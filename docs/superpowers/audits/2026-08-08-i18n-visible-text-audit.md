# i18n 可见文本审计（Task 11）

- 范围：bounded file list（19 个文件，见各节标题）
- 日期：2026-08-08
- 分支：`feat/i18n`
- HEAD：`2c26bff92c6be8f4ee9c9d693b44e1365167ce42`（Task 10 HEAD）
- 分类口径：`locale-required` / `raw technical-or-user content` / `test fixture`
- 方法：人工通读 19 个文件 + grep 复核；保守判定，存疑归 `raw`。

## 分类汇总

- `locale-required` 残留：**8 处**（详见末尾汇总表，均为 Task 10 显式 defer 的项，外加 1 个 block-pipeline 的 thinking 占位符）
- `raw` 分类：约 60+ 处（命令名 / 参数语法 / provider / model id / tool 名 / 路径 / regex / ANSI / 技术标记 / agent-facing system prompt / 用户输入 / hook 输出 / 启动错误等）
- 资源缺口：无新增 key 缺口（8 处 `locale-required` 残留需要新 key，但概念均已在设计文档 §3.1 列入"首版 locale 化"范围，只是 Task 10 未实现）

---

## 各文件明细

### 1. `src/commands/executor.ts`

`/help` 走 translator 路径已正确本地化（`handleHelp` line 347-350，经 `buildHelpMessage(translator)`）。但 `translator` 缺省时的 fallback 以及其余命令分支仍保留大量硬编码英文 user-visible 文本。

| file:line | literal | category | rationale |
|---|---|---|---|
| executor.ts:64 | `'Compaction triggered. Use the agent to run a task and it will auto-compact when needed.'` | locale-required | /compact 成功反馈，user-visible，硬编码英文 |
| executor.ts:72 | `` `Unknown command: /${cmd.name}. Type /help for available commands.` `` | locale-required | theme 缺 ctx 的错误提示，user-visible |
| executor.ts:76 | `` `Unknown command: /${cmd.name}. Type /help for available commands.` `` | locale-required | default 分支错误提示，user-visible |
| executor.ts:92 | `` `Unknown command: /${cmd.name}. Type /help for available commands.` `` | locale-required | context default 分支错误提示，user-visible |
| executor.ts:112 | `` `Unknown skill command: /${cmd.name}` `` | locale-required | user-visible |
| executor.ts:119 | `'Usage: /skill list | /skill off <name> | /skill retry <name>'` | raw technical-or-user content | `Usage:` 前缀 + 命令名 + 参数语法 `<name>`；命令名与参数语法按设计 §3.1 不翻译。整串视为 usage 模板，建议未来 locale 化 `Usage:` 前缀但保留命令骨架——目前归 raw（保守）。 |
| executor.ts:126 | `'No skill registry available.'` | locale-required | user-visible 错误 |
| executor.ts:131 | `'Usage: /skill off <name>'` | raw technical-or-user content | 同 line 119，usage + 命令骨架 |
| executor.ts:132 | `'No negotiator available.'` | locale-required | user-visible 错误 |
| executor.ts:134 | `` `Skill "${skillName}" blocked.` `` | locale-required | user-visible 反馈（与 index.ts:736 重复，需统一 locale 化） |
| executor.ts:138 | `'Usage: /skill retry <name>'` | raw technical-or-user content | usage + 命令骨架 |
| executor.ts:139 | `'No negotiator available.'` | locale-required | user-visible |
| executor.ts:141 | `` `Skill "${skillName}" retry enabled.` `` | locale-required | user-visible 反馈 |
| executor.ts:144 | `'Usage: /skill list | /skill off <name> | /skill retry <name>'` | raw technical-or-user content | 同 line 119 |
| executor.ts:151 | `'Usage: /trigger <name> | /trigger off <name>'` | raw technical-or-user content | usage + 命令骨架 |
| executor.ts:157 | `'Usage: /trigger off <name>'` | raw technical-or-user content | usage + 命令骨架 |
| executor.ts:158 | `'No negotiator available.'` | locale-required | user-visible |
| executor.ts:160 | `` `Skill "${skillName}" blocked.` `` | locale-required | user-visible |
| executor.ts:166 | `'No skill system available.'` | locale-required | user-visible |
| executor.ts:170 | `` `Skill "${skillName}" not found.` `` | locale-required | user-visible |
| executor.ts:178 | `'No pending confirmation.'` | locale-required | user-visible（/y） |
| executor.ts:180 | `'No pending confirmation.'` | locale-required | user-visible |
| executor.ts:187 | `'No pending confirmation.'` | locale-required | user-visible（/n） |
| executor.ts:189 | `'No pending confirmation.'` | locale-required | user-visible |
| executor.ts:196 | `'No pending confirmation.'` | locale-required | user-visible（/edit） |
| executor.ts:198 | `'No pending confirmation.'` | locale-required | user-visible |
| executor.ts:201 | `` ` Feedback: ${result.feedback}` `` | locale-required | user-visible 反馈后缀（前导空格 + 动态 feedback） |
| executor.ts:209 | `'Current configuration:'` | locale-required | user-visible |
| executor.ts:211 | `' (default)'` | raw technical-or-user content | 标记后缀（标记，非自然语言） |
| executor.ts:213 | `` `    apiKey: ${provider.apiKey || '(not set)'}` `` | raw technical-or-user content | config key `apiKey` + 值；`(not set)` 是状态标记 |
| executor.ts:214 | `` `    model: ${provider.model}` `` | raw technical-or-user content | config key `model` + 值 |
| executor.ts:217 | `'  No providers configured. Use /login <provider> to add one.'` | locale-required | user-visible 提示 |
| executor.ts:228 | `` `Default provider set to: ${value}` `` | locale-required | user-visible 反馈 |
| executor.ts:233 | `` `plansDirectory set to: ${cleared ? '(default ~/.micode/plans/)' : value}` `` | locale-required | user-visible 反馈（路径是用户数据，但前缀文案需 locale） |
| executor.ts:235 | `` `Unknown config key: ${key}` `` | locale-required | user-visible 错误 |
| executor.ts:238 | `'Usage: /config or /config set <key> <value>'` | raw technical-or-user content | usage + 命令骨架 |
| executor.ts:244 | `'Usage: /login <provider> <api-key>\nSupported: anthropic, openai, google'` | raw technical-or-user content | usage + provider 名（provider 名按设计不翻译） |
| executor.ts:251 | `` `API Key saved for ${provider}. Use /provider ${provider} to activate.` `` | locale-required | user-visible 反馈（provider 名保留原样，文案需 locale） |
| executor.ts:258 | `` `Current provider: ${current}` `` | locale-required | user-visible |
| executor.ts:263 | `` `Switched to provider: ${provider}` `` | locale-required | user-visible |
| executor.ts:270 | `` `Current model: ${current}` `` | locale-required | user-visible |
| executor.ts:276 | `` `Model set to: ${model} (for ${provider})` `` | locale-required | user-visible |
| executor.ts:288 | `'No language runtime available.'` | locale-required | user-visible 错误（languageStore 缺失） |
| executor.ts:338 | `` `Permission mode set to: ${mode}` `` | locale-required | user-visible 反馈 |
| executor.ts:343 | `` `Permission mode set to: ${mode}` `` | locale-required | user-visible 反馈（legacy 路径） |
| executor.ts:353-375 | `'Available commands:\n  /config ...'`（整段 help 文本） | locale-required | `handleHelp` 的无 translator fallback；运行时 index.ts:769 总是注入 translator，此分支实测不触发，但仍是硬编码 user-visible 文本，应删除或改走 fallback 资源 |
| executor.ts:383 | `'Usage: /theme <dark|light>'` | raw technical-or-user content | usage + 命令骨架 + 枚举值 |
| executor.ts:386 | `` `Theme switched to ${themeName}` `` | locale-required | user-visible 反馈 |

