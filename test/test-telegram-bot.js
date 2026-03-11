#!/usr/bin/env node

/**
 * test-telegram-bot.js
 *
 * Telegram bot with long-polling (using Telegraf).
 * Listens for incoming messages and echoes them back.
 * Reads bot token from .env PUSHOO_TOKEN.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf, session } from 'telegraf';

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

function extractTelegramBotToken(token) {
  // Token format: "botToken#chatId"
  if (!token) return '';
  if (token.includes('#')) {
    return token.split('#')[0];
  }
  // Also support "/" format
  if (token.includes('/')) {
    return token.split('/')[0];
  }
  return token;
}

async function main() {
  const env = parseDotEnv(envPath);
  const rawToken = env.PUSHOO_TOKEN || '';
  const botToken = extractTelegramBotToken(rawToken);

  if (!botToken) {
    console.error('Error: PUSHOO_TOKEN not found in .env or invalid format.');
    console.error('Expected format: botToken#chatId or botToken/chatId');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('🤖 Telegram Bot - Long Polling Mode');
  console.log('='.repeat(60));
  console.log(`Bot Token: ${botToken.slice(0, 10)}...${botToken.slice(-10)}`);
  console.log('Status: Starting polling...');
  console.log('');
  console.log('💬 Waiting for messages. Send a message to the bot to test.');
  console.log('Press Ctrl+C to stop.\n');

  const bot = new Telegraf(botToken);

  // Middleware to log all updates
  bot.use((ctx, next) => {
    const updateType = ctx.updateType;
    if (updateType === 'message') {
      const msg = ctx.message;
      const fromUser = msg.from;
      const text = msg.text || '(no text content)';
      const timestamp = new Date(msg.date * 1000).toISOString();
      
      console.log(`\n[${timestamp}] 📨 Message received`);
      console.log(`  From: ${fromUser.first_name}${fromUser.last_name ? ' ' + fromUser.last_name : ''} (@${fromUser.username || 'no-username'})`);
      console.log(`  Chat ID: ${msg.chat.id}`);
      console.log(`  Content: "${text}"`);
    }
    return next();
  });

  // Handle text messages
  bot.on('message', async (ctx) => {
    try {
      const incomingText = ctx.message.text || '(message without text)';
      const echoText = `Echo: ${incomingText}`;
      
      await ctx.reply(echoText);
      console.log(`  Response: "Echo reply sent" ✅\n`);
    } catch (err) {
      console.error(`  Error sending reply: ${err.message}`);
    }
  });

  // Handle /start command
  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Hello! 👋\n\n' +
      'I\'m a simple echo bot powered by Telegraf.\n' +
      'Send me any message and I\'ll echo it back.\n\n' +
      'Commands:\n' +
      '/start - Show this message\n' +
      '/help - Show help\n' +
      '/stop - Stop the bot'
    );
  });

  // Handle /help command
  bot.command('help', async (ctx) => {
    await ctx.reply(
      'Echo Bot Help\n\n' +
      'Just send any message and it will be echoed back.\n' +
      'Try it now! 🚀'
    );
  });

  // Handle /stop command
  bot.command('stop', async (ctx) => {
    await ctx.reply('Bot is stopping... Goodbye! 👋');
    console.log('\n✋ Stop command received. Shutting down...\n');
    process.exit(0);
  });

  // Error handler
  bot.catch((err) => {
    console.error('Bot error:', err);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n✋ Interrupt signal received. Stopping bot...');
    bot.stop().then(() => {
      console.log('Bot stopped successfully.');
      process.exit(0);
    }).catch(err => {
      console.error('Error stopping bot:', err);
      process.exit(1);
    });
  });

  process.on('SIGTERM', () => {
    console.log('\n\n✋ Termination signal received. Stopping bot...');
    bot.stop().then(() => {
      console.log('Bot stopped successfully.');
      process.exit(0);
    }).catch(err => {
      console.error('Error stopping bot:', err);
      process.exit(1);
    });
  });

  // Start polling
  try {
    await bot.launch({
      polling: {
        interval: 300,      // Poll every 300ms
        timeout: 30,        // 30 second timeout per request
        allowedUpdates: ['message', 'callback_query']
      }
    });
    console.log('✅ Bot polling started successfully.\n');
  } catch (err) {
    console.error('Failed to start bot:', err.message);
    process.exit(1);
  }
}

main();
