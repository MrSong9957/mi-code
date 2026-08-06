// auto-mode-spec.md

# Auto 权限模式 · 完整实现规格

> **文档性质**：Agent 实现提示词（命令式规格）。本文档可作为另一台设备上 Agent 工具的整体实现指令，也可分章执行。
>
> **来源**：逆向自 Claude Code 真实源码（`src/utils/permissions/`、`src/services/tools/`、`src/tools/BashTool/`、`src/utils/forkedAgent.ts`、`src/services/api/withRetry.ts`、`src/utils/settings/`、`src/constants/prompts.ts` 等）。所有机制忠实于源码语义；代码为移植压缩版（删除遥测行、ant-only 分支、冗余注释，保留结构与关键注释）。
>
> **使用方式**：
> 1. 整体粘贴：把 §0-§14 作为实现指令交给 Agent，§13 验收总表即完成度自证清单
> 2. 分章执行：按 §14 实现顺序逐章交付，每章以该章验收清单为出口条件
>
> **[ant-only] 约定**：标注 `[ant-only]` 的机制仅存在于 Claude Code 内部构建（`TRANSCRIPT_CLASSIFIER` 特性门控），外部构建连模式枚举都不含。实现者可整体裁剪；裁剪后的行为差异在标注处说明。裁剪前请先确认：**auto 模式的裁决器（LLM 分类器）是本文档安全模型的支柱**，裁剪配套机制（denial 计数、fail-closed 铁门、危险规则剥离）会削弱安全性。

---

## 0. 架构总览与铁律

```
┌─ 规则层 ────────────────────────────────────────────────┐
│ 8 个规则源 × 3 种行为（allow/deny/ask），按来源分层       │
│ userSettings / projectSettings / localSettings /        │
│ flagSettings / policySettings / cliArg / command /      │
│ session（后三个仅内存）                                  │
├─ 管道层（9 步，绕过免疫带）─────────────────────────────┤
│ 1a-1g 规则与安全检查（免疫一切模式）                     │
│   → 2a 模式（bypass）→ 2b allow 规则 → 3 passthrough→ask│
├─ 模式转换层（只处置 ask 结果）───────────────────────────┤
│ default → 弹窗 | acceptEdits → 放行 | bypass → 放行     │
│ dontAsk → deny | auto → 分类器管道 | headless → hooks→deny│
└──────────────────────────────────────────────────────────┘
```

**设计铁律**（贯穿全文，任何实现偏离都视为缺陷）：

1. **模式与规则彻底分离**。规则决定 ask/deny（管道 1a-1g 免疫一切模式），模式只决定 ask 之后的处置方式。把模式做成"闸门"（如 plan 禁写）是错误设计。
2. **auto 只接管 ask，从不跳过闸门**。1a-1g 全部先跑；deny 规则在 auto 下照常 deny——分类器看不到被 deny 的调用。
3. **子代理默认拒绝一切 ask**。无 UI 环境只有两条出路：PermissionRequest hooks 显式决定，或自动 deny。不存在"静默 allow"。
4. **可影响裁决器 prompt 的配置只来自可信源**。分类器规则排除 projectSettings（恶意项目注入 = RCE 风险）。
5. **成本递增排列 fast-path**。规则匹配（免费）→ acceptEdits 模拟（本地）→ 白名单（零成本）→ 分类器 API（花钱）；denial 计数（3 连续/20 总计）是最后的安全气囊。

---

## 1. 核心类型系统

### 设计要点

类型系统决定整个权限域的边界。关键决策：
- **模式集是封闭枚举**，运行时校验（非法字符串一律回退 `default`）
- **规则是字符串对**（`toolName + ruleContent?`），而非结构化对象——解析→序列化 roundtrip 是去重/删除等价性的基础
- **决策携带 `decisionReason` 判别联合**——每步决策可溯源（规则/模式/分类器/safetyCheck/hook），这是审计与回退决策的依据
- **`PermissionUpdate` 是唯一的变更载体**——内存应用与磁盘持久化共用同一结构，落点（destination）即生命周期

### 关键代码

```ts
// ── 模式 ──
// 外部模式（用户可寻址）；auto 仅内部构建 [ant-only]
export const EXTERNAL_PERMISSION_MODES = [
  'acceptEdits', 'bypassPermissions', 'default', 'dontAsk', 'plan',
] as const
// 运行时校验集：INTERNAL = EXTERNAL + (TRANSCRIPT_CLASSIFIER ? ['auto'] : [])
// 非法模式从字符串解析时一律回退 'default'
export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode) : 'default'
}

// ── 规则 ──
export type PermissionRuleValue = { toolName: string; ruleContent?: string }
// 字符串形态："Bash" | "Bash(npm install)" | "Bash(prefix:*)"

export type PermissionRule = {
  source: 'userSettings' | 'projectSettings' | 'localSettings'
        | 'flagSettings' | 'policySettings' | 'cliArg' | 'command' | 'session'
  ruleBehavior: PermissionBehavior        // 同一工具可同时有 allow/deny/ask 规则
  ruleValue: PermissionRuleValue
}

// ── 决策 ──
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown; decisionReason?: PermissionDecisionReason }
  | { behavior: 'ask'; message: string; suggestions?: PermissionUpdate[]
      decisionReason?: PermissionDecisionReason }
  | { behavior: 'deny'; message: string; decisionReason: PermissionDecisionReason }
// 工具自检还可返回 passthrough（无意见）—— 外层管道将其转 ask

// ── 决策原因（判别联合，审计与回退的依据）──
export type PermissionDecisionReason =
  | { type: 'rule'; rule: PermissionRule }                    // 规则命中
  | { type: 'mode'; mode: PermissionMode }                    // 模式放行/拒绝
  | { type: 'hook'; hookName: string; reason?: string }       // PermissionRequest hook
  | { type: 'classifier'; classifier: string; reason: string }// 分类器裁决
  | { type: 'safetyCheck'; reason: string
      classifierApprovable: boolean }                         // 敏感路径
  | { type: 'asyncAgent'; reason: string }                    // headless 拒绝
  | { type: 'other'; reason: string }

// ── 变更载体（内存应用与磁盘持久化共用）──
export type PermissionUpdate =
  | { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination }
  | { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination }
  | { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination }
  | { type: 'setMode'; mode: PermissionMode; destination }
  | { type: 'addDirectories'; directories: string[]; destination }
  | { type: 'removeDirectories'; directories: string[]; destination }

// ── 权限上下文（每次检查读取的不可变快照）──
export type ToolPermissionContext = {
  readonly mode: PermissionMode
  readonly additionalWorkingDirectories: ReadonlyMap<string, AdditionalWorkingDirectory>
  readonly alwaysAllowRules: ToolPermissionRulesBySource   // { [source]: string[] }
  readonly alwaysDenyRules: ToolPermissionRulesBySource
  readonly alwaysAskRules: ToolPermissionRulesBySource
  readonly isBypassPermissionsModeAvailable: boolean
  readonly strippedDangerousRules?: ToolPermissionRulesBySource  // auto 剥离暂存
  readonly shouldAvoidPermissionPrompts?: boolean          // headless/子代理标志
  readonly awaitAutomatedChecksBeforeDialog?: boolean      // 后台先自动检查再弹窗
  readonly prePlanMode?: PermissionMode                    // plan 退出后恢复用
}
```

**关键语义**：
- `safetyCheck.classifierApprovable`：`true`（敏感路径配置类，如 `.claude/settings.json`）→ auto 下可交分类器判断；`false`（路径绕过攻击类：UNC、NTFS ADS、8.3 短名、DOS 设备名）→ 免疫一切自动放行路径
- `shouldAvoidPermissionPrompts` 是子代理/后台的权威标志——它有值时 ask 走 hooks → 自动 deny
- 上下文是**不可变快照**：所有变更经 `PermissionUpdate` 生成新对象，禁止原地修改（并发与缓存安全的根基）

---

## 2. 规则引擎

### 设计要点

- 规则以字符串存储（`"ToolName"` 或 `"ToolName(content)"`），**解析→序列化 roundtrip 是等价性判定的唯一标准**（去重、删除、legacy 名称都依赖它）
- 匹配分三种形态：exact（`npm install`）、prefix（legacy `npm:*`）、wildcard（`git *`）
- **通配符必须支持转义**：`\*` 字面星号、`\\` 字面反斜杠——否则用户无法表达含 `*` 的命令
- **遮蔽检测**：工具级 deny/ask 规则会使内容级 allow 规则不可达（"假授权"）——必须告警
- 目录规则（`Read(//path/**)`）与 MCP 服务器级规则（`mcp__server1`）是两类特殊的通配

### 关键代码

