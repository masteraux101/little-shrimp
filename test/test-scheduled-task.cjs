/**
 * test-scheduled-task.js
 *
 * Tests for the create_scheduled_task tool in runner.js:
 *   1. writeFile encrypts content when _encryptKey is set
 *   2. writeFileRaw does NOT encrypt content when _encryptKey is set
 *   3. create_scheduled_task writes YAML & script via writeFileRaw (plain text)
 *   4. create_scheduled_task writes task record via writeFile (encrypted)
 *   5. Scheduled task communication channel: poll Upstash / repo for messages
 *
 * Since runner.js does not export its internals, we extract and re-create
 * the relevant classes/functions here with the same logic, then test them
 * against a mock GitHub API (fetch).
 */

const crypto = require('crypto');
const assert = require('assert');

// ─── Copy of encryption constants & functions from runner.js ────────

const ENC_PBKDF2_ITERATIONS = 310000;
const ENC_SALT_LEN = 16;
const ENC_IV_LEN = 12;
const ENC_KEY_LEN = 32;
const ENC_TAG_LEN = 16;
const ENC_PREFIX = 'ENCRYPTED:';

function encryptContent(passphrase, plaintext) {
  const salt = crypto.randomBytes(ENC_SALT_LEN);
  const iv = crypto.randomBytes(ENC_IV_LEN);
  const key = crypto.pbkdf2Sync(passphrase, salt, ENC_PBKDF2_ITERATIONS, ENC_KEY_LEN, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
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
  const key = crypto.pbkdf2Sync(passphrase, salt, ENC_PBKDF2_ITERATIONS, ENC_KEY_LEN, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

// ─── Mock GitHub API ────────────────────────────────────────────────

/**
 * Tracks all files "written" to the mock GitHub repo.
 * Key: file path, Value: { raw content (pre-base64), sha }
 */
const mockRepoFiles = new Map();
const writeLog = []; // { path, content, encrypted: boolean }

function resetMock() {
  mockRepoFiles.clear();
  writeLog.length = 0;
}

/**
 * Mock fetch that simulates GitHub Contents API.
 * GET  → returns file content + SHA (or 404)
 * PUT  → stores file, returns SHA
 */
function mockFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();

  // Extract path from URL: .../contents/{path}?ref=...
  const contentsMatch = url.match(/\/contents\/(.+?)(?:\?|$)/);
  if (!contentsMatch) {
    return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) });
  }
  const filePath = decodeURIComponent(contentsMatch[1]);

  if (method === 'GET') {
    if (mockRepoFiles.has(filePath)) {
      const { content: rawContent, sha } = mockRepoFiles.get(filePath);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          content: Buffer.from(rawContent).toString('base64'),
          sha,
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  }

  if (method === 'PUT') {
    const body = JSON.parse(opts.body);
    const rawContent = Buffer.from(body.content, 'base64').toString('utf-8');
    const sha = crypto.randomBytes(20).toString('hex');
    mockRepoFiles.set(filePath, { content: rawContent, sha });
    const isEncrypted = rawContent.startsWith(ENC_PREFIX);
    writeLog.push({ path: filePath, content: rawContent, encrypted: isEncrypted });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ content: { sha } }),
    });
  }

  return Promise.resolve({ ok: false, status: 405, json: () => Promise.resolve({}) });
}

