/**
 * loop-agent/runner.js — Long-running GitHub Action agent
 *
 * Architecture: OpenClaw-inspired 4-node stateful graph
 *   Start → Analyze → Validate → Ask_User (params missing) ↔ Validate
 *                               → Execute  (params complete)
 *
 * Two input modes:
 *   1. Telegram mode — When PUSHOO_PLATFORM is "telegram", uses Telegraf
 *      long-polling to receive user messages directly from Telegram and
 *      replies via Telegram. Upstash is optional (status tracking only).
 *   2. Upstash mode  — Polls Upstash for user messages, sends results via
 *      Pushoo, and persists conversation history to the repo.
 *
 * Environment variables (set as repo secrets/vars):
 *   UPSTASH_URL       — Upstash Redis REST URL (required in Upstash mode)
 *   UPSTASH_TOKEN     — Upstash Redis REST token (required in Upstash mode)
 *   LOOP_KEY          — Unique conversation key
 *   AI_PROVIDER       — gemini | qwen | kimi
 *   AI_MODEL          — Model ID
 *   AI_API_KEY        — Provider API key
 *   PUSHOO_PLATFORM   — Pushoo platform name (if "telegram", enables Telegram mode)
 *   PUSHOO_TOKEN      — Pushoo platform token (for Telegram: botToken#chatId)
 *   GITHUB_TOKEN      — GitHub PAT for repo operations
 *   GITHUB_REPOSITORY — owner/repo (auto-set by Actions)
 *   LOOP_HISTORY_PATH — Path in repo for history file (default: loop-agent/history)
 *   LOOP_POLL_INTERVAL— Polling interval in seconds (default: 5)
 *   LOOP_SYSTEM_PROMPT— Optional system prompt for the agent
 *   LOOP_MAX_RUNTIME  — Max runtime in seconds (default: 18000 = 5h)
 *   LOOP_ENCRYPT_KEY  — Optional passphrase for encrypting repo files (AES-256-GCM)
 */

// ─── Upstash Redis REST client ──────────────────────────────────────

class UpstashClient {
  constructor(url, token) {
    this.baseUrl = url.replace(/\/+$/, '');
    this.token = token;
  }

  async _cmd(args) {
    const resp = await fetch(`${this.baseUrl}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Upstash error ${resp.status}: ${text}`);
    }
    return resp.json();
  }

  async get(key) {
    const res = await this._cmd(['GET', key]);
    return res.result;
  }

  async set(key, value) {
    const res = await this._cmd(['SET', key, value]);
    return res.result;
  }

  async del(key) {
    const res = await this._cmd(['DEL', key]);
    return res.result;
  }

  /**
   * Verify Upstash connectivity by issuing a PING command.
   * Returns true if connected, throws on failure.
   */
  async ping() {
    const res = await this._cmd(['PING']);
    return res.result === 'PONG';
  }
}

// ─── File Encryption (AES-256-GCM, PBKDF2) ────────────────────────
//
// Format: "ENCRYPTED:" + base64( salt(16) + iv(12) + ciphertext + authTag(16) )
// Compatible with the browser's Web Crypto implementation in crypto.js.

const nodeCrypto = require('crypto');

const ENC_PBKDF2_ITERATIONS = 310000;
const ENC_SALT_LEN = 16;
const ENC_IV_LEN = 12;
const ENC_KEY_LEN = 32;
const ENC_TAG_LEN = 16;
const ENC_PREFIX = 'ENCRYPTED:';

function encryptContent(passphrase, plaintext) {
  const salt = nodeCrypto.randomBytes(ENC_SALT_LEN);
  const iv = nodeCrypto.randomBytes(ENC_IV_LEN);
  const key = nodeCrypto.pbkdf2Sync(passphrase, salt, ENC_PBKDF2_ITERATIONS, ENC_KEY_LEN, 'sha256');
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Pack: salt + iv + ciphertext + authTag  (matches Web Crypto output)
  const packed = Buffer.concat([salt, iv, encrypted, authTag]);
  return ENC_PREFIX + packed.toString('base64');
}

function decryptContent(passphrase, blob) {
  if (!blob || !blob.startsWith(ENC_PREFIX)) return blob;
  const packed = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64');
  const salt = packed.subarray(0, ENC_SALT_LEN);
  const iv = packed.subarray(ENC_SALT_LEN, ENC_SALT_LEN + ENC_IV_LEN);
  const remainder = packed.subarray(ENC_SALT_LEN + ENC_IV_LEN);
  const authTag = remainder.subarray(remainder.length - ENC_TAG_LEN);
  const ciphertext = remainder.subarray(0, remainder.length - ENC_TAG_LEN);
  const key = nodeCrypto.pbkdf2Sync(passphrase, salt, ENC_PBKDF2_ITERATIONS, ENC_KEY_LEN, 'sha256');
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

// ─── GitHub Repo Operations ─────────────────────────────────────────

class RepoStore {
  constructor(token, repository, encryptKey = null) {
    this.token = token;
    const [owner, repo] = repository.split('/');
    this.owner = owner;
    this.repo = repo;
    this.api = 'https://api.github.com';
    this._encryptKey = encryptKey || null;
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }

  async readFile(path, branch = 'main') {
    const resp = await fetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${branch}`,
      { headers: this._headers() }
    );
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub read error: ${resp.status}`);
    const data = await resp.json();
    let content = Buffer.from(data.content, 'base64').toString('utf-8');
    // Decrypt if encrypted and key is available
    if (this._encryptKey && content.startsWith(ENC_PREFIX)) {
      try {
        content = decryptContent(this._encryptKey, content);
      } catch (e) {
        console.warn(`[RepoStore] Decrypt failed for ${path}: ${e.message}`);
      }
    }
    return { content, sha: data.sha };
  }

  async writeFile(path, content, message, branch = 'main') {
    // Get existing file SHA if it exists (for updates)
    const existing = await this.readFile(path, branch);
    // Encrypt content if key is set
    const finalContent = this._encryptKey ? encryptContent(this._encryptKey, content) : content;
    const body = {
      message,
      content: Buffer.from(finalContent).toString('base64'),
      branch,
    };
    if (existing) body.sha = existing.sha;

    const resp = await fetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { method: 'PUT', headers: this._headers(), body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`GitHub write error: ${resp.status} ${err.message || ''}`);
    }
    return resp.json();
  }
}

// ─── Pushoo Notification ────────────────────────────────────────────

async function sendPushoo(platform, token, title, content) {
  if (!platform || !token) return;

  try {
    // In CommonJS: require('pushoo').default returns a callable function directly
    // Signature: pushoo(platform, { token, title, content })
    const pushoo = require('pushoo').default;
    await pushoo(platform, { token, title, content });
    console.log(`[Pushoo] Notification sent via ${platform}`);
  } catch (e) {
    console.warn(`[Pushoo] Failed: ${e.message}`);
  }
}

// ─── Telegram Helpers ───────────────────────────────────────────────

/**
 * Parse the PUSHOO_TOKEN for Telegram.
 * Format: "botToken#chatId" or "botToken/chatId"
 */
function parseTelegramToken(pushooToken) {
  if (!pushooToken) return { botToken: '', chatId: '' };
  const sep = pushooToken.includes('#') ? '#' : '/';
  const parts = pushooToken.split(sep);
  return { botToken: parts[0] || '', chatId: parts[1] || '' };
}

/**
 * Split a long message into chunks for Telegram's 4096-char limit.
 */
function splitTelegramMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/**
 * Check if the platform string refers to Telegram.
 */
function isTelegramPlatform(platform) {
  return platform && platform.toLowerCase() === 'telegram';
}

// ─── Self-Restart (Workflow Re-dispatch) ────────────────────────────

/**
 * Attempt to re-dispatch the current workflow to continue the loop agent.
 * Uses the GitHub Actions REST API with GH_PAT.
 */