注：executor.ts 是本次审计残留最密集的文件，但其内容属于 `/config /login /provider /model /skill /trigger /theme /compact` 等命令的反馈文本，与设计 §3.1"首版 locale 化"范围一致。Task 10 未覆盖 executor.ts（仅覆盖 suggestion-data + index.ts 权限问卷 + overlays + resume-hint）。这些应在后续 Task 集中 locale 化 executor。

### 2. `src/commands/suggestion-data.ts`

`description` 字段（line 32-48）是英文 fallback，仅用于向后兼容 `COMMAND_SUGGESTIONS` 静态导出；运行时走 `getCommandSuggestions(translator)` 已正确 locale 化。

| file:line | literal | category | rationale |
|---|---|---|---|
| suggestion-data.ts:32-48 | `'Show or set configuration'` 等 17 条 `description` | raw technical-or-user content | 向后兼容静态 fallback，注释 line 80 明确"保持英文 fallback"；运行时显示走 translator.t(descriptionKey) |
| suggestion-data.ts:32-48 | `'[set <key> <value>]'` 等 argHint | raw technical-or-user content | 参数语法，按设计不翻译 |
| suggestion-data.ts:32-48 | `group: 'Config'` 等 | raw technical-or-user content | 内部稳定键（`CommandGroup` 类型），非显示文本；显示走 `groupLabelKey` |
| suggestion-data.ts:103 | `` `${suggestion.groupLabel ?? suggestion.group}:` `` | raw technical-or-user content | groupLabel 来自 translator；fallback `suggestion.group` 是内部键 |

无 locale-required 残留。

### 3. `src/cli.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| cli.ts:52 | `'dark'` / `'light'` | raw technical-or-user content | theme 枚举值（ThemeName） |
| cli.ts:58 | `` `Unsupported language: ${values.language}. Supported values: ${SUPPORTED_LANGUAGES.join(', ')}.` `` | locale-required (deferred-acceptable) | 启动阶段错误，发生在 translator 构造之前（startup-language.ts:21 的 error 通道）。**无法 locale 化**——此时还未确定语言。归 raw（启动错误，bootstrap 阶段） |

cli.ts:58 是设计上不可 locale 化的启动错误（语言未定）。无 locale-required 残留。

### 4. `src/cli/resume-hint.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| resume-hint.ts:7 | `const DEFAULT_LABEL = 'Resume this session with:'` | raw technical-or-user content | translator 缺省时的 fallback；运行时 index.ts:1257 总是传入 translator（走 `cli.resumeHintLabel`），此 DEFAULT_LABEL 仅在无 translator 调用时生效（向后兼容） |
| resume-hint.ts:19 | `'\r\n\r\n\r\n\r\n'` / `'\x1b[2m'` / `'\x1b[0m'` | raw technical-or-user content | ANSI escape + 控制字符 |
| resume-hint.ts:19 | `\nmicode --resume ${sessionId}\n` | raw technical-or-user content | 命令名 `micode` + 参数语法 |

