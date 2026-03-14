/**
 * pushoo.js — Push notifications for workflow completion
 *
 * Pushoo API is extremely simple:
 *   pushoo(platform, { token, title, content })
 *
 * Config stored per-session as JSON:
 *   { channels: [{ platform, token }, ...] }
 *
 * Special platforms (use native SDK in runner.js, not pushoo):
 *   - telegram: token format "botToken#chatId"
 *   - wecombot: token format "botId#secret"
 */

import { t } from './i18n.js';

const PushooNotifier = (() => {
  // Curated list of well-supported platforms
  const PLATFORM_NAMES = [
    'telegram', 'wecombot', 'discord', 'dingtalk', 'feishu',
    'serverchan', 'pushplus', 'wecom', 'bark', 'webhook',
  ];

  const PLATFORM_MAP = {
    telegram:   { labelKey: 'platTelegram',   hintKey: 'platTelegramHint' },
    wecombot:   { labelKey: 'platWecomBot',   hintKey: 'platWecomBotHint' },
    discord:    { labelKey: 'platDiscord',    hintKey: 'platDiscordHint' },
    dingtalk:   { labelKey: 'platDingtalk',   hintKey: 'platDingtalkHint' },
    feishu:     { labelKey: 'platFeishu',     hintKey: 'platFeishuHint' },
    serverchan: { labelKey: 'platServerchan', hintKey: 'platServerchanHint' },
    pushplus:   { labelKey: 'platPushplus',   hintKey: 'platPushplusHint' },
    wecom:      { labelKey: 'platWecom',      hintKey: 'platWecomHint' },
    bark:       { labelKey: 'platBark',       hintKey: 'platBarkHint' },
    webhook:    { labelKey: 'platWebhook',    hintKey: 'platWebhookHint' },
  };

  function getPlatforms(lang = 'en') {
    return PLATFORM_NAMES.map(name => {
      const cfg = PLATFORM_MAP[name];
      return {
        name,
        label: t(lang, cfg.labelKey),
        hint: t(lang, cfg.hintKey),
      };
    });
  }

  function getSupportedPlatforms(lang = 'en') {
    return getPlatforms(lang);
  }

  function getPlatformHint(platformName, lang = 'en') {
    const cfg = PLATFORM_MAP[platformName];
    return cfg ? t(lang, cfg.hintKey) : '';
  }

  /**
   * Parse stored config JSON into { channels: [{ platform, token }] }.
   * Handles both new multi-channel format and legacy single-channel format.
   */
  function parseConfig(raw) {
    if (!raw) return { channels: [] };
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      // New multi-channel format
      if (Array.isArray(obj.channels)) {
        return { channels: obj.channels.filter(ch => ch.platform && ch.token) };
      }
      // Legacy single-channel format: { enabled, platform, token }
      if (obj.platform && obj.token) {
        return { channels: [{ platform: obj.platform, token: obj.token }] };
      }
      return { channels: [] };
    } catch {
      return { channels: [] };
    }
  }

  function serializeConfig(cfg) {
    const channels = (cfg.channels || []).filter(ch => ch.platform && ch.token);
    return JSON.stringify({ channels });
  }

  /**
   * Check if at least one valid channel is configured.
   */
  function hasChannels(cfg) {
    const parsed = typeof cfg === 'string' ? parseConfig(cfg) : cfg;
    return parsed.channels.length > 0;
  }

  /**
   * Get summary text for configured channels (for badge display).
   */
  function getChannelSummary(cfg, lang = 'en') {
    const parsed = typeof cfg === 'string' ? parseConfig(cfg) : cfg;
    if (parsed.channels.length === 0) return '';
    const platforms = getPlatforms(lang);
    return parsed.channels.map(ch => {
      const p = platforms.find(pl => pl.name === ch.platform);
      return p ? p.label : ch.platform;
    }).join(', ');
  }

  return {
    getSupportedPlatforms,
    getPlatformHint,
    parseConfig,
    serializeConfig,
    hasChannels,
    getChannelSummary,
  };
})();

export default PushooNotifier;