async function selfRestart() {
  const pat = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY;
  const workflowFile = process.env.LOOP_WORKFLOW_FILE;
  if (!pat || !repo || !workflowFile) {
    console.log('[Restart] Cannot self-restart: missing GH_PAT, GITHUB_REPOSITORY, or LOOP_WORKFLOW_FILE');
    return false;
  }

  const [owner, repoName] = repo.split('/');
  const url = `https://api.github.com/repos/${owner}/${repoName}/actions/workflows/${workflowFile}/dispatches`;
  try {
    console.log(`[Restart] Dispatching new workflow run: ${workflowFile}`);
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[Restart] Dispatch failed (${resp.status}): ${body}`);
      return false;
    }
    console.log('[Restart] Successfully dispatched new workflow run');
    return true;
  } catch (e) {
    console.error(`[Restart] Failed: ${e.message}`);
    return false;
  }
}

// ─── Built-in Tools ─────────────────────────────────────────────────

function createBuiltinTools(repoStore) {
  const { tool } = require('@langchain/core/tools');
  const { z } = require('zod');

  const tools = [];

  // 1. Web Search — uses fetch to query a search API (no API key needed)
  tools.push(tool(async ({ query }) => {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopAgent/1.0)' },
      });
      const html = await resp.text();
      // Extract text snippets from DuckDuckGo HTML results
      const snippets = [];
      const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
      let match;
      while ((match = regex.exec(html)) !== null && snippets.length < 5) {
        snippets.push(match[1].replace(/<\/?b>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim());
      }
      if (snippets.length === 0) return 'No search results found.';
      return snippets.map((s, i) => `${i + 1}. ${s}`).join('\n');
    } catch (e) {
      return `Search failed: ${e.message}`;
    }
  }, {
    name: 'web_search',
    description: 'Search the internet for information using DuckDuckGo. Returns top 5 text snippets.',
    schema: z.object({ query: z.string().describe('The search query') }),
  }));

  // 2. Fetch URL — retrieve content from a web page or API endpoint
  tools.push(tool(async ({ url, method, headers: customHeaders, body }) => {
    try {
      const fetchOpts = {
        method: method || 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LoopAgent/1.0)' },
        signal: AbortSignal.timeout(30000),
      };
      if (customHeaders) {
        try {
          const parsed = typeof customHeaders === 'string' ? JSON.parse(customHeaders) : customHeaders;
          Object.assign(fetchOpts.headers, parsed);
        } catch { /* ignore parse errors */ }
      }
      if (body && method && method !== 'GET') {
        fetchOpts.body = body;
        if (!fetchOpts.headers['Content-Type'] && !fetchOpts.headers['content-type']) {
          fetchOpts.headers['Content-Type'] = 'application/json';
        }
      }
      const resp = await fetch(url, fetchOpts);
      const statusLine = `HTTP ${resp.status} ${resp.statusText}`;
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        return `${statusLine}\n${errBody.slice(0, 2000)}`;
      }
      const contentType = resp.headers.get('content-type') || '';
      const text = await resp.text();
      // If JSON or API response, return raw text preserving structure
      if (contentType.includes('json') || contentType.includes('text/plain') || url.includes('/api/')) {
        return text.slice(0, 8000) + (text.length > 8000 ? '\n...(truncated)' : '');
      }
      // For HTML, strip tags
      const clean = text.replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return clean.slice(0, 8000) + (clean.length > 8000 ? '\n...(truncated)' : '');
    } catch (e) {
      return `Fetch failed: ${e.message}`;
    }
  }, {
    name: 'fetch_url',
    description: 'Fetch a URL or call an API endpoint. This is the PREFERRED tool for all HTTP API calls. Supports custom HTTP methods, headers (Authorization, etc.), and request body. Returns raw text for JSON/API responses, cleaned text for HTML pages, max 8000 chars. Use this instead of curl or Python requests.',
    schema: z.object({
      url: z.string().url().describe('The URL to fetch'),
      method: z.string().optional().describe('HTTP method: GET, POST, PUT, DELETE, PATCH. Defaults to GET.'),
      headers: z.string().optional().describe('Custom HTTP headers as a JSON string, e.g. {"Authorization": "Bearer token123"}'),
      body: z.string().optional().describe('Request body string (for POST/PUT/PATCH). Send JSON as a string.'),
    }),
  }));

  // 3. Run JavaScript — execute a JS snippet in a sandboxed VM
  tools.push(tool(async ({ code }) => {
    try {
      const vm = require('vm');
      const sandbox = { console: { log: (...args) => { output.push(args.map(String).join(' ')); } }, result: undefined };
      const output = [];
      const script = new vm.Script(code);
      const context = vm.createContext(sandbox);
      script.runInContext(context, { timeout: 10000 });
      const logs = output.join('\n');
      const result = sandbox.result !== undefined ? String(sandbox.result) : '';
      return [logs, result ? `Result: ${result}` : ''].filter(Boolean).join('\n') || '(no output)';
    } catch (e) {
      return `Execution error: ${e.message}`;
    }
  }, {
    name: 'run_js',
    description: 'Execute a JavaScript code snippet in a sandboxed VM. Set `result` variable to return a value, or use console.log(). Timeout: 10s.',
    schema: z.object({ code: z.string().describe('JavaScript code to execute') }),
  }));

  // 3b. Run Shell — execute a shell command (bash)
  tools.push(tool(async ({ command }) => {
    try {
      const { execSync } = require('child_process');
      const output = execSync(command, {
        encoding: 'utf-8',
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        shell: '/bin/bash',
        env: { ...process.env, LANG: 'en_US.UTF-8' },
      });
      const trimmed = output.trim();
      return trimmed.slice(0, 8000) + (trimmed.length > 8000 ? '\n...(truncated)' : '') || '(no output)';
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString().trim() : '';
      const stdout = e.stdout ? e.stdout.toString().trim() : '';
      return `Exit code: ${e.status || 1}\n${stderr || stdout || e.message}`.slice(0, 4000);
    }
  }, {
    name: 'run_shell',
    description: 'Execute a BASH shell command (/bin/bash). Supports any command including Python, Node.js, curl, git, file operations, package managers, etc. For HTTP API calls, fetch_url is preferred. Timeout: 30s, max output: 8000 chars.',
    schema: z.object({ command: z.string().describe('A bash command, e.g. "curl -s -H \'Authorization: Bearer token\' https://api.example.com/data" or "python3 script.py"') }),
  }));

  // 4. Current DateTime — returns current date and time
  tools.push(tool(async ({ timezone }) => {
    try {
      return new Date().toLocaleString('en-US', { timeZone: timezone || 'UTC', dateStyle: 'full', timeStyle: 'long' });
    } catch {
      return new Date().toISOString();
    }
  }, {
    name: 'current_datetime',
    description: 'Get the current date and time.',
    schema: z.object({ timezone: z.string().optional().describe('IANA timezone, e.g. Asia/Shanghai. Defaults to UTC.') }),
  }));

  // 5. Read Repo File — read a file from the GitHub repository
  if (repoStore) {
    tools.push(tool(async ({ path }) => {
      try {
        const file = await repoStore.readFile(path);
        if (!file) return `File not found: ${path}`;
        return file.content.slice(0, 8000) + (file.content.length > 8000 ? '\n...(truncated)' : '');
      } catch (e) {
        return `Read failed: ${e.message}`;
      }
    }, {
      name: 'read_repo_file',
      description: 'Read a file from the GitHub repository. Returns file content, max 8000 chars.',
      schema: z.object({ path: z.string().describe('File path relative to repo root, e.g. README.md') }),
    }));

    // 6. Write Repo File — write/update a file in the GitHub repository
    tools.push(tool(async ({ path, content, message }) => {
      try {
        await repoStore.writeFile(path, content, message || `[loop-agent] Update ${path}`);
        return `Successfully wrote ${content.length} chars to ${path}`;
      } catch (e) {
        return `Write failed: ${e.message}`;
      }
    }, {
      name: 'write_repo_file',
      description: 'Write or update a file in the GitHub repository.',
      schema: z.object({
        path: z.string().describe('File path relative to repo root'),
        content: z.string().describe('File content to write'),
        message: z.string().optional().describe('Commit message'),
      }),
    }));

    // 7. Save to Memory — persist information to MEMORY.md in the repo
    tools.push(tool(async ({ key, value }) => {
      try {
        const memPath = 'loop-agent/MEMORY.md';
        let content = '';
        const existing = await repoStore.readFile(memPath);
        if (existing) {
          content = existing.content;
        } else {
          content = '# Agent Memory\n\n';
        }
        const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sectionRegex = new RegExp(`## ${escaped}\\n[\\s\\S]*?(?=\\n## |$)`);
        if (sectionRegex.test(content)) {
          content = content.replace(sectionRegex, `## ${key}\n${value}`);
        } else {
          content += `\n## ${key}\n${value}\n`;
        }
        await repoStore.writeFile(memPath, content, `[loop-agent] Update memory: ${key}`);
        return `Memory saved: ${key}`;
      } catch (e) {
        return `Failed to save memory: ${e.message}`;
      }
    }, {
      name: 'save_memory',
      description: 'Save information to persistent memory (MEMORY.md in repo). Use for storing important context, preferences, or notes that persist across sessions.',
      schema: z.object({
        key: z.string().describe('Memory section name'),
        value: z.string().describe('Content to save under this section'),
      }),
    }));

    // 8. Read Memory — read the persistent memory file
    tools.push(tool(async ({ section }) => {
      try {
        const memPath = 'loop-agent/MEMORY.md';
        const file = await repoStore.readFile(memPath);
        if (!file) return 'No memory file found. Memory is empty.';
        if (section) {
          const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const sectionRegex = new RegExp(`## ${escaped}\\n([\\s\\S]*?)(?=\\n## |$)`);
          const match = file.content.match(sectionRegex);
          return match ? match[1].trim() : `Section "${section}" not found in memory.`;
        }
        return file.content.slice(0, 4000) + (file.content.length > 4000 ? '\n...(truncated)' : '');
      } catch (e) {
        return `Failed to read memory: ${e.message}`;
      }
    }, {
      name: 'read_memory',
      description: 'Read the persistent memory file (MEMORY.md). Returns all sections or a specific section.',
      schema: z.object({
        section: z.string().optional().describe('Specific section name to read, or omit to read all'),
      }),
    }));
  }

  // 9. Unified Skill Search — searches both built-in catalog AND ClawHub
  tools.push(tool(async ({ query }) => {
    try {
      const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
      const results = [];

      // Search built-in catalog
      for (const skill of BUILTIN_SKILLS) {
        const haystack = [skill.name, skill.description, ...skill.keywords].join(' ').toLowerCase();
        if (terms.some(t => haystack.includes(t))) {
          results.push({
            name: skill.name,
            icon: skill.icon,
            description: skill.description,
            loaded: _skillRouter.has(skill.name),
            source: 'builtin',
          });
        }
      }

      // Search ClawHub (non-blocking: if it fails, we still return builtin results)
      try {
        const chUrl = `https://clawhub.ai/api/v1/search?q=${encodeURIComponent(query)}&type=skill`;
        const resp = await fetch(chUrl, {
          headers: { 'User-Agent': 'LittleShrimp-LoopAgent/1.0' },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          const body = await resp.json();
          for (const r of (body.results || []).slice(0, 5)) {
            results.push({
              name: r.displayName || r.slug,
              slug: r.slug,
              icon: '🔌',
              description: (r.summary || '').slice(0, 150),
              loaded: _skillRouter.has(r.displayName || r.slug),
              source: 'clawhub',
              score: r.score,
            });
          }
        }
      } catch { /* ClawHub unreachable — continue with builtin results */ }

      if (results.length === 0) {
        return `No skills found matching "${query}".\nBuilt-in skills: ${BUILTIN_SKILLS.map(s => `${s.icon} ${s.name}`).join(', ')}`;
      }

      const lines = results.map(r => {
        const status = r.loaded ? '✅ loaded' : '📦 available';
        const src = r.source === 'clawhub' ? `[clawhub: ${r.slug}]` : '[builtin]';
        return `${r.icon} ${r.name} ${src} [${status}] — ${r.description}`;
      });
      return `Found ${results.length} skill(s):\n${lines.join('\n')}\n\nTo load a skill, call load_skill with the skill name (for builtin), a ClawHub slug, or a direct URL.`;
    } catch (e) {
      return `Skill search failed: ${e.message}`;
    }
  }, {
    name: 'search_skills',
    description: 'Search for skills across built-in catalog AND ClawHub community registry. Returns matching skills with load status. Use this when current tools cannot complete a task.',
    schema: z.object({ query: z.string().describe('Search keywords, e.g. "email send" or "translate language"') }),
  }));

  // 10. Unified Skill Loader — loads a skill from URL, builtin name, or ClawHub slug
  tools.push(tool(async ({ source }) => {
    try {
      let url, name, skillSource;

      // 1. Direct URL
      if (source.startsWith('http://') || source.startsWith('https://')) {
        url = source;
        name = source.split('/').pop().replace(/\.[^.]+$/, '') || 'custom-skill';
        skillSource = 'url';
      }
      // 2. Built-in skill name
      else {
        const builtin = BUILTIN_SKILLS.find(s =>
          s.name.toLowerCase() === source.toLowerCase()
        );
        if (builtin) {
          url = SKILLS_BASE_URL + builtin.file;
          name = builtin.name;
          skillSource = 'builtin';
        } else {
          // 3. Try as ClawHub slug — fetch content from ClawHub API
          const chUrl = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(source)}/content`;
          try {
            const resp = await fetch(chUrl, {
              headers: { 'User-Agent': 'LittleShrimp-LoopAgent/1.0' },
              signal: AbortSignal.timeout(15000),
            });
            if (resp.ok) {
              const content = await resp.text();
              const nameMatch = content.match(/^#\s*(.+)/m) || content.match(/name:\s*(.+)/im);
              name = nameMatch ? nameMatch[1].trim() : source;
              if (_skillRouter.has(name)) return `ℹ️ Skill "${name}" is already loaded.`;
              const entry = _skillRouter.register({
                name, source: 'clawhub', url: chUrl, content: content.slice(0, 6000),
              });
              return `✅ Skill "${name}" loaded from ClawHub.\nTriggers: ${entry.triggers.join(', ')}\nThe skill will be active for matching tasks.`;
            }
          } catch { /* fall through */ }

          return `❌ Skill "${source}" not found. Provide a full URL, a built-in skill name, or a ClawHub slug.\nBuilt-in skills: ${BUILTIN_SKILLS.map(s => s.name).join(', ')}`;
        }
      }

      // Check if already loaded
      if (_skillRouter.has(name)) return `ℹ️ Skill "${name}" is already loaded.`;

      // Fetch and register
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const content = await resp.text();

      // Try to extract a better name from content
      const nameMatch = content.match(/^#\s*(.+)/m) || content.match(/name:\s*(.+)/im);
      if (nameMatch) name = nameMatch[1].trim();

      if (_skillRouter.has(name)) return `ℹ️ Skill "${name}" is already loaded.`;

      const entry = _skillRouter.register({
        name, source: skillSource, url, content: content.slice(0, 6000),
      });
      return `✅ Skill "${name}" loaded from ${skillSource}.\nTriggers: ${entry.triggers.join(', ')}\nThe skill will be active for matching tasks.`;
    } catch (e) {
      return `❌ Failed to load skill: ${e.message}`;
    }
  }, {
    name: 'load_skill',
    description: 'Load a skill by URL, built-in name, or ClawHub slug. The skill will be automatically activated for matching tasks via the skill router. Sources: direct URL (any .txt/.md skill file), built-in name (e.g. "Code Review"), or ClawHub slug (e.g. "email-daily-summary").',
    schema: z.object({
      source: z.string().describe('URL, built-in skill name, or ClawHub slug'),
    }),
  }));

  // 11. ClawHub Skill Detail — inspect a skill before loading
  tools.push(tool(async ({ slug }) => {
    try {
      const url = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'LittleShrimp-LoopAgent/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (resp.status === 404) return `Skill "${slug}" not found on ClawHub.`;
      if (!resp.ok) return `ClawHub detail failed: HTTP ${resp.status}`;
      const body = await resp.json();
      const s = body.skill || {};
      const v = body.latestVersion || {};
      const owner = body.owner || {};
      const mod = body.moderation || {};
      const loaded = _skillRouter.has(s.displayName || s.slug);
      const lines = [
        `**${s.displayName || s.slug}** (${s.slug}) ${loaded ? '✅ loaded' : '📦 available'}`,
        `Summary: ${s.summary || 'N/A'}`,
        `Version: ${v.version || 'N/A'}`,
        `Author: ${owner.handle || 'unknown'}`,
        `Downloads: ${s.stats?.downloads || 0} | Stars: ${s.stats?.stars || 0}`,
        `Safety: ${mod.verdict || 'unknown'}${mod.summary ? ' — ' + mod.summary : ''}`,
        v.changelog ? `Changelog: ${v.changelog.slice(0, 300)}` : '',
        `URL: https://clawhub.ai/skills/${s.slug}`,
        loaded ? '' : `\nTo load: call load_skill with slug "${s.slug}"`,
      ].filter(Boolean);
      return lines.join('\n');
    } catch (e) {
      return `ClawHub detail failed: ${e.message}`;
    }
  }, {
    name: 'clawhub_skill_detail',
    description: 'Get detailed information about a specific ClawHub skill by slug. Inspect safety, author, stats before loading. Use load_skill to actually load a skill.',
    schema: z.object({ slug: z.string().describe('The skill slug, e.g. "email-daily-summary"') }),
  }));

  return tools;
}

// ─── Content Extraction Helper ────────────────────────────────────

/**
 * Extract text string from LLM response content.
 * Gemini may return content as an array of {type:'text',text:'...'} objects.
 */
function extractTextContent(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => (typeof part === 'string' ? part : part.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

// ─── LLM Factory ────────────────────────────────────────────────────

function createLLM(provider, model, apiKey) {
  if (provider === 'gemini') {
    const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({ model, apiKey, maxRetries: 2 });
  }
  // For qwen/kimi/other OpenAI-compatible providers
  const { ChatOpenAI } = require('@langchain/openai');
  const baseURLMap = {
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    kimi: 'https://api.moonshot.cn/v1',
  };
  return new ChatOpenAI({
    model,
    openAIApiKey: apiKey,
    configuration: { baseURL: baseURLMap[provider] || baseURLMap.qwen },
    maxRetries: 2,
  });
}

// ─── State: The "blood" flowing through the graph ──────────────────
//
// State is the single source of truth for the entire graph.
// Every node receives State as input and returns a mutated State.
// It persists across node transitions via the Checkpointer.

function createInitialState() {
  return {
    // Core graph phase
    phase: 'analyze',
    intent: '',
    requiredParams: {},
    collectedParams: {},
    missingParams: {},
    _waitRounds: 0,

    // Extensions (skills/soul)
    _skills: [],           // SkillRouter serialized data
    _loadedSoul: null,

    // Node execution history — records every node transition
    nodeHistory: [],
    // Per-node timing statistics (accumulated)
    timing: {
      analyze: { calls: 0, totalMs: 0, lastMs: 0 },
      validate: { calls: 0, totalMs: 0, lastMs: 0 },
      askUser: { calls: 0, totalMs: 0, lastMs: 0 },
      onUserReply: { calls: 0, totalMs: 0, lastMs: 0 },
      execute: { calls: 0, totalMs: 0, lastMs: 0 },
    },
    // Turn counter — increments per user message
    turnCount: 0,
    // Last error info for recovery/debugging
    lastError: null,
    // Thread identifier
    threadId: '',
  };
}

/**
 * Merge a partial update into an existing state, preserving structure.
 * Only updates fields present in the patch.
 */
function mergeState(state, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'timing' && typeof value === 'object') {
      state.timing = { ...state.timing, ...value };
    } else if (key === 'nodeHistory' && Array.isArray(value)) {
      state.nodeHistory = value;
    } else {
      state[key] = value;
    }
  }
  return state;
}