无 locale-required 残留（运行时已 locale 化）。

### 5. `src/tui/bootstrap.tsx`

| file:line | literal | category | rationale |
|---|---|---|---|
| bootstrap.tsx:104 | `'Running Bash'`（注释示例） | raw technical-or-user content | 代码注释中的示例，非字面量 |
| bootstrap.tsx:131 | `'inline'`（renderMode） | raw technical-or-user content | 内部模式枚举值 |
| bootstrap.tsx:168 | `'/^❯\s?/'` | raw technical-or-user content | regex |
| bootstrap.tsx:170 | `'❯ ${clean}'` | raw technical-or-user content | 提示符 glyph（非自然语言） |
| bootstrap.tsx:192 | `{ exitOnCtrlC: false, ... }` | raw technical-or-user content | 配置字段值 |
| bootstrap.tsx:283 | `'⎿  '` / `'   '` | raw technical-or-user content | 折叠前缀 glyph |

无 user-visible 自然语言字面量。无 locale-required 残留。

### 6. `src/tui/state/spinner-store.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| spinner-store.ts:6 | `SPINNER_FRAMES = ['·','✢','✳',...]` | raw technical-or-user content | 动画 glyph |
| spinner-store.ts:101 | `` `${seconds}s` `` / `` `${minutes}m` `` / `` `${minutes}m ${rest}s` `` | raw technical-or-user content | 时长单位缩写（s/m），按 spinner-verbs 设计原样透传，不翻译 |
| spinner-store.ts:113-118 | `thinkingStatusText` / `thoughtStatusText` | (已 locale 化) | 经 translator.t('spinner.thinking'/'thinkingWithEffort'/'thoughtFor') |

无 locale-required 残留。

### 7. `src/tui/state/spinner-verbs.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| spinner-verbs.ts:22-80 | `SPINNER_VERBS = ['Thinking','Pondering',...]`（约 200 个） | raw technical-or-user content | en-US 内置词库单一数据源（设计明确 en-US 直接复用此常量，避免与 en-US.ts 双写）。zh-CN 走 zhCN.spinner.builtinVerbs |
| spinner-verbs.ts:83 | `'/^[A-Z].*ing$/'` | raw technical-or-user content | regex |
| spinner-verbs.ts:130 | `'Thinking'`（fallback） | raw technical-or-user content | 词库空时的兜底动词 |

无 locale-required 残留（按语言选词库的设计已实现）。

### 8. `src/tui/inline-v2/AskQuestionOverlayV2.tsx`

| file:line | literal | category | rationale |
|---|---|---|---|
| AskQuestionOverlayV2.tsx:93-97 | `t('overlay.submit')` / `t('overlay.submitAnswers')` / `t('overlay.cancel')` / `t('overlay.submitHint')` | (已 locale 化) | 经 translator |
| AskQuestionOverlayV2.tsx:94 | `t('overlay.unansweredWarning')` | (已 locale 化) | 经 translator |
| AskQuestionOverlayV2.tsx:112-113 | `'[x]'` / `'[ ]'` / `'◉'` / `'◯'` | raw technical-or-user content | 选择框 glyph |
| AskQuestionOverlayV2.tsx:130 | `t('overlay.otherDefault')` | (已 locale 化) | 经 translator |
| AskQuestionOverlayV2.tsx:152 | `t('overlay.chatAction')` | (已 locale 化) | 经 translator |
| AskQuestionOverlayV2.tsx:156-158 | `t('overlay.inputModeHint')` / `t('overlay.navigationHint')` | (已 locale 化) | 经 translator |
| 各处 `'❯ '` / `'  '` | raw technical-or-user content | focus glyph |

注：`overlay.submit` 在 zh-CN 资源中刻意保留英文 `'Submit'`（pre-i18n 行为保真，见末尾 deferred 节 + 本次新增的 zh-CN.ts 注释）。

无 locale-required 残留。

### 9. `src/ui/tool-presentation.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| tool-presentation.ts:12-14 | `TOOL_ALIASES: { read: 'read_file', search: 'glob' }` | raw technical-or-user content | tool 名别名映射 |
| tool-presentation.ts:17 | `'/^\s*Error:\s*/i'` | raw technical-or-user content | regex |
| tool-presentation.ts:20 | `ANSI_ESCAPE` regex | raw technical-or-user content | regex |
| tool-presentation.ts:163 | `'<invalid pattern>'` | raw technical-or-user content | 技术标记（无效输入的占位） |
| tool-presentation.ts:204 | `'workspace'` | raw technical-or-user content | scope 默认值（语义化技术标识） |
| tool-presentation.ts:265 | `'<invalid path>'` | raw technical-or-user content | 技术标记 |
| tool-presentation.ts:312 | `'● '` / `'⎿  '` 等 | raw technical-or-user content | 块前缀 glyph |
| tool-presentation.ts:24-47 | `GROUP_TITLE_KEYS` / `GLOB_FILE_COUNT_KEYS` / `GREP_MATCH_KEYS` | (已 locale 化) | translation key 引用 |
| 各 `translator.t(...)` 调用 | (已 locale 化) | |

