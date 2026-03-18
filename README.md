# 🍤 LittleShrimp

Languages: [English](README.md) | [简体中文](README.zh-CN.md)

LittleShrimp is a browser-first AI workspace focused on one core idea: run a long-lived AI agent through GitHub Actions, while keeping the app itself zero-backend.

## Live Site

- GitHub Pages: https://masteraux101.github.io/shrimp/main.html

## 0-Backend by Design

LittleShrimp is deployed as a static site (Vite build output). There is no required application backend for core chat, configuration, and session flows.

Data and execution rely on:

- Browser runtime + Web APIs
- User-provided model APIs (OpenAI-compatible or built-in providers)
- User-owned GitHub repository + GitHub Actions for remote execution and scheduling

## Core Focus: Loop Agent

Loop Agent is the main feature of the project.

It deploys an always-on AI worker to GitHub Actions and lets you operate it from browser chat and external channels. It is designed for long-running tasks, remote execution, and continuous interaction.

### What Loop Agent does

- Runs as a persistent agent on GitHub Actions
- Supports self-healing continuation when a workflow run reaches time limits
- Executes browser automation tasks (through its browser operation module)
- Supports scheduled jobs through GitHub Actions workflows (cron)
- Sends/receives messages with encrypted payloads
- Can notify users through configured channels

### Why GitHub Actions is central

- Loop Agent runtime is hosted in GitHub Actions, not in your browser tab
- Scheduling is implemented through GitHub Actions cron workflows
- Artifacts, state exchange, and agent scripts are pushed to your repository

## Secondary Capabilities

- Multi-provider chat: Gemini, Qwen, Kimi, and OpenAI-compatible endpoints
- Session-level isolation: each session keeps independent model/storage/action settings
- SOUL system: load built-in or custom persona instructions
- Skill system: load built-in or URL-based skills for task-specific behavior
- Encrypted persistence: session payloads are encrypted before storage
- Multiple storage backends: localStorage, GitHub repo, Notion
- Optional notifications: Pushoo and email-related settings

## Common Commands

- `/loop`: deploy/manage Loop Agent
- `/loop connect <key>`: connect current session to a running Loop Agent
- `/loop status`: check Loop Agent workflow status
- `/schedule`: create and deploy a cron workflow from generated code
- `/skills`, `/skill <name-or-url>`: load/manage skills
- `/soul`, `/soul list`, `/soul <name-or-url>`: inspect/switch SOUL

## Quick Start

Requirements:

- Node.js 18+

Run locally:

```bash
npm install
npm run dev
```

Build:

```bash
npm run build
npm run preview
```

In-app first setup:

1. Create a session from the sidebar.
2. Set provider/model/API key.
3. Set an encryption passphrase.
4. Choose storage backend (local by default, GitHub optional).

## Notes

- Product UI copy is primarily English.
- This is a browser target project; avoid server-only assumptions when extending features.

## License

MIT. See [LICENSE](LICENSE).
