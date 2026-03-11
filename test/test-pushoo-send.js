#!/usr/bin/env node

/**
 * test-pushoo-send.js
 *
 * Real notification smoke test for Pushoo.
 * Reads PUSHOO_* values from .env and sends one test message.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pushooModule from 'pushoo';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const envPath = path.join(rootDir, '.env');

function stripQuotes(value) {
  if (!value) return '';
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseDotEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const val = stripQuotes(line.slice(eqIndex + 1));
    out[key] = val;
  }
  return out;
}

function maskSecret(secret) {
  if (!secret) return '(empty)';
  if (secret.length <= 8) return '********';
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeTelegramToken(rawToken, chatIdFromEnv) {
  const token = stripQuotes(rawToken || '');
  const chatId = stripQuotes(chatIdFromEnv || '');
  if (!token) return '';

  // Pushoo Telegram expects "botToken#chatId".
  if (token.includes('#')) return token;
  if (token.includes('/')) {
    const [bot, cid] = token.split('/');
    if (bot && cid) return `${bot}#${cid}`;
  }
  if (chatId) return `${token}#${chatId}`;
  return token;
}

function isProviderError(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.error == null) return false;
  return true;
}

async function main() {
  const env = parseDotEnv(envPath);
  const platform = (env.PUSHOO_PLATFORM || '').trim();
  const rawToken = env.PUSHOO_TOKEN || '';
  const chatId = env.PUSHOO_CHAT_ID || '';
  const token = platform === 'telegram'
    ? normalizeTelegramToken(rawToken, chatId)
    : stripQuotes(rawToken);

  if (!platform) {
    console.error('Missing PUSHOO_PLATFORM in .env');
    process.exit(1);
  }
  if (!token) {
    console.error('Missing PUSHOO_TOKEN in .env');
    process.exit(1);
  }

  const now = new Date();
  const title = 'Boxed Agent Pushoo Test';
  const content = [
    'This is a real push notification test.',
    `Platform: ${platform}`,
    `Time: ${now.toISOString()}`,
    'If you receive this, Pushoo config works.'
  ].join('\n');

  const pushoo = pushooModule?.default || pushooModule;

  console.log('Sending Pushoo test message...');
  console.log(`Platform: ${platform}`);
  console.log(`Token: ${maskSecret(token)}`);

  try {
    const result = await pushoo(platform, { token, title, content });
    if (isProviderError(result)) {
      console.error('Send failed: provider returned error payload.');
      console.error('Provider response:', JSON.stringify(result));
      process.exit(1);
    }

    console.log('Send success.');
    if (result !== undefined) {
      console.log('Provider response:', typeof result === 'string' ? result : JSON.stringify(result));
    }
  } catch (err) {
    console.error('Send failed:', err?.message || err);
    process.exit(1);
  }
}

main();