无 locale-required 残留。

### 10. `src/ui/ask-user-presentation.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| ask-user-presentation.ts:22-25 | `ANSWERED_SUMMARY_KEYS` | (已 locale 化) | translation key 引用 |
| 各 `translator.t(...)` 调用（line 48-67） | (已 locale 化) | |
| ask-user-presentation.ts:70 | `` `${e.header} → ${e.answer}` `` | raw technical-or-user content | header 是 agent 提供的短标签（动态用户内容），answer 是用户选择（动态）；仅 `→` 是分隔符 glyph |

无 locale-required 残留。

### 11. `src/ui/subagent-presentation.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| subagent-presentation.ts:29 | `ENVELOPE` regex `'/^\[Subagent status=.../'` | raw technical-or-user content | regex |
| subagent-presentation.ts:111 | `'Agent'`（label fallback） | ✅ **resolved**（Task 7 corrective） | 已改走 `translator.t('subagent.agentFallback')`。zh `'代理'` / en `'Agent'`。 |
| subagent-presentation.ts:113 | `` `● Agent "${label}" ${statusWord} · ${formatDurationFromMs}` `` | raw technical-or-user content | `●` glyph + `Agent`（见上）+ 动态 label + 已 locale 化的 statusWord + `·` 分隔符 + 已 locale 化的 duration |
| subagent-presentation.ts:155 | `'Agent'`（label fallback，RC-4 路径） | ✅ **resolved**（Task 7 corrective） | 同 line 111，已改走 `translator.t('subagent.agentFallback')`。 |
| subagent-presentation.ts:161/168 | `● Agent ... · ...` | raw technical-or-user content | 同 line 113 |
| 各 `translator.t(...)` 调用 | (已 locale 化) | |

注：`'Agent'` 兜底词（line 111/155）已在 Task 7 corrective 中 locale 化（`subagent.agentFallback`：zh `'代理'` / en `'Agent'`）。

### 12. `src/ui/block-pipeline.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| block-pipeline.ts:74 | `'● '`（ASSISTANT_FORMAT.firstLinePrefix） | raw technical-or-user content | 块前缀 glyph |
| block-pipeline.ts:155 | `'Thinking…'`（startThinking 临时行） | ✅ **resolved**（Task 7 corrective） | 已改走 `this.translator.t('thinking.tempLabel')`。zh `'思考中…'` / en `'Thinking…'`。 |
| block-pipeline.ts:283 | `'⎿  '` / `'   '` | raw technical-or-user content | 折叠前缀 glyph |
| block-pipeline.ts:339 | `'[tool presentation failed]'`（console.error） | raw technical-or-user content | DEBUG 模式日志，非 user-visible（仅 process.env.DEBUG 时输出到 stderr） |
| block-pipeline.ts:372 | `'  (No thinking content received)'` | ✅ **resolved**（Task 7 corrective） | 已改走 `this.translator.t('thinking.noContent')`。前导 2 空格保留在资源值中（与 `buildThinkingFullLines` 的 has-content 分支 `  ${l}` 缩进对齐，刻意双缩进）。zh `'  （无思考内容）'` / en `'  (No thinking content received)'`。 |
| block-pipeline.ts:169 | `this.translator.t('thinking.summary', ...)` | (已 locale 化) | |

locale-required 残留：**0**（line 155、372 已在 Task 7 corrective 中全部 locale 化）。

### 13. `src/permission/permission-answer-mapping.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| permission-answer-mapping.ts:9-12 | `'permission.allowOnce'` / `'permission.allowExactSession'` / `'permission.allowAlways'` / `'permission.reject'` | raw technical-or-user content | 稳定 decision value（与显示 label 解耦，见设计 §3.3 / commit `333e333`），是协议字段，绝不翻译 |
| permission-answer-mapping.ts:26-28 | `protocol_version` / `decision_id` / `decided_at` | raw technical-or-user content | UserDecision 协议字段名 |
| permission-answer-mapping.ts:33-38 | `'approved_once'` / `'rejected'` | raw technical-or-user content | UserDecision.response 枚举值（协议字段） |
| permission-answer-mapping.ts:47-53 | `'escape'` / `'rejected'` / `'approved_once'` / `'approved_session'` / `'approved_always'` | raw technical-or-user content | DialogResult.kind 枚举值（协议字段） |
| permission-answer-mapping.ts:26 | `SECURITY_PROTOCOL_VERSION` | raw technical-or-user content | 协议版本号 |

无 locale-required 残留（全部是协议/枚举字段）。

### 14. `src/permission/auto-permission-dialog.ts`

全部 `translator.t(...)` 调用（line 34-58）已正确 locale 化。`PERMISSION_ANSWER_VALUES.*` 是协议 value（raw）。

无 locale-required 残留。

### 15. `src/utils/error-message.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| error-message.ts:11 | `DEFAULT_UNSERIALIZABLE = '[Unserializable error object]'` | raw technical-or-user content | translator 缺省时的 fallback marker；运行时传入 translator 走 `errors.unserializable`（已 locale 化） |
| error-message.ts:17 | `SENSITIVE_FIELD` regex | raw technical-or-user content | regex（敏感字段名匹配） |
| error-message.ts:19 | `SENSITIVE_TEXT_KEY` regex 片段 | raw technical-or-user content | regex |
| error-message.ts:25-34 | `'[REDACTED]'`（多处） | raw technical-or-user content | 脱敏标记（技术标记，非自然语言） |
| error-message.ts:48 | `'[Circular]'` | raw technical-or-user content | 循环引用标记 |
| error-message.ts:75-77 | `translator.t('errors.unserializable')` | (已 locale 化) | 经 translator |
| error-message.ts:99 | `'…'` | raw technical-or-user content | 截断省略号 glyph |

