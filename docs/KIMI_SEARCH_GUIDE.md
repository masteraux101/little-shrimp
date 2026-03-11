# Kimi 网络搜索功能使用指南

## 功能概述

现在 Kimi 模型已支持网络搜索功能。通过启用"Enable Search Grounding"选项，Kimi 可以在生成答案前搜索最新信息，提供更准确和及时的回答。

## 如何使用

### 1. 启用搜索功能

在应用设置中：
- 选择 **Provider**: `Kimi (via Moonshot)`
- 选择任何 Kimi 模型（所有都支持搜索）
- 勾选 **Enable Search Grounding** 复选框

### 2. 发送包含搜索的消息

在启用搜索后，当您发送消息时：
1. Kimi 会自动判断是否需要搜索
2. 如果需要搜索，应用会自动进行网络搜索
3. 搜索结果被集成到模型的上下文中
4. 模型基于搜索结果生成回答

### 3. 查看搜索成本

每次网络搜索会产生：
- **搜索费用**: ¥0.03 （Kimi 内置搜索费用）
- **Token 消耗**: 搜索结果会被计入 prompt_tokens

## 支持的 Kimi 模型

所有 Kimi 模型都支持网络搜索：

| 模型 | ID | 思考模式 | 多模态 |
|------|----|---------|----|
| Kimi K2.5 (Multimodal) | `kimi-k2.5` | ✅ | ✅ |
| Kimi K2 Thinking | `kimi-k2-thinking` | ✅ | ❌ |
| Kimi K2 Thinking Turbo | `kimi-k2-thinking-turbo` | ✅ | ❌ |
| Kimi K2 Turbo Preview | `kimi-k2-turbo-preview` | ❌ | ❌ |
| Kimi K2 0905 Preview | `kimi-k2-0905-preview` | ❌ | ❌ |
| Kimi K2 0711 Preview | `kimi-k2-0711-preview` | ❌ | ❌ |
| Moonshot V1 128K | `moonshot-v1-128k` | ❌ | ❌ |

## 实现细节

### API 集成

搜索功能通过 Kimi 的内置工具 `$web_search` 实现：

```javascript
// 在请求中添加搜索工具
tools: [
  {
    type: 'builtin_function',
    function: {
      name: '$web_search'
    }
  }
]
```

### 工具调用流程

当模型需要搜索信息时：

1. **初始请求**: 发送包含 `$web_search` 工具的请求
2. **模型决策**: Kimi 决定是否需要搜索
3. **工具调用**: 如果需要，返回 `finish_reason: tool_calls`
4. **搜索执行**: App 将搜索参数原封不动返回给 Kimi
5. **最终回答**: Kimi 基于搜索结果生成回答（`finish_reason: stop`）

### 流处理架构

- **增量更新**: 流式接收并处理搜索结果
- **工具聚合**: 正确合并流中分散的 tool_calls
- **错误恢复**: 最多进行 10 次工具调用迭代以防止无限循环
- **Token 追踪**: 搜索相关的 token 消耗被正确记录

## 配置选项

### 用户设置 (localStorage)

搜索功能的配置存储在会话中：
```javascript
enableSearch: boolean  // 启用/禁用搜索
```

### 会话隔离

每个会话可以有不同的搜索设置。这通过 `SESSION_KEYS` 数组中的 `enableSearch` 配置项实现。

## 故障排除

### 搜索不工作？

1. **检查 API 余额**: 确保帐户有足够的余额支付搜索费用（¥0.03/次）
2. **模型选择**: 确认选择了支持搜索的 Kimi 模型
3. **复选框状态**: 验证"Enable Search Grounding"已勾选
4. **网络连接**: 确保网络连接正常

### Token 超限错误？

搜索结果可能导致 token 数量大幅增加。如出现 token 超限：
- 尝试使用 `kimi-k2-turbo-preview` （上下文窗口更大）
- 简化搜索查询或减少历史记录

## 代码变更总结

### src/provider-api.js
- 添加 `enableSearch` 参数到 Kimi `generateContent()` 函数
- 实现 tool_calls 处理循环
- 在 requestBody 中添加 `$web_search` 工具声明
- 更新 KIMI_MODELS dimensions 为 `search: true`

### src/chat.js  
- 向 Kimi `generateContent()` 调用传递 `enableSearch` 参数

### 前端集成
- UI 中的现有"Enable Search Grounding"复选框自动支持 Kimi
- 搜索状态通过会话存储管理

## 测试

运行验证脚本检查实现：
```bash
node test/verify-kimi-search.js
```

手动测试：
1. 在应用中选择 Kimi 模型
2. 启用搜索选项
3. 发送查询，如"最新的科技新闻"
4. 观察应用是否进行搜索并返回最新信息

## 相关文档

- [Kimi Web Search 官方文档](https://platform.moonshot.cn/docs/guide/use-web-search)
- [Tool Calls 说明](https://platform.moonshot.cn/docs/guide/use-kimi-api-to-complete-tool-calls)
- [API 价格](https://platform.moonshot.cn/docs/pricing/tools)