// ─── Checkpointer: External "recorder" at node boundaries ─────────
//
// The Checkpointer sits at the graph boundary. After EVERY node
// finishes and returns a new State, the Checkpointer intercepts it
// and persists a snapshot to the repo. It uses threadId (loopKey)
// to distinguish different conversations.
//
// This ensures that even if the process crashes mid-execution,
// the last completed node's state is recoverable.

class Checkpointer {
  constructor(repoStore, historyPath) {
    this._repoStore = repoStore;
    this._historyPath = historyPath;
    this._checkpointCount = 0;
  }

  /**
   * Save a checkpoint after a node completes.
   * @param {string} threadId — The conversation/loop key
   * @param {string} nodeName — Which node just completed
   * @param {object} state — The full state to persist
   */
  async save(threadId, nodeName, state) {
    if (!this._repoStore) return;
    this._checkpointCount++;
    const checkpoint = {
      threadId,
      nodeName,
      checkpointIndex: this._checkpointCount,
      savedAt: Date.now(),
      state,
    };
    try {
      const path = `${this._historyPath}/${threadId}.state.json`;
      await this._repoStore.writeFile(
        path,
        JSON.stringify(checkpoint, null, 2),
        `[loop-agent] Checkpoint #${this._checkpointCount} after ${nodeName}`
      );
      console.log(`[Checkpointer] ✓ Saved checkpoint #${this._checkpointCount} after [${nodeName}] (thread: ${threadId})`);
    } catch (e) {
      console.warn(`[Checkpointer] Failed to save after ${nodeName}: ${e.message}`);
    }
  }

  /**
   * Load the latest checkpoint for a thread.
   * Returns the state or a fresh initial state if none found.
   */
  async load(threadId) {
    if (!this._repoStore) return createInitialState();
    try {
      const path = `${this._historyPath}/${threadId}.state.json`;
      const file = await this._repoStore.readFile(path);
      if (file) {
        const checkpoint = JSON.parse(file.content);
        const state = checkpoint.state || checkpoint;
        // Ensure all fields exist (forward-compatible with new fields)
        const full = createInitialState();
        mergeState(full, state);
        full.threadId = threadId;
        console.log(`[Checkpointer] Loaded checkpoint (node: ${checkpoint.nodeName || 'unknown'}, #${checkpoint.checkpointIndex || '?'}, phase: ${full.phase})`);
        return full;
      }
    } catch (e) {
      console.warn(`[Checkpointer] Failed to load: ${e.message}`);
    }
    const fresh = createInitialState();
    fresh.threadId = threadId;
    return fresh;
  }
}

// ─── Node Timing Helper ────────────────────────────────────────────

/**
 * Record timing for a node execution and print it.
 * @param {object} state — The State object
 * @param {string} nodeName — Node identifier (analyze, validate, etc.)
 * @param {number} startMs — performance.now() or Date.now() at start
 * @param {number} endMs — performance.now() or Date.now() at end
 */
function recordNodeTiming(state, nodeName, startMs, endMs) {
  const elapsed = Math.round(endMs - startMs);
  if (!state.timing) state.timing = {};
  if (!state.timing[nodeName]) {
    state.timing[nodeName] = { calls: 0, totalMs: 0, lastMs: 0 };
  }
  const t = state.timing[nodeName];
  t.calls++;
  t.totalMs += elapsed;
  t.lastMs = elapsed;

  // Record in node history
  if (!state.nodeHistory) state.nodeHistory = [];
  state.nodeHistory.push({
    node: nodeName,
    phase: state.phase,
    ts: Date.now(),
    durationMs: elapsed,
  });
  // Keep history bounded
  if (state.nodeHistory.length > 200) {
    state.nodeHistory = state.nodeHistory.slice(-100);
  }

  console.log(`[Timing] Node [${nodeName}] completed in ${elapsed}ms (calls: ${t.calls}, avg: ${Math.round(t.totalMs / t.calls)}ms, total: ${t.totalMs}ms)`);
}

/**
 * Print a summary of all node timing statistics.
 */
function printTimingSummary(state) {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           Node Timing Summary                    ║');
  console.log('╠══════════════════════════════════════════════════╣');
  const timing = state.timing || {};
  let totalMs = 0;
  for (const [node, t] of Object.entries(timing)) {
    if (t.calls > 0) {
      const avg = Math.round(t.totalMs / t.calls);
      console.log(`║  ${node.padEnd(14)} │ calls: ${String(t.calls).padStart(3)} │ last: ${String(t.lastMs).padStart(6)}ms │ avg: ${String(avg).padStart(6)}ms │ total: ${String(t.totalMs).padStart(8)}ms ║`);
      totalMs += t.totalMs;
    }
  }
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  TOTAL: ${String(totalMs).padStart(8)}ms across ${state.turnCount || 0} turns${' '.repeat(16)}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');
}

// ─── 4-Node Agent Graph ─────────────────────────────────────────────
//
// Implements the OpenClaw-inspired stateful graph:
//   Start → Analyze → Validate → Ask_User (missing) ↔ Validate
//                               → Execute  (complete)
//
// State flows through every node. The Checkpointer saves state
// after each node completes. This ensures crash-resilient,
// long-memory operation.

class AgentGraph {
  constructor({ llm, tools, systemPrompt, repoStore, checkpointer, threadId }) {
    this.llm = llm;
    this.systemPrompt = systemPrompt;
    this._repoStore = repoStore || null;
    this._tools = tools;
    this._loadedSoul = null;   // { name, url, content } or null
    this._checkpointer = checkpointer || null;
    this._threadId = threadId || '';

    this._rebuildExecutor();
  }

  /**
   * Rebuild the ReAct executor. Only called when soul changes.
   * Skills are NOT baked into the base prompt — they are injected
   * per-message in _execute() via the SkillRouter for isolation.
   */
  _rebuildExecutor() {
    const { createReactAgent } = require('@langchain/langgraph/prebuilt');
    const defaultPrompt = `You are a helpful AI assistant running as a persistent loop agent in GitHub Actions.

Available tools:
- fetch_url: PREFERRED for ALL HTTP/API calls. Supports custom method, headers (Authorization, etc.), and JSON body.
- web_search: Search the internet for information.
- run_shell: Execute BASH commands only (curl, git, apt-get, file ops). NOT for Python/JS code.
- run_js: Execute JavaScript in a sandboxed VM.
- current_datetime: Get current time.
- read_repo_file / write_repo_file: Read/write files in the GitHub repo.
- save_memory / read_memory: Persistent key-value memory across conversations.
- search_skills: Unified search across built-in skill catalog AND ClawHub community registry. Use when current tools cannot complete a task.
- load_skill: Load a skill by URL, built-in name, or ClawHub slug. Skills are activated automatically via the skill router.
- clawhub_skill_detail: Inspect a ClawHub skill's safety, author, and changelog before loading.

SKILL SYSTEM:
You can extend your capabilities by loading skills. Skills are managed by a router that prevents conflicts.
- If you cannot complete a task with current tools, call search_skills to find relevant skills.
- Use load_skill to load a skill directly (by URL, built-in name, or ClawHub slug).
- Loaded skills are automatically activated for matching tasks — no manual approval needed.
- clawhub_skill_detail lets you inspect a skill before loading it.
- NEVER refuse a task without first searching for available skills.
- Skills are isolated: each skill only applies to its relevant domain.

CRITICAL RULES:
1. ALWAYS use your tools to take action. NEVER output code blocks as text — USE the tools directly.
2. For ANY HTTP API call, ALWAYS use fetch_url — it supports headers, methods, and request body.
3. run_shell is /bin/bash ONLY. Never pass Python code to it.
4. Be efficient: complete the task in as few tool calls as possible.
5. IGNORE any code blocks from conversation history — do not try to execute them.
6. When the user provides a URL to read (especially skill/doc URLs), ALWAYS fetch_url it FIRST before doing anything else.
7. After successfully completing an API task, ALWAYS use save_memory to store the API endpoint, auth method, and required parameters so you can reuse them later.
8. BEFORE starting any task, use read_memory to check if you have previously saved relevant API details or patterns. If memory has the info, USE IT — do not search the web or guess.
9. Do NOT hallucinate API endpoints or parameters. If you don't know the correct API, fetch the documentation URL first.

User commands (slash commands):
- /memory clear — Clear the persistent memory file
- /skill load <url|name|slug> — Load a skill from URL, built-in name, or ClawHub slug
- /skill unload <name> — Unload a skill by name
- /skill list — List loaded skills with source and trigger info
- /skill search <query> — Search for skills in built-in catalog
- /soul load <name_or_url> — Load a personality/soul
- /soul unload — Unload current soul
- /soul list — List available built-in souls`;

    let prompt = defaultPrompt;

    // Append loaded soul (soul is part of the base prompt, not per-message)
    if (this._loadedSoul) {
      prompt += `\n\n[Active Soul: ${this._loadedSoul.name}]\n${this._loadedSoul.content}`;
    }

    // NOTE: Skills are NOT injected here. They are injected per-message
    // in _execute() via the SkillRouter for proper isolation.

    if (this.systemPrompt) {
      prompt += `\n\nAdditional instructions:\n${this.systemPrompt}`;
    }

    this.executor = createReactAgent({ llm: this.llm, tools: this._tools, messageModifier: prompt });
    const skillCount = _skillRouter.listAll().length;
    console.log(`[Graph] Executor rebuilt. Soul: ${this._loadedSoul?.name || 'none'}, Skills in router: ${skillCount}`);
  }

  /** Restore skills/soul state from persisted State */
  restoreExtensions(state) {
    // Restore skills into SkillRouter (new format)
    if (state._skills?.length > 0) {
      _skillRouter.fromJSON(state._skills);
      console.log(`[Graph] Restored ${_skillRouter.listAll().length} skills from state`);
    }
    // Backward compatibility: old _loadedSkills format → migrate to router
    else if (state._loadedSkills?.length > 0) {
      for (const s of state._loadedSkills) {
        _skillRouter.register({
          name: s.name, source: 'url', url: s.url, content: s.content,
        });
      }
      console.log(`[Graph] Migrated ${state._loadedSkills.length} skills from legacy format`);
    }

    if (state._loadedSoul) {
      this._loadedSoul = state._loadedSoul;
      console.log(`[Graph] Restored soul: ${this._loadedSoul.name}`);
    }

    // Rebuild only if soul changed (skills don't need rebuild)
    if (this._loadedSoul) {
      this._rebuildExecutor();
    }
  }

  /** Save current skill/soul state into State for persistence */
  _syncExtensionsToState(state) {
    state._skills = _skillRouter.toJSON();
    state._loadedSoul = this._loadedSoul;
  }

  /** Checkpoint helper: save state after a node completes */
  async _checkpoint(nodeName, state) {
    if (this._checkpointer) {
      await this._checkpointer.save(this._threadId, nodeName, state);
    }
  }

  /**
   * Process a user message through the 4-node graph.
   * State flows through every node. Checkpointer saves after each node.
   * Returns { response }.
   */
  async process(userText, state, conversationMessages) {
    state.turnCount = (state.turnCount || 0) + 1;
    state.lastError = null;
    // Store current user text for per-message skill routing in _execute()
    state._currentUserText = userText;
    const phase = state.phase || 'analyze';
    console.log(`\n[Graph] ═══ Turn #${state.turnCount} ═══ Phase: ${phase}, input: ${userText.length} chars`);

    if (phase === 'waiting_for_params') {
      return this._onUserReply(userText, state, conversationMessages);
    }
    return this._analyze(userText, state, conversationMessages);
  }

