/**
 * provider-api.js — Multi-provider AI API client
 *
 * Supports:
 * - Google Gemini (via @google/genai SDK)
 * - Qwen (via OpenAI-compatible DashScope API)
 * - Kimi (via OpenAI-compatible Moonshot API)
 * - Custom OpenAI-compatible endpoints
 */

// Provider implementations
const ProviderAPI = (() => {
  let _GoogleGenAI = null;

  // ─── Qwen via OpenAI-compatible API (using fetch) ──────────────────

  const Qwen = (() => {
    const QWEN_MODELS = [
      { id: 'qwen3-max-2026-01-23', name: 'Qwen3 Max (2026-01-23)', provider: 'qwen', dimensions: { search: true, thinking: true } },
      { id: 'qwen-max', name: 'Qwen Max (Latest)', provider: 'qwen', dimensions: { search: true, thinking: false } },
      { id: 'qwen-plus', name: 'Qwen Plus', provider: 'qwen', dimensions: { search: true, thinking: false } },
      { id: 'qwen-turbo', name: 'Qwen Turbo (Fast)', provider: 'qwen', dimensions: { search: true, thinking: false } },
      { id: 'qwen-long', name: 'Qwen Long', provider: 'qwen', dimensions: { search: false, thinking: false } },
      { id: 'qwen2-72b-instruct', name: 'Qwen2 72B', provider: 'qwen', dimensions: { search: false, thinking: false } },
      { id: 'qwen2-7b-instruct', name: 'Qwen2 7B', provider: 'qwen', dimensions: { search: false, thinking: false } },
    ];

    async function generateContent(config) {
      const {
        apiKey,
        model,
        systemInstruction = '',
        messages = [],
        onChunk = null,
        abortSignal = null,
        enableSearch = false,
        thinkingConfig = null,
        _disableTools = false,
      } = config;

      if (!apiKey) throw new Error('Qwen API key is required');
      if (!model) throw new Error('Model is required');
      if (!messages.length) throw new Error('At least one message is required');

      // Build chat messages for OpenAI API format
      const chatMessages = [];
      
      if (systemInstruction) {
        chatMessages.push({ role: 'system', content: systemInstruction });
      }

      for (const msg of messages) {
        chatMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content || msg.parts?.map(p => p.text).join('') || '',
        });
      }

      const url = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

      const lowerModel = model.toLowerCase();
      const supportsThinking = lowerModel.startsWith('qwen3-') || lowerModel.startsWith('qwq-');
      const supportsBuiltinTools = lowerModel.startsWith('qwen3-') || lowerModel.startsWith('qwen-max') || lowerModel.startsWith('qwen-plus');
      
      let fullText = '';
      let usageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const requestBody = {
        model,
        messages: chatMessages,
        stream: true,
        stream_options: { include_usage: true },
        temperature: 1.0,
        top_p: 0.95,
        max_tokens: 8192,
      };

      const extraBody = {};
      if (enableSearch) {
        // DashScope/OpenAI-compatible Qwen expects this at top-level.
        requestBody.enable_search = true;
      }
      if (thinkingConfig?.enabled && supportsThinking) {
        extraBody.enable_thinking = true;
        if (thinkingConfig.thinkingBudget) {
          extraBody.thinking_budget = thinkingConfig.thinkingBudget;
        }
      }
      if (Object.keys(extraBody).length > 0) {
        requestBody.extra_body = extraBody;
      }

      // Align with tool-based invocation style where the model supports it.
      // Keep enable_search for compatibility with older behavior.
      if (enableSearch && supportsBuiltinTools && !_disableTools) {
        requestBody.tools = [
          { type: 'web_search' },
          { type: 'web_extractor' },
          { type: 'code_interpreter' },
        ];
        requestBody.tool_choice = 'auto';
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'X-DashScope-SSE': 'enable',
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Qwen API error: ${response.status} - ${error}`);
      }

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingBuffer = '';
      let sawToolCall = false;

      function processSseLine(line) {
        if (!line.trim() || line.startsWith(':')) return;
        if (!line.startsWith('data: ')) return;

        const data = line.slice(6);
        if (data === '[DONE]') return;

        try {
          const chunk = JSON.parse(data);
          if (chunk.choices?.[0]?.delta?.content) {
            const chunkText = chunk.choices[0].delta.content;
            fullText += chunkText;
            if (onChunk) {
              onChunk({ type: 'text', text: chunkText });
            }
          }
          if (chunk.choices?.[0]?.delta?.tool_calls?.length) {
            sawToolCall = true;
          }
          if (chunk.usage) {
            usageInfo = {
              promptTokens: chunk.usage.prompt_tokens || 0,
              completionTokens: chunk.usage.completion_tokens || 0,
              totalTokens: chunk.usage.total_tokens || 0,
            };
          }
        } catch {
          // Ignore JSON parse errors in stream chunks.
        }
      }
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          pendingBuffer += decoder.decode(value, { stream: true });
          const lines = pendingBuffer.split('\n');
          pendingBuffer = lines.pop() || '';
          for (const line of lines) {
            processSseLine(line);
          }
        }

        if (pendingBuffer.trim()) {
          processSseLine(pendingBuffer);
        }
      } finally {
        reader.releaseLock();
      }

      // Some models may emit tool-calls without final text in this endpoint.
      // Fallback once without tools to avoid blank responses.
      if (!fullText.trim() && sawToolCall && !_disableTools) {
        return generateContent({
          ...config,
          _disableTools: true,
        });
      }

      return { text: fullText, usageInfo };
    }

    async function testApiKey(apiKey, model = 'qwen-turbo') {
      try {
        const result = await generateContent({
          apiKey,
          model,
          messages: [{ role: 'user', content: 'Hi' }],
        });
        return result && result.text && result.text.length > 0;
      } catch (e) {
        return false;
      }
    }

    return { QWEN_MODELS, generateContent, testApiKey };
  })();

  // ─── Kimi via OpenAI-compatible API (using fetch) ─────────────────

  const Kimi = (() => {
    const KIMI_MODELS = [
      { id: 'kimi-k2.5', name: 'Kimi K2.5 (Multimodal)', provider: 'kimi', dimensions: { search: true, thinking: true } },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', provider: 'kimi', dimensions: { search: true, thinking: true } },
      { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', provider: 'kimi', dimensions: { search: true, thinking: true } },
      { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo Preview', provider: 'kimi', dimensions: { search: true, thinking: false } },
      { id: 'kimi-k2-0905-preview', name: 'Kimi K2 0905 Preview', provider: 'kimi', dimensions: { search: true, thinking: false } },
      { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 Preview', provider: 'kimi', dimensions: { search: true, thinking: false } },
      { id: 'moonshot-v1-128k', name: 'Moonshot V1 128K', provider: 'kimi', dimensions: { search: true, thinking: false } },
    ];

    async function generateContent(config) {
      const {
        apiKey,
        model,
        systemInstruction = '',
        messages = [],
        onChunk = null,
        abortSignal = null,
        thinkingConfig = null,
        enableSearch = false,
      } = config;

      if (!apiKey) throw new Error('Kimi API key is required');
      if (!model) throw new Error('Model is required');
      if (!messages.length) throw new Error('At least one message is required');

      const url = 'https://api.moonshot.cn/v1/chat/completions';
      let fullText = '';
      let usageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0, searchTokens: 0 };

      // Build chat messages for OpenAI API format
      const chatMessages = [];
      
      if (systemInstruction) {
        chatMessages.push({ role: 'system', content: systemInstruction });
      }

      for (const msg of messages) {
        chatMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content || msg.parts?.map(p => p.text).join('') || '',
        });
      }

      const lowerModel = model.toLowerCase();

      // Tool call handling loop for search functionality
      let continueLoop = true;
      let lastFinishReason = null;
      let toolCallCount = 0;
      const maxToolCalls = 10; // Prevent infinite loops

      while (continueLoop && toolCallCount < maxToolCalls) {
        const requestBody = {
          model,
          messages: chatMessages,
          stream: true,
          temperature: 0.6,
          top_p: 0.95,
        };

          // K2.5 doesn't support temperature modification (for both thinking and search)
          if (lowerModel === 'kimi-k2.5') {
            delete requestBody.temperature;
          }

          // Add thinking configuration
          if (thinkingConfig?.enabled && (lowerModel.includes('k2.5') || lowerModel.includes('thinking'))) {
            if (lowerModel === 'kimi-k2.5') {
              // K2.5 uses thinking object
              requestBody.thinking = { type: 'enabled' };
            } else {
              // Other thinking models
              requestBody.thinking = {
                type: 'enabled',
                budget_tokens: thinkingConfig.thinkingBudget || 10000,
              };
            }
          }

          // Add web search capability if enabled
          if (enableSearch) {
            requestBody.tools = [
              {
                type: 'builtin_function',
                function: {
                  name: '$web_search',
                },
              },
            ];
          }

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(requestBody),
          signal: abortSignal,
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Kimi API error: ${response.status} - ${error}`);
        }

        // Handle streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pendingBuffer = '';
        let lastMessage = null;
        let lastToolCall = null;
        let reasoningContent = ''; // Capture thinking content for tool_calls context

        function processSseLine(line) {
          if (!line.trim() || line.startsWith(':')) return;
          if (!line.startsWith('data: ')) return;

          const data = line.slice(6);
          if (data === '[DONE]') return;

          try {
            const chunk = JSON.parse(data);

            // Capture finish_reason
            if (chunk.choices?.[0]?.finish_reason) {
              lastFinishReason = chunk.choices[0].finish_reason;
            }

            // Process content chunks
            if (chunk.choices?.[0]?.delta?.content) {
              const chunkText = chunk.choices[0].delta.content;
              fullText += chunkText;
              if (onChunk) {
                onChunk({ type: 'text', text: chunkText });
              }
            }

            // Capture reasoning content (for thinking mode)
            if (chunk.choices?.[0]?.delta?.reasoning_content) {
              reasoningContent += chunk.choices[0].delta.reasoning_content;
            }

            // Capture tool calls
            if (chunk.choices?.[0]?.delta?.tool_calls) {
              const toolCalls = chunk.choices[0].delta.tool_calls;
              if (toolCalls.length > 0) {
                const toolCall = toolCalls[0];
                if (!lastToolCall) {
                  lastToolCall = {
                    id: toolCall.id,
                    function: {
                      name: toolCall.function?.name || '',
                      arguments: '',
                    },
                  };
                }
                if (toolCall.function?.arguments) {
                  lastToolCall.function.arguments += toolCall.function.arguments;
                }
              }
            }

            // Capture assistant message for tool_calls handling
            if (chunk.choices?.[0]?.message) {
              lastMessage = chunk.choices[0].message;
            }

            // Update usage information
            if (chunk.usage) {
              usageInfo = {
                promptTokens: chunk.usage.prompt_tokens || usageInfo.promptTokens,
                completionTokens: chunk.usage.completion_tokens || usageInfo.completionTokens,
                cachedTokens: chunk.usage.cached_tokens || 0,
                totalTokens: chunk.usage.total_tokens || usageInfo.totalTokens,
              };
              // Track search-related tokens if usage contains that info
              if (chunk.usage.search_tokens) {
                usageInfo.searchTokens = chunk.usage.search_tokens;
              }
            }
          } catch {
            // Ignore JSON parse errors in stream chunks.
          }
        }
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            pendingBuffer += decoder.decode(value, { stream: true });
            const lines = pendingBuffer.split('\n');
            pendingBuffer = lines.pop() || '';
            for (const line of lines) {
              processSseLine(line);
            }
          }

          if (pendingBuffer.trim()) {
            processSseLine(pendingBuffer);
          }
        } finally {
          reader.releaseLock();
        }

        // Handle tool calls for search
        if (lastFinishReason === 'tool_calls' && lastToolCall) {
          toolCallCount++;
          const toolCallName = lastToolCall.function.name;
          const toolCallArguments = JSON.parse(lastToolCall.function.arguments);

          if (toolCallName === '$web_search') {
            // For $web_search, return arguments as-is (Kimi executes the search internally)
            // Build assistant message with all required fields for thinking mode
            const assistantMsg = {
              role: 'assistant',
              tool_calls: [
                {
                  id: lastToolCall.id,
                  type: 'function',
                  function: {
                    name: toolCallName,
                    arguments: lastToolCall.function.arguments,
                  },
                },
              ],
            };

            // Add content and reasoning_content if present (required for thinking mode with tool_calls)
            if (fullText) {
              assistantMsg.content = fullText;
            }
            if (reasoningContent) {
              assistantMsg.reasoning_content = reasoningContent;
            }

            chatMessages.push(assistantMsg);

            // Add tool result - for Kimi's built-in search, we just return the arguments
            chatMessages.push({
              role: 'tool',
              tool_call_id: lastToolCall.id,
              name: toolCallName,
              content: JSON.stringify(toolCallArguments),
            });

            // Reset content for next iteration
            fullText = '';
            reasoningContent = '';
          } else {
            // Unknown tool, break loop
            continueLoop = false;
          }
        } else {
          // finish_reason is 'stop' or something else, exit loop
          continueLoop = false;
        }
      }

      return { text: fullText, usageInfo };
    }

    async function testApiKey(apiKey, model = 'kimi-k2-turbo-preview') {
      try {
        const result = await generateContent({
          apiKey,
          model,
          messages: [{ role: 'user', content: 'Hi' }],
        });
        return result && result.text && result.text.length > 0;
      } catch (e) {
        return false;
      }
    }

    return { KIMI_MODELS, generateContent, testApiKey };
  })();

  // ─── Gemini via Google SDK ──────────────────────────────────────────

  const Gemini = (() => {
    const GEMINI_MODELS = [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', dimensions: { search: true, thinking: true } },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'gemini', dimensions: { search: true, thinking: true } },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'gemini', dimensions: { search: true, thinking: false } },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', provider: 'gemini', dimensions: { search: true, thinking: false } },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', provider: 'gemini', dimensions: { search: true, thinking: false } },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', provider: 'gemini', dimensions: { search: true, thinking: false } },
    ];

    async function getAI(apiKey) {
      if (!_GoogleGenAI) {
        try {
          const mod = await import('@google/genai');
          _GoogleGenAI = mod.GoogleGenAI;
        } catch (e) {
          throw new Error('Failed to load Google GenAI SDK. Check your internet connection and refresh.');
        }
      }
      return new _GoogleGenAI({ apiKey });
    }

    async function generateContent(config) {
      const {
        apiKey,
        model,
        systemInstruction = '',
        messages = [],
        onChunk = null,
        enableSearch = false,
        thinkingConfig = null,
      } = config;

      if (!apiKey) throw new Error('Gemini API key is required');
      if (!model) throw new Error('Model is required');
      if (!messages.length) throw new Error('At least one message is required');

      // Convert to Gemini format
      const geminiHistory = messages.map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: msg.parts || [{ text: msg.content || '' }],
      }));

      const tools = enableSearch ? [{ googleSearch: {} }] : [];
      const config_obj = {
        temperature: 1.0,
        topP: 0.95,
        maxOutputTokens: 8192,
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      };

      if (thinkingConfig?.enabled) {
        config_obj.thinkingConfig = {};
        if (thinkingConfig.thinkingBudget) {
          config_obj.thinkingConfig.thinkingBudget = thinkingConfig.thinkingBudget;
        }
        if (thinkingConfig.includeThoughts) {
          config_obj.thinkingConfig.includeThoughts = true;
        }
      }

      const ai = await getAI(apiKey);
      const response = await ai.models.generateContentStream({
        model,
        contents: geminiHistory,
        config: config_obj,
      });

      let fullText = '';
      let lastUsageMetadata = null;
      let groundingMeta = null;

      for await (const chunk of response) {
        const t = chunk.text || '';
        if (t) {
          fullText += t;
          if (onChunk) {
            onChunk({ type: 'text', text: t });
          }
        }
        if (chunk.usageMetadata) {
          lastUsageMetadata = chunk.usageMetadata;
        }
        if (chunk.candidates?.[0]?.groundingMetadata) {
          groundingMeta = chunk.candidates[0].groundingMetadata;
        }
      }

      const usageInfo = {
        promptTokens: lastUsageMetadata?.promptTokenCount || 0,
        completionTokens: lastUsageMetadata?.candidatesTokenCount || 0,
        thoughtsTokens: lastUsageMetadata?.thoughtsTokenCount || 0,
        totalTokens: lastUsageMetadata?.totalTokenCount || 0,
      };

      return { text: fullText, usageInfo, grounding: groundingMeta };
    }

    async function testApiKey(apiKey, model) {
      try {
        const ai = await getAI(apiKey);
        await ai.models.generateContent({
          model,
          contents: 'Hi',
          config: { maxOutputTokens: 5 },
        });
        return true;
      } catch (e) {
        return false;
      }
    }

    return { GEMINI_MODELS, generateContent, testApiKey };
  })();

  // ─── OpenAI-compatible via BaseUrl + API Key ──────────────────────

  const OpenAICompat = (() => {
    async function generateContent(config) {
      const {
        apiKey,
        baseUrl,
        model,
        systemInstruction = '',
        messages = [],
        onChunk = null,
        abortSignal = null,
        enableSearch = false,
        thinkingConfig = null,
      } = config;

      if (!apiKey) throw new Error('API Key is required');
      if (!baseUrl) throw new Error('Base URL is required');
      if (!model) throw new Error('Model is required');
      if (!messages.length) throw new Error('At least one message is required');

      const chatMessages = [];
      if (systemInstruction) {
        chatMessages.push({ role: 'system', content: systemInstruction });
      }
      for (const msg of messages) {
        chatMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: msg.content || msg.parts?.map(p => p.text).join('') || '',
        });
      }

      const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';

      let fullText = '';
      let usageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      const requestBody = {
        model,
        messages: chatMessages,
        stream: true,
        temperature: 1.0,
        top_p: 0.95,
        max_tokens: 8192,
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: abortSignal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API error: ${response.status} - ${error}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pendingBuffer = '';

      function processSseLine(line) {
        if (!line.trim() || line.startsWith(':')) return;
        if (!line.startsWith('data: ')) return;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const chunk = JSON.parse(data);
          if (chunk.choices?.[0]?.delta?.content) {
            const chunkText = chunk.choices[0].delta.content;
            fullText += chunkText;
            if (onChunk) onChunk({ type: 'text', text: chunkText });
          }
          if (chunk.usage) {
            usageInfo = {
              promptTokens: chunk.usage.prompt_tokens || 0,
              completionTokens: chunk.usage.completion_tokens || 0,
              totalTokens: chunk.usage.total_tokens || 0,
            };
          }
        } catch { /* ignore parse errors */ }
      }

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          pendingBuffer += decoder.decode(value, { stream: true });
          const lines = pendingBuffer.split('\n');
          pendingBuffer = lines.pop() || '';
          for (const line of lines) processSseLine(line);
        }
        if (pendingBuffer.trim()) processSseLine(pendingBuffer);
      } finally {
        reader.releaseLock();
      }

      return { text: fullText, usageInfo };
    }

    async function testApiKey(apiKey, baseUrl, model) {
      try {
        const result = await generateContent({
          apiKey, baseUrl, model,
          messages: [{ role: 'user', content: 'Hi' }],
        });
        return result && result.text && result.text.length > 0;
      } catch { return false; }
    }

    return { generateContent, testApiKey };
  })();

  // ─── Public API ────────────────────────────────────────────────────

  return {
    Gemini,
    Qwen,
    Kimi,
    OpenAICompat,
  };
})();

export default ProviderAPI;