```ts
// ── 规则判别（可整体照抄）──
export type ShellPermissionRule =
  | { type: 'exact';    command: string }
  | { type: 'prefix';   prefix: string }     // legacy "npm:*"
  | { type: 'wildcard'; pattern: string }    // "git *"

export function parsePermissionRule(rule: string): ShellPermissionRule {
  const prefix = permissionRuleExtractPrefix(rule)   // /^(.+):\*$/ → "npm"
  if (prefix !== null) return { type: 'prefix', prefix }
  if (hasWildcards(rule)) return { type: 'wildcard', pattern: rule }
  return { type: 'exact', command: rule }
}
// hasWildcards：以 :* 结尾视为 legacy；否则扫描未转义 *（前导反斜杠为偶数个）

// ── 通配匹配（核心实现）──
export function matchWildcardPattern(pattern: string, command: string,
                                     caseInsensitive = false): boolean {
  const trimmedPattern = pattern.trim()
  // 1. 转义处理：\* → 占位符（防被当成通配符），\\ → 反斜杠占位符
  // 2. 正则特殊字符转义（保留 *）
  // 3. 未转义 * → .*
  // 4. 占位符还原为字面量
  // 5. ★ 关键语义：模式以 ' *' 结尾且是唯一通配符时，尾部参数可选
  //      → 'git *' 同时匹配 'git' 和 'git add'（对齐 legacy git:* 语义）
  //      多通配模式（'* run *'）不做此处理 —— 否则 'npm run'（无尾参）被误匹配
  const unescapedStarCount = (processed.match(/\*/g) || []).length
  if (regexPattern.endsWith(' .*') && unescapedStarCount === 1) {
    regexPattern = regexPattern.slice(0, -3) + '( .*)?'
  }
  // 6. 's' 标志：. 匹配换行 → 通配符能匹配含内嵌换行的命令（heredoc 内容）
  return new RegExp(`^${regexPattern}$`, 's' + (caseInsensitive ? 'i' : '')).test(command)
}

// ── 工具级匹配（无 ruleContent 才匹配整个工具；MCP 支持服务器级）──
function toolMatchesRule(tool, rule): boolean {
  if (rule.ruleValue.ruleContent !== undefined) return false
  if (rule.ruleValue.toolName === tool.name) return true
  // mcp__server1 匹配 mcp__server1__tool1；mcp__server1__* 通配任意工具
  const ruleInfo = mcpInfoFromString(rule.ruleValue.toolName)
  const toolInfo = mcpInfoFromString(tool.name)
  return ruleInfo && toolInfo
    && (ruleInfo.toolName === undefined || ruleInfo.toolName === '*')
    && ruleInfo.serverName === toolInfo.serverName
}

// ── 内容级规则按内容索引（Bash(prefix:*) 查表用）──
export function getRuleByContentsForToolName(ctx, toolName, behavior): Map<string, PermissionRule> {
  const map = new Map()
  for (const rule of rulesForBehavior(ctx, behavior)) {
    if (rule.ruleValue.toolName === toolName && rule.ruleValue.ruleContent !== undefined) {
      map.set(rule.ruleValue.ruleContent, rule)
    }
  }
  return map
}

// ── 转义（顺序至关重要：先反斜杠后括号）──
export function escapeRuleContent(content: string): string {
  return content.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}
export function unescapeRuleContent(content: string): string {
  return content.replace(/\\\(/g, '(').replace(/\\\)/g, ')').replace(/\\\\/g, '\\')
}

// ── legacy 名称规范化（工具改名后规则/删除/持久化名称统一解析）──
const LEGACY_TOOL_NAME_ALIASES = {
  Task: 'AgentTool', KillShell: 'TaskStop',
  AgentOutputTool: 'TaskOutputTool', BashOutputTool: 'TaskOutputTool',
}
export function normalizeLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name
}

// ── 目录规则建议（绝对路径前补 / 成 //path/** 形态）──
export function createReadRuleSuggestion(dirPath: string, destination = 'session') {
  const pathForPattern = toPosixPath(dirPath)
  if (pathForPattern === '/') return undefined          // 根目录太宽，拒绝
  const ruleContent = posix.isAbsolute(pathForPattern)
    ? `/${pathForPattern}/**` : `${pathForPattern}/**`
  return { type: 'addRules', rules: [{ toolName: 'Read', ruleContent }],
           behavior: 'allow', destination }
}
```

**遮蔽检测**（假授权告警）：

```ts
// deny 遮蔽：工具级 deny（"Bash"）→ 内容级 allow（"Bash(ls:*)"）不可达 → 告警
// ask 遮蔽：工具级 ask → 内容级 allow 不可达（用户永远先被弹窗）
// ★ 例外：Bash 沙箱 auto-allow 开启时，个人源（user/local）的 ask 不遮蔽 allow
//   （沙箱命令本就自动放行）；共享源（project/policy/command）始终告警
//   —— 团队成员可能没开沙箱
export function isSharedSettingSource(source): boolean {
  return source === 'projectSettings' || source === 'policySettings' || source === 'command'
}
// 遮蔽告警输出：UnreachableRule { rule, reason, shadowedBy, shadowType, fix }
```

### 陷阱

1. **转义顺序错误**：先处理括号再处理反斜杠会破坏 `echo "test\n"` 类内容。必须"先反斜杠、后括号"（escape）/"先括号、后反斜杠"（unescape）。
2. **误把 `:*` 当通配符**：`npm:*` 是 legacy 前缀语法，不是通配符。判别顺序：prefix 先于 wildcard。
3. **`git *` 与 `* run *` 语义差异**：尾部可选规则只适用于单通配符模式——多通配符模式做同样处理会误匹配无尾参命令。
4. **删除/去重必须 roundtrip**：直接字符串比较会把 `KillShell` 与 `TaskStop` 当两条规则，留下幽灵规则。

### 验收

| 编号 | 断言 |
|---|---|
| A1 | `parsePermissionRule('npm:*')` → prefix；`'git *'` → wildcard；`'npm install'` → exact |
| A2 | `matchWildcardPattern('git *', 'git')` 与 `('git *', 'git add')` 均为 true；`('git *', 'gits')` 为 false |
| A3 | `matchWildcardPattern('\\*foo', '*foo')` 为 true（`\*` 是字面星号，不展开通配） |
| A4 | `matchWildcardPattern('* run *', 'npm run')` 为 false（多通配不做尾部可选） |
| A5 | 含换行的 heredoc 命令被 `cat <<'EOF' *` 类规则匹配（dotAll） |
| A6 | `mcp__server1` 匹配 `mcp__server1__tool1`，不匹配 `mcp__server2__tool1` |
| A7 | 工具级 deny `Bash` + 内容级 allow `Bash(ls:*)` → 遮蔽检测告警（含修复建议）；共享源 + ask 规则始终告警 |
| A8 | `escapeRuleContent('f(x)')` → `'f\\(x\\)'`，roundtrip 还原；`KillShell` 与 `TaskStop` 删除时等价 |

---

## 3. 权限检查管道（9 步）

### 设计要点

- **绕过免疫带**：1a-1g 全部在模式转换之前——deny 规则、内容级 ask 规则、safetyCheck 在 bypass 与 auto 下依然生效
- **工具自检是子管道**：1c 调用 `tool.checkPermissions()`，Bash 在此做 tree-sitter AST 解析与子命令级规则匹配
- **默认 ask**：无规则命中 = passthrough → ask。系统默认是询问，不是放行
- **Bash 管道内部顺序铁律**：deny/ask 规则先于路径约束（防绝对路径绕过，HackerOne 修复）；路径约束使用 AST 派生的 argv（消灭 shell-quote 二次解析的静默跳过 bug）
- **沙箱机制说明**：1b 步引用的 `sandboxOn` / `autoAllowIfSandboxed` / `shouldUseSandbox` 属于 BashTool 内部实现（Bash 命令可被沙箱执行时跳过整工具 ask 规则，落回子命令级检查），不在本规格范围内——此处引用仅为完整表达 1b 步的例外条件，实现时按自身沙箱能力取舍

### 关键代码

```ts
async function hasPermissionsToUseToolInner(tool, input, context) {
  // 1a. 整工具 deny
  const denyRule = getDenyRuleForTool(ctx, tool)
  if (denyRule) return { behavior: 'deny', message: `Permission to use ${tool.name} has been denied.` }

  // 1b. 整工具 ask —— Bash 例外：沙箱开启且 autoAllowIfSandboxed 且应沙箱 → 落回工具自检
  const askRule = getAskRuleForTool(ctx, tool)
  if (askRule && !(tool.name === 'Bash' && sandboxOn && autoAllowIfSandboxed && shouldUseSandbox(input))) {
    return { behavior: 'ask', message: createPermissionRequestMessage(tool.name) }
  }

  // 1c. 工具自检（子管道，见 Bash 段）
  const toolPermissionResult = await tool.checkPermissions(parsedInput, context)

  // 1d. 工具自检 deny
  if (toolPermissionResult?.behavior === 'deny') return toolPermissionResult
  // 1e. 强制交互（bypass 免疫）
  if (tool.requiresUserInteraction?.() && toolPermissionResult?.behavior === 'ask') return toolPermissionResult
  // 1f. 内容级 ask 规则（用户显式配置的 Bash(npm publish:*)）→ bypass 免疫
  if (toolPermissionResult?.behavior === 'ask'
      && toolPermissionResult.decisionReason?.type === 'rule'
      && toolPermissionResult.decisionReason.rule.ruleBehavior === 'ask') return toolPermissionResult
  // 1g. safetyCheck（.git/、.claude/、shell 配置）→ 免疫一切模式
  if (toolPermissionResult?.behavior === 'ask'
      && toolPermissionResult.decisionReason?.type === 'safetyCheck') return toolPermissionResult

  // 2a. bypass（plan 继承 bypass 时同样放行）
  if (mode === 'bypassPermissions' || (mode === 'plan' && isBypassPermissionsModeAvailable)) {
    return { behavior: 'allow', updatedInput: toolPermissionResult.updatedInput ?? input }
  }
  // 2b. 整工具 allow
  const alwaysAllowedRule = toolAlwaysAllowedRule(ctx, tool)
  if (alwaysAllowedRule) return { behavior: 'allow', updatedInput: toolPermissionResult.updatedInput ?? input }

  // 3. passthrough → ask
  return { ...toolPermissionResult, behavior: 'ask' }
}
```

**Bash 工具子管道**（AST 级命令解析——"Command Structural Policy Hook"的真实位置）：

```ts
// 解析入口（tree-sitter-bash）→ 三种结果：
//   simple：引号解析干净、无隐藏替换 → 子命令可直接信任
//   too-complex：命令替换/展开/控制流/解析器差异 → 无法静态分析，走保守路径
//   parse-unavailable：WASM 不可用 → 回退 legacy 检查
export async function parseForSecurity(cmd: string): Promise<ParseForSecurityResult> {
  if (cmd === '') return { kind: 'simple', commands: [] }
  const root = await parseCommandRaw(cmd)
  return root === null ? { kind: 'parse-unavailable' }
                       : parseForSecurityFromAst(cmd, root)
}
// 前置差分预检（tree-sitter 与 bash 的分歧点，先于解析执行）：
//   控制字符 / Unicode 空白 / 反斜杠转义空白 / zsh 波浪号方括号 → too-complex

// too-complex 的保守处理（安全决策的核心）：
if (astResult.kind === 'too-complex') {
  // respect 精确 deny/ask/allow → prefix/wildcard deny；
  // 只有无 deny 命中才 fall through 到 ask —— 绝不把 deny 降级为 ask
  const earlyExit = checkEarlyExitDeny(input, ctx)
  if (earlyExit !== null) return earlyExit
  // 否则返回 ask（reason 附 AST 拒因）
}

// 工具内检查顺序（bashToolCheckPermission）：
//   1. 精确匹配规则 → 2. prefix/wildcard deny/ask → 3. 路径约束
//   → 4-5. allow → 5b. sed 约束 → 6. 模式处理 → 7. 只读命令放行 → 8. passthrough + 规则建议
// 顺序铁律：deny/ask 先于路径约束（HackerOne：绝对路径绕过）
// 路径约束接收 astCommand 派生的 argv —— 消除 shell-quote 二次解析
// （其单引号反斜杠 bug 曾致 parseCommandArguments 返回 [] 静默跳过路径校验）
```

**safetyCheck 分流**（auto 下"谁还能拦下分类器"的答案）：

```ts
export function checkPathSafetyForAutoEdit(path): { safe: true } | { safe: false; classifierApprovable: boolean } {
  // 1. 可疑 Windows 路径模式（UNC/NTFS ADS/8.3 短名/长路径前缀/尾点空格/DOS 设备名）
  //    → classifierApprovable: false   ← 免疫分类器，必须真人（攻击行为，模型不可代判）
  // 2. Claude 配置文件（.claude/settings.json 等）→ classifierApprovable: true（配置决策，可交分类器）
  // 3. 危险文件（.gitconfig/.bashrc/.zshrc 等）与目录（.git/、.vscode/、.idea/、.claude/）
  //    → classifierApprovable: true（模型可看上下文判断）
}
```

### 陷阱

1. **把"危险命令静态清单"做成硬 deny**：真实系统没有这种清单——命令危险与否由 AST 语义检查（工具层）+ 分类器（auto 层）+ 用户规则共同裁决。静态清单会误伤合法用途且无法维护。
2. **模式闸门化**：plan 不"禁写"。plan 靠提示层约束模型 + 工具层工作目录检查；把"plan 禁写"做成闸门会同时产生漏写与误禁。
3. **路径约束在规则之前**：这是 HackerOne 报告的回归——绝对路径可绕过内容级 deny。
4. **对 AST too-complex 静默放行**：无法静态分析的命令必须保守（有 deny 则 deny，无 deny 才 ask），否则 heredoc/命令替换可绕过全部子命令规则。

### 验收

| 编号 | 断言 |
|---|---|
| A9 | deny 规则命中时，即使命令在 CWD 内也 deny（规则 > 路径） |
| A10 | `cd /tmp && rm -rf x` 复合命令 → 子命令级 deny 命中（AST 拆分） |
| A11 | AST too-complex（`$(...)`、反斜杠空白）：有 deny 则 deny、无 deny 才 ask，绝不降级 |
| A12 | bypass 下写 `.git/config` → 仍 ask（1g 免疫 bypass） |
| A13 | bypass 下执行 `Bash(npm publish:*)` 命中 → 仍 ask（1f 免疫 bypass） |
| A14 | `requiresUserInteraction` 工具在 bypass 下仍 ask（1e） |
| A15 | 无任何规则命中 → passthrough → ask（默认询问） |
| A16 | 只读命令（`ls`、`git status`）无规则时在工具层直接 allow（第 7 步） |

---

## 4. 模式状态机与持久化

### 设计要点

- **循环切换**：Shift+Tab 走 `getNextPermissionMode`（算下一个）→ `transitionPermissionMode`（执行副作用）两步分离
- **切换副作用集中**：所有激活路径（键盘、SDK 消息、CLI）共用一个 `transitionPermissionMode`——防止某条路径绕过危险规则剥离
- **进入/退出 auto 是成对操作**：进 = 门控检查 + 激活 + 剥离危险规则；出 = 失活 + 退出通知标记 + 原样恢复
- **持久化 = 落点选择**：session 仅内存；settings 写盘 `defaultMode`

### 关键代码

```ts
// ── 循环（[ant-only] 内部循环含 auto；外部不含）──
export function getNextPermissionMode(ctx): PermissionMode {
  switch (ctx.mode) {
    case 'default': return 'acceptEdits'                    // 外部路径
    case 'acceptEdits': return 'plan'
    case 'plan':
      if (ctx.isBypassPermissionsModeAvailable) return 'bypassPermissions'
      return 'default'
    case 'bypassPermissions': return 'default'
    case 'dontAsk': return 'default'                        // 不在 UI 循环中
    default: return 'default'                               // auto 及未来模式回 default
  }
}
// [ant-only] 内部路径：default → bypassPermissions → auto → default
//   （跳过 acceptEdits/plan；auto 受双重门控 isAutoModeAvailable + isAutoModeGateEnabled）

// ── 切换副作用中枢（可整体照抄）──
export function transitionPermissionMode(from, to, context) {
  if (from === to) return context                           // 幂等：重复 set 无副作用
  handlePlanModeTransition(from, to)                        // plan 进/出 attachment 标记
  handleAutoModeTransition(from, to)                        // auto 进/出 attachment 标记

  // 分类器使用判定：isAutoModeActive() 是权威信号（prePlanMode/stash 不可靠——
  // auto 可在 plan 中段被关闭而这两个字段仍残留）
  const fromUsesClassifier = from === 'auto'
      || (from === 'plan' && isAutoModeActive())
  const toUsesClassifier = to === 'auto'                    // plan 进入由 prepareContextForPlanMode 处理

  if (toUsesClassifier && !fromUsesClassifier) {
    if (!isAutoModeGateEnabled()) throw new Error('Cannot transition to auto: gate disabled')
    setAutoModeActive(true)
    context = stripDangerousPermissionsForAutoMode(context) // 剥离宽泛 allow 规则
  } else if (fromUsesClassifier && !toUsesClassifier) {
    setAutoModeActive(false)
    setNeedsAutoModeExitAttachment(true)                    // 通知模型"auto 已关闭"
    context = restoreDangerousPermissions(context)          // 原样恢复
  }
  if (from === 'plan' && to !== 'plan' && context.prePlanMode) {
    return { ...context, prePlanMode: undefined }           // 清 plan 遗留
  }
  return context
}

// 危险规则恢复（与剥离成对）：
export function restoreDangerousPermissions(context) {
  const stash = context.strippedDangerousRules
  if (!stash) return context
  let result = context
  for (const [source, ruleStrings] of Object.entries(stash)) {
    if (!ruleStrings || ruleStrings.length === 0) continue
    result = applyPermissionUpdate(result, {
      type: 'addRules',
      rules: ruleStrings.map(permissionRuleValueFromString),
      behavior: 'allow', destination: source as PermissionUpdateDestination,
    })
  }
  return { ...result, strippedDangerousRules: undefined }   // 恢复后清空 stash
}

// ── 启动解析（优先级 + 门控）──
// 优先级：CLI --dangerously-skip-permissions > --permission-mode > settings.defaultMode
// 门控：
//   bypass：Statsig 门控（tengu_disable_bypass_permissions_mode）或
//           settings.permissions.disableBypassPermissionsMode === 'disable' → 跳过
//   远程环境（CCR）：settings 只接受 acceptEdits/plan/default —— 防静默授予全权限
//   auto：[ant-only] circuit breaker（GrowthBook enabled==='disabled' → 回退 default）
// 全部被禁用 → 'default'

// ── 防抖 attachment（快速切换不产生重复通知）──
function handleAutoModeTransition(from, to) {
  if ((from==='auto'&&to==='plan') || (from==='plan'&&to==='auto')) return  // plan 机制接管
  if (to==='auto' && from!=='auto') needsAutoModeExitAttachment = false
  if (from==='auto' && to!=='auto') needsAutoModeExitAttachment = true
}

// ── 会话恢复清洗（磁盘数据可能来自旧构建）──
// 反序列化时：permissionMode 不在当前合法模式集 → 置 undefined
const validModes = new Set<string>(PERMISSION_MODES)
for (const msg of migratedMessages) {
  if (msg.type === 'user' && msg.permissionMode !== undefined
      && !validModes.has(msg.permissionMode)) msg.permissionMode = undefined
}

// ── plan+auto 组合（prepareContextForPlanMode）──
// 进入 plan：当前模式存档为 prePlanMode（ExitPlanMode 恢复用）
//   auto 激活且用户 opt-in → auto 保持激活（分类器在 plan 下继续裁决）
//   auto 激活且未 opt-in → auto 退出（退出附件 + 恢复规则）
//   非 auto 且 opt-in → 激活 auto（分类器在 plan 下运行）
```

### 陷阱

1. **副作用不集中**：任何绕过 `transitionPermissionMode` 的模式切换都会漏掉剥离/恢复——安全漏洞。
2. **用 `prePlanMode`/stash 判断分类器激活**：它们在中途关闭 auto 时残留，必须用 `isAutoModeActive()`。
3. **恢复会话不清洗模式**：旧构建的 `permissionMode` 会让会话恢复到不存在的模式。
4. **快速切换的重复附件**：无防抖会产生重复的 `auto_mode_exit` 通知污染上下文。

### 验收

| 编号 | 断言 |
|---|---|
| A17 | `set('auto')` 门控未开 → 抛错；开启 → 剥离 `Bash(*)` 且 `strippedDangerousRules` 有值 |
| A18 | 从 auto 切出 → 规则逐源恢复、stash 清空；`Bash(*)` 恢复生效 |
| A19 | 同模式重复 set → 无副作用（幂等） |
| A20 | `setMode` 落点 session → 不写盘；落点 userSettings → `defaultMode` 更新 |
| A21 | 恢复会话时 `permissionMode: 'unknown-mode'` → 清洗为 undefined |
| A22 | 启动优先级：CLI > settings；被禁用模式跳过；全禁回 default |
| A23 | 模式循环顺序与定义一致；auto 在门控关闭时从循环中跳过 |

---

## 5. auto 分类器管道

### 设计要点

auto 只做一件事：**把管道第 3 步产生的 ask 交给 AI 分类器裁决**，替代用户弹窗。管道包含：

1. **前置过滤**（免疫一切自动放行路径）：非 `classifierApprovable` 的 safetyCheck、`requiresUserInteraction` 工具、PowerShell [ant-only 限制]
2. **fast-path 1 — acceptEdits 模拟**：临时把模式换成 acceptEdits 重跑工具自检，放行则 allow（CWD 内写操作免分类器 API 调用）；跳过 Agent/REPL（内部调用需分类器把关）
3. **fast-path 2 — 安全工具白名单**：只读/任务/计划类工具免分类器
4. **主路径 — 两阶段 LLM 分类器**：读完整主 transcript 判断（"用户是否明确要求"的上下文来源）
5. **故障语义**：分类器不可用 → fail-closed deny（铁门）或 fail-open 回退 ask；transcript 超长 → 确定性回退
6. **denial 计数**：3 连续/20 总计 → 回退弹窗（headless 直接 abort）

### 关键代码

```ts
// 外层管道对 ask 的处置（顺序即成本递增）：
if (result.behavior === 'ask') {
  if (mode === 'dontAsk') {
    return deny(DONT_ASK_REJECT_MESSAGE)                  // dontAsk：ask → deny
  }
  if (mode === 'auto' || (mode === 'plan' && isAutoModeActive())) {
    // ── 前置过滤（免疫一切自动放行路径）──
    if (reason.type === 'safetyCheck' && !reason.classifierApprovable) {
      return headless ? deny : ask                        // 路径绕过攻击类必须真人
    }
    if (tool.requiresUserInteraction?.() && result.behavior === 'ask') return result

    // ── fast-path 1：acceptEdits 模拟（跳过 Agent/REPL）──
    if (tool.name !== 'Agent' && tool.name !== 'REPL') {
      const acceptEditsResult = await tool.checkPermissions(input, { ...ctx, mode: 'acceptEdits' })
      if (acceptEditsResult.behavior === 'allow') return allow
    }
    // ── fast-path 2：安全工具白名单 ──
    if (isAutoModeAllowlistedTool(tool.name)) return allow

    // ── 主路径：分类器（读完整主 transcript）──
    const classifierResult = await classifyYolo(context.messages, action, tools, ctx)
    if (classifierResult.unavailable) {
      return ironGateClosed
        ? denyWithRetryGuidance(tool.name)                // fail-closed（默认）
        : result                                          // fail-open：回退普通 ask
    }
    if (classifierResult.transcriptTooLong) return fallbackToAsk()   // 确定性错误不重试
    if (classifierResult.shouldBlock) {
      const newState = recordDenial(denialState)
      if (shouldFallbackToPrompting(newState)) return fallbackToPrompt(result)  // 超限回退
      return deny(buildRejectionMessage(classifierResult.reason))
    }
    recordSuccess(denialState)
    return allow
  }
  if (headless) {
    // PermissionRequest hooks → 无决定 → 自动 deny（见 §6）
  }
}
```

**白名单**（不含任何写/执行工具——它们走 fast-path 1 或分类器）：

```ts
const SAFE_TOOL_ALLOWLIST = new Set([
  // 只读文件与搜索
  'Read', 'Grep', 'Glob', 'LSP', 'ToolSearch', 'ListMcpResources',
  // 任务元数据
  'TodoWrite', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskStop', 'TaskOutput',
  // 计划与 UI
  'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  // 杂项安全
  'Sleep',
])
```

**拒绝计数**（完整小模块，可直接照抄）：

```ts
export const DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 } as const
export function createDenialTrackingState() { return { consecutiveDenials: 0, totalDenials: 0 } }
export function recordDenial(s) {
  return { ...s, consecutiveDenials: s.consecutiveDenials + 1, totalDenials: s.totalDenials + 1 }
}
export function recordSuccess(s) {
  return s.consecutiveDenials === 0 ? s : { ...s, consecutiveDenials: 0 }
}
export function shouldFallbackToPrompting(s) {
  return s.consecutiveDenials >= 3 || s.totalDenials >= 20
}
// 任意 allow（含 fast-path）都 recordSuccess —— 成功打断拒绝连击
// 超限：交互 → 回退弹窗（附带分类器原因）；headless → AbortError 终止整个循环
// 计数存会话内存，不入盘；子代理用独立计数（§6）
```

**危险规则剥离**（进入 auto 时执行，退出恢复——防"宽泛 allow 规则绕过分类器"）：

```ts
// 允许规则一旦命中这些解释器前缀 = 绕过分类器执行任意代码
const DANGEROUS_PREFIXES = ['python','python3','node','deno','ruby','perl','php','lua',
  'npx','npm run','yarn run','bun run','bash','sh','zsh','ssh','sudo','eval','exec','xargs','env']

function isDangerousBashPermission(toolName, ruleContent): boolean {
  if (toolName !== 'Bash') return false
  if (ruleContent === undefined) return true              // 裸 Bash → 任意命令
  return DANGEROUS_PREFIXES.some(p => /* prefix/wildcard 形态匹配 */)
}
// PowerShell 额外：[ant-only 默认关闭] pwsh/cmd/wsl/iex/invoke-expression/start-process/add-type
// Agent 工具的任何 allow 规则都危险（子代理启动须过分类器）
// 剥离规则存入 context.strippedDangerousRules，退出 auto 经 restoreDangerousPermissions 原样恢复
```

**分类器配置**（三段式规则，`[ant-only]` 的 `deny` 段并入 soft_deny）：

```jsonc
// settings.json（可信源：user/local/flag/policy —— 排除 project，§10）
{
  "autoMode": {
    "allow": ["npm install", "git status"],       // 分类器应自动放行
    "soft_deny": ["git push --force"],            // 分类器应阻止（要求确认）
    "environment": ["用户主要做前端开发", "使用 pnpm"]  // 帮助分类器判断的上下文
  }
}
// 段语义：非空用户段整段 REPLACE 默认段；空段回退默认
// 分类器 system prompt = 基础安全模板 + 用户规则 + 完整主 transcript
// 输出 { shouldBlock: boolean, reason: string }（两阶段：fast 判定 + thinking 复核）[ant-only 两阶段]
//
// ★ soft_deny → shouldBlock 语义桥接：
//   soft_deny 规则注入分类器 system prompt 的"应阻止"段，影响分类器输出。
//   分类器 shouldBlock=true 时，执行 deny + recordDenial（而非回退 ask）——
//   拒绝路径的计数与回退语义见上文"拒绝计数"段。
```

### 陷阱

1. **前置过滤顺序错误**：非 classifierApprovable safetyCheck 必须在 fast-path 之前——否则 acceptEdits 模拟会放行敏感路径写入。
2. **白名单包含写工具**：白名单是"无需分类器判断就安全"的声明——含 Write/Edit/Bash 即漏洞。
3. **分类器失败静默放行**：fail-open 是特例（feature gate 控制）；默认必须 fail-closed deny。
4. **denial 计数与持久化位置**：计数在会话内存；headless 子代理必须用本地计数（§6）——否则计数器永远为 0。
5. **危险规则只剥不恢复**：退出 auto 不恢复 → 用户授权被永久破坏；恢复实现错误（stash 不清）→ 二次进入 auto 剥离出错。

### 验收

| 编号 | 断言 |
|---|---|
| A24 | auto 下白名单工具直接 allow，分类器零调用 |
| A25 | auto 下 CWD 内 Write → allow，分类器零调用（fast-path 1） |
| A26 | auto 下 CWD 外 Write → 分类器被调用，仅 `shouldBlock=false` 时 allow |
| A27 | 非 classifierApprovable safetyCheck → 保持 ask，分类器不被调用 |
| A28 | 分类器 API 故障 → deny（fail-closed），消息含重试指引 |
| A29 | `transcriptTooLong` → 回退 ask（确定性错误不重试） |
| A30 | 连续 3 次拒绝 → 交互回退弹窗；headless 抛 `AbortError` |
| A31 | 任意 allow 重置 consecutiveDenials |
| A32 | 进 auto 后 `Bash(*)`、`Bash(python:*)` 不生效；退出后恢复 |
| A33 | 分类器规则段：非空整段 REPLACE 默认；空段回退默认 |

---

## 6. 子代理权限

### 设计要点

- **继承与隔离是成对的**：规则与模式全继承（同一份 `toolPermissionContext`），UI 与状态写入强制隔离
- **优先级链**：父 bypass > acceptEdits > auto > agent 声明的 `permissionMode`
- **headless 的 ask 只有两条出路**：PermissionRequest hooks 显式决定，或自动 deny——**永不静默 allow**
- **授权收窄**：`allowedTools` 提供时**替换**父的 session 规则（防泄漏），仅保留 cliArg（SDK 显式授权）
- **auto 下子代理同走分类器**（分类器分支在 headless 检查之前）——这是子代理唯一的"自动批准"路径

### 关键代码

```ts
// AgentTool 子代理 —— 权限上下文的三个变换（可整体照抄）：
const agentGetAppState = () => {
  let ctx = state.toolPermissionContext                  // ← 父的全部规则/模式原样继承

  // 变换 1：agent 声明的 permissionMode 可覆盖 —— 父在 bypass/acceptEdits/auto 时永远优先
  if (agentPermissionMode
      && parentMode !== 'bypassPermissions'
      && parentMode !== 'acceptEdits'
      && parentMode !== 'auto') {
    ctx = { ...ctx, mode: agentPermissionMode }
  }

  // 变换 2：UI 隔离（canShowPermissionPrompts 显式 > bubble=false > isAsync）
  //   bubble：[ant-only] 子代理提示冒泡到父终端（shouldAvoidPermissionPrompts: false）
  const shouldAvoidPrompts = canShowPermissionPrompts !== undefined
    ? !canShowPermissionPrompts
    : agentPermissionMode === 'bubble' ? false : isAsync
  if (shouldAvoidPrompts) ctx = { ...ctx, shouldAvoidPermissionPrompts: true }

  // 变换 3：后台可弹窗 agent → 先等自动检查（分类器/hooks）再弹窗
  if (isAsync && !shouldAvoidPrompts) {
    ctx = { ...ctx, awaitAutomatedChecksBeforeDialog: true }
  }

  // 授权收窄：allowedTools 提供时【替换】session 规则，仅保留 cliArg（SDK 授权）
  if (allowedTools !== undefined) {
    ctx = { ...ctx, alwaysAllowRules: {
      cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
      session: [...allowedTools],
    } }
  }
  return { ...state, toolPermissionContext: ctx }
}

