# Loop Agent 代码架构总结

## 文件概览

| 文件 | 行数 | 大小 | 职责 |
|------|------|------|------|
| `public/loop-agent/runner.js` | 4,571 | ~192 KB | 主 Agent 入口：消息轮询、ReAct 执行循环、工具注册、自愈重启 |
| `public/loop-agent/sub-agent.js` | 579 | ~24 KB | Explorer 子 Agent：代码生成→执行→自省→重试 |
| `public/loop-agent/browser-agent.js` | 980 | ~39 KB | 浏览器自动化 Agent：Playwright + Set-of-Mark 视觉标注 |
| `src/loop-agent.js` | 523 | ~20 KB | 前端部署模块：生成 YAML、同步密钥、下发 workflow、管理历史 |

---

## 一、整体三层架构

```
┌──────────────────────────────────────────────────────────┐
│          主 Agent（AgentGraph / ReAct）                  │
│  runner.js — 核心大脑，响应用户消息，调用 25+ 工具       │
│  工具: web_search / fetch_url / run_shell / run_js /     │
│        github_* / save_memory / explore_task / browser_task│
└──────────────────┬───────────────────────────────────────┘
                   │ 语义缺口或工具失败时，主动调用
┌──────────────────▼───────────────────────────────────────┐
│          Explorer 子 Agent（ExplorerSubAgent）            │
│  sub-agent.js — 代码生成、执行、反思、重试（最多 3 次）  │
│  支持: JavaScript / Python / Bash                        │
└──────────────────┬───────────────────────────────────────┘
                   │ 检测到浏览器任务时，自动路由
┌──────────────────▼───────────────────────────────────────┐
│          浏览器 Agent（BrowserAgentLoop）                  │
│  browser-agent.js — Playwright + SoM 视觉标注，          │
│  最多 30 步 OBSERVE→THINK→ACT→VERIFY 循环               │
└──────────────────────────────────────────────────────────┘
```

---

## 二、runner.js — 主 Agent（4,571 行）

### 2.1 关键模块

| 模块 | 行号区间 | 职责 |
|------|----------|------|
| `UpstashClient` | 39–84 | Redis REST 客户端，用于消息轮询 |
| `RepoStore` | 128–233 | GitHub API 封装（文件读写 + AES-256-GCM 加密） |
| Pushoo / Telegram 通知 | 237–472 | 多平台推送（Pushoo、Telegram Bot API、图片优化） |
| WeCom 支持 | 478–531 | 企业微信 WebSocket 双向消息 |
| `createBuiltinTools()` | 599–2007 | 工具工厂函数，生成 25+ LangChain 工具 |
| `createLLM()` | 2021–2064 | LLM provider 工厂（Gemini / Qwen / Kimi / OpenAI） |
| `AgentGraph` | 2256–2853 | ReAct 执行器，含 Skill/Soul 加载、检查点、计时 |
| `ConversationHistory` | 2881–2987 | 对话历史持久化（基于仓库文件） |
| `SkillRouter` | 2988–3139 | 动态注册并注入 Skill，避免冲突 |
| `ScheduleManager` | 3367–3502 | 进程内 cron 调度器 |
| Telegram Listener | 3503–3676 | Telegraf 长轮询 |
| WeCom Listener | 3677–3854 | WebSocket 双向通信 |
| `switchActiveListener()` | 3864–3938 | 运行时切换通道（Telegram ↔ WeCom ↔ 仅通知） |
| `startBrowserPolling()` | 4030–4310 | 主消息轮询循环（含休眠模式、控制指令） |
| `startScheduler()` | 3955–4029 | 每 30 秒执行到期的定时任务 |
| `main()` | 4314–4559 | 初始化、listener 启动、优雅退出 |

### 2.2 初始化流程

```
main()
  ├─ 解析环境变量（LOOP_KEY、AI_PROVIDER、UPSTASH_URL、GH_PAT 等）
  ├─ 创建 UpstashClient（可选）
  ├─ 创建 RepoStore（GitHub 文件 I/O）
  ├─ 从仓库加载 ConversationHistory
  ├─ createLLM() → 获取 LLM 实例
  ├─ createBuiltinTools() → 注册 25+ 工具
  ├─ 创建 AgentGraph → 通过 @langchain/langgraph 构建 ReAct 执行器
  ├─ 根据 PUSHOO_CHANNELS 选择监听器：
  │  ├─ Telegram → createTelegramListener()（长轮询）
  │  ├─ WeCom   → createWecomListener()（WebSocket）
  │  └─ 均无    → 仅通知模式（Upstash/仓库轮询）
  ├─ startBrowserPolling() → 主轮询循环
  ├─ startScheduler() → cron 定时器
  └─ 永久阻塞（保持事件循环活跃）
```

