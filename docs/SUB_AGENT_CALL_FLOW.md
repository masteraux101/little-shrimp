# Runner.js 中 Agent 调用 Sub-Agent 的流程

## 高层架构

```
主Agent (ReAct Executor) 
    ↓
[Tool Available? → explore_task] ← LLM 自动决策
    ↓
子Agent (Explorer Sub-Agent)
    │
    ├→ Planner Node (规划)
    ├→ Coder Node (生成代码)
    ├→ Executor Node (执行代码)
    ├→ Reflector Node (诊断)
    └→ 返回结果给主Agent
    ↓
[反馈到ReAct循环]
```

## 详细调用流程

### 1️⃣ **工具注册阶段** (main() 函数)

```javascript
// runner.js 第3760-3770行
const llm = createLLM(AI_PROVIDER, AI_MODEL, AI_API_KEY);
const tools = createBuiltinTools(repoStore, llm);  // ← 注册所有工具
console.log(`[Tools] Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

// tools 数组包含 14 个工具：
// 1. fetch_url          6. read_repo_file      11. load_skill
// 2. web_search         7. write_repo_file     12. clawhub_skill_detail
// 3. run_js            8. save_memory          13. screenshot_page
// 4. run_shell         9. read_memory          14. explore_task ← 子Agent工具
// 5. current_datetime  10. search_skills
```

### 2️⃣ **工具创建** (createBuiltinTools 函数)

```javascript
// runner.js 第1625-1628行
if (llm) {
  const { createExplorerTool } = require('./sub-agent');
  tools.push(createExplorerTool(llm, repoStore));  // ← 创建并注册 explore_task
}
```

**explore_task 工具的 LLM 可见定义**：
```
名称: explore_task
描述: "Launch the Explorer sub-agent for complex tasks that need dynamic code generation. 
       It will Plan → Code → Execute → Self-diagnose → Retry. 
       Use when no existing tool fits, a tool failed, or the task requires multi-step browser automation."
参数:
  - task: 任务描述 (必需)
  - error_context: 之前的错误日志 (可选)
  - page_description: 网页描述 (可选)
  - user_hints: 用户提示 (可选)
```

### 3️⃣ **Executor 初始化** (AgentGraph 构造函数)

```javascript
// runner.js 第1954行
this.executor = createReactAgent({ 
  llm: this.llm,           // LLM 实例
  tools: this._tools,      // 包含 explore_task 的工具数组 (14个)
  messageModifier: prompt  // 系统提示词，告诉LLM所有工具的用法
});
```

**prompt 中关于 explore_task 的说明** (runner.js 第1936行):
```
"10. When a task is too complex for existing tools (multi-step web automation, 
dynamic scraping of SPAs, cross-page logic), or when a tool fails with errors 
like SelectorNotFoundError/TimeoutError, use explore_task to let the Explorer 
sub-agent generate and execute custom code automatically."
```

### 4️⃣ **执行阶段** (_execute 方法 → ReAct 循环)

```javascript
// runner.js 第2330-2336行
let result;
try {
  result = await this.executor.invoke(
    { messages: execMessages },  // 消息历史 + 当前用户消息
    { recursionLimit: 60 }       // 最多60次工具调用循环
  );
}
```

**ReAct 循环工作流**:
```
┌─ Loop Start (最多60次)
│
├─ Step 1: LLM 分析
│  ├─ 看到 execMessages (用户请求 + 历史)
│  ├─ 查看 14 个工具的定义及描述
│  └─ 判定: 需要 explore_task 吗？
│      ├─ NO  → 选择其他工具 (fetch_url, run_js, etc.) 或返回答案
│      └─ YES → 决定使用 explore_task
│
├─ Step 2: 工具调用
│  ├─ LLM 输出: tool_calls = [{
│  │     name: 'explore_task',
│  │     args: {
│  │       task: '用户的具体任务',
│  │       error_context?: '如果是修复之前的失败',
│  │       page_description?: '页面上下文',
│  │       user_hints?: '我该如何做？'
│  │     }
│  │   }]
│  │
│  ├─ createReactAgent 自动执行 tool_calls
│  └─ 调用: await explore_task({ task, error_context, page_description, user_hints })
│
├─ Step 3: 子Agent 执行
│  ├─ ExplorerSubAgent.run(task, context)
│  ├─ Planner  → 决定代码语言
│  ├─ Coder    → 生成代码
│  ├─ Executor → 运行代码 (execSync, 60秒超时)
│  ├─ Reflector → 诊断 (成功/可恢复/不可恢复)
│  ├─ 如果可恢复 → 重试 (最多3次)
│  └─ 返回 result = {
│       success,
│       type,         // 'suggestion' | 'execution' | 'human_needed' | 'max_retries'
│       result,
│       output?,
│       duration
│     }
│
├─ Step 4: 工具结果返回给 LLM
│  └─ ToolMessage: "[Explorer — Success] ...\nOutput: ..."
│
├─ Step 5: LLM 处理子Agent结果
│  ├─ 阅读成功的结果 → 继续
│  ├─ 或阅读失败后给用户说明 → 返回答案
│  └─ 可能再调用其他工具 (继续循环)
│
└─ Loop End: LLM 停止 tool_calls，返回最终答案
```

### 5️⃣ **LLM 决策触发 explore_task 的条件**

主Agent的LLM会在以下情况下调用explore_task：

| 条件 | 示例 |
|------|------|
| **语义差距** | "分析这个网页上所有按钮的点击处理逻辑" (no existing tool可以做) |
| **工具失败恢复** | fetch_url 或 run_js 返回错误，需要重新写代码修复 |
| **复杂多步逻辑** | "登录网站 → 找文章 → 筛选 → 导出" (需要跨页面自动化) |
| **SPA 动态渲染** | JavaScript 渲染的单页应用 (screenshot_page + 需要交互) |
| **选择器变化** | "之前的 CSS 选择器失效，需要新策略找元素" |

## 代码调用关系图

```
main()
  └─ createLLM()                      // 创建 LLM 实例
  └─ createBuiltinTools(repoStore, llm)
       ├─ 创建 14 个工具
       └─ createExplorerTool(llm, repoStore)  // ← sub-agent.js 导出
            └─ tool(async ({ task, error_context, ... }) => {
                 const explorer = new ExplorerSubAgent(...)
                 return await explorer.run(task, context)
               })
  └─ new AgentGraph({ llm, tools, ... })
       └─ _rebuildExecutor()
            └─ createReactAgent({ llm, tools, messageModifier: prompt })
                 // prompt 中说明了所有工具，包括 explore_task