// fork 子代理（slash command/skill/背景任务）—— 隔离更彻底：
function createSubagentContext(parentContext, overrides) {
  // getAppState 包装：默认强制 shouldAvoidPermissionPrompts: true
  // （仅 shareAbortController = 交互式子代理时保留弹窗能力）
  const getAppState = overrides?.shareAbortController
    ? parentContext.getAppState
    : () => {
        const s = parentContext.getAppState()
        if (s.toolPermissionContext.shouldAvoidPermissionPrompts) return s
        return { ...s, toolPermissionContext: { ...s.toolPermissionContext,
          shouldAvoidPermissionPrompts: true } }
      }
  return {
    ...parentContext,
    getAppState,
    setAppState: overrides?.shareSetAppState ? parentContext.setAppState : () => {}, // no-op
    localDenialTracking: overrides?.shareSetAppState
      ? parentContext.localDenialTracking
      : createDenialTrackingState(),      // 独立拒绝计数（setAppState no-op，全局计数无法累积）
    addNotification: undefined,           // 不能控制父 UI
    agentId: overrides?.agentId ?? createAgentId(),
  }
}

// slash command/skill 的 allowedTools 注入（command 源，仅该 command 的 fork 可见）：
export function createGetAppStateWithAllowedTools(baseGetAppState, allowedTools) {
  if (allowedTools.length === 0) return baseGetAppState
  return () => {
    const appState = baseGetAppState()
    return { ...appState, toolPermissionContext: { ...appState.toolPermissionContext,
      alwaysAllowRules: { ...appState.toolPermissionContext.alwaysAllowRules,
        command: [...new Set([...(ctx.alwaysAllowRules.command || []), ...allowedTools])] } } }
  }
}
```

**headless 的 ask 处置**（单一路径——可整体照抄）：

```ts
if (appState.toolPermissionContext.shouldAvoidPermissionPrompts) {
  const hookDecision = await runPermissionRequestHooksForHeadlessAgent(...)
  // hooks 可 allow（可改输入）/ deny（可中断）/ 返回 null
  if (hookDecision) return hookDecision
  return { behavior: 'deny', message: AUTO_REJECT_MESSAGE(tool.name) }   // 无决定 → 自动拒绝
}
```

### 陷阱

1. **父 session 规则泄漏**：allowedTools 若不替换而追加，父的本次会话授权会静默扩展到子代理。
2. **子代理 denial 计数共享**：setAppState 是 no-op 时全局计数不更新——必须本地计数，否则超限回退永不触发。
3. **agent 声明的模式覆盖父的 auto**：优先级反了会让子代理在 auto 下被降级为 default（弹窗被静默拒绝）。
4. **"静默 allow"式策略（按 reason code 放行）**：真实系统不存在——ask 的处置只有"验证后批准"（acceptEdits 模拟/分类器）与"拒绝"。原因码只解释"为什么问"，不授权"可以自动批"。

### 验收

| 编号 | 断言 |
|---|---|
| A34 | 父无规则时子代理调 Bash → ask → 无 hook → deny（默认 fail-safe） |
| A35 | 父在 auto → 子代理调用与父同走分类器，相同裁决 |
| A36 | 父在 auto + agent 声明 `permissionMode: 'default'` → auto 生效（父优先） |
| A37 | 子代理 `allowedTools: ['Read']` → 父的 session allow 规则对子代理不生效（替换语义），cliArg 规则仍生效 |
| A38 | 后台子代理 3 次连续分类器拒绝 → 子代理终止（AbortError），主代理不受影响 |
| A39 | fork 子代理 denial 计数独立（父的计数不被污染） |
| A40 | PermissionRequest hook 返回 allow → 子代理放行（hooks 是唯一外部静默通道） |
| A41 | bubble 模式子代理 [ant-only] → 权限提示在父终端可见 |

---

## 7. ask 处置链

### 设计要点

- **没有单一阻塞点**——ask 是"待决状态"，由三级处置链依次消化，每级都能终结它：
  1. **模式抢占**：auto → 分类器管道（§5）；dontAsk → deny；headless → hooks → deny
  2. **上下文处理器**：协调者 worker（`awaitAutomatedChecksBeforeDialog`）先跑自动检查再弹窗；swarm worker 经 mailbox 转 leader [ant-only]
  3. **交互弹窗** + Bash 2 秒投机分类器竞速（高置信度命中 → 弹窗取消）
- **"记住授权" = 落点选择**，无 `remember: true` 布尔
- **弹窗确认是异步后台协同**：显示期间 hooks/分类器并行跑，任一先决出即终结

### 关键代码

```ts
// ask 处置链（useCanUseTool 的核心，可整体照抄）：
switch (result.behavior) {
  case 'allow': resolve(buildAllow(result.updatedInput ?? input)); return
  case 'deny':
    // auto 拒绝时：记录 autoModeDenial（供 /permissions 查看）+ 即时通知
    resolve(result); return
  case 'ask': {
    // ① 协调者 worker：先等自动检查（hooks/分类器），解决不了才弹窗
    if (ctx.awaitAutomatedChecksBeforeDialog) {
      const coordinatorDecision = await handleCoordinatorPermission({...})
      if (coordinatorDecision) { resolve(coordinatorDecision); return }
    }
    // ② swarm worker [ant-only]：分类器 → mailbox 转 leader
    // ③ Bash 投机分类器竞速（2 秒）：
    if (pendingClassifierCheck && tool.name === 'Bash' && !awaitAutomatedChecksBeforeDialog) {
      const speculativePromise = peekSpeculativeClassifierCheck(input.command)
      const raceResult = await Promise.race([
        speculativePromise.then(r => ({ type: 'result', result: r })),
        new Promise(res => setTimeout(res, 2000, { type: 'timeout' })),
      ])
      if (raceResult.type === 'result' && raceResult.result.matches
          && raceResult.result.confidence === 'high') {
        consumeSpeculativeClassifierCheck(input.command)
        resolve(buildAllow(input, { decisionReason: { type: 'classifier',
          classifier: 'bash_allow', reason: `Allowed by prompt rule: ...` } }))
        return                                            // 弹窗不再出现
      }
      // 超时或无匹配 → 落入弹窗
    }
    // ④ 交互弹窗 + hooks/分类器后台并行
    handleInteractivePermission({ ctx, description, result, ... }, resolve)
    return
  }
}
```

**记住授权**（弹窗选项 → 落点映射）：

```ts
type PermissionOption =
  | { type: 'accept-once' }                     // 本次授权，用完即忘
  | { type: 'accept-session',                   // 本次会话记住
      scope?: 'claude-folder' | 'global-claude-folder' }  // .claude 目录专用选项
  | { type: 'reject' }