### 2.3 消息轮询循环（startBrowserPolling）

**自适应轮询间隔**：
- **快速轮询**（默认 5 秒）：收到消息后立即处理
- **慢速轮询**（30 秒）：空闲时降低 CPU 占用

**控制指令**（随时生效，休眠模式下也响应）：

| 指令 | 作用 |
|------|------|
| `__STATUS__` | 返回当前状态报告 |
| `__WAKE__` | 唤醒，退出休眠模式 |
| `__FOCUS__` | 进入休眠模式，忽略普通消息 |
| `__SWITCH_CHANNEL__:JSON` | 运行时切换通知渠道 |

**轮询核心逻辑**：
```
while (true):
  if 正在处理中 → 跳过
  从 Upstash/仓库文件拉取消息
  if 以 __ 开头 → handleControlMessage()
  if 休眠模式   → 忽略普通消息
  else          → processUserMessage() → agentGraph.invoke()
  通过活跃 listener 或 Pushoo 发送响应
```

### 2.4 完整消息流

```
用户输入（三种入口）
  ├─ Telegram     → Bot 长轮询 → 解析消息 → 收件箱
  ├─ WeCom        → WebSocket  → 解析消息 → 收件箱
  └─ 浏览器/Upstash → 轮询 Redis/仓库文件 → 解析消息 → 收件箱
         ↓
Browser Polling Loop（主轮询，4030–4310 行）
  ├─ 从 Upstash inbox 或仓库文件取消息
  ├─ 标记为已读
  └─ 解析为 {text, source}
         ↓
是控制指令吗？（以 __ 开头）
  ├─ 是 → handleControlMessage()
  └─ 否 → processUserMessage()
         ↓
processUserMessage()（3315–3366 行）
  ├─ 追加到 ConversationHistory
  ├─ agentGraph.invoke(messages) → ReAct 循环
  └─ 获取 responseText
         ↓
发送响应（按优先级）
  ├─ 若 Telegram listener 活跃 → listener.sendMsg()
  ├─ 若 WeCom    listener 活跃 → listener.sendMsg()（WebSocket）
  ├─ 否则 → Pushoo 推送到所有渠道
  └─ 同时回写浏览器（Upstash outbox 或仓库文件）
```

### 2.5 内置工具（25+）

**Web 与搜索：**
- `web_search` — DuckDuckGo 爬取
- `fetch_url` — HTTP GET/POST，支持自定义 header、body、超时

**代码执行：**
- `run_shell` — Bash 脚本
- `run_js` — 沙箱 VM（无 Playwright，无 require）

**仓库操作：**
- `read_repo_file` / `write_repo_file` — 仓库文件 I/O
- `screenshot_page` / `analyze_page_visual` / `crop_image` — 页面截图与视觉分析

**技能与记忆：**
- `search_skills` / `load_skill` / `unload_skill` — 动态 Skill 加载
- `save_memory` / `read_memory` — 持久化键值存储

**调度：**
- `list_scheduled_tasks` / `create_scheduled_task` / `delete_scheduled_task`

**子 Agent：**
- `explore_task` — Explorer 子 Agent（代码生成 + 浏览器自动化）
- `browser_task` — ReAct 浏览器循环（Playwright）

**GitHub API（15 个工具）：**
- `github_list_issues` / `github_create_issue` / `github_update_issue` / `github_comment_issue`
- `github_list_pulls` / `github_create_pull` / `github_merge_pull`
- `github_list_branches` / `github_create_branch`
- `github_list_repos` / `github_create_repo` / `github_get_content`
- `github_list_runs` / `github_dispatch_workflow` / `github_add_labels`

**工具：**
- `current_datetime` — Unix 时间戳
- `capture_screenshot` / `analyze_image` — 视觉工具

### 2.6 自愈重启机制

**最大运行时间检查**（4195–4205 行）：
- 若 `Date.now() - startTime >= LOOP_MAX_RUNTIME`，尝试调用 `selfRestart()`
- `selfRestart()` 通过 GitHub API 重新 dispatch 同一 workflow
- 失败时降级为正常退出（workflow 超时后由用户手动重启或另行配置）