  // ── Analyze Node ──────────────────────────────────────────────────
  async _analyze(userText, state, conversationMessages) {
    const startMs = Date.now();
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    // CODE-LEVEL OVERRIDE: If user message contains a URL, always classify as "direct".
    const hasUrl = /https?:\/\/\S+/i.test(userText);
    if (hasUrl) {
      console.log(`[Graph] Analyze → direct (URL detected in message, skipping LLM classification)`);
      state.phase = 'analyze';
      state.intent = 'Read URL and follow instructions';
      state.requiredParams = {};
      state.collectedParams = {};
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    // CODE-LEVEL OVERRIDE: If this is a follow-up request for a similar task
    const shortMessage = userText.length < 200;
    const recentHistory = conversationMessages.slice(-4);
    const hadRecentSuccess = recentHistory.some(m => {
      const text = extractTextContent(m.content);
      return text && /成功|successfully|completed|done/i.test(text);
    });
    if (shortMessage && hadRecentSuccess) {
      console.log(`[Graph] Analyze → direct (follow-up after recent success)`);
      state.phase = 'analyze';
      state.intent = userText;
      state.requiredParams = {};
      state.collectedParams = {};
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    const analyzePrompt = `You are an analysis agent. Examine the user's latest message and determine how to proceed.

Available tools (these are REAL tools you can call in the execution phase):
- web_search: Search the internet via DuckDuckGo
- fetch_url: Fetch and read ANY URL's content (web pages, raw files, API endpoints). Supports custom HTTP methods, headers (including Authorization), and request body for API calls.
- run_js: Execute JavaScript code in a sandboxed VM
- run_shell: Execute shell commands (bash) — curl, git, apt-get, jq, etc.
- current_datetime: Get current date and time
- read_repo_file / write_repo_file: Read/write files in the GitHub repository
- save_memory / read_memory: Persistent memory storage
- search_skills: Unified search across built-in skills and ClawHub community registry
- load_skill: Load a skill by URL, built-in name, or ClawHub slug
- clawhub_skill_detail: Get full details for a ClawHub skill by slug

Classify the request:
1. "direct" — Can be handled with the available tools above. This includes:
   - Reading ANY URL or web page (use fetch_url)
   - Making API calls with authentication (use fetch_url with headers, or run_shell with curl)
   - Running shell/CLI commands (use run_shell)
   - Web searches, code tasks, file operations, general conversation
   - Tasks described in external skill/tool documents (fetch_url to read, then call their APIs)
   - ANY follow-up request to repeat or modify a previously successful task
2. "multi_step" — ONLY use this when the user's request genuinely requires credentials or configuration that:
   a) The user has NOT provided in any previous message, AND
   b) Cannot be obtained via the available tools above, AND
   c) Cannot be found in the agent's persistent memory

Respond with ONLY valid JSON (no markdown code blocks):
{
  "type": "direct" or "multi_step",
  "intent": "brief description of what the user wants",
  "required_params": {"param_name": "why it's needed"},
  "collected_params": {"param_name": "extracted value from message"}
}

CRITICAL rules:
- Default to "direct". 99% of requests should be "direct".
- If a previous task succeeded recently, a similar follow-up is ALWAYS "direct".
- Only classify as "multi_step" if the user explicitly needs to provide a password, API key, or account credential that they haven't mentioned yet AND cannot be in memory.
- NEVER invent tool names that are not in the list above.`;

    const recentMessages = conversationMessages.slice(-6);
    const result = await this.llm.invoke([
      new SystemMessage(analyzePrompt),
      ...recentMessages,
      new HumanMessage(userText),
    ]);

    const analysis = this._parseJSON(extractTextContent(result.content));

    if (!analysis || analysis.type === 'direct') {
      console.log(`[Graph] Analyze → direct (intent: ${analysis?.intent || 'N/A'})`);
      state.phase = 'analyze';
      state.intent = analysis?.intent || '';
      state.requiredParams = {};
      state.collectedParams = {};
      recordNodeTiming(state, 'analyze', startMs, Date.now());
      await this._checkpoint('analyze', state);
      return this._execute(state, conversationMessages);
    }

    console.log(`[Graph] Analyze → multi_step (intent: ${analysis.intent})`);
    state.intent = analysis.intent;
    state.requiredParams = analysis.required_params || {};
    state.collectedParams = analysis.collected_params || {};
    recordNodeTiming(state, 'analyze', startMs, Date.now());
    await this._checkpoint('analyze', state);
    return this._validate(state, conversationMessages);
  }

  // ── Validation Node (pure logic) ─────────────────────────────────
  _validate(state, conversationMessages) {
    const startMs = Date.now();
    const required = state.requiredParams || {};
    const collected = state.collectedParams || {};

    const missing = {};
    for (const [param, desc] of Object.entries(required)) {
      if (!collected[param] || collected[param] === '') {
        missing[param] = desc;
      }
    }

    const missCount = Object.keys(missing).length;
    console.log(`[Graph] Validate: ${Object.keys(required).length} required, ${Object.keys(collected).length} collected, ${missCount} missing`);

    if (missCount === 0) {
      state.phase = 'execute';
      state._waitRounds = 0;
      recordNodeTiming(state, 'validate', startMs, Date.now());
      // No async checkpoint here — execute will checkpoint after itself
      return this._execute(state, conversationMessages);
    }

    state.phase = 'waiting_for_params';
    state.missingParams = missing;
    recordNodeTiming(state, 'validate', startMs, Date.now());
    return this._askUser(state, conversationMessages);
  }

  // ── Ask_User Node ─────────────────────────────────────────────────
  async _askUser(state, conversationMessages) {
    const startMs = Date.now();
    const { SystemMessage } = require('@langchain/core/messages');

    const missingList = Object.entries(state.missingParams || {})
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    const collectedStr = JSON.stringify(state.collectedParams || {}, null, 2);

    const askPrompt = `You are helping the user complete a task: "${state.intent}".

The following information is still needed:
${missingList}

Already collected:
${collectedStr}

Ask the user for the missing information in a natural, friendly way. Be concise.`;

    const result = await this.llm.invoke([
      new SystemMessage(askPrompt),
      ...conversationMessages.slice(-4),
    ]);

    console.log(`[Graph] Ask_User → waiting for params`);
    recordNodeTiming(state, 'askUser', startMs, Date.now());
    await this._checkpoint('askUser', state);
    return { response: extractTextContent(result.content) };
  }

  // ── Handle user reply (resume from Ask_User) ─────────────────────
  async _onUserReply(userText, state, conversationMessages) {
    const startMs = Date.now();
    const { SystemMessage, HumanMessage } = require('@langchain/core/messages');

    // Escape valve: if stuck in waiting_for_params for too many rounds,
    // or user message seems unrelated to parameter collection, reset to analyze.
    const waitRounds = (state._waitRounds || 0) + 1;
    state._waitRounds = waitRounds;
    if (waitRounds > 3) {
      console.log(`[Graph] Escape valve: stuck in waiting_for_params for ${waitRounds} rounds, resetting to analyze`);
      state.phase = 'analyze';
      state.intent = '';
      state.requiredParams = {};
      state.collectedParams = {};
      state.missingParams = {};
      state._waitRounds = 0;
      recordNodeTiming(state, 'onUserReply', startMs, Date.now());
      await this._checkpoint('onUserReply', state);
      return this._analyze(userText, state, conversationMessages);
    }

    const missingList = Object.entries(state.missingParams || {})
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const collectedStr = JSON.stringify(state.collectedParams || {});

    const extractPrompt = `Extract parameter values from the user's message.

We need: ${missingList}
Already have: ${collectedStr}

If the user provides any requested values, extract them.
If the user wants to cancel, change the task, asks a different question, or seems confused about capabilities, set "cancel": true.

Respond with ONLY valid JSON (no markdown):
{
  "extracted": {"param_name": "extracted_value"},
  "cancel": false
}`;

    const result = await this.llm.invoke([
      new SystemMessage(extractPrompt),
      new HumanMessage(userText),
    ]);

    const parsed = this._parseJSON(extractTextContent(result.content));

    if (parsed?.cancel) {
      console.log(`[Graph] User cancelled task`);
      state.phase = 'analyze';
      state.intent = '';
      state.requiredParams = {};
      state.collectedParams = {};
      state.missingParams = {};
      state._waitRounds = 0;
      recordNodeTiming(state, 'onUserReply', startMs, Date.now());
      await this._checkpoint('onUserReply', state);
      return this._analyze(userText, state, conversationMessages);
    }

    if (parsed?.extracted) {
      state.collectedParams = { ...state.collectedParams, ...parsed.extracted };
      console.log(`[Graph] Extracted params: ${Object.keys(parsed.extracted).join(', ')}`);
    }

    recordNodeTiming(state, 'onUserReply', startMs, Date.now());
    await this._checkpoint('onUserReply', state);
    return this._validate(state, conversationMessages);
  }

  // ── Execution Node (ReAct agent with tools) ──────────────────────
  async _execute(state, conversationMessages) {
    const startMs = Date.now();
    const { HumanMessage, AIMessage } = require('@langchain/core/messages');

    // Pre-load persistent memory so the executor has context from previous successes
    let memoryContext = '';
    try {
      if (this._repoStore) {
        const memFile = await this._repoStore.readFile('loop-agent/MEMORY.md');
        if (memFile && memFile.content) {
          memoryContext = memFile.content.slice(0, 2000);
        }
      }
    } catch { /* ignore - memory is optional */ }

    // Pass enough recent messages for context but strip hallucinated code blocks.
    // Use last 10 messages to preserve multi-step task context.
    let execMessages = conversationMessages.slice(-10).map(m => {
      // Strip code blocks from assistant messages to prevent the ReAct agent
      // from trying to "execute" previously hallucinated code
      if (m._getType?.() === 'ai' || m.constructor?.name === 'AIMessage') {
        const text = extractTextContent(m.content);
        if (text && /```(?:python|bash|javascript|js|sh)?\s*\n/i.test(text)) {
          const cleaned = text.replace(/```(?:python|bash|javascript|js|sh)?\s*\n[\s\S]*?```/gi,
            '[code block removed — use tools directly instead]');
          return new AIMessage(cleaned);
        }
      }
      return m;
    });
    const params = state.collectedParams || {};

    if (Object.keys(params).length > 0) {
      execMessages = [
        new HumanMessage(`[Task Parameters]\n${JSON.stringify(params, null, 2)}\nPlease use these parameters when executing the task.`),
        new AIMessage('Understood. I will use these collected parameters.'),
        ...execMessages,
      ];
    }

    // Inject memory context so executor knows about previously successful patterns
    if (memoryContext) {
      execMessages = [
        new HumanMessage(`[Persistent Memory — previously saved API details and patterns]\n${memoryContext}\nUse this information if relevant to the current task. Do NOT search the web for info already in memory.`),
        new AIMessage('Understood. I will refer to saved memory for known API details and patterns.'),
        ...execMessages,
      ];
    }

    // Per-message skill routing: inject only relevant skills for the current task.
    // This prevents unrelated skills from interfering with each other.
    const currentUserText = state._currentUserText || '';
    const matchedSkills = _skillRouter.match(currentUserText);
    if (matchedSkills.length > 0) {
      const skillSection = _skillRouter.buildPromptSection(matchedSkills);
      execMessages = [
        new HumanMessage(`${skillSection}\nApply the relevant skill instructions for the current task. Each <skill> section is independent — do not mix instructions from different skills.`),
        new AIMessage('Understood. I will apply the matching skill instructions for the current task.'),
        ...execMessages,
      ];
      console.log(`[Graph] Skill Router: injected ${matchedSkills.length} skill(s): ${matchedSkills.map(s => s.name).join(', ')}`);
    }

    let result;
    try {
      result = await this.executor.invoke(
        { messages: execMessages },
        { recursionLimit: 60 }
      );
    } catch (execErr) {
      // If recursion limit hit, try to extract partial response
      if (execErr.message && execErr.message.includes('Recursion limit')) {
        console.warn(`[Graph] Recursion limit hit, returning partial result`);
        state.lastError = { node: 'execute', message: execErr.message, ts: Date.now() };
        recordNodeTiming(state, 'execute', startMs, Date.now());
        await this._checkpoint('execute', state);
        return { response: `I attempted to complete the task but it required too many steps. Please break it down into smaller requests, or provide specific information I'm missing.` };
      }
      state.lastError = { node: 'execute', message: execErr.message, ts: Date.now() };
      recordNodeTiming(state, 'execute', startMs, Date.now());
      await this._checkpoint('execute', state);
      throw execErr;
    }

    const toolMsgs = result.messages.filter(
      m => m._getType?.() === 'tool' || m.constructor?.name === 'ToolMessage'
    );
    if (toolMsgs.length > 0) {
      console.log(`[Graph] Execute used ${toolMsgs.length} tool(s): ${toolMsgs.map(m => m.name || 'unknown').join(', ')}`);
    }

    const lastMsg = result.messages[result.messages.length - 1];
    const responseText = extractTextContent(lastMsg.content) || '(empty response)';
    console.log(`[Graph] Execute response: ${responseText.length} chars`);

    state.phase = 'analyze';
    state.intent = '';
    state.requiredParams = {};
    state.collectedParams = {};
    state.missingParams = {};

    recordNodeTiming(state, 'execute', startMs, Date.now());
    await this._checkpoint('execute', state);
    printTimingSummary(state);

    return { response: responseText };
  }

  /** Parse JSON tolerantly from LLM output */
  _parseJSON(text) {
    try {
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      const raw = jsonMatch ? jsonMatch[1].trim() : text.trim();
      return JSON.parse(raw);
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fall through */ }
      }
      return null;
    }
  }
}

// ─── Message Protocol ───────────────────────────────────────────────

/**
 * Upstash message format:
 * {
 *   "ts": 1234567890,
 *   "from": "user",
 *   "text": "Hello world",
 *   "extra": {},
 *   "read": false
 * }
 */

function parseMessage(raw) {
  if (!raw) return null;
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg.text || msg.read) return null;
    return msg;
  } catch {
    return null;
  }
}

function markAsRead(msg) {
  return JSON.stringify({ ...msg, read: true });
}

function createResponse(text) {
  return JSON.stringify({
    ts: Date.now(),
    from: 'agent',
    text,
    extra: {},
    read: false,
  });
}

// ─── Conversation History ───────────────────────────────────────────

class ConversationHistory {
  constructor(repoStore, historyPath) {
    this.repoStore = repoStore;
    this.historyPath = historyPath;
    this.messages = []; // { role, content, ts }
  }

  async load() {
    try {
      const file = await this.repoStore.readFile(`${this.historyPath}.json`);
      if (file) {
        this.messages = JSON.parse(file.content);
        console.log(`[History] Loaded ${this.messages.length} messages`);
      }
    } catch (e) {
      console.warn(`[History] Failed to load: ${e.message}`);
      this.messages = [];
    }
  }