// 落点即生命周期：
//   accept-session → destination: 'session'（内存，会话结束失效）
//   "始终允许"     → userSettings/projectSettings/localSettings（写盘，永久）
//   CLI --allowedTools → cliArg（进程级内存）
export function supportsPersistence(d): boolean {
  return d === 'localSettings' || d === 'userSettings' || d === 'projectSettings'
}
// 弹窗确认 → applyPermissionUpdates（内存，不可变）+ persistPermissionUpdates（仅可持久化落点）
```

**auto 下仍触发 ask 的完整清单**（分类器无权替用户判断的）：

| 情形 | 结果 | 原因 |
|---|---|---|
| safetyCheck 且 `classifierApprovable === false` | ask（headless → hooks → 无决定 → deny） | 路径绕过是攻击行为，模型不可代判；headless 下 hooks 仍可介入，无决定才 deny（§6） |
| `requiresUserInteraction()` 工具 | ask | 工具语义要求真人 |
| [ant-only] PowerShell（无 `POWERSHELL_AUTO_MODE`） | ask/deny | 防 `iex (iwr ...)` 下载执行 |
| 分类器 unavailable + fail-open | 回退 ask | 默认是 fail-closed deny |
| denial 超限（3/20） | 回退 ask 弹窗（附分类器原因） | 连续误拒说明分类器失效 |
| 分类器 transcript 超长 | 回退 ask | 确定性错误，重试无意义 |

### 陷阱

1. **ask 规则在 auto 下的语义**：1b/1f 的 ask 规则命中后**会流到分类器**（它不是被豁免的三类）——效果是"必须过分类器且放行才 allow"。不要实现成"ask 规则 = auto 下直接 ask"。
2. **投机竞速的安全条件**：只有 `confidence === 'high'` 且 `matches` 才抢在弹窗前放行；低置信度必须落入弹窗。
3. **落点混淆**：session 与 settings 的区分必须靠 `supportsPersistence` 守卫——漏掉守卫会把会话授权写进磁盘（或反之）。

### 验收

| 编号 | 断言 |
|---|---|
| A42 | auto 下普通 Bash 调用 → 分类器裁决，弹窗队列零条目（ask 被抢占） |
| A43 | auto 下分类器 unavailable → 默认 deny（fail-closed），非 ask |
| A44 | auto 下 denial 超限 → 弹窗出现（回退生效），原因含分类器理由 |
| A45 | 交互模式弹窗显示中，Bash 分类器 2 秒内高置信度命中 → 弹窗取消、自动放行 |
| A46 | `accept-session` → 本次会话后续相同调用直接 allow；重启后失效 |
| A47 | "始终允许" → settings 文件 `permissions.allow` 出现规则；重启后生效 |
| A48 | ask 规则命中在 auto 下：分类器放行 → allow；分类器拒绝 → deny |
| A49 | `requiresUserInteraction` 工具在 auto 下仍弹窗；弹窗期间 ESC → 取消并中止关联工具 |

---

## 8. 并发控制

### 设计要点

- **动态声明 + fail-closed 默认**：`isConcurrencySafe(input)` 由工具按输入决定（`ls` 安全、`cd /tmp && npm install` 不安全）；工具未声明 = 不安全
- **单队列实现"读池/写独占"双语义**：`canExecuteTool` 约束 + `break` 保序
- **错误级联仅限 Bash**：Bash 失败杀全部并行兄弟（隐式依赖链）；Read/WebFetch 失败不连累
- **共享状态副作用（contextModifiers）仅限非并发工具**——并发顺序不确定不能安全修改共享上下文
- **auto 不改并发**（完全正交）

### 关键代码

```ts
// Tool 接口 + 默认值（fail-closed）：
isConcurrencySafe(input: z.infer<Input>): boolean          // 必选
const TOOL_DEFAULTS = { isConcurrencySafe: (_input?) => false,  // 默认不安全
                        isReadOnly: (_input?) => false }

