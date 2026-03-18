# 🍤 小虾米

语言版本：[English](README.md) | [简体中文](README.zh-CN.md)

小虾米是一个浏览器优先的 AI 工作台，核心目标是通过 GitHub Actions 运行可持续执行的 Loop Agent，同时保持应用本体 0 后端。

## 在线地址

- GitHub Pages：https://masteraux101.github.io/shrimp/main.html

## 0 后端定位

项目以静态站点方式部署（Vite 构建产物），核心对话、配置、会话流程不依赖自建后端。

能力来源主要是：

- 浏览器运行时与 Web API
- 用户配置的模型 API（OpenAI 兼容或内置 provider）
- 用户自己的 GitHub 仓库与 GitHub Actions（执行与定时）

## 核心重点：Loop Agent

Loop Agent 是本项目最重要的能力。

它将 AI 代理部署到 GitHub Actions 中持续运行，你可以在浏览器里或外部通道持续与它交互，适合长任务、远程执行和自动化流程。

### Loop Agent 的设计与作用

- 持久运行在 GitHub Actions 中
- workflow 超时后支持自愈接续
- 内置浏览器操作能力，可执行网页自动化任务
- 通过 GitHub Actions cron workflow 支持定时任务
- 通信内容支持加密传输
- 可按配置推送执行通知

### 为什么依赖 GitHub Actions

- Loop Agent 的运行时在 GitHub Actions，而不是浏览器标签页
- 定时任务由 GitHub Actions 的 cron 机制承载
- agent 脚本、工件与状态交换都依赖用户仓库

## 次要功能

- 多模型对话：Gemini、Qwen、Kimi、OpenAI 兼容接口
- 会话隔离：每个 session 拥有独立模型/存储/执行配置
- SOUL 加载：内置或 URL 自定义人格指令
- Skill 加载：内置或 URL 技能扩展
- 加密存储：会话正文持久化前加密
- 多后端存储：localStorage、GitHub、Notion
- 通知能力：Pushoo 与邮件相关配置

## 常用命令

- `/loop`：部署与管理 Loop Agent
- `/loop connect <key>`：连接到运行中的 Loop Agent
- `/loop status`：查看 Loop Agent workflow 状态
- `/schedule`：把最近生成代码转为定时 workflow
- `/skills`、`/skill <name-or-url>`：管理/加载 Skill
- `/soul`、`/soul list`、`/soul <name-or-url>`：查看/切换 SOUL

## 快速开始

要求：

- Node.js 18+

本地启动：

```bash
npm install
npm run dev
```

构建预览：

```bash
npm run build
npm run preview
```

首次使用：

1. 新建会话。
2. 配置 provider/model/API Key。
3. 设置加密密码。
4. 选择存储后端（默认本地，可选 GitHub）。

## 备注

- 产品界面文案以英文为主。
- 项目目标运行环境是浏览器，开发时避免服务端假设。

## License

MIT，详见 [LICENSE](LICENSE)。