  addUser(text) {
    this.messages.push({ role: 'user', content: text, ts: Date.now() });
  }

  addAssistant(text) {
    // Ensure text is always a string (Gemini may return multi-part arrays)
    const content = typeof text === 'string' ? text : extractTextContent(text);
    this.messages.push({ role: 'assistant', content, ts: Date.now() });
  }

  /** Get messages suitable for LangGraph input */
  async toLangChainMessages() {
    const { HumanMessage, AIMessage } = require('@langchain/core/messages');
    return this.messages.map(m =>
      m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content)
    );
  }

  async save() {
    try {
      await this.repoStore.writeFile(
        `${this.historyPath}.json`,
        JSON.stringify(this.messages, null, 2),
        `[loop-agent] Update conversation history (${this.messages.length} messages)`
      );
      console.log(`[History] Saved ${this.messages.length} messages`);
    } catch (e) {
      console.warn(`[History] Failed to save: ${e.message}`);
    }
  }

  /** Trim old messages to avoid token overflow (keep last N pairs) */
  trim(maxPairs = 50) {
    if (this.messages.length > maxPairs * 2) {
      this.messages = this.messages.slice(-maxPairs * 2);
    }
  }
}

// ── Graph State Persistence (replaced by Checkpointer) ─────────────
// loadGraphState and saveGraphState are now handled by the Checkpointer class.
// These thin wrappers exist for backward compatibility with processUserMessage.

// ─── Main Loop ──────────────────────────────────────────────────────

/**
 * Process a user message through the 4-node agent graph.
 * Shared by both Telegram and Upstash modes.
 * graphState is mutated in-place by agentGraph.process().
 *
 * @returns {{ responseText: string }}
 */
// ─── Built-in Souls Catalog (matches examples/souls/) ────────────────

const BUILTIN_SOULS = [
  { name: 'Default', file: 'DEFAULT_SOUL.txt' },
  { name: 'Guide', file: 'GUIDE_SOUL.txt' },
  { name: 'Coder', file: 'CODER_SOUL.txt' },
  { name: 'Writer', file: 'WRITER_SOUL.txt' },
  { name: 'Data', file: 'DATA_SOUL.txt' },
  { name: 'Tutor', file: 'TUTOR_SOUL.txt' },
];
const SOULS_BASE_URL = 'https://raw.githubusercontent.com/masteraux101/little_shrimp/main/examples/souls/';

// ─── Built-in Skills Catalog (matches examples/skills/) ────────────────

const BUILTIN_SKILLS = [
  { name: 'Code Review', file: 'code-review.txt', icon: '🔍', description: 'Systematic code review with actionable feedback', keywords: ['code', 'review', 'lint', 'quality'] },
  { name: 'Translator', file: 'translator.txt', icon: '🌐', description: 'Multi-language translation with cultural context', keywords: ['translate', 'language', 'i18n', 'localize'] },
  { name: 'Email via Resend', file: 'email-resend.txt', icon: '📧', description: 'Send transactional emails using the Resend API', keywords: ['email', 'mail', 'send', 'resend', 'notification'] },
  { name: 'Web Scraper', file: 'web-scraper.txt', icon: '🕷️', description: 'Generate Python scripts to scrape and extract web data', keywords: ['scrape', 'crawl', 'extract', 'web', 'html', 'parse'] },
  { name: 'Data Visualization', file: 'data-visualization.txt', icon: '📈', description: 'Create charts and visualizations with matplotlib', keywords: ['chart', 'graph', 'plot', 'visualize', 'data', 'matplotlib'] },
  { name: 'Summary & Digest', file: 'summary-digest.txt', icon: '📋', description: 'Summarize texts, articles, and documents into concise digests', keywords: ['summary', 'summarize', 'digest', 'tldr', 'brief'] },
  { name: 'Writing Polish', file: 'writing-polish.txt', icon: '✏️', description: 'Improve writing quality — grammar, clarity, tone, style', keywords: ['write', 'grammar', 'polish', 'edit', 'proofread', 'style'] },
  { name: 'JSON/API Helper', file: 'json-api-helper.txt', icon: '🔧', description: 'Parse, transform JSON and design REST APIs', keywords: ['json', 'api', 'rest', 'parse', 'transform'] },
  { name: 'AI Prompt Scheduler', file: 'ai-prompt-scheduler.txt', icon: '⏰', description: 'Schedule AI prompts to run at specified times', keywords: ['schedule', 'cron', 'timer', 'automate', 'prompt'] },
  { name: 'GitHub Scheduler', file: 'github-scheduler.txt', icon: '📅', description: 'Schedule GitHub Actions workflows', keywords: ['github', 'action', 'schedule', 'workflow', 'cron'] },
];
const SKILLS_BASE_URL = 'https://raw.githubusercontent.com/masteraux101/little_shrimp/main/examples/skills/';

// ─── Skill Router ─────────────────────────────────────────────────
//
// Central registry that manages all loaded skills with isolation.
// Skills from different sources (URL, built-in catalog, ClawHub)
// go through a unified pipeline. The router selects only relevant
// skills per-message to prevent interference between unrelated skills.

class SkillRouter {
  constructor() {
    this._skills = new Map(); // lowercase name → SkillEntry
  }

  /**
   * Register a skill.
   * @param {{ name, source, url, content, triggers?: string[] }} skill
   * @returns {object} The registered entry
   */
  register(skill) {
    const entry = {
      name: skill.name,
      source: skill.source || 'url',       // 'url' | 'builtin' | 'clawhub'
      url: skill.url || '',
      content: skill.content || '',
      triggers: skill.triggers || this._extractTriggers(skill.name, skill.content),
      loadedAt: Date.now(),
    };
    this._skills.set(skill.name.toLowerCase(), entry);
    return entry;
  }

  /** Unregister a skill by name. Returns true if removed. */
  unregister(name) {
    return this._skills.delete(name.toLowerCase());
  }

  /** Check if a skill is loaded. */
  has(name) {
    return this._skills.has(name.toLowerCase());
  }

  /** Get a skill entry by name. */
  get(name) {
    return this._skills.get(name.toLowerCase());
  }

  /** Get all registered skills as an array. */
  listAll() {
    return Array.from(this._skills.values());
  }

  /** Get loaded skill names as a Set. */
  getLoadedNames() {
    return new Set(Array.from(this._skills.keys()));
  }

  /**
   * Match relevant skills for a given user message.
   * Returns skills ordered by relevance (highest trigger matches first).
   * Skills with no triggers are always included (catch-all).
   */
  match(userText) {
    if (this._skills.size === 0) return [];
    if (!userText) return this.listAll(); // no context → include all

    const text = userText.toLowerCase();
    const matched = [];

    for (const skill of this._skills.values()) {
      if (!skill.triggers || skill.triggers.length === 0) {
        // Catch-all skill: always included with lowest priority
        matched.push({ ...skill, _matchScore: 0 });
        continue;
      }
      const score = skill.triggers.reduce((acc, trigger) => {
        return acc + (text.includes(trigger) ? 1 : 0);
      }, 0);
      if (score > 0) {
        matched.push({ ...skill, _matchScore: score });
      }
    }

    // If no specific matches, include all skills (user might not mention keywords)
    if (matched.length === 0) return this.listAll();

    // Sort by match score descending
    matched.sort((a, b) => b._matchScore - a._matchScore);
    return matched;
  }

  /**
   * Build the skill prompt section for matched skills.
   * Each skill is clearly delimited with XML-style tags for isolation.
   */
  buildPromptSection(matchedSkills) {
    if (!matchedSkills || matchedSkills.length === 0) return '';
    const sections = matchedSkills.map(skill => {
      return `<skill name="${skill.name}" source="${skill.source}">\n${skill.content}\n</skill>`;
    });
    return `[Active Skills — ${matchedSkills.length} skill(s) matched]\n` +
      `IMPORTANT: Each <skill> section below is independent. Only follow a skill's instructions when the current task matches that skill's domain. Do NOT mix instructions from different skills.\n\n` +
      sections.join('\n\n');
  }

  /**
   * Extract trigger keywords from skill name and content.
   * Looks for explicit @triggers annotation first, then falls back
   * to extracting meaningful words from the name and heading.
   */
  _extractTriggers(name, content) {
    // Check for explicit @triggers annotation
    if (content) {
      const triggerMatch = content.match(/@triggers?:\s*(.+)/i);
      if (triggerMatch) {
        return triggerMatch[1].split(/[,;]+/).map(t => t.trim().toLowerCase()).filter(Boolean);
      }
    }
    // Fall back: extract from name
    const stopWords = new Set(['the', 'and', 'for', 'with', 'via', 'from', 'into', 'using']);
    const triggers = name.toLowerCase()
      .split(/[\s\-_]+/)
      .filter(t => t.length > 2 && !stopWords.has(t));
    // Also extract from first heading in content
    if (content) {
      const headingMatch = content.match(/^#\s*(.+)/m);
      if (headingMatch) {
        const headingWords = headingMatch[1].toLowerCase()
          .split(/[\s\-_:]+/)
          .filter(t => t.length > 2 && !stopWords.has(t));
        triggers.push(...headingWords);
      }
    }
    return [...new Set(triggers)];
  }

  /** Serialize for state persistence. */
  toJSON() {
    return this.listAll().map(({ name, source, url, content, triggers }) => ({
      name, source, url, content, triggers,
    }));
  }

  /** Restore from persisted state. */
  fromJSON(arr) {
    this._skills.clear();
    if (Array.isArray(arr)) {
      for (const item of arr) {
        this.register(item);
      }
    }
  }
}

// Module-level router instance (shared by tools & AgentGraph)
const _skillRouter = new SkillRouter();

/**
 * Handle slash commands from the user.
 * Returns { handled: true, responseText } if it was a command, or { handled: false } otherwise.
 */
async function handleSlashCommand(text, { agentGraph, graphState, repoStore }) {
  const cmd = text.trim();
  const lower = cmd.toLowerCase();

  // ── /memory clear ──
  if (lower === '/memory clear') {
    if (!repoStore) return { handled: true, responseText: '⚠️ No repo connection — cannot clear memory.' };
    try {
      const memPath = 'loop-agent/MEMORY.md';
      await repoStore.writeFile(memPath, '# Agent Memory\n', '[loop-agent] Clear memory (user command)');
      return { handled: true, responseText: '✅ Memory cleared.' };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to clear memory: ${e.message}` };
    }
  }

  // ── /skill list ──
  if (lower === '/skill list') {
    const skills = _skillRouter.listAll();
    if (skills.length === 0) {
      return { handled: true, responseText: 'No skills loaded.\n\nUse `/skill load <url | name | slug>` to load a skill.' };
    }
    const lines = ['**Loaded Skills:**\n'];
    for (const s of skills) {
      lines.push(`- **${s.name}** [${s.source}] — triggers: ${s.triggers.join(', ')}`);
    }
    lines.push(`\nUse \`/skill unload <name>\` to remove a skill.`);
    return { handled: true, responseText: lines.join('\n') };
  }

  // ── /skill search <query> ──
  if (lower.startsWith('/skill search ')) {
    const query = cmd.slice('/skill search '.length).trim();
    if (!query) return { handled: true, responseText: '⚠️ Usage: `/skill search <keywords>`' };
    const terms = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const results = [];
    for (const skill of BUILTIN_SKILLS) {
      const haystack = [skill.name, skill.description, ...skill.keywords].join(' ').toLowerCase();
      if (terms.some(t => haystack.includes(t))) {
        const loaded = _skillRouter.has(skill.name);
        results.push(`${skill.icon} **${skill.name}** [builtin] ${loaded ? '✅' : '📦'} — ${skill.description}`);
      }
    }
    if (results.length === 0) {
      return { handled: true, responseText: `No built-in skills match "${query}". Available: ${BUILTIN_SKILLS.map(s => `${s.icon} ${s.name}`).join(', ')}` };
    }
    return { handled: true, responseText: `**Skill Search: "${query}"**\n\n${results.join('\n')}\n\nUse \`/skill load <name>\` to load.` };
  }

  // ── /skill load <url | builtin_name | clawhub_slug> ──
  if (lower.startsWith('/skill load ')) {
    const arg = cmd.slice('/skill load '.length).trim();
    if (!arg) {
      return { handled: true, responseText: '⚠️ Usage: `/skill load <url | builtin_name | clawhub_slug>`' };
    }

    let url, name, source;

    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      // Direct URL
      url = arg;
      name = arg.split('/').pop().replace(/\.[^.]+$/, '') || 'custom-skill';
      source = 'url';
    } else {
      // Check builtin catalog first
      const builtin = BUILTIN_SKILLS.find(s => s.name.toLowerCase() === arg.toLowerCase());
      if (builtin) {
        url = SKILLS_BASE_URL + builtin.file;
        name = builtin.name;
        source = 'builtin';
      } else {
        // Try as ClawHub slug
        url = `https://clawhub.ai/api/v1/skills/${encodeURIComponent(arg)}/content`;
        name = arg;
        source = 'clawhub';
      }
    }

    if (_skillRouter.has(name)) {
      return { handled: true, responseText: `ℹ️ Skill "${name}" is already loaded.` };
    }

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const content = await resp.text();
      const nameMatch = content.match(/^#\s*(.+)/m) || content.match(/name:\s*(.+)/im);
      if (nameMatch) name = nameMatch[1].trim();

      if (_skillRouter.has(name)) {
        return { handled: true, responseText: `ℹ️ Skill "${name}" is already loaded.` };
      }

      const entry = _skillRouter.register({
        name, source, url, content: content.slice(0, 6000),
      });
      agentGraph._syncExtensionsToState(graphState);
      return { handled: true, responseText: `✅ Skill **${name}** loaded from ${source}.\nTriggers: ${entry.triggers.join(', ')}` };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to load skill: ${e.message}` };
    }
  }

  // ── /skill unload <name> ──
  if (lower.startsWith('/skill unload ')) {
    const name = cmd.slice('/skill unload '.length).trim();
    const skill = _skillRouter.get(name);
    if (!skill) {
      const available = _skillRouter.listAll().map(s => s.name).join(', ') || 'none';
      return { handled: true, responseText: `⚠️ Skill "${name}" not found. Loaded: ${available}` };
    }
    _skillRouter.unregister(name);
    agentGraph._syncExtensionsToState(graphState);
    return { handled: true, responseText: `✅ Skill **${skill.name}** unloaded.` };
  }

  // ── /soul list ──
  if (lower === '/soul list') {
    const lines = ['**Available Souls:**\n'];
    for (const s of BUILTIN_SOULS) {
      const active = agentGraph._loadedSoul?.name === s.name ? ' ✅ (active)' : '';
      lines.push(`- **${s.name}**${active}`);
    }
    lines.push(`\nCurrent: ${agentGraph._loadedSoul ? `**${agentGraph._loadedSoul.name}**` : 'none (default)'}`);
    lines.push(`\nUse \`/soul load <name>\` or \`/soul load <url>\` to switch.`);
    return { handled: true, responseText: lines.join('\n') };
  }