// Bash 的动态实现（只读判定即并发判定）：
isConcurrencySafe(input) { return this.isReadOnly?.(input) ?? false }
isReadOnly(input) {
  const compoundCommandHasCd = commandHasAnyCd(input.command)   // cd 改变工作目录
  return checkReadOnlyConstraints(input, compoundCommandHasCd).behavior === 'allow'
}

// 调度器（可整体照抄）：
// addTool：schema 解析失败 → 强制不安全
const isConcurrencySafe = parsedInput?.success
  ? (() => { try { return Boolean(toolDefinition.isConcurrencySafe(parsedInput.data)) }
            catch { return false } })()
  : false

// 可执行判定：执行中为空，或（新工具安全 && 所有执行中工具都安全）
private canExecuteTool(isConcurrencySafe: boolean): boolean {
  const executingTools = this.tools.filter(t => t.status === 'executing')
  return executingTools.length === 0
      || (isConcurrencySafe && executingTools.every(t => t.isConcurrencySafe))
}

// 排队：非安全工具阻断后续（保序）；安全工具可越过等待立即执行
private async processQueue(): Promise<void> {
  for (const tool of this.tools) {
    if (tool.status !== 'queued') continue
    if (this.canExecuteTool(tool.isConcurrencySafe)) await this.executeTool(tool)
    else if (!tool.isConcurrencySafe) break
  }
}