无 locale-required 残留（运行时已 locale 化；`[REDACTED]` / `[Circular]` 是技术标记，按设计保留原样）。

### 16. `src/index.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| index.ts:94 | `'anthropic'`（provider fallback） | raw technical-or-user content | provider 名 |
| index.ts:119-123 | `'openai'` / `'google'` / `'anthropic'` | raw technical-or-user content | provider 名 |
| index.ts:131 | `'skills'`（loadFromDir） | raw technical-or-user content | 目录路径 |
| index.ts:142 | `'.team'` | raw technical-or-user content | 目录路径 |
| index.ts:144 | `'.schedules.json'` | raw technical-or-user content | 文件路径 |
| index.ts:147-149 | `'PreToolUse'` / `'PostToolUse'` / `'SessionStart'` | raw technical-or-user content | hook 事件名（协议字段） |
| index.ts:190 | `console.error(startupLanguageSelection.error)` | raw technical-or-user content | 启动错误（translator 构造前，不可 locale 化，见 cli.ts:58） |
| index.ts:205-206 | `'build'`（permission mode） | raw technical-or-user content | 模式枚举值 |
| index.ts:222-223 | `'git rev-parse --abbrev-ref HEAD'` / `'no-git'` | raw technical-or-user content | git 命令 + 兜底标记 |
| index.ts:240 | `'small'` / `'inherit'`（modelChoice） | raw technical-or-user content | 模型选择枚举 |
| index.ts:319-321 | `'input'` / `'error'` / `'system'`（role） | raw technical-or-user content | 内部 role 枚举 |
| index.ts:385-403 | 各 `translator.t('permission.*')` | (已 locale 化) | 经 translator |
| index.ts:494 | `'.micode'`（homedir join） | raw technical-or-user content | 目录路径 |
| index.ts:515 | `'userSettings'`（transition source） | raw technical-or-user content | 内部 source 枚举 |
| index.ts:571 | `'/' + sel + ' '` | raw technical-or-user content | 命令前缀构造 |
| index.ts:579 | `['build','plan','auto']` | raw technical-or-user content | 模式枚举数组 |
| index.ts:584 | `'session'`（transition source） | raw technical-or-user content | 内部 source 枚举 |
| index.ts:601 | `expandable.kind === 'thinking' ? 'Thinking' : 'Tool result'` | ✅ resolved (Task 10 corrective) | Ctrl+O 展开覆盖层的标题，已 locale 化为 `status.overlayTitleThinking` / `status.overlayTitleToolResult` |
| index.ts:642/650/677 | `'user'` / `'assistant'`（role 比较） | raw technical-or-user content | 内部 role 枚举 |
| index.ts:711 | `'exit'` | raw technical-or-user content | 命令名 |
| index.ts:735-736 | `'default'`（userId） / `` `Skill "${blockReq.skillName}" blocked.` `` | ✅ resolved (Task 10 corrective, 后者) | userId 是内部键；blocked 消息已 locale 化为 `commands.skill.blocked`（复用，带 `{name}` 参数） |
| index.ts:744 | `'image'`（cmd.name） | raw technical-or-user content | 命令名 |
| index.ts:747 | `` `✗ ${imgResult.error}` `` | raw (reclassified, Task 10 corrective) | `✗` 是视觉符号/icon（非自然语言），`${imgResult.error}` 是动态错误体（spec：动态错误文本不翻译）。无固定自然语言散文，整体归 raw。见末尾"重分类"节 |
| index.ts:753 | `'model'`（cmd.name） | raw technical-or-user content | 命令名 |
| index.ts:765 | `['skill','trigger','y','n','edit']` | raw technical-or-user content | 命令名数组 |
| index.ts:766 | `'default'`（userId） | raw technical-or-user content | 内部 userId |
| index.ts:776 | `'userSettings'` | raw technical-or-user content | source 枚举 |
| index.ts:784/788 | `'plan'` / `'build'` / `'auto'` / `'model'` / `'provider'` | raw technical-or-user content | 命令名 |
| index.ts:800 | `plannerPrompt` | raw technical-or-user content | agent-facing prompt（src/prompts/） |
| index.ts:818 | `'# Project Rules (AGENTS.md)\n\n'` | raw technical-or-user content | agent-facing system prompt 段落标记 |
| index.ts:822-834 | `'When the user\'s request implies...'` 等（systemPrompt 拼接段） | raw technical-or-user content | agent-facing system prompt 指令（非 UI 文本）；响应语言由 `getResponseLanguagePreference(translator)` 单独注入（已 locale 化） |
| index.ts:854 | `translator.t('status.noApiKey', ...)` | (已 locale 化) | 经 translator |
| index.ts:887 | `'tool-use'`（SpinnerMode） | raw technical-or-user content | 内部模式枚举 |
| index.ts:910 | `translator.t('errors.errorPrefix', ...)` | (已 locale 化) | 经 translator |
| index.ts:913 | `'plan'`（currentMode） | raw technical-or-user content | 模式枚举 |
| index.ts:940-941 | `'requesting'` / `translator.t('status.connecting')` | (已 locale 化) | mode 是枚举；connecting 经 translator |
| index.ts:973-979 | `'addRule'` / `'recheck'` / `'permission-default'` | raw technical-or-user content | 协议/策略字段 |
| index.ts:1013-1059 | 各 `'content_block_start'` / `'thinking'` / `'text'` / `'message_start'` / `'assistant'` / `'tool_result'` | raw technical-or-user content | 流事件类型枚举（协议字段） |
| index.ts:1067 | `'PostToolUse'` | raw technical-or-user content | hook 事件名 |
| index.ts:1084-1085 | `translator.t('errors.emptyResponseVision'/'emptyResponse')` | (已 locale 化) | 经 translator |
| index.ts:1091 | `'user-cancel'`（abort reason） | raw technical-or-user content | 内部 abort 标识 |
| index.ts:1099 | `translator.t('errors.errorPrefix', ...)` | (已 locale 化) | 经 translator |
| index.ts:1131 | `translator.t('errors.persistenceFailed', ...)` | (已 locale 化) | 经 translator |
| index.ts:1161-1168 | `translator.t('cli.noSessions'/'sessionsHeader'/'sessionCount'/'resumeHintFooter')` | (已 locale 化) | 经 translator |
| index.ts:1186/1189 | `'awaiting_user'`（status） / `translator.t('cli.pendingPermissionExpired')` | (已 locale 化) | status 是枚举；pendingPermissionExpired 经 translator |
| index.ts:1207 | `'inline'`（renderMode） | raw technical-or-user content | 模式枚举 |
| index.ts:1223 | `translator.t('cli.resumedMessages', ...)` | (已 locale 化) | 经 translator |
| index.ts:1225/1230/1240 | `'user'` / `'assistant'` / `'text'`（role/type） | raw technical-or-user content | 内部枚举 |
| index.ts:1259-1261 | `'SIGINT'` / `'SIGTERM'` / `'exit'` | raw technical-or-user content | 进程信号名 |
| index.ts:1264 | `{ name: 'SessionStart', payload: {} }` | raw technical-or-user content | hook 事件名；`r.message` 是 hook 输出（raw 用户/hook 内容） |
| index.ts:1271 | `` `[scheduled:${n.scheduleId}] ${n.prompt}` `` | raw (reclassified, Task 10 corrective) | `[scheduled:<id>]` 是结构化/系统标签前缀（无自然语言），`${n.prompt}` 是动态用户自定义 prompt（spec：用户输入不翻译）。无固定可翻译散文，整体归 raw。见末尾"重分类"节 |