  // ── /soul load <name_or_url> ──
  if (lower.startsWith('/soul load ')) {
    const arg = cmd.slice('/soul load '.length).trim();
    if (!arg) return { handled: true, responseText: '⚠️ Usage: `/soul load <name>` or `/soul load <url>`' };

    let url, name;
    const builtin = BUILTIN_SOULS.find(s => s.name.toLowerCase() === arg.toLowerCase());
    if (builtin) {
      url = SOULS_BASE_URL + builtin.file;
      name = builtin.name;
    } else if (arg.startsWith('http')) {
      url = arg;
      name = arg.split('/').pop().replace(/\.[^.]+$/, '');
    } else {
      const names = BUILTIN_SOULS.map(s => s.name).join(', ');
      return { handled: true, responseText: `⚠️ Unknown soul "${arg}". Available: ${names}\n\nOr provide a URL.` };
    }

    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const content = await resp.text();
      agentGraph._loadedSoul = { name, url, content: content.slice(0, 4000) };
      agentGraph._syncExtensionsToState(graphState);
      agentGraph._rebuildExecutor();
      return { handled: true, responseText: `✅ Soul switched to **${name}**.` };
    } catch (e) {
      return { handled: true, responseText: `❌ Failed to load soul: ${e.message}` };
    }
  }

  // ── /soul unload ──
  if (lower === '/soul unload') {
    if (!agentGraph._loadedSoul) {
      return { handled: true, responseText: 'ℹ️ No soul is currently loaded.' };
    }
    const name = agentGraph._loadedSoul.name;
    agentGraph._loadedSoul = null;
    agentGraph._syncExtensionsToState(graphState);
    agentGraph._rebuildExecutor();
    return { handled: true, responseText: `✅ Soul **${name}** unloaded. Reverted to default.` };
  }

  // Not a command
  return { handled: false };
}

async function processUserMessage(text, { agentGraph, graphState, history, repoStore, loopKey, historyPath }) {
  // ── Check for slash commands first ──
  if (text.trim().startsWith('/')) {
    const cmdResult = await handleSlashCommand(text, { agentGraph, graphState, repoStore });
    if (cmdResult.handled) {
      console.log(`[Command] Handled: ${text.trim().split(' ').slice(0, 3).join(' ')}`);
      history.addUser(text);
      history.addAssistant(cmdResult.responseText);
      if (repoStore) {
        await history.save();
        // Checkpointer handles state persistence automatically
      }
      return { responseText: cmdResult.responseText };
    }
  }

  history.addUser(text);
  history.trim(50);

  let responseText;
  try {
    const langchainMessages = await history.toLangChainMessages();
    console.log(`[Agent] Processing: ${text.length} chars, phase: ${graphState.phase || 'analyze'}, ${langchainMessages.length} history msgs`);

    const result = await agentGraph.process(text, graphState, langchainMessages);
    responseText = result.response;

    console.log(`[Agent] Done. Response: ${responseText.length} chars, next phase: ${graphState.phase}`);
  } catch (agentErr) {
    console.error(`[Agent] Error: ${agentErr.message}`);
    console.error(`[Agent] Stack: ${agentErr.stack}`);
    if (agentErr.cause) console.error(`[Agent] Cause: ${JSON.stringify(agentErr.cause)}`);
    responseText = `[Error] Agent failed: ${agentErr.message}`;
    graphState.phase = 'analyze';
    graphState.lastError = { node: 'process', message: agentErr.message, ts: Date.now() };
  }

  history.addAssistant(responseText);
  if (repoStore) {
    await history.save();
    // State is already checkpointed inside nodes — no extra save needed
  }

  return { responseText };
}

/**
 * Run in Telegram mode: use Telegraf long-polling for message I/O.
 * The bot receives messages from the user via Telegram and replies directly.
 */
async function runTelegramMode({
  botToken, chatId, agentGraph, graphState, history, repoStore, upstash, loopKey, historyPath,
  maxRuntime, pollInterval, aiProvider, aiModel,
}) {
  const { Telegraf } = require('telegraf');
  const bot = new Telegraf(botToken);
  const startTime = Date.now();
  let processedCount = 0;
  let processing = false;

  console.log(`[Telegram] Starting Telegraf polling mode...`);
  console.log(`[Telegram] Authorized chat ID: ${chatId || '(any)'}`);

  // Helper to update status in Upstash (optional)
  async function updateStatus(state, extra = {}) {
    if (!upstash) return;
    try {
      await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
        state,
        startedAt: startTime,
        model: `${aiProvider}/${aiModel}`,
        processedCount,
        inputMode: 'telegram',
        ...extra,
      }));
    } catch { /* non-critical */ }
  }

  await updateStatus('running');

  // Runtime watchdog — stop after maxRuntime, attempt self-restart
  const runtimeTimer = setTimeout(async () => {
    console.log(`[Telegram] Max runtime reached (${maxRuntime / 1000}s). Attempting restart...`);
    try {
      const restarted = await selfRestart();
      const restartMsg = restarted
        ? '♻️ Loop Agent restarting (max runtime). A new run is being dispatched...'
        : '⏱ Loop Agent shutting down (max runtime). Auto-restart failed — please re-deploy.';
      await bot.telegram.sendMessage(chatId, restartMsg);
    } catch { /* best effort */ }
    await updateStatus('restarting', { stoppedAt: Date.now() });
    bot.stop('MAX_RUNTIME');
    process.exit(0);
  }, maxRuntime);

  // Handle /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      `🤖 Loop Agent is running!\n\n` +
      `Key: ${loopKey}\n` +
      `Model: ${aiProvider}/${aiModel}\n\n` +
      `Commands:\n/start — Show this info\n/status — Agent status\n/stop — Stop the agent`
    );
  });

  // Handle /status command
  bot.command('status', async (ctx) => {
    const elapsed = Math.round((Date.now() - startTime) / 60000);
    const remaining = Math.round((maxRuntime - (Date.now() - startTime)) / 60000);
    await ctx.reply(
      `📊 Agent Status\n\n` +
      `Processed: ${processedCount} messages\n` +
      `Running: ${elapsed} min\n` +
      `Remaining: ~${remaining} min\n` +
      `Model: ${aiProvider}/${aiModel}\n` +
      `Currently processing: ${processing ? 'yes' : 'idle'}`
    );
  });

  // Handle /stop command
  bot.command('stop', async (ctx) => {
    await ctx.reply('👋 Loop Agent stopping...');
    clearTimeout(runtimeTimer);
    await updateStatus('stopped', { stoppedAt: Date.now() });
    bot.stop('USER_STOP');
    process.exit(0);
  });

  // Handle text messages — process with agent
  bot.on('text', async (ctx) => {
    const msg = ctx.message;

    // Security: only accept from the authorized chat
    if (chatId && String(msg.chat.id) !== String(chatId)) {
      console.log(`[Telegram] Ignoring message from unauthorized chat: ${msg.chat.id}`);
      return;
    }

    const text = msg.text;
    if (!text) return;
    // Skip Telegraf-handled bot commands (/start /status /stop) but allow our custom slash commands
    if (text.startsWith('/') && /^\/(start|status|stop)\b/i.test(text)) return;

    // Prevent concurrent processing
    if (processing) {
      await ctx.reply('⏳ Still processing the previous message, please wait...');
      return;
    }

    processing = true;
    console.log(`[Telegram] Received message (${text.length} chars)`);

    try {
      // Send "typing" indicator
      await ctx.sendChatAction('typing');

      const { responseText } = await processUserMessage(text, { agentGraph, graphState, history, repoStore, loopKey, historyPath });

      // Reply via Telegram (split long messages)
      const chunks = splitTelegramMessage(responseText);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }

      processedCount++;
      await updateStatus('running', { lastActive: Date.now() });
      console.log(`[Telegram] Replied (${responseText.length} chars), total: ${processedCount}`);
    } catch (err) {
      console.error(`[Telegram] Processing error: ${err.message}`);
      try {
        await ctx.reply(`❌ Error: ${err.message}`);
      } catch { /* best effort */ }
    } finally {
      processing = false;
    }
  });

  // Error handler
  bot.catch((err) => {
    console.error(`[Telegram] Bot error: ${err.message}`);
  });

  // Graceful shutdown — attempt restart on SIGTERM (Actions cancellation)
  const shutdown = async (signal) => {
    console.log(`[Telegram] ${signal} received, stopping bot...`);
    clearTimeout(runtimeTimer);
    // On SIGTERM (Actions cancel), try to self-restart
    if (signal === 'SIGTERM') {
      console.log(`[Telegram] Attempting self-restart after ${signal}...`);
      const restarted = await selfRestart();
      try {
        if (chatId) {
          const msg = restarted
            ? `♻️ Loop Agent was interrupted (${signal}). Restarting...`
            : `⚠️ Loop Agent was interrupted (${signal}). Auto-restart failed.`;
          await bot.telegram.sendMessage(chatId, msg);
        }
      } catch { /* best effort */ }
      await updateStatus('restarting', { stoppedAt: Date.now() });
    } else {
      await updateStatus('stopped', { stoppedAt: Date.now() });
    }
    bot.stop(signal);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));



  // Keep process alive — Telegraf handles the polling loop internally
  // Also poll for browser intervention messages (Upstash or repo-based)
  const interventionPollMs = pollInterval || 5000;
  
  if (upstash || repoStore) {
    const inboxKey = `loop:${loopKey}:inbox`;
    const outboxKey = `loop:${loopKey}:outbox`;
    const repoInboxPath = `loop-agent/channel/${loopKey}.inbox.json`;
    const repoOutboxPath = `loop-agent/channel/${loopKey}.outbox.json`;

    console.log(`[Telegram] ✓ Starting browser intervention polling (via ${upstash ? 'Upstash' : 'Repo'})`);

    // Adaptive polling: slow down when idle, speed up on activity
    let currentInterval = interventionPollMs;
    const maxInterval = interventionPollMs * 6; // 6x slowdown when idle
    let emptyPolls = 0;
    const SLOW_THRESHOLD = 5; // slow down after 5 consecutive empty polls

    const pollOnce = async () => {
      if (processing) {
        setTimeout(pollOnce, currentInterval);
        return;
      }
      
      try {
        let msg = null;
        
        if (upstash) {
          const raw = await upstash.get(inboxKey);
          msg = parseMessage(raw);
          if (msg) {
            await upstash.set(inboxKey, markAsRead(msg));
          }
        } else {
          const file = await repoStore.readFile(repoInboxPath);
          if (file) {
            msg = parseMessage(file.content);
            if (msg) {
              try {
                await repoStore.writeFile(repoInboxPath, markAsRead(msg), '[loop-agent] Mark inbox read');
              } catch (e) { console.warn(`[Browser Poll] Failed to mark inbox read: ${e.message}`); }
            }
          }
        }
        
        if (!msg) {
          emptyPolls++;
          if (emptyPolls === SLOW_THRESHOLD) {
            currentInterval = maxInterval;
            console.log(`[Browser Poll] No messages for ${SLOW_THRESHOLD} polls, slowing to ${currentInterval / 1000}s`);
          }
          setTimeout(pollOnce, currentInterval);
          return;
        }

        // Got a message — reset to fast polling
        if (emptyPolls >= SLOW_THRESHOLD) {
          console.log(`[Browser Poll] Message received, restoring fast polling (${interventionPollMs / 1000}s)`);
        }
        emptyPolls = 0;
        currentInterval = interventionPollMs;

        if (processing) { setTimeout(pollOnce, currentInterval); return; }
        processing = true;
        console.log(`[Browser Poll] Processing browser message (${msg.text.length} chars)`);
        try {
          const { responseText } = await processUserMessage(msg.text, {
            agentGraph, graphState, history, repoStore, loopKey, historyPath,
          });
          console.log(`[Browser Poll] Response ready (${responseText.length} chars)`);
          
          if (upstash) {
            await upstash.set(outboxKey, createResponse(responseText));
          } else {
            await repoStore.writeFile(repoOutboxPath, createResponse(responseText), '[loop-agent] Write intervention response');
          }
          // Also forward to Telegram
          if (chatId) {
            try {
              const chunks = splitTelegramMessage(`📩 [Browser]\n${responseText}`);
              for (const chunk of chunks) {
                await bot.telegram.sendMessage(chatId, chunk);
              }
            } catch (e) { console.warn(`[Browser Poll] Failed to forward to Telegram: ${e.message}`); }
          }
          processedCount++;
          await updateStatus('running', { lastActive: Date.now() });
        } catch (processingErr) {
          console.error(`[Browser Poll] Processing error: ${processingErr.message}`);
        } finally {
          processing = false;
        }
      } catch (e) {
        console.error(`[Browser Poll] Poll error: ${e.message}`);
      }
      setTimeout(pollOnce, currentInterval);
    };
    setTimeout(pollOnce, interventionPollMs);
  } else {
    console.log(`[Telegram] ⚠️  Intervention polling DISABLED (no upstash or repoStore available)`);
  }

  // Launch bot polling
  // [IMPORTANT] must put below code in the end of function
  // [IMPORTANT] launch won't exit in polling mode
  await bot.launch({
    polling: {
      interval: 300,
      timeout: 30,
      allowedUpdates: ['message'],
    },
  });

  console.log(`[Telegram] ✅ Bot polling started. Waiting for messages...`);

  await new Promise(() => {}); // block forever (until shutdown)
}