// 输出保序：非安全工具执行中，后续结果不越序输出（progress 消息立即 yield）
for (const tool of this.tools) {
  while (tool.pendingProgress.length > 0) yield { message: tool.pendingProgress.shift()! }
  if (tool.status === 'yielded') continue
  if (tool.status === 'completed' && tool.results) { /* yield 结果 */ }
  else if (tool.status === 'executing' && !tool.isConcurrencySafe) break
}

// 错误级联（仅 Bash）：
if (isErrorResult) {
  thisToolErrored = true
  // 只有 Bash 错误取消兄弟。Bash 命令常有隐式依赖链
  // （mkdir 失败 → 后续命令无意义）。Read/WebFetch 独立——一个失败不该毁掉其余。
  if (tool.block.name === BASH_TOOL_NAME) {
    this.hasErrored = true
    this.siblingAbortController.abort('sibling_error')   // 兄弟工具收到 synthetic error
  }
}

// contextModifiers（共享状态副作用）仅限非并发工具：
if (!tool.isConcurrencySafe && contextModifiers.length > 0) {
  for (const modifier of contextModifiers) this.toolUseContext = modifier(this.toolUseContext)
}
```

### 陷阱

1. **静态集合判定**：`CONCURRENCY_SAFE_TOOLS = new Set(READ_ONLY_TOOLS)` 会误判（`git commit` 被并行）与漏判（新工具忘登记）。判定权下放工具自身 + fail-closed 默认。
2. **并发工具修改共享状态**：顺序不确定——必须禁止（contextModifiers 限制）。
3. **错误级联误伤**：Read 失败杀兄弟会毁掉无依赖的并行工作。

### 验收

| 编号 | 断言 |
|---|---|
| A50 | 只读 `ls` 与 `Read` 同回合 → 并行执行，互不等待 |
| A51 | `Write` 与 `ls` 同回合 → Write 独占；启动时等待执行中清空 |
| A52 | 非安全工具执行中，后续结果（含已完成的）不越序输出 |
| A53 | Read 失败 → 兄弟工具继续（不级联） |
| A54 | Bash 失败 → 全部并行兄弟被 abort（synthetic sibling_error）；仅 Bash 触发级联 |
| A55 | `isConcurrencySafe` 抛异常 / schema 解析失败 → 按不安全处理（fail-closed） |
| A56 | auto 模式与 default 模式 → 相同并发行为 |

---

## 9. 错误恢复与降级

### 设计要点

- **工具层无自动重试**——错误结果回传模型，由模型决定下一步
- **重试只在 API 层**（LLM 调用与分类器调用共享 `withRetry`）：指数退避 + jitter + Retry-After 头
- **分类器享受前台级 529 重试**：它是权限链条上的新故障点，失败 = fail-closed 误拒 / fail-open 误放——"必须完成，auto 模式正确性依赖"
- **无模式降级链**（auto→build→plan 不存在）；降级是"auto → 手动弹窗"（denial 超限）与"模型层 → fallback 模型"（3 次连续 529）
- **错误恢复 ↔ 权限只有三条连线**：分类器 API 错误（fail-closed/open）、denial 计数（回退/abort）、会话恢复（模式清洗）

### 关键代码

```ts
const DEFAULT_MAX_RETRIES = 10; const BASE_DELAY_MS = 500
export function getRetryDelay(attempt, retryAfterHeader?, maxDelayMs = 32000): number {
  if (retryAfterHeader) { /* 服务器指令优先 */ }
  const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), maxDelayMs)
  return baseDelay + Math.random() * 0.25 * baseDelay      // 25% jitter
}

// 可重试判据（shouldRetry）：
//   永不：mock 错误（测试用）
//   x-should-retry 头权威：'true'（订阅用户除外——几小时后重试无意义；
//     Enterprise PAYG 可重试）；'false'（ant 5xx 除外）
//   可重试：连接错误 / 408 / 409 / 429（订阅用户除外）/ 401（清 key 缓存）/
//     403 token revoked / 5xx
//   max_tokens 溢出（400）→ 特殊处理：解析 inputTokens+contextLimit，
//     重算 max_tokens（保底 3000）后重试
//   其余 400 → 不重试（请求本身错了）

// ★ 权限耦合：分类器（querySource 'auto_mode'）享受前台级 529 重试
const FOREGROUND_529_RETRY_SOURCES = new Set([
  'repl_main_thread', 'sdk', 'agent:default', 'compact', 'hook_agent', ...
  // 安全分类器 —— 必须完成，auto 模式正确性依赖它
  'auto_mode',
])
// 后台源（总结/标题/建议）529 立即放弃 —— 容量级联时每次重试都是 3-10×
// 网关放大，且用户看不到这些失败

// 流式 529 → 非流式 fallback：initialConsecutive529Errors 预置计数，
// 保证两种模式合计不超 MAX_529_RETRIES（3）

// 模型降级（3 次连续 529 + 配置了 fallbackModel）：
if (consecutive529Errors >= MAX_529_RETRIES) {
  if (options.fallbackModel) throw new FallbackTriggeredError(originalModel, fallbackModel)
  // 上层捕获后切 fallback 模型重新发起
  // 无 fallback：订阅用户 → CannotRetryError + 友好 529 提示
}
```

**降级形态总表**：

| 触发 | 结果 |
|---|---|
| denial 超限（3 连续/20 总计） | 交互回退弹窗；headless `AbortError` 终止 |
| 分类器 API 错误 | fail-closed deny（默认）／fail-open 回退 ask（feature gate 控制） |
| 主模型 3 次连续 529 | `FallbackTriggeredError` → fallbackModel |
| fast mode 429/529 [ant-only] | 冷却（≥10 分钟）后切标准速度 |
| 流式 529 | 丢弃流式结果、非流式重跑（计数延续） |
| 会话恢复 | `permissionMode` 白名单清洗 |

### 陷阱

1. **给工具调用加自动重试**：工具可能有副作用（写文件一半、发消息）——重试必须由模型基于结果决定。
2. **分类器失败静默放行**（fail-open 当默认）：安全模型支柱被拿掉时必须 fail-closed。
3. **529 重试放大**：后台源与分类器混用同一重试策略会让容量级联恶化。

### 验收

| 编号 | 断言 |
|---|---|
| A57 | 工具执行抛错 → 错误结果回传模型，不自动重试同一工具调用 |
| A58 | LLM 调用 400（非溢出）→ 不重试，直接 `CannotRetryError` |
| A59 | LLM 调用 529 → 指数退避重试；Retry-After 头存在时按其等待 |
| A60 | 分类器（auto_mode）529 → 重试；后台源 529 → 立即放弃 |
| A61 | 流式 529 → 非流式重跑，529 计数延续（不重置为 0） |
| A62 | 主模型 3 次连续 529 + fallbackModel → 切 fallback 模型 |
| A63 | 分类器 API 错误 → deny（fail-closed），消息含重试指引 |
| A64 | 恢复会话时 `permissionMode: 'unknown'` → 清洗为 undefined |

---

## 10. 配置持久化与迁移

### 设计要点

- **五源分层 JSON，后覆盖前**；多项目靠"项目内相对路径"（切换项目即切换配置）
- **文件所有权属于用户**：所有迁移动作是读取时兼容（passthrough/coerce/legacy 映射），从不主动改写磁盘
- **写盘三重保护**：只读源拒绝写、JSON 语法错误不覆盖、校验失败用 raw 合并
- **autoMode 配置的安全红线**：排除 projectSettings——规则直接进分类器 system prompt，恶意项目注入 = RCE

### 关键代码

```ts
// 五源（顺序即覆盖优先级）：
export const SETTING_SOURCES = [
  'userSettings',      // 全局用户
  'projectSettings',   // 项目共享（提交 git）→ 项目内 .claude/settings.json
  'localSettings',     // 项目本地（gitignored）→ 项目内 .claude/settings.local.json
  'flagSettings',      // --settings flag / SDK 内联
  'policySettings',    // 企业托管
] as const
// policySettings first-wins 链：remote > MDM(HKLM/plist) > 托管文件 > HKCU