**优雅退出**（4537–4553 行）：
- `SIGTERM` → 先尝试自愈重启
- `SIGINT` → 正常退出
- 均会：停止轮询计时器、调度器计时器、关闭 WebSocket

---

## 三、sub-agent.js — Explorer 子 Agent（579 行）

### 3.1 定位

当主 Agent 遇到"语义缺口"或工具失败时，调用 `explore_task` 工具，内部由 `ExplorerSubAgent` 处理。支持动态代码生成并在沙箱中执行，可处理任意语言的自定义逻辑。

### 3.2 Plan → Code → Execute → Reflect 循环

```
ExplorerSubAgent.run(task, context)
  ├─ _plan(task)
  │  ├─ 询问 LLM：建议使用工具 OR 生成代码？
  │  └─ 返回 { approach, language, reasoning, steps }
  │
  ├─ if approach === 'tool_suggestion'
  │  └─ 直接返回建议给主 Agent（不执行代码）
  │
  ├─ if isBrowserTask(plan, task)
  │  └─ 转发给 BrowserAgentLoop（内部处理）
  │
  └─ 代码生成路径（重试次数 < maxRetries = 3）
     ├─ _generateCode(plan, task, errorHistory)
     │  ├─ 系统提示按语言定制（JS/Python/Bash）
     │  ├─ 包含历史错误，避免重复失败
     │  └─ LLM 返回 { language, code, dependencies, description }
     │
     ├─ _executeCode(codeResult)
     │  ├─ 将脚本写入 /tmp/.explorer-tmp/{script}.{js|py|sh}
     │  ├─ 设置 NODE_PATH 以解析项目包
     │  ├─ 运行: node/python3/bash {script}，60 秒超时
     │  └─ 解析 stdout/stderr 中的 [EXPLORER_SUCCESS]/[EXPLORER_FAILURE]
     │
     ├─ _reflect(task, codeResult, execResult)
     │  ├─ LLM 分析：成功？不可恢复？可恢复？
     │  ├─ 返回 { status, diagnosis, suggestion, summary }
     │  └─ 若可恢复 → 追加到 errorHistory，重试代码生成
     │
     └─ 返回 { success, type, result, output, duration }
```

### 3.3 浏览器任务自动路由

当以下任意条件满足时，自动路由至 `BrowserAgentLoop`：

```javascript
plan.language === 'javascript' && /https?:\/\/\S+/.test(task)
// 或
/playwright|browser|page\.|navigate|click|selector|dom|scrape/.test(task)
// 或
/login|sign in|登录/.test(task) && URL 存在
```

### 3.4 代码生成约定

| 语言 | 规范 |
|------|------|
| **JavaScript** | 使用 `require()`（非 ESM），pre-installed: playwright / sharp / zod 等 |
| **Python** | 在脚本内用 `subprocess.check_call(['pip', 'install', '-q', 'pkg'])` 安装依赖 |
| **Bash** | 以 `set -euo pipefail` 开头 |
| **通用** | 最后一行必须输出 `[EXPLORER_SUCCESS]` 或 `[EXPLORER_FAILURE]: <reason>` |

### 3.5 关键类

| 类 | 行号 | 职责 |
|----|------|------|
| `ExplorerSubAgent` | 67–488 | 代码生成与执行的主编排器 |
| `createExplorerTool()` | 491–575 | LangChain 工具工厂，暴露为 `explore_task` |

---

## 四、browser-agent.js — 浏览器自动化 Agent（980 行）

### 4.1 定位

实现基于 Playwright + Set-of-Mark（SoM）视觉标注的自主浏览器自动化。独立于沙箱代码执行，直接操纵真实浏览器。

### 4.2 OBSERVE → THINK → ACT → VERIFY 循环