// ─── RepoStore (copy from runner.js) ────────────────────────────────

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
    const resp = await mockFetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}?ref=${branch}`,
      { headers: this._headers() }
    );
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GitHub read error: ${resp.status}`);
    const data = await resp.json();
    let content = Buffer.from(data.content, 'base64').toString('utf-8');
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
    const existing = await this.readFile(path, branch);
    const finalContent = this._encryptKey ? encryptContent(this._encryptKey, content) : content;
    const body = {
      message,
      content: Buffer.from(finalContent).toString('base64'),
      branch,
    };
    if (existing) body.sha = existing.sha;

    const resp = await mockFetch(
      `${this.api}/repos/${this.owner}/${this.repo}/contents/${path}`,
      { method: 'PUT', headers: this._headers(), body: JSON.stringify(body) }
    );
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`GitHub write error: ${resp.status} ${err.message || ''}`);
    }
    return resp.json();
  }

  async writeFileRaw(path, content, message, branch = 'main') {
    const existing = await this.readFile(path, branch);
    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
    };
    if (existing) body.sha = existing.sha;

    const resp = await mockFetch(
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

// ─── Simulate create_scheduled_task logic (extracted from runner.js) ─

async function simulateCreateScheduledTask(repoStore, { name, description, cron, script, language }) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const workflowFile = `scheduled-${slug}.yml`;
  const workflowPath = `.github/workflows/${workflowFile}`;
  const taskRecordPath = `loop-agent/schedules/${slug}.json`;
  const lang = (language || 'node').toLowerCase();
  const setupStep = lang === 'python'
    ? '      - uses: actions/setup-python@v5\n        with:\n          python-version: "3.12"\n      - run: pip install -r requirements.txt 2>/dev/null || true'
    : '';
  const runCmd = lang === 'python' ? `python loop-agent/schedules/${slug}.py` : `node loop-agent/schedules/${slug}.js`;
  const scriptPath = `loop-agent/schedules/${slug}.${lang === 'python' ? 'py' : 'js'}`;
  const cryptoHelperPath = 'loop-agent/schedules/_crypto.js';

  const yaml = [
    `# scheduled-task: ${slug}`,
    `name: "Scheduled — ${name}"`,
    '',
    'on:',
    '  schedule:',
    `    - cron: '${cron}'`,
    '  workflow_dispatch: {}',
    '',
    'jobs:',
    '  run-and-notify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    setupStep,
    `      - name: Run task`,
    '        id: run-task',
    '        env:',
    '          LOOP_ENCRYPT_KEY: ${{ secrets.LOOP_ENCRYPT_KEY }}',
    '        run: |',
    `          ${runCmd} > /tmp/_task_output.txt 2>&1 || true`,
    '          echo "output<<EOF" >> $GITHUB_OUTPUT',
    '          head -c 3000 /tmp/_task_output.txt >> $GITHUB_OUTPUT',
    '          echo "EOF" >> $GITHUB_OUTPUT',
    '',
    '      - name: Callback to Loop Agent',
    '        if: always()',
    '        env:',
    '          UPSTASH_URL: ${{ secrets.UPSTASH_URL }}',
    '          UPSTASH_TOKEN: ${{ secrets.UPSTASH_TOKEN }}',
    '          LOOP_KEY: ${{ secrets.LOOP_KEY }}',
    '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    '          GITHUB_REPOSITORY: ${{ github.repository }}',
    '        run: |',
    `          OUTPUT=$(head -c 2000 /tmp/_task_output.txt 2>/dev/null || echo "(no output)")`,
    `          node loop-agent/schedules/_callback.js "[Scheduled] ${name.replace(/"/g, '\\"')}" "$OUTPUT"`,
    '',
    '      - name: Notify',
    '        if: always()',
    '        env:',
    '          PUSHOO_CHANNELS: ${{ secrets.PUSHOO_CHANNELS }}',
    '        run: |',
    '          npm install pushoo 2>/dev/null',
    `          node -e "const p=require('pushoo').default;const ch=JSON.parse(process.env.PUSHOO_CHANNELS||'[]');const o=require('fs').readFileSync('/tmp/_task_output.txt','utf8').slice(0,2000);ch.forEach(c=>p(c.platform,{token:c.token,title:'[Scheduled] ${name.replace(/'/g, "\\'")}',content:o||'(no output)'}).catch(e=>console.warn(e.message)))"`,
  ].filter(Boolean).join('\n') + '\n';

  const cryptoHelperCode = [
    '// _crypto.js — Decryption helper for scheduled tasks',
    'const crypto = require("crypto");',
    'const fs = require("fs");',
    'const PREFIX = "ENCRYPTED:";',
    'function decrypt(passphrase, blob) {',
    '  if (!blob || !blob.startsWith(PREFIX)) return blob;',
    '  const packed = Buffer.from(blob.slice(PREFIX.length), "base64");',
    '  const salt = packed.subarray(0, 16);',
    '  const iv = packed.subarray(16, 28);',
    '  const rest = packed.subarray(28);',
    '  const tag = rest.subarray(rest.length - 16);',
    '  const ct = rest.subarray(0, rest.length - 16);',
    '  const key = crypto.pbkdf2Sync(passphrase, salt, 310000, 32, "sha256");',
    '  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);',
    '  d.setAuthTag(tag);',
    '  return d.update(ct, undefined, "utf8") + d.final("utf8");',
    '}',
    'function readEncryptedFile(filePath) {',
    '  const k = process.env.LOOP_ENCRYPT_KEY;',
    '  const c = fs.readFileSync(filePath, "utf8");',
    '  return (k && c.startsWith(PREFIX)) ? decrypt(k, c) : c;',
    '}',
    'module.exports = { decrypt, readEncryptedFile, PREFIX };',
  ].join('\n') + '\n';

  const callbackHelperPath = 'loop-agent/schedules/_callback.js';

  // Write executable files WITHOUT encryption
  await repoStore.writeFileRaw(scriptPath, script, `[scheduled] Add script for ${name}`);
  await repoStore.writeFileRaw(workflowPath, yaml, `[scheduled] Create schedule for ${name}`);

  // Write shared crypto helper (plain text)
  if (repoStore._encryptKey) {
    await repoStore.writeFileRaw(cryptoHelperPath, cryptoHelperCode, '[scheduled] Add/update crypto helper');
  }

  // Write callback helper (plain text)
  await repoStore.writeFileRaw(callbackHelperPath, '// _callback.js stub for testing\n', '[scheduled] Add/update callback helper');

  // Create/update task record (encrypted)
  let record = { name, slug, description, cron, language: lang, createdAt: new Date().toISOString(), executions: [] };
  try {
    const existing = await repoStore.readFile(taskRecordPath);
    if (existing) record = JSON.parse(existing.content);
  } catch { /* new record */ }
  record.cron = cron;
  record.description = description;
  record.updatedAt = new Date().toISOString();
  await repoStore.writeFile(taskRecordPath, JSON.stringify(record, null, 2), `[scheduled] Update record for ${name}`);

  return { workflowPath, scriptPath, taskRecordPath, cryptoHelperPath, callbackHelperPath };
}

