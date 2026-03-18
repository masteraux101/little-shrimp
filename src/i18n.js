const LANG_KEY = 'browseragent_lang';

const messages = {
  en: {
    languageLabel: 'EN', switchLanguageTitle: 'Switch language', toggleSidebarTitle: 'Toggle sidebar',
    sessions: 'Sessions', restoreTitle: 'Restore sessions from GitHub', newSessionTitle: 'New session',
    tokenTitle: 'Token usage this session', settingsTitle: 'Settings', sendTitle: 'Send', stopTitle: 'Stop generation',
    noSavedSessions: 'No saved sessions',
    pageTitle: '🍤 Shrimp — Multi-Provider AI Workspace',
    quickSkills: 'Skills', quickSouls: 'Souls', quickSchedule: 'Schedule', quickCompact: 'Compact', quickLoop: 'Loop',
    inputEnabled: 'Type a message... (Enter to send, Shift+Enter for new line)', inputDisabled: 'Click + to start a new session',
    landingTitle: '🍤 Shrimp', landingDesc: 'A fully browser-based multi-provider AI workspace with Loop Agent, SOUL personality, Skills, encrypted storage, and GitHub Actions integration.', landingCta: 'Click + in the sidebar to start a new session.', welcomeDesc: 'Your personal multi-provider AI assistant. Deploy a Loop Agent with /loop, or chat with SOUL & Skills.', statusNoSoul: 'No SOUL loaded',
    featureLoopTitle: '🔄 Loop Agent', featureLoopDesc: 'Deploy a persistent AI agent on GitHub Actions. Chat via Telegram, WeCom, or browser. Supports any OpenAI-compatible model.',
    featureSecureTitle: '🔒 Private & Secure', featureSecureDesc: 'Everything runs in your browser. No server, no tracking. Sessions are AES-256 encrypted.',
    featureSoulTitle: '🧩 SOUL & Skills', featureSoulDesc: 'Load personality files (SOUL.md) and modular skill prompts from GitHub or Notion.',
    featureStorageTitle: '☁️ Flexible Storage', featureStorageDesc: 'Save encrypted sessions to localStorage, GitHub, or Notion.',
    featureGroundingTitle: '🔍 Grounding & Thinking', featureGroundingDesc: 'Provider-aware search grounding and thinking mode for deeper reasoning.',
    featureActionsTitle: '⚡ GitHub Actions', featureActionsDesc: 'Push AI-generated code to GitHub and execute it via Actions workflows.',
    settingsPanelTitle: 'Session Settings', settingsSaveApply: 'Save & Apply',
    passphraseLabel: 'Encryption Passphrase', passphrasePlaceholder: 'Enter passphrase...', passphraseHint: 'Used to encrypt this session history. Cannot be changed after first save.',
    aiConfig: 'AI Configuration', aiProvider: 'AI Provider', aiProviderSelect: '-- Select Provider --', aiHint: 'Choose your preferred AI model provider', aiModel: 'AI Model', aiModelPlaceholder: 'e.g., gemini-2.5-flash or qwen3-max-2026-01-23', aiModelHint: 'Enter the model ID (e.g., gemini-2.5-flash, qwen3-max-2026-01-23)',
    setupApiKeyGemini: 'Gemini API Key', setupApiKeyQwen: 'Qwen API Key', setupApiKeyKimi: 'Kimi API Key', geminiKeyHint: 'Required when using Google Gemini models', qwenKeyHint: 'DashScope key for Qwen models', kimiKeyHint: 'Moonshot API key for Kimi models',
    enableSearchGrounding: 'Enable Search Grounding', enableThinking: 'Enable Thinking', thinkingBudget: 'Thinking Budget (tokens)', thinkingBudgetHint: 'Max tokens for internal reasoning. Leave empty for model default', includeThoughts: 'Include Thoughts in Response', includeThoughtsHint: "Show the model's thinking process in the output",
    personalitySkills: 'Personality & Skills', soulSource: 'SOUL Source', soulNone: '— None —', soulUseUrl: 'Use URL…', soulSourceHint: 'Choose a built-in personality or provide your own URL', soulUrl: 'SOUL URL', soulUrlHint: 'GitHub raw URL or Notion page URL', notionTokenOpt: 'Notion Integration Token (optional)', notionTokenHint: 'Required only when loading private Notion SOUL/Skill URLs', corsProxy: 'CORS Proxy URL', corsProxyHint: 'Used for Notion API requests. Replace with your own proxy if needed',
    encryptedStorage: 'Encrypted Session Storage', storageBackend: 'Storage Backend', storageLocal: 'Local (localStorage)', storageGithub: 'GitHub Repository', storageNotion: 'Notion Page', githubPat: 'GitHub Personal Access Token', githubPatHint: 'Recommended PAT permissions: Contents (Read and write), Actions (Read and write), Metadata (Read-only). Classic PAT: repo + workflow.', githubActionPatHint: 'Recommended PAT permissions: Contents (Read and write), Actions (Read and write), Metadata (Read-only). Classic PAT: repo + workflow.', repoOwner: 'Repository Owner', repoName: 'Repository Name', sessionsDir: 'Sessions Directory', autoCreateRepo: 'Auto-Create Repository', privateRepo: 'Private repository', autoCreateRepoHint: 'One-click: creates a repo and fills Owner / Repo fields. Sessions are AES-256 encrypted, public repos are fine', notionIntegrationToken: 'Notion Integration Token', notionParentPage: 'Parent Page ID', notionParentHint: 'Sessions will be created as child pages under this page',
    execTitle: 'GitHub Actions Execution', useStorageRepo: 'Use session storage repository', useStorageRepoHint: 'Reuse the GitHub repo configured for session storage', githubToken: 'GitHub Token', actionAutoRepo: 'Auto-Create Action Repository', branch: 'Branch', workflowFile: 'Workflow File', workflowFileHint: 'Filename under .github/workflows/. Auto-created if missing', artifactsDir: 'Artifacts Directory', artifactsDirHint: 'Directory in the repo where code artifacts are pushed',
    loopAgentTitle: 'Loop Agent',
    notifyTitle: 'Notifications', pushooLabel: 'Notification Channels', configPushoo: 'Configure Channels', pushooHint: 'Send workflow completion notifications to multiple platforms (WeChat, Telegram, DingTalk, Discord, etc.)',
    reloadSoul: 'Reload SOUL', restoreDialogTitle: 'Restore Sessions from GitHub', restoreDialogDesc: 'Enter your GitHub credentials to restore sessions stored in a repository.', restorePatPlaceholder: 'GitHub Personal Access Token (ghp_...)', restoreOwnerPlaceholder: 'Repository Owner (username)', restoreRepoPlaceholder: 'Repository Name', restorePathPlaceholder: 'Sessions directory (default: sessions)', cancel: 'Cancel', restore: 'Restore', decryptSession: 'Decrypt Session', decryptDesc: 'Enter the passphrase to decrypt this session.', decrypt: 'Decrypt',
    pushooModalTitle: 'Notification Channels', pushooModalDesc: 'Configure one or more notification channels. Add channels with + to receive notifications from scheduled tasks and loop agents.', platform: 'Platform', tokenKey: 'Token / Key', save: 'Save', notConfigured: '— not configured', addChannel: 'Add Channel', removeChannel: 'Remove', noChannels: 'No channels configured. Click + to add one.',
    setupConfiguring: 'Configuring...', setupDefaultSession: 'Default Session', setupWelcome: "Welcome! Let's set up your new session.", setupStep1: 'Step 1/3: Configure your AI model provider.', setupProvider: 'AI Provider', setupModel: 'Model', setupEnableSearch: 'Enable Web Search', next: 'Next ->', done: 'Done', setupStep2Title: 'Step 2/3: Set encryption passphrase', setupStep2Desc: "Your session data will be encrypted with this passphrase. Remember it: you'll need it to reload this session.", setupPassphrase: 'Encryption Passphrase', setupStep3Title: 'Step 3/3: Storage configuration', setupStep3Desc: 'Where should sessions be saved? Local storage works out of the box. GitHub allows cross-device access.', setupStorage: 'Storage Backend', setupGithubToken: 'GitHub Personal Access Token', setupGithubPatHint: 'When creating PAT, grant Contents (Read and write), Actions (Read and write), and Metadata (Read-only). Classic PAT: repo + workflow.', setupGithubOwner: 'Repository Owner', setupGithubRepo: 'Repository Name', skipLocal: 'Skip (use Local)', startSession: 'Start Session',
    saveIndicator: 'saved', supported: 'supported', unsupported: 'not supported', modelCapabilityFmt: 'Search: {search} | Think: {think}',
    toastStartFirst: 'Start a session first', toastEnterApiKey: 'Please enter your API key', toastEnterModel: 'Please enter a model name', toastPassphraseEmpty: 'Passphrase cannot be empty', toastGithubFillOrSkip: 'Please fill in all GitHub fields, or click Skip to use Local', toastSessionReady: 'Session ready! Start chatting.', toastGenerationStopped: 'Generation stopped', toastPushooSaved: 'Pushoo configuration saved', toastClickPlusFirst: 'Click + to start a new session first', toastNoActiveSession: 'No active session', toastSetApiKeyFirst: 'Set API key first', toastSetModelInSettings: 'Please set a model in session settings', toastPleaseSetQwenKey: 'Please set your Qwen API key in settings', toastPleaseSetKimiKey: 'Please set your Kimi API key in settings', toastPleaseSetGeminiKey: 'Please set your Gemini API key in settings', toastRequestFailed: 'Request failed — see error above', toastSessionDeleted: 'Session deleted', toastSettingsSaved: 'Settings saved', toastNeedPassphrase: 'Please set an encryption passphrase', toastGithubFallbackLocal: 'GitHub credentials missing — saved locally. Open session settings to fix.', toastNotionFallbackLocal: 'Notion credentials missing — saved locally. Open session settings to fix.', toastDecryptFailed: 'Decryption failed — wrong passphrase', toastSessionCleared: 'Session cleared', toastHistoryCompacted: 'History compacted', toastSkillUnloaded: 'Skill unloaded', toastCronRequired: 'Please enter a cron expression', toastCronInvalid: 'Invalid cron expression — must have 5 fields (e.g. "0 9 * * *")', toastNeedGithubToken: 'Please enter your GitHub token first', toastNeedActionGithubToken: 'Enter a GitHub token for the action repo first', toastLoadingSoul: 'Loading SOUL...',
    welcomeHintsStart: 'Type a message below to start chatting.', slashClearShort: 'Clear history', slashCompactShort: 'Compress context', slashSoulShort: 'SOUL menu', slashSkillsShort: 'List skills',
    slashScheduleDesc: 'Create a cron scheduled task from conversation code', slashGithubDesc: 'Open GitHub command menu', slashGithubStatusDesc: 'List workflows and active runs in the repo', slashGithubRunDesc: 'Trigger (workflow_dispatch) a specific workflow', slashGithubDeleteDesc: 'Delete a workflow file', slashLoopDesc: 'Open Loop Agent command menu', slashLoopStatusDesc: 'Check status of running loop agents', slashLoopConnectDesc: 'Connect to a running loop agent and chat directly', slashLoopDisconnectDesc: 'Disconnect from the current loop agent', slashLoopChannelDesc: 'Switch notification channels for connected loop agent', slashLoopDashboardDesc: 'Show/hide the Loop Agent status dashboard', slashLoopMemoryClearDesc: 'Clear the loop agent persistent memory file', slashSkillsDesc: 'Manage skills — browse built-in library & custom URLs', slashSoulDesc: 'Open SOUL command menu', slashSoulListDesc: 'Browse available built-in SOULs', slashCompactDesc: 'Compress conversation history into a summary', slashClearDesc: 'Clear all messages in current session',
    commandMenuSubtitle: 'Select a sub-command to continue', githubMenuTitle: 'GitHub Command Menu', githubMenuStatusLabel: 'Workflow Status', githubMenuRunLabel: 'Run Workflow', githubMenuDeleteLabel: 'Delete Workflow', loopMenuTitle: 'Loop Agent Command Menu', loopMenuDeployLabel: 'Deploy Loop Agent', loopMenuStatusLabel: 'Check Running Status', loopMenuConnectLabel: 'Connect To Agent', loopMenuDisconnectLabel: 'Disconnect Session', loopMenuChannelLabel: 'Switch Notification Channel', loopMenuDashboardLabel: 'Open Dashboard Panel', loopMenuMemoryClearLabel: 'Clear Persistent Memory', soulMenuTitle: 'SOUL Command Menu', soulMenuInfoLabel: 'Current SOUL Info', soulMenuListLabel: 'Browse Built-in SOULs', soulMenuSetLabel: 'Set SOUL From URL/Name', soulMenuSetDesc: 'Select this, then type SOUL name or URL after /soul',
    msgLoadingBuiltinSouls: 'Loading built-in SOULs', msgNoBuiltinSouls: 'No built-in SOULs available.', msgBuiltinSoulsTitle: 'Built-in SOULs', msgClickUseSoul: 'Click "Use" to switch to a personality.', msgSwitchedTo: 'Switched to', btnActive: 'Active', msgFailed: 'Failed', msgInvalidSoulNameOrUrl: 'Not a valid URL or built-in SOUL name.', msgAvailableBuiltinSouls: 'Available built-in SOULs', msgOrProvideUrl: 'Or provide a full URL', msgLoadingSoul: 'Loading SOUL', msgSwitchedSoul: 'Switched to SOUL', msgSkillsLoaded: 'skills loaded', msgFailedLoadSoul: 'Failed to load SOUL', msgCurrentSoul: 'Current SOUL', msgNone: 'None', msgNotSet: 'Not set', msgSoulListTip: 'Tip: Use `/soul list` to browse built-in SOULs.', msgInvalidSkillNameOrUrl: 'Not a valid URL or built-in skill name.', msgAvailableBuiltinSkills: 'Available built-in skills', msgLoadingSkill: 'Loading skill', msgLoadedSkill: 'Loaded skill', msgFailedLoadSkill: 'Failed to load skill', msgLoadingSkillLibrary: 'Loading skill library', btnUnload: 'Unload', msgNoSkillsLoadedYet: 'No skills loaded yet.', msgSkillManager: 'Skill Manager', msgActiveSkills: 'Active Skills', msgAddSkillUrl: 'Add skill URL…', msgBuiltinLibrary: 'Built-in Library', msgOneClickLoadSkill: 'One-click to load a skill into this session.',
    msgNoCodeFoundForSchedule: 'No code found in recent conversation. Ask the AI to generate code first, then use `/schedule` to schedule it.', msgCreateScheduledTask: 'Create Scheduled Task', msgScript: 'Script', msgTaskName: 'Task Name', msgSchedule: 'Schedule', msgAutoNotifyVia: 'auto-notify via', msgConfigurePushooInSettings: 'configure in Settings → Notifications to enable', msgPreview: 'Preview', msgScheduleCreationCancelled: 'Schedule creation cancelled.', msgFetchingGithubStatus: 'Fetching GitHub status', msgLoadingWorkflows: 'Loading workflows', msgNoWorkflowsFound: 'No workflows found.', msgPickWorkflowToRun: 'Choose a workflow to run now:', msgDispatched: 'dispatched', msgDispatchFailed: 'Dispatch failed', msgCancelled: 'Cancelled.', msgPickWorkflowToDelete: 'Choose a workflow to delete:', msgDeleteConfirm: 'Delete confirmation', msgDeleteFailed: 'Delete failed',
    btnLoading: 'Loading…', btnUse: 'Use', btnAdd: 'Add', btnDeploying: 'Deploying…', btnDeploySchedule: 'Deploy Schedule', btnRunNow: 'Run Now', btnDispatching: 'Dispatching…', btnDispatched: 'Dispatched!', btnFailed: 'Failed', btnRun: 'Run', btnDeleting: 'Deleting…', btnDelete: 'Delete', btnCreating: 'Creating…', btnView: 'View', btnPush: 'Push', sourcesTitle: 'Sources', sourcesSearched: 'Searched',
    msgMessagingChannelRequired: 'A bidirectional messaging channel (e.g. Telegram) is required. Configure Pushoo with a supported platform in Settings → Notifications.', msgCheckingLoopStatus: 'Checking loop agent status', msgNoLoopAgents: 'No loop agents deployed for this session.', msgLoopAgentStatus: 'Loop Agent Status', msgDeployLoopAgent: 'Deploy Loop Agent', msgLoopKey: 'Loop Key', msgLoopSystemPrompt: 'System Prompt (optional)', msgLoopPollInterval: 'Poll Interval', msgLoopMaxRuntime: 'Max Runtime', msgDeployAndStart: 'Deploy & Start',
    confirmDeleteSession: 'Delete this session?', confirmClearSession: 'Clear all messages in current session? This action cannot be undone.',
    // Model names and capabilities
    geminiFlash: 'Gemini 2.5 Flash', geminiPro: 'Gemini 1.5 Pro', geminiExp: 'Gemini 2.0 Exp', geminiThinking: 'Gemini 2.0 Thinking',
    qwenMax: 'Qwen Max', qwenPlus: 'Qwen Plus', qwenTurbo: 'Qwen Turbo', qwenLong: 'Qwen Long', qwen3Max: 'Qwen3 Max (2026-01-23)',
    kimiPlus: 'Kimi Plus', kimiPro: 'Kimi Pro', kimiMax: 'Kimi Max',
    // Notification channel platforms
    platTelegram: 'Telegram', platWecomBot: 'WeCom Bot (企业微信机器人)', platDiscord: 'Discord', platDingtalk: 'DingTalk (钉钉)', platFeishu: 'Feishu (飞书)',
    platServerchan: 'ServerChan (WeChat)', platPushplus: 'Push Plus (WeChat)', platWecom: 'WeChat Work App (企业微信应用)',
    platBark: 'Bark (iOS)', platWebhook: 'Webhook (generic)',
    platTelegramHint: 'botToken#chatId, e.g. 123456:ABC-DEF#987654', platWecomBotHint: 'botId#secret, e.g. aibC-xxx#your-secret-key',
    platDiscordHint: 'Full webhook URL: https://discord.com/api/webhooks/...', platDingtalkHint: 'Webhook access_token, e.g. 33da1a...',
    platFeishuHint: 'Webhook token, e.g. 8838eb...', platServerchanHint: 'SCT token from sct.ftqq.com, e.g. SCTxxx',
    platPushplusHint: 'Token from www.pushplus.plus', platWecomHint: 'Webhook key, e.g. 693a91...',
    platBarkHint: 'Device key from Bark app, e.g. ABCDEF', platWebhookHint: 'Full HTTP POST/GET URL, e.g. https://example.com/webhook',
    // Loop agent workflow steps
    loopStepGenerate: 'Generating workflow YAML...', loopStepPush: 'Pushing runner script and workflow...', loopStepSecrets: 'Syncing secrets...',
    loopStepDispatch: 'Starting loop agent workflow...', loopStepDone: 'Loop agent deployed and started!',
    // Error messages
    errSessionNotFound: 'Session not found', errGithubFailed: 'GitHub operation failed', errNetworkError: 'Network error',
    errInvalidToken: 'Invalid GitHub token', errRepoNotFound: 'Repository not found', errFailedToLoad: 'Failed to load',
    errLoadRunnerFailed: 'Failed to load loop-agent runner', errGenericError: 'An error occurred',
    // Compact history message
    msgHistoryCompacted: 'Understood. I have the context from our previous conversation. How can I continue helping you?',
    // GitHub Actions descriptions
    descGithubGetUser: 'Get authenticated user from GitHub API', descGithubCreateRepo: 'Create a new repository',
    descGithubPushFiles: 'Push multiple files in atomic commit', descGithubWorkflow: 'GitHub Actions workflow',
    // Notion API errors
    errNotionUnauthorized: 'Notion access not authorized', errNotionPageNotFound: 'Notion page not found',
  },
  zh: {
    languageLabel: '中文', switchLanguageTitle: '切换语言', toggleSidebarTitle: '切换侧边栏',
    sessions: '会话', restoreTitle: '从 GitHub 恢复会话', newSessionTitle: '新建会话', tokenTitle: '当前会话 Token 使用量', settingsTitle: '设置', sendTitle: '发送', stopTitle: '停止生成', noSavedSessions: '暂无已保存会话',
    pageTitle: '🍤 小虾米 — 多模型 AI 工作台',
    quickSkills: '技能', quickSouls: '人格', quickSchedule: '定时', quickCompact: '压缩', quickLoop: '循环',
    inputEnabled: '输入消息...（Enter 发送，Shift+Enter 换行）', inputDisabled: '点击 + 开始新会话',
    landingTitle: '🍤 小虾米', landingDesc: '完全在浏览器中运行的多模型 AI 工作台，支持 Loop Agent、SOUL 人格定制、技能扩展、端到端加密存储和 GitHub Actions 集成。', landingCta: '点击左侧 + 开始新会话。', welcomeDesc: '你的浏览器内个性化 AI 助手。使用 /loop 部署 Loop Agent，或使用 SOUL & 技能进行对话。', statusNoSoul: '未加载 SOUL',
    featureLoopTitle: '🔄 Loop Agent', featureLoopDesc: '在 GitHub Actions 上部署持久化 AI Agent。通过 Telegram、企业微信或浏览器对话。支持任何 OpenAI 兼容模型。',
    featureSecureTitle: '🔒 私密与安全', featureSecureDesc: '一切在浏览器中运行，无服务器，无追踪。会话使用 AES-256 加密。',
    featureSoulTitle: '🧩 SOUL & 技能', featureSoulDesc: '从 GitHub 或 Notion 加载人格文件 (SOUL.md) 和模块化技能提示词。',
    featureStorageTitle: '☁️ 灵活存储', featureStorageDesc: '将加密会话保存到 localStorage、GitHub 或 Notion。',
    featureGroundingTitle: '🔍 搜索增强 & 思考', featureGroundingDesc: '支持根据提供商的搜索增强和思考模式，实现更深入的推理。',
    featureActionsTitle: '⚡ GitHub Actions', featureActionsDesc: '将 AI 生成的代码推送到 GitHub 并通过 Actions 工作流执行。',
    settingsPanelTitle: '会话设置', settingsSaveApply: '保存并应用',
    passphraseLabel: '加密密码', passphrasePlaceholder: '输入密码...', passphraseHint: '用于加密当前会话历史。首次保存后不可更改。',
    aiConfig: 'AI 配置', aiProvider: '模型提供商', aiProviderSelect: '-- 选择提供商 --', aiHint: '选择你偏好的模型提供商', aiModel: '模型', aiModelPlaceholder: '例如：gemini-2.5-flash 或 qwen3-max-2026-01-23', aiModelHint: '输入模型 ID（例如 gemini-2.5-flash, qwen3-max-2026-01-23）',
    setupApiKeyGemini: 'Gemini API Key', setupApiKeyQwen: 'Qwen API Key', setupApiKeyKimi: 'Kimi API Key', geminiKeyHint: '使用 Gemini 模型时必填', qwenKeyHint: 'Qwen 的 DashScope Key', kimiKeyHint: 'Kimi 的 Moonshot API Key',
    enableSearchGrounding: '开启搜索增强', enableThinking: '开启思考模式', thinkingBudget: '思考预算（tokens）', thinkingBudgetHint: '内部推理最大 token。留空则使用模型默认值', includeThoughts: '在回复中包含思考过程', includeThoughtsHint: '在输出中展示模型思考过程',
    personalitySkills: '人格与技能', soulSource: 'SOUL 来源', soulNone: '— 无 —', soulUseUrl: '使用 URL…', soulSourceHint: '选择内置人格或提供自定义 URL', soulUrl: 'SOUL URL', soulUrlHint: 'GitHub Raw URL 或 Notion 页面 URL', notionTokenOpt: 'Notion 集成 Token（可选）', notionTokenHint: '仅在加载私有 Notion SOUL/Skill 时需要', corsProxy: 'CORS 代理 URL', corsProxyHint: '用于 Notion API 请求，可替换为你自己的代理',
    encryptedStorage: '加密会话存储', storageBackend: '存储后端', storageLocal: '本地（localStorage）', storageGithub: 'GitHub 仓库', storageNotion: 'Notion 页面', githubPat: 'GitHub Personal Access Token', githubPatHint: '建议 PAT 权限：Contents（读写）、Actions（读写）、Metadata（只读）；Classic PAT 勾选 repo + workflow。', githubActionPatHint: '建议 PAT 权限：Contents（读写）、Actions（读写）、Metadata（只读）；Classic PAT 勾选 repo + workflow。', repoOwner: '仓库所有者', repoName: '仓库名称', sessionsDir: '会话目录', autoCreateRepo: '自动创建仓库', privateRepo: '私有仓库', autoCreateRepoHint: '一键创建仓库并自动填写 Owner/Repo。会话使用 AES-256 加密，公开仓库也可用。', notionIntegrationToken: 'Notion 集成 Token', notionParentPage: '父页面 ID', notionParentHint: '会话将作为子页面创建在该页面下',
    execTitle: 'GitHub Actions 执行', useStorageRepo: '复用会话存储仓库', useStorageRepoHint: '复用已配置的 GitHub 会话仓库', githubToken: 'GitHub Token', actionAutoRepo: '自动创建执行仓库', branch: '分支', workflowFile: '工作流文件', workflowFileHint: '位于 .github/workflows/ 下，不存在会自动创建', artifactsDir: '工件目录', artifactsDirHint: '代码工件推送到仓库中的目录',
    loopAgentTitle: '循环代理',
    notifyTitle: '通知', pushooLabel: '通知通道', configPushoo: '配置通道', pushooHint: '将工作流完成通知发送到多个平台（微信、Telegram、钉钉、Discord 等）',
    reloadSoul: '重新加载 SOUL', restoreDialogTitle: '从 GitHub 恢复会话', restoreDialogDesc: '输入 GitHub 凭据以恢复仓库中的会话数据。', restorePatPlaceholder: 'GitHub Personal Access Token (ghp_...)', restoreOwnerPlaceholder: '仓库所有者（用户名）', restoreRepoPlaceholder: '仓库名称', restorePathPlaceholder: '会话目录（默认：sessions）', cancel: '取消', restore: '恢复', decryptSession: '解密会话', decryptDesc: '请输入密码以解密该会话。', decrypt: '解密',
    pushooModalTitle: '通知通道', pushooModalDesc: '配置一个或多个通知通道。点击 + 添加通道，用于接收定时任务和循环代理的通知。', platform: '平台', tokenKey: 'Token / Key', save: '保存', notConfigured: '— 未配置', addChannel: '添加通道', removeChannel: '删除', noChannels: '未配置通道。点击 + 添加。',
    setupConfiguring: '完善配置中', setupDefaultSession: '默认会话', setupWelcome: '欢迎！我们来配置新会话。', setupStep1: '第 1/3 步：配置模型提供商。', setupProvider: '模型提供商', setupModel: '模型', setupEnableSearch: '开启网络搜索', next: '下一步 ->', done: '已完成', setupStep2Title: '第 2/3 步：设置加密密码', setupStep2Desc: '会话数据会使用该密码加密，请妥善保存，后续解密会用到。', setupPassphrase: '加密密码', setupStep3Title: '第 3/3 步：配置存储', setupStep3Desc: '会话保存到哪里？本地开箱即用，GitHub 支持跨设备访问。', setupStorage: '存储类型', setupGithubToken: 'GitHub Personal Access Token', setupGithubPatHint: '创建 PAT 时请授予 Contents（读写）、Actions（读写）、Metadata（只读）；Classic PAT 勾选 repo + workflow。', setupGithubOwner: '仓库所有者', setupGithubRepo: '仓库名称', skipLocal: '跳过（使用本地）', startSession: '开始会话',
    saveIndicator: '已保存', supported: '支持', unsupported: '不支持', modelCapabilityFmt: '搜索: {search} | 思考: {think}',
    toastStartFirst: '请先开始一个会话', toastEnterApiKey: '请输入 API Key', toastEnterModel: '请输入模型名称', toastPassphraseEmpty: '密码不能为空', toastGithubFillOrSkip: '请填写完整 GitHub 信息，或点击“跳过”使用本地存储', toastSessionReady: '会话已就绪，开始聊天吧。', toastGenerationStopped: '已停止生成', toastPushooSaved: 'Pushoo 配置已保存', toastClickPlusFirst: '请先点击 + 创建会话', toastNoActiveSession: '当前无活动会话', toastSetApiKeyFirst: '请先设置 API Key', toastSetModelInSettings: '请先在会话设置中选择模型', toastPleaseSetQwenKey: '请在设置中填写 Qwen API Key', toastPleaseSetKimiKey: '请在设置中填写 Kimi API Key', toastPleaseSetGeminiKey: '请在设置中填写 Gemini API Key', toastRequestFailed: '请求失败，请查看上方错误信息', toastSessionDeleted: '会话已删除', toastSettingsSaved: '设置已保存', toastNeedPassphrase: '请设置加密密码', toastGithubFallbackLocal: 'GitHub 凭据不完整，已回退本地保存。请在会话设置中修复。', toastNotionFallbackLocal: 'Notion 凭据不完整，已回退本地保存。请在会话设置中修复。', toastDecryptFailed: '解密失败：密码错误', toastSessionCleared: '会话已清空', toastHistoryCompacted: '上下文已压缩', toastSkillUnloaded: '技能已卸载', toastCronRequired: '请输入 cron 表达式', toastCronInvalid: 'cron 表达式无效，必须为 5 段（例如 "0 9 * * *"）', toastNeedGithubToken: '请先输入 GitHub Token', toastNeedActionGithubToken: '请先输入用于执行仓库的 GitHub Token', toastLoadingSoul: '正在加载 SOUL...',
    welcomeHintsStart: '在下方输入消息开始对话。', slashClearShort: '清空历史', slashCompactShort: '压缩上下文', slashSoulShort: 'SOUL 菜单', slashSkillsShort: '查看技能',
    slashScheduleDesc: '从对话代码创建 cron 定时任务', slashGithubDesc: '打开 GitHub 命令菜单', slashGithubStatusDesc: '查看仓库中的工作流和运行状态', slashGithubRunDesc: '触发指定 workflow（workflow_dispatch）', slashGithubDeleteDesc: '删除 workflow 文件', slashLoopDesc: '打开 Loop Agent 命令菜单', slashLoopStatusDesc: '检查运行中的循环代理状态', slashLoopConnectDesc: '连接到运行中的循环代理并直接对话', slashLoopDisconnectDesc: '断开当前循环代理连接', slashLoopChannelDesc: '切换已连接循环代理的通知通道', slashLoopDashboardDesc: '显示/隐藏循环代理状态面板', slashLoopMemoryClearDesc: '清理 Loop Agent 持久记忆文件', slashSkillsDesc: '管理技能：浏览内置库与自定义 URL', slashSoulDesc: '打开 SOUL 命令菜单', slashSoulListDesc: '浏览可用内置 SOUL', slashCompactDesc: '将会话历史压缩为摘要', slashClearDesc: '清空当前会话所有消息',
    commandMenuSubtitle: '请选择一个子命令继续', githubMenuTitle: 'GitHub 命令菜单', githubMenuStatusLabel: '查看工作流状态', githubMenuRunLabel: '执行工作流', githubMenuDeleteLabel: '删除工作流', loopMenuTitle: 'Loop Agent 命令菜单', loopMenuDeployLabel: '部署 Loop Agent', loopMenuStatusLabel: '查看运行状态', loopMenuConnectLabel: '连接 Agent', loopMenuDisconnectLabel: '断开连接', loopMenuChannelLabel: '切换通知通道', loopMenuDashboardLabel: '打开状态面板', loopMenuMemoryClearLabel: '清理持久记忆', soulMenuTitle: 'SOUL 命令菜单', soulMenuInfoLabel: '查看当前 SOUL', soulMenuListLabel: '浏览内置 SOUL', soulMenuSetLabel: '从 URL/名称设置 SOUL', soulMenuSetDesc: '点击后在 /soul 后继续输入 SOUL 名称或 URL',
    msgLoadingBuiltinSouls: '正在加载内置 SOUL', msgNoBuiltinSouls: '暂无内置 SOUL。', msgBuiltinSoulsTitle: '内置 SOUL', msgClickUseSoul: '点击“使用”即可切换人格。', msgSwitchedTo: '已切换到', btnActive: '当前', msgFailed: '失败', msgInvalidSoulNameOrUrl: '不是有效 URL 或内置 SOUL 名称。', msgAvailableBuiltinSouls: '可用内置 SOUL', msgOrProvideUrl: '或提供完整 URL', msgLoadingSoul: '正在加载 SOUL', msgSwitchedSoul: '已切换 SOUL', msgSkillsLoaded: '个技能已加载', msgFailedLoadSoul: '加载 SOUL 失败', msgCurrentSoul: '当前 SOUL', msgNone: '无', msgNotSet: '未设置', msgSoulListTip: '提示：使用 `/soul list` 浏览内置 SOUL。', msgInvalidSkillNameOrUrl: '不是有效 URL 或内置技能名称。', msgAvailableBuiltinSkills: '可用内置技能', msgLoadingSkill: '正在加载技能', msgLoadedSkill: '已加载技能', msgFailedLoadSkill: '加载技能失败', msgLoadingSkillLibrary: '正在加载技能库', btnUnload: '卸载', msgNoSkillsLoadedYet: '当前未加载技能。', msgSkillManager: '技能管理', msgActiveSkills: '已激活技能', msgAddSkillUrl: '添加技能 URL…', msgBuiltinLibrary: '内置库', msgOneClickLoadSkill: '一键将技能加载到当前会话。',
    msgNoCodeFoundForSchedule: '最近会话中未找到代码，请先让模型生成代码，再使用 `/schedule` 创建定时任务。', msgCreateScheduledTask: '创建定时任务', msgScript: '脚本', msgTaskName: '任务名称', msgSchedule: '调度', msgAutoNotifyVia: '自动通知平台', msgConfigurePushooInSettings: '请在 设置 → 通知 中启用', msgPreview: '预览', msgScheduleCreationCancelled: '已取消创建定时任务。', msgFetchingGithubStatus: '正在获取 GitHub 状态', msgLoadingWorkflows: '正在加载工作流', msgNoWorkflowsFound: '未找到工作流。', msgPickWorkflowToRun: '选择要立即执行的工作流：', msgDispatched: '已触发', msgDispatchFailed: '触发失败', msgCancelled: '已取消。', msgPickWorkflowToDelete: '选择要删除的工作流：', msgDeleteConfirm: '确认删除', msgDeleteFailed: '删除失败',
    btnLoading: '加载中…', btnUse: '使用', btnAdd: '添加', btnDeploying: '部署中…', btnDeploySchedule: '部署定时任务', btnRunNow: '立即运行', btnDispatching: '触发中…', btnDispatched: '已触发', btnFailed: '失败', btnRun: '执行', btnDeleting: '删除中…', btnDelete: '删除', btnCreating: '创建中…', btnView: '查看', btnPush: '推送', sourcesTitle: '参考来源', sourcesSearched: '检索词',
    msgMessagingChannelRequired: '需要配置双向通信渠道（如 Telegram）。请在 设置 → 通知 中配置 Pushoo 支持的平台。', msgCheckingLoopStatus: '正在检查循环代理状态', msgNoLoopAgents: '当前会话没有已部署的循环代理。', msgLoopAgentStatus: '循环代理状态', msgDeployLoopAgent: '部署循环代理', msgLoopKey: '循环密钥', msgLoopSystemPrompt: '系统提示词（可选）', msgLoopPollInterval: '轮询间隔', msgLoopMaxRuntime: '最大运行时间', msgDeployAndStart: '部署并启动',
    confirmDeleteSession: '确认删除该会话？', confirmClearSession: '清空当前会话的所有消息？此操作不可撤销。',
    // Model names and capabilities
    geminiFlash: 'Gemini 2.5 Flash', geminiPro: 'Gemini 1.5 Pro', geminiExp: 'Gemini 2.0 Exp', geminiThinking: 'Gemini 2.0 Thinking',
    qwenMax: 'Qwen Max', qwenPlus: 'Qwen Plus', qwenTurbo: 'Qwen Turbo (快速)', qwenLong: 'Qwen Long', qwen3Max: 'Qwen3 Max (2026-01-23)',
    kimiPlus: 'Kimi Plus', kimiPro: 'Kimi Pro', kimiMax: 'Kimi Max',
    // 通知通道平台
    platTelegram: 'Telegram', platWecomBot: '企业微信机器人', platDiscord: 'Discord', platDingtalk: '钉钉', platFeishu: '飞书',
    platServerchan: 'ServerChan (微信)', platPushplus: 'Push Plus (微信)', platWecom: '企业微信应用',
    platBark: 'Bark (iOS)', platWebhook: 'Webhook (通用)',
    platTelegramHint: 'botToken#chatId，例如 123456:ABC-DEF#987654', platWecomBotHint: 'botId#secret，例如 aibC-xxx#your-secret-key',
    platDiscordHint: '完整 webhook URL: https://discord.com/api/webhooks/...', platDingtalkHint: 'Webhook access_token，例如 33da1a...',
    platFeishuHint: 'Webhook token，例如 8838eb...', platServerchanHint: 'sct.ftqq.com 的 SCT token，例如 SCTxxx',
    platPushplusHint: 'www.pushplus.plus 的 Token', platWecomHint: 'Webhook key，例如 693a91...',
    platBarkHint: 'Bark app 中的设备密钥，例如 ABCDEF', platWebhookHint: '完整 HTTP POST/GET URL，例如 https://example.com/webhook',
    // Loop agent workflow steps
    loopStepGenerate: '正在生成工作流 YAML...', loopStepPush: '正在推送运行程序脚本和工作流...', loopStepSecrets: '正在同步秘密...',
    loopStepDispatch: '正在启动循环代理工作流...', loopStepDone: '循环代理已部署并启动！',
    // Error messages
    errSessionNotFound: '会话未找到', errGithubFailed: 'GitHub 操作失败', errNetworkError: '网络错误',
    errInvalidToken: 'GitHub Token 无效', errRepoNotFound: '仓库未找到', errFailedToLoad: '加载失败',
    errLoadRunnerFailed: '加载循环代理运行程序失败', errGenericError: '发生错误',
    // Compact history message
    msgHistoryCompacted: '已明白。我已获取之前对话的上下文。接下来怎么帮你？',
    // GitHub Actions descriptions
    descGithubGetUser: '从 GitHub API 获取已认证用户', descGithubCreateRepo: '创建新仓库',
    descGithubPushFiles: '原子提交推送多个文件', descGithubWorkflow: 'GitHub Actions 工作流',
    // Notion API errors
    errNotionUnauthorized: 'Notion 访问未授权', errNotionPageNotFound: 'Notion 页面未找到',
  },
};

function getLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'zh' || saved === 'en') return saved;
  const nav = navigator.language || 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function setLang(lang) {
  const safe = lang === 'zh' ? 'zh' : 'en';
  localStorage.setItem(LANG_KEY, safe);
  return safe;
}

function t(lang, key) {
  const safe = lang === 'zh' ? 'zh' : 'en';
  return messages[safe][key] || messages.en[key] || key;
}

export { getLang, setLang, t };