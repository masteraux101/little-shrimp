# 🍤 小虾米

语言版本：[English](README.md) | [简体中文](README.zh-CN.md)

🍤 小虾米是一个完全在浏览器中运行的多模型 AI 工作台，支持会话级隔离配置、SOUL 人格定制、Skill 技能扩展、端到端加密存储以及 GitHub Actions 集成。

项目采用 Vite 构建，核心流程在浏览器中完成，不依赖必须的后端服务。

## 在线体验

- GitHub Pages：`https://masteraux101.github.io/shrimp/`

## 快速开始

### 本地开发

要求：

- Node.js 18+

命令：

```bash
npm install
npm run dev
```

构建与预览：

```bash
npm run build
npm run preview
```

### 首次使用流程

1. 点击左侧 `+` 新建会话。
2. 按引导完成 3 步配置：
- 模型提供商 + 模型 + API Key（默认开启搜索）
- 加密密码（必填）
- 存储类型（默认本地，可选 GitHub）
3. 开始聊天。
4. 可在 Settings 中继续配置 SOUL/Skills、Actions、通知。

## 核心能力

### 多模型对话

- 支持 Gemini、Qwen（DashScope 兼容）、Kimi（Moonshot 兼容）
- provider/model/key 支持会话级隔离，必要时可回落到全局模板
- 支持流式输出与会话级 token 统计

### SOUL + Skill 体系

- 内置 SOUL/Skill 位于 `examples/`
- 支持 URL 加载自定义 SOUL/Skill（GitHub Raw / Notion / 通用 URL）
- 系统指令会将 SOUL 与已加载 Skill 动态合成

### 会话存储与隔离

- 每个 session 的模型设置、存储配置、执行配置、通知配置互不影响
- 存储后端：
- `localStorage`
- GitHub 仓库（`.enc` 加密文件）
- Notion 页面

### 加密模型

- 会话正文在持久化前进行加密
- 侧边栏索引元信息保留在本地以便快速展示
- 解密时必须输入对应 passphrase

### GitHub Actions 执行与定时

- 将模型产出的代码工件推送到仓库
- 自动创建/更新 workflow 并触发执行
- 轮询运行状态并回传日志结果
- 使用 `/schedule` 将最近代码生成定时任务 workflow

### 通知

- 集成 Pushoo 多平台推送
- 支持在设置中填写 Resend 相关邮件字段

## 体验特性

- 新会话创建后立即显示在侧边栏
- 配置未完成时显示 `完善配置中`
- 配置完成但尚未与模型交互时显示 `默认会话`
- 输入框上方快捷按钮：
- Skills -> `/skills`
- Souls -> `/soul list`
- Schedule -> `/schedule`
- Compact -> `/compact`
- 右上 token 区域为纯文本显示
- 对话区域仅保留文字气泡（无左右头像）

## 内置 Slash 命令

- `/skills` 管理技能
- `/skill <name-or-url>` 加载技能
- `/soul` 查看当前 SOUL
- `/soul list` 列出内置 SOUL
- `/soul <name-or-url>` 切换 SOUL
- `/compact` 压缩上下文
- `/clear` 清空当前会话
- `/schedule` 从最近代码生成并部署 cron workflow
- `/github status` 查看 workflows 与运行状态
- `/github run [workflow]` 手动触发 workflow
- `/github delete [workflow]` 删除 workflow 文件

## 项目结构

- `index.html` 页面骨架
- `style.css` 全局样式
- `src/app.js` 主协调器（UI、会话生命周期、引导、命令）
- `src/chat.js` 对话状态与流式生命周期
- `src/provider-api.js` 模型 provider 适配层
- `src/storage.js` 加密持久化（Local/GitHub/Notion）
- `src/crypto.js` Web Crypto 加解密
- `src/soul-loader.js` SOUL/Skill 加载解析
- `src/github-actions.js` 工件推送、workflow 管理、运行轮询
- `src/pushoo.js` Pushoo 配置与平台信息
- `examples/souls/` 内置 SOUL 与索引
- `examples/skills/` 内置 Skill 与索引

## 构建与部署说明

- `vite.config.js` 当前 `base` 为 `/shrimp/`
- 构建插件会复制 `examples/` 到 `dist/examples/`
- 静态部署时上传 `dist/`
- 若部署子路径不同，请同步调整 `vite.config.js` 的 `base`

## 测试

测试脚本位于 `test/`，可直接运行：

```bash
node test/test-builtin-catalog.js
node test/test-multi-provider.js
node test/test-pushoo-integration.js
node test/test-session-deletion-simple.js
node test/test-ui-fixes-simple.js
node test/verify-kimi-integration.js
node test/verify-kimi-search.js
```

说明：当前 `package.json` 里未定义 `npm run test`。

## 常见问题

- 提供商鉴权失败：
- 检查当前会话里 provider 对应 API Key 是否正确
- 解密失败：
- 多为 passphrase 错误或密文损坏
- GitHub 存储失败：
- 检查 PAT 权限、owner/repo/path 与仓库访问权限
- 模型输出为空或能力异常：
- 检查当前模型是否支持已启用的 search/thinking 选项
- 生产环境看不到内置 SOUL/Skill：
- 检查 `dist/examples/` 是否已正确生成

## 备注

- 产品界面文案以英文为主，同时支持中英文切换
- 该项目以浏览器运行时为主，开发功能时避免引入仅服务端可用的假设

## License

本项目采用 MIT 许可证 - 详见 [LICENSE](LICENSE) 文件。
