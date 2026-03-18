/**
 * app.js — Main coordinator: UI interactions, settings, session lifecycle
 */

import { marked } from 'marked';
import hljs from 'highlight.js';
import 'highlight.js/styles/atom-one-dark.css';

import SoulLoader from './soul-loader.js';
import Chat from './chat.js';
import Storage from './storage.js';
import GitHubActions from './github-actions.js';
import PushooNotifier from './pushoo.js';
import LoopAgent from './loop-agent.js';
import Crypto from './crypto.js';
import { getLang, setLang, t } from './i18n.js';

const App = (() => {
  /* eslint-disable -- keeping original structure */
  // ─── State ─────────────────────────────────────────────────────────
  let passphrase = null;
  let currentSessionId = null;
  let currentSoulName = '';
  let loadedSkillCount = 0;
  let loadedSkills = []; // { url, meta: {name, description}, content } for each loaded skill
  let isStreaming = false;
  let autoSaveTimer = null;
  let baseSoulInstruction = ''; // assembled system instruction (SOUL + Skills)
  let soulOnlyInstruction = ''; // SOUL-only text, used for dynamic skill recomposition
  let currentLang = 'en';

  // ─── Loop State ─────────────────────────────────────────────────────
  let _loopConnectedKey = null;   // Currently connected loop agent key (null = not connected)
  let _loopPollTimer = null;      // Timeout for polling loop agent responses
  let _loopPollReset = null;      // Function to reset adaptive polling to fast mode
  let openPushooConfigDialog = null;

  function getLoopDataRepoForKey(loopKey) {
    if (!currentSessionId || !loopKey) return null;
    const cfg = getSessionConfig(currentSessionId);
    const mapped = cfg.loopDataRepos?.[loopKey];
    if (mapped?.owner && mapped?.repo) return mapped;
    return null;
  }

  function disconnectLoopAgent() {
    if (_loopPollTimer) {
      clearTimeout(_loopPollTimer);
      _loopPollTimer = null;
    }
    _loopConnectedKey = null;
    _loopPollReset = null;
    const banner = document.getElementById('loop-connect-banner');
    if (banner) {
      banner.classList.add('hidden');
      banner.style.display = 'none';
    }
  }

  // ─── Loop Agent Status Panel ───────────────────────────────────────
  let _loopStatusPanelVisible = false;

  function showLoopStatusPanel() {
    const panel = document.getElementById('loop-status-panel');
    if (panel) {
      panel.classList.remove('hidden');
      panel.style.display = 'block';
      _loopStatusPanelVisible = true;
    }
  }

  function hideLoopStatusPanel() {
    const panel = document.getElementById('loop-status-panel');
    if (panel) {
      panel.classList.add('hidden');
      panel.style.display = 'none';
      _loopStatusPanelVisible = false;
    }
  }

  async function refreshLoopStatusPanel() {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    const loopKeys = cfg.loopKeys || [];
    const contentEl = document.getElementById('loop-status-content');
    if (!contentEl) return;

    if (loopKeys.length === 0) {
      contentEl.innerHTML = '<span style="opacity:.6">No loop agents deployed in this session.</span>';
      return;
    }

    contentEl.innerHTML = '<span style="opacity:.6">Refreshing…</span>';

    let config;
    try { config = getActionConfig(); }
    catch (e) {
      contentEl.innerHTML = `<span style="color:#e74c3c;">⚠️ ${escapeHtml(e.message)}</span>`;
      return;
    }

    try {
      const recentRuns = await GitHubActions.listRecentRuns(config, null, 30);

      // Build active channel info
      const pushooConfig = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
      const channelSummary = PushooNotifier.getChannelSummary(pushooConfig) || 'None';
      const upstashUrl = cfg.upstashUrl || getSessionSetting('upstashUrl');

      const items = [];
      for (const key of loopKeys) {
        const run = recentRuns.find(r => r.name && r.name.includes(key));
        const isRunning = run && (run.status === 'in_progress' || run.status === 'queued');
        const stateIcon = !run ? '⚪' : isRunning ? '🟢' : run.conclusion === 'success' ? '✅' : '🔴';
        const connected = _loopConnectedKey === key;

        items.push(`
          <div style="background:rgba(255,255,255,.05);border-radius:6px;padding:6px 10px;min-width:200px;position:relative;" data-loop-key="${escapeHtml(key)}" data-run-id="${run ? run.id : ''}" data-is-running="${isRunning ? '1' : '0'}">
            <button class="loop-card-close" data-key="${escapeHtml(key)}" style="position:absolute;top:4px;right:6px;background:none;border:none;color:#e74c3c;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;opacity:.7;" title="${isRunning ? 'Stop & remove' : 'Remove'}">&times;</button>
            <div style="font-weight:600;margin-bottom:2px;padding-right:20px;">${stateIcon} ${escapeHtml(key)} ${connected ? '<span style="color:#4ae168;font-size:10px;">● connected</span>' : ''}</div>
            <div style="opacity:.7;">Channel: ${escapeHtml(channelSummary)}</div>
            ${upstashUrl ? '<div style="opacity:.7;">Upstash: ✓ configured</div>' : ''}
            ${run ? `<div style="margin-top:4px;"><a href="${run.html_url}" target="_blank" style="color:#8ec5fc;font-size:11px;">View Run →</a></div>` : ''}
            <div style="margin-top:6px;"><button class="loop-card-connect" data-key="${escapeHtml(key)}" style="background:#22863a;color:#fff;border:none;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px;">${connected ? '✓ Connected' : 'Connect'}</button></div>
          </div>
        `);
      }
      contentEl.innerHTML = items.join('');

      // Wire X (close) buttons
      contentEl.querySelectorAll('.loop-card-close').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const key = btn.dataset.key;
          const card = btn.closest('[data-loop-key]');
          const runId = card?.dataset.runId;
          const running = card?.dataset.isRunning === '1';

          if (running && runId) {
            if (!confirm(`Loop agent "${key}" is still running. Stop and remove it?`)) return;
            btn.textContent = '⏳';
            try {
              await GitHubActions.cancelRun(config, runId);
            } catch (err) {
              showToast(`Failed to cancel run: ${err.message}`, 'error');
            }
          }

          // If connected to this key, disconnect first
          if (_loopConnectedKey === key) disconnectLoopAgent();

          // Clean up Upstash keys
          const cfgClean = getSessionConfig(currentSessionId);
          await LoopAgent.cleanupUpstashKeys(key, {
            upstashUrl: cfgClean.upstashUrl || getSessionSetting('upstashUrl') || '',
            upstashToken: cfgClean.upstashToken || getSessionSetting('upstashToken') || '',
          });

          // Remove key from session config
          const cfgDel = getSessionConfig(currentSessionId);
          cfgDel.loopKeys = (cfgDel.loopKeys || []).filter(k => k !== key);
          if (cfgDel.loopDataRepos) delete cfgDel.loopDataRepos[key];
          saveSessionConfig(currentSessionId, cfgDel);

          // Remove card from DOM
          card?.remove();

          // If no more keys, show empty message
          if ((cfgDel.loopKeys || []).length === 0) {
            contentEl.innerHTML = '<span style="opacity:.6">No loop agents deployed in this session.</span>';
          }
        });
      });

      // Wire Connect buttons
      contentEl.querySelectorAll('.loop-card-connect').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          const input = document.getElementById('message-input');
          if (input) {
            input.value = `/loop connect ${key}`;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          // Trigger sendMessage
          document.getElementById('send-btn')?.click();
        });
      });
    } catch (e) {
      contentEl.innerHTML = `<span style="color:#e74c3c;">Failed to fetch status: ${escapeHtml(e.message)}</span>`;
    }
  }

  /**
   * Check what prerequisites are missing for deploying a Loop Agent.
   * Returns { ready: bool, missing: string[] }
   */
  function checkLoopPrerequisites() {
    const missing = [];

    // Check GitHub Actions config
    try { getActionConfig(); }
    catch { missing.push('github_actions'); }

    // Check messaging channel
    const pushooConfig = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
    const hasTelegram = pushooConfig.channels.some(ch => ch.platform === 'telegram' && ch.token);
    const hasWecom = pushooConfig.channels.some(ch => ch.platform === 'wecombot' && ch.token);
    if (!hasTelegram && !hasWecom) missing.push('messaging_channel');

    // Check AI provider and API key
    const provider = getSessionSetting('provider') || inferProviderFromModel(getSessionSetting('model'));
    const model = getSessionSetting('model');
    const apiKey = provider === 'qwen' ? getSessionSetting('qwenApiKey')
      : provider === 'kimi' ? getSessionSetting('kimiApiKey')
      : provider === 'openai' ? getSessionSetting('openaiApiKey')
      : getSessionSetting('apiKey');
    if (!apiKey) missing.push('api_key');
    if (!model) missing.push('model');
    if (provider === 'openai' && !getSessionSetting('openaiBaseUrl')) missing.push('openai_base_url');

    return { ready: missing.length === 0, missing };
  }

  // ─── Built-in Catalog ──────────────────────────────────────────────
  // Cached catalog entries loaded from bundled examples/ directory.
  // Each entry: { name, file, icon, description }
  let _builtinSouls = null;   // Array from examples/souls/index.json
  let _builtinSkills = null;  // Array from examples/skills/index.json

  // Ensure BASE_URL always ends with '/' before appending 'examples/'
  const _base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : import.meta.env.BASE_URL + '/';
  const EXAMPLES_BASE = _base + 'examples/';

  /** Fetch and cache the built-in SOUL catalog. */
  async function getBuiltinSouls() {
    if (_builtinSouls) return _builtinSouls;
    try {
      const resp = await fetch(EXAMPLES_BASE + 'souls/index.json');
      if (!resp.ok) throw new Error(resp.status);
      _builtinSouls = await resp.json();
    } catch { _builtinSouls = []; }
    return _builtinSouls;
  }

  /** Fetch and cache the built-in SKILL catalog. */
  async function getBuiltinSkills() {
    if (_builtinSkills) return _builtinSkills;
    try {
      const resp = await fetch(EXAMPLES_BASE + 'skills/index.json');
      if (!resp.ok) throw new Error(resp.status);
      _builtinSkills = await resp.json();
    } catch { _builtinSkills = []; }
    return _builtinSkills;
  }

  /** Resolve a built-in SOUL file path to full URL. */
  function builtinSoulUrl(filename) {
    return EXAMPLES_BASE + 'souls/' + filename;
  }

  /** Resolve a built-in SKILL file path to full URL. */
  function builtinSkillUrl(filename) {
    return EXAMPLES_BASE + 'skills/' + filename;
  }

  /**
   * Populate the #set-soul-preset <select> with built-in entries.
   * Preserves the "— None —" and "Use URL…" options.
   */
  async function populateSoulPresetSelect() {
    const sel = $('#set-soul-preset');
    if (!sel) return;
    const souls = await getBuiltinSouls();
    // Remove all options except the first two  (— None — and Use URL…)
    while (sel.options.length > 2) sel.remove(2);
    for (const s of souls) {
      const opt = document.createElement('option');
      opt.value = builtinSoulUrl(s.file);
      opt.textContent = `${s.icon || '🧠'} ${s.name}`;
      sel.insertBefore(opt, sel.querySelector('option[value="__custom__"]'));
    }
  }

  // ─── Settings helpers ──────────────────────────────────────────────

  const SETTINGS_KEY = 'browseragent_settings';
  const SESSION_CFG_PREFIX = 'browseragent_session_cfg_';

  // Keys that are per-session (each session stores its own independent copy)
  const SESSION_KEYS = ['apiKey', 'qwenApiKey', 'kimiApiKey', 'openaiApiKey', 'openaiBaseUrl', 'provider', 'model', 'enableSearch', 'enableThinking', 'thinkingBudget', 'includeThoughts', 'soulUrl', 'notionToken', 'corsProxy', 'storageBackend', 'githubToken', 'githubOwner', 'githubRepo', 'githubPath', 'notionStorageToken', 'notionParentPageId', 'actionUseStorage', 'actionBranch', 'actionWorkflow', 'actionArtifactDir', 'actionToken', 'actionOwner', 'actionRepo', 'pushooConfig', 'upstashUrl', 'upstashToken'];

  // Credential-type keys where empty string should be treated as "not set"
  // so the ?? / fallback logic can reach the next level (global settings).
  const CREDENTIAL_KEYS = new Set(['apiKey', 'qwenApiKey', 'kimiApiKey', 'openaiApiKey', 'openaiBaseUrl', 'githubToken', 'githubOwner', 'githubRepo', 'githubPath', 'notionStorageToken', 'notionParentPageId', 'actionToken', 'actionOwner', 'actionRepo', 'notionToken', 'pushooConfig', 'upstashUrl', 'upstashToken']);

  /**
   * Read a value from a config object with fallback, treating empty strings
   * as "not set" for credential-type keys.
   */
  function cfgGet(cfg, key, fallback) {
    const val = cfg[key];
    if (val == null) return fallback;
    if (val === '' && CREDENTIAL_KEYS.has(key)) return fallback;
    return val;
  }

  function inferProviderFromModel(model, fallback = 'gemini') {
    if (!model) return fallback;
    const m = String(model).toLowerCase();
    if (m.startsWith('qwen') || m.startsWith('qwq')) return 'qwen';
    if (m.startsWith('kimi') || m.startsWith('moonshot')) return 'kimi';
    if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('deepseek') || m.startsWith('claude')) return 'openai';
    return 'gemini';
  }

  function inferModelDimensions(provider, model) {
    const modelId = (model || '').trim().toLowerCase();
    const fallback = { search: true, thinking: false };
    if (!modelId) return fallback;

    const known = Chat.MODELS.find((m) =>
      (m.provider || inferProviderFromModel(m.id)) === provider &&
      m.id.toLowerCase() === modelId
    );
    if (known?.dimensions) return known.dimensions;

    if (provider === 'qwen') {
      return {
        search: /^qwen3-|^qwen-(max|plus|turbo)/.test(modelId),
        thinking: /^qwen3-|^qwq-/.test(modelId),
      };
    }

    if (provider === 'kimi') {
      return {
        search: false,
        thinking: /thinking|k2\.5/.test(modelId),
      };
    }

    return {
      search: true,
      thinking: /gemini-2\.5/.test(modelId),
    };
  }

  // SOUL/Skills are loaded by user-provided URLs only.

  function getSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveSettings(s) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function getSetting(key, fallback = '') {
    return getSettings()[key] ?? fallback;
  }

  function setSetting(key, value) {
    const s = getSettings();
    s[key] = value;
    saveSettings(s);
  }

  // ─── Per-Session Settings ──────────────────────────────────────────

  function getSessionConfig(sessionId) {
    try {
      return JSON.parse(localStorage.getItem(SESSION_CFG_PREFIX + sessionId)) || {};
    } catch {
      return {};
    }
  }

  function saveSessionConfig(sessionId, cfg) {
    localStorage.setItem(SESSION_CFG_PREFIX + sessionId, JSON.stringify(cfg));
  }

  function removeSessionConfig(sessionId) {
    localStorage.removeItem(SESSION_CFG_PREFIX + sessionId);
  }

  /**
   * Get a setting for the current session.
   * Falls back to global default if not set per-session.
   */
  function getSessionSetting(key, fallback = '') {
    if (!currentSessionId) return getSetting(key, fallback);
    const cfg = getSessionConfig(currentSessionId);
    const val = cfg[key];
    // For credential keys, treat empty string as "not set" so we fall through to global
    if (val == null || (val === '' && CREDENTIAL_KEYS.has(key))) {
      return getSetting(key, fallback);
    }
    return val;
  }

  function setSessionSetting(key, value) {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    cfg[key] = value;
    saveSessionConfig(currentSessionId, cfg);
  }

  /**
   * Initialize a new session's config by copying current global defaults
   */
  function initSessionConfig(sessionId) {
    const cfg = {};
    for (const key of SESSION_KEYS) {
      const val = getSetting(key);
      if (val !== '' && val != null) {
        cfg[key] = val;
      }
    }
    saveSessionConfig(sessionId, cfg);
  }

  /**
   * Persist the current loadedSkills URL list into the session config.
   */
  function saveSessionSkills() {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    cfg.skillUrls = loadedSkills.map(s => s.url);
    saveSessionConfig(currentSessionId, cfg);
  }

  /**
   * Restore skills saved in the session config (without triggering another save).
   */
  async function restoreSessionSkills() {
    if (!currentSessionId) return;
    const cfg = getSessionConfig(currentSessionId);
    const urls = cfg.skillUrls || [];
    for (const url of urls) {
      if (loadedSkills.find(s => s.url === url)) continue; // already loaded
      try {
        const raw = await SoulLoader.fetchRawText(url);
        const parsed = SoulLoader.parseSkillFile(raw);
        parsed.url = url;
        loadedSkills.push(parsed);
      } catch (e) {
        console.warn(`[Skills] Failed to restore skill ${url}:`, e);
      }
    }
    applySkillsToInstruction();
  }

  // ─── Marked.js config ─────────────────────────────────────────────

  function configureMarked() {
    marked.setOptions({
      breaks: true,
      gfm: true,
      highlight: function (code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try {
            return hljs.highlight(code, { language: lang }).value;
          } catch {}
        }
        try {
          return hljs.highlightAuto(code).value;
        } catch {}
        return code;
      },
    });
  }

  // ─── UI Helpers ────────────────────────────────────────────────────

  function $(sel) {
    return document.querySelector(sel);
  }

  function $$(sel) {
    return document.querySelectorAll(sel);
  }

  function show(el) {
    if (typeof el === 'string') el = $(el);
    if (el) el.classList.remove('hidden');
  }

  function hide(el) {
    if (typeof el === 'string') el = $(el);
    if (el) el.classList.add('hidden');
  }

  function tl(key) {
    return t(currentLang, key);
  }

  function applyLanguageToStaticUi() {
    const setText = (selector, key) => {
      const el = $(selector);
      if (el) el.textContent = tl(key);
    };
    const setPlaceholder = (selector, key) => {
      const el = $(selector);
      if (el) el.placeholder = tl(key);
    };
    const setTitle = (selector, key) => {
      const el = $(selector);
      if (el) el.title = tl(key);
    };

    const langBtn = $('#lang-toggle-btn');
    if (langBtn) {
      langBtn.textContent = tl('languageLabel');
      langBtn.title = tl('switchLanguageTitle');
    }

    const sessionsTitle = document.querySelector('.sidebar-header h3');
    if (sessionsTitle) sessionsTitle.textContent = tl('sessions');

    setTitle('#sidebar-toggle', 'toggleSidebarTitle');
    setTitle('#restore-sessions-btn', 'restoreTitle');
    setTitle('#new-session-btn', 'newSessionTitle');
    setTitle('#token-display', 'tokenTitle');
    setTitle('#settings-btn', 'settingsTitle');
    setTitle('#send-btn', 'sendTitle');
    setTitle('#stop-btn', 'stopTitle');

    const quickSkills = $('#quick-btn-skills');
    if (quickSkills) {
      quickSkills.innerHTML = `🧩 ${tl('quickSkills')}`;
      quickSkills.title = tl('quickSkills');
    }

    const quickSouls = $('#quick-btn-souls');
    if (quickSouls) {
      quickSouls.innerHTML = `🧠 ${tl('quickSouls')}`;
      quickSouls.title = tl('quickSouls');
    }

    const quickLoop = $('#quick-btn-loop');
    if (quickLoop) {
      quickLoop.innerHTML = `🔄 ${tl('quickLoopBrief')}`;
      quickLoop.title = tl('quickLoopBrief');
    }

    // Update page title
    document.title = tl('pageTitle');

    // Settings panel labels and hints
    setText('#settings-title', `⚙ ${tl('settingsTitle')}`);
    setText('#passphrase-field-top label', `🔐 ${tl('passphraseLabel')}`);
    setPlaceholder('#set-passphrase', 'passphrasePlaceholder');
    const passphraseHint = $('#passphrase-field-top .hint');
    if (passphraseHint) passphraseHint.textContent = tl('passphraseHint');

    setText('#settings-section-ai .settings-group-title', tl('aiConfig'));
    setText('label[for="set-provider"]', tl('aiProvider'));
    const providerSelect = $('#set-provider');
    if (providerSelect?.options?.[0]) providerSelect.options[0].textContent = tl('aiProviderSelect');
    const aiHint = $('#set-provider')?.parentElement?.querySelector('.hint');
    if (aiHint) aiHint.textContent = tl('aiHint');
    setText('label[for="set-model"]', tl('aiModel'));
    setPlaceholder('#set-model', 'aiModelPlaceholder');
    const modelHint = $('#set-model')?.parentElement?.querySelector('.hint');
    if (modelHint) modelHint.textContent = tl('aiModelHint');
    setText('#gemini-fields label', tl('setupApiKeyGemini'));
    const geminiHint = $('#gemini-fields .hint');
    if (geminiHint) geminiHint.textContent = tl('geminiKeyHint');
    setText('#qwen-fields label', tl('setupApiKeyQwen'));
    const qwenHint = $('#qwen-fields .hint');
    if (qwenHint) qwenHint.textContent = tl('qwenKeyHint');
    setText('#kimi-fields label', tl('setupApiKeyKimi'));
    const kimiHint = $('#kimi-fields .hint');
    if (kimiHint) kimiHint.textContent = tl('kimiKeyHint');

    const searchToggle = $('#set-enable-search')?.closest('label')?.querySelector('span');
    if (searchToggle) searchToggle.textContent = tl('enableSearchGrounding');
    const thinkToggle = $('#set-enable-thinking')?.closest('label')?.querySelector('span');
    if (thinkToggle) thinkToggle.textContent = tl('enableThinking');
    setText('label[for="set-thinking-budget"]', tl('thinkingBudget'));
    const budgetHint = $('#set-thinking-budget')?.parentElement?.querySelector('.hint');
    if (budgetHint) budgetHint.textContent = tl('thinkingBudgetHint');
    const includeThoughtsToggle = $('#set-include-thoughts')?.closest('label')?.querySelector('span');
    if (includeThoughtsToggle) includeThoughtsToggle.textContent = tl('includeThoughts');
    const includeThoughtsHint = $('#set-include-thoughts')?.closest('.settings-field')?.querySelector('.hint');
    if (includeThoughtsHint) includeThoughtsHint.textContent = tl('includeThoughtsHint');

    setText('#settings-section-soul .settings-group-title', tl('personalitySkills'));
    setText('label[for="set-soul-preset"]', tl('soulSource'));
    const soulPreset = $('#set-soul-preset');
    if (soulPreset?.options?.[0]) soulPreset.options[0].textContent = tl('soulNone');
    const customOpt = soulPreset?.querySelector('option[value="__custom__"]');
    if (customOpt) customOpt.textContent = tl('soulUseUrl');
    const soulSourceHint = $('#set-soul-preset')?.parentElement?.querySelector('.hint');
    if (soulSourceHint) soulSourceHint.textContent = tl('soulSourceHint');
    setText('label[for="set-soul-url"]', tl('soulUrl'));
    const soulUrlHint = $('#set-soul-url')?.parentElement?.querySelector('.hint');
    if (soulUrlHint) soulUrlHint.textContent = tl('soulUrlHint');
    setText('label[for="set-notion-token"]', tl('notionTokenOpt'));
    const notionTokenHint = $('#set-notion-token')?.parentElement?.querySelector('.hint');
    if (notionTokenHint) notionTokenHint.textContent = tl('notionTokenHint');
    setText('label[for="set-cors-proxy"]', tl('corsProxy'));
    const corsHint = $('#set-cors-proxy')?.parentElement?.querySelector('.hint');
    if (corsHint) corsHint.textContent = tl('corsProxyHint');

    setText('#settings-section-storage .settings-group-title', tl('encryptedStorage'));
    setText('label[for="set-storage-backend"]', tl('storageBackend'));
    const storage = $('#set-storage-backend');
    if (storage?.options?.[0]) storage.options[0].textContent = tl('storageLocal');
    if (storage?.options?.[1]) storage.options[1].textContent = tl('storageGithub');
    if (storage?.options?.[2]) storage.options[2].textContent = tl('storageNotion');
    setText('label[for="set-github-token"]', tl('githubPat'));
    const ghPatHint = $('#set-github-token')?.parentElement?.parentElement?.querySelector('.hint');
    if (ghPatHint) ghPatHint.textContent = tl('githubPatHint');
    setText('label[for="set-github-owner"]', tl('repoOwner'));
    setText('label[for="set-github-repo"]', tl('repoName'));
    setText('label[for="set-github-path"]', tl('sessionsDir'));
    setText('#auto-create-repo-btn', `🚀 ${tl('autoCreateRepo')}`);
    const privateRepoSpan = $('#set-repo-private')?.closest('label')?.querySelector('span');
    if (privateRepoSpan) privateRepoSpan.textContent = tl('privateRepo');
    const autoRepoHint = $('#auto-create-repo-btn')?.parentElement?.querySelector('.hint');
    if (autoRepoHint) autoRepoHint.textContent = tl('autoCreateRepoHint');
    setText('label[for="set-notion-storage-token"]', tl('notionIntegrationToken'));
    setText('label[for="set-notion-parent-page"]', tl('notionParentPage'));
    const notionParentHint = $('#set-notion-parent-page')?.parentElement?.querySelector('.hint');
    if (notionParentHint) notionParentHint.textContent = tl('notionParentHint');

    setText('#settings-section-exec .settings-group-title', `⚡ ${tl('execTitle')}`);
    const useStorageSpan = $('#set-action-use-storage')?.closest('label')?.querySelector('span');
    if (useStorageSpan) useStorageSpan.textContent = tl('useStorageRepo');
    const useStorageHint = $('#set-action-use-storage')?.closest('.settings-field')?.querySelector('.hint');
    if (useStorageHint) useStorageHint.textContent = tl('useStorageRepoHint');
    setText('label[for="set-action-token"]', tl('githubToken'));
    const actionPatHint = $('#set-action-token')?.parentElement?.parentElement?.querySelector('.hint');
    if (actionPatHint) actionPatHint.textContent = tl('githubActionPatHint');
    setText('label[for="set-action-owner"]', tl('repoOwner'));
    setText('label[for="set-action-repo"]', tl('repoName'));
    setText('#auto-create-action-repo-btn', `🚀 ${tl('actionAutoRepo')}`);
    const privateActionRepoSpan = $('#set-action-repo-private')?.closest('label')?.querySelector('span');
    if (privateActionRepoSpan) privateActionRepoSpan.textContent = tl('privateRepo');
    setText('label[for="set-action-branch"]', tl('branch'));
    setText('label[for="set-action-workflow"]', tl('workflowFile'));
    const wfHint = $('#set-action-workflow')?.parentElement?.querySelector('.hint');
    if (wfHint) wfHint.textContent = tl('workflowFileHint');
    setText('label[for="set-action-dir"]', tl('artifactsDir'));
    const artifactsHint = $('#set-action-dir')?.parentElement?.querySelector('.hint');
    if (artifactsHint) artifactsHint.textContent = tl('artifactsDirHint');

    // Loop Agent section
    setText('#settings-section-loop .settings-group-title', `🔄 ${tl('loopAgentTitle')}`);

    setText('#settings-section-notify .settings-group-title', `🔔 ${tl('notifyTitle')}`);
    const pushooLabel = $('#pushoo-config-btn')?.closest('.settings-field')?.querySelector('label');
    if (pushooLabel) {
      const badge = $('#pushoo-status-badge')?.outerHTML || '';
      pushooLabel.innerHTML = `${tl('pushooLabel')} ${badge}`;
    }
    setText('#pushoo-config-btn', `⚙️ ${tl('configPushoo')}`);
    const pushooHint = $('#pushoo-config-btn')?.parentElement?.querySelector('.hint');
    if (pushooHint) pushooHint.childNodes[0].textContent = `${tl('pushooHint')} — `;

    setText('#reload-soul-btn', `↻ ${tl('reloadSoul')}`);
    const applyBtn = $('#apply-settings');
    if (applyBtn && !applyBtn.textContent.includes('Start') && !applyBtn.textContent.includes('开始')) {
      applyBtn.textContent = tl('settingsSaveApply');
    }

    // Restore dialog
    const restoreCardTitle = $('#restore-dialog h3');
    if (restoreCardTitle) restoreCardTitle.textContent = `⬇ ${tl('restoreDialogTitle')}`;
    const restoreDesc = $('#restore-dialog p');
    if (restoreDesc) restoreDesc.textContent = tl('restoreDialogDesc');
    setPlaceholder('#restore-github-token', 'restorePatPlaceholder');
    setPlaceholder('#restore-github-owner', 'restoreOwnerPlaceholder');
    setPlaceholder('#restore-github-repo', 'restoreRepoPlaceholder');
    setPlaceholder('#restore-github-path', 'restorePathPlaceholder');
    setText('#restore-cancel', tl('cancel'));
    setText('#restore-submit', tl('restore'));

    // Passphrase dialog
    const decryptTitle = $('#passphrase-dialog h3');
    if (decryptTitle) decryptTitle.textContent = `🔐 ${tl('decryptSession')}`;
    const decryptDesc = $('#passphrase-message');
    if (decryptDesc) decryptDesc.textContent = tl('decryptDesc');
    setPlaceholder('#passphrase-input', 'passphrasePlaceholder');
    setText('#passphrase-cancel', tl('cancel'));
    setText('#passphrase-submit', tl('decrypt'));

    // Pushoo modal
    const pushooModalTitle = $('#pushoo-config-dialog h2');
    if (pushooModalTitle) pushooModalTitle.textContent = `📢 ${tl('pushooModalTitle')}`;
    const pushooModalDesc = $('#pushoo-config-dialog .modal-body p');
    if (pushooModalDesc) pushooModalDesc.childNodes[0].textContent = `${tl('pushooModalDesc')} `;
    const pushooEnableText = $('#pushoo-enabled')?.parentElement;
    if (pushooEnableText) {
      pushooEnableText.childNodes[1].textContent = ` ${tl('enablePushoo')}`;
    }
    setText('label[for="pushoo-platform"]', tl('platform'));
    setText('label[for="pushoo-token"]', tl('tokenKey'));
    setText('#pushoo-config-cancel', tl('cancel'));
    setText('#pushoo-config-save', tl('save'));
  }

  function applyLanguageAndRefresh() {
    applyLanguageToStaticUi();
    setInputEnabled(!!currentSessionId);
    updateSoulStatus();

    // Refresh currently rendered informational screens.
    if (!currentSessionId) {
      showLanding();
      return;
    }

    const hasMessages = Chat.getHistory().length > 0;
    if (!hasMessages) {
      showWelcome();
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    // Pre-process: extract <details> blocks, render their inner markdown separately,
    // then stitch back. This is needed because marked.js treats content inside
    // HTML block tags as raw HTML and skips markdown parsing.
    const detailsRegex = /(<details[\s\S]*?<\/summary>)([\s\S]*?)(<\/details>)/gi;
    const processed = text.replace(detailsRegex, (_, open, inner, close) => {
      const renderedInner = marked.parse(inner.trim());
      return `${open}\n${renderedInner}\n${close}`;
    });
    return marked.parse(processed);
  }

  function scrollToBottom() {
    const chatBox = $('#chat-box');
    if (chatBox) {
      chatBox.scrollTop = chatBox.scrollHeight;
    }
  }

  function showSaveIndicator() {
    let dot = $('#save-indicator');
    if (!dot) {
      dot = document.createElement('span');
      dot.id = 'save-indicator';
      dot.className = 'save-indicator';
      dot.textContent = tl('saveIndicator');
      const header = $('.header');
      if (header) header.appendChild(dot);
    }
    dot.classList.remove('fade');
    void dot.offsetWidth; // reflow
    dot.classList.add('show');
    clearTimeout(dot._timer);
    dot._timer = setTimeout(() => {
      dot.classList.add('fade');
    }, 1200);
  }

  function showToast(message, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('toast-fade');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ─── Message Rendering ────────────────────────────────────────────

  function addMessageBubble(role, content, isHtml = false) {
    const chatBox = $('#chat-box');
    const wrapper = document.createElement('div');
    wrapper.className = `message-wrapper ${role}`;

    const bubble = document.createElement('div');
    bubble.className = `message-bubble ${role}`;
    if (isHtml) {
      bubble.innerHTML = content;
    } else {
      bubble.innerHTML = renderMarkdown(content);
    }

    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);
    scrollToBottom();

    // Highlight code blocks
    bubble.querySelectorAll('pre code').forEach((block) => {
      hljs.highlightElement(block);
    });

    // Add artifact toolbars for model messages
    if (role === 'model' && !isHtml) {
      // Legacy: handle DEPLOY_BUNDLE format from older skill-guided responses
      if (hasDeployBundle(content)) {
        renderDeployBundleCard(bubble, content);
      } else {
        addCodeBlockToolbars(bubble, content);
      }
    }

    return bubble;
  }

  function addErrorBubble(message) {
    const chatBox = $('#chat-box');
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper model';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble error-bubble';
    // Show each line of the error message (hint \n details)
    const lines = message.split('\n');
    bubble.innerHTML = lines.map((l, i) =>
      i === 0
        ? `<strong>${escapeHtml(l)}</strong>`
        : `<span class="error-detail">${escapeHtml(l)}</span>`
    ).join('<br>');

    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);
    scrollToBottom();
  }

  function createStreamingBubble() {
    const chatBox = $('#chat-box');
    const wrapper = document.createElement('div');
    wrapper.className = 'message-wrapper model';
    wrapper.id = 'streaming-wrapper';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble model streaming';
    bubble.id = 'streaming-bubble';
    bubble.innerHTML = '<span class="cursor-blink">▊</span>';

    wrapper.appendChild(bubble);
    chatBox.appendChild(wrapper);
    scrollToBottom();
    return bubble;
  }

  function finalizeStreamingBubble(fullText) {
    const bubble = $('#streaming-bubble');
    if (!bubble) return;

    bubble.classList.remove('streaming');
    bubble.removeAttribute('id');

    const wrapper = $('#streaming-wrapper');
    if (wrapper) wrapper.removeAttribute('id');

    // Legacy: handle DEPLOY_BUNDLE format from older skill-guided responses
    if (hasDeployBundle(fullText)) {
      bubble.innerHTML = renderMarkdown(fullText);
      renderDeployBundleCard(bubble, fullText);
    } else {
      bubble.innerHTML = renderMarkdown(fullText);

      // Highlight code blocks
      bubble.querySelectorAll('pre code').forEach((block) => {
        hljs.highlightElement(block);
      });

      // Add artifact toolbars (Push / Run buttons)
      addCodeBlockToolbars(bubble, fullText);
    }

    scrollToBottom();
  }

  // ─── Session Management ────────────────────────────────────────────

  function generateTitle(message) {
    return message.slice(0, 40).replace(/\n/g, ' ') + (message.length > 40 ? '…' : '');
  }

  function getCurrentSessionData() {
    const messages = Chat.getHistory().map((h, i) => ({
      role: h.role,
      content: h.parts?.[0]?.text || '',
      ts: new Date().toISOString(),
    }));

    return {
      id: currentSessionId,
      title: messages[0]?.content
        ? generateTitle(messages[0].content)
        : 'Empty Session',
      soulName: currentSoulName,
      backend: getSessionSetting('storageBackend', 'local'),
      createdAt:
        Storage.getIndex().find((s) => s.id === currentSessionId)?.createdAt ||
        new Date().toISOString(),
      messages,
    };
  }

  async function saveCurrentSession() {
    if (!currentSessionId) return;
    const history = Chat.getHistory();
    if (history.length === 0) return;

    // Recover passphrase from session config if not in memory
    if (!passphrase) {
      const cfg = getSessionConfig(currentSessionId);
      if (cfg.passphrase) {
        passphrase = cfg.passphrase;
      } else {
        // Cannot save without passphrase — should not happen if setup was correct
        console.warn('No passphrase set, cannot save session');
        return;
      }
    }

    const data = getCurrentSessionData();
    const backend = getSessionSetting('storageBackend', 'local');

    try {
      if (backend === 'github') {
        const config = {
          token: getSessionSetting('githubToken'),
          owner: getSessionSetting('githubOwner'),
          repo: getSessionSetting('githubRepo'),
          path: getSessionSetting('githubPath', 'sessions'),
        };
        if (!config.token || !config.owner || !config.repo) {
          // Credentials incomplete — fall back to local save so data is not lost
          console.warn('[Save] GitHub credentials incomplete, falling back to local. session=', currentSessionId,
            'token?', !!config.token, 'owner?', !!config.owner, 'repo?', !!config.repo);
          await Storage.Local.save(data, passphrase);
          showToast(tl('toastGithubFallbackLocal'), 'warn');
          showSaveIndicator();
          return;
        }
        await Storage.GitHub.save(data, passphrase, config);
      } else if (backend === 'notion') {
        const config = {
          token: getSessionSetting('notionStorageToken'),
          parentPageId: getSessionSetting('notionParentPageId'),
          corsProxy: getSessionSetting('corsProxy'),
        };
        if (!config.token || !config.parentPageId) {
          console.warn('[Save] Notion credentials incomplete, falling back to local. session=', currentSessionId);
          await Storage.Local.save(data, passphrase);
          showToast(tl('toastNotionFallbackLocal'), 'warn');
          showSaveIndicator();
          return;
        }
        await Storage.Notion.save(data, passphrase, config);
      } else {
        await Storage.Local.save(data, passphrase);
      }
      showSaveIndicator();
    } catch (err) {
      console.error('Auto-save failed:', err);
      // If encryption/save failed, clear passphrase so next save re-prompts
      const isDecryptError = /decrypt|cipher|tag|operation/i.test(err.message);
      if (isDecryptError) passphrase = null;
      showToast(`Save failed: ${err.message}`, 'error');
    }
  }

  async function loadSession(sessionId) {
    const entry = Storage.getIndex().find((s) => s.id === sessionId);
    const loadCfg = getSessionConfig(sessionId);
    const loadGet = (key, fb) => cfgGet(loadCfg, key, getSetting(key, fb));
    const backend = entry?.backend || loadGet('storageBackend', 'local');

    // Always prompt passphrase via dialog for loading
    const pass = await promptPassphrase(tl('decryptDesc'));
    if (!pass) return; // user cancelled

    // Clean up incomplete setup if switching away
    if (_setupSessionId && _setupStep > 0 && _setupSessionId !== sessionId) {
      cleanupIncompleteSetup(_setupSessionId);
    }

    try {
      let data;
      if (backend === 'github') {
        const config = {
          token: loadGet('githubToken', ''),
          owner: loadGet('githubOwner', ''),
          repo: loadGet('githubRepo', ''),
          path: loadGet('githubPath', 'sessions'),
        };
        data = await Storage.GitHub.load(sessionId, pass, config);
      } else if (backend === 'notion') {
        const config = {
          token: loadGet('notionStorageToken', ''),
          parentPageId: loadGet('notionParentPageId', ''),
          corsProxy: loadGet('corsProxy', ''),
        };
        data = await Storage.Notion.load(sessionId, pass, config);
      } else {
        data = await Storage.Local.load(sessionId, pass);
      }

      // Success — store passphrase in memory + config for future saves
      passphrase = pass;
      const cfg = getSessionConfig(sessionId);
      cfg.passphrase = pass;
      saveSessionConfig(sessionId, cfg);

      // Reset SOUL / skills in-memory state before restoring for this session
      loadedSkills = [];
      loadedSkillCount = 0;
      currentSoulName = '';
      soulOnlyInstruction = '';
      baseSoulInstruction = '';

      currentSessionId = data.id;
      currentSoulName = data.soulName || '';

      // Sync metadata back to index (restores title after GitHub restore)
      const indexEntry = Storage.getIndex().find(s => s.id === sessionId);
      if (indexEntry) {
        indexEntry.title = data.title || indexEntry.title;
        indexEntry.soulName = data.soulName || indexEntry.soulName || '';
        indexEntry.updatedAt = data.updatedAt || indexEntry.updatedAt;
        indexEntry.createdAt = data.createdAt || indexEntry.createdAt;
        const fullIndex = Storage.getIndex().map(s => s.id === sessionId ? indexEntry : s);
        Storage.saveIndex(fullIndex);
        renderSidebar();
      }

      const history = data.messages.map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
      }));
      Chat.setHistory(history);

      $('#chat-box').innerHTML = '';
      for (const msg of data.messages) {
        addMessageBubble(msg.role === 'model' ? 'model' : 'user', msg.content);
      }

      setInputEnabled(true);
      show('#token-display');
      updateSidebarActive(sessionId);

      // Restore SOUL + skills for this session
      await loadSoulAndSkills();
    } catch (err) {
      console.error('Load failed:', err);
      const isDecryptError = /decrypt|cipher|tag|operation/i.test(err.message);
      if (isDecryptError) {
        showToast(tl('toastDecryptFailed'), 'error');
      } else {
        showToast(`Load failed: ${err.message}`, 'error');
      }
      passphrase = null;
    }
  }

  async function activateSession(sessionId, newPassphrase = null) {
    currentSessionId = sessionId;
    passphrase = newPassphrase;
    loadedSkills = [];
    loadedSkillCount = 0;
    currentSoulName = '';        // reset immediately so /soul shows correct state
    soulOnlyInstruction = '';
    baseSoulInstruction = '';
    Chat.clearHistory();
    Chat.resetTokenUsage();
    $('#chat-box').innerHTML = '';
    setInputEnabled(true);
    show('#token-display');
    showWelcome();
    updateSidebarActive(null);
    updateTokenDisplay();

    // Load SOUL and restore skills
    await loadSoulAndSkills();
  }

  async function startNewSession() {
    const id = Storage.uuid();
    initSessionConfig(id);
    await activateSession(id);
  }

  // ─── Sidebar ───────────────────────────────────────────────────────

  function renderSidebar() {
    const list = $('#session-list');
    const index = Storage.getIndex();
    list.innerHTML = '';

    if (index.length === 0) {
      list.innerHTML =
        `<div class="session-empty">${tl('noSavedSessions')}</div>`;
      return;
    }

    for (const entry of index) {
      const item = document.createElement('div');
      item.className = `session-item ${
        entry.id === currentSessionId ? 'active' : ''
      }`;
      item.dataset.id = entry.id;

      const title = document.createElement('div');
      title.className = 'session-title';
      title.textContent = entry.title || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'session-meta';
      const date = new Date(entry.updatedAt || entry.createdAt);
      const backendLabel = { github: '☁ GitHub', notion: '📓 Notion', local: '💾 Local' }[entry.backend || 'local'] || '💾 Local';
      meta.innerHTML = `<span class="session-backend-badge backend-${entry.backend || 'local'}">${backendLabel}</span> · ${entry.soulName ? entry.soulName + ' · ' : ''}${date.toLocaleDateString()}`;

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'session-delete';
      deleteBtn.textContent = '×';
      deleteBtn.title = 'Delete session';
      deleteBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm(tl('confirmDeleteSession'))) return;
        try {
          const backend = entry.backend || 'local';
          const delCfg = getSessionConfig(entry.id);
          const delGet = (key, fb) => cfgGet(delCfg, key, getSetting(key, fb));
          if (backend === 'github') {
            await Storage.GitHub.remove(entry.id, {
              token: delGet('githubToken', ''),
              owner: delGet('githubOwner', ''),
              repo: delGet('githubRepo', ''),
              path: delGet('githubPath', 'sessions'),
            });
          } else if (backend === 'notion') {
            await Storage.Notion.remove(entry.id, {
              token: delGet('notionStorageToken', ''),
              parentPageId: delGet('notionParentPageId', ''),
              corsProxy: delGet('corsProxy', ''),
            });
          } else {
            await Storage.Local.remove(entry.id);
          }
          // If deleting a session that's in guided setup, clean up setup state
          if (entry.id === _setupSessionId && _setupStep > 0) {
            _setupSessionId = null;
            _setupStep = 0;
          }
          removeSessionConfig(entry.id);
          renderSidebar();
          
          // If deleted session is current, switch to another or show landing
          if (entry.id === currentSessionId) {
            const remaining = Storage.getIndex();
            if (remaining.length > 0) {
              // Activate another session
              await activateSession(remaining[0].id);
            } else {
              // No sessions left - show landing page
              currentSessionId = null;
              setInputEnabled(false);
              showLanding();
            }
          }
          
          showToast(tl('toastSessionDeleted'), 'success');
        } catch (err) {
          showToast(`Delete failed: ${err.message}`, 'error');
        }
      };

      const settingsBtn = document.createElement('button');
      settingsBtn.className = 'session-settings-btn';
      settingsBtn.textContent = '⚙';
      settingsBtn.title = 'Session settings';
      settingsBtn.onclick = (e) => {
        e.stopPropagation();
        openSettings(entry.id);
      };

      const actions = document.createElement('div');
      actions.className = 'session-actions';
      actions.appendChild(settingsBtn);
      actions.appendChild(deleteBtn);

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(actions);
      item.onclick = () => {
        if (entry.id === currentSessionId) return; // already active
        loadSession(entry.id);
      };
      list.appendChild(item);
    }
  }

  function updateSidebarActive(id) {
    $$('.session-item').forEach((el) => {
      el.classList.toggle('active', el.dataset.id === id);
    });
  }

  // ─── Welcome Screen ───────────────────────────────────────────────

  function showLanding() {
    const chatBox = $('#chat-box');
    chatBox.innerHTML = `
      <div class="welcome-screen">
        <div class="welcome-logo">🍤</div>
        <h2>${tl('landingTitle')}</h2>
        <p>${tl('landingDesc')}</p>
        <div class="landing-features">
          <div class="landing-feature landing-feature-highlight">
            <strong>${tl('featureLoopTitle')}</strong>
            <span>${tl('featureLoopDesc')}</span>
          </div>
          <div class="landing-feature">
            <strong>${tl('featureSecureTitle')}</strong>
            <span>${tl('featureSecureDesc')}</span>
          </div>
          <div class="landing-feature">
            <strong>${tl('featureSoulTitle')}</strong>
            <span>${tl('featureSoulDesc')}</span>
          </div>
          <div class="landing-feature">
            <strong>${tl('featureStorageTitle')}</strong>
            <span>${tl('featureStorageDesc')}</span>
          </div>
          <div class="landing-feature">
            <strong>${tl('featureGroundingTitle')}</strong>
            <span>${tl('featureGroundingDesc')}</span>
          </div>
          <div class="landing-feature">
            <strong>${tl('featureActionsTitle')}</strong>
            <span>${tl('featureActionsDesc')}</span>
          </div>
        </div>
        <p class="landing-cta">${tl('landingCta').replace('+', '<strong>+</strong>')}</p>
      </div>
    `;
  }

  function showWelcome() {
    const chatBox = $('#chat-box');
    chatBox.innerHTML = `
      <div class="welcome-screen">
        <div class="welcome-logo">🍤</div>
        <h2>${tl('landingTitle')}</h2>
        <p>${tl('welcomeDesc')}</p>
        <div class="welcome-status">
          <span id="soul-status" class="status-badge">${tl('statusNoSoul')}</span>
          <span id="skill-status" class="status-badge">0 Skills</span>
        </div>
        <div class="welcome-hints">
          <p>${tl('welcomeHintsStart')}</p>
          <code>/loop</code> Deploy Loop Agent &nbsp;
          <code>/clear</code> ${tl('slashClearShort')} &nbsp;
          <code>/compact</code> ${tl('slashCompactShort')} &nbsp;
          <code>/soul</code> ${tl('slashSoulShort')} &nbsp;
          <code>/skills</code> ${tl('slashSkillsShort')} &nbsp;
        </div>
      </div>
    `;
    updateSoulStatus();
  }

  function updateSoulStatus() {
    const soulBadge = $('#soul-status');
    const skillBadge = $('#skill-status');
    const headerSoul = $('#header-soul-name');

    if (soulBadge) {
      soulBadge.textContent = currentSoulName
        ? `SOUL: ${currentSoulName}`
        : tl('statusNoSoul');
      soulBadge.className = `status-badge ${currentSoulName ? 'active' : ''}`;
    }
    if (skillBadge) {
      skillBadge.textContent = `${loadedSkillCount} Skill${loadedSkillCount !== 1 ? 's' : ''}`;
      skillBadge.className = `status-badge ${loadedSkillCount > 0 ? 'active clickable' : ''}`;
      skillBadge.title = loadedSkillCount > 0
        ? loadedSkills.map(s => s.meta.name).join(', ')
        : '';
      // Wire click to show skills popover (idempotent)
      skillBadge.onclick = loadedSkillCount > 0 ? toggleSkillsPopover : null;
    }
    if (headerSoul) {
      headerSoul.textContent = currentSoulName || tl('landingTitle');
    }
  }

  function toggleSkillsPopover() {
    let popover = $('#skills-popover');
    if (popover) { popover.remove(); return; }

    popover = document.createElement('div');
    popover.id = 'skills-popover';
    popover.className = 'skills-popover';
    popover.innerHTML = `
      <div class="skills-popover-header">
        <span>🧩 Loaded Skills</span>
        <button class="skills-popover-close" onclick="document.getElementById('skills-popover')?.remove()">✕</button>
      </div>
      ${
        loadedSkills.map(s => `
          <div class="skill-card">
            <div class="skill-card-name">${escapeHtml(s.meta.name || 'Unnamed')}</div>
            ${s.meta.description ? `<div class="skill-card-desc">${escapeHtml(s.meta.description)}</div>` : ''}
          </div>
        `).join('')
      }
    `;

    const badge = $('#skill-status');
    const parent = badge?.closest('.welcome-status') || badge?.parentElement || $('#chat-box');
    parent?.appendChild(popover);

    // Close on outside click
    setTimeout(() => {
      document.addEventListener('click', function handler(e) {
        if (!popover.contains(e.target) && e.target !== badge) {
          popover.remove();
          document.removeEventListener('click', handler);
        }
      });
    }, 10);
  }

  // ─── Slash Commands ────────────────────────────────────────────────

  function getSlashCommands() {
    return [
      { cmd: '/schedule',       desc: tl('slashScheduleDesc') },
      { cmd: '/github',         desc: tl('slashGithubDesc') },
      { cmd: '/loop',           desc: tl('slashLoopDesc') },
      { cmd: '/skills',         desc: tl('slashSkillsDesc') },
      { cmd: '/soul',           desc: tl('slashSoulDesc') },
      { cmd: '/compact',        desc: tl('slashCompactDesc') },
      { cmd: '/clear',          desc: tl('slashClearDesc') },
    ];
  }

  function showSlashCommandMenu(baseCmd, title, options) {
    addMessageBubble('user', baseCmd);
    const bubble = addMessageBubble('model', '');
    const rows = options.map((opt, idx) => `
      <button class="command-menu-btn" data-idx="${idx}">
        <div class="command-menu-line1">
          <span class="command-menu-cmd">${escapeHtml(opt.cmd)}</span>
          <span class="command-menu-label">${escapeHtml(opt.label)}</span>
        </div>
        ${opt.desc ? `<div class="command-menu-desc">${escapeHtml(opt.desc)}</div>` : ''}
      </button>
    `).join('');

    bubble.innerHTML = `
      <div class="command-menu-card">
        <div class="command-menu-title">${escapeHtml(title)}</div>
        <div class="command-menu-subtitle">${escapeHtml(tl('commandMenuSubtitle'))}</div>
        <div class="command-menu-list">${rows}</div>
      </div>
    `;

    bubble.querySelectorAll('.command-menu-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        const option = options[idx];
        const input = $('#message-input');
        if (!input || !option) return;
        input.value = option.cmd;
        input.focus();
        autoResizeInput();
        if (option.prefillOnly) {
          input.setSelectionRange(input.value.length, input.value.length);
          return;
        }
        $('#send-btn')?.click();
      });
    });

    scrollToBottom();
  }

  let _slashSelectedIdx = -1;

  function slashAutocompleteShow(items) {
    const el = $('#slash-autocomplete');
    if (!el) return;
    el.innerHTML = items.map((item, i) =>
      `<div class="slash-cmd-item${i === _slashSelectedIdx ? ' active' : ''}" data-idx="${i}">
        <span class="slash-cmd-name">${item.cmd}</span>
        <span class="slash-cmd-desc">${item.desc}</span>
      </div>`
    ).join('');
    el.querySelectorAll('.slash-cmd-item').forEach(row => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault(); // don't blur textarea
        const idx = parseInt(row.dataset.idx);
        _slashSelectedIdx = idx;
        slashAutocompleteConfirm();
      });
    });
    el.classList.remove('hidden');
  }

  function slashAutocompleteHide() {
    const el = $('#slash-autocomplete');
    if (el) el.classList.add('hidden');
    _slashSelectedIdx = -1;
  }

  function slashAutocompleteActiveIndex() { return _slashSelectedIdx; }

  function slashAutocompleteMoveSelection(delta) {
    const el = $('#slash-autocomplete');
    if (!el) return;
    const items = el.querySelectorAll('.slash-cmd-item');
    if (!items.length) return;
    _slashSelectedIdx = (_slashSelectedIdx + delta + items.length) % items.length;
    items.forEach((row, i) => row.classList.toggle('active', i === _slashSelectedIdx));
    items[_slashSelectedIdx]?.scrollIntoView({ block: 'nearest' });
  }

  function slashAutocompleteConfirm() {
    const el = $('#slash-autocomplete');
    if (!el) return;
    const items = el.querySelectorAll('.slash-cmd-item');
    const idx = _slashSelectedIdx >= 0 ? _slashSelectedIdx : 0;
    const target = items[idx];
    if (!target) return;
    const cmdText = target.querySelector('.slash-cmd-name').textContent;
    const input = $('#message-input');
    input.value = cmdText;
    input.focus();
    // Place cursor at end
    input.setSelectionRange(cmdText.length, cmdText.length);
    slashAutocompleteHide();
    autoResizeInput();
  }

  function slashAutocompleteUpdate() {
    const input = $('#message-input');
    const val = input?.value || '';
    if (!val.startsWith('/')) { slashAutocompleteHide(); return; }
    const q = val.toLowerCase();
    const matches = getSlashCommands().filter(c => c.cmd.startsWith(q));
    if (!matches.length || (matches.length === 1 && matches[0].cmd === q)) {
      slashAutocompleteHide(); return;
    }
    _slashSelectedIdx = -1;
    slashAutocompleteShow(matches);
  }

  async function handleSlashCommand(text) {
    const cmd = text.trim().toLowerCase();

    if (cmd === '/loop') {
      showSlashCommandMenu('/loop', tl('loopMenuTitle'), [
        { cmd: '/loop deploy', label: tl('loopMenuDeployLabel'), desc: tl('slashLoopDesc') },
        { cmd: '/loop status', label: tl('loopMenuStatusLabel'), desc: tl('slashLoopStatusDesc') },
        { cmd: '/loop connect', label: tl('loopMenuConnectLabel'), desc: tl('slashLoopConnectDesc') },
        { cmd: '/loop disconnect', label: tl('loopMenuDisconnectLabel'), desc: tl('slashLoopDisconnectDesc') },
        { cmd: '/loop channel', label: tl('loopMenuChannelLabel'), desc: tl('slashLoopChannelDesc') },
        { cmd: '/loop dashboard', label: tl('loopMenuDashboardLabel'), desc: tl('slashLoopDashboardDesc') },
        { cmd: '/loop memory clear', label: tl('loopMenuMemoryClearLabel'), desc: tl('slashLoopMemoryClearDesc') },
      ]);
      return true;
    }

    if (cmd === '/github') {
      showSlashCommandMenu('/github', tl('githubMenuTitle'), [
        { cmd: '/github status', label: tl('githubMenuStatusLabel'), desc: tl('slashGithubStatusDesc') },
        { cmd: '/github run', label: tl('githubMenuRunLabel'), desc: tl('slashGithubRunDesc') },
        { cmd: '/github delete', label: tl('githubMenuDeleteLabel'), desc: tl('slashGithubDeleteDesc') },
      ]);
      return true;
    }

    if (cmd === '/clear') {
      if (!currentSessionId) { showToast(tl('toastNoActiveSession'), 'info'); return true; }
      if (!confirm(tl('confirmClearSession'))) return true;

      const clearSessionId = currentSessionId;
      const entry = Storage.getIndex().find(s => s.id === clearSessionId);

      // Read config BEFORE resetting currentSessionId
      const clearCfg = getSessionConfig(clearSessionId);
      const clearGet = (key, fb) => cfgGet(clearCfg, key, getSetting(key, fb));
      const clearBackend = entry?.backend || clearGet('storageBackend', 'local');

      // Reset to no-session state immediately
      Chat.clearHistory();
      Chat.resetTokenUsage();
      removeSessionConfig(clearSessionId);
      currentSessionId = null;
      setInputEnabled(false);
      hide('#token-display');
      showLanding();
      updateSidebarActive(null);

      // Delete from storage in the background
      if (entry) {
        const backend = clearBackend;
        (async () => {
          try {
            if (backend === 'github') {
              await Storage.GitHub.remove(clearSessionId, {
                token: clearGet('githubToken', ''),
                owner: clearGet('githubOwner', ''),
                repo: clearGet('githubRepo', ''),
                path: clearGet('githubPath', 'sessions'),
              });
            } else if (backend === 'notion') {
              await Storage.Notion.remove(clearSessionId, {
                token: clearGet('notionStorageToken', ''),
                parentPageId: clearGet('notionParentPageId', ''),
                corsProxy: clearGet('corsProxy', ''),
              });
            } else {
              await Storage.Local.remove(clearSessionId);
            }
            renderSidebar();
            showToast(tl('toastSessionCleared'), 'success');
          } catch (err) {
            renderSidebar();
            showToast(`清空存储失败: ${err.message}`, 'error');
          }
        })();
      } else {
        renderSidebar();
        showToast(tl('toastSessionCleared'), 'success');
      }
      return true;
    }

    if (cmd === '/compact') {
      const apiKey = getSessionSetting('apiKey');
      const model = getSessionSetting('model');
      if (!apiKey) {
        showToast(tl('toastSetApiKeyFirst'), 'error');
        return true;
      }
      if (!model) {
        showToast(tl('toastSetModelInSettings'), 'error');
        return true;
      }
      addMessageBubble('user', '/compact');
      try {
        const summary = await Chat.compactHistory(apiKey, model);
        addMessageBubble(
          'model',
          '**Context compacted.** Summary:\n\n' + summary
        );
        showToast(tl('toastHistoryCompacted'), 'success');
      } catch (err) {
        showToast(`Compact failed: ${err.message}`, 'error');
      }
      return true;
    }

    // Handle /soul list — show built-in SOULs for quick selection
    if (cmd === '/soul list') {
      addMessageBubble('user', '/soul list');
      const bubble = addMessageBubble('model', `⏳ ${tl('msgLoadingBuiltinSouls')}`);
      (async () => {
        const souls = await getBuiltinSouls();
        if (!souls.length) {
          bubble.innerHTML = renderMarkdown(`_${tl('msgNoBuiltinSouls')}_`);
          return;
        }
        const rows = souls.map(s => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="font-size:20px;">${s.icon || '🧠'}</span>
            <div style="flex:1;font-size:12px;">
              <span style="font-weight:600;">${escapeHtml(s.name)}</span>
              <div style="opacity:.6;">${escapeHtml(s.description || '')}</div>
            </div>
            <button class="gh-soul-select-btn" data-file="${escapeHtml(s.file)}"
              style="background:var(--accent);color:#fff;border:none;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;">
              ${tl('btnUse')}
            </button>
          </div>
        `).join('');
        bubble.innerHTML = `
          <div style="font-weight:600;margin-bottom:10px;font-size:14px;">🧠 ${tl('msgBuiltinSoulsTitle')}</div>
          <div style="font-size:12px;opacity:.7;margin-bottom:8px;">${tl('msgClickUseSoul')}</div>
          ${rows}
        `;
        bubble.querySelectorAll('.gh-soul-select-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const file = btn.dataset.file;
            const url = builtinSoulUrl(file);
            btn.disabled = true;
            btn.textContent = tl('btnLoading');
            try {
              const cfg = getSessionConfig(currentSessionId);
              cfg.soulUrl = url;
              saveSessionConfig(currentSessionId, cfg);
              await loadSoulAndSkills();
              showToast(`${tl('msgSwitchedTo')}: ${currentSoulName}`, 'success');
              btn.textContent = `✓ ${tl('btnActive')}`;
              // Reset other buttons
              bubble.querySelectorAll('.gh-soul-select-btn').forEach(b => {
                if (b !== btn) { b.disabled = false; b.textContent = tl('btnUse'); }
              });
            } catch (err) {
              btn.disabled = false;
              btn.textContent = tl('btnUse');
              showToast(`${tl('msgFailed')}: ${err.message}`, 'error');
            }
          });
        });
      })();
      return true;
    }

    // Handle /soul <name-or-url> to switch SOUL
    if (text.trim().toLowerCase().startsWith('/soul ')) {
      const soulInput = text.trim().slice(6).trim();
      addMessageBubble('user', text.trim());

      // Check if the input matches a built-in SOUL by name (case-insensitive)
      const matchBuiltin = async () => {
        const souls = await getBuiltinSouls();
        return souls.find(s => s.name.toLowerCase() === soulInput.toLowerCase());
      };
      
      (async () => {
        const builtin = await matchBuiltin();
        const soulUrl = builtin ? builtinSoulUrl(builtin.file) : soulInput;

        if (!builtin && !soulInput.startsWith('http://') && !soulInput.startsWith('https://')) {
          const souls = await getBuiltinSouls();
          const names = souls.map(s => `- ${s.icon} ${s.name}`).join('\n');
          addMessageBubble('model', `❌ ${tl('msgInvalidSoulNameOrUrl')}\n\n**${tl('msgAvailableBuiltinSouls')}:**\n${names}\n\n${tl('msgOrProvideUrl')}: \`/soul https://…\``);
          return;
        }

        const displayName = builtin ? builtin.name : soulInput.split('/').pop() || 'SOUL';
        const bubble = addMessageBubble('model', `⏳ ${tl('msgLoadingSoul')}: **${displayName}**…`);
        try {
          const cfg = getSessionConfig(currentSessionId);
          cfg.soulUrl = soulUrl;
          saveSessionConfig(currentSessionId, cfg);
          await loadSoulAndSkills();
          bubble.innerHTML = renderMarkdown(`✅ ${tl('msgSwitchedSoul')}: **${currentSoulName}** (${loadedSkillCount} ${tl('msgSkillsLoaded')})`);
        } catch (err) {
          addMessageBubble('model', `❌ ${tl('msgFailedLoadSoul')}: ${err.message}`);
        }
      })();
      
      return true;
    }

    if (cmd === '/soul') {
      showSlashCommandMenu('/soul', tl('soulMenuTitle'), [
        { cmd: '/soul info', label: tl('soulMenuInfoLabel'), desc: tl('slashSoulDesc') },
        { cmd: '/soul list', label: tl('soulMenuListLabel'), desc: tl('slashSoulListDesc') },
        { cmd: '/soul ', label: tl('soulMenuSetLabel'), desc: tl('soulMenuSetDesc'), prefillOnly: true },
      ]);
      return true;
    }

    if (cmd === '/soul info') {
      const soulUrl = getSessionSetting('soulUrl');
      addMessageBubble('user', '/soul info');
      addMessageBubble(
        'model',
        `**${tl('msgCurrentSoul')}:** ${currentSoulName || tl('msgNone')}\n**URL:** ${soulUrl || tl('msgNotSet')}\n**${tl('msgSkillsLoaded')}:** ${loadedSkillCount}\n\n_${tl('msgSoulListTip')}_`
      );
      return true;
    }

    // Handle /skill <name-or-url> to load a skill
    if (text.trim().toLowerCase().startsWith('/skill ')) {
      const skillInput = text.trim().slice(7).trim();
      addMessageBubble('user', text.trim());

      (async () => {
        // Try to match a built-in skill by name (case-insensitive)
        const skills = await getBuiltinSkills();
        const builtin = skills.find(s => s.name.toLowerCase() === skillInput.toLowerCase());
        const skillUrl = builtin ? builtinSkillUrl(builtin.file) : skillInput;

        if (!builtin && !skillInput.startsWith('http://') && !skillInput.startsWith('https://')) {
          const names = skills.map(s => `- ${s.icon} ${s.name}`).join('\n');
          addMessageBubble('model', `❌ ${tl('msgInvalidSkillNameOrUrl')}\n\n**${tl('msgAvailableBuiltinSkills')}:**\n${names}\n\n${tl('msgOrProvideUrl')}: \`/skill https://…\``);
          return;
        }

        const displayName = builtin ? builtin.name : skillInput.split('/').pop() || 'SKILL';
        try {
          const bubble = addMessageBubble('model', `⏳ ${tl('msgLoadingSkill')}: **${displayName}**…`);
          const parsed = await loadSkillFromUrl(skillUrl);
          bubble.innerHTML = renderMarkdown(`✅ ${tl('msgLoadedSkill')}: **${parsed.meta?.name || displayName}**\n\n${parsed.meta?.description || ''}`);
        } catch (err) {
          addMessageBubble('model', `❌ ${tl('msgFailedLoadSkill')}: ${err.message}`);
        }
      })();
      
      return true;
    }

    if (cmd === '/skills') {
      addMessageBubble('user', '/skills');
      const bubble = addMessageBubble('model', `⏳ ${tl('msgLoadingSkillLibrary')}…`);

      // Fetch built-in catalog in the background
      const builtinSkillsCatalog = await getBuiltinSkills();

      const renderSkillPanel = () => {
        // ── Loaded skills section ──
        const loadedRows = loadedSkills.length
          ? loadedSkills.map(s => `
            <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
              <div style="flex:1;font-size:12px;">
                <span style="font-weight:600;">${escapeHtml(s.meta?.name || 'Unnamed')}</span>
                <div style="opacity:.6;word-break:break-all;">${escapeHtml(s.url)}</div>
              </div>
              <button class="gh-skill-unload-btn" data-url="${escapeHtml(s.url)}"
                style="background:#555;color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;">
                ${tl('btnUnload')}
              </button>
            </div>
          `).join('')
          : `<div style="padding:8px 0;font-size:12px;opacity:.7;">${tl('msgNoSkillsLoadedYet')}</div>`;

        // ── Built-in skills section ──
        const builtinRows = builtinSkillsCatalog.length
          ? builtinSkillsCatalog.map(s => {
              const url = builtinSkillUrl(s.file);
              const isLoaded = loadedSkills.some(ls => ls.url === url);
              return `
                <div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);">
                  <span style="font-size:18px;">${s.icon || '🧩'}</span>
                  <div style="flex:1;font-size:12px;">
                    <span style="font-weight:600;">${escapeHtml(s.name)}</span>
                    <div style="opacity:.6;">${escapeHtml(s.description || '')}</div>
                  </div>
                  <button class="gh-skill-builtin-btn" data-file="${escapeHtml(s.file)}"
                    style="background:${isLoaded ? '#555' : 'var(--accent)'};color:#fff;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;"
                    ${isLoaded ? 'disabled' : ''}>
                    ${isLoaded ? '✓ Loaded' : 'Add'}
                  </button>
                </div>
              `;
            }).join('')
          : '';

        return `
          <div style="font-weight:600;margin-bottom:10px;font-size:14px;">🧩 ${tl('msgSkillManager')}</div>

          <div style="font-size:13px;font-weight:600;margin:12px 0 6px;opacity:.85;">${tl('msgActiveSkills')}</div>
          ${loadedRows}

          <div style="margin-top:12px;display:flex;gap:6px;align-items:center;">
            <input id="skill-add-url" type="url" placeholder="${tl('msgAddSkillUrl')}"
              style="flex:1;padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--bg-input,#1e1e1e);color:inherit;font-size:12px;" />
            <button id="skill-add-btn"
              style="background:var(--accent);color:#fff;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-size:12px;white-space:nowrap;">
              ${tl('btnAdd')}
            </button>
          </div>

          ${builtinRows ? `
            <div style="font-size:13px;font-weight:600;margin:16px 0 6px;opacity:.85;">📚 ${tl('msgBuiltinLibrary')}</div>
            <div style="font-size:12px;opacity:.6;margin-bottom:6px;">${tl('msgOneClickLoadSkill')}</div>
            ${builtinRows}
          ` : ''}
        `;
      };

      bubble.innerHTML = renderSkillPanel();

      const wireButtons = () => {
        // Unload buttons
        bubble.querySelectorAll('.gh-skill-unload-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            unloadSkill(btn.dataset.url);
            bubble.innerHTML = renderSkillPanel();
            wireButtons();
            showToast(tl('toastSkillUnloaded'), 'info');
          });
        });

        // Built-in skill add buttons
        bubble.querySelectorAll('.gh-skill-builtin-btn').forEach(btn => {
          if (btn.disabled) return;
          btn.addEventListener('click', async () => {
            const file = btn.dataset.file;
            const url = builtinSkillUrl(file);
            btn.disabled = true;
            btn.textContent = tl('btnLoading');
            try {
              await loadSkillFromUrl(url);
              bubble.innerHTML = renderSkillPanel();
              wireButtons();
              const entry = builtinSkillsCatalog.find(s => s.file === file);
              showToast(`"${entry?.name || file}" loaded`, 'success');
            } catch (e) {
              btn.disabled = false;
              btn.textContent = tl('btnAdd');
              showToast(`Load failed: ${e.message}`, 'error');
            }
          });
        });

        // Custom URL add
        const addBtn = bubble.querySelector('#skill-add-btn');
        const addInput = bubble.querySelector('#skill-add-url');
        if (addBtn && addInput) {
          addBtn.addEventListener('click', async () => {
            const url = addInput.value.trim();
            if (!url) return;
            addBtn.disabled = true;
            addBtn.textContent = tl('btnLoading');
            try {
              const parsed = await loadSkillFromUrl(url);
              bubble.innerHTML = renderSkillPanel();
              wireButtons();
              showToast(`"${parsed.meta.name}" loaded`, 'success');
            } catch (e) {
              addBtn.disabled = false;
              addBtn.textContent = tl('btnAdd');
              showToast(`Load failed: ${e.message}`, 'error');
            }
          });
          addInput.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
        }
      };
      wireButtons();
      return true;
    }

    // ─── /schedule — Create a cron scheduled task from conversation code ─────
    if (cmd === '/schedule' || cmd.startsWith('/schedule ')) {
      addMessageBubble('user', text.trim());

      let config;
      try {
        config = getActionConfig();
      } catch (e) {
        addMessageBubble('model', `⚠️ ${e.message}`);
        return true;
      }

      // Extract code artifacts from conversation history (search recent model messages)
      const history = Chat.getHistory();
      let foundArtifacts = [];
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role !== 'model') continue;
        const modelText = history[i].parts?.map(p => p.text).join('') || '';
        const arts = GitHubActions.extractArtifacts(modelText);
        if (arts.length > 0) {
          // Filter out workflow YAML — we only want runnable scripts
          foundArtifacts = arts.filter(a => !a.filename.startsWith('.github/'));
          if (foundArtifacts.length > 0) break;
        }
      }

      if (foundArtifacts.length === 0) {
        addMessageBubble('model', `⚠️ ${tl('msgNoCodeFoundForSchedule')}`);
        return true;
      }

      // Build the scheduling UI
      const bubble = addMessageBubble('model', '');
      const CRON_PRESETS = [
        { label: 'Every hour',       cron: '0 * * * *' },
        { label: 'Every 6 hours',    cron: '0 */6 * * *' },
        { label: 'Daily 9:00 UTC',   cron: '0 9 * * *' },
        { label: 'Daily 0:00 UTC',   cron: '0 0 * * *' },
        { label: 'Mon–Fri 9:00 UTC', cron: '0 9 * * 1-5' },
        { label: 'Weekly (Mon 9:00)',cron: '0 9 * * 1' },
        { label: 'Monthly (1st 9:00)',cron: '0 9 1 * *' },
        { label: 'Custom',           cron: '' },
      ];

      // Auto-generate a slug from the first artifact filename
      const defaultScript = foundArtifacts[0];
      const defaultSlug = defaultScript.filename.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();

      const pushooConfig = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
      const hasPushoo = PushooNotifier.hasChannels(pushooConfig);
      const channelSummary = hasPushoo ? PushooNotifier.getChannelSummary(pushooConfig, currentLang) : '';

      const artifactOptions = foundArtifacts.map((a, i) =>
        `<option value="${i}" ${i === 0 ? 'selected' : ''}>${escapeHtml(a.filename)} (${a.language})</option>`
      ).join('');

      const presetOptions = CRON_PRESETS.map((p, i) =>
        `<option value="${i}" ${i === 2 ? 'selected' : ''}>${escapeHtml(p.label)}${p.cron ? ' — ' + p.cron : ''}</option>`
      ).join('');

      bubble.innerHTML = `
        <div class="schedule-wizard">
          <div class="schedule-wizard-title">⏰ ${tl('msgCreateScheduledTask')}</div>

          <label class="schedule-field-label">${tl('msgScript')}</label>
          <select id="schedule-script" class="schedule-input">
            ${artifactOptions}
          </select>

          <label class="schedule-field-label">${tl('msgTaskName')}</label>
          <input id="schedule-name" class="schedule-input" type="text" value="${escapeHtml(defaultSlug)}" placeholder="my-task">

          <label class="schedule-field-label">${tl('msgSchedule')}</label>
          <select id="schedule-preset" class="schedule-input">
            ${presetOptions}
          </select>
          <input id="schedule-cron-custom" class="schedule-input hidden" type="text" placeholder="e.g. */30 * * * *" style="margin-top:4px;">

          <label class="schedule-field-label">${tl('notifyTitle')}</label>
          <div class="schedule-notify-row">
            <div class="schedule-checkbox-label" style="opacity:${hasPushoo ? 1 : 0.5}">
              📢 ${hasPushoo
                ? '<span class="schedule-hint" style="color:#22863a">✅ ' + tl('msgAutoNotifyVia') + ' ' + escapeHtml(channelSummary) + '</span>'
                : `<span class="schedule-hint">(${tl('msgConfigurePushooInSettings')})</span>`}
            </div>
          </div>

          <div class="schedule-preview" id="schedule-preview">
            <div class="schedule-preview-title">${tl('msgPreview')}</div>
            <div class="schedule-preview-body" id="schedule-preview-body"></div>
          </div>

          <div class="schedule-actions">
            <button id="schedule-cancel-btn" class="schedule-btn schedule-btn-secondary">${tl('cancel')}</button>
            <button id="schedule-deploy-btn" class="schedule-btn schedule-btn-primary">🚀 Deploy Schedule</button>
          </div>
        </div>
      `;

      const presetSelect = bubble.querySelector('#schedule-preset');
      const cronCustom = bubble.querySelector('#schedule-cron-custom');
      const nameInput = bubble.querySelector('#schedule-name');
      const previewBody = bubble.querySelector('#schedule-preview-body');

      function updatePreview() {
        const presetIdx = parseInt(presetSelect.value);
        const preset = CRON_PRESETS[presetIdx];
        const cronVal = preset.cron || cronCustom.value.trim();
        const scriptIdx = parseInt(bubble.querySelector('#schedule-script').value);
        const script = foundArtifacts[scriptIdx];
        const slug = nameInput.value.trim().replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'task';
        const wfFile = `scheduler-${slug}.yml`;

        previewBody.innerHTML = `
          <div>📄 <code>${escapeHtml(config.artifactDir)}/${escapeHtml(script.filename)}</code></div>
          <div>⚙️ <code>.github/workflows/${escapeHtml(wfFile)}</code></div>
          <div>🕐 <code>${escapeHtml(cronVal || '(enter cron)')}</code> — ${escapeHtml(preset.label || 'Custom')}</div>
        `;
      }

      // Toggle custom cron input
      presetSelect.addEventListener('change', () => {
        const idx = parseInt(presetSelect.value);
        const isCustom = CRON_PRESETS[idx].cron === '';
        cronCustom.classList.toggle('hidden', !isCustom);
        updatePreview();
      });
      cronCustom.addEventListener('input', updatePreview);
      nameInput.addEventListener('input', updatePreview);
      bubble.querySelector('#schedule-script').addEventListener('change', updatePreview);

      updatePreview();
      scrollToBottom();

      // Cancel
      bubble.querySelector('#schedule-cancel-btn').addEventListener('click', () => {
        bubble.innerHTML = renderMarkdown(`_${tl('msgScheduleCreationCancelled')}_`);
      });

      // Deploy
      bubble.querySelector('#schedule-deploy-btn').addEventListener('click', async () => {
        const deployBtn = bubble.querySelector('#schedule-deploy-btn');
        deployBtn.disabled = true;
        deployBtn.textContent = `⏳ ${tl('btnDeploying')}`;

        const presetIdx = parseInt(presetSelect.value);
        const preset = CRON_PRESETS[presetIdx];
        const cronVal = preset.cron || cronCustom.value.trim();
        const scheduleLabel = preset.cron ? preset.label : `Custom: ${cronVal}`;

        if (!cronVal) {
          showToast(tl('toastCronRequired'), 'error');
          deployBtn.disabled = false;
          deployBtn.textContent = `🚀 ${tl('btnDeploySchedule')}`;
          return;
        }

        // Basic cron validation: 5 fields separated by spaces
        if (cronVal.split(/\s+/).length !== 5) {
          showToast(tl('toastCronInvalid'), 'error');
          deployBtn.disabled = false;
          deployBtn.textContent = `🚀 ${tl('btnDeploySchedule')}`;
          return;
        }

        const scriptIdx = parseInt(bubble.querySelector('#schedule-script').value);
        const script = foundArtifacts[scriptIdx];
        const slug = nameInput.value.trim().replace(/[^a-z0-9-]/gi, '-').toLowerCase() || 'task';

        const wfFileName = `scheduler-${slug}.yml`;
        const wfPath = `.github/workflows/${wfFileName}`;

        try {
          // Generate workflow YAML programmatically
          const workflowYaml = GitHubActions.generateScheduleWorkflow({
            name: slug,
            slug,
            cron: cronVal,
            scheduleText: scheduleLabel,
            scriptFilename: script.filename,
            language: script.language,
            artifactDir: config.artifactDir,
          });

          // Prepare files for atomic push
          const files = [
            { path: `${config.artifactDir}/${script.filename}`, content: script.code },
            { path: wfPath, content: workflowYaml },
          ];

          // Replace wizard UI with status card
          bubble.innerHTML = '';
          const statusCard = createStatusCard(bubble);
          updateStatusCard(statusCard, 'in_progress', `Pushing ${files.length} files…`);

          await GitHubActions.pushFiles(config, files, `Schedule "${slug}" from 小虾米`);

          // Sync secrets
          updateStatusCard(statusCard, 'in_progress', 'Syncing secrets & variables…');
          const settings = {
            geminiApiKey: getSessionSetting('apiKey'),
            qwenApiKey: getSessionSetting('qwenApiKey'),
          };

          // Sync all notification channels as PUSHOO_CHANNELS JSON
          const pc = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
          if (pc.channels.length > 0) {
            settings.PUSHOO_CHANNELS = JSON.stringify(pc.channels);
          }

          const result = await GitHubActions.syncSecretsAndVars(config, settings);

          const repoUrl = `https://github.com/${config.owner}/${config.repo}`;
          updateStatusCard(statusCard, 'success',
            `Scheduled "${slug}" — ${scheduleLabel}`,
            `${repoUrl}/actions`
          );

          // Add "Run Now" button
          const buttonRow = document.createElement('div');
          buttonRow.style.cssText = 'margin-top:12px; display:flex; gap:8px;';
          const runBtn = document.createElement('button');
          runBtn.textContent = `▶️ ${tl('btnRunNow')}`;
          runBtn.className = 'btn-primary';
          runBtn.style.cssText = 'flex:1; padding:8px 12px; font-size:13px;';
          runBtn.addEventListener('click', async () => {
            runBtn.disabled = true;
            const origText = runBtn.textContent;
            runBtn.textContent = `⏳ ${tl('btnDispatching')}`;
            try {
              await GitHubActions.dispatchWorkflow(config, `scheduler-${slug}.yml`);
              runBtn.textContent = `✅ ${tl('btnDispatched')}`;
              showToast(`Workflow "${slug}" dispatched`, 'success');
              setTimeout(() => { runBtn.textContent = origText; runBtn.disabled = false; }, 2000);
            } catch (err) {
              runBtn.textContent = `❌ ${tl('btnFailed')}`;
              showToast(`Dispatch failed: ${err.message}`, 'error');
              setTimeout(() => { runBtn.textContent = origText; runBtn.disabled = false; }, 3000);
            }
          });
          buttonRow.appendChild(runBtn);
          bubble.appendChild(buttonRow);

          // Show sync summary
          const parts = [];
          if (result.synced.length > 0) parts.push(`✅ ${result.synced.join(', ')}`);
          if (result.skipped.length > 0) parts.push(`⏭ skipped: ${result.skipped.join(', ')}`);
          if (result.errors.length > 0) parts.push(`❌ ${result.errors.join('; ')}`);

          if (parts.length > 0) {
            const secretsHint = document.createElement('div');
            secretsHint.className = 'deploy-bundle-secrets-hint';
            secretsHint.innerHTML = `<span class="deploy-bundle-secrets-icon">🔑</span><span>${parts.join(' · ')}</span>`;
            bubble.appendChild(secretsHint);
          }

          showToast(`Scheduled task "${slug}" deployed`, 'success');
        } catch (err) {
          bubble.innerHTML = '';
          const statusCard = createStatusCard(bubble);
          updateStatusCard(statusCard, 'failure', `Deploy failed: ${err.message}`);
          showToast(`Schedule deploy failed: ${err.message}`, 'error');
        }
      });

      return true;
    }

    if (cmd === '/github status') {
      addMessageBubble('user', text.trim());
      let config;
      try {
        config = getActionConfig();
      } catch (e) {
        addMessageBubble('model', `⚠️ ${e.message}`);
        return true;
      }

      const loadingBubble = addMessageBubble('model', `_${tl('msgFetchingGithubStatus')}…_`);

      try {
        const [workflows, activeRuns, recentRuns] = await Promise.all([
          GitHubActions.listWorkflows(config),
          GitHubActions.listRecentRuns(config, 'in_progress', 20),
          GitHubActions.listRecentRuns(config, null, 15),
        ]);

        // Build status output
        const lines = [];
        lines.push(`## 📦 \`${config.owner}/${config.repo}\``);
        lines.push('');

        // Active runs
        const queued = await GitHubActions.listRecentRuns(config, 'queued', 10);
        const running = [...activeRuns, ...queued];
        if (running.length > 0) {
          lines.push('### ⚡ Active Runs');
          for (const run of running) {
            const trigger = run.event === 'schedule' ? '🕐 cron' : run.event === 'workflow_dispatch' ? '▶️ manual' : run.event;
            const elapsed = Math.round((Date.now() - new Date(run.run_started_at).getTime()) / 1000);
            lines.push(`- **${run.name}** — ${run.status} · ${trigger} · ${elapsed}s ago · [View](${run.html_url})`);
          }
          lines.push('');
        }

        // Workflows list
        if (workflows.length > 0) {
          lines.push('### 📋 Workflows');
          for (const wf of workflows) {
            const stateIcon = wf.state === 'active' ? '✅' : '⏸️';
            // Find most recent run for this workflow
            const lastRun = recentRuns.find(r => r.workflow_id === wf.id);
            let lastStatus = '';
            if (lastRun) {
              const icon = lastRun.conclusion === 'success' ? '✅' : lastRun.conclusion === 'failure' ? '❌' : lastRun.status === 'in_progress' ? '⏳' : '⚪';
              const age = Math.round((Date.now() - new Date(lastRun.created_at).getTime()) / 60000);
              lastStatus = ` · last: ${icon} ${age}m ago`;
            }
            lines.push(`- ${stateIcon} **${wf.name}** \`${wf.path.replace('.github/workflows/', '')}\`${lastStatus}`);
          }
        } else {
          lines.push('_No workflows found in this repo._');
        }

        lines.push('');
        lines.push(`_[Open Actions →](https://github.com/${config.owner}/${config.repo}/actions)_`);

        // Replace loading bubble
        if (loadingBubble) {
          loadingBubble.innerHTML = renderMarkdown(lines.join('\n'));
          loadingBubble.querySelectorAll('pre code').forEach(b => hljs.highlightElement(b));
          scrollToBottom();
        }
      } catch (err) {
        if (loadingBubble) {
          loadingBubble.innerHTML = renderMarkdown(`❌ Failed to fetch GitHub status: ${err.message}`);
        }
      }
      return true;
    }

    if (cmd.startsWith('/github run')) {
      addMessageBubble('user', text.trim());
      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const argPart = text.trim().slice('/github run'.length).trim();

      if (argPart) {
        // Direct dispatch: /github run some-workflow.yml
        const workflowFile = argPart.includes('/') ? argPart.split('/').pop() : argPart;
        const bubble = addMessageBubble('model', `_Dispatching \`${workflowFile}\`…_`);
        try {
          await GitHubActions.dispatchWorkflow(config, workflowFile, {});
          bubble.innerHTML = renderMarkdown(`✅ \`${workflowFile}\` 已触发，稍后可用 \`/github status\` 查看运行状态。`);
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
        }
        return true;
      }

      // No arg: list workflows with ▶️ run buttons
      const runBubble = addMessageBubble('model', `_${tl('msgLoadingWorkflows')}…_`);
      try {
        const workflows = await GitHubActions.listWorkflows(config);
        if (!workflows.length) {
          runBubble.innerHTML = renderMarkdown(`_${tl('msgNoWorkflowsFound')}_`);
          return true;
        }
        const header = `<div style="font-weight:600;margin-bottom:8px;">▶️ ${tl('msgPickWorkflowToRun')}</div>`;
        const rows = workflows.map(wf => {
          const file = wf.path.replace('.github/workflows/', '');
          const stateIcon = wf.state === 'active' ? '✅' : '⏸️';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="flex:1;font-size:13px;">${stateIcon} <strong>${escapeHtml(wf.name)}</strong> <code style="font-size:11px;opacity:.7;">${escapeHtml(file)}</code></span>
            <button class="gh-run-wf-btn" data-file="${escapeHtml(file)}" data-name="${escapeHtml(wf.name)}"
              style="background:var(--accent);color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">
              执行
            </button>
          </div>`;
        }).join('');
        runBubble.innerHTML = header + rows;

        runBubble.querySelectorAll('.gh-run-wf-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const file = btn.dataset.file;
            const name = btn.dataset.name;
            btn.disabled = true;
            btn.textContent = tl('btnDispatching');
            try {
              await GitHubActions.dispatchWorkflow(config, file, {});
              btn.textContent = `✅ ${tl('btnDispatched')}`;
              btn.style.background = '#27ae60';
              showToast(`"${name}" ${tl('msgDispatched')}`, 'success');
            } catch (e) {
              btn.disabled = false;
              btn.textContent = tl('btnRun');
              showToast(`${tl('msgDispatchFailed')}: ${e.message}`, 'error');
            }
          });
        });
      } catch (e) {
        runBubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
      }
      return true;
    }

    if (cmd.startsWith('/github delete')) {
      addMessageBubble('user', text.trim());
      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      // Helper: extract loop key from workflow filename for cleanup tracking
      const tryCleanUpstash = async (wfPath) => {
        return ''; // Upstash cleanup no longer needed — communication now via messaging channels
      };

      const argPart = text.trim().slice('/github delete'.length).trim();

      if (argPart) {
        // Direct delete: /github delete some-workflow.yml
        const filePath = argPart.includes('/') ? argPart : `.github/workflows/${argPart}`;
        if (!confirm(`删除 ${filePath}？此操作不可撤销。`)) {
          addMessageBubble('model', `_${tl('msgCancelled')}_`);
          return true;
        }
        const bubble = addMessageBubble('model', `_Deleting \`${filePath}\`…_`);
        try {
          await GitHubActions.deleteFile(config, filePath);
          const upstashMsg = await tryCleanUpstash(filePath);
          bubble.innerHTML = renderMarkdown(`✅ \`${filePath}\` 已删除。${upstashMsg}`);
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
        }
        return true;
      }

      // No arg: list workflows and render interactive picker
      const bubble = addMessageBubble('model', `_${tl('msgLoadingWorkflows')}…_`);
      try {
        const workflows = await GitHubActions.listWorkflows(config);
        if (!workflows.length) {
          bubble.innerHTML = renderMarkdown(`_${tl('msgNoWorkflowsFound')}_`);
          return true;
        }
        const header = `<div style="font-weight:600;margin-bottom:8px;">🗑️ ${tl('msgPickWorkflowToDelete')}</div>`;
        const rows = workflows.map(wf => {
          const file = wf.path.replace('.github/workflows/', '');
          const stateIcon = wf.state === 'active' ? '✅' : '⏸️';
          return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);">
            <span style="flex:1;font-size:13px;">${stateIcon} <strong>${wf.name}</strong> <code style="font-size:11px;opacity:.7;">${file}</code></span>
            <button class="gh-delete-wf-btn" data-path="${wf.path}" data-name="${escapeHtml(wf.name)}"
              style="background:#c0392b;color:#fff;border:none;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:12px;">
              删除
            </button>
          </div>`;
        }).join('');
        bubble.innerHTML = header + rows;

        // Wire delete buttons
        bubble.querySelectorAll('.gh-delete-wf-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const path = btn.dataset.path;
            const name = btn.dataset.name;
            if (!confirm(`${tl('msgDeleteConfirm')}: "${name}" (${path})`)) return;
            btn.disabled = true;
            btn.textContent = tl('btnDeleting');
            try {
              await GitHubActions.deleteFile(config, path);
              const upstashMsg = await tryCleanUpstash(path);
              btn.closest('div[style]').innerHTML =
                `<span style="opacity:.5;font-size:12px;">✅ <del>${escapeHtml(name)}</del> 已删除${upstashMsg ? ' 🧹' : ''}</span>`;
            } catch (e) {
              btn.disabled = false;
              btn.textContent = tl('btnDelete');
              showToast(`${tl('msgDeleteFailed')}: ${e.message}`, 'error');
            }
          });
        });
      } catch (e) {
        bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
      }
      return true;
    }

    // ─── /loop — Deploy and manage Loop Agent ──────────────────────────

    if (cmd === '/loop status') {
      addMessageBubble('user', '/loop status');

      // Show the status panel
      showLoopStatusPanel();
      refreshLoopStatusPanel();

      const cfg = getSessionConfig(currentSessionId);
      const loopKeys = cfg.loopKeys || [];
      if (loopKeys.length === 0) {
        addMessageBubble('model', `_${tl('msgNoLoopAgents')}_`);
        return true;
      }

      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const bubble = addMessageBubble('model', `⏳ ${tl('msgCheckingLoopStatus')}…`);
      (async () => {
        try {
          // Check loop agent workflow runs via GitHub Actions API
          const recentRuns = await GitHubActions.listRecentRuns(config, null, 30);
          const lines = [`## 🔄 ${tl('msgLoopAgentStatus')}\n`];
          for (const key of loopKeys) {
            // Find the most recent run matching this loop key
            const run = recentRuns.find(r => r.name && r.name.includes(key));
            if (run) {
              const stateIcon = run.status === 'in_progress' || run.status === 'queued' ? '🟢' : run.conclusion === 'success' ? '✅' : '🔴';
              const elapsed = Math.round((Date.now() - new Date(run.run_started_at || run.created_at).getTime()) / 60000);
              lines.push(`- ${stateIcon} **${key}** — ${run.status}${run.conclusion ? ` (${run.conclusion})` : ''} · ${elapsed}min · [View](${run.html_url})`);
            } else {
              lines.push(`- ⚪ **${key}** — no workflow run found`);
            }
          }
          bubble.innerHTML = renderMarkdown(lines.join('\n'));
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ ${e.message}`);
        }
      })();
      return true;
    }

    // /loop clear removed — Upstash cleanup is now handled automatically by /github delete

    // ─── /loop memory clear — Clear loop agent MEMORY.md ───────────────
    if (cmd.startsWith('/loop memory clear')) {
      addMessageBubble('user', text.trim());
      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const bubble = addMessageBubble('model', `⏳ Clearing loop agent memory…`);
      (async () => {
        try {
          const repoOverride = getLoopDataRepoForKey(_loopConnectedKey);
          const result = await LoopAgent.clearMemory(config, 'loop-agent/MEMORY.md', repoOverride);
          if (result.cleared) {
            bubble.innerHTML = renderMarkdown(`✅ Loop agent memory (MEMORY.md) has been cleared.`);
          } else {
            bubble.innerHTML = renderMarkdown(`ℹ️ ${result.reason}`);
          }
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ Failed to clear memory: ${e.message}`);
        }
      })();
      return true;
    }

    // /loop leave, join, send, roll, focus, wake — multi-agent coordination handled by runner.js

    // ─── /loop connect <key> — Connect to a running loop agent ────────
    if (cmd.startsWith('/loop connect')) {
      const loopKeyArg = text.trim().slice('/loop connect'.length).trim();
      addMessageBubble('user', text.trim());

      if (!loopKeyArg) {
        // List known loop keys for this session
        const cfg = getSessionConfig(currentSessionId);
        const keys = cfg.loopKeys || [];
        if (keys.length === 0) {
          addMessageBubble('model', `⚠️ No loop agents found in this session.\n\nUsage: \`/loop connect <key>\``);
        } else {
          addMessageBubble('model', `**Loop keys in this session:**\n${keys.map(k => `- \`/loop connect ${k}\``).join('\n')}`);
        }
        return true;
      }

      // Disconnect previous connection if any
      disconnectLoopAgent();

      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const cfg = getSessionConfig(currentSessionId);
      const upstashUrl = cfg.upstashUrl || '';
      const upstashToken = cfg.upstashToken || '';
      const repoOverride = getLoopDataRepoForKey(loopKeyArg);

      const bubble = addMessageBubble('model', `⏳ Connecting to loop agent **${escapeHtml(loopKeyArg)}**…`);

      (async () => {
        try {
          // Fetch history from the repo to show past conversation
          let historyMessages = [];
          try {
            historyMessages = await LoopAgent.fetchHistory(config, loopKeyArg, 'loop-agent/history', repoOverride);
          } catch (e) {
            console.warn(`[Loop Connect] History fetch failed: ${e.message}`);
          }

          // Activate connected mode
          _loopConnectedKey = loopKeyArg;

          // Show banner
          const banner = document.getElementById('loop-connect-banner');
          const keySpan = document.getElementById('loop-connect-key');
          if (banner && keySpan) {
            keySpan.textContent = loopKeyArg;
            banner.classList.remove('hidden');
            banner.style.display = 'flex';
          }

          // Save loop key to session config for tracking
          const cfgSave = getSessionConfig(currentSessionId);
          if (!cfgSave.loopKeys) cfgSave.loopKeys = [];
          if (!cfgSave.loopKeys.includes(loopKeyArg)) {
            cfgSave.loopKeys.push(loopKeyArg);
          }
          saveSessionConfig(currentSessionId, cfgSave);

          // Display conversation history
          if (historyMessages.length > 0) {
            const lines = [`## 🔄 Loop Agent — ${loopKeyArg}\n`, `_${historyMessages.length} messages from history_\n`];
            // Show last 20 messages to avoid overflow
            const recent = historyMessages.slice(-20);
            if (historyMessages.length > 20) {
              lines.push(`_…${historyMessages.length - 20} earlier messages omitted_\n`);
            }
            for (const msg of recent) {
              const role = msg.role === 'user' ? '👤 **User**' : '🤖 **Agent**';
              const time = msg.ts ? new Date(msg.ts).toLocaleString() : '';
              const content = msg.content.length > 500 ? msg.content.slice(0, 500) + '…' : msg.content;
              lines.push(`${role} ${time ? `_(${time})_` : ''}\n${content}\n`);
            }
            lines.push(`---\n_Connected. Type messages below to chat with the loop agent. Use \`/loop disconnect\` to exit._`);
            bubble.innerHTML = renderMarkdown(lines.join('\n'));
          } else {
            bubble.innerHTML = renderMarkdown(`✅ Connected to loop agent **${loopKeyArg}**.\n\n_No previous conversation history found._\n\nType messages below — they will be sent directly to the loop agent. Use \`/loop disconnect\` to exit.`);
          }
          scrollToBottom();

          // Start background polling for responses (adaptive: slows when idle)
          const LOOP_POLL_BASE = 3000;
          const LOOP_POLL_MAX = 18000; // 6x slowdown
          const LOOP_POLL_SLOW_AFTER = 5;
          let loopEmptyPolls = 0;
          let loopCurrentInterval = LOOP_POLL_BASE;

          const loopPollOnce = async () => {
            if (!_loopConnectedKey) return;
            try {
              let pollConfig;
              try { pollConfig = getActionConfig(); }
              catch { _loopPollTimer = setTimeout(loopPollOnce, loopCurrentInterval); return; }
              const pollCfg = getSessionConfig(currentSessionId);
              const response = await LoopAgent.pollIntervention(pollConfig, _loopConnectedKey, {
                upstashUrl: pollCfg.upstashUrl || '',
                upstashToken: pollCfg.upstashToken || '',
                repoOverride: getLoopDataRepoForKey(_loopConnectedKey),
              });
              if (response && response.text) {
                addMessageBubble('model', `🤖 **${escapeHtml(_loopConnectedKey)}**:\n\n${response.text}`);
                scrollToBottom();
                loopEmptyPolls = 0;
                loopCurrentInterval = LOOP_POLL_BASE;
              } else {
                loopEmptyPolls++;
                if (loopEmptyPolls >= LOOP_POLL_SLOW_AFTER && loopCurrentInterval === LOOP_POLL_BASE) {
                  loopCurrentInterval = LOOP_POLL_MAX;
                  console.log(`[Loop Connect] No responses for ${LOOP_POLL_SLOW_AFTER} polls, slowing to ${loopCurrentInterval / 1000}s`);
                }
              }
            } catch (e) {
              console.warn(`[Loop Connect] Poll error: ${e.message}`);
            }
            if (_loopConnectedKey) {
              _loopPollTimer = setTimeout(loopPollOnce, loopCurrentInterval);
            }
          };
          _loopPollReset = () => {
            loopEmptyPolls = 0;
            loopCurrentInterval = LOOP_POLL_BASE;
            // Restart timer immediately for fast response
            if (_loopPollTimer) clearTimeout(_loopPollTimer);
            _loopPollTimer = setTimeout(loopPollOnce, LOOP_POLL_BASE);
          };
          _loopPollTimer = setTimeout(loopPollOnce, LOOP_POLL_BASE);

        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ Failed to connect: ${e.message}`);
        }
      })();
      return true;
    }

    // ─── /loop channel — Switch to a specific notification channel ────
    if (cmd.startsWith('/loop channel')) {
      addMessageBubble('user', text.trim());
      if (!_loopConnectedKey) {
        addMessageBubble('model', `⚠️ Not connected to a loop agent. Use \`/loop connect <key>\` first.`);
        return true;
      }

      // Get available channels
      const freshPushoo = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
      if (freshPushoo.channels.length === 0) {
        addMessageBubble('model', `⚠️ No notification channels configured. Open **Settings** → **Notifications** to add channels.`);
        return true;
      }

      let config;
      try { config = getActionConfig(); }
      catch (e) { addMessageBubble('model', `⚠️ ${e.message}`); return true; }

      const cfg = getSessionConfig(currentSessionId);
      const platformArg = text.trim().slice('/loop channel'.length).trim().toLowerCase();

      // Helper function to switch to a specific channel
      const switchToChannel = async (selectedChannels) => {
        const channelsJson = JSON.stringify(selectedChannels);
        const controlMsg = `__SWITCH_CHANNEL__:${channelsJson}`;
        try {
          await LoopAgent.sendIntervention(config, _loopConnectedKey, controlMsg, {
            upstashUrl: cfg.upstashUrl || '',
            upstashToken: cfg.upstashToken || '',
            repoOverride: getLoopDataRepoForKey(_loopConnectedKey),
          });
          const summary = PushooNotifier.getChannelSummary({ channels: selectedChannels });
          return { success: true, summary };
        } catch (e) {
          return { success: false, error: e.message };
        }
      };

      // If platform is specified via command, switch directly
      if (platformArg) {
        const selectedChannel = freshPushoo.channels.find(ch => ch.platform === platformArg);
        if (!selectedChannel) {
          addMessageBubble('model', `⚠️ Channel "${escapeHtml(platformArg)}" not configured.\n\nAvailable: ${freshPushoo.channels.map(ch => `\`${ch.platform}\``).join(', ')}`);
          return true;
        }

        const bubble = addMessageBubble('model', `⏳ Switching to **${escapeHtml(platformArg)}**…`);
        (async () => {
          const result = await switchToChannel([selectedChannel]);
          if (result.success) {
            bubble.innerHTML = renderMarkdown(`✅ Switched to **${escapeHtml(platformArg)}**`);
          } else {
            bubble.innerHTML = renderMarkdown(`❌ Failed to switch: ${result.error}`);
          }
        })();
        return true;
      }

      // No platform specified: show interactive channel selector buttons
      const panelId = 'ch-sel-' + Date.now();
      const ICONS = { telegram: '✈️', wecombot: '💼', discord: '💬', dingtalk: '🔔', feishu: '🐦', webhook: '🔗' };
      const bubble = addMessageBubble('model', '');
      bubble.innerHTML = [
        `<div id="${panelId}" style="padding:12px;">`,
        `<div style="margin-bottom:10px;font-weight:600;">📡 Switch notification channel for <strong>${escapeHtml(_loopConnectedKey)}</strong>:</div>`,
        `<div style="display:flex;flex-wrap:wrap;gap:8px;">`,
        ...freshPushoo.channels.map(ch => {
          const icon = ICONS[ch.platform] || '📨';
          return `<button data-platform="${escapeHtml(ch.platform)}" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:#fff;border:1px solid #d0d7de;border-radius:8px;cursor:pointer;font-size:14px;transition:all .15s;">${icon} ${escapeHtml(ch.platform)}</button>`;
        }),
        `</div>`,
        `<div class="ch-result" style="margin-top:10px;"></div>`,
        `</div>`
      ].join('');

      // Scoped event delegation on this panel only
      const panel = document.getElementById(panelId);
      if (panel) {
        let switching = false;
        panel.addEventListener('click', async (e) => {
          const btn = e.target.closest('button[data-platform]');
          if (!btn || switching) return;
          const platform = btn.dataset.platform;
          const selectedChannel = freshPushoo.channels.find(ch => ch.platform === platform);
          if (!selectedChannel) return;

          // Disable all buttons & show loading
          switching = true;
          const buttons = panel.querySelectorAll('button[data-platform]');
          buttons.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; b.style.cursor = 'wait'; });
          btn.style.opacity = '1';
          btn.style.borderColor = '#0969da';
          btn.style.background = '#ddf4ff';
          const resultDiv = panel.querySelector('.ch-result');
          resultDiv.innerHTML = `<span style="color:#656d76;">⏳ Switching to <strong>${escapeHtml(platform)}</strong>…</span>`;

          const result = await switchToChannel([selectedChannel]);

          if (result.success) {
            resultDiv.innerHTML = `<span style="color:#1a7f37;">✅ Switched to <strong>${escapeHtml(platform)}</strong></span>`;
            // Keep selected button highlighted, restore others
            buttons.forEach(b => {
              b.disabled = false;
              b.style.cursor = 'pointer';
              if (b === btn) {
                b.style.opacity = '1'; b.style.borderColor = '#0969da'; b.style.background = '#ddf4ff';
              } else {
                b.style.opacity = '1'; b.style.borderColor = '#d0d7de'; b.style.background = '#fff';
              }
            });
          } else {
            resultDiv.innerHTML = `<span style="color:#cf222e;">❌ Failed: ${escapeHtml(result.error)}</span>`;
            buttons.forEach(b => { b.disabled = false; b.style.opacity = '1'; b.style.cursor = 'pointer'; b.style.borderColor = '#d0d7de'; b.style.background = '#fff'; });
          }
          switching = false;
        });
      }
      scrollToBottom();
      return true;
    }

    // ─── /loop dashboard — Show/hide the Loop Agent status panel ──────
    if (cmd === '/loop dashboard') {
      addMessageBubble('user', '/loop dashboard');
      if (_loopStatusPanelVisible) {
        hideLoopStatusPanel();
        addMessageBubble('model', `Dashboard panel hidden.`);
      } else {
        showLoopStatusPanel();
        refreshLoopStatusPanel();
        addMessageBubble('model', `Dashboard panel shown. Use the ↻ button to refresh.`);
      }
      return true;
    }

    // ─── /loop disconnect — Disconnect from the loop agent ────────────
    if (cmd === '/loop disconnect') {
      addMessageBubble('user', '/loop disconnect');
      if (!_loopConnectedKey) {
        addMessageBubble('model', `ℹ️ Not connected to any loop agent.`);
      } else {
        const key = _loopConnectedKey;
        disconnectLoopAgent();
        addMessageBubble('model', `✅ Disconnected from loop agent **${escapeHtml(key)}**.`);
      }
      return true;
    }

    if (cmd === '/loop deploy') {
      addMessageBubble('user', '/loop deploy');

      // Check prerequisites and guide user if missing
      const prereqs = checkLoopPrerequisites();
      if (!prereqs.ready) {
        const bubble = addMessageBubble('model', '');
        const items = [];
        if (prereqs.missing.includes('github_actions')) {
          items.push(`<button class="loop-prereq-btn" data-action="settings" style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;cursor:pointer;color:#e0e0e0;font-size:13px;text-align:left;"><span style="font-size:18px;">📂</span><span><strong>${escapeHtml(tl('loopPrereqGithubTitle'))}</strong><br><span style="opacity:.7;font-size:12px;">${escapeHtml(tl('loopPrereqGithubDesc'))}</span></span></button>`);
        }
        if (prereqs.missing.includes('api_key') || prereqs.missing.includes('model') || prereqs.missing.includes('openai_base_url')) {
          items.push(`<button class="loop-prereq-btn" data-action="settings" style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;cursor:pointer;color:#e0e0e0;font-size:13px;text-align:left;"><span style="font-size:18px;">🤖</span><span><strong>${escapeHtml(tl('loopPrereqAiTitle'))}</strong><br><span style="opacity:.7;font-size:12px;">${escapeHtml(tl('loopPrereqAiDesc'))}</span></span></button>`);
        }
        if (prereqs.missing.includes('messaging_channel')) {
          items.push(`<button class="loop-prereq-btn" data-action="pushoo" style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;cursor:pointer;color:#e0e0e0;font-size:13px;text-align:left;"><span style="font-size:18px;">📡</span><span><strong>${escapeHtml(tl('loopPrereqChannelTitle'))}</strong><br><span style="opacity:.7;font-size:12px;">${escapeHtml(tl('loopPrereqChannelDesc'))}</span></span></button>`);
        }
        bubble.innerHTML = `
          <div style="padding:12px;">
            <div style="font-weight:600;font-size:15px;margin-bottom:12px;">🔄 ${escapeHtml(tl('loopSetupTitle'))}</div>
            <div style="opacity:.8;margin-bottom:14px;font-size:13px;">${escapeHtml(tl('loopSetupMissingDesc'))}</div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">${items.join('')}</div>
            <button class="loop-prereq-retry" style="width:100%;padding:8px 14px;background:#22863a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">🔄 ${escapeHtml(tl('loopSetupRetryDeploy'))}</button>
          </div>
        `;
        // Wire buttons
        bubble.querySelectorAll('.loop-prereq-btn').forEach(btn => {
          btn.addEventListener('click', () => {
            const action = btn.dataset.action;
            if (action === 'pushoo') {
              if (typeof openPushooConfigDialog === 'function') {
                openPushooConfigDialog(currentSessionId);
              }
              return;
            }
            openSettings();
          });
        });
        bubble.querySelector('.loop-prereq-retry')?.addEventListener('click', () => {
          const input = document.getElementById('message-input');
          if (input) { input.value = '/loop deploy'; }
          document.getElementById('send-btn')?.click();
        });
        return true;
      }

      let config;
      try {
        config = getActionConfig();
      } catch (e) {
        addMessageBubble('model', `⚠️ ${e.message}`);
        return true;
      }

      // Require a bidirectional messaging channel (Telegram via Pushoo or WeCom Bot)
      const pushooConfig = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
      const hasTelegram = pushooConfig.channels.some(ch => ch.platform === 'telegram' && ch.token);
      const hasWecom = pushooConfig.channels.some(ch => ch.platform === 'wecombot' && ch.token);

      const provider = getSessionSetting('provider') || inferProviderFromModel(getSessionSetting('model'));
      const model = getSessionSetting('model');
      const apiKey = provider === 'qwen' ? getSessionSetting('qwenApiKey')
        : provider === 'kimi' ? getSessionSetting('kimiApiKey')
        : provider === 'openai' ? getSessionSetting('openaiApiKey')
        : getSessionSetting('apiKey');
      const openaiBaseUrl = provider === 'openai' ? getSessionSetting('openaiBaseUrl') : '';

      if (!apiKey) {
        addMessageBubble('model', `⚠️ ${tl('toastSetApiKeyFirst')}`);
        return true;
      }

      const loopKey = LoopAgent.generateLoopKey();

      // Build deploy wizard UI
      const bubble = addMessageBubble('model', '');
      bubble.innerHTML = `
        <div class="schedule-wizard">
          <div class="schedule-wizard-title">🔄 ${tl('msgDeployLoopAgent')}</div>

          <label class="schedule-field-label">${tl('msgLoopSystemPrompt')}</label>
          <textarea id="loop-system-prompt" class="schedule-input" rows="2" placeholder="Optional: custom system prompt..."
            style="resize:vertical;font-size:12px;"></textarea>

          <div style="display:flex;gap:8px;">
            <div style="flex:1;">
              <label class="schedule-field-label">${tl('msgLoopMaxRuntime')}</label>
              <select id="loop-max-runtime" class="schedule-input">
                <option value="3600">1 hour</option>
                <option value="10800">3 hours</option>
                <option value="18000" selected>5 hours</option>
                <option value="21000">5h50m</option>
              </select>
            </div>
            <div style="flex:1;">
              <label class="schedule-field-label">${tl('msgLoopPollInterval')}</label>
              <select id="loop-poll-interval" class="schedule-input">
                <option value="3">3s</option>
                <option value="5" selected>5s</option>
                <option value="10">10s</option>
                <option value="30">30s</option>
              </select>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:6px;margin:10px 0;font-size:12px;opacity:.8;">
            <span>🔑 <code>${escapeHtml(loopKey)}</code></span>
            <span>·</span>
            <span>🤖 ${escapeHtml(provider)}/${escapeHtml(model)}</span>
            <span>·</span>
            <span>📂 ${escapeHtml(config.owner)}/${escapeHtml(config.repo)}</span>
            <span>·</span>
            <span>📢 ${PushooNotifier.getChannelSummary(pushooConfig)}</span>
          </div>

          <input id="loop-key-input" type="hidden" value="${escapeHtml(loopKey)}" />

          <div class="schedule-actions">
            <button id="loop-cancel-btn" class="schedule-btn schedule-btn-secondary">${tl('cancel')}</button>
            <button id="loop-deploy-btn" class="schedule-btn schedule-btn-primary">🚀 ${tl('msgDeployAndStart')}</button>
          </div>
        </div>
      `;

      scrollToBottom();

      // Cancel
      bubble.querySelector('#loop-cancel-btn').addEventListener('click', () => {
        bubble.innerHTML = renderMarkdown(`_Loop agent deployment cancelled._`);
      });

      // Deploy
      bubble.querySelector('#loop-deploy-btn').addEventListener('click', async () => {
        const deployBtn = bubble.querySelector('#loop-deploy-btn');
        deployBtn.disabled = true;
        deployBtn.textContent = `⏳ ${tl('btnDeploying')}`;

        const systemPrompt = bubble.querySelector('#loop-system-prompt').value.trim();
        const pollInterval = parseInt(bubble.querySelector('#loop-poll-interval').value);
        const maxRuntime = parseInt(bubble.querySelector('#loop-max-runtime').value);

        try {
          // Load runner script and sub-agent script
          const [runnerScript, subAgentScript, browserAgentScript] = await Promise.all([
            LoopAgent.getRunnerScript(),
            LoopAgent.getSubAgentScript(),
            LoopAgent.getBrowserAgentScript(),
          ]);

          // Re-read pushoo config fresh (user may have configured it after wizard appeared)
          const freshPushoo = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));

          // Log pushoo config being synced
          console.log('[Loop Deploy] Pushoo channels:', freshPushoo.channels.length);

          // Loop data must live in a dedicated private repo (separate from GHA session repo)
          const preferredOwner = getSessionSetting('githubOwner') || config.owner;
          const preferredRepoRaw = getSessionSetting('githubRepo') || `${config.repo}-loop-private`;
          const preferredRepo = (preferredRepoRaw === config.repo && preferredOwner === config.owner)
            ? `${config.repo}-loop-private`
            : preferredRepoRaw;
          const dataRepo = await LoopAgent.ensurePrivateRepo(config, preferredOwner, preferredRepo);

          const result = await LoopAgent.deploy({
            actionConfig: config,
            dataRepo,
            runnerScript,
            subAgentScript,
            browserAgentScript,
            loopKey,
            agentOpts: {
              provider,
              model,
              pollInterval,
              maxRuntime,
              systemPrompt,
              historyPath: 'loop-agent/history',
            },
            secrets: {
              aiApiKey: apiKey,
              aiBaseUrl: openaiBaseUrl || undefined,
              upstashUrl: getSessionSetting('upstashUrl') || undefined,
              upstashToken: getSessionSetting('upstashToken') || undefined,
              pushooChannels: freshPushoo.channels.length > 0 ? JSON.stringify(freshPushoo.channels) : undefined,
            },
            onProgress: (step, detail) => {
              deployBtn.textContent = `⏳ ${detail}`;
            },
          });

          // Save loop key to session config for tracking
          const cfg = getSessionConfig(currentSessionId);
          if (!cfg.loopKeys) cfg.loopKeys = [];
          if (!cfg.loopKeys.includes(loopKey)) cfg.loopKeys.push(loopKey);
          if (!cfg.loopDataRepos) cfg.loopDataRepos = {};
          cfg.loopDataRepos[loopKey] = { owner: dataRepo.owner, repo: dataRepo.repo };
          saveSessionConfig(currentSessionId, cfg);

          // Show success UI
          const repoUrl = result.repoUrl;
          const dataRepoUrl = result.dataRepoUrl || repoUrl;
          bubble.innerHTML = `
            <div style="padding:12px;">
              <div style="font-weight:600;font-size:15px;margin-bottom:10px;">✅ Loop Agent Deployed!</div>

              <div style="margin-bottom:12px;">
                <code style="display:block;padding:8px 12px;background:var(--bg-darker,#111);border-radius:4px;font-size:14px;letter-spacing:0.5px;user-select:all;">${escapeHtml(loopKey)}</code>
              </div>

              <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;font-size:12px;opacity:.7;">
                <span>🤖 ${escapeHtml(provider)}/${escapeHtml(model)}</span>
                <span>·</span>
                <span>⚡ GHA: <a href="${repoUrl}" target="_blank" style="color:#8ec5fc;">${escapeHtml(config.owner)}/${escapeHtml(config.repo)}</a></span>
                <span>·</span>
                <span>🔒 Data: <a href="${dataRepoUrl}" target="_blank" style="color:#8ec5fc;">${escapeHtml(dataRepo.owner)}/${escapeHtml(dataRepo.repo)}</a></span>
                <span>·</span>
                <span>⏱ ${maxRuntime / 3600}h</span>
                ${result.errors.length ? `<span style="color:#e74c3c;">· ❌ ${result.errors.join('; ')}</span>` : ''}
              </div>

              <div style="display:flex;flex-wrap:wrap;gap:8px;">
                <button class="loop-success-cmd" data-cmd="/loop connect ${escapeHtml(loopKey)}" style="display:flex;align-items:center;gap:4px;padding:6px 14px;background:#22863a;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">🔗 Connect</button>
                <button class="loop-success-cmd" data-cmd="/loop status" style="display:flex;align-items:center;gap:4px;padding:6px 14px;background:rgba(255,255,255,.1);color:#e0e0e0;border:1px solid rgba(255,255,255,.15);border-radius:6px;cursor:pointer;font-size:12px;">📊 Status</button>
                <button class="loop-success-cmd" data-cmd="/loop dashboard" style="display:flex;align-items:center;gap:4px;padding:6px 14px;background:rgba(255,255,255,.1);color:#e0e0e0;border:1px solid rgba(255,255,255,.15);border-radius:6px;cursor:pointer;font-size:12px;">📋 Dashboard</button>
                <a href="${repoUrl}/actions" target="_blank" style="display:flex;align-items:center;gap:4px;padding:6px 14px;background:rgba(255,255,255,.1);color:#e0e0e0;border:1px solid rgba(255,255,255,.15);border-radius:6px;cursor:pointer;font-size:12px;text-decoration:none;">🔗 GitHub Actions</a>
              </div>
            </div>
          `;

          // Wire command buttons
          bubble.querySelectorAll('.loop-success-cmd').forEach(btn => {
            btn.addEventListener('click', () => {
              const input = document.getElementById('message-input');
              if (input) { input.value = btn.dataset.cmd; }
              document.getElementById('send-btn')?.click();
            });
          });

          showToast(`Loop agent "${loopKey}" deployed and started!`, 'success');

          // Show status panel automatically after deploy
          showLoopStatusPanel();
          setTimeout(() => refreshLoopStatusPanel(), 5000); // Delay for GHA to start
        } catch (err) {
          bubble.innerHTML = '';
          const statusCard = createStatusCard(bubble);
          updateStatusCard(statusCard, 'failure', `Deploy failed: ${err.message}`);
          showToast(`Loop agent deploy failed: ${err.message}`, 'error');
        }
      });

      return true;
    }

    return false;
  }

  // ─── Send Message ──────────────────────────────────────────────────

  async function sendMessage() {
    const input = $('#message-input');
    const originalText = input.value;
    const text = originalText.trim();
    if (!text || isStreaming) return;

    // Must have an active session
    if (!currentSessionId) {
      showToast(tl('toastClickPlusFirst'), 'info');
      return;
    }

    // ── Loop connect mode intercept ──
    // When connected to a loop agent, send messages to the agent instead of the normal AI chat
    if (_loopConnectedKey && !text.startsWith('/')) {
      input.value = '';
      autoResizeInput();
      addMessageBubble('user', text);
      const bubble = addMessageBubble('model', `⏳ Sending to **${escapeHtml(_loopConnectedKey)}**…`);
      scrollToBottom();

      (async () => {
        try {
          let config;
          try { config = getActionConfig(); }
          catch (e) { bubble.innerHTML = renderMarkdown(`⚠️ ${e.message}`); return; }

          const cfg = getSessionConfig(currentSessionId);
          const upstashUrl = cfg.upstashUrl || '';
          const upstashToken = cfg.upstashToken || '';
          const repoOverride = getLoopDataRepoForKey(_loopConnectedKey);

          const result = await LoopAgent.sendIntervention(config, _loopConnectedKey, text, {
            upstashUrl, upstashToken, repoOverride,
          });
          bubble.innerHTML = renderMarkdown(`📤 Sent via **${result.channel}**. Waiting for reply…`);
          scrollToBottom();
          // Reset adaptive polling to fast mode after sending
          if (_loopPollReset) _loopPollReset();
        } catch (e) {
          bubble.innerHTML = renderMarkdown(`❌ Failed to send: ${e.message}`);
        }
      })();
      return;
    }

    const model = getSessionSetting('model');
    if (!model) {
      showToast(tl('toastSetModelInSettings'), 'error');
      openSettings();
      return;
    }

    // Determine provider from explicit setting first, then model hint.
    const provider = getSessionSetting('provider') || inferProviderFromModel(model);
    
    // Get the appropriate API key for the provider
    let apiKey;
    let qwenApiKey = null;
    let openaiBaseUrl = null;
    if (provider === 'qwen') {
      apiKey = getSessionSetting('qwenApiKey');
      if (!apiKey) {
        showToast(tl('toastPleaseSetQwenKey'), 'error');
        openSettings();
        return;
      }
    } else if (provider === 'kimi') {
      apiKey = getSessionSetting('kimiApiKey');
      if (!apiKey) {
        showToast(tl('toastPleaseSetKimiKey'), 'error');
        openSettings();
        return;
      }
    } else if (provider === 'openai') {
      apiKey = getSessionSetting('openaiApiKey');
      openaiBaseUrl = getSessionSetting('openaiBaseUrl');
      if (!apiKey) {
        showToast('Please set your OpenAI-compatible API key in settings', 'error');
        openSettings();
        return;
      }
      if (!openaiBaseUrl) {
        showToast('Please set the Base URL for your OpenAI-compatible endpoint', 'error');
        openSettings();
        return;
      }
    } else {
      apiKey = getSessionSetting('apiKey');
      if (!apiKey) {
        showToast(tl('toastPleaseSetGeminiKey'), 'error');
        openSettings();
        return;
      }
    }

    // Check for slash commands
    if (text.startsWith('/')) {
      input.value = '';
      autoResizeInput();

      const handled = await handleSlashCommand(text);
      if (handled) {
        return;
      }

      // Not a recognized slash command: restore raw input and continue normal send flow.
      input.value = originalText;
      autoResizeInput();
    }

    // Clear welcome screen if present
    const welcome = $('.welcome-screen');
    if (welcome) welcome.remove();

    input.value = '';
    autoResizeInput();

    // Refresh session context in system instruction so AI sees latest settings
    if (baseSoulInstruction) {
      const ctx = buildSessionContext();
      Chat.setSystemInstruction(baseSoulInstruction + '\n\n' + ctx);
    }

    // Show user message
    addMessageBubble('user', text);

    // Create streaming bubble
    const streamBubble = createStreamingBubble();

    // Toggle UI state
    setStreamingState(true);

    const enableSearch = getSessionSetting('enableSearch', false);
    const enableThinking = getSessionSetting('enableThinking', false);

    // Build thinking config
    let thinkingConfig = null;
    if (enableThinking) {
      thinkingConfig = { enabled: true };
      const budget = getSessionSetting('thinkingBudget', '');
      if (budget !== '' && budget != null) {
        thinkingConfig.thinkingBudget = parseInt(budget, 10);
      }
      thinkingConfig.includeThoughts = getSessionSetting('includeThoughts', false);
    }

    // LAYER 2: preflight skill resolution (only if skills are loaded)
    let systemInstructionOverride = undefined;
    if (loadedSkills.length > 0) {
      streamBubble.innerHTML = '<span style="opacity:.5;font-size:12px;">🧩 Resolving skill…</span>';
      const result = await resolveSkillOverride(text, apiKey, model);
      if (result) {
        systemInstructionOverride = result.override;
        streamBubble.innerHTML = `<span style="opacity:.5;font-size:12px;">🧩 Activating <em>${escapeHtml(result.skillName)}</em>…</span>`;
      } else {
        streamBubble.innerHTML = '';
      }
    }

    let _firstSaveDone = false;

    try {
      await Chat.send({
        provider,
        apiKey,
        qwenApiKey: getSessionSetting('qwenApiKey'),
        openaiBaseUrl,
        model,
        message: text,
        enableSearch,
        thinkingConfig,
        systemInstructionOverride,
        onStart() {
          // New session or first message: update sidebar title immediately
          if (!_firstSaveDone) {
            _firstSaveDone = true;
            saveCurrentSession().then(() => renderSidebar());
          }
        },
        onChunk(delta, fullText) {
          streamBubble.innerHTML =
            escapeHtml(fullText) + '<span class="cursor-blink">▊</span>';
          scrollToBottom();
        },
        onDone(fullText, metadata) {
          finalizeStreamingBubble(fullText);

          // Render grounding sources if available
          if (metadata?.grounding) {
            renderGroundingSources(metadata.grounding);
          }

          // Update token display
          updateTokenDisplay();

          setStreamingState(false);
          // Auto-save (await so passphrase dialog works)
          saveCurrentSession().then(() => renderSidebar());
        },
        onError(err) {
          setStreamingState(false);
          streamBubble.closest('.message-wrapper')?.remove();
          addErrorBubble(err.message);
          showToast(tl('toastRequestFailed'), 'error');
        },
      });
    } catch (err) {
      setStreamingState(false);
      streamBubble.closest('.message-wrapper')?.remove();
      addErrorBubble(err.message);
      showToast(tl('toastRequestFailed'), 'error');
    }
  }

  function setStreamingState(streaming) {
    isStreaming = streaming;
    const sendBtn = $('#send-btn');
    const stopBtn = $('#stop-btn');
    if (streaming) {
      hide(sendBtn);
      show(stopBtn);
      $('#message-input').disabled = true;
    } else {
      show(sendBtn);
      hide(stopBtn);
      $('#message-input').disabled = false;
      $('#message-input').focus();
    }
  }

  // ─── Settings Panel ────────────────────────────────────────────────

  let settingsTarget = null; // session ID being edited
  const _patVerification = {
    storage: null,
    action: null,
    guided: null,
  };

  function buildPatVerificationSig(token, owner, repo) {
    return `${(token || '').trim()}|${(owner || '').trim()}|${(repo || '').trim()}`;
  }

  function setPatVerification(type, signature, passed, message) {
    _patVerification[type] = {
      signature,
      passed: !!passed,
      message: message || '',
      at: Date.now(),
    };
  }

  function clearPatVerification(type) {
    _patVerification[type] = null;
  }

  function isPatVerificationValid(type, signature) {
    const state = _patVerification[type];
    return !!(state && state.passed && state.signature === signature);
  }

  async function testGitHubPatPermissions({ token, owner, repo }) {
    const cleanToken = (token || '').trim();
    const cleanOwner = (owner || '').trim();
    const cleanRepo = (repo || '').trim();
    if (!cleanToken) {
      throw new Error('Token is required for PAT test.');
    }

    const headers = {
      Authorization: `token ${cleanToken}`,
      Accept: 'application/vnd.github.v3+json',
    };

    const userResp = await fetch('https://api.github.com/user', { headers });
    if (!userResp.ok) {
      throw new Error('Invalid GitHub token or token expired.');
    }
    const user = await userResp.json();

    const scopesHeader = (userResp.headers.get('x-oauth-scopes') || '').trim();
    const scopes = scopesHeader
      ? scopesHeader.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : [];

    // Probe create-repository capability without creating anything:
    // POST /user/repos with empty payload should return 422 if authorized.
    const createRepoProbe = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    const canCreateRepo = createRepoProbe.status === 422;

    const checks = [
      `Create repo: ${canCreateRepo ? 'OK' : 'Missing'}`,
    ];

    let canManageRepo = false;
    let canManageContents = false;
    let canManageActions = false;

    if (!cleanOwner || !cleanRepo) {
      checks.push('Repo manage: Skipped (owner/repo not set)');
      checks.push('Contents manage: Skipped (owner/repo not set)');
      checks.push('Actions manage: Skipped (owner/repo not set)');
      return {
        passed: canCreateRepo,
        login: user.login,
        checks,
        scopes,
      };
    }

    const repoResp = await fetch(`https://api.github.com/repos/${cleanOwner}/${cleanRepo}`, { headers });
    if (repoResp.status === 404) {
      checks.push(`Repo manage: Skipped (${cleanOwner}/${cleanRepo} not found yet)`);
      checks.push(`Contents manage: Skipped (${cleanOwner}/${cleanRepo} not found yet)`);
      checks.push(`Actions manage: Skipped (${cleanOwner}/${cleanRepo} not found yet)`);
      return {
        passed: canCreateRepo,
        login: user.login,
        checks,
        scopes,
      };
    }
    if (!repoResp.ok) {
      throw new Error(`Failed to access repository (${repoResp.status}).`);
    }
    const repoData = await repoResp.json();
    const permissions = repoData.permissions || {};

    canManageRepo = !!(permissions.admin || permissions.maintain || permissions.push);
    canManageContents = !!(permissions.push || permissions.maintain || permissions.admin);

    const actionsPermResp = await fetch(`https://api.github.com/repos/${cleanOwner}/${cleanRepo}/actions/permissions`, { headers });
    if (actionsPermResp.ok) {
      canManageActions = true;
    } else {
      const workflowsResp = await fetch(`https://api.github.com/repos/${cleanOwner}/${cleanRepo}/actions/workflows?per_page=1`, { headers });
      const hasClassicWorkflowScope = scopes.includes('workflow') || scopes.includes('repo');
      if (workflowsResp.ok && hasClassicWorkflowScope) {
        canManageActions = true;
      }
    }

    const passed = canCreateRepo && canManageRepo && canManageContents && canManageActions;
    checks.push(`Repo manage: ${canManageRepo ? 'OK' : 'Missing'}`);
    checks.push(`Contents manage: ${canManageContents ? 'OK' : 'Missing'}`);
    checks.push(`Actions manage: ${canManageActions ? 'OK' : 'Missing'}`);

    return {
      passed,
      login: user.login,
      checks,
      scopes,
    };
  }

  async function testStoragePatFromSettings() {
    const token = $('#set-github-token')?.value.trim();
    const owner = $('#set-github-owner')?.value.trim();
    const repo = $('#set-github-repo')?.value.trim();
    const btn = $('#test-github-pat-btn');
    const signature = buildPatVerificationSig(token, owner, repo);

    if (!token) {
      showToast('Please fill Token first.', 'error');
      return;
    }

    const originalText = btn?.textContent || '🧪 Test PAT Permissions';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Testing...';
    }
    try {
      const result = await testGitHubPatPermissions({ token, owner, repo });
      if (!result.passed) {
        setPatVerification('storage', signature, false, result.checks.join(' | '));
        showToast(`PAT test failed: ${result.checks.join(' | ')}`, 'error');
        return;
      }
      setPatVerification('storage', signature, true, result.checks.join(' | '));
      showToast(`PAT test passed for ${result.login}: ${result.checks.join(' | ')}`, 'success');
    } catch (e) {
      setPatVerification('storage', signature, false, e.message);
      showToast(`PAT test failed: ${e.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  async function testActionPatFromSettings() {
    const token = $('#set-action-token')?.value.trim();
    const owner = $('#set-action-owner')?.value.trim();
    const repo = $('#set-action-repo')?.value.trim();
    const btn = $('#test-action-pat-btn');
    const signature = buildPatVerificationSig(token, owner, repo);

    if (!token) {
      showToast('Please fill Token first.', 'error');
      return;
    }

    const originalText = btn?.textContent || '🧪 Test PAT Permissions';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Testing...';
    }
    try {
      const result = await testGitHubPatPermissions({ token, owner, repo });
      if (!result.passed) {
        setPatVerification('action', signature, false, result.checks.join(' | '));
        showToast(`PAT test failed: ${result.checks.join(' | ')}`, 'error');
        return;
      }
      setPatVerification('action', signature, true, result.checks.join(' | '));
      showToast(`PAT test passed for ${result.login}: ${result.checks.join(' | ')}`, 'success');
    } catch (e) {
      setPatVerification('action', signature, false, e.message);
      showToast(`PAT test failed: ${e.message}`, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    }
  }

  // Helper: Update pushoo status badge when opening settings
  function updatePushooStatusBadge() {
    const badge = $('#pushoo-status-badge');
    if (!badge || !settingsTarget) return;
    const cfg = getSessionConfig(settingsTarget);
    const pc = PushooNotifier.parseConfig(cfg.pushooConfig);
    if (pc.channels.length > 0) {
      const summary = PushooNotifier.getChannelSummary(pc);
      badge.textContent = `✅ ${summary}`;
      badge.style.color = '#22863a';
    } else {
      badge.textContent = tl('notConfigured');
      badge.style.color = '#888';
    }
  }

  /**
   * Open settings panel for a session.
   * If no sessionId given, opens for the current session.
   */
  async function openSettings(sessionId) {
    const sid = sessionId || currentSessionId;
    if (!sid) return;
    settingsTarget = sid;

    const panel = $('#settings-panel');
    show(panel);

    // Show all sections
    show('#settings-section-ai');
    show('#settings-section-soul');
    show('#settings-section-storage');

    // Determine if this is a brand-new session (not yet in index)
    const entry = Storage.getIndex().find(s => s.id === sid);
    const isNew = !entry;
    const label = entry?.title || (isNew ? 'New Session' : sid.slice(0, 8));

    // Update header
    $('#settings-title').textContent = `⚙ ${tl('settingsPanelTitle')}`;
    $('#settings-subtitle').textContent = label;
    show('#settings-subtitle');

    // Populate from session config (fallback to global for values)
    const cfg = getSessionConfig(sid);
    const get = (key, fb) => cfgGet(cfg, key, getSetting(key, fb));

    // Passphrase field: only show for new sessions (first-time config)
    const ppField = $('#set-passphrase');
    const ppGroup = $('#passphrase-field-top') || ppField?.closest('.settings-field');
    if (ppGroup) {
      if (isNew) {
        show(ppGroup);
        ppField.value = '';
        ppField.readOnly = false;
        ppField.classList.remove('field-locked');
      } else {
        hide(ppGroup);
      }
    }

    // All settings read from per-session config (with global fallback)
    $('#set-api-key').value = get('apiKey', '');
    $('#set-qwen-api-key').value = get('qwenApiKey', '');
    $('#set-kimi-api-key').value = get('kimiApiKey', '');
    $('#set-openai-api-key').value = get('openaiApiKey', '');
    $('#set-openai-base-url').value = get('openaiBaseUrl', '');
    $('#set-github-token').value = get('githubToken', '');
    $('#set-github-owner').value = get('githubOwner', '');
    $('#set-github-repo').value = get('githubRepo', '');
    $('#set-github-path').value = get('githubPath', 'sessions');
    $('#set-notion-storage-token').value = get('notionStorageToken', '');
    $('#set-notion-parent-page').value = get('notionParentPageId', '');
    
    // Set provider/model from saved config
    const modelValue = get('model', '');
    const providerValue = get('provider', inferProviderFromModel(modelValue));
    $('#set-provider').value = providerValue;
    $('#set-model').value = get('model', '');
    
    $('#set-enable-search').checked = get('enableSearch', false);
    $('#set-enable-thinking').checked = get('enableThinking', false);
    $('#set-thinking-budget').value = get('thinkingBudget', '');
    $('#set-include-thoughts').checked = get('includeThoughts', false);
    // Soul picker: populate built-in options, then match saved URL.
    await populateSoulPresetSelect();
    const savedSoulUrl = get('soulUrl', '');
    if (!savedSoulUrl) {
      $('#set-soul-preset').value = '';
      $('#set-soul-url').value = '';
    } else {
      // Check if savedSoulUrl matches any built-in option value
      const sel = $('#set-soul-preset');
      const matchedOption = Array.from(sel.options).find(o => o.value === savedSoulUrl);
      if (matchedOption) {
        sel.value = savedSoulUrl;
      } else {
        sel.value = '__custom__';
        $('#set-soul-url').value = savedSoulUrl;
      }
    }
    toggleSoulUrlField();

    $('#set-notion-token').value = get('notionToken', '');
    $('#set-cors-proxy').value = get('corsProxy', 'https://corsproxy.io/?url=');
    $('#set-storage-backend').value = get('storageBackend', 'local');

    // Button label
    const applyBtn = $('#apply-settings');
    if (applyBtn) applyBtn.textContent = isNew ? `✓ ${tl('startSession')}` : tl('settingsSaveApply');

    // Action settings
    $('#set-action-use-storage').checked = get('actionUseStorage', true);
    $('#set-action-token').value = get('actionToken', '');
    $('#set-action-owner').value = get('actionOwner', '');
    $('#set-action-repo').value = get('actionRepo', '');
    $('#set-action-branch').value = get('actionBranch', 'main');
    $('#set-action-workflow').value = get('actionWorkflow', 'execute.yml');
    $('#set-action-dir').value = 'artifact';

    // Upstash settings (optional, for loop agent browser intervention)
    $('#set-upstash-url').value = get('upstashUrl', '');
    $('#set-upstash-token').value = get('upstashToken', '');

    toggleStorageFields();
    toggleThinkingFields();
    toggleActionFields();
    updateProviderSections();
    updatePushooStatusBadge();
  }

  function closeSettings() {
    hide('#settings-panel');
    // If user dismissed settings for a pending new session (never activated), clean up the lingering config
    if (settingsTarget && settingsTarget !== currentSessionId) {
      const inIndex = Storage.getIndex().find(s => s.id === settingsTarget);
      if (!inIndex) removeSessionConfig(settingsTarget);
    }
  }

  async function applySettings() {
    const sessionId = settingsTarget;
    if (!sessionId) return;

    // ── All settings saved to per-session config ──
    const cfg = getSessionConfig(sessionId);

    // Credentials — only store non-empty values so getSessionSetting can
    // fall back to global settings when a session doesn't override a key.
    const credentialInputs = {
      apiKey:             $('#set-api-key').value.trim(),
      qwenApiKey:         $('#set-qwen-api-key').value.trim(),
      kimiApiKey:         $('#set-kimi-api-key').value.trim(),
      openaiApiKey:       $('#set-openai-api-key').value.trim(),
      openaiBaseUrl:      $('#set-openai-base-url').value.trim(),
      githubToken:        $('#set-github-token').value.trim(),
      githubOwner:        $('#set-github-owner').value.trim(),
      githubRepo:         $('#set-github-repo').value.trim(),
      githubPath:         $('#set-github-path').value.trim() || 'sessions',
      notionStorageToken: $('#set-notion-storage-token').value.trim(),
      notionParentPageId: $('#set-notion-parent-page').value.trim(),
      pushooConfig:       getSessionConfig(sessionId)?.pushooConfig || '', // Preserve from previous dialog config
      upstashUrl:         $('#set-upstash-url').value.trim(),
      upstashToken:       $('#set-upstash-token').value.trim(),
    };

    for (const [key, val] of Object.entries(credentialInputs)) {
      if (val) {
        cfg[key] = val;
      } else {
        delete cfg[key]; // remove so getSessionSetting falls back to global
      }
    }

    // Propagate non-empty credentials to global as template for new sessions
    for (const [key, val] of Object.entries(credentialInputs)) {
      if (val) setSetting(key, val);
    }

    // Get provider/model from settings
    const selectedProvider = $('#set-provider').value || inferProviderFromModel($('#set-model').value.trim());
    let selectedModel = $('#set-model').value.trim();
    if (!selectedModel) {
      selectedModel = selectedProvider === 'qwen' ? 'qwen3-max-2026-01-23' : 'gemini-2.5-flash';
    }
    cfg.provider = selectedProvider;
    cfg.model = selectedModel;
    cfg.enableSearch = $('#set-enable-search').checked;
    cfg.enableThinking = $('#set-enable-thinking').checked;
    cfg.thinkingBudget = $('#set-thinking-budget').value.trim();
    cfg.includeThoughts = $('#set-include-thoughts').checked;
    const soulPreset = $('#set-soul-preset').value;
    cfg.soulUrl = soulPreset === '__custom__' ? $('#set-soul-url').value.trim() : soulPreset;
    cfg.notionToken = $('#set-notion-token').value.trim();
    cfg.corsProxy = $('#set-cors-proxy').value.trim();
    cfg.storageBackend = $('#set-storage-backend').value;

    // Action execution settings (per-session)
    cfg.actionUseStorage = $('#set-action-use-storage').checked;
    cfg.actionBranch = $('#set-action-branch').value.trim() || 'main';
    cfg.actionWorkflow = $('#set-action-workflow').value.trim() || 'execute.yml';
    cfg.actionArtifactDir = 'artifact';

    // Action repo credentials — same empty-string handling
    const actionCreds = {
      actionToken: $('#set-action-token').value.trim(),
      actionOwner: $('#set-action-owner').value.trim(),
      actionRepo:  $('#set-action-repo').value.trim(),
    };
    for (const [key, val] of Object.entries(actionCreds)) {
      if (val) { cfg[key] = val; } else { delete cfg[key]; }
    }

    if (!cfg.actionUseStorage) {
      for (const [key, val] of Object.entries(actionCreds)) {
        if (val) setSetting(key, val);
      }

      if (cfg.actionToken || cfg.actionOwner || cfg.actionRepo) {
        if (!cfg.actionToken || !cfg.actionOwner || !cfg.actionRepo) {
          showToast('Action PAT test requires token, owner, and repo.', 'error');
          return;
        }
      }
    }

    // Auto-create action repo if token + owner + repo are all provided but repo doesn't exist
    {
      const aToken = cfg.actionUseStorage ? cfg.githubToken : cfg.actionToken;
      const aOwner = cfg.actionUseStorage ? cfg.githubOwner : cfg.actionOwner;
      const aRepo  = cfg.actionUseStorage ? cfg.githubRepo  : cfg.actionRepo;
      if (aToken && aOwner && aRepo) {
        try {
          const checkResp = await fetch(`https://api.github.com/repos/${aOwner}/${aRepo}`, {
            headers: { Authorization: `token ${aToken}`, Accept: 'application/vnd.github.v3+json' },
          });
          if (checkResp.status === 404) {
            showToast(`Action repo "${aRepo}" not found — creating…`, 'info');
            const createResp = await fetch('https://api.github.com/user/repos', {
              method: 'POST',
              headers: {
                Authorization: `token ${aToken}`,
                Accept: 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                name: aRepo,
                description: '🍤 小虾米 execution environment',
                private: true,
                auto_init: true,
              }),
            });
            if (!createResp.ok) {
              const err = await createResp.json().catch(() => ({}));
              console.warn(`[AutoCreate] Action repo creation failed: ${err.message || createResp.status}`);
            } else {
              showToast(`✅ Created private action repo "${aOwner}/${aRepo}"`, 'success');
            }
          }
        } catch (e) {
          console.warn(`[AutoCreate] Action repo check failed: ${e.message}`);
        }
      }
    }

    // Validate: if GitHub backend selected, required credential fields must be filled
    if (cfg.storageBackend === 'github') {
      const missing = [];
      if (!cfg.githubToken)  missing.push('GitHub Token');
      if (!cfg.githubOwner)  missing.push('Repository Owner');
      if (!cfg.githubRepo)   missing.push('Repository Name');
      if (missing.length) {
        showToast(`GitHub storage requires: ${missing.join(', ')}`, 'error');
        const firstEmpty = !cfg.githubToken ? '#set-github-token'
          : !cfg.githubOwner ? '#set-github-owner' : '#set-github-repo';
        const el = $(firstEmpty);
        if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
        return;
      }

      // Auto-create storage repo if it doesn't exist
      try {
        const checkResp = await fetch(`https://api.github.com/repos/${cfg.githubOwner}/${cfg.githubRepo}`, {
          headers: { Authorization: `token ${cfg.githubToken}`, Accept: 'application/vnd.github.v3+json' },
        });
        if (checkResp.status === 404) {
          showToast(`Repo "${cfg.githubRepo}" not found — creating…`, 'info');
          const createResp = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: {
              Authorization: `token ${cfg.githubToken}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: cfg.githubRepo,
              description: 'Encrypted session storage for 🍤 小虾米',
              private: true,
              auto_init: true,
            }),
          });
          if (!createResp.ok) {
            const err = await createResp.json().catch(() => ({}));
            throw new Error(err.message || `HTTP ${createResp.status}`);
          }
          // Wait for GitHub to finalize the initial commit
          await new Promise(r => setTimeout(r, 1500));
          const sessionsDir = cfg.githubPath || 'sessions';
          await fetch(`https://api.github.com/repos/${cfg.githubOwner}/${cfg.githubRepo}/contents/${sessionsDir}/.gitkeep`, {
            method: 'PUT',
            headers: {
              Authorization: `token ${cfg.githubToken}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ message: 'Initialize sessions directory', content: btoa('') }),
          });
          showToast(`✅ Created private repo "${cfg.githubOwner}/${cfg.githubRepo}"`, 'success');
        } else if (!checkResp.ok) {
          throw new Error(`GitHub API error: ${checkResp.status}`);
        }
      } catch (e) {
        showToast(`Failed to verify/create repo: ${e.message}`, 'error');
        return;
      }
    }

    // Validate: if Notion backend selected, required fields must be filled
    if (cfg.storageBackend === 'notion') {
      const missing = [];
      if (!cfg.notionStorageToken)  missing.push('Notion Token');
      if (!cfg.notionParentPageId)  missing.push('Parent Page ID');
      if (missing.length) {
        showToast(`Notion storage requires: ${missing.join(', ')}`, 'error');
        return;
      }
    }

    // Passphrase: required for new sessions, skip for existing
    const ppVal = $('#set-passphrase')?.value.trim();
    const isNew = !Storage.getIndex().find(s => s.id === sessionId);
    if (isNew && !ppVal) {
      showToast(tl('toastNeedPassphrase'), 'error');
      const el = $('#set-passphrase');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
      return;
    }
    if (ppVal && !cfg.passphrase) {
      cfg.passphrase = ppVal;
    }

    saveSessionConfig(sessionId, cfg);

    // Set passphrase in memory for this session
    if (cfg.passphrase && sessionId === currentSessionId) {
      passphrase = cfg.passphrase;
    }

    // If storage backend changed for an existing session, update the index
    // and trigger an immediate re-save to the new backend
    if (!isNew) {
      const indexEntry = Storage.getIndex().find(s => s.id === sessionId);
      if (indexEntry && indexEntry.backend !== cfg.storageBackend) {
        const oldBackend = indexEntry.backend || 'local';
        indexEntry.backend = cfg.storageBackend;
        const fullIndex = Storage.getIndex().map(s => s.id === sessionId ? indexEntry : s);
        Storage.saveIndex(fullIndex);
        renderSidebar();

        // If this is the active session with messages, re-save to the new backend
        if (sessionId === currentSessionId && Chat.getHistory().length > 0) {
          // Use setTimeout so the settings panel closes first
          setTimeout(() => {
            saveCurrentSession().then(() => {
              showToast(`Session migrated from ${oldBackend} to ${cfg.storageBackend}`, 'success');
              renderSidebar();
            }).catch(err => {
              showToast(`Migration save failed: ${err.message}`, 'error');
            });
          }, 100);
        }
      }
    }

    // Clear settingsTarget before closing so closeSettings() won't
    // mistake this saved-and-about-to-activate session for an abandoned one.
    settingsTarget = null;
    closeSettings();
    showToast(tl('toastSettingsSaved'), 'success');

    if (isNew) {
      // Brand-new session confirmed — now activate it (enables input, shows welcome)
      await activateSession(sessionId, cfg.passphrase);
    } else if (sessionId === currentSessionId) {
      loadSoulAndSkills();
    }
  }

  function toggleSoulUrlField() {
    const preset = $('#set-soul-preset')?.value;
    if (preset === '__custom__') show('#soul-url-field');
    else hide('#soul-url-field');
  }

  function toggleStorageFields() {
    const backend = $('#set-storage-backend').value;
    const githubFields = $('#github-fields');
    const notionFields = $('#notion-storage-fields');
    if (backend === 'github') {
      show(githubFields);
      hide(notionFields);
    } else if (backend === 'notion') {
      hide(githubFields);
      show(notionFields);
    } else {
      hide(githubFields);
      hide(notionFields);
    }
  }

  function updateProviderSections() {
    const provider = $('#set-provider')?.value || 'gemini';
    const geminiFields = $('#gemini-fields');
    const qwenFields = $('#qwen-fields');
    const kimiFields = $('#kimi-fields');
    const openaiFields = $('#openai-fields');
    const modelInput = $('#set-model');
    const currentModel = (modelInput?.value || '').trim().toLowerCase();
    const hasModel = !!currentModel;
    const looksGemini = currentModel.startsWith('gemini-');
    const looksQwen = currentModel.startsWith('qwen') || currentModel.startsWith('qwq-');
    const looksKimi = currentModel.startsWith('kimi-') || currentModel.startsWith('moonshot-');
    const shouldUseProviderDefault = !hasModel ||
      (provider === 'qwen' && !looksQwen) ||
      (provider === 'kimi' && !looksKimi) ||
      (provider === 'gemini' && !looksGemini);

    if (provider === 'qwen') {
      show(qwenFields);
      hide(geminiFields);
      hide(kimiFields);
      hide(openaiFields);
      if (modelInput && shouldUseProviderDefault) {
        modelInput.value = 'qwen3-max-2026-01-23';
      }
    } else if (provider === 'kimi') {
      show(kimiFields);
      hide(geminiFields);
      hide(qwenFields);
      hide(openaiFields);
      if (modelInput && shouldUseProviderDefault) {
        modelInput.value = 'kimi-k2-turbo-preview';
      }
    } else if (provider === 'openai') {
      show(openaiFields);
      hide(geminiFields);
      hide(qwenFields);
      hide(kimiFields);
      if (modelInput && shouldUseProviderDefault) {
        modelInput.value = '';
        modelInput.placeholder = 'e.g., gpt-4o, deepseek-chat, claude-3.5-sonnet';
      }
    } else {
      show(geminiFields);
      hide(qwenFields);
      hide(kimiFields);
      hide(openaiFields);
      if (modelInput && shouldUseProviderDefault) {
        modelInput.value = 'gemini-2.5-flash';
      }
    }

    updateModelDimensionUI();
  }

  function updateModelDimensionUI() {
    const provider = $('#set-provider')?.value || 'gemini';
    const model = $('#set-model')?.value || '';
    const dims = inferModelDimensions(provider, model);

    const searchEl = $('#set-enable-search');
    const thinkEl = $('#set-enable-thinking');
    const capabilityHint = $('#model-capability-hint');

    if (searchEl) {
      searchEl.disabled = !dims.search;
      if (!dims.search) searchEl.checked = false;
    }

    if (thinkEl) {
      thinkEl.disabled = !dims.thinking;
      if (!dims.thinking) thinkEl.checked = false;
    }

    if (capabilityHint) {
      const searchText = dims.search ? tl('supported') : tl('unsupported');
      const thinkText = dims.thinking ? tl('supported') : tl('unsupported');
      capabilityHint.textContent = tl('modelCapabilityFmt')
        .replace('{search}', searchText)
        .replace('{think}', thinkText);
    }

    toggleThinkingFields();
  }


  function toggleThinkingFields() {
    const checked = $('#set-enable-thinking').checked;
    const canUseThinking = !$('#set-enable-thinking').disabled;
    if (checked && canUseThinking) {
      show('#thinking-fields');
    } else {
      hide('#thinking-fields');
    }
  }

  function toggleActionFields() {
    const useStorage = $('#set-action-use-storage')?.checked;
    if (useStorage) {
      hide('#action-custom-repo-fields');
    } else {
      show('#action-custom-repo-fields');
    }
  }

  /**
   * Build the GitHub Actions config object from current session settings.
   * When "use storage repo" is on, reuses the global GitHub storage credentials.
   */
  function getActionConfig() {
    const useStorage = getSessionSetting('actionUseStorage', true);
    let token, owner, repo;
    if (useStorage) {
      token = getSessionSetting('githubToken');
      owner = getSessionSetting('githubOwner');
      repo  = getSessionSetting('githubRepo');
    } else {
      token = getSessionSetting('actionToken');
      owner = getSessionSetting('actionOwner');
      repo  = getSessionSetting('actionRepo');
    }
    if (!token || !owner || !repo) {
      throw new Error('GitHub Actions repository not configured. Open session settings to configure.');
    }
    return {
      token,
      owner,
      repo,
      branch: getSessionSetting('actionBranch', 'main'),
      workflow: getSessionSetting('actionWorkflow', 'execute.yml'),
      artifactDir: 'artifact',
    };
  }

  // ─── Auto-Create GitHub Repo ───────────────────────────────────────

  async function autoCreateGitHubRepo() {
    const token = $('#set-github-token').value.trim();
    if (!token) {
      showToast(tl('toastNeedGithubToken'), 'error');
      return;
    }

    const repoName = $('#set-github-repo').value.trim() || 'browseragent-sessions';
    const sessionsDir = $('#set-github-path').value.trim() || 'sessions';
    const btn = $('#auto-create-repo-btn');
    const originalText = btn.textContent;

    try {
      btn.disabled = true;
      btn.textContent = `⏳ ${tl('btnCreating')}`;

      // 1. Get authenticated user info
      const userResp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
      });
      if (!userResp.ok) throw new Error('Invalid token or network error');
      const user = await userResp.json();
      const owner = user.login;

      // 2. Check if repo already exists
      const checkResp = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
      });

      if (checkResp.status === 200) {
        // Repo exists — just fill in the fields
        $('#set-github-owner').value = owner;
        $('#set-github-repo').value = repoName;
        showToast(`Repo "${repoName}" already exists — fields filled`, 'info');
        return;
      }

      // 3. Create private repo
      const createResp = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: repoName,
          description: 'Encrypted session storage for 🍤 小虾米',
          private: !!$('#set-repo-private')?.checked,
          auto_init: true,  // creates initial commit with README
        }),
      });

      if (!createResp.ok) {
        const err = await createResp.json();
        throw new Error(err.message || `HTTP ${createResp.status}`);
      }

      // 4. Create sessions directory with a .gitkeep
      // Small delay to let GitHub process the initial commit
      await new Promise(r => setTimeout(r, 1500));

      await fetch(`https://api.github.com/repos/${owner}/${repoName}/contents/${sessionsDir}/.gitkeep`, {
        method: 'PUT',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Initialize sessions directory',
          content: btoa(''),  // empty file
        }),
      });

      // 5. Fill in the fields
      $('#set-github-owner').value = owner;
      $('#set-github-repo').value = repoName;
      $('#set-github-path').value = sessionsDir;

      const visibility = $('#set-repo-private')?.checked ? 'private' : 'public';
      showToast(`✅ Created ${visibility} repo "${owner}/${repoName}"`, 'success');
    } catch (err) {
      console.error('Auto-create repo failed:', err);
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ─── Auto-Create Action Repo ───────────────────────────────────────

  async function autoCreateActionRepo() {
    const token = $('#set-action-token').value.trim();
    if (!token) {
      showToast(tl('toastNeedActionGithubToken'), 'error');
      return;
    }
    const repoName = $('#set-action-repo').value.trim() || 'browseragent-exec';
    const isPrivate = !!$('#set-action-repo-private')?.checked;
    const btn = $('#auto-create-action-repo-btn');
    const originalText = btn.textContent;

    try {
      btn.disabled = true;
      btn.textContent = `⏳ ${tl('btnCreating')}`;

      const user = await GitHubActions.getUser(token);
      const owner = user.login;

      const exists = await GitHubActions.repoExists(token, owner, repoName);
      if (exists) {
        $('#set-action-owner').value = owner;
        $('#set-action-repo').value = repoName;
        showToast(`Repo "${repoName}" already exists — fields filled`, 'info');
        return;
      }

      await GitHubActions.createRepo(token, repoName, isPrivate);
      $('#set-action-owner').value = owner;
      $('#set-action-repo').value = repoName;
      const vis = isPrivate ? 'private' : 'public';
      showToast(`✅ Created ${vis} repo "${owner}/${repoName}"`, 'success');
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  // ─── Token Usage Display ───────────────────────────────────────────

  function updateTokenDisplay() {
    const usage = Chat.getTokenUsage();
    const el = $('#token-count');
    if (!el) return;

    const total = usage.totalTokens;
    let display;
    if (total >= 1000000) {
      display = (total / 1000000).toFixed(1) + 'M';
    } else if (total >= 1000) {
      display = (total / 1000).toFixed(1) + 'K';
    } else {
      display = String(total);
    }
    el.textContent = display + ' tokens';

    // Show/hide based on whether session is active
    const container = $('#token-display');
    if (container) {
      if (currentSessionId) {
        container.classList.remove('hidden');
      } else {
        container.classList.add('hidden');
      }
      container.title = [
        `Total: ${usage.totalTokens.toLocaleString()} tokens`,
        `Prompt: ${usage.promptTokens.toLocaleString()}`,
        `Output: ${usage.candidatesTokens.toLocaleString()}`,
        usage.thoughtsTokens ? `Thoughts: ${usage.thoughtsTokens.toLocaleString()}` : '',
        `Requests: ${usage.requestCount}`,
      ].filter(Boolean).join('\n');
    }
  }

  // ─── Grounding Sources Rendering ───────────────────────────────────

  function renderGroundingSources(grounding) {
    if (!grounding) return;

    const chunks = grounding.groundingChunks || [];
    const webChunks = chunks.filter(c => c.web);
    if (webChunks.length === 0) return;

    const chatBox = $('#chat-box');
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'grounding-sources';

    const header = document.createElement('div');
    header.className = 'grounding-header';
    header.textContent = `🔍 ${tl('sourcesTitle')}`;
    sourcesDiv.appendChild(header);

    const list = document.createElement('div');
    list.className = 'grounding-list';

    for (const chunk of webChunks) {
      const link = document.createElement('a');
      link.className = 'grounding-link';
      link.href = chunk.web.uri;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = chunk.web.title || chunk.web.uri;
      list.appendChild(link);
    }

    sourcesDiv.appendChild(list);

    // Append search queries if available
    if (grounding.webSearchQueries?.length > 0) {
      const queries = document.createElement('div');
      queries.className = 'grounding-queries';
      queries.textContent = `${tl('sourcesSearched')}: ` + grounding.webSearchQueries.join(', ');
      sourcesDiv.appendChild(queries);
    }

    chatBox.appendChild(sourcesDiv);
    scrollToBottom();
  }

  // ─── Deploy Bundle Detection & Rendering ──────────────────────────

  /**
   * Parse DEPLOY_BUNDLE markers from raw AI response text.
   * Legacy: kept for backward compatibility with older skill-generated responses.
   */
  function parseDeployBundles(rawText) {
    const bundles = [];
    const bundleRegex = /<!--DEPLOY_BUNDLE:(.*?)-->([\s\S]*?)<!--\/DEPLOY_BUNDLE-->/g;
    let match;

    while ((match = bundleRegex.exec(rawText)) !== null) {
      try {
        const meta = JSON.parse(match[1]);
        const bundleContent = match[2];

        // Extract code blocks within this bundle
        const codeRegex = /```(\w+)?(?::([^\n]+))?\n([\s\S]*?)```/g;
        const artifacts = [];
        let codeMatch;

        while ((codeMatch = codeRegex.exec(bundleContent)) !== null) {
          const language = (codeMatch[1] || 'text').toLowerCase();
          const filename = codeMatch[2]?.trim() || `artifact_${artifacts.length + 1}.txt`;
          const code = codeMatch[3].trimEnd();
          artifacts.push({ language, filename, code });
        }

        if (artifacts.length > 0) {
          bundles.push({ meta, artifacts, raw: match[0] });
        }
      } catch (e) {
        console.warn('Failed to parse DEPLOY_BUNDLE meta:', e);
      }
    }
    return bundles;
  }

  /**
   * Check if raw text contains DEPLOY_BUNDLE markers.
   * Legacy: kept for backward compatibility.
   */
  function hasDeployBundle(rawText) {
    return /<!--DEPLOY_BUNDLE:/.test(rawText);
  }

  /**
   * Render a compact deploy card for a DEPLOY_BUNDLE.
   * Legacy: kept for backward compatibility with older skill-generated responses.
   */
  function renderDeployBundleCard(bubble, rawText) {
    const bundles = parseDeployBundles(rawText);
    if (bundles.length === 0) return false;

    // Extract any text BEFORE the first bundle (the ✅ summary line)
    const firstBundleIdx = rawText.indexOf('<!--DEPLOY_BUNDLE:');
    const preText = rawText.substring(0, firstBundleIdx).trim();

    // Clear the bubble and rebuild with compact UI
    bubble.innerHTML = '';

    // Render the short pre-text (e.g. "✅ 已配置每日AI新闻摘要任务。")
    if (preText) {
      const intro = document.createElement('div');
      intro.className = 'deploy-bundle-intro';
      intro.innerHTML = renderMarkdown(preText);
      bubble.appendChild(intro);
    }

    for (const bundle of bundles) {
      const card = document.createElement('div');
      card.className = 'deploy-bundle-card';

      // Card header with meta info
      const header = document.createElement('div');
      header.className = 'deploy-bundle-header';
      header.innerHTML = `
        <div class="deploy-bundle-title">
          <span class="deploy-bundle-icon">📦</span>
          <span class="deploy-bundle-name">${escapeHtml(bundle.meta.name || 'Deploy Bundle')}</span>
        </div>
        <div class="deploy-bundle-meta">
          ${bundle.meta.scheduleText ? `<span class="deploy-bundle-schedule">🕐 ${escapeHtml(bundle.meta.scheduleText)}</span>` : ''}
          ${bundle.meta.description ? `<span class="deploy-bundle-desc">${escapeHtml(bundle.meta.description)}</span>` : ''}
        </div>
      `;
      card.appendChild(header);

      // File list
      const fileList = document.createElement('div');
      fileList.className = 'deploy-bundle-files';

      for (const artifact of bundle.artifacts) {
        const isWorkflow = artifact.filename.startsWith('.github/workflows/');
        const fileItem = document.createElement('div');
        fileItem.className = 'deploy-bundle-file';

        const fileIcon = isWorkflow ? '⚙️' : '📄';
        const fileInfo = document.createElement('div');
        fileInfo.className = 'deploy-bundle-file-info';
        fileInfo.innerHTML = `<span class="deploy-bundle-file-icon">${fileIcon}</span><span class="deploy-bundle-file-name">${escapeHtml(artifact.filename)}</span>`;

        const fileActions = document.createElement('div');
        fileActions.className = 'deploy-bundle-file-actions';

        // Toggle code view button
        const viewBtn = document.createElement('button');
        viewBtn.className = 'deploy-bundle-file-btn';
        viewBtn.textContent = `👁 ${tl('btnView')}`;
        viewBtn.title = 'Toggle code view';

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'deploy-bundle-file-btn';
        copyBtn.textContent = '📋';
        copyBtn.title = 'Copy code';
        copyBtn.onclick = () => {
          navigator.clipboard.writeText(artifact.code);
          copyBtn.textContent = '✓';
          setTimeout(() => (copyBtn.textContent = '📋'), 1500);
        };

        fileActions.appendChild(viewBtn);
        fileActions.appendChild(copyBtn);

        fileItem.appendChild(fileInfo);
        fileItem.appendChild(fileActions);
        fileList.appendChild(fileItem);

        // Collapsible code block (hidden by default)
        const codeContainer = document.createElement('div');
        codeContainer.className = 'deploy-bundle-code hidden';
        const pre = document.createElement('pre');
        const codeEl = document.createElement('code');
        codeEl.className = `language-${artifact.language}`;
        codeEl.textContent = artifact.code;
        pre.appendChild(codeEl);
        codeContainer.appendChild(pre);
        fileList.appendChild(codeContainer);

        // Highlight
        if (artifact.language && hljs.getLanguage(artifact.language)) {
          try {
            codeEl.innerHTML = hljs.highlight(artifact.code, { language: artifact.language }).value;
          } catch {}
        }

        // Toggle handler
        viewBtn.onclick = () => {
          const isHidden = codeContainer.classList.contains('hidden');
          codeContainer.classList.toggle('hidden');
          viewBtn.textContent = isHidden ? '🔽 Hide' : '👁 View';
        };
      }

      card.appendChild(fileList);

      // Deploy All button
      const deployAllBtn = document.createElement('button');
      deployAllBtn.className = 'deploy-bundle-deploy-btn';
      deployAllBtn.innerHTML = '🚀 Deploy All';
      deployAllBtn.onclick = () => handleDeployBundle(bundle, card);
      card.appendChild(deployAllBtn);

      bubble.appendChild(card);
    }

    return true;
  }

  /**
   * Handle deploying all files in a bundle at once.
   */
  async function handleDeployBundle(bundle, cardEl) {
    let config;
    try {
      config = getActionConfig();
    } catch (e) {
      showToast(e.message, 'error');
      return;
    }

    const statusCard = createStatusCard(cardEl);

    // Collect non-workflow script filenames for path fixing
    const scriptFilenames = bundle.artifacts
      .filter(a => !a.filename.startsWith('.github/'))
      .map(a => a.filename);

    // Prepare all files — fix workflow YAML that references bare script names
    const files = bundle.artifacts.map(artifact => {
      const isWorkflow = artifact.filename.startsWith('.github/');
      let content = artifact.code;

      // Auto-fix: ensure workflow YAML references scripts with artifact/ prefix
      if (isWorkflow && scriptFilenames.length > 0) {
        const escapedArtifactDir = config.artifactDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const scriptName of scriptFilenames) {
          // Match bare script name NOT already prefixed with artifact/
          // Handles patterns like: python3 script.py, python "script.py", node script.js
          const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp(`(?<!${escapedArtifactDir}/)(?<![\\w/])${escaped}`, 'g');
          content = content.replace(re, `${config.artifactDir}/${scriptName}`);
        }
      }

      return {
        path: isWorkflow ? artifact.filename : `${config.artifactDir}/${artifact.filename}`,
        content,
      };
    });

    const fileNames = bundle.artifacts.map(a => a.filename).join(', ');

    try {
      // Step 1: Push all files in a single atomic commit
      updateStatusCard(statusCard, 'in_progress', `Pushing ${files.length} files…`);
      await GitHubActions.pushFiles(
        config,
        files,
        `Deploy bundle "${bundle.meta.name}" from 🍤 小虾米`
      );

      // Check if any file is NOT a workflow (needs execution)
      const hasWorkflow = bundle.artifacts.some(a => a.filename.startsWith('.github/workflows/'));
      const nonWorkflowArtifacts = bundle.artifacts.filter(a => !a.filename.startsWith('.github/workflows/'));

      if (nonWorkflowArtifacts.length > 0 && !hasWorkflow) {
        // One-time script execution: push script and dispatch via generic execute.yml.
        // For scheduled/cron tasks, use the /schedule command instead.
        updateStatusCard(statusCard, 'in_progress', 'Checking workflow…');
        await GitHubActions.ensureWorkflow(config, `.github/workflows/${config.workflow}`);

        const firstScript = nonWorkflowArtifacts[0];
        const filePath = `${config.artifactDir}/${firstScript.filename}`;
        const runtime = GitHubActions.detectRuntime(firstScript.language);

        updateStatusCard(statusCard, 'in_progress', 'Triggering workflow…');
        const dispatchTs = Date.now();
        await GitHubActions.dispatchWorkflow(config, config.workflow, {
          entrypoint: filePath,
          language: runtime,
        });

        // Poll for run
        updateStatusCard(statusCard, 'queued', 'Waiting for workflow run…');
        let run = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          await new Promise((r) => setTimeout(r, 1200));
          const recentRuns = await GitHubActions.listRecentRuns(config, null, 10);
          run = recentRuns.find(r => {
            if (!r) return false;
            const createdAt = new Date(r.created_at || 0).getTime();
            const workflowPath = String(r.path || '');
            return createdAt >= (dispatchTs - 10000) && workflowPath.includes(config.workflow);
          }) || null;
          if (run) break;
        }

        if (run) {
          const runUrl = run.html_url;
          updateStatusCard(statusCard, 'in_progress', 'Running…', runUrl);
          const finalRun = await GitHubActions.pollRun(config, run.id, (r) => {
            const label = r.status === 'in_progress' ? 'Running…' : r.status === 'queued' ? 'Queued…' : r.status;
            updateStatusCard(statusCard, r.status, label, runUrl);
          }, 2000);

          try {
            const jobs = await GitHubActions.getRunJobs(config, finalRun.id);
            const job = jobs.jobs?.[0];
            if (job) {
              const rawLogs = await GitHubActions.getJobLogs(config, job.id);
              const { output, exitCode } = GitHubActions.parseLogOutput(rawLogs);
              const statusLabel = finalRun.conclusion === 'success'
                ? 'Completed (exit 0)' : `Failed (exit ${exitCode ?? '?'})`;
              updateStatusCard(statusCard, finalRun.conclusion, statusLabel, runUrl, output || '(no output)');
            } else {
              updateStatusCard(statusCard, finalRun.conclusion,
                finalRun.conclusion === 'success' ? 'Completed' : `Failed (${finalRun.conclusion})`,
                runUrl
              );
            }
          } catch (logErr) {
            console.warn('Could not fetch logs:', logErr);
            updateStatusCard(statusCard, finalRun.conclusion,
              finalRun.conclusion === 'success' ? 'Completed' : `Done (${finalRun.conclusion})`,
              runUrl
            );
          }
        } else {
          updateStatusCard(statusCard, 'failure',
            'Could not find workflow run. Check the Actions tab.',
            `https://github.com/${config.owner}/${config.repo}/actions`
          );
        }
      } else {
        // All files deployed (workflow files auto-activate, scripts pushed)
        const repoUrl = `https://github.com/${config.owner}/${config.repo}`;
        const scheduleInfo = bundle.meta.scheduleText ? ` — scheduled ${bundle.meta.scheduleText}` : '';
        updateStatusCard(statusCard, 'success',
          `All ${files.length} files deployed${scheduleInfo}`,
          `${repoUrl}/actions`
        );

        // Auto-sync secrets & variables to the repo
        try {
          updateStatusCard(statusCard, 'in_progress',
            `Syncing secrets & variables…`,
            `${repoUrl}/actions`
          );

          const settings = {
            geminiApiKey: getSessionSetting('apiKey'),
          };

          // Add Pushoo multi-channel configuration
          const pc = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
          if (pc.channels.length > 0) {
            settings.PUSHOO_CHANNELS = JSON.stringify(pc.channels);
          }

          const result = await GitHubActions.syncSecretsAndVars(config, settings);

          // Build summary
          const parts = [];
          if (result.synced.length > 0) parts.push(`✅ ${result.synced.join(', ')}`);
          if (result.skipped.length > 0) parts.push(`⏭ skipped: ${result.skipped.join(', ')}`);
          if (result.errors.length > 0) parts.push(`❌ ${result.errors.join('; ')}`);

          const hasErrors = result.errors.length > 0;
          const allDeployedMsg = `All ${files.length} files deployed${scheduleInfo}`;

          updateStatusCard(statusCard,
            hasErrors ? 'failure' : 'success',
            allDeployedMsg,
            `${repoUrl}/actions`
          );

          // Show secrets sync result
          const secretsHint = document.createElement('div');
          secretsHint.className = 'deploy-bundle-secrets-hint';
          secretsHint.innerHTML = `
            <span class="deploy-bundle-secrets-icon">🔑</span>
            <span>${parts.join(' · ')}</span>
          `;
          cardEl.appendChild(secretsHint);

          if (result.skipped.length > 0) {
            const missingHint = document.createElement('div');
            missingHint.className = 'deploy-bundle-secrets-hint';
            missingHint.innerHTML = `
              <span class="deploy-bundle-secrets-icon">⚠️</span>
              <span>Skipped keys are not configured in 🍤 小虾米 settings. <a href="${repoUrl}/settings/secrets/actions" target="_blank" rel="noopener">Add manually</a> or configure in Settings first.</span>
            `;
            cardEl.appendChild(missingHint);
          }
        } catch (secretsErr) {
          console.warn('Secrets sync failed:', secretsErr);
          // Still show success for file deploy, but warn about secrets
          const secretsHint = document.createElement('div');
          secretsHint.className = 'deploy-bundle-secrets-hint';
          secretsHint.innerHTML = `
            <span class="deploy-bundle-secrets-icon">⚠️</span>
            <span>Files deployed, but secrets sync failed: ${escapeHtml(secretsErr.message)}. <a href="${repoUrl}/settings/secrets/actions" target="_blank" rel="noopener">Add secrets manually</a></span>
          `;
          cardEl.appendChild(secretsHint);
        }
      }

      showToast(`Deployed ${fileNames}`, 'success');
    } catch (err) {
      updateStatusCard(statusCard, 'failure', `Deploy failed: ${err.message}`);
      showToast(`Deploy failed: ${err.message}`, 'error');
    }
  }

  // ─── Artifact Toolbars on Code Blocks ────────────────────────────

  /**
   * Post-process a rendered message bubble to add action toolbars
   * (Copy / Push / Push & Run) on every code block.
   */
  function addCodeBlockToolbars(bubble, rawText) {
    if (typeof GitHubActions === 'undefined') return;
    const artifacts = GitHubActions.extractArtifacts(rawText);
    if (artifacts.length === 0) return;

    const preBlocks = bubble.querySelectorAll('pre');
    preBlocks.forEach((pre, idx) => {
      if (idx >= artifacts.length) return;
      const artifact = artifacts[idx];
      const isWorkflow = artifact.filename.startsWith('.github/workflows/');

      // Toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'code-toolbar';

      const fileLabel = document.createElement('span');
      fileLabel.className = 'code-filename';
      fileLabel.textContent = artifact.filename;
      toolbar.appendChild(fileLabel);

      const actions = document.createElement('div');
      actions.className = 'code-toolbar-actions';

      // Copy
      const copyBtn = document.createElement('button');
      copyBtn.className = 'code-toolbar-btn';
      copyBtn.textContent = '📋';
      copyBtn.title = 'Copy code';
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(artifact.code);
        copyBtn.textContent = '✓';
        setTimeout(() => (copyBtn.textContent = '📋'), 1500);
      };
      actions.appendChild(copyBtn);

      // Push
      const pushBtn = document.createElement('button');
      pushBtn.className = 'code-toolbar-btn';
      pushBtn.textContent = `↑ ${tl('btnPush')}`;
      pushBtn.title = 'Push to GitHub';
      pushBtn.onclick = () => handlePushArtifact(artifact, pre);
      actions.appendChild(pushBtn);

      // Push & Run / Deploy
      const runBtn = document.createElement('button');
      runBtn.className = 'code-toolbar-btn code-toolbar-btn-primary';
      runBtn.textContent = isWorkflow ? '📦 Deploy' : '▶ Run';
      runBtn.title = isWorkflow
        ? 'Push workflow file to .github/workflows/'
        : 'Push & trigger GitHub Actions workflow';
      runBtn.onclick = () => handlePushAndRun(artifact, pre);
      actions.appendChild(runBtn);

      toolbar.appendChild(actions);

      // Wrap <pre> in container
      const container = document.createElement('div');
      container.className = 'code-block-container';
      pre.parentNode.insertBefore(container, pre);
      container.appendChild(toolbar);
      container.appendChild(pre);

      // If code is inside a <details>, add a prominent Execute button outside
      const details = container.closest('details');
      if (details) {
        const existingBtn = details.parentElement.querySelector('.quick-exec-btn');
        if (!existingBtn) {
          const quickBtn = document.createElement('button');
          quickBtn.className = 'quick-exec-btn';
          quickBtn.innerHTML = isWorkflow
            ? '📦 Deploy Workflow'
            : '⚡ Execute';
          quickBtn.onclick = () => handlePushAndRun(artifact, pre);
          details.parentElement.insertBefore(quickBtn, details.nextSibling);
        }
      }
    });
  }

  // ─── Execution Status Card ─────────────────────────────────────────

  function createStatusCard(parentEl) {
    const card = document.createElement('div');
    card.className = 'exec-status-card';
    card.innerHTML = `
      <div class="exec-status-header">
        <span class="exec-status-icon">⏳</span>
        <span class="exec-status-text">Preparing…</span>
        <a class="exec-status-link hidden" href="#" target="_blank" rel="noopener">View on GitHub ↗</a>
      </div>
      <div class="exec-status-log hidden">
        <pre class="exec-log-content"></pre>
      </div>
    `;
    parentEl.appendChild(card);
    scrollToBottom();
    return card;
  }

  function updateStatusCard(card, status, text, url, logContent) {
    const icons = {
      queued: '⏳', in_progress: '🔄', completed: '✅',
      success: '✅', failure: '❌', cancelled: '⚠️',
    };
    card.querySelector('.exec-status-icon').textContent = icons[status] || '⏳';
    card.querySelector('.exec-status-text').textContent = text;
    if (url) {
      const link = card.querySelector('.exec-status-link');
      link.href = url;
      link.classList.remove('hidden');
    }
    if (logContent != null) {
      const logDiv = card.querySelector('.exec-status-log');
      logDiv.classList.remove('hidden');
      card.querySelector('.exec-log-content').textContent = logContent;
    }
    scrollToBottom();
  }

  // ─── Push & Run Handlers ───────────────────────────────────────────

  async function handlePushArtifact(artifact, preElement) {
    let config;
    try { config = getActionConfig(); } catch (e) {
      showToast(e.message, 'error');
      return;
    }

    const details = preElement.closest('details');
    const container = details
      ? (details.closest('.message-bubble') || details.parentElement)
      : (preElement.closest('.code-block-container') || preElement.parentElement);
    const card = createStatusCard(container);
    // Files starting with .github/ go to repo root; others go under artifactDir
    const filePath = artifact.filename.startsWith('.github/')
      ? artifact.filename
      : `${config.artifactDir}/${artifact.filename}`;

    try {
      updateStatusCard(card, 'in_progress', `Pushing ${artifact.filename}…`);
      await GitHubActions.pushFiles(config,
        [{ path: filePath, content: artifact.code }],
        `Push ${artifact.filename} from 🍤 小虾米`
      );
      const fileUrl = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${filePath}`;
      updateStatusCard(card, 'success', `Pushed to ${filePath}`, fileUrl);
      showToast(`Pushed ${artifact.filename}`, 'success');
    } catch (err) {
      updateStatusCard(card, 'failure', `Push failed: ${err.message}`);
      showToast(`Push failed: ${err.message}`, 'error');
    }
  }

  async function handlePushAndRun(artifact, preElement) {
    let config;
    try { config = getActionConfig(); } catch (e) {
      showToast(e.message, 'error');
      return;
    }

    // Place status card at visible level — if code is inside <details>, put card outside it
    const details = preElement.closest('details');
    const container = details
      ? (details.closest('.message-bubble') || details.parentElement)
      : (preElement.closest('.code-block-container') || preElement.parentElement);
    const card = createStatusCard(container);
    // Files starting with .github/ go to repo root; others go under artifactDir
    const filePath = artifact.filename.startsWith('.github/')
      ? artifact.filename
      : `${config.artifactDir}/${artifact.filename}`;
    const runtime = GitHubActions.detectRuntime(artifact.language);

    // Workflow YAML files → deploy only (push to .github/workflows/, no dispatch)
    const isWorkflowFile = filePath.startsWith('.github/workflows/');
    if (isWorkflowFile) {
      try {
        updateStatusCard(card, 'in_progress', `Deploying workflow ${artifact.filename}…`);
        await GitHubActions.pushFiles(config,
          [{ path: filePath, content: artifact.code }],
          `Deploy workflow ${artifact.filename} from 🍤 小虾米`
        );
        const fileUrl = `https://github.com/${config.owner}/${config.repo}/blob/${config.branch}/${filePath}`;
        updateStatusCard(card, 'success', `Workflow deployed → ${filePath}`, fileUrl);
        showToast(`Deployed ${artifact.filename}`, 'success');
      } catch (err) {
        updateStatusCard(card, 'failure', `Deploy failed: ${err.message}`);
        showToast(`Deploy failed: ${err.message}`, 'error');
      }
      return;
    }

    try {
      // 1. Ensure execute workflow
      updateStatusCard(card, 'in_progress', 'Checking workflow…');
      await GitHubActions.ensureWorkflow(config, `.github/workflows/${config.workflow}`);

      // 2. Push artifact
      updateStatusCard(card, 'in_progress', `Pushing ${artifact.filename}…`);
      await GitHubActions.pushFiles(config,
        [{ path: filePath, content: artifact.code }],
        `Push ${artifact.filename} from 🍤 小虾米`
      );

      // 3. Dispatch workflow
      updateStatusCard(card, 'in_progress', 'Triggering workflow…');
      const dispatchTs = Date.now();
      await GitHubActions.dispatchWorkflow(config, config.workflow, {
        entrypoint: filePath,
        language: runtime,
      });

      // 4. Find the triggered run (with retries)
      updateStatusCard(card, 'queued', 'Waiting for workflow run…');
      let run = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 1200));
        const recentRuns = await GitHubActions.listRecentRuns(config, null, 10);
        run = recentRuns.find(r => {
          if (!r) return false;
          const createdAt = new Date(r.created_at || 0).getTime();
          const workflowPath = String(r.path || '');
          return createdAt >= (dispatchTs - 10000) && workflowPath.includes(config.workflow);
        }) || null;
        if (run) break;
      }

      if (!run) {
        updateStatusCard(card, 'failure',
          'Could not find workflow run. Check the Actions tab on GitHub.',
          `https://github.com/${config.owner}/${config.repo}/actions`
        );
        return;
      }

      // 5. Poll for completion
      const runUrl = run.html_url;
      updateStatusCard(card, 'in_progress', 'Running…', runUrl);

      const finalRun = await GitHubActions.pollRun(config, run.id, (r) => {
        const label = r.status === 'in_progress' ? 'Running…' : r.status === 'queued' ? 'Queued…' : r.status;
        updateStatusCard(card, r.status, label, runUrl);
      }, 2000);

      // 6. Fetch & parse logs
      try {
        const jobs = await GitHubActions.getRunJobs(config, finalRun.id);
        const job = jobs.jobs?.[0];
        if (job) {
          const rawLogs = await GitHubActions.getJobLogs(config, job.id);
          const { output, exitCode } = GitHubActions.parseLogOutput(rawLogs);
          const statusLabel = finalRun.conclusion === 'success'
            ? `Completed (exit 0)` : `Failed (exit ${exitCode ?? '?'})`;
          updateStatusCard(card, finalRun.conclusion, statusLabel, runUrl, output || '(no output)');
        } else {
          updateStatusCard(card, finalRun.conclusion,
            finalRun.conclusion === 'success' ? 'Completed' : `Failed (${finalRun.conclusion})`,
            runUrl
          );
        }
      } catch (logErr) {
        console.warn('Could not fetch logs:', logErr);
        updateStatusCard(card, finalRun.conclusion,
          finalRun.conclusion === 'success' ? 'Completed' : `Done (${finalRun.conclusion})`,
          runUrl
        );
      }
    } catch (err) {
      updateStatusCard(card, 'failure', `Error: ${err.message}`);
      showToast(`Push & Run failed: ${err.message}`, 'error');
    }
  }

  // ─── SOUL + Skills Loading ────────────────────────────────────────

  /**
   * Build a context block describing current user settings so the AI model
   * can reference them (e.g. auto-fill model name, know which keys exist).
   * Actual key values are NOT exposed — only whether they are configured.
   */
  function buildSessionContext() {
    const model = getSessionSetting('model');
    const hasGeminiKey = !!getSessionSetting('apiKey');
    const hasGithubToken = !!getSessionSetting('githubToken');
    const useStorage = getSessionSetting('actionUseStorage', true);
    const actionOwner = useStorage ? getSessionSetting('githubOwner') : getSessionSetting('actionOwner');
    const actionRepo = useStorage ? getSessionSetting('githubRepo') : getSessionSetting('actionRepo');
    const hasResendKey = false; // Resend removed — use pushoo channels
    const pushooChannels = PushooNotifier.parseConfig(getSessionSetting('pushooConfig'));
    const channelSummary = PushooNotifier.getChannelSummary(pushooChannels);

    const lines = [
      '## 📋 Current Session Context',
      '',
      'This is automatically injected — use these values when generating code or workflows.',
      '',
      `- **Current AI Model**: \`${model}\``,
      `- **Gemini API Key**: ${hasGeminiKey ? '✅ configured' : '❌ not set'}`,
      `- **GitHub Token**: ${hasGithubToken ? '✅ configured' : '❌ not set'}`,
    ];

    if (actionOwner) lines.push(`- **GitHub Owner**: \`${actionOwner}\``);
    if (actionRepo) lines.push(`- **GitHub Actions Repo**: \`${actionRepo}\``);

    lines.push(`- **Notification Channels**: ${channelSummary || '❌ not configured'}`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## ⛔ MANDATORY RULES — YOU MUST FOLLOW THESE');
    lines.push('');
    lines.push('### Rule 1: Never Generate Content Directly When Notification Delivery Is Requested');
    lines.push('');
    lines.push('When the user asks you to do something AND send/notify the result:');
    lines.push('- ❌ WRONG: Generate the content in your chat response, then ask "should I send a notification?"');
    lines.push('- ❌ WRONG: Show the content in chat and say "I need your notification config"');
    lines.push('- ❌ WRONG: Produce content as text and offer to "set up automation later"');
    lines.push('- ✅ CORRECT: Generate a **Python script** that does the work AND sends the notification. The user can then use ▶ Run to execute it or /schedule to make it recurring.');
    lines.push('');
    lines.push('The content must be generated BY THE SCRIPT AT RUNTIME on GitHub Actions — not by you in the chat.');
    lines.push('');
    lines.push('### Rule 2: Use the Session Values Above');
    lines.push('- Use the model name above in generated scripts (do not ask the user which model).');
    lines.push('- If a key is marked ✅, reference it as a GitHub Actions secret (e.g. `${{ secrets.GEMINI_API_KEY }}`) — do not ask the user to provide the value again.');
    lines.push('- Secrets (GEMINI_API_KEY, PUSHOO_CHANNELS) are **automatically synced** to the GitHub repo when the user clicks Deploy. Do NOT tell the user to manually add secrets or variables.');
    lines.push('- If notification channels are configured above, use PUSHOO_CHANNELS secret in workflow scripts for multi-channel notification.');
    lines.push('- If a key is marked ❌, tell the user they need to configure it first in 🍤 小虾米 settings.');
    lines.push('');
    lines.push('### Rule 3: Scheduling Is Handled by the /schedule Command');
    lines.push('');
    lines.push('When a user asks to schedule a recurring task (cron job, daily task, etc.):');
    lines.push('- Do NOT generate workflow YAML files yourself.');
    lines.push('- Instead, generate the **script** only (the code that does the work).');
    lines.push('- Tell the user to run `/schedule` to set up the cron schedule.');
    lines.push('- The /schedule command will programmatically create the workflow, configure notifications, and deploy.');
    lines.push('');
    lines.push('### Rule 4: Single-file Tasks Use Collapsed Format');
    lines.push('');
    lines.push('For single executable scripts (not scheduled), use the collapsed details pattern:');
    lines.push('');
    lines.push('```');
    lines.push('✅ [1 sentence: what this does]');
    lines.push('');
    lines.push('<details>');
    lines.push('<summary>📄 View script details</summary>');
    lines.push('');
    lines.push('```python:descriptive-filename.py');
    lines.push('# the actual script');
    lines.push('```');
    lines.push('');
    lines.push('</details>');
    lines.push('```');
    lines.push('');
    lines.push('The fenced code block MUST have a filename (e.g. `python:my-task.py`). Without a filename, the Execute button will not appear.');
    lines.push('The UI automatically adds an ⚡ Execute button outside the `<details>`. The user clicks it once to deploy and run.');

    return lines.join('\n');
  }

  async function loadSoulAndSkills() {
    const soulUrl = getSessionSetting('soulUrl');

    if (!soulUrl) {
      soulOnlyInstruction = '';
      currentSoulName = '';
      applySkillsToInstruction();
      await restoreSessionSkills();
      return;
    }

    try {
      showToast(tl('toastLoadingSoul'), 'info');

      const result = await SoulLoader.load({
        soulUrl,
        skillUrls: [], // Skills are managed at runtime via /skills
        notionToken: getSessionSetting('notionToken'),
        corsProxy: getSessionSetting('corsProxy'),
      });

      soulOnlyInstruction = result.systemInstruction; // SOUL text only (no skills yet)
      currentSoulName = result.soulName;
      applySkillsToInstruction(); // Compose final instruction with any already-loaded skills
      await restoreSessionSkills(); // Restore skills saved for this session

      showToast(`Loaded: ${currentSoulName} + ${loadedSkillCount} skill(s)`, 'success');
    } catch (err) {
      console.error('SOUL loading failed:', err);
      showToast(`SOUL loading failed: ${err.message}`, 'error');
      await restoreSessionSkills(); // Still try to restore skills even if SOUL failed
    }
  }

  /**
   * Rebuild & push the full system instruction.
   * LAYER 1: Only injects a compact skill menu (name + description).
   * Full skill bodies are injected per-request in resolveActiveSkill().
   */
  function applySkillsToInstruction() {
    const parts = [soulOnlyInstruction];

    if (loadedSkills.length > 0) {
      const menu = loadedSkills
        .map(s => `- **${s.meta?.name || 'Unnamed'}**: ${s.meta?.description || ''}`)
        .join('\n');
      parts.push(
        `=== AVAILABLE SKILLS ===\n\nYou have the following skills available. When a user request clearly matches one, reply FIRST with a single line:\n[[SKILL: <exact skill name>]]\nthen continue your response. Do NOT output this line if no skill is needed.\n\n${menu}`
      );
    }

    const ctx = buildSessionContext();
    baseSoulInstruction = parts.filter(Boolean).join('\n\n---\n\n');
    Chat.setSystemInstruction(baseSoulInstruction + (ctx ? '\n\n' + ctx : ''));
    loadedSkillCount = loadedSkills.length;
    updateSoulStatus();
  }

  /**
   * LAYER 2: Intercept a [[SKILL: Name]] signal in the first chunk of the model response.
   * If detected, transparently re-issue the request with the full skill body injected.
   * Returns { override: string|null } — the augmented system instruction to use, or null.
   */
  async function resolveSkillOverride(userText, apiKey, _model) {
    if (!loadedSkills.length) return null;

    // Skip preflight for very short / trivial messages
    if (userText.length < 6) return null;

    // Always use a fast, stable model for preflight — never the user's (possibly slow/broken) model
    const PREFLIGHT_MODEL = 'gemini-2.0-flash-lite';

    // Preflight: lightweight non-streaming call to detect which skill is needed
    const menu = loadedSkills
      .map(s => `- ${s.meta?.name || 'Unnamed'}: ${s.meta?.description || ''}`)
      .join('\n');

    const preflightPrompt = `You have these skills available:\n${menu}\n\nUser message: "${userText}"\n\nWhich skill (if any) is needed to best answer this? Reply with ONLY the exact skill name from the list above, or the single word none. No other text.`;

    // 5-second timeout to avoid indefinite hangs
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);

    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${PREFLIGHT_MODEL}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: preflightPrompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 32 },
          }),
          signal: ac.signal,
        }
      );
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = await resp.json();
      const pick = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'none';

      if (!pick || pick.toLowerCase() === 'none') return null;

      // Match back to a loaded skill (case-insensitive)
      const matched = loadedSkills.find(
        s => s.meta?.name?.toLowerCase() === pick.toLowerCase()
      );
      if (!matched) return null;

      // Build override: SOUL + full skill body + any other loaded skill metadata + context
      const menuOthers = loadedSkills
        .filter(s => s !== matched)
        .map(s => `- **${s.meta?.name}**: ${s.meta?.description || ''}`)
        .join('\n');

      const overrideParts = [soulOnlyInstruction];
      if (menuOthers) {
        overrideParts.push(`=== OTHER AVAILABLE SKILLS ===\n\n${menuOthers}`);
      }
      overrideParts.push(
        `=== ACTIVE SKILL: ${matched.meta?.name || 'Unnamed'} ===\n\n${matched.content}`
      );
      const ctx = buildSessionContext();
      const override = overrideParts.filter(Boolean).join('\n\n---\n\n') + (ctx ? '\n\n' + ctx : '');
      return { override, skillName: matched.meta?.name };
    } catch {
      clearTimeout(timer);
      return null;
    }
  }

  /**
   * Fetch a skill from a URL, parse it, add to loadedSkills, and apply.
   * Stores the source URL on the parsed object for later identity checks.
   */
  async function loadSkillFromUrl(url) {
    const corsProxy = getSessionSetting('corsProxy');
    const raw = await SoulLoader.fetchRawText(url, corsProxy);
    const parsed = SoulLoader.parseSkillFile(raw);
    parsed.url = url;
    if (!loadedSkills.find(s => s.url === url)) {
      loadedSkills.push(parsed);
    }
    applySkillsToInstruction();
    saveSessionSkills(); // persist skill state for this session
    return parsed;
  }

  /**
   * Remove a loaded skill by URL and re-apply system instruction.
   */
  function unloadSkill(url) {
    loadedSkills = loadedSkills.filter(s => s.url !== url);
    applySkillsToInstruction();
    saveSessionSkills(); // persist skill state for this session
  }

  // ─── Guided Setup Wizard ──────────────────────────────────────────

  let _setupSessionId = null;
  let _setupStep = 0;

  function cleanupIncompleteSetup(setupId) {
    if (!setupId) return;
    // Remove incomplete session from index and config
    const index = Storage.getIndex().filter(s => s.id !== setupId);
    Storage.saveIndex(index);
    removeSessionConfig(setupId);
    _setupSessionId = null;
    _setupStep = 0;
    renderSidebar();
  }

  async function startGuidedSetup() {
    // Clean up any incomplete previous setup
    if (_setupSessionId && _setupStep > 0) {
      cleanupIncompleteSetup(_setupSessionId);
    }

    const id = Storage.uuid();
    initSessionConfig(id);
    _setupSessionId = id;
    _setupStep = 1;
    currentSessionId = id;
    passphrase = null;
    loadedSkills = [];
    loadedSkillCount = 0;
    currentSoulName = '';
    soulOnlyInstruction = '';
    baseSoulInstruction = '';
    Chat.clearHistory();
    Chat.resetTokenUsage();
    $('#chat-box').innerHTML = '';
    setInputEnabled(false);
    hide('#token-display');
    updateSidebarActive(null);

    // Add to sidebar immediately with localized "configuring" label
    const index = Storage.getIndex();
    index.unshift({
      id,
      title: tl('setupConfiguring'),
      soulName: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      backend: 'local',
    });
    Storage.saveIndex(index);
    renderSidebar();
    updateSidebarActive(id);

    renderSetupStep1();
  }

  function renderSetupStep1() {
    const chatBox = $('#chat-box');
    // System message
    const sysMsg = document.createElement('div');
    sysMsg.className = 'message-wrapper model';
    sysMsg.innerHTML = `<div class="message-bubble model setup-bubble">
      <p><strong>${tl('setupWelcome')}</strong></p>
      <p>${tl('setupStep1')}</p>
      <div class="setup-form" id="setup-step1">
        <div class="setup-field">
          <label>${tl('setupProvider')}</label>
          <select id="setup-provider" class="setup-input">
            <option value="gemini">Google Gemini</option>
            <option value="qwen">Qwen (DashScope)</option>
            <option value="kimi">Kimi (Moonshot)</option>
            <option value="openai">OpenAI Compatible</option>
          </select>
        </div>
        <div class="setup-field" id="setup-baseurl-field" style="display:none;">
          <label>Base URL</label>
          <input type="text" id="setup-base-url" class="setup-input" placeholder="https://api.openai.com/v1" />
        </div>
        <div class="setup-field">
          <label>${tl('setupModel')}</label>
          <input type="text" id="setup-model" class="setup-input" placeholder="gemini-2.5-flash" value="gemini-2.5-flash" />
        </div>
        <div class="setup-field">
          <label id="setup-key-label">${tl('setupApiKeyGemini')}</label>
          <div class="password-input-group">
            <input type="password" id="setup-api-key" class="setup-input" placeholder="Enter your API key..." autocomplete="off" />
            <button type="button" class="password-toggle setup-toggle" title="Show/hide">👁</button>
          </div>
        </div>
        <div class="setup-field">
          <label class="toggle-label">
            <input type="checkbox" id="setup-search" checked />
            <span>${tl('setupEnableSearch')}</span>
          </label>
        </div>
        <div class="setup-actions">
          <button id="setup-next1" class="setup-btn-primary">${tl('next')}</button>
        </div>
      </div>
    </div>`;
    chatBox.appendChild(sysMsg);
    scrollToBottom();

    // Wire provider change to update UI
    const providerSel = sysMsg.querySelector('#setup-provider');
    const modelInput = sysMsg.querySelector('#setup-model');
    const keyLabel = sysMsg.querySelector('#setup-key-label');
    const keyInput = sysMsg.querySelector('#setup-api-key');
    const savedSettings = getSettings();

    // Pre-fill from global settings
    const globalProvider = savedSettings.provider || 'gemini';
    providerSel.value = globalProvider;

    const baseUrlField = sysMsg.querySelector('#setup-baseurl-field');
    const baseUrlInput = sysMsg.querySelector('#setup-base-url');

    function updateProviderUI() {
      const p = providerSel.value;
      baseUrlField.style.display = p === 'openai' ? '' : 'none';
      if (p === 'qwen') {
        keyLabel.textContent = tl('setupApiKeyQwen');
        keyInput.placeholder = 'sk-...';
        if (!modelInput.value || !modelInput.value.startsWith('qwen')) modelInput.value = 'qwen3-max-2026-01-23';
        keyInput.value = savedSettings.qwenApiKey || '';
      } else if (p === 'kimi') {
        keyLabel.textContent = tl('setupApiKeyKimi');
        keyInput.placeholder = 'sk-...';
        if (!modelInput.value || !modelInput.value.startsWith('kimi')) modelInput.value = 'kimi-k2-turbo-preview';
        keyInput.value = savedSettings.kimiApiKey || '';
      } else if (p === 'openai') {
        keyLabel.textContent = 'API Key';
        keyInput.placeholder = 'sk-...';
        modelInput.value = modelInput.value || 'gpt-4o';
        keyInput.value = savedSettings.openaiApiKey || '';
        baseUrlInput.value = savedSettings.openaiBaseUrl || '';
      } else {
        keyLabel.textContent = tl('setupApiKeyGemini');
        keyInput.placeholder = 'AIza...';
        if (!modelInput.value || !modelInput.value.startsWith('gemini')) modelInput.value = 'gemini-2.5-flash';
        keyInput.value = savedSettings.apiKey || '';
      }
    }
    updateProviderUI();
    providerSel.addEventListener('change', updateProviderUI);

    // Toggle password visibility
    sysMsg.querySelector('.setup-toggle')?.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });

    sysMsg.querySelector('#setup-next1')?.addEventListener('click', () => {
      const provider = providerSel.value;
      const model = modelInput.value.trim();
      const apiKey = keyInput.value.trim();
      const enableSearch = sysMsg.querySelector('#setup-search').checked;

      if (!apiKey) {
        showToast(tl('toastEnterApiKey'), 'error');
        keyInput.focus();
        return;
      }
      if (!model) {
        showToast(tl('toastEnterModel'), 'error');
        modelInput.focus();
        return;
      }
      if (provider === 'openai' && !baseUrlInput.value.trim()) {
        showToast('Please enter a Base URL', 'error');
        baseUrlInput.focus();
        return;
      }

      // Save to session config
      const cfg = getSessionConfig(_setupSessionId);
      cfg.provider = provider;
      cfg.model = model;
      cfg.enableSearch = enableSearch;
      if (provider === 'qwen') cfg.qwenApiKey = apiKey;
      else if (provider === 'kimi') cfg.kimiApiKey = apiKey;
      else if (provider === 'openai') { cfg.openaiApiKey = apiKey; cfg.openaiBaseUrl = baseUrlInput.value.trim(); }
      else cfg.apiKey = apiKey;
      saveSessionConfig(_setupSessionId, cfg);

      // Also save to global as template
      setSetting('provider', provider);
      setSetting('model', model);
      if (provider === 'qwen') setSetting('qwenApiKey', apiKey);
      else if (provider === 'kimi') setSetting('kimiApiKey', apiKey);
      else if (provider === 'openai') { setSetting('openaiApiKey', apiKey); setSetting('openaiBaseUrl', baseUrlInput.value.trim()); }
      else setSetting('apiKey', apiKey);

      // Disable step 1
      sysMsg.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
      sysMsg.querySelector('#setup-next1').textContent = `✓ ${tl('done')}`;

      _setupStep = 2;
      renderSetupStep2();
    });
  }

  function renderSetupStep2() {
    const chatBox = $('#chat-box');
    const sysMsg = document.createElement('div');
    sysMsg.className = 'message-wrapper model';
    sysMsg.innerHTML = `<div class="message-bubble model setup-bubble">
      <p><strong>${tl('setupStep2Title')}</strong></p>
      <p>${tl('setupStep2Desc')}</p>
      <div class="setup-form" id="setup-step2">
        <div class="setup-field">
          <label>${tl('setupPassphrase')}</label>
          <div class="password-input-group">
            <input type="password" id="setup-passphrase" class="setup-input" placeholder="${escapeHtml(tl('setupPassphrasePlaceholder'))}" autocomplete="off" />
            <button type="button" class="password-toggle setup-toggle2" title="Show/hide">👁</button>
          </div>
        </div>
        <div class="setup-actions">
          <button id="setup-next2" class="setup-btn-primary">${tl('next')}</button>
        </div>
      </div>
    </div>`;
    chatBox.appendChild(sysMsg);
    scrollToBottom();

    sysMsg.querySelector('.setup-toggle2')?.addEventListener('click', () => {
      const inp = sysMsg.querySelector('#setup-passphrase');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    sysMsg.querySelector('#setup-next2')?.addEventListener('click', () => {
      const pass = sysMsg.querySelector('#setup-passphrase').value.trim();
      if (!pass) {
        showToast(tl('toastPassphraseEmpty'), 'error');
        sysMsg.querySelector('#setup-passphrase').focus();
        return;
      }

      const cfg = getSessionConfig(_setupSessionId);
      cfg.passphrase = pass;
      saveSessionConfig(_setupSessionId, cfg);
      passphrase = pass;

      sysMsg.querySelectorAll('input, button').forEach(el => el.disabled = true);
      sysMsg.querySelector('#setup-next2').textContent = `✓ ${tl('done')}`;

      _setupStep = 3;
      renderSetupStep3();
    });
  }

  function renderSetupStep3() {
    const chatBox = $('#chat-box');
    const sysMsg = document.createElement('div');
    sysMsg.className = 'message-wrapper model';
    sysMsg.innerHTML = `<div class="message-bubble model setup-bubble">
      <p><strong>${tl('setupStep3Title')}</strong></p>
      <p>${tl('setupStep3Desc')}</p>
      <div class="setup-form" id="setup-step3">
        <div class="setup-field">
          <label>${tl('setupStorage')}</label>
          <select id="setup-storage" class="setup-input">
            <option value="local">Local (localStorage)</option>
            <option value="github">GitHub Repository</option>
          </select>
        </div>
        <div id="setup-github-fields" class="hidden">
          <div class="setup-field">
            <label>${tl('setupGithubToken')}</label>
            <div class="password-input-group">
              <input type="password" id="setup-gh-token" class="setup-input" placeholder="ghp_..." autocomplete="off" />
              <button type="button" class="password-toggle setup-toggle3" title="Show/hide">👁</button>
            </div>
            <button id="setup-test-gh-pat" class="setup-btn-secondary" type="button" style="margin-top:8px;">🧪 Test PAT Permissions</button>
            <div class="setup-hint">${tl('setupGithubPatHint')}</div>
          </div>
          <div class="setup-field">
            <label>${tl('setupGithubOwner')}</label>
            <input type="text" id="setup-gh-owner" class="setup-input" placeholder="your-username" />
          </div>
          <div class="setup-field">
            <label>${tl('setupGithubRepo')}</label>
            <input type="text" id="setup-gh-repo" class="setup-input" placeholder="my-agent-sessions" />
          </div>
        </div>
        <div class="setup-actions">
          <button id="setup-skip3" class="setup-btn-secondary">${tl('skipLocal')}</button>
          <button id="setup-finish" class="setup-btn-primary">✓ ${tl('startSession')}</button>
        </div>
      </div>
    </div>`;
    chatBox.appendChild(sysMsg);
    scrollToBottom();

    const storageSel = sysMsg.querySelector('#setup-storage');
    const ghFields = sysMsg.querySelector('#setup-github-fields');
    const ghTokenInput = sysMsg.querySelector('#setup-gh-token');
    const ghOwnerInput = sysMsg.querySelector('#setup-gh-owner');
    const ghRepoInput = sysMsg.querySelector('#setup-gh-repo');
    const testPatBtn = sysMsg.querySelector('#setup-test-gh-pat');
    const savedSettings = getSettings();
    let guidedPatVerifiedSig = null;

    storageSel.addEventListener('change', () => {
      if (storageSel.value === 'github') {
        ghFields.classList.remove('hidden');
        // Pre-fill from global settings
        const ghToken = sysMsg.querySelector('#setup-gh-token');
        const ghOwner = sysMsg.querySelector('#setup-gh-owner');
        const ghRepo = sysMsg.querySelector('#setup-gh-repo');
        if (!ghToken.value) ghToken.value = savedSettings.githubToken || '';
        if (!ghOwner.value) ghOwner.value = savedSettings.githubOwner || '';
        if (!ghRepo.value) ghRepo.value = savedSettings.githubRepo || '';
      } else {
        ghFields.classList.add('hidden');
      }
    });

    sysMsg.querySelector('.setup-toggle3')?.addEventListener('click', () => {
      const inp = sysMsg.querySelector('#setup-gh-token');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    const clearGuidedVerification = () => {
      guidedPatVerifiedSig = null;
      clearPatVerification('guided');
    };
    ghTokenInput?.addEventListener('input', clearGuidedVerification);
    ghOwnerInput?.addEventListener('input', clearGuidedVerification);
    ghRepoInput?.addEventListener('input', clearGuidedVerification);

    testPatBtn?.addEventListener('click', async () => {
      const token = ghTokenInput?.value.trim();
      const owner = ghOwnerInput?.value.trim();
      const repo = ghRepoInput?.value.trim();
      if (!token) {
        showToast('Please fill Token first.', 'error');
        return;
      }

      const signature = buildPatVerificationSig(token, owner, repo);
      const originalText = testPatBtn.textContent;
      testPatBtn.disabled = true;
      testPatBtn.textContent = '⏳ Testing...';
      try {
        const result = await testGitHubPatPermissions({ token, owner, repo });
        if (!result.passed) {
          setPatVerification('guided', signature, false, result.checks.join(' | '));
          showToast(`PAT test failed: ${result.checks.join(' | ')}`, 'error');
          return;
        }
        guidedPatVerifiedSig = signature;
        setPatVerification('guided', signature, true, result.checks.join(' | '));
        showToast(`PAT test passed for ${result.login}: ${result.checks.join(' | ')}`, 'success');
      } catch (e) {
        setPatVerification('guided', signature, false, e.message);
        showToast(`PAT test failed: ${e.message}`, 'error');
      } finally {
        testPatBtn.disabled = false;
        testPatBtn.textContent = originalText;
      }
    });

    const finishSetup = async (skipGithub) => {
      const cfg = getSessionConfig(_setupSessionId);
      if (!skipGithub && storageSel.value === 'github') {
        const ghToken = sysMsg.querySelector('#setup-gh-token').value.trim();
        const ghOwner = sysMsg.querySelector('#setup-gh-owner').value.trim();
        const ghRepo = sysMsg.querySelector('#setup-gh-repo').value.trim();
        if (!ghToken || !ghOwner || !ghRepo) {
          showToast(tl('toastGithubFillOrSkip'), 'error');
          return;
        }

        // Check if repo exists, create if not
        try {
          const checkResp = await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}`, {
            headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json' },
          });

          if (checkResp.status === 404) {
            // Repo doesn't exist — ask user about privacy before creating
            const privacyChoice = await new Promise(resolve => {
              const bubble = addMessageBubble('model', '');
              bubble.innerHTML = `
                <div class="schedule-wizard" style="max-width:400px;">
                  <div class="schedule-wizard-title">🔧 Create Repository</div>
                  <p style="margin-bottom:16px;">Repository <strong>"${escapeHtml(ghOwner)}/${escapeHtml(ghRepo)}"</strong> doesn't exist. Create it now?</p>
                  <label class="schedule-field-label">Privacy Setting</label>
                  <select id="repo-privacy" class="schedule-input">
                    <option value="false" selected>🌐 Public</option>
                    <option value="true">🔒 Private</option>
                  </select>
                  <div class="schedule-actions" style="margin-top:12px;">
                    <button id="repo-cancel" class="schedule-btn schedule-btn-secondary">Cancel</button>
                    <button id="repo-create" class="schedule-btn schedule-btn-primary">✓ Create</button>
                  </div>
                </div>
              `;
              bubble.querySelector('#repo-cancel').addEventListener('click', () => {
                bubble.innerHTML = renderMarkdown('_Repository creation cancelled._');
                resolve(null);
              });
              bubble.querySelector('#repo-create').addEventListener('click', () => {
                const isPrivate = bubble.querySelector('#repo-privacy').value === 'true';
                resolve(isPrivate);
              });
              scrollToBottom();
            });

            if (privacyChoice === null) return; // User cancelled

            // Create the repository
            try {
              const createResp = await fetch('https://api.github.com/user/repos', {
                method: 'POST',
                headers: {
                  Authorization: `token ${ghToken}`,
                  Accept: 'application/vnd.github.v3+json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  name: ghRepo,
                  description: 'Encrypted session storage for 🍤 小虾米',
                  private: privacyChoice,
                  auto_init: true,
                }),
              });

              if (!createResp.ok) {
                const err = await createResp.json().catch(() => ({}));
                throw new Error(err.message || `HTTP ${createResp.status}`);
              }

              // Wait for GitHub to process the initial commit
              await new Promise(r => setTimeout(r, 1500));

              // Create sessions directory with .gitkeep
              await fetch(`https://api.github.com/repos/${ghOwner}/${ghRepo}/contents/sessions/.gitkeep`, {
                method: 'PUT',
                headers: {
                  Authorization: `token ${ghToken}`,
                  Accept: 'application/vnd.github.v3+json',
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message: 'Initialize sessions directory', content: btoa('') }),
              });

              const vis = privacyChoice ? 'private' : 'public';
              showToast(`✅ Created ${vis} repo "${ghOwner}/${ghRepo}"`, 'success');
            } catch (e) {
              showToast(`Failed to create repo: ${e.message}`, 'error');
              return;
            }
          } else if (!checkResp.ok) {
            throw new Error(`GitHub API error: ${checkResp.status}`);
          }
        } catch (e) {
          showToast(`Failed to verify repo: ${e.message}`, 'error');
          return;
        }

        cfg.storageBackend = 'github';
        cfg.githubToken = ghToken;
        cfg.githubOwner = ghOwner;
        cfg.githubRepo = ghRepo;
        cfg.githubPath = 'sessions';
        setSetting('githubToken', ghToken);
        setSetting('githubOwner', ghOwner);
        setSetting('githubRepo', ghRepo);
      } else {
        cfg.storageBackend = 'local';
      }
      saveSessionConfig(_setupSessionId, cfg);

      sysMsg.querySelectorAll('input, select, button').forEach(el => el.disabled = true);
      
      // Update sidebar entry
      const indexEntry = Storage.getIndex().find(s => s.id === _setupSessionId);
      if (indexEntry) {
        indexEntry.title = tl('setupDefaultSession');
        indexEntry.backend = cfg.storageBackend;
        Storage.saveIndex(Storage.getIndex().map(s => s.id === _setupSessionId ? indexEntry : s));
      }

      _setupStep = 0;
      const sessionId = _setupSessionId;
      _setupSessionId = null;

      // Activate the session
      currentSessionId = sessionId;
      passphrase = cfg.passphrase;

      // Clear setup chat and show welcome
      $('#chat-box').innerHTML = '';
      setInputEnabled(true);
      show('#token-display');
      showWelcome();
      updateSidebarActive(sessionId);
      updateTokenDisplay();
      renderSidebar();

      await loadSoulAndSkills();

      showToast(tl('toastSessionReady'), 'success');
    };

    sysMsg.querySelector('#setup-skip3')?.addEventListener('click', () => finishSetup(true));
    sysMsg.querySelector('#setup-finish')?.addEventListener('click', () => finishSetup(false));
  }

  /**
   * Enable/disable the input area
   */
  function setInputEnabled(enabled) {
    const inputArea = document.querySelector('.input-area');
    const quickActions = $('#quick-actions');
    const input = $('#message-input');
    const sendBtn = $('#send-btn');
    if (inputArea) {
      if (enabled) { inputArea.classList.remove('hidden'); }
      else         { inputArea.classList.add('hidden'); }
    }
    if (quickActions) {
      if (enabled) { quickActions.classList.remove('hidden'); }
      else         { quickActions.classList.add('hidden'); }
    }
    if (input) {
      input.disabled = !enabled;
      input.placeholder = enabled
        ? tl('inputEnabled')
        : tl('inputDisabled');
    }
    if (sendBtn) sendBtn.disabled = !enabled;
  }

  // ─── Restore Sessions from GitHub ─────────────────────────────────

  function openRestoreDialog() {
    const dialog = $('#restore-dialog');
    show(dialog);
    // Pre-fill from global settings if available
    $('#restore-github-token').value = getSetting('githubToken', '');
    $('#restore-github-owner').value = getSetting('githubOwner', '');
    $('#restore-github-repo').value = getSetting('githubRepo', '');
    $('#restore-github-path').value = getSetting('githubPath', 'sessions');
    setRestoreStatus('', '');
    $('#restore-submit').disabled = false;
    $('#restore-github-token').focus();
  }

  function closeRestoreDialog() {
    hide('#restore-dialog');
    setRestoreStatus('', '');
  }

  function setRestoreStatus(message, type) {
    const el = $('#restore-status');
    if (!el) return;
    if (!message) {
      hide(el);
      el.textContent = '';
      el.className = 'restore-status hidden';
      return;
    }
    el.textContent = message;
    el.className = `restore-status status-${type}`;
    show(el);
  }

  async function submitRestore() {
    const token = $('#restore-github-token').value.trim();
    const owner = $('#restore-github-owner').value.trim();
    const repo  = $('#restore-github-repo').value.trim();
    const path  = $('#restore-github-path').value.trim() || 'sessions';

    if (!token || !owner || !repo) {
      setRestoreStatus('Please fill in Token, Owner, and Repository fields.', 'error');
      return;
    }

    const submitBtn = $('#restore-submit');
    submitBtn.disabled = true;
    setRestoreStatus('Connecting to GitHub…', 'loading');

    try {
      const config = { token, owner, repo, path };
      const remoteIds = await Storage.GitHub.list(config);

      if (remoteIds.length === 0) {
        setRestoreStatus('No sessions found in this repository.', 'error');
        submitBtn.disabled = false;
        return;
      }

      // Merge remote sessions into local index
      const localIndex = Storage.getIndex();
      const localIdSet = new Set(localIndex.map(s => s.id));
      let imported = 0;

      for (const id of remoteIds) {
        // Save GitHub credentials to each session's config for independent access
        const sessCfg = getSessionConfig(id);
        sessCfg.githubToken = token;
        sessCfg.githubOwner = owner;
        sessCfg.githubRepo = repo;
        sessCfg.githubPath = path;
        sessCfg.storageBackend = 'github';
        saveSessionConfig(id, sessCfg);

        if (localIdSet.has(id)) continue; // already in index
        const entry = {
          id,
          title: `GitHub Session (${id.slice(0, 8)}…)`,
          soulName: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          backend: 'github',
        };
        localIndex.unshift(entry);
        imported++;
      }

      Storage.saveIndex(localIndex);

      // Also persist GitHub credentials globally as template for new sessions
      setSetting('githubToken', token);
      setSetting('githubOwner', owner);
      setSetting('githubRepo', repo);
      setSetting('githubPath', path);

      setRestoreStatus(
        `Found ${remoteIds.length} session(s), imported ${imported} new session(s).`,
        'success'
      );

      renderSidebar();

      // Auto-close after a short delay on success
      setTimeout(() => closeRestoreDialog(), 1500);
    } catch (err) {
      console.error('Restore failed:', err);
      setRestoreStatus(`Restore failed: ${err.message}`, 'error');
      submitBtn.disabled = false;
    }
  }

  // ─── Passphrase Dialog ────────────────────────────────────────────

  /**
   * Show passphrase dialog for decrypting a saved session.
   * Returns a Promise that resolves with the passphrase or null if cancelled.
   */
  function promptPassphrase(message) {
    return new Promise((resolve) => {
      const dialog = $('#passphrase-dialog');
      const msgEl = $('#passphrase-message');
      if (msgEl) msgEl.textContent = message || tl('decryptDesc');
      show(dialog);
      const input = $('#passphrase-input');
      input.value = '';
      input.focus();
      dialog._resolve = resolve;
    });
  }

  function submitPassphrase() {
    const input = $('#passphrase-input');
    const val = input.value;
    if (!val) {
      showToast(tl('toastPassphraseEmpty'), 'error');
      return;
    }
    input.value = '';
    hide('#passphrase-dialog');
    const dialog = $('#passphrase-dialog');
    if (dialog._resolve) {
      dialog._resolve(val);
      dialog._resolve = null;
    }
  }

  function cancelPassphrase() {
    hide('#passphrase-dialog');
    const dialog = $('#passphrase-dialog');
    if (dialog._resolve) {
      dialog._resolve(null);
      dialog._resolve = null;
    }
  }

  // ─── Input Auto-Resize ────────────────────────────────────────────

  function autoResizeInput() {
    const input = $('#message-input');
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  }

  // ─── Sidebar Toggle ───────────────────────────────────────────────

  function toggleSidebar() {
    const sidebar = $('#sidebar');
    sidebar.classList.toggle('collapsed');
  }

  // ─── Init ──────────────────────────────────────────────────────────

  function init() {
    configureMarked();
    currentLang = getLang();
    applyLanguageToStaticUi();

    // Event listeners
    $('#send-btn')?.addEventListener('click', sendMessage);
    $('#stop-btn')?.addEventListener('click', () => {
      Chat.abort();
      setStreamingState(false);
      showToast(tl('toastGenerationStopped'), 'info');
    });

    // Loop agent disconnect button
    $('#loop-disconnect-btn')?.addEventListener('click', () => {
      if (_loopConnectedKey) {
        const key = _loopConnectedKey;
        disconnectLoopAgent();
        addMessageBubble('model', `✅ Disconnected from loop agent **${escapeHtml(key)}**.`);
      }
    });

    // Loop agent status panel buttons
    $('#loop-panel-refresh')?.addEventListener('click', () => refreshLoopStatusPanel());
    $('#loop-panel-close')?.addEventListener('click', () => hideLoopStatusPanel());

    $('#message-input')?.addEventListener('keydown', (e) => {
      const isComposing = e.isComposing || e.keyCode === 229;

      // Slash autocomplete navigation
      if (!$('#slash-autocomplete').classList.contains('hidden')) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          slashAutocompleteMoveSelection(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          slashAutocompleteMoveSelection(-1);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !isComposing && slashAutocompleteActiveIndex() >= 0)) {
          e.preventDefault();
          slashAutocompleteConfirm();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          slashAutocompleteHide();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
        e.preventDefault();
        sendMessage();
      }
    });

    $('#message-input')?.addEventListener('input', () => {
      autoResizeInput();
      slashAutocompleteUpdate();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.input-area')) slashAutocompleteHide();
    });

    $('#lang-toggle-btn')?.addEventListener('click', () => {
      currentLang = setLang(currentLang === 'zh' ? 'en' : 'zh');
      applyLanguageAndRefresh();
    });

    // Quick action buttons above input
    document.querySelectorAll('.quick-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const cmd = btn.dataset.cmd;
        if (!cmd) return;
        if (!currentSessionId) {
          showToast(tl('toastStartFirst'), 'info');
          return;
        }
        const input = $('#message-input');
        input.value = cmd;
        input.focus();
        sendMessage();
      });
    });

    $('#settings-btn')?.addEventListener('click', () => openSettings());
    $('#close-settings')?.addEventListener('click', closeSettings);
    $('#apply-settings')?.addEventListener('click', applySettings);

    // Toggle visibility for all password fields
    document.querySelectorAll('.password-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const inputId = btn.getAttribute('data-for');
        const input = $(`#${inputId}`);
        if (input) {
          const isPassword = input.type === 'password';
          input.type = isPassword ? 'text' : 'password';
          btn.textContent = isPassword ? '🙈' : '👁';
          input.focus();
        }
      });
    });

    $('#set-storage-backend')?.addEventListener('change', toggleStorageFields);
    $('#set-provider')?.addEventListener('change', updateProviderSections);
    $('#set-model')?.addEventListener('input', updateModelDimensionUI);
    $('#set-model')?.addEventListener('change', updateModelDimensionUI);
    $('#set-enable-thinking')?.addEventListener('change', toggleThinkingFields);
    $('#auto-create-repo-btn')?.addEventListener('click', autoCreateGitHubRepo);
    $('#test-github-pat-btn')?.addEventListener('click', testStoragePatFromSettings);
    $('#set-action-use-storage')?.addEventListener('change', toggleActionFields);
    $('#auto-create-action-repo-btn')?.addEventListener('click', autoCreateActionRepo);
    $('#test-action-pat-btn')?.addEventListener('click', testActionPatFromSettings);

    ['#set-github-token', '#set-github-owner', '#set-github-repo'].forEach((selector) => {
      $(selector)?.addEventListener('input', () => clearPatVerification('storage'));
    });
    ['#set-action-token', '#set-action-owner', '#set-action-repo'].forEach((selector) => {
      $(selector)?.addEventListener('input', () => clearPatVerification('action'));
    });

    $('#new-session-btn')?.addEventListener('click', () => {
      startGuidedSetup();
    });

    $('#sidebar-toggle')?.addEventListener('click', toggleSidebar);

    // Restore sessions dialog
    $('#restore-sessions-btn')?.addEventListener('click', openRestoreDialog);
    $('#restore-submit')?.addEventListener('click', submitRestore);
    $('#restore-cancel')?.addEventListener('click', closeRestoreDialog);

    // Passphrase dialog
    $('#passphrase-submit')?.addEventListener('click', submitPassphrase);
    $('#passphrase-cancel')?.addEventListener('click', cancelPassphrase);
    $('#passphrase-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPassphrase();
      }
    });

    // Reload SOUL button — persist current form values first so the fetch uses what's in the inputs
    $('#reload-soul-btn')?.addEventListener('click', async () => {
      const panel = $('#settings-panel');
      const isOpen = panel && !panel.classList.contains('hidden');
      if (isOpen && settingsTarget && settingsTarget === currentSessionId) {
        const cfg = getSessionConfig(settingsTarget);
        const soulPreset = $('#set-soul-preset').value;
        cfg.soulUrl     = soulPreset === '__custom__' ? $('#set-soul-url').value.trim() : soulPreset;
        cfg.notionToken = $('#set-notion-token').value.trim();
        cfg.corsProxy   = $('#set-cors-proxy').value.trim();
        saveSessionConfig(settingsTarget, cfg);
      }
      await loadSoulAndSkills();
    });

    $('#set-soul-preset')?.addEventListener('change', toggleSoulUrlField);

    // Pushoo configuration dialog — multi-channel form
    const pushooDialog = $('#pushoo-config-dialog');

    // Multi-channel pushoo dialog logic
    let _pushooEditChannels = []; // Temporary edit state for the dialog

    function buildPlatformOptions(selectedPlatform) {
      return PushooNotifier.getSupportedPlatforms(currentLang).map(
        p => `<option value="${p.name}" ${p.name === selectedPlatform ? 'selected' : ''}>${escapeHtml(p.label)}</option>`
      ).join('');
    }

    function renderChannelRow(index, channel) {
      const hint = PushooNotifier.getPlatformHint(channel.platform, currentLang);
      return `
        <div class="pushoo-channel-row" data-index="${index}" style="border:1px solid var(--border-color,#333);border-radius:8px;padding:12px;position:relative;">
          <button type="button" class="pushoo-remove-channel" data-index="${index}" style="position:absolute;top:6px;right:8px;background:none;border:none;color:#888;cursor:pointer;font-size:16px;" title="${tl('removeChannel')}">&times;</button>
          <div style="margin-bottom:8px;">
            <label style="font-size:12px;color:#999;margin-bottom:4px;display:block;">${tl('platform')}</label>
            <select class="pushoo-ch-platform schedule-input" data-index="${index}" style="width:100%;">
              ${buildPlatformOptions(channel.platform)}
            </select>
          </div>
          <div>
            <label style="font-size:12px;color:#999;margin-bottom:4px;display:block;">${tl('tokenKey')}</label>
            <div class="password-input-group">
              <input type="password" class="pushoo-ch-token schedule-input" data-index="${index}" value="${escapeHtml(channel.token)}" placeholder="..." autocomplete="off" />
              <button type="button" class="password-toggle pushoo-ch-toggle" data-index="${index}" title="Show/hide">👁</button>
            </div>
            <div class="hint pushoo-ch-hint" data-index="${index}" style="margin-top:4px;font-size:12px;">${escapeHtml(hint)}</div>
          </div>
        </div>
      `;
    }

    function renderChannelsList() {
      const container = $('#pushoo-channels-list');
      if (!container) return;
      if (_pushooEditChannels.length === 0) {
        container.innerHTML = `<div style="text-align:center;color:#888;padding:16px;font-size:13px;">${tl('noChannels')}</div>`;
      } else {
        container.innerHTML = _pushooEditChannels.map((ch, i) => renderChannelRow(i, ch)).join('');
      }

      // Bind events for newly rendered rows
      container.querySelectorAll('.pushoo-remove-channel').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          _pushooEditChannels.splice(idx, 1);
          renderChannelsList();
        });
      });
      container.querySelectorAll('.pushoo-ch-platform').forEach(sel => {
        sel.addEventListener('change', () => {
          const idx = parseInt(sel.dataset.index);
          _pushooEditChannels[idx].platform = sel.value;
          const hintEl = container.querySelector(`.pushoo-ch-hint[data-index="${idx}"]`);
          if (hintEl) hintEl.textContent = PushooNotifier.getPlatformHint(sel.value, currentLang);
        });
      });
      container.querySelectorAll('.pushoo-ch-token').forEach(inp => {
        inp.addEventListener('input', () => {
          const idx = parseInt(inp.dataset.index);
          _pushooEditChannels[idx].token = inp.value;
        });
      });
      container.querySelectorAll('.pushoo-ch-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.index);
          const inp = container.querySelector(`.pushoo-ch-token[data-index="${idx}"]`);
          if (inp) inp.type = inp.type === 'password' ? 'text' : 'password';
        });
      });
    }

    let _pushooDialogTargetSessionId = null;

    openPushooConfigDialog = (targetSessionId = null) => {
      const effectiveSessionId = targetSessionId || settingsTarget || currentSessionId;
      if (!effectiveSessionId) return;
      _pushooDialogTargetSessionId = effectiveSessionId;
      const cfg = getSessionConfig(effectiveSessionId);
      const pc = PushooNotifier.parseConfig(cfg.pushooConfig);
      _pushooEditChannels = pc.channels.map(ch => ({ ...ch }));
      renderChannelsList();
      show(pushooDialog);
    };

    $('#pushoo-config-btn')?.addEventListener('click', () => {
      openPushooConfigDialog();
    });

    $('#pushoo-add-channel')?.addEventListener('click', () => {
      const defaultPlatform = PushooNotifier.getSupportedPlatforms(currentLang)[0]?.name || 'telegram';
      _pushooEditChannels.push({ platform: defaultPlatform, token: '' });
      renderChannelsList();
    });

    $('#pushoo-config-save')?.addEventListener('click', () => {
      const targetSessionId = _pushooDialogTargetSessionId || settingsTarget || currentSessionId;
      if (!targetSessionId) return;
      // Filter out channels with empty tokens
      const validChannels = _pushooEditChannels.filter(ch => ch.platform && ch.token?.trim());
      const pc = { channels: validChannels.map(ch => ({ platform: ch.platform, token: ch.token.trim() })) };
      const cfg = getSessionConfig(targetSessionId);
      cfg.pushooConfig = PushooNotifier.serializeConfig(pc);
      saveSessionConfig(targetSessionId, cfg);
      hide(pushooDialog);
      updatePushooStatusBadge();
      showToast(tl('toastPushooSaved'), 'success');
    });

    ['pushoo-config-cancel', 'pushoo-config-close'].forEach(id => {
      $(`#${id}`)?.addEventListener('click', () => hide(pushooDialog));
    });

    // Collapsible sections
    document.querySelectorAll('.collapsible-header').forEach(header => {
      header.addEventListener('click', () => {
        const body = header.nextElementSibling;
        if (body && body.classList.contains('collapsible-body')) {
          header.classList.toggle('active');
          body.classList.toggle('active');
        }
      });
    });

    // No session on startup — show landing, disable input
    showLanding();
    setInputEnabled(false);
    renderSidebar();
  }

  // ─── Expose ────────────────────────────────────────────────────────
  return { init };
})();

export default App;

// Boot
document.addEventListener('DOMContentLoaded', App.init);