index.ts 的 locale-required 残留（Task 10 显式 defer）—— **Task 10 corrective 后全部 resolved**：
- ~~line 601：`'Thinking'` / `'Tool result'`（Ctrl+O 标题）~~ → ✅ resolved：`translator.t('status.overlayTitleThinking')` / `translator.t('status.overlayTitleToolResult')`
- ~~line 696：`'── 上一条消息已撤回 ──'`（撤回标记，硬编码中文）~~ → ✅ resolved：`translator.t('status.rewindNotice')`
- ~~line 736：`` `Skill "${blockReq.skillName}" blocked.` ``（skill 拦截反馈）~~ → ✅ resolved：`translator.t('commands.skill.blocked', { name: blockReq.skillName })`（复用现有 key）
- ~~line 747：`` `✗ ${imgResult.error}` ``（图片错误前缀，标记 + 动态）~~ → ✅ reclassified as `raw`
- ~~line 1271：`` `[scheduled:${n.scheduleId}] ${n.prompt}` ``（调度前缀，标记 + 动态用户内容）~~ → ✅ reclassified as `raw`

注：line 696 的撤回标记原是整个 bounded list 中**唯一**的硬编码中文 user-visible 字符串——现已 locale 化。

### 17. `src/prompts/response-language-preference.ts`

| file:line | literal | category | rationale |
|---|---|---|---|
| response-language-preference.ts:4 | `translator.t('agent.responseLanguagePreference')` | (已 locale 化) | 经 translator |

无 locale-required 残留。

### 18. `src/locale/resources/zh-CN.ts`（canonical shape 源）

此文件是 canonical 资源（`CanonicalResources = typeof zhCN`）。所有字面量定义均为资源值，不是"待 locale 化"对象。

特记：
- zh-CN.ts:86 `submit: 'Submit'` —— 刻意保留英文（pre-i18n 行为保真，Task 10 reviewer Minor #1）。本次审计已新增单行注释说明此决策（见 step 7）。
- zh-CN.ts:75-82 `builtinVerbs`（32 个中文动词）—— zh-CN spinner 内置词库，由 spinner-verbs.ts:96 消费。
- 各 `placeholder` 字段（line 3/40/50/61/64/71/85/97/155/158/170/220）—— 命名空间结构标记，非 user-visible（见资源完整性节）。

### 19. `src/locale/resources/en-US.ts`

en-US 资源，`CanonicalResources` 类型强制结构对齐。