```
BrowserAgentLoop.run(task, context)
  ├─ BrowserManager.launch() → 启动 Playwright headless 浏览器
  ├─ 导航到任务中的 URL
  │
  └─ ReAct 循环（最多 30 步）
     │
     ├─ OBSERVE（观察）
     │  ├─ ElementParser.getPageSnapshot()
     │  │  ├─ 提取 a11y 无障碍树（深度 ≤ 5）
     │  │  ├─ 注入 Set-of-Mark（最多 80 个交互标注 [1][2]…）
     │  │  └─ 截取视口截图
     │  └─ 格式化快照 → LLM 上下文
     │
     ├─ THINK（思考）
     │  ├─ LLM 读取：快照文本 + a11y 树 + 标记编号
     │  ├─ LLM 输出：ONE 原子操作（JSON）
     │  └─ 解析：{ type, params, reasoning }
     │
     ├─ ACT（执行）
     │  ├─ ActionExecutor.execute(page, action, marks)
     │  ├─ 支持操作：click / input_text / scroll / navigate / press_key 等
     │  └─ 三级元素查找：CSS 选择器 → 坐标命中测试 → 文本匹配
     │
     ├─ VERIFY（验证）
     │  ├─ 检查：action.done? action.failed?
     │  ├─ 若 done 且有截图 → VisionAnalyzer 多模态验证
     │  └─ 若视觉判定失败 → 继续循环（不信任 Agent 的 done 声明）
     │
     └─ 循环直到：done/failed 或达到步数上限
  
  └─ 清理
     ├─ 截取最终截图
     ├─ 通过 Telegram/WeCom 发送截图
     └─ 关闭浏览器，保存 session state（Cookies/localStorage）
```

### 4.3 关键模块

| 模块 | 类 | 行号 | 职责 |
|------|----|------|------|
| A | `BrowserManager` | 53–106 | Playwright 生命周期、session 持久化 |
| B | `ElementParser` | 107–301 | a11y 树提取 + SoM 标注 + 视口截图 |
| C | `ActionExecutor` | 307–485 | 原子浏览器操作（带结构化错误回传） |
| D | `VisionAnalyzer` | 486–637 | 多模态 LLM 验证任务完成状态 |
| E | `BrowserAgentLoop` | 639–897 | ReAct 主编排循环 |
| Factory | `createBrowserTool()` | 898–969 | LangChain 工具封装，暴露为 `browser_task` |

### 4.4 ActionExecutor 支持的操作

| 操作 | 参数 | 说明 |
|------|------|------|
| `click_element` | `{id: markId}` | 点击 SoM 标记元素 |
| `input_text` | `{id, text, press_enter}` | 输入文字，可选按 Enter |
| `scroll_page` | `{direction, amount}` | 页面滚动 |
| `navigate` | `{url}` | 导航到 URL |
| `press_key` | `{key: "Enter"\|"Escape"\|...}` | 键盘按键 |
| `select_option` | `{id, value}` | 下拉框选项 |
| `hover_element` | `{id}` | 鼠标悬停 |
| `wait_for_navigation` | `{timeout?}` | 等待页面导航 |
| `get_page_source` | `{selector?}` | 获取页面源码 |
| `done` | `{reason}` | 声明任务完成 |
| `fail` | `{reason}` | 声明任务失败 |

### 4.5 VisionAnalyzer 验证流程

```javascript
verifyCompletion(screenshotPath, task)
  ├─ 加载图片，若 > 2048px 则缩放
  ├─ 构建 vision prompt："截图是否表明任务已完成？"
  ├─ 发送至 LLM（Gemini/GPT-4V）含图片
  └─ 返回 'PASS' | 'FAIL'
```

若返回 `FAIL`，拒绝 Agent 的 done 声明，继续循环。

---

## 五、src/loop-agent.js — 前端部署模块（523 行）

负责从浏览器端完成 Loop Agent 的部署与管理，不参与 Agent 运行时逻辑。

### 5.1 主要功能

| 函数 | 职责 |
|------|------|
| `generateLoopKey()` | 生成唯一 loop 标识（`loop-<8位hex>`） |
| `generateWorkflowYaml(opts)` | 生成 GitHub Actions YAML（含所有环境变量注入） |
| `deploy(opts)` | 完整部署流程：推送文件 → 同步密钥 → dispatch workflow |
| `fetchHistory(...)` | 从仓库读取对话历史（支持加密内容解密） |
| `clearMemory(...)` | 清空 MEMORY.md（可加密写回） |
| `sendIntervention(...)` | 向运行中的 Agent 发送干预消息（Upstash 或仓库文件） |
| `pollIntervention(...)` | 轮询 Agent 响应（读取 outbox，标记已读） |
| `cleanupUpstashKeys(...)` | 清理 Upstash inbox/outbox 键 |

### 5.2 deploy() 流程

