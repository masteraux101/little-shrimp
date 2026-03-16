/**
 * loop-agent.js — Frontend module for deploying and managing the Loop Agent
 *
 * Generates the GitHub Actions workflow YAML,
 * bundles the runner script, syncs secrets, and dispatches the workflow.
 */

import GitHubActions from './github-actions.js';
import PushooNotifier from './pushoo.js';
import Crypto from './crypto.js';
import { t, getLang } from './i18n.js';

const LoopAgent = (() => {
  /* eslint-disable -- keeping original structure */

  /**
   * The runner.js and sub-agent.js content is loaded from the public/ directory.
   * Public files are not processed by Vite, avoiding dynamic import issues.
   */
  let _runnerScriptCache = null;
  let _subAgentScriptCache = null;
  let _browserAgentScriptCache = null;

  async function getRunnerScript() {
    if (_runnerScriptCache) return _runnerScriptCache;
    // Runner script is in public/loop-agent/, accessible as /shrimp/loop-agent/runner.js
    const resp = await fetch('/shrimp/loop-agent/runner.js');
    if (!resp.ok) throw new Error(`Failed to load loop-agent runner: ${resp.status}`);
    _runnerScriptCache = await resp.text();
    return _runnerScriptCache;
  }

  async function getSubAgentScript() {
    if (_subAgentScriptCache) return _subAgentScriptCache;
    const resp = await fetch('/shrimp/loop-agent/sub-agent.js');
    if (!resp.ok) throw new Error(`Failed to load loop-agent sub-agent: ${resp.status}`);
    _subAgentScriptCache = await resp.text();
    return _subAgentScriptCache;
  }

  async function getBrowserAgentScript() {
    if (_browserAgentScriptCache) return _browserAgentScriptCache;
    const resp = await fetch('/shrimp/loop-agent/browser-agent.js');
    if (!resp.ok) throw new Error(`Failed to load loop-agent browser-agent: ${resp.status}`);
    _browserAgentScriptCache = await resp.text();
    return _browserAgentScriptCache;
  }

  /**
   * Generate a unique loop key for a new session.
   * Format: loop-<8hex>
   */
  function generateLoopKey() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    return 'loop-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Generate the workflow YAML for the loop agent.
   */
  function generateWorkflowYaml(opts) {
    const {
      loopKey,
      workflowFile,
      provider = 'gemini',
      model = 'gemini-2.0-flash',
      pollInterval = 5,
      maxRuntime = 18000,
      systemPrompt = '',
      historyPath = 'loop-agent/history',
    } = opts;

    return [
      `# browseragent-loop: ${loopKey}`,
      `name: "Loop Agent — ${loopKey}"`,
      '',
      'on:',
      '  workflow_dispatch: {}',
      '',
      'jobs:',
      '  loop-agent:',
      '    runs-on: ubuntu-latest',
      '    container:',
      '      image: mcr.microsoft.com/playwright:v1.50.0-noble',
      '      options: --ipc=host',
      '    timeout-minutes: 360',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
      '      - name: Install dependencies',
      '        run: |',
      '          cd loop-agent',
      '          npm install pushoo telegraf @wecom/aibot-node-sdk zod @langchain/core @langchain/langgraph @langchain/google-genai @langchain/openai playwright@1.50.0 sharp 2>&1',
      '',
      '      - name: Run loop agent',
      '        env:',
      '          UPSTASH_URL: ${{ secrets.UPSTASH_URL }}',
      '          UPSTASH_TOKEN: ${{ secrets.UPSTASH_TOKEN }}',
      `          LOOP_KEY: "${loopKey}"`,
      `          AI_PROVIDER: "${provider}"`,
      `          AI_MODEL: "${model}"`,
      '          AI_API_KEY: ${{ secrets.AI_API_KEY }}',
      '          AI_BASE_URL: ${{ secrets.AI_BASE_URL }}',
      '          PUSHOO_CHANNELS: ${{ secrets.PUSHOO_CHANNELS }}',
      '          GH_PAT: ${{ secrets.GH_PAT }}',
      '          GITHUB_REPOSITORY: ${{ github.repository }}',
      `          LOOP_WORKFLOW_FILE: "${workflowFile}"`,
      `          LOOP_HISTORY_PATH: "${historyPath}"`,
      `          LOOP_POLL_INTERVAL: "${pollInterval}"`,
      `          LOOP_MAX_RUNTIME: "${maxRuntime}"`,
      ...(systemPrompt ? [`          LOOP_SYSTEM_PROMPT: "${systemPrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`] : []),
      '          LOOP_ENCRYPT_KEY: ${{ secrets.LOOP_ENCRYPT_KEY }}',
      '        run: node loop-agent/runner.js',
      '',
    ].join('\n') + '\n';
  }

  /**
   * Deploy a loop agent to the user's GitHub repo.
   *
   * @param {Object} opts
   * @param {Object} opts.actionConfig - { token, owner, repo, branch }
   * @param {string} opts.runnerScript - The runner.js content
   * @param {string} opts.subAgentScript - The sub-agent.js content
   * @param {string} opts.browserAgentScript - The browser-agent.js content
   * @param {string} opts.loopKey - Unique loop key
   * @param {Object} opts.agentOpts - { provider, model, pollInterval, maxRuntime, systemPrompt }
   * @param {Object} opts.secrets - { aiApiKey, pushooChannels }
   * @param {function} opts.onProgress - (step, detail) progress callback
   * @returns {Object} { loopKey, workflowFile, repoUrl }
   */
  async function deploy(opts) {
    const {
      actionConfig,
      runnerScript,
      subAgentScript,
      browserAgentScript,
      loopKey,
      agentOpts = {},
      secrets = {},
      onProgress,
    } = opts;

    const progress = (step, detail) => {
      if (onProgress) onProgress(step, detail);
      console.log(`[LoopAgent] ${step}: ${detail}`);
    };

    const lang = getLang();
    const workflowFile = `loop-agent-${Date.now()}.yml`;
    const workflowPath = `.github/workflows/${workflowFile}`;

    // 1. Generate workflow YAML
    progress('generate', t(lang, 'loopStepGenerate'));
    const workflowYaml = generateWorkflowYaml({
      loopKey,
      workflowFile,
      provider: agentOpts.provider,
      model: agentOpts.model,
      pollInterval: agentOpts.pollInterval,
      maxRuntime: agentOpts.maxRuntime,
      systemPrompt: agentOpts.systemPrompt,
      historyPath: agentOpts.historyPath,
    });

    // 2. Push files to repo
    progress('push', t(lang, 'loopStepPush'));
    const files = [
      { path: 'loop-agent/runner.js', content: runnerScript },
      { path: 'loop-agent/sub-agent.js', content: subAgentScript },
      { path: 'loop-agent/browser-agent.js', content: browserAgentScript },
      { path: workflowPath, content: workflowYaml },
    ];
    await GitHubActions.pushFiles(actionConfig, files, `[loop-agent] Deploy ${loopKey}`);

    // 3. Sync secrets
    progress('secrets', t(lang, 'loopStepSecrets'));
    const secretMap = [];
    if (secrets.upstashUrl)     secretMap.push({ name: 'UPSTASH_URL',     value: secrets.upstashUrl });
    if (secrets.upstashToken)   secretMap.push({ name: 'UPSTASH_TOKEN',   value: secrets.upstashToken });
    if (secrets.aiApiKey)       secretMap.push({ name: 'AI_API_KEY',      value: secrets.aiApiKey });
    if (secrets.aiBaseUrl)      secretMap.push({ name: 'AI_BASE_URL',     value: secrets.aiBaseUrl });
    if (secrets.pushooChannels) secretMap.push({ name: 'PUSHOO_CHANNELS', value: secrets.pushooChannels });
    // Use the user's PAT (not the default GITHUB_TOKEN) for repo operations
    if (actionConfig.token)     secretMap.push({ name: 'GH_PAT',          value: actionConfig.token });
    if (secrets.encryptKey)      secretMap.push({ name: 'LOOP_ENCRYPT_KEY', value: secrets.encryptKey });

    console.log(`[LoopAgent] Secrets to sync: ${secretMap.map(s => s.name).join(', ')}`);
    for (const s of secretMap) {
      const masked = s.value ? s.value.slice(0, 4) + '***' + s.value.slice(-4) : '(empty)';
      console.log(`[LoopAgent] Secret ${s.name}: value=${masked}, length=${s.value?.length || 0}`);
    }

    const synced = [];
    const errors = [];
    for (const s of secretMap) {
      try {
        console.log(`[LoopAgent] Syncing secret: ${s.name}...`);
        await GitHubActions.setRepoSecret(actionConfig, s.name, s.value);
        synced.push(s.name);
        console.log(`[LoopAgent] ✅ Secret ${s.name} synced successfully`);
      } catch (e) {
        console.error(`[LoopAgent] ❌ Failed to sync secret ${s.name}: ${e.message}`);
        errors.push(`${s.name}: ${e.message}`);
      }
    }

    // 4. Dispatch workflow
    progress('dispatch', t(lang, 'loopStepDispatch'));
    try {
      await GitHubActions.dispatchWorkflow(actionConfig, workflowFile);
    } catch (e) {
      // Workflow might not be available immediately after push — retry once
      await new Promise(r => setTimeout(r, 3000));
      await GitHubActions.dispatchWorkflow(actionConfig, workflowFile);
    }

    progress('done', t(lang, 'loopStepDone'));

    const repoUrl = `https://github.com/${actionConfig.owner}/${actionConfig.repo}`;
    return {
      loopKey,
      workflowFile,
      repoUrl,
      synced,
      errors,
    };
  }

  /**
   * Fetch loop agent conversation history from the GitHub repo.
   * If encryptKey is provided, encrypted content will be decrypted.
   * Returns an array of { role: 'user'|'assistant', content, ts }.
   */
  async function fetchHistory(actionConfig, loopKey, historyPath = 'loop-agent/history', encryptKey = null) {
    const { token, owner, repo } = actionConfig;
    const filePath = `${historyPath}/${loopKey}.json`;
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=main`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    if (resp.status === 404) return [];
    if (!resp.ok) throw new Error(`Failed to fetch history: ${resp.status}`);
    const data = await resp.json();
    const binary = atob(data.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    let content = new TextDecoder('utf-8').decode(bytes);
    // Detect encrypted content
    if (content.startsWith('ENCRYPTED:')) {
      if (!encryptKey) {
        throw new Error('Content is encrypted. Please provide a decryption key.');
      }
      try {
        content = await Crypto.decrypt(encryptKey, content.slice('ENCRYPTED:'.length));
      } catch (e) {
        throw new Error(`Decryption failed — wrong key? ${e.message}`);
      }
    }
    return JSON.parse(content);
  }

  /**
   * Clear the loop agent's persistent memory file (MEMORY.md) from the GitHub repo.
   * If encryptKey is provided, the cleared content will be encrypted.
   */
  async function clearMemory(actionConfig, memoryPath = 'loop-agent/MEMORY.md', encryptKey = null) {
    const { token, owner, repo } = actionConfig;
    // First get the file SHA (required for deletion)
    const getResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${memoryPath}?ref=main`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    if (getResp.status === 404) return { cleared: false, reason: 'Memory file does not exist.' };
    if (!getResp.ok) throw new Error(`Failed to read memory file: ${getResp.status}`);
    const fileData = await getResp.json();

    // Prepare cleared content (encrypt if key provided)
    let clearedContent = '# Agent Memory\n';
    if (encryptKey) {
      clearedContent = 'ENCRYPTED:' + await Crypto.encrypt(encryptKey, clearedContent);
    }

    // Delete the file
    const delResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${memoryPath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: '[loop-agent] Clear memory (user initiated)',
          content: btoa(clearedContent),
          sha: fileData.sha,
          branch: 'main',
        }),
      }
    );
    if (!delResp.ok) throw new Error(`Failed to clear memory: ${delResp.status}`);
    return { cleared: true };
  }

  // ─── Browser-side Intervention Channel ─────────────────────────────

  /**
   * Send an intervention message to a running loop agent.
   * Routes to Upstash (if configured) or repo-based channel (fallback).
   *
   * @param {Object} actionConfig - { token, owner, repo }
   * @param {string} loopKey - The loop agent key
   * @param {string} text - Message text to send
   * @param {Object} opts - { upstashUrl, upstashToken, encryptKey }
   * @returns {{ channel: 'upstash' | 'repo' }}
   */
  async function sendIntervention(actionConfig, loopKey, text, opts = {}) {
    const { upstashUrl, upstashToken, encryptKey } = opts;
    const message = JSON.stringify({
      ts: Date.now(),
      from: 'user',
      text,
      read: false,
      extra: {},
    });

    if (upstashUrl && upstashToken) {
      // Upstash mode
      const inboxKey = `loop:${loopKey}:inbox`;
      const resp = await fetch(upstashUrl.replace(/\/+$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['SET', inboxKey, message]),
      });
      if (!resp.ok) throw new Error(`Upstash write failed: ${resp.status}`);
      return { channel: 'upstash' };
    }

    // Repo-based fallback
    const { token, owner, repo } = actionConfig;
    const inboxPath = `loop-agent/channel/${loopKey}.inbox.json`;
    let content = message;
    if (encryptKey) {
      content = 'ENCRYPTED:' + await Crypto.encrypt(encryptKey, content);
    }

    // Get existing file SHA if it exists (for update)
    const getResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${inboxPath}?ref=main`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' } }
    );
    const body = {
      message: '[loop-agent] Browser intervention message',
      content: btoa(unescape(encodeURIComponent(content))),
      branch: 'main',
    };
    if (getResp.ok) {
      const data = await getResp.json();
      body.sha = data.sha;
    }

    const putResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${inboxPath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    );
    if (!putResp.ok) throw new Error(`Failed to write intervention message: ${putResp.status}`);
    return { channel: 'repo' };
  }

  /**
   * Poll for intervention response from a running loop agent.
   * Returns the response message object { ts, from, text } or null if no response.
   *
   * @param {Object} actionConfig - { token, owner, repo }
   * @param {string} loopKey - The loop agent key
   * @param {Object} opts - { upstashUrl, upstashToken, encryptKey }
   * @returns {Object|null}
   */
  async function pollIntervention(actionConfig, loopKey, opts = {}) {
    const { upstashUrl, upstashToken, encryptKey } = opts;

    if (upstashUrl && upstashToken) {
      // Upstash mode — read outbox
      const outboxKey = `loop:${loopKey}:outbox`;
      const resp = await fetch(upstashUrl.replace(/\/+$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['GET', outboxKey]),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.result) return null;
      try {
        const msg = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;
        if (!msg.text || msg.read) return null;
        // Mark as read
        await fetch(upstashUrl.replace(/\/+$/, ''), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstashToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(['SET', outboxKey, JSON.stringify({ ...msg, read: true })]),
        });
        return msg;
      } catch { return null; }
    }

    // Repo-based fallback — read outbox file
    const { token, owner, repo } = actionConfig;
    const outboxPath = `loop-agent/channel/${loopKey}.outbox.json`;
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${outboxPath}?ref=main`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.v3+json' } }
    );
    if (resp.status === 404 || !resp.ok) return null;

    const fileData = await resp.json();
    const binary = atob(fileData.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    let content = new TextDecoder('utf-8').decode(bytes);

    // Decrypt if needed
    if (content.startsWith('ENCRYPTED:') && encryptKey) {
      try { content = await Crypto.decrypt(encryptKey, content.slice('ENCRYPTED:'.length)); }
      catch { return null; }
    }

    try {
      const msg = JSON.parse(content);
      if (!msg.text || msg.read) return null;

      // Mark as read by writing back
      const updated = JSON.stringify({ ...msg, read: true });
      let writeContent = updated;
      if (encryptKey) {
        writeContent = 'ENCRYPTED:' + await Crypto.encrypt(encryptKey, updated);
      }
      await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${outboxPath}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message: '[loop-agent] Mark outbox read',
            content: btoa(unescape(encodeURIComponent(writeContent))),
            sha: fileData.sha,
            branch: 'main',
          }),
        }
      );
      return msg;
    } catch { return null; }
  }

  /**
   * Clean up Upstash keys for a given loop agent.
   * Deletes both inbox and outbox keys.
   */
  async function cleanupUpstashKeys(loopKey, opts = {}) {
    const { upstashUrl, upstashToken } = opts;
    if (!upstashUrl || !upstashToken) return;
    const keys = [`loop:${loopKey}:inbox`, `loop:${loopKey}:outbox`];
    for (const key of keys) {
      try {
        await fetch(upstashUrl.replace(/\/+$/, ''), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${upstashToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(['DEL', key]),
        });
      } catch { /* ignore cleanup errors */ }
    }
  }

  return {
    getRunnerScript,
    getSubAgentScript,
    getBrowserAgentScript,
    generateLoopKey,
    generateWorkflowYaml,
    deploy,
    fetchHistory,
    clearMemory,
    sendIntervention,
    pollIntervention,
    cleanupUpstashKeys,
  };
})();

export default LoopAgent;