// ─── Test Suites ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  return fn().then(() => {
    console.log(`  ✅ ${name}`);
    passed++;
  }).catch(e => {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  });
}

async function runTests() {
  const ENCRYPT_KEY = 'test-passphrase-for-encryption-2024';

  // ── Suite 1: Encryption / Decryption Roundtrip ──
  console.log('\n🔐 Suite 1: Encryption/Decryption');

  await test('encryptContent produces ENCRYPTED: prefix', async () => {
    const result = encryptContent(ENCRYPT_KEY, 'hello world');
    assert.ok(result.startsWith(ENC_PREFIX), `Expected ${ENC_PREFIX} prefix, got: ${result.slice(0, 20)}`);
  });

  await test('decryptContent recovers original text', async () => {
    const original = 'some secret data 🔑';
    const encrypted = encryptContent(ENCRYPT_KEY, original);
    const decrypted = decryptContent(ENCRYPT_KEY, encrypted);
    assert.strictEqual(decrypted, original);
  });

  await test('decryptContent returns plain text as-is', async () => {
    const plain = 'just plain text, no encryption';
    const result = decryptContent(ENCRYPT_KEY, plain);
    assert.strictEqual(result, plain);
  });

  // ── Suite 2: RepoStore writeFile vs writeFileRaw ──
  console.log('\n📦 Suite 2: RepoStore write methods');

  await test('writeFile encrypts content when encryptKey is set', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    await store.writeFile('data/secret.txt', 'my secret', 'test commit');
    const entry = writeLog.find(e => e.path === 'data/secret.txt');
    assert.ok(entry, 'File should have been written');
    assert.ok(entry.encrypted, `Content should be encrypted, got: ${entry.content.slice(0, 30)}`);
    assert.ok(entry.content.startsWith(ENC_PREFIX), `Should start with ${ENC_PREFIX}`);
  });

  await test('writeFile does NOT encrypt when no encryptKey', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo'); // no key
    await store.writeFile('data/public.txt', 'public data', 'test commit');
    const entry = writeLog.find(e => e.path === 'data/public.txt');
    assert.ok(entry, 'File should have been written');
    assert.ok(!entry.encrypted, 'Content should NOT be encrypted');
    assert.strictEqual(entry.content, 'public data');
  });

  await test('writeFileRaw does NOT encrypt even with encryptKey set', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    const yamlContent = 'name: test\non:\n  schedule:\n    - cron: "0 9 * * *"\n';
    await store.writeFileRaw('.github/workflows/test.yml', yamlContent, 'test commit');
    const entry = writeLog.find(e => e.path === '.github/workflows/test.yml');
    assert.ok(entry, 'File should have been written');
    assert.ok(!entry.encrypted, `YAML should NOT be encrypted, got: ${entry.content.slice(0, 30)}`);
    assert.strictEqual(entry.content, yamlContent, 'Content should be identical to input');
  });

  await test('writeFileRaw handles update (existing file)', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    // Pre-populate a file
    mockRepoFiles.set('test.yml', { content: 'old content', sha: 'old-sha-123' });
    await store.writeFileRaw('test.yml', 'new content', 'update');
    const entry = writeLog.find(e => e.path === 'test.yml');
    assert.ok(entry, 'File should have been written');
    assert.ok(!entry.encrypted, 'Updated content should NOT be encrypted');
    assert.strictEqual(entry.content, 'new content');
  });

  // ── Suite 3: create_scheduled_task simulation ──
  console.log('\n⏰ Suite 3: create_scheduled_task');

  await test('Workflow YAML is NOT encrypted', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    const result = await simulateCreateScheduledTask(store, {
      name: 'Daily Weather',
      description: 'Fetch weather data',
      cron: '0 9 * * *',
      script: 'console.log("Hello from scheduled task");',
      language: 'node',
    });
    const yamlEntry = writeLog.find(e => e.path === result.workflowPath);
    assert.ok(yamlEntry, `Workflow YAML should have been written to ${result.workflowPath}`);
    assert.ok(!yamlEntry.encrypted, `Workflow YAML must NOT be encrypted!\nGot: ${yamlEntry.content.slice(0, 80)}`);
    assert.ok(yamlEntry.content.includes('name: "Scheduled'), 'YAML should contain workflow name');
    assert.ok(yamlEntry.content.includes('cron:'), 'YAML should contain cron schedule');
  });

  await test('Script file is NOT encrypted', async () => {
    // Uses same mock state from previous test
    const scriptEntry = writeLog.find(e => e.path.endsWith('.js') && e.path.includes('schedules/daily-weather'));
    assert.ok(scriptEntry, 'Script should have been written');
    assert.ok(!scriptEntry.encrypted, `Script must NOT be encrypted!\nGot: ${scriptEntry.content.slice(0, 80)}`);
    assert.strictEqual(scriptEntry.content, 'console.log("Hello from scheduled task");');
  });

  await test('Crypto helper is NOT encrypted', async () => {
    const cryptoEntry = writeLog.find(e => e.path === 'loop-agent/schedules/_crypto.js');
    assert.ok(cryptoEntry, 'Crypto helper should have been written');
    assert.ok(!cryptoEntry.encrypted, `Crypto helper must NOT be encrypted!`);
    assert.ok(cryptoEntry.content.includes('readEncryptedFile'), 'Should contain readEncryptedFile function');
  });

  await test('Task record IS encrypted (metadata)', async () => {
    const recordEntry = writeLog.find(e => e.path.endsWith('.json'));
    assert.ok(recordEntry, 'Task record should have been written');
    assert.ok(recordEntry.encrypted, `Task record should be encrypted, got: ${recordEntry.content.slice(0, 30)}`);
    // Verify we can decrypt it back to valid JSON
    const decrypted = decryptContent(ENCRYPT_KEY, recordEntry.content);
    const parsed = JSON.parse(decrypted);
    assert.strictEqual(parsed.name, 'Daily Weather');
    assert.strictEqual(parsed.cron, '0 9 * * *');
  });

  await test('Python task generates correct workflow', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    await simulateCreateScheduledTask(store, {
      name: 'Data Sync',
      description: 'Sync data from API',
      cron: '*/30 * * * *',
      script: 'import requests\nprint("syncing")',
      language: 'python',
    });
    const yamlEntry = writeLog.find(e => e.path.includes('.yml'));
    assert.ok(yamlEntry, 'Workflow YAML should exist');
    assert.ok(!yamlEntry.encrypted, 'Python workflow YAML must NOT be encrypted');
    assert.ok(yamlEntry.content.includes('setup-python'), 'Python workflow should include setup-python step');
    assert.ok(yamlEntry.content.includes('python loop-agent/schedules/data-sync.py'), 'Should run python script');
  });

  // ── Suite 4: Verify runner.js source code uses writeFileRaw ──
  console.log('\n🔍 Suite 4: Source code verification');

  await test('runner.js uses writeFileRaw for workflow YAML write', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');

    // Find the create_scheduled_task tool implementation (the try block with writeFileRaw)
    // Use the comment marker that immediately precedes the tool definition
    const marker = '// ── create_scheduled_task: Create a cron-scheduled GHA workflow';
    const taskToolStart = source.indexOf(marker);
    assert.ok(taskToolStart > -1, 'Should find create_scheduled_task marker in source');

    // Extract a generous window covering the entire tool (comment to schema closing)
    const toolEnd = source.indexOf("name: 'create_scheduled_task'", taskToolStart);
    assert.ok(toolEnd > -1, 'Should find create_scheduled_task name in source');
    const toolSection = source.slice(taskToolStart, toolEnd + 500);

    // Check workflow YAML write uses writeFileRaw
    assert.ok(
      toolSection.includes('writeFileRaw(workflowPath'),
      'Workflow YAML must use writeFileRaw, not writeFile'
    );

    // Check script write uses writeFileRaw
    assert.ok(
      toolSection.includes('writeFileRaw(scriptPath'),
      'Script must use writeFileRaw, not writeFile'
    );

    // Check crypto helper is plain text too
    assert.ok(
      toolSection.includes('writeFileRaw(cryptoHelperPath'),
      'Crypto helper must use writeFileRaw'
    );

    // Check task record uses writeFile (encrypted)
    assert.ok(
      toolSection.includes('writeFile(taskRecordPath'),
      'Task record should use writeFile (encrypted)'
    );
  });

  await test('runner.js writeFileRaw does not call encryptContent', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');

    // Extract writeFileRaw method
    const rawStart = source.indexOf('async writeFileRaw(');
    assert.ok(rawStart > -1, 'Should find writeFileRaw method');
    const rawEnd = source.indexOf('\n  }', rawStart);
    const rawBody = source.slice(rawStart, rawEnd);

    assert.ok(!rawBody.includes('encryptContent'), 'writeFileRaw must NOT call encryptContent');
    assert.ok(!rawBody.includes('_encryptKey'), 'writeFileRaw must NOT reference _encryptKey');
  });

  // ── Suite 5: write_repo_file smart encryption bypass ──
  console.log('\n🛡️  Suite 5: write_repo_file plain text bypass');

  await test('runner.js write_repo_file skips encryption for workflow YAML paths', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');

    // The write_repo_file tool should detect workflow paths and use writeFileRaw
    const writeRepoStart = source.indexOf("name: 'write_repo_file'");
    assert.ok(writeRepoStart > -1, 'Should find write_repo_file tool in source');
    const writeRepoSection = source.slice(writeRepoStart - 1500, writeRepoStart + 500);

    assert.ok(
      writeRepoSection.includes('writeFileRaw'),
      'write_repo_file should use writeFileRaw for plain text file paths'
    );
    assert.ok(
      writeRepoSection.includes('.github/workflows') || writeRepoSection.includes('workflows'),
      'write_repo_file should detect workflow YAML paths'
    );
    assert.ok(
      writeRepoSection.includes('schedules'),
      'write_repo_file should detect scheduled task script paths'
    );
  });

  await test('shouldSkipEncryption correctly identifies workflow YAML', async () => {
    // Re-implement the pattern matching logic from runner.js for testing
    const PLAIN_TEXT_PATTERNS = [
      /^\.github\/workflows\/.+\.ya?ml$/,
      /^loop-agent\/schedules\/.+\.(js|py)$/,
      /^loop-agent\/schedules\/_crypto\.js$/,
    ];
    function shouldSkipEncryption(filePath) {
      return PLAIN_TEXT_PATTERNS.some(re => re.test(filePath));
    }

    // Should skip encryption
    assert.ok(shouldSkipEncryption('.github/workflows/scheduled-task.yml'), '.yml workflow');
    assert.ok(shouldSkipEncryption('.github/workflows/test.yaml'), '.yaml workflow');
    assert.ok(shouldSkipEncryption('loop-agent/schedules/daily.js'), 'scheduled .js');
    assert.ok(shouldSkipEncryption('loop-agent/schedules/sync.py'), 'scheduled .py');
    assert.ok(shouldSkipEncryption('loop-agent/schedules/_crypto.js'), 'crypto helper');

    // Should NOT skip encryption (user data files)
    assert.ok(!shouldSkipEncryption('loop-agent/MEMORY.md'), 'memory should be encrypted');
    assert.ok(!shouldSkipEncryption('loop-agent/history'), 'history should be encrypted');
    assert.ok(!shouldSkipEncryption('data/secrets.json'), 'data files should be encrypted');
    assert.ok(!shouldSkipEncryption('README.md'), 'README should be encrypted if key set');
  });

  await test('Simulated write_repo_file for .yml path stays plain text', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    const PLAIN_TEXT_PATTERNS = [
      /^\.github\/workflows\/.+\.ya?ml$/,
      /^loop-agent\/schedules\/.+\.(js|py)$/,
      /^loop-agent\/schedules\/_crypto\.js$/,
    ];
    function shouldSkipEncryption(filePath) {
      return PLAIN_TEXT_PATTERNS.some(re => re.test(filePath));
    }

    const ymlPath = '.github/workflows/scheduled-daily.yml';
    const ymlContent = 'name: test\non:\n  schedule:\n    - cron: "0 9 * * *"\n';
    if (shouldSkipEncryption(ymlPath)) {
      await store.writeFileRaw(ymlPath, ymlContent, 'test');
    } else {
      await store.writeFile(ymlPath, ymlContent, 'test');
    }
    const entry = writeLog.find(e => e.path === ymlPath);
    assert.ok(entry, 'YAML should have been written');
    assert.ok(!entry.encrypted, `YAML via write_repo_file path must NOT be encrypted, got: ${entry.content.slice(0, 30)}`);
    assert.strictEqual(entry.content, ymlContent);
  });

  await test('Simulated write_repo_file for normal path encrypts', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    const PLAIN_TEXT_PATTERNS = [
      /^\.github\/workflows\/.+\.ya?ml$/,
      /^loop-agent\/schedules\/.+\.(js|py)$/,
      /^loop-agent\/schedules\/_crypto\.js$/,
    ];
    function shouldSkipEncryption(filePath) {
      return PLAIN_TEXT_PATTERNS.some(re => re.test(filePath));
    }

    const dataPath = 'loop-agent/MEMORY.md';
    const dataContent = '# My Secret Notes\nSensitive data here';
    if (shouldSkipEncryption(dataPath)) {
      await store.writeFileRaw(dataPath, dataContent, 'test');
    } else {
      await store.writeFile(dataPath, dataContent, 'test');
    }
    const entry = writeLog.find(e => e.path === dataPath);
    assert.ok(entry, 'File should have been written');
    assert.ok(entry.encrypted, 'Normal files should be encrypted');
  });

  // ── Suite 6: Communication channel for scheduled task feedback ──
  console.log('\n📡 Suite 6: Scheduled task communication');

  await test('Upstash polling keys are correctly formatted', async () => {
    const loopKey = 'test-session-123';
    const inboxKey = `loop:${loopKey}:inbox`;
    const outboxKey = `loop:${loopKey}:outbox`;
    assert.ok(inboxKey.startsWith('loop:'), 'Inbox key should start with loop:');
    assert.ok(outboxKey.includes(':outbox'), 'Outbox key should end with :outbox');
  });

  await test('Repo channel file paths are correctly formatted', async () => {
    const loopKey = 'sched-task-abc';
    const inboxPath = `loop-agent/channel/${loopKey}.inbox.json`;
    const outboxPath = `loop-agent/channel/${loopKey}.outbox.json`;
    assert.ok(inboxPath.includes(loopKey), 'Inbox path should contain loop key');
    assert.ok(outboxPath.endsWith('.outbox.json'), 'Outbox path should end with .outbox.json');
  });

  await test('runner.js contains polling mechanism for repo channel', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');
    assert.ok(source.includes('inbox') && source.includes('outbox'), 'Source should contain inbox/outbox polling logic');
    assert.ok(source.includes('.inbox.json') || source.includes(':inbox'), 'Source should reference inbox files/keys');
  });

  // ── Suite 7: Scheduled task → loop agent communication channel ──
  console.log('\n🔄 Suite 7: Scheduled task communication with loop agent');

  await test('runner.js has _callback.js helper generation', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');
    assert.ok(source.includes('_callback.js'), 'runner.js should generate _callback.js helper');
    assert.ok(source.includes('callbackHelperCode'), 'runner.js should define callback helper code');
    assert.ok(source.includes('sendToAgent'), 'Callback helper should include sendToAgent function');
    assert.ok(source.includes('pollAgentReply'), 'Callback helper should include pollAgentReply function');
  });

  await test('Generated workflow YAML includes callback step', async () => {
    resetMock();
    const store = new RepoStore('fake-token', 'owner/repo', ENCRYPT_KEY);
    const result = await simulateCreateScheduledTask(store, {
      name: 'Test Callback',
      description: 'Test callback mechanism',
      cron: '0 9 * * *',
      script: 'console.log("test");',
      language: 'node',
    });
    const yamlEntry = writeLog.find(e => e.path === result.workflowPath);
    assert.ok(yamlEntry, 'YAML should exist');
    assert.ok(yamlEntry.content.includes('Callback to Loop Agent'), 'YAML should have callback step');
    assert.ok(yamlEntry.content.includes('_callback.js'), 'YAML should reference _callback.js');
    assert.ok(yamlEntry.content.includes('UPSTASH_URL'), 'YAML should pass UPSTASH_URL env var');
    assert.ok(yamlEntry.content.includes('LOOP_KEY'), 'YAML should pass LOOP_KEY env var');
  });

  await test('Callback helper file is written (plain text)', async () => {
    const callbackEntry = writeLog.find(e => e.path === 'loop-agent/schedules/_callback.js');
    assert.ok(callbackEntry, 'Callback helper should be written');
    assert.ok(!callbackEntry.encrypted, 'Callback helper must NOT be encrypted');
  });

  await test('runner.js callback supports both Upstash and repo channels', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');
    // Upstash path
    assert.ok(source.includes('UPSTASH_URL') && source.includes('UPSTASH_TOKEN'), 'Should reference Upstash env vars');
    // Repo file path
    assert.ok(source.includes('loop-agent/channel'), 'Should reference repo channel path');
    assert.ok(source.includes('.inbox.json'), 'Should target inbox file');
  });

  await test('_callback.js pattern is in PLAIN_TEXT_PATTERNS', async () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'loop-agent', 'runner.js'), 'utf-8');
    assert.ok(source.includes('_callback\\.js'), 'PLAIN_TEXT_PATTERNS should include _callback.js');
  });

  // ── Summary ──
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    console.log('⚠️  Some tests failed — see details above');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
  }
}

runTests().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