```
deploy(opts)
  ├─ 1. generateWorkflowYaml() → 生成 YAML
  ├─ 2. GitHubActions.pushFiles() → 推送 4 个文件到仓库：
  │     ├─ loop-agent/runner.js
  │     ├─ loop-agent/sub-agent.js
  │     ├─ loop-agent/browser-agent.js
  │     └─ .github/workflows/loop-agent-{timestamp}.yml
  ├─ 3. GitHubActions.setRepoSecret() × N → 同步密钥：
  │     UPSTASH_URL / UPSTASH_TOKEN / AI_API_KEY / AI_BASE_URL /
  │     PUSHOO_CHANNELS / GH_PAT / LOOP_ENCRYPT_KEY
  └─ 4. GitHubActions.dispatchWorkflow() → 触发 workflow 运行
        （失败时等待 3 秒后重试一次）
```

### 5.3 干预通道（双模式）

```
Upstash 模式（优先）
  sendIntervention → SET loop:{key}:inbox
  pollIntervention → GET loop:{key}:outbox → 标记 read=true

仓库文件模式（降级）
  sendIntervention → PUT loop-agent/channel/{key}.inbox.json
  pollIntervention → GET loop-agent/channel/{key}.outbox.json → 写回 read=true
```

---

## 六、关键环境变量

```bash
# 必需
LOOP_KEY                # 唯一对话标识
AI_PROVIDER             # gemini | qwen | kimi | openai
AI_MODEL                # 模型 ID（如 gemini-2.0-flash）
AI_API_KEY              # Provider API Key

# 输入模式（三选一）
UPSTASH_URL + UPSTASH_TOKEN     # Redis 轮询
GH_PAT + GITHUB_REPOSITORY      # 仓库文件轮询
PUSHOO_CHANNELS                 # Telegram/WeCom 长连接

# 输出渠道
PUSHOO_CHANNELS         # JSON: [{"platform":"telegram","token":"..."},...] 

# GitHub
GH_PAT                  # GitHub Personal Access Token
GITHUB_REPOSITORY       # owner/repo
LOOP_WORKFLOW_FILE      # 用于自愈重启的 workflow 文件名

# 配置
LOOP_HISTORY_PATH       # 对话历史路径（默认 loop-agent/history）
LOOP_POLL_INTERVAL      # 轮询间隔秒数（默认 5）
LOOP_MAX_RUNTIME        # 最大运行时间秒数（默认 18000 = 5 小时）
LOOP_SYSTEM_PROMPT      # 自定义系统提示词
LOOP_ENCRYPT_KEY        # 可选 AES-256-GCM 加密密码
AI_BASE_URL             # OpenAI 兼容接口覆盖 URL
```

---

## 七、文件关系图

```
src/loop-agent.js（前端部署模块）
  │  部署时推送以下文件到仓库
  ├──→ public/loop-agent/runner.js
  ├──→ public/loop-agent/sub-agent.js
  ├──→ public/loop-agent/browser-agent.js
  └──→ .github/workflows/loop-agent-{ts}.yml（动态生成）

runner.js（GitHub Actions 中运行）
  │  require('./sub-agent')
  ├──→ sub-agent.js
  │     createExplorerTool() → 注册为 explore_task 工具
  │     ExplorerSubAgent → Plan/Code/Execute/Reflect 循环
  │       └─ 检测到浏览器任务时内部调用
  │           └──→ browser-agent.js
  │                 BrowserAgentLoop → OBSERVE/THINK/ACT/VERIFY 循环
  │
  └──→ browser-agent.js（直接 require）
        createBrowserTool() → 注册为 browser_task 工具
        BrowserAgentLoop → 直接被主 Agent 调用（无需经过 sub-agent）
```

---

## 八、核心设计亮点

| 特性 | 说明 |
|------|------|
| **持久化执行** | 对话历史、记忆文件存储在 GitHub 仓库，workflow 重启后无缝接续 |
| **自愈机制** | 达到最大运行时间时自动 dispatch 新 workflow，防止中断 |
| **多渠道输入** | Telegram / WeCom / Upstash / 仓库文件，运行时可动态切换 |
| **端到端加密** | AES-256-GCM 加密仓库文件与通信内容，密钥仅存于 GitHub Secret |
| **三级 Agent** | 主 Agent → Explorer 子 Agent → 浏览器 Agent，按复杂度自动分级 |
| **Set-of-Mark 视觉标注** | 在页面上注入编号标记，让 LLM 可以用数字引用页面元素 |
| **多模态验证** | 任务完成时用视觉 LLM 截图验证，防止 Agent 误报成功 |
| **Skill/Soul 动态加载** | 运行时注入技能与人格，无需重启 |
| **休眠模式** | `__FOCUS__` 指令让 Agent 暂停响应普通消息，只保持控制通道 |