processUserMessage(text)
  └─ agentGraph.process(text, state, messages)
       └─ _analyze() / _execute() / _validate()
            └─ _execute(state, messages)
                 └─ this.executor.invoke({ messages }, { recursionLimit: 60 })
                      // ← ReAct 循环自动决定何时调用 explore_task
                           ↓
                      Tool calling loop:
                        1. LLM 看工具选项
                        2. 要用 explore_task? → yes/no
                        3. yes → 执行 explore_task
                        4. 返回结果给 LLM
                        5. LLM 继续或返回答案
```

## 关键特性

✅ **自动决策**: LLM 自动判定何时需要 explore_task（无需显式指令）  
✅ **集成透明**: explore_task 是普通工具，和 fetch_url、run_js 一样可用  
✅ **自我诊断**: 子Agent可自动重试失败（最多3次）  
✅ **参数灵活**: 支持传递错误日志、页面描述、用户提示来引导子Agent  
✅ **隔离安全**: 子Agent代码在 subprocess 中运行，60秒超时，可看日志  

## 数据流示例

### 场景：用户要求爬取动态加载的数据

```
用户消息: "抓取 https://example.com 上所有评论，按日期排序输出"
    ↓
主Agent分析
    ├─ fetch_url(url) → HTML不完整（JS未运行）
    ├─ 诊断：需要浏览器自动化
    └─ 决策：调用 explore_task
    ↓
explore_task 被调用
    ├─ Planner → "JavaScript with Playwright"
    ├─ Coder → 生成 Playwright 脚本（自带 npm install playwright）
    ├─ Executor → execSync 运行脚本 60秒
    ├─ Reflector → "[EXPLORER_SUCCESS]\n[评论1]\n[评论2]..."
    └─ 返回结果给主Agent
    ↓
主Agent收到结果
    └─ 返回给用户："已抓取 42 条评论：..."
```

### 场景：工具失败触发修复

```
主Agent尝试:
    └─ run_js("...") → Error: Cannot read property 'innerText' of null
    ↓
主Agent诊断失败
    └─ 决策：调用 explore_task + error_context
    ↓
explore_task 执行修复
    ├─ Coder 看到错误
    ├─ 重新生成代码 (改用不同选择器)
    ├─ Executor 运行新代码
    ├─ Reflector → 成功 OR 继续重试
    └─ 返回修复后的结果
    ↓
主Agent继续
    └─ 任务完成或多次重试都失败→ 返回"需要人工帮助"
```

## 总结

- **Sub-Agent 是工具**: explore_task 在工具数组中，和其他工具地位相同
- **LLM 自动决策**: createReactAgent 的 ReAct 循环中 LLM 自动选择调用哪个工具
- **无缝集成**: prompt 中说明了何时用 explore_task，LLM 遵循该规则
- **服务关系**: 子Agent 是主Agent 的 executor 的一个工具选项，不是替代关系
- **互相通信**: 主Agent 通过工具参数传上下文 → 子Agent 执行 → 返回结果 → 主Agent 理解并继续