// permissions 段格式：
// { "allow": ["Bash(npm install)"], "deny": ["Bash(rm -rf:*)"],
//   "ask": ["Bash(npm publish:*)"], "defaultMode": "acceptEdits",
//   "additionalDirectories": ["D:/other-workspace"] }
// defaultMode 枚举校验：外部构建不含 'auto'（含则解析失败回退 default）

// 写盘保护（updateSettingsForSource）：
//   1. 只读源（policy/flag）拒绝写 —— 企业配置不可被本地修改
//   2. 目标文件 JSON 语法错误 → 返回错误，绝不覆盖用户文件
//   3. 校验失败但 JSON 合法 → 用 raw 内容合并（追加规则时 hooks 字段
//      校验失败也不能丢掉已有规则）
//   4. 删除语义：字段设为 undefined = 删除（不用 delete 操作符）
//   5. 写前 resetSettingsCache —— mergeWith 原地修改缓存对象，
//      写失败时未持久化状态不能泄漏到缓存

// 宽松 schema 原则（加载侧）：
//   .passthrough() 未知字段保留 | z.coerce 类型强制（env 数字→字符串）
//   | 无效值"不用但留在文件里"由用户修复 —— 配置系统永不破坏用户文件
```

**autoMode 配置**（可导出分享 + 安全红线）：

```ts
export function getAutoModeConfig() {
  // schema: { allow?: string[], soft_deny?: string[], deny?: string[] [ant-only], environment?: string[] }
  // 跨源合并 = 追加（user + local + flag + policy 全部汇入）
  // ★ 安全红线：projectSettings 被刻意排除 ——
  //   一个恶意项目可注入分类器 allow/deny 规则（RCE 风险）
  for (const source of ['userSettings', 'localSettings', 'flagSettings', 'policySettings']) {
    const result = schema.safeParse(settings.autoMode)
    if (result.success) {
      allow.push(...result.data.allow)
      soft_deny.push(...result.data.soft_deny)
      // [ant-only] deny 段并入 soft_deny
    }
  }
}

