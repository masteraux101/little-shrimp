# 🍤 小虾米

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

A fully browser-based multi-provider AI workspace with per-session SOUL/Skill customization, encrypted storage, and GitHub Actions integration.

This project runs in the browser (built with Vite). There is no required backend service for core chat/storage flows.

## Status

Actively evolving. Features and UX are being iterated frequently.

## What It Does

- Multi-provider chat
- Supported providers: Gemini, Qwen (DashScope compatible), Kimi (Moonshot compatible)
- Session-isolated configuration
- Provider/model/API keys are stored per session (with global fallback templates)
- Guided first-run setup (chat-style)
- Clicking `+` opens a 3-step guided setup:
- 1) Provider + model + API key (search enabled by default)
- 2) Encryption passphrase (required)
- 3) Storage backend (default local, optional GitHub repo)
- SOUL + Skill system
- Load built-in SOULs/Skills from `examples/`
- Load custom SOUL/Skill from URL (GitHub raw / Notion / generic URL)
- Encrypt session content
- Session payloads are encrypted before persistence (AES-GCM via Web Crypto)
- Multi-backend session storage
- `localStorage`
- GitHub repository (`.enc` files)
- Notion page storage
- GitHub Actions execution workflow
- Push generated artifacts to repo
- Ensure/dispatch workflows
- Poll run status and fetch outputs
- Notifications
- Pushoo multi-platform push notifications
- Optional Resend email fields in settings

## UX Highlights

- Sidebar session appears immediately after creating a new session
- During setup, session title shows `Configuring...`
- After setup and before first model interaction, title is `Default Session`
- Quick action buttons above input:
- `Skills` (`/skills`)
- `Souls` (`/soul list`)
- `Schedule` (`/schedule`)
- `Compact` (`/compact`)
- Token usage shown as text in header (without icon)
- Chat view is text-first (no side avatars)

## Built-in Slash Commands

- `/skills` Manage skills
- `/skill <name-or-url>` Load one skill
- `/soul` Show current soul
- `/soul list` List built-in souls
- `/soul <name-or-url>` Switch soul
- `/compact` Compact conversation context
- `/clear` Clear current session
- `/schedule` Create cron workflow from generated code
- `/github status` Show workflow/run status
- `/github run [workflow]` Dispatch workflow
- `/github delete [workflow]` Delete workflow file

## Quick Start

## 1) Local development

Requirements:

- Node.js 18+

Install and run:

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
npm run preview
```

## 2) First-time usage in app

1. Click `+` in sidebar
2. Complete guided setup (provider/model/key -> passphrase -> storage)
3. Start chatting
4. Optional: open Settings to configure SOUL, Skills, GitHub Actions, notifications

## Architecture Overview

Core files:

- `src/app.js`: Main coordinator (UI, session lifecycle, setup wizard, commands)
- `src/chat.js`: Chat history + streaming + token accounting
- `src/provider-api.js`: Provider adapters (Gemini / Qwen / Kimi)
- `src/storage.js`: Local/GitHub/Notion encrypted persistence
- `src/crypto.js`: Encryption/decryption utilities (Web Crypto)
- `src/soul-loader.js`: SOUL/Skill loading and parsing
- `src/github-actions.js`: Artifact push, workflow management, run polling
- `src/pushoo.js`: Pushoo config and platform metadata

Static and catalogs:

- `index.html`: UI shell
- `style.css`: app styling
- `examples/souls/index.json`: built-in soul registry
- `examples/skills/index.json`: built-in skill registry

Build config:

- `vite.config.js` uses `base: '/shrimp/'`
- Includes a plugin that copies `examples/` into `dist/examples/`

## Data and Security Model

Session data model (conceptually):

- Session index (unencrypted, local): `id/title/soulName/timestamps/backend`
- Session body (encrypted): messages and session payload

Storage behavior:

- Session content is encrypted before save/load backend operations
- Index remains local to enable fast sidebar listing
- Per-session config isolation is enforced by session config keys

Important notes:

- Passphrase is required to decrypt an encrypted session
- If GitHub storage config is incomplete, app may fallback to local save to avoid data loss

## GitHub Actions and Scheduling

Execution flow:

1. Model generates code blocks
2. User pushes artifacts to GitHub repo
3. Workflow is created/updated (if needed)
4. Workflow run is dispatched and monitored
5. Result is shown in chat; optional notifications are sent

Scheduling flow:

- Use `/schedule` after code exists in recent conversation
- App generates cron workflow YAML and deploys it to target repo

## Tests

This repository contains focused script-based tests under `test/`.

Run examples:

```bash
node test/test-builtin-catalog.js
node test/test-multi-provider.js
node test/test-pushoo-integration.js
node test/test-session-deletion-simple.js
node test/test-ui-fixes-simple.js
node test/verify-kimi-integration.js
node test/verify-kimi-search.js
```

Note: `npm run test` is not currently defined in `package.json`.

## Deployment

Standard static deployment:

```bash
npm run build
```

Deploy `dist/` to static hosting (GitHub Pages / Vercel / Netlify / etc.).

When hosted under a subpath, ensure it matches Vite `base` (`/shrimp/`) or adjust `vite.config.js` accordingly.

## Troubleshooting

- Provider key errors
- Confirm provider-specific API key is set in session config
- Decryption failures
- Usually incorrect passphrase or corrupted encrypted blob
- GitHub storage save/load failures
- Check PAT scopes, owner/repo/path settings, and repository visibility
- Empty or missing model response
- Verify selected model supports current options (search/thinking)
- Built-in SOUL/Skill not listed in production
- Confirm `examples/` was copied to `dist/` during build

## Project Notes

- Product copy/UI language is English in-app
- Browser runtime is the primary target; avoid server-only assumptions for feature work
- `playground/` and related action experiments are non-core and may change independently

## License

Add your license information here.