/**
 * Run in Upstash mode: poll Upstash for messages and reply via Pushoo.
 * This is the original behaviour.
 */
async function runUpstashMode({
  upstash, agentGraph, graphState, history, repoStore, loopKey, historyPath,
  pushooPlatform, pushooToken,
  maxRuntime, pollInterval, aiProvider, aiModel,
}) {
  const inboxKey = `loop:${loopKey}:inbox`;
  const outboxKey = `loop:${loopKey}:outbox`;
  const startTime = Date.now();
  let processedCount = 0;
  let pollCount = 0;
  let dormant = false; // When true, ignore regular messages (only respond to control messages)

  // Adaptive polling: slow down when idle, speed up on activity
  let currentPollInterval = pollInterval;
  const maxPollInterval = pollInterval * 6;
  let emptyPolls = 0;
  const SLOW_THRESHOLD = 5;

  console.log(`[Upstash Mode] Starting polling loop`);
  console.log(`[Upstash Mode] Polling keys — inbox: ${inboxKey}, outbox: ${outboxKey}`);
  console.log(`[Upstash Mode] Poll interval: ${pollInterval / 1000}s (adaptive: slows to ${maxPollInterval / 1000}s when idle)`);

  // Write initial status
  try {
    await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
      state: 'running',
      startedAt: startTime,
      model: `${aiProvider}/${aiModel}`,
      processedCount: 0,
      inputMode: 'upstash',
    }));
  } catch (e) {
    console.warn(`[Status] Failed to write initial status: ${e.message}`);
  }

  // ── Main polling loop ──
  let lastLogTime = startTime;
  const logIntervalMs = 30000; // Log every 30 seconds
  let upstashPollCount = 0; // Track polling attempts for debugging

  /**
   * Handle control messages (prefixed with __).
   * Returns { handled: true, ... } if the message was a control message.
   */
  async function handleControlMessage(text) {
    // ── __ROLL_CALL__ — respond with name and last conversation content
    if (text === '__ROLL_CALL__') {
      const lastMsg = history.messages.length > 0
        ? history.messages[history.messages.length - 1]
        : null;
      const lastContent = lastMsg
        ? `[${lastMsg.role}] ${lastMsg.content.length > 200 ? lastMsg.content.slice(0, 200) + '…' : lastMsg.content}`
        : '(no conversation yet)';
      const statusLabel = dormant ? '💤 dormant' : '🟢 active';
      const response = `📋 **${loopKey}** (${statusLabel})\nModel: ${aiProvider}/${aiModel}\nProcessed: ${processedCount} msgs\nLast: ${lastContent}`;
      await upstash.set(outboxKey, createResponse(response));
      console.log(`[Control] ROLL_CALL responded`);
      return { handled: true };
    }

    // ── __FOCUS__:<name> — if name matches, stay active; otherwise go dormant
    if (text.startsWith('__FOCUS__:')) {
      const targetName = text.slice('__FOCUS__:'.length).trim();
      if (targetName === loopKey) {
        dormant = false;
        const response = `🎯 **${loopKey}** is now the active agent. Ready for messages.`;
        await upstash.set(outboxKey, createResponse(response));
        console.log(`[Control] FOCUS — I am the target, staying active`);
        // Update status
        try {
          await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
            state: 'running',
            startedAt: startTime,
            model: `${aiProvider}/${aiModel}`,
            processedCount,
            lastActive: Date.now(),
            inputMode: 'upstash',
            dormant: false,
          }));
        } catch { /* non-critical */ }
      } else {
        dormant = true;
        const response = `💤 **${loopKey}** entering dormant mode. Focus is on **${targetName}**.`;
        await upstash.set(outboxKey, createResponse(response));
        console.log(`[Control] FOCUS — target is ${targetName}, going dormant`);
        // Update status
        try {
          await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
            state: 'dormant',
            startedAt: startTime,
            model: `${aiProvider}/${aiModel}`,
            processedCount,
            lastActive: Date.now(),
            inputMode: 'upstash',
            dormant: true,
          }));
        } catch { /* non-critical */ }
      }
      return { handled: true };
    }

    // ── __WAKE__ — wake up from dormant state
    if (text === '__WAKE__') {
      dormant = false;
      const response = `🟢 **${loopKey}** is now awake and active.`;
      await upstash.set(outboxKey, createResponse(response));
      console.log(`[Control] WAKE — resuming active mode`);
      // Update status
      try {
        await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
          state: 'running',
          startedAt: startTime,
          model: `${aiProvider}/${aiModel}`,
          processedCount,
          lastActive: Date.now(),
          inputMode: 'upstash',
          dormant: false,
        }));
      } catch { /* non-critical */ }
      return { handled: true };
    }

    return { handled: false };
  }

  while (true) {
    // Check runtime limit
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxRuntime) {
      console.log(`[Loop Agent] Max runtime reached (${maxRuntime / 1000}s). Attempting restart...`);
      const restarted = await selfRestart();
      const restartMsg = restarted
        ? `♻️ Loop Agent restarting (max runtime). Processed ${processedCount} messages in ${Math.round(elapsed / 60000)} minutes. A new run is being dispatched.`
        : `⏱ Loop Agent shutting down (max runtime). Processed ${processedCount} messages. Auto-restart failed.`;
      await sendPushoo(pushooPlatform, pushooToken,
        `[Reply] [Loop Agent] ${restarted ? 'Restarting' : 'Shutting Down'}`,
        restartMsg);
      break;
    }

    let gotMessage = false;
    try {
      // Poll for new message
      pollCount++;
      upstashPollCount++;
      const now = Date.now();
      const nowIso = new Date().toISOString();
      const timeSinceLastLog = now - lastLogTime;
      
      if (timeSinceLastLog >= logIntervalMs) {
        // Log every 30s to show the agent is alive and polling
        const elapsedMin = Math.round((now - startTime) / 60000);
        console.log(`[Upstash Mode] ✓ Polling active (${elapsedMin}min elapsed, ${pollCount} polls, ${processedCount} msgs processed, dormant=${dormant})`);
        lastLogTime = now;
      }
      
      let raw;
      try {
        console.log(`[Upstash Poll #${upstashPollCount}] [${nowIso}] Calling upstash.get("${inboxKey}")...`);
        raw = await upstash.get(inboxKey);
        console.log(`[Upstash Poll #${upstashPollCount}] Raw response: ${raw ? `(type=${typeof raw}, len=${JSON.stringify(raw).length}) ${JSON.stringify(raw).slice(0, 300)}` : 'null/empty'}`);
      } catch (e) {
        console.error(`[Upstash Poll #${upstashPollCount}] ❌ Get failed: ${e.message}`);
        throw e;
      }
      
      const msg = parseMessage(raw);
      console.log(`[Upstash Poll #${upstashPollCount}] Parsed: ${msg ? `unread msg: "${msg.text.slice(0, 80).replace(/\n/g, ' ')}..."` : 'null/empty (no unread message)'}`);

      if (msg) {
        gotMessage = true;
        console.log(`[Upstash Poll #${upstashPollCount}] ✓ Found unread message, marking as read...`);
        // Mark as read immediately
        await upstash.set(inboxKey, markAsRead(msg));
        console.log(`[Upstash Poll #${upstashPollCount}] ✓ Marked as read in upstash`);

        // Check for control messages first (always handled, even when dormant)
        console.log(`[Upstash Poll #${upstashPollCount}] Checking if message is control message...`);
        const ctrl = await handleControlMessage(msg.text);
        if (ctrl.handled) {
          console.log(`[Upstash Poll #${upstashPollCount}] ✓ Processed as control message`);
          // Control message handled — skip normal processing
        } else if (dormant) {
          // Dormant mode — ignore regular messages silently
          console.log(`[Upstash Poll #${upstashPollCount}] ⏸ Dormant mode — ignoring message (${msg.text.length} chars)`);
        } else {
          console.log(`[Upstash Poll #${upstashPollCount}] ✓ Processing regular message (${msg.text.length} chars)`);
          console.time(`[Upstash Poll #${upstashPollCount}] Message processing`);

          const { responseText } = await processUserMessage(msg.text, { agentGraph, graphState, history, repoStore, loopKey, historyPath });
          console.timeEnd(`[Upstash Poll #${upstashPollCount}] Message processing`);
          console.log(`[Upstash Poll #${upstashPollCount}] ✓ Response ready (${responseText.length} chars)`);

          // Write response to outbox
          console.log(`[Upstash Poll #${upstashPollCount}] Writing response to outbox key...`);
          await upstash.set(outboxKey, createResponse(responseText));
          console.log(`[Upstash Poll #${upstashPollCount}] ✓ Response written to upstash outbox`);

          // Notify user via Pushoo
          const truncated = responseText.length > 500
            ? responseText.slice(0, 500) + '...'
            : responseText;
          console.log(`[Upstash Poll #${upstashPollCount}] Sending notification via Pushoo (${pushooPlatform})...`);
          await sendPushoo(pushooPlatform, pushooToken,
            `[Reply] [Loop Agent] Reply`,
            truncated);
          console.log(`[Upstash Poll #${upstashPollCount}] ✓ Pushoo notification sent`);

          processedCount++;

          // Update status
          try {
            await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
              state: 'running',
              startedAt: startTime,
              model: `${aiProvider}/${aiModel}`,
              processedCount,
              lastActive: Date.now(),
              inputMode: 'upstash',
            }));
          } catch { /* non-critical */ }
        }
      }
    } catch (pollErr) {
      console.error(`[Upstash Poll #${upstashPollCount}] ❌ Poll error: ${pollErr.message}`);
      if (pollErr.stack) console.error(`[Upstash Poll #${upstashPollCount}] Stack: ${pollErr.stack.split('\n').slice(0, 3).join('\n')}`);
    }

    // Adaptive polling: slow down when idle, speed up on activity
    if (gotMessage) {
      emptyPolls = 0;
      if (currentPollInterval !== pollInterval) {
        currentPollInterval = pollInterval;
        console.log(`[Upstash Mode] Message received, restoring fast polling (${currentPollInterval / 1000}s)`);
      }
    } else {
      emptyPolls++;
      if (emptyPolls === SLOW_THRESHOLD && currentPollInterval === pollInterval) {
        currentPollInterval = maxPollInterval;
        console.log(`[Upstash Mode] No messages for ${SLOW_THRESHOLD} polls, slowing to ${currentPollInterval / 1000}s`);
      }
    }

    // Wait before next poll
    await new Promise(r => setTimeout(r, currentPollInterval));
  }

  // Final status update
  try {
    await upstash.set(`loop:${loopKey}:status`, JSON.stringify({
      state: 'restarting',
      startedAt: startTime,
      stoppedAt: Date.now(),
      model: `${aiProvider}/${aiModel}`,
      processedCount,
      inputMode: 'upstash',
    }));
  } catch { /* non-critical */ }

  process.exit(0);
}

/**
 * Run in Repo mode: poll GitHub repo for messages and reply via Pushoo.
 * Fallback when neither Telegram nor Upstash is configured.
 * Browser writes to loop-agent/channel/{loopKey}.inbox.json
 * Runner writes to loop-agent/channel/{loopKey}.outbox.json
 */