特记：
- en-US.ts:77-81 注释明确 `builtinVerbs`（230 个英文动词）仅为资源结构对齐 + 文档独立可读，运行时英文词库单一数据源是 spinner-verbs.ts 的 `SPINNER_VERBS`。
- en-US.ts:66 `fallbackDemo: ''`（空串）—— translator 对空串回退到 zhCN（`fallback` 机制，translator.ts:37）。

---

## locale-required 残留汇总（action items）

| file:line | current text | recommended key | 状态 |
|---|---|---|---|
| index.ts:601 | `'Thinking'` / `'Tool result'`（Ctrl+O 标题） | `status.overlayTitleThinking` / `status.overlayTitleToolResult` | ✅ **resolved**（Task 10 corrective）—— 已改走 `translator.t('status.overlayTitleThinking')` / `translator.t('status.overlayTitleToolResult')`。注意：与 `spinner.thinking`（spinner 状态文本）不同，使用独立 key。 |
| index.ts:696 | `'── 上一条消息已撤回 ──'`（撤回标记） | `status.rewindNotice` | ✅ **resolved**（Task 10 corrective）—— 已改走 `translator.t('status.rewindNotice')`。 |
| index.ts:736 | `` `Skill "${skillName}" blocked.` `` | `commands.skill.blocked`（复用，Task 4 corrective 已加 `{name}` 参数） | ✅ **resolved**（Task 10 corrective）—— 已改走 `translator.t('commands.skill.blocked', { name: blockReq.skillName })`。**未新增 key**，复用 Task 4 corrective 的现有 key。 |
| index.ts:747 | `` `✗ ${imgResult.error}` `` | （无） | ✅ **resolved**（Task 10 corrective）—— **reclassified as `raw`**（见下方"重分类"节）。 |
| index.ts:1271 | `` `[scheduled:${id}] ${prompt}` `` | （无） | ✅ **resolved**（Task 10 corrective）—— **reclassified as `raw`**（见下方"重分类"节）。 |
| block-pipeline.ts:155 | `'Thinking…'`（临时行） | `thinking.tempLabel`（新） | ✅ **resolved**（Task 7 corrective）—— 已改走 `this.translator.t('thinking.tempLabel')`。zh `'思考中…'` / en `'Thinking…'`。 |
| block-pipeline.ts:372 | `'  (No thinking content received)'` | `thinking.noContent`（新） | ✅ **resolved**（Task 7 corrective）—— 已改走 `this.translator.t('thinking.noContent')`。前导 2 空格保留在资源值中。zh `'  （无思考内容）'` / en `'  (No thinking content received)'`。 |
| executor.ts（多处，约 25+ 条） | `/config /login /provider /model /skill /trigger /theme /compact` 等命令反馈 | 需新增 `commands.*` 子树（`commands.compact.triggered` / `commands.unknown` / `commands.noSkillRegistry` / `commands.skillBlocked` / `commands.config.*` / `commands.login.saved` / `commands.provider.*` / `commands.model.*` / `commands.theme.switched` / `commands.mode.set` 等） | 后续 executor locale 化 task（独立） |

### 重分类（reclassifications）

Task 10 corrective 期间，对原审计标为 `locale-required` 的 2 处重新判定为 `raw`，依据如下：

| file:line | original category | reclassified | evidence |
|---|---|---|---|
| index.ts:747 | locale-required (prefix only) | **`raw`** | `` `✗ ${imgResult.error}` `` —— `✗` 是视觉符号/icon（非自然语言），`${imgResult.error}` 是动态错误体（spec：动态错误文本不翻译）。**无固定自然语言散文**需要 locale 化。无需新增 resource key。 |
| index.ts:1271 | locale-required (prefix only) | **`raw`** | `` `[scheduled:${n.scheduleId}] ${n.prompt}` `` —— `[scheduled:<id>]` 是结构化/系统标签前缀（无自然语言），`${n.prompt}` 是动态用户自定义 prompt 内容（spec：用户输入不翻译）。**无固定可翻译散文**。spec §3.1"调度提示"指 notification 是 user-visible，但此渲染无完整可翻译句子。无需新增 resource key。 |

判定准则：locale 化针对"固定自然语言散文"。当一行仅由 **(a) 视觉符号/系统标签 + (b) 动态内容** 组成、无固定自然语言成分时，归 `raw`。

低优先（保守可归 raw）—— 已全部 locale 化：
- subagent-presentation.ts:111/155 `'Agent'`（label 兜底）—— ✅ **resolved**（Task 7 corrective）—— 已改走 `translator.t('subagent.agentFallback')`。zh `'代理'` / en `'Agent'`。

---

## 资源完整性

### 结构对齐

- zh-CN 与 en-US 均有 **140 个叶子 key**（数组按 1 个 key 计，如 `spinner.builtinVerbs`），结构完全一致（无 missing key）。
- 强制机制：`CanonicalResources = typeof zhCN`（types.ts:14），en-US 标注 `: CanonicalResources`（en-US.ts:3），TypeScript 编译期拒绝结构不匹配。
- 验证：`npm run typecheck` 通过。

### placeholder 名称集合

- `resource-shape.test.ts` 递归比对每个共享叶子节点的 `{placeholder}` 名称集合，通过。
- 此测试是设计 §12.2 明确的唯一 placeholder 契约，本次审计**未新增** AST lint 或第二套 key-set 测试（符合 Task 11 约束）。

### 未使用 key（informational，不删除）

经 grep 全 src（排除资源文件与测试）核实，以下 key 在生产代码中未被引用：