// 工具链（导出/分享/评审）：
//   claude auto-mode defaults   → dump 默认分类器规则
//   claude auto-mode config     → dump 合并后的生效配置
//   claude auto-mode critique   → LLM 评审自定义规则
//     （清晰度/完整性/冲突/可执行性，输出改进建议）
```

**迁移三层**：
1. **schema 层**：passthrough 保留未知字段 + coerce 类型强制——新版本读旧文件、旧版本读新文件都不崩（"保留 + 忽略"而非"改写"）
2. **语义层**：legacy 名称映射（§2）+ 删除/去重 roundtrip
3. **测试锁**：`BACKWARD_COMPATIBILITY_CONFIGS` 样本集 + 专门回归测试——失败即"引入了破坏性变更"；新增字段必须补样本

### 陷阱

1. **写盘覆盖语法错误文件**：用户手改坏 JSON 后任何写入都会毁掉整个文件——必须检测并拒绝。
2. **追加规则时丢弃校验失败的字段**：hooks 字段格式错时不能连带丢掉 allow 规则。
3. **autoMode 放行 projectSettings**：直接注入分类器 prompt 的配置来自不可信源 = 权限绕过。
4. **自动迁移改写磁盘**：用户可能同时用多个版本——任何自动改写都会破坏另一版本。

### 验收

| 编号 | 断言 |
|---|---|
| A65 | 同一字段在 user/project/local 均有值时，local 生效（覆盖顺序） |
| A66 | 切换项目目录 → project/local 配置随之切换，user 配置不变 |
| A67 | `update` 目标文件有 JSON 语法错误 → 返回错误，文件内容原样保留 |
| A68 | 设置字段校验失败（如 hooks 格式错）→ 追加权限规则仍成功（raw 合并） |
| A69 | 删除记录字段 = 设 undefined；文件里对应 key 被移除 |
| A70 | `autoMode` 配置在 projectSettings 中存在 → 不生效（被排除） |
| A71 | `autoMode` 在 user/local/flag/policy 均存在 → 规则全部合并（追加语义） |
| A72 | 旧版本文件含未知字段 → 加载成功，未知字段保留在文件中不被触碰 |
| A73 | 新增 schema 字段后运行向后兼容测试 → 旧配置样本全部通过 |

---

## 11. 提示词与安全约束

### 设计要点

- **模式不注入 system prompt**：动态化靠"事件注入"（attachment）替代"状态注入"——持续的模式描述会写进 system prompt 破坏 prompt cache
- **system prompt = 静态基座 + 动态 section 注册表**，中间有缓存边界标记；每个动态 section 声明自己的缓存策略
- **分类器有独立 system prompt**（基础安全模板 + 用户三段式规则 + 完整主 transcript）
- **自我修改提示词**：直接通道关闭；间接通道（`.claude/settings.json` 编辑）被三重把关

### 关键代码

```ts
// system prompt 组装（可整体照抄结构）：
return [
  // ── 静态段（cacheable）──
  getSimpleIntroSection(),            // 身份
  getSimpleSystemSection(),           // 系统规则（权限模式说明、注入提醒）
  getSimpleDoingTasksSection(),       // 任务执行
  getActionsSection(),                // "Executing actions with care"
  getUsingYourToolsSection(),         // 工具说明
  getSimpleToneAndStyleSection(),
  getOutputEfficiencySection(),
  // === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===   // 缓存边界
  ...(globalCacheScope ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
  // ── 动态段（registry-managed，各带缓存策略）──
  ...resolvedDynamicSections,
  // session_guidance / memory / env_info / language / output_style /
  // mcp_instructions（uncached —— 服务器连接/断开回合间变化）/
  // scratchpad / summarize_tool_results / token_budget / brief
]
// 缓存控制：每个 section 要么 systemPromptSection（缓存），要么
// DANGEROUS_uncachedSystemPromptSection（回合间会变）——
// 动态注入必须平衡 prompt cache 命中率（不缓存的变化段每次重置缓存 ~20K token）

// "Executing actions with care"（静态安全约束段）要点：
//  - 破坏性操作：删文件/分支、drop 表、杀进程、rm -rf、覆盖未提交改动
//  - 难逆转操作：force-push、git reset --hard、修改 CI/CD
//  - 影响他人/共享状态：推送、PR、发消息、外发内容（可能被缓存/索引）
//  - 上传第三方 web 工具（渲染器/pastebin/gist）前先考虑敏感性
// 工具级提示（BashTool prompt）：破坏性操作先考虑更安全替代，
// 只在真正最佳时才用破坏性操作

// 模式切换注入 = attachment 一次性事件（不是改 system prompt）：
//   进 plan → plan 上下文 attachment | 出 plan → plan_mode_exit
//   出 auto → auto_mode_exit（模型被告知分类器不再生效）
//   防抖：快速切换不产生重复 attachment（§4）

// 自我修改提示词的三重把关（间接通道 .claude/settings.json）：
//   1. safetyCheck：.claude/ 命中敏感路径 → 必须 ask（bypass 免疫）
//   2. 分类器把关：classifierApprovable: true → auto 下分类器看上下文判断
//      （模型自作主张改配置 vs 用户要求改配置）
//   3. session 级显式授权：弹窗 accept-session + scope: 'claude-folder'
```

### 陷阱

1. **把模式写进 system prompt**：每次模式切换都重建 prompt → 缓存全失效；模型看到的是"旧模式残留"状态描述。
2. **动态 section 无缓存策略**：全部 uncached 会让每个动态字段变化都重置缓存。
3. **把 hooks 内容当系统指令**：hooks 反馈应提示为"视为用户消息"——否则恶意 hook 可注入指令。

### 验收

| 编号 | 断言 |
|---|---|
| A74 | 模式从 default 切 auto → system prompt 内容不变（零缓存影响） |
| A75 | 从 auto 切出 → 注入 `auto_mode_exit` attachment；快速往返 → 只有一个（防抖） |
| A76 | 动态 section（MCP instructions）变化 → 只失效边界后缓存，静态段缓存命中 |
| A77 | auto 下模型写 `.claude/settings.json` → 分类器裁决（transcript 无用户要求 → deny） |
| A78 | bypass 下模型写 `.claude/settings.json` → 仍 ask（safetyCheck 免疫 bypass） |
| A79 | `autoMode.allow` 在 projectSettings → 不进分类器 prompt（可信源白名单） |
| A80 | 分类器 prompt 用户规则段：非空整段替换默认；空段回退默认 |

---

## 12. 审计与测试

### 设计要点

- **审计在遥测层，不在文件日志**：所有权限决策经单一出口 fan-out（Statsig + OTel + code-edit 计数器）
- **审计可 join**：requestId/msgId 使"分类器裁决 → 主对话响应 → 服务端请求"三端可互查
- **测试分层**：纯函数单测（权限核心刻意做成无副作用）→ 状态重置钩子 → 配置兼容回归 → 在线影子对比 → 故障注入
- **影子模式**：新解析器与 legacy 并行跑、只观测不切换权威——无测试文件的"在线回归测试"

### 关键代码

```ts
// 全量决策审计（单一出口）：
//   logPermissionDecision({tool, input, ctx, messageId, toolUseID},
//     { decision: 'accept' | 'reject', source })
//   source 分类（审计粒度）：
//     classifier | hook | user_permanent | user_temporary
//     | user_abort | user_reject | config
//   三层 fan-out：Statsig 分析 + OTel 遥测 + code-edit 指标计数器
//   代码编辑工具（Edit/Write/NotebookEdit）额外带语言属性

// auto 专用审计事件（tengu_auto_mode_decision，每次分类器决策都发）：
//   decision: 'allowed' | 'blocked' | 'unavailable'
//   fastPath: 'acceptEdits' | 'allowlist' | undefined   ← 度量分类器调用节省
//   classifierModel | confidence
//   consecutiveDenials | totalDenials                    ← 恢复状态审计
//   token 开销（input/output/cacheRead/cacheCreation）    ← 成本审计
//   classifierStage: 'fast' | 'thinking'  [ant-only 两阶段]
//   stage1RequestId | stage1MsgId | agentMsgId           ← join 三端
// 防泄露：审计元数据类型标记（编译期检查，禁止代码/路径进遥测）

// 影子模式（在线回归，解析器灰度）：
//   TREE_SITTER_BASH_SHADOW：新 AST 解析与 legacy 并行
//   - 记录：可用性 / too-complex / 语义失败 / 子命令分歧（subsDiffer）
//   - 强制 legacy 保持权威（"shadow mode is observational only"）
//   - 分歧率收敛后才切换权威 —— 解析器安全回归的部署形态

// 测试钩子（模块级状态重置）：
export function _resetForTesting(): void {   // autoModeState
  autoModeActive = false; autoModeFlagCli = false; autoModeCircuitBroken = false
}
```

**测试分层**：

```
层 1 纯函数单测：denialTracking / ruleParser / wildcardMatch / shadowDetection / PermissionUpdate
层 2 状态钩子：autoModeState._resetForTesting / modeCycling
层 3 配置兼容回归：BACKWARD_COMPATIBILITY_CONFIGS 样本集
层 4 在线影子对比：解析器分歧遥测 → 收敛后切权威
层 5 故障注入：分类器 mock 三态（unavailable/shouldBlock/transcriptTooLong）
              限流 mock（429/529）[ant-only /mock-limits]
层 6 审计断言：决策事件 source 正确性 + 无代码/路径泄露
```

### 陷阱

1. **审计只记结论不记来源**：没有 `source` 分类（classifier/hook/user 等）就无法区分"谁批准的"——事故复盘失效。
2. **审计事件泄露代码/路径**：必须类型标记 + 清理函数（sanitizeToolNameForAnalytics）。
3. **影子模式切换权威太快**：分歧未收敛就切换 = 把未验证的解析器上线。

### 验收

| 编号 | 断言 |
|---|---|
| A81 | `denialTracking` 三态单测：3 连续 / 20 总计 / 成功后重置 |
| A82 | `matchWildcardPattern` 单测：`git *` 尾部可选、`\*` 字面、多通配排除、heredoc 换行 |
| A83 | 兼容测试：旧配置样本加载全部通过；新增字段有样本覆盖 |
| A84 | 分类器 mock：unavailable → fail-closed deny；shouldBlock → denial+1；超限 → 回退/abort |
| A85 | 影子模式：新旧解析分歧被记录（事件含 subsDiffer），权威不被切换 |
| A86 | 每次 allow/deny 产生一条决策审计事件，source 正确（classifier/hook/user_permanent 等） |
| A87 | 审计事件不含代码/文件路径（类型标记编译期检查） |
| A88 | 状态钩子重置后，模式循环与门控行为回到初始态 |

---

## 13. 验收总清单

| 编号 | 断言 | 章节 |
|---|---|---|
| A1 | 规则判别三形态正确 | §2 |
| A2 | `git *` 尾部可选语义 | §2 |
| A3 | `\*` 字面星号转义 | §2 |
| A4 | 多通配不做尾部可选 | §2 |
| A5 | heredoc 换行匹配（dotAll） | §2 |
| A6 | MCP 服务器级规则隔离 | §2 |
| A7 | 遮蔽检测告警（含共享源） | §2 |
| A8 | 转义 roundtrip + legacy 等价 | §2 |
| A9 | deny 优先于路径（CWD 内也 deny） | §3 |
| A10 | 复合命令子命令级 deny | §3 |
| A11 | AST too-complex 不降级 deny | §3 |
| A12 | bypass 免疫：`.git/config` 仍 ask | §3 |
| A13 | bypass 免疫：内容级 ask 规则 | §3 |
| A14 | requiresUserInteraction 免疫 bypass | §3 |
| A15 | 无规则 → 默认 ask | §3 |
| A16 | 只读命令工具层放行 | §3 |
| A17 | auto 进入剥离 + stash 记录 | §4 |
| A18 | auto 退出恢复 + stash 清空 | §4 |
| A19 | 切换幂等 | §4 |
| A20 | 落点：session 不写盘 / settings 写 defaultMode | §4 |
| A21 | 恢复会话模式清洗 | §4 |
| A22 | 启动优先级与门控 | §4 |
| A23 | 模式循环与 auto 门控跳过 | §4 |
| A24 | auto 白名单零分类器调用 | §5 |
| A25 | CWD 内写操作零分类器调用 | §5 |
| A26 | CWD 外写操作过分类器 | §5 |
| A27 | 非 classifierApprovable 免疫 auto | §5 |
| A28 | 分类器故障 fail-closed deny | §5 |
| A29 | transcriptTooLong 回退 | §5 |
| A30 | denial 超限回退/abort | §5 |
| A31 | 任意 allow 重置连击 | §5 |
| A32 | 危险规则剥离/恢复 | §5 |
| A33 | 分类器规则段 REPLACE 语义 | §5 |
| A34 | 子代理 ask 默认 deny | §6 |
| A35 | auto 下子代理同走分类器 | §6 |
| A36 | 父模式优先级 | §6 |
| A37 | allowedTools 替换语义 | §6 |
| A38 | 子代理 denial 超限独立终止 | §6 |
| A39 | fork denial 计数独立 | §6 |
| A40 | hooks 是唯一外部静默通道 | §6 |
| A41 | bubble 冒泡 [ant-only] | §6 |
| A42 | auto 抢占 ask（零弹窗） | §7 |
| A43 | 分类器故障默认 deny 非 ask | §7 |
| A44 | denial 超限回退弹窗 | §7 |
| A45 | Bash 2 秒投机竞速 | §7 |
| A46 | accept-session 生命周期 | §7 |
| A47 | 始终允许写盘生效 | §7 |
| A48 | ask 规则在 auto 下 = 过分类器 | §7 |
| A49 | requiresUserInteraction 仍弹窗 + ESC 中止 | §7 |
| A50 | 只读并行 | §8 |
| A51 | 写工具独占 | §8 |
| A52 | 输出保序 | §8 |
| A53 | Read 失败不级联 | §8 |
| A54 | Bash 失败级联杀兄弟 | §8 |
| A55 | 并发声明 fail-closed | §8 |
| A56 | auto 不改并发 | §8 |
| A57 | 工具错误不重试 | §9 |
| A58 | 400 非溢出不重试 | §9 |
| A59 | 529 退避重试 + Retry-After | §9 |
| A60 | 分类器前台级 529 重试 | §9 |
| A61 | 流式计数延续 | §9 |
| A62 | 3 次 529 切 fallback 模型 | §9 |
| A63 | 分类器故障 deny | §9 |
| A64 | 恢复会话模式清洗 | §9 |
| A65 | 设置源覆盖顺序 | §10 |
| A66 | 多项目配置切换 | §10 |
| A67 | JSON 语法错误不覆盖 | §10 |
| A68 | 校验失败 raw 合并 | §10 |
| A69 | undefined 删除语义 | §10 |
| A70 | autoMode 排除 projectSettings | §10 |
| A71 | autoMode 多源追加合并 | §10 |
| A72 | 未知字段保留不触碰 | §10 |
| A73 | 向后兼容测试锁 | §10 |
| A74 | 模式切换零 system prompt 影响 | §11 |
| A75 | auto_mode_exit attachment + 防抖 | §11 |
| A76 | 缓存边界：动态段失效隔离 | §11 |
| A77 | auto 下改 `.claude` 走分类器 | §11 |
| A78 | bypass 下改 `.claude` 仍 ask | §11 |
| A79 | 分类器规则可信源白名单 | §11 |
| A80 | 规则段 REPLACE 语义 | §11 |
| A81 | denial 三态单测 | §12 |
| A82 | 通配单测集 | §12 |
| A83 | 兼容样本回归 | §12 |
| A84 | 分类器 mock 三态 | §12 |
| A85 | 影子模式观测不切权威 | §12 |
| A86 | 决策审计事件 + source 分类 | §12 |
| A87 | 审计防泄露 | §12 |
| A88 | 状态钩子重置 | §12 |

---

## 14. 实现顺序建议

```
Phase 1（地基）   §1 类型 + §2 规则引擎
                  → 纯函数，先行单测（A1-A8）；出口：A1-A8 全绿
Phase 2（管道）   §3 九步管道 + §4 模式状态机
                  → 出口：A9-A23 全绿
Phase 3（auto）   §5 分类器管道（fast-path 顺序 + denial + 剥离）
                  → 出口：A24-A33 全绿
Phase 4（边界）   §6 子代理 + §7 ask 处置链
                  → 出口：A34-A49 全绿
Phase 5（健壮性） §8 并发 + §9 错误恢复
                  → 出口：A50-A64 全绿
Phase 6（治理）   §10 配置 + §11 提示词 + §12 审计测试
                  → 出口：A65-A88 全绿
```

**贯穿铁律**（实现期每阶段复查）：

1. 1a-1g 免疫一切模式（含 auto 与 bypass）——§3
2. auto 只接管 ask，从不跳过闸门——§5
3. 子代理默认拒绝一切 ask（hooks 是唯一外部静默通道）——§6
4. 可影响裁决器 prompt 的配置只来自可信源——§10
5. 成本递增排列 fast-path；denial 计数（3/20）是最后安全气囊——§5