async function runRepoMode({
  agentGraph, graphState, history, repoStore, loopKey, historyPath,
  pushooPlatform, pushooToken,
  maxRuntime, pollInterval, aiProvider, aiModel,
}) {
  const inboxPath = `loop-agent/channel/${loopKey}.inbox.json`;
  const outboxPath = `loop-agent/channel/${loopKey}.outbox.json`;
  const startTime = Date.now();
  let processedCount = 0;

  // Adaptive polling: slow down when idle, speed up on activity
  let repoCurrentInterval = pollInterval;
  const repoMaxInterval = pollInterval * 6;
  let repoEmptyPolls = 0;
  const REPO_SLOW_THRESHOLD = 5;

  console.log(`[RepoMode] Starting repo-based polling mode`);
  console.log(`[RepoMode] Inbox: ${inboxPath}`);
  console.log(`[RepoMode] Outbox: ${outboxPath}`);
  console.log(`[RepoMode] Poll interval: ${pollInterval / 1000}s (adaptive: slows to ${repoMaxInterval / 1000}s when idle)`);

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= maxRuntime) {
      console.log(`[RepoMode] Max runtime reached (${maxRuntime / 1000}s). Attempting restart...`);
      const restarted = await selfRestart();
      const restartMsg = restarted
        ? `♻️ Loop Agent restarting (max runtime). Processed ${processedCount} messages in ${Math.round(elapsed / 60000)} minutes.`
        : `⏱ Loop Agent shutting down (max runtime). Processed ${processedCount} messages.`;
      await sendPushoo(pushooPlatform, pushooToken,
        `[Loop Agent] ${restarted ? 'Restarting' : 'Shutting Down'}`, restartMsg);
      break;
    }

    let repoGotMessage = false;
    try {
      const file = await repoStore.readFile(inboxPath);
      if (file) {
        const msg = parseMessage(file.content);
        if (msg) {
          repoGotMessage = true;
          console.log(`[RepoMode] Received message (${msg.text.length} chars)`);

          // Mark inbox as read
          try {
            await repoStore.writeFile(inboxPath, markAsRead(msg), '[loop-agent] Mark inbox read');
          } catch (e) {
            console.warn(`[RepoMode] Failed to mark inbox read: ${e.message}`);
          }

          const { responseText } = await processUserMessage(msg.text, {
            agentGraph, graphState, history, repoStore, loopKey, historyPath,
          });

          // Write response to outbox
          try {
            await repoStore.writeFile(outboxPath, createResponse(responseText), '[loop-agent] Write response');
          } catch (e) {
            console.warn(`[RepoMode] Failed to write outbox: ${e.message}`);
          }

          // Notify via pushoo
          const truncated = responseText.length > 500 ? responseText.slice(0, 500) + '...' : responseText;
          await sendPushoo(pushooPlatform, pushooToken, `[Reply] [Loop Agent] Reply`, truncated);
          processedCount++;
        }
      }
    } catch (e) {
      console.warn(`[RepoMode] Poll error: ${e.message}`);
    }

    // Adaptive polling: slow down when idle, speed up on activity
    if (repoGotMessage) {
      repoEmptyPolls = 0;
      if (repoCurrentInterval !== pollInterval) {
        repoCurrentInterval = pollInterval;
        console.log(`[RepoMode] Message received, restoring fast polling (${repoCurrentInterval / 1000}s)`);
      }
    } else {
      repoEmptyPolls++;
      if (repoEmptyPolls === REPO_SLOW_THRESHOLD && repoCurrentInterval === pollInterval) {
        repoCurrentInterval = repoMaxInterval;
        console.log(`[RepoMode] No messages for ${REPO_SLOW_THRESHOLD} polls, slowing to ${repoCurrentInterval / 1000}s`);
      }
    }

    await new Promise(r => setTimeout(r, repoCurrentInterval));
  }

  process.exit(0);
}

async function main() {
  const UPSTASH_URL = process.env.UPSTASH_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
  const LOOP_KEY = process.env.LOOP_KEY;
  const AI_PROVIDER = process.env.AI_PROVIDER || 'gemini';
  const AI_MODEL = process.env.AI_MODEL || 'gemini-2.0-flash';
  const AI_API_KEY = process.env.AI_API_KEY;
  const PUSHOO_PLATFORM = process.env.PUSHOO_PLATFORM;
  const PUSHOO_TOKEN_VAL = process.env.PUSHOO_TOKEN;
  const GH_PAT = process.env.GH_PAT;
  const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
  const LOOP_WORKFLOW_FILE = process.env.LOOP_WORKFLOW_FILE || '';
  const LOOP_HISTORY_PATH = process.env.LOOP_HISTORY_PATH || 'loop-agent/history';
  const POLL_INTERVAL = parseInt(process.env.LOOP_POLL_INTERVAL || '5', 10) * 1000;
  const MAX_RUNTIME = parseInt(process.env.LOOP_MAX_RUNTIME || '18000', 10) * 1000;
  const SYSTEM_PROMPT = process.env.LOOP_SYSTEM_PROMPT || '';

  const useTelegram = isTelegramPlatform(PUSHOO_PLATFORM) && PUSHOO_TOKEN_VAL;
  const hasUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);
  const hasRepoStore = !!(GH_PAT && GITHUB_REPOSITORY);

  // Validate required env
  if (!useTelegram && !hasUpstash && !hasRepoStore) {
    console.error('[FATAL] Either Telegram, Upstash, or GitHub repo access (GH_PAT) is required for messaging');
    process.exit(1);
  }
  if (!LOOP_KEY) {
    console.error('[FATAL] LOOP_KEY is required');
    process.exit(1);
  }
  if (!AI_API_KEY) {
    console.error('[FATAL] AI_API_KEY is required');
    process.exit(1);
  }

  const inputMode = useTelegram ? 'Telegram' : hasUpstash ? 'Upstash' : 'Repo';
  console.log(`[Loop Agent] Starting...`);
  console.log(`  Key: ${LOOP_KEY}`);
  console.log(`  Provider: ${AI_PROVIDER}, Model: ${AI_MODEL}`);
  console.log(`  Input mode: ${inputMode}`);
  console.log(`  Max runtime: ${MAX_RUNTIME / 1000}s`);

  // Upstash client (optional in Telegram mode)
  const upstash = (UPSTASH_URL && UPSTASH_TOKEN)
    ? new UpstashClient(UPSTASH_URL, UPSTASH_TOKEN)
    : null;

  console.log(`[Main] Upstash client initialization:`);
  console.log(`  - UPSTASH_URL: ${UPSTASH_URL ? 'present' : '❌ missing'}`);
  console.log(`  - UPSTASH_TOKEN: ${UPSTASH_TOKEN ? 'present' : '❌ missing'}`);
  console.log(`  - upstash object: ${upstash ? '✓ created' : '❌ null (missing env variables)'}`);

  // ── Upstash connectivity test ──
  if (upstash) {
    const inboxKey = `loop:${LOOP_KEY}:inbox`;
    const outboxKey = `loop:${LOOP_KEY}:outbox`;
    const statusKey = `loop:${LOOP_KEY}:status`;
    console.log(`[Upstash] URL: ${UPSTASH_URL.slice(0, 30)}...`);
    console.log(`[Upstash] Inbox key:  ${inboxKey}`);
    console.log(`[Upstash] Outbox key: ${outboxKey}`);
    console.log(`[Upstash] Status key: ${statusKey}`);
    try {
      console.log(`[Upstash] Testing connection with PING...`);
      await upstash.ping();
      console.log(`[Upstash] ✅ Connection verified (PING → PONG)`);
      // Check if there are any pending messages in the inbox
      console.log(`[Upstash] Checking for pending messages in inbox...`);
      const pending = await upstash.get(inboxKey);
      console.log(`[Upstash] Inbox value: ${pending ? `(${typeof pending}) ${JSON.stringify(pending).slice(0, 200)}` : 'empty'}`);
      if (pending) {
        const msg = parseMessage(pending);
        console.log(`[Upstash] Inbox has ${msg ? 'an UNREAD' : 'a read/empty'} message waiting`);
      } else {
        console.log(`[Upstash] Inbox is empty — waiting for browser messages`);
      }
    } catch (e) {
      console.error(`[Upstash] ❌ Connection FAILED: ${e.message}`);
      console.error(`[Upstash] Error details: ${e.stack ? e.stack.split('\n')[1] : 'no stack'}`);
      console.error(`[Upstash] Check UPSTASH_URL and UPSTASH_TOKEN in repo secrets`);
      console.error(`[Upstash] UPSTASH_URL length: ${UPSTASH_URL ? UPSTASH_URL.length : 'undefined'}`);
      console.error(`[Upstash] UPSTASH_TOKEN length: ${UPSTASH_TOKEN ? UPSTASH_TOKEN.length : 'undefined'}`);
      if (!useTelegram && hasUpstash && !hasRepoStore) {
        console.error(`[FATAL] Upstash is the only messaging channel but connection failed`);
        process.exit(1);
      }
    }
  } else {
    console.log(`[Upstash] Not configured — ${hasRepoStore ? 'using repo-based polling' : 'N/A'}`);
  }

  const LOOP_ENCRYPT_KEY = process.env.LOOP_ENCRYPT_KEY || '';

  const repoStore = GH_PAT && GITHUB_REPOSITORY
    ? new RepoStore(GH_PAT, GITHUB_REPOSITORY, LOOP_ENCRYPT_KEY)
    : null;

  if (LOOP_ENCRYPT_KEY) {
    console.log(`[Loop Agent] File encryption: ENABLED`);
  } else {
    console.log(`[Loop Agent] File encryption: disabled (no LOOP_ENCRYPT_KEY)`);
  }

  // Load conversation history
  const history = new ConversationHistory(
    repoStore,
    `${LOOP_HISTORY_PATH}/${LOOP_KEY}`
  );
  if (repoStore) await history.load();

  // Create LLM and agent graph
  let agentGraph;
  let graphState;
  try {
    const llm = createLLM(AI_PROVIDER, AI_MODEL, AI_API_KEY);
    const tools = createBuiltinTools(repoStore);
    console.log(`[Tools] Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

    // Create Checkpointer for persistent state across node transitions
    const checkpointer = new Checkpointer(repoStore, LOOP_HISTORY_PATH);

    // Load persisted state via Checkpointer
    graphState = await checkpointer.load(LOOP_KEY);

    agentGraph = new AgentGraph({
      llm, tools, systemPrompt: SYSTEM_PROMPT, repoStore,
      checkpointer, threadId: LOOP_KEY,
    });

    // Restore loaded skills/soul from persisted state
    agentGraph.restoreExtensions(graphState);

    console.log(`[Loop Agent] Agent graph created (phase: ${graphState.phase}, turn: ${graphState.turnCount || 0})`);
    if (graphState.timing) {
      printTimingSummary(graphState);
    }
  } catch (e) {
    console.error(`[FATAL] Failed to create agent graph: ${e.message}`);
    await sendPushoo(PUSHOO_PLATFORM, PUSHOO_TOKEN_VAL,
      `[Reply] [Loop Agent] Startup Failed`,
      `Failed to create AI agent: ${e.message}`);
    process.exit(1);
  }

  // Send startup notification (both modes)
  const introMsg = [
    `🤖 Loop Agent Started`,
    `Key: ${LOOP_KEY}`,
    `Model: ${AI_PROVIDER}/${AI_MODEL}`,
    `Mode: ${inputMode}`,
    `Max Runtime: ${MAX_RUNTIME / 1000}s`,
    SYSTEM_PROMPT ? `System Prompt: ${SYSTEM_PROMPT.slice(0, 200)}${SYSTEM_PROMPT.length > 200 ? '...' : ''}` : '',
  ].filter(Boolean).join('\n');

  if (!useTelegram) {
    // Upstash mode: send via Pushoo
    await sendPushoo(PUSHOO_PLATFORM, PUSHOO_TOKEN_VAL, `[Loop Agent] ${LOOP_KEY} Started`, introMsg);
  }

  if (useTelegram) {
    // ── Telegram mode ──
    const { botToken, chatId } = parseTelegramToken(PUSHOO_TOKEN_VAL);
    if (!botToken) {
      console.error('[FATAL] Invalid PUSHOO_TOKEN for Telegram. Expected format: botToken#chatId');
      process.exit(1);
    }
    console.log(`[Telegram] Bot token: ${botToken.slice(0, 10)}...`);
    console.log(`[Telegram] Chat ID: ${chatId || '(accept all)'}`);

    // Send intro to Telegram directly
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: introMsg }),
      });
    } catch (e) {
      console.warn(`[Telegram] Failed to send intro: ${e.message}`);
    }

    await runTelegramMode({
      botToken, chatId, agentGraph, graphState, history, repoStore, upstash, loopKey: LOOP_KEY,
      historyPath: LOOP_HISTORY_PATH,
      maxRuntime: MAX_RUNTIME, pollInterval: POLL_INTERVAL,
      aiProvider: AI_PROVIDER, aiModel: AI_MODEL,
    });
  } else if (hasUpstash) {
    // ── Upstash mode ──
    console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
    console.log(`  Pushoo: ${PUSHOO_PLATFORM || 'disabled'}`);

    await runUpstashMode({
      upstash, agentGraph, graphState, history, repoStore, loopKey: LOOP_KEY,
      historyPath: LOOP_HISTORY_PATH,
      pushooPlatform: PUSHOO_PLATFORM, pushooToken: PUSHOO_TOKEN_VAL,
      maxRuntime: MAX_RUNTIME, pollInterval: POLL_INTERVAL,
      aiProvider: AI_PROVIDER, aiModel: AI_MODEL,
    });
  } else {
    // ── Repo mode (fallback — no Telegram, no Upstash) ──
    console.log(`  Poll interval: ${POLL_INTERVAL / 1000}s`);
    console.log(`  Pushoo: ${PUSHOO_PLATFORM || 'disabled'}`);

    await runRepoMode({
      agentGraph, graphState, history, repoStore, loopKey: LOOP_KEY,
      historyPath: LOOP_HISTORY_PATH,
      pushooPlatform: PUSHOO_PLATFORM, pushooToken: PUSHOO_TOKEN_VAL,
      maxRuntime: MAX_RUNTIME, pollInterval: POLL_INTERVAL,
      aiProvider: AI_PROVIDER, aiModel: AI_MODEL,
    });
  }
}

main().catch(err => {
  console.error(`[FATAL] Unhandled error: ${err.message}`);
  process.exit(1);
});