| key | 说明 |
|---|---|
| `commands.placeholder` | 命名空间结构标记 |
| `cli.placeholder` | 命名空间结构标记 |
| `errors.placeholder` | 命名空间结构标记 |
| `help.placeholder` | 命名空间结构标记 |
| `spinner.placeholder` | 命名空间结构标记 |
| `overlay.placeholder` | 命名空间结构标记 |
| `permission.placeholder` | 命名空间结构标记 |
| `tool.placeholder` | 命名空间结构标记 |
| `ask.placeholder` | 命名空间结构标记 |
| `subagent.placeholder` | 命名空间结构标记 |
| `confirmation.greetByName` | 仅在 translator.test.ts 中作为示例使用，生产代码无调用点 |
| `status.fallbackDemo` | 演示/调试 key（zh `'使用中文回退'` / en `''`），生产无引用 |

注：`*.placeholder` 是每个命名空间的统一结构标记（值如 `'命令'`/`'CLI'`/`'错误'` 等），用途是让每个命名空间在资源文件中可独立识别/文档化。它们不计入 user-visible 残留。`confirmation.greetByName` 与 `status.fallbackDemo` 是历史遗留的未接线 key，保留不删（符合"不删除资源 key"约束）。

### 资源缺口

无新增资源 key 缺口。8 处 `locale-required` 残留（见上表）需要**新增** key，但对应概念均已在设计 §3.1（命令反馈、撤回提示、调度提示）列入首版 locale 化范围，只是 Task 10 未实现这些分支。executor.ts 的批量残留建议作为独立 task 处理。

---

## 验证

### 测试

```
$ npx vitest run src/__tests__/locale/resource-shape.test.ts src/__tests__/locale/translator.test.ts

 ✓ src/__tests__/locale/resource-shape.test.ts (1 test) 10ms
 ✓ src/__tests__/locale/translator.test.ts (6 tests) 4ms

 Test Files  2 passed (2)
      Tests  7 passed (7)
```

### 类型检查

```
$ npm run typecheck
> mi-code@1.0.0 typecheck
> tsc --noEmit
（无输出 = 通过）
```

### 未新增测试

本次审计**未新增** AST lint 或第二套 key-set 测试。`git status` 在本次工作后仅含：
- `docs/superpowers/audits/2026-08-08-i18n-visible-text-audit.md`（新增审计文档）
- `src/locale/resources/zh-CN.ts`（step-7 单行注释，唯一生产文件改动）

---

## Deferred / Out-of-scope

### ExitPlanModeOverlayV2（不在 bounded list）

`src/tui/inline-v2/ExitPlanModeOverlayV2.tsx` 不在本 Task 的 19 文件 bounded list 内，但在 Task 10 期间观察到其含**多处硬编码中文** user-visible 文本：

| line | literal |
|---|---|
| 92 | `'提出修改意见'`（otherLabel） |
| 143 | `'与 Agent 讨论此计划'`（chat action） |
| 149 | `'Enter 保存修改意见 · Esc 取消'`（hint） |
| 150 | `'↑↓ 导航 · Enter 选择 · Esc 取消'`（hint） |
| 154 | `'准备开始编码？'`（标题） |
| 155 | `'以下是 Agent 拟定的计划：'`（正文） |
| 163 | `'Agent 已完成计划，是否继续执行？'`（正文） |

这些是明确的 `locale-required` 残留，应在后续 i18n task 集中处理（需新增 `planApproval.*` 资源子树）。本审计仅在 deferred 节记录，不展开逐行分类（不在 bounded list）。

### Task 10 reviewer 备注处理

1. **Minor #1：`overlay.submit` 英文保真决策** —— 已在 `src/locale/resources/zh-CN.ts:86` 新增单行注释说明 `'Submit'` 刻意保留英文以匹配 pre-i18n 行为。该决策的测试依据是 `src/__tests__/tui/inline-v2/exit-plan-mode-routing.test.tsx`，其中断言：
   - plan-approval 路由到 ExitPlanModeOverlayV2 时 frame **不含** `'Submit'`
   - 普通问卷用 AskQuestionOverlayV2 时 frame **含** `'Submit'`
   - 因 zh-CN 的 `overlay.submit` 是英文 `'Submit'`，这些断言在两种语言下均成立。

2. **exit-plan-mode 测试断言** —— `exit-plan-mode-routing.test.tsx` 的 `'Submit'` / `'准备开始编码？'` 互斥断言同时覆盖了路由正确性与 overlay.submit 保真决策，无需改动。

### 已 locale 化但本次未深审的文件

以下文件在 Task 10 已 locale 化，本次抽样确认 translator 接线正确，未逐行展开（除 bounded list 强制要求的外）：
- `src/index.ts` 权限问卷构造（line 385-403）
- `src/cli/resume-hint.ts`（line 18）
- `src/utils/error-message.ts`（line 75-77）

---

## 结论

Task 11 审计完成。bounded list 19 文件已逐文件分类。`locale-required` 残留 8 处（含 executor.ts 批量约 25+ 条命令反馈作为 1 个聚合项），全部是 Task 10 显式 defer 或未覆盖范围，无新增意外缺口。资源结构完整（110 key 对齐），placeholder 契约由现有测试守护，未新增测试（符合约束）。`overlay.submit` 保真决策已加单行注释。
