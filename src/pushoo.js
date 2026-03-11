/**
 * pushoo.js — Push notifications for workflow completion
 *
 * Pushoo API is extremely simple:
 *   pushoo(platform, { token, title, content })
 *
 * Config stored per-session: { enabled, platform, token }
 */

import { t } from './i18n.js';

const PushooNotifier = (() => {
  const PLATFORM_NAMES = [
    'serverchan', 'pushplus', 'pushplushxtrip', 'dingtalk', 'wecom', 'wecombot',
    'bark', 'telegram', 'feishu', 'discord', 'webhook', 'qmsg', 'gocqhttp',
    'atri', 'pushdeer', 'igot', 'ifttt', 'wxpusher', 'join',
  ];

  function getPlatforms(lang = 'en') {
    const platformMap = {
      serverchan: { name: 'serverchan', labelKey: 'platServerchan', hintKey: 'platServerchanHint' },
      pushplus: { name: 'pushplus', labelKey: 'platPushplus', hintKey: 'platPushplusHint' },
      pushplushxtrip: { name: 'pushplushxtrip', labelKey: 'platPushplus', hintKey: 'platPushplusHint' },
      dingtalk: { name: 'dingtalk', labelKey: 'platDingtalk', hintKey: 'platDingtalkHint' },
      wecom: { name: 'wecom', labelKey: 'platWecom', hintKey: 'platWecomHint' },
      wecombot: { name: 'wecombot', labelKey: 'platWecom', hintKey: 'platWecomHint' },
      bark: { name: 'bark', labelKey: 'platBark', hintKey: 'platBarkHint' },
      telegram: { name: 'telegram', labelKey: 'platTelegram', hintKey: 'platTelegramHint' },
      feishu: { name: 'feishu', labelKey: 'platFeishu', hintKey: 'platFeishuHint' },
      discord: { name: 'discord', labelKey: 'platDiscord', hintKey: 'platDiscordHint' },
      webhook: { name: 'webhook', labelKey: 'platWebhook', hintKey: 'platWebhookHint' },
      qmsg: { name: 'qmsg', labelKey: 'platQmsg', hintKey: 'platQmsgHint' },
      gocqhttp: { name: 'gocqhttp', labelKey: 'platGocqhttp', hintKey: 'platQmsgHint' },
      atri: { name: 'atri', labelKey: 'platAtri', hintKey: 'platQmsgHint' },
      pushdeer: { name: 'pushdeer', labelKey: 'msgNotSet', hintKey: 'msgNotSet' },
      igot: { name: 'igot', labelKey: 'msgNotSet', hintKey: 'msgNotSet' },
      ifttt: { name: 'ifttt', labelKey: 'msgNotSet', hintKey: 'msgNotSet' },
      wxpusher: { name: 'wxpusher', labelKey: 'msgNotSet', hintKey: 'msgNotSet' },
      join: { name: 'join', labelKey: 'msgNotSet', hintKey: 'msgNotSet' },
    };

    return PLATFORM_NAMES.map(name => {
      const config = platformMap[name];
      return {
        name: config.name,
        label: t(lang, config.labelKey),
        hint: t(lang, config.hintKey),
      };
    });
  }

  function getSupportedPlatforms(lang = 'en') {
    return getPlatforms(lang);
  }

  function getPlatformHint(platformName, lang = 'en') {
    const platforms = getPlatforms(lang);
    const p = platforms.find(pl => pl.name === platformName);
    return p ? p.hint : t(lang, 'msgNotSet');
  }

  function validateConfig(config) {
    if (!config) return false;
    if (!config.platform || typeof config.platform !== 'string') return false;
    if (!config.token || typeof config.token !== 'string') return false;
    return true;
  }

  function parseConfig(raw) {
    if (!raw) return { enabled: false, platform: 'serverchan', token: '' };
    try {
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return {
        enabled: !!obj.enabled,
        platform: obj.platform || 'serverchan',
        token: obj.token || '',
      };
    } catch {
      return { enabled: false, platform: 'serverchan', token: '' };
    }
  }

  function serializeConfig(cfg) {
    return JSON.stringify({ enabled: !!cfg.enabled, platform: cfg.platform || '', token: cfg.token || '' });
  }

  return {
    getSupportedPlatforms,
    getPlatformHint,
    validateConfig,
    parseConfig,
    serializeConfig,
  };
})();

export default PushooNotifier;
