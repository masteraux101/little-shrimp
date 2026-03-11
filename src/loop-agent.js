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
   * The runner.js content is loaded from the public/ directory.
   * Public files are not processed by Vite, avoiding dynamic import issues.
   */
  let _runnerScriptCache = null;

  async function getRunnerScript() {
    if (_runnerScriptCache) return _runnerScriptCache;
    // Runner script is in public/loop-agent/, accessible as /shrimp/loop-agent/runner.js
    const resp = await fetch('/shrimp/loop-agent/runner.js');
    if (!resp.ok) throw new Error(`Failed to load loop-agent runner: ${resp.status}`);
    _runnerScriptCache = await resp.text();
    return _runnerScriptCache;
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
      '    timeout-minutes: 360',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
      '      - name: Setup Node.js',
      '        uses: actions/setup-node@v4',
      '        with:',
      "          node-version: '20'",
      '',
      '      - name: Install dependencies',
      '        run: |',
      '          cd loop-agent',
      '          npm install pushoo telegraf zod @langchain/core @langchain/langgraph @langchain/google-genai @langchain/openai 2>&1',
      '',
      '      - name: Run loop agent',
      '        env:',
      '          UPSTASH_URL: ${{ secrets.UPSTASH_URL }}',
      '          UPSTASH_TOKEN: ${{ secrets.UPSTASH_TOKEN }}',
      `          LOOP_KEY: "${loopKey}"`,
      `          AI_PROVIDER: "${provider}"`,
      `          AI_MODEL: "${model}"`,
      '          AI_API_KEY: ${{ secrets.AI_API_KEY }}',
      '          PUSHOO_PLATFORM: ${{ secrets.PUSHOO_PLATFORM }}',
      '          PUSHOO_TOKEN: ${{ secrets.PUSHOO_TOKEN }}',
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
   * @param {string} opts.loopKey - Unique loop key
   * @param {Object} opts.agentOpts - { provider, model, pollInterval, maxRuntime, systemPrompt }
   * @param {Object} opts.secrets - { aiApiKey, upstashUrl, upstashToken, pushooPlatform, pushooToken }
   * @param {function} opts.onProgress - (step, detail) progress callback
   * @returns {Object} { loopKey, workflowFile, repoUrl }
   */
  async function deploy(opts) {
    const {
      actionConfig,
      runnerScript,
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
      { path: workflowPath, content: workflowYaml },
    ];
    await GitHubActions.pushFiles(actionConfig, files, `[loop-agent] Deploy ${loopKey}`);

    // 3. Sync secrets
    progress('secrets', t(lang, 'loopStepSecrets'));
    const hasPushoo = !!(secrets.pushooPlatform && secrets.pushooToken);
    console.log(`[LoopAgent] Preparing secrets. pushoo enabled: ${hasPushoo ? 'yes' : 'no'}, platform=${secrets.pushooPlatform || '(none)'}, token=${secrets.pushooToken ? 'present(' + secrets.pushooToken.length + ' chars)' : '(none)'}`);
    const secretMap = [];
    if (secrets.upstashUrl)     secretMap.push({ name: 'UPSTASH_URL',     value: secrets.upstashUrl });
    if (secrets.upstashToken)   secretMap.push({ name: 'UPSTASH_TOKEN',   value: secrets.upstashToken });
    if (secrets.aiApiKey)       secretMap.push({ name: 'AI_API_KEY',      value: secrets.aiApiKey });
    if (secrets.pushooPlatform) secretMap.push({ name: 'PUSHOO_PLATFORM', value: secrets.pushooPlatform });
    if (secrets.pushooToken)    secretMap.push({ name: 'PUSHOO_TOKEN',    value: secrets.pushooToken });
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
   * Validate Upstash configuration.
   */
  function validateUpstashConfig(url, token) {
    if (!url || typeof url !== 'string') return { valid: false, error: 'Upstash URL is required' };
    if (!token || typeof token !== 'string') return { valid: false, error: 'Upstash token is required' };
    if (!url.startsWith('https://')) return { valid: false, error: 'Upstash URL must start with https://' };
    return { valid: true };
  }

  /**
   * Test Upstash connectivity by performing a PING.
   */
  async function testUpstash(url, token) {
    try {
      const resp = await fetch(url.replace(/\/+$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['PING']),
      });
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      const data = await resp.json();
      return { ok: data.result === 'PONG', error: data.result !== 'PONG' ? 'Unexpected response' : null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Send a message to a running loop agent via Upstash.
   */
  async function sendMessage(upstashUrl, upstashToken, loopKey, text) {
    const msg = JSON.stringify({
      ts: Date.now(),
      from: 'user',
      text,
      extra: {},
      read: false,
    });

    // Clear outbox before sending so stale responses don't interfere
    const outboxKey = `loop:${loopKey}:outbox`;
    try {
      await fetch(upstashUrl.replace(/\/+$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['DEL', outboxKey]),
      });
    } catch { /* best effort */ }

    const inboxKey = `loop:${loopKey}:inbox`;
    const resp = await fetch(upstashUrl.replace(/\/+$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstashToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', inboxKey, msg]),
    });
    if (!resp.ok) throw new Error(`Failed to send message: ${resp.status}`);
    return resp.json();
  }

  /**
   * Read the latest response from the loop agent's outbox.
   */
  async function readResponse(upstashUrl, upstashToken, loopKey) {
    const outboxKey = `loop:${loopKey}:outbox`;
    const resp = await fetch(upstashUrl.replace(/\/+$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstashToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['GET', outboxKey]),
    });
    if (!resp.ok) throw new Error(`Failed to read response: ${resp.status}`);
    const data = await resp.json();
    if (!data.result) return null;
    try {
      return JSON.parse(data.result);
    } catch {
      return null;
    }
  }

  /**
   * Get the status of a running loop agent.
   */
  async function getStatus(upstashUrl, upstashToken, loopKey) {
    const statusKey = `loop:${loopKey}:status`;
    const resp = await fetch(upstashUrl.replace(/\/+$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstashToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['GET', statusKey]),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data.result) return null;
    try {
      return JSON.parse(data.result);
    } catch {
      return null;
    }
  }

  /**
   * Clear the status and inbox/outbox of a loop agent.
   * Useful when deleting a workflow to clean up Upstash state.
   */
  async function clearStatus(upstashUrl, upstashToken, loopKey) {
    const keys = [
      `loop:${loopKey}:status`,
      `loop:${loopKey}:inbox`,
      `loop:${loopKey}:outbox`,
    ];
    const resp = await fetch(upstashUrl.replace(/\/+$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${upstashToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['DEL', ...keys]),
    });
    if (!resp.ok) throw new Error(`Upstash error: ${resp.status}`);
    const data = await resp.json();
    return { deletedKeys: data.result || 0 };
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

  /**
   * Poll the outbox for a new response.
   * Returns the parsed response and deletes it from outbox to prevent re-reading.
   * The sinceTs parameter is kept for backward compatibility but the primary
   * mechanism is now presence-based: if an outbox value exists, it is new.
   */
  async function pollResponse(upstashUrl, upstashToken, loopKey, sinceTs = 0) {
    const resp = await readResponse(upstashUrl, upstashToken, loopKey);
    if (!resp) return null;
    // Response exists — consume it by deleting the outbox key
    const outboxKey = `loop:${loopKey}:outbox`;
    try {
      await fetch(upstashUrl.replace(/\/+$/, ''), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${upstashToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['DEL', outboxKey]),
      });
    } catch { /* best effort */ }
    return resp;
  }

  return {
    getRunnerScript,
    generateLoopKey,
    generateWorkflowYaml,
    deploy,
    validateUpstashConfig,
    testUpstash,
    sendMessage,
    readResponse,
    getStatus,
    clearStatus,
    fetchHistory,
    clearMemory,
    pollResponse,
  };
})();

export default LoopAgent;
