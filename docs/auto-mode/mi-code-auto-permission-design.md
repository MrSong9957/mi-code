# MiCode Auto 权限模式架构设计

> 状态：已按 2026-08-03 审核意见修订，作为 MiCode 实现的权威设计输入。
>
> Reference：`docs/auto-mode/auto-mode-spec.md` 是只读的 Claude Code 行为参考，不是 MiCode 的可编辑规格。本设计记录 MiCode 的最终语义以及相对 reference 的差异；两者冲突时，MiCode 实现、测试与验收以本文为准。

## 1. 目标与边界

MiCode 已有一条生产权限链：`PermissionChecker.checkDecision()` 产生同步安全决定，`executeToolCall()` 负责工具调用编排，`RuntimeSecurityGate.execute()` 是唯一授权与执行出口。本项目不创建平行的 `src/permissions/*`，而是在这条宿主链上增加 auto ask resolver。

目标是把当前“auto 模式直接放行未决写操作”替换为：

1. 同步强约束先执行并保持权威。
2. auto 只处理同步阶段留下的 ask。
3. 本地 fast-path 只能在安全前置过滤之后运行。
4. 只有可信 user-authored intent 可以支持分类器 allow。
5. 分类器、headless hooks、交互弹窗都不能绕过最终 runtime gate。

不在本项目范围内：重写 Bash parser、建立第二个 settings store、改变工具并发的安全分类、为工具执行增加自动重试、修改 Claude Code reference 文档。

## 2. 权威关系与 MiCode 差异

| 主题 | Claude Code reference | MiCode 最终设计 |
|---|---|---|
| 用户可见模式 | reference 使用 `default/plan/acceptEdits/bypassPermissions/dontAsk/auto` | UI 与配置继续使用 `build/plan/auto`；`auto` 正式可用 |
| 内部 evaluation mode | 模式本身参与工具自检 | 增加只在权限求值调用中出现的 `acceptEdits/bypassPermissions/dontAsk`；不暴露新的 CLI/TUI 模式 |
| 生产入口 | reference 模块路径 | 复用 `src/permission/*`、`executeToolCall()`、`RuntimeSecurityGate` |
| canonical agent tool | reference 文本存在 `Agent/AgentTool` 差异 | canonical ID 固定为运行时注册名 `spawn_agent`；旧名只作输入别名 |
| auto 激活状态 | reference 含模块级信号 | 状态属于 `SessionState`，禁止模块级可变权威信号 |
| dangerous-rule stash | reference 对 auto 期间规则变更不完整 | stash 表示当前逻辑危险 allow 集合，所有 update/reload 同步作用于 stash |
| classifier 输入 | reference 使用较宽的主 transcript 上下文 | 每次只投影真实 user-authored messages 与当前一个 executable tool call；其余内容不进入模型 |
| classifier 执行通道 | reference 以内部模块描述分类流程 | MiCode 使用 provider-neutral 的直接 RPC；不是 Agent、subagent 或 tool |
| retry cap | reference 是 base cap 32 秒 | 明确最终 jitter 后可处于 `[32000, 40000)` |

### 2.1 Reference Disposition Matrix

下表只说明 MiCode 如何处置 reference 的章节，不复制其细节。`ADOPT` 表示接受行为目标，`ADAPT` 表示映射到 MiCode 宿主后重定义，`REUSE-AS-IS` 表示直接复用现有宿主能力，`DROP-DEFER` 表示本期不实现。

| Reference | Disposition | 一句理由 |
|---|---|---|
| §1 核心类型系统 | ADAPT | 对外模式保持 `build/plan/auto`，额外模式仅作内部 evaluation。 |
| §2 规则引擎 | ADAPT | 使用 MiCode canonical ID、MCP exact/server 语义与统一危险规则判定。 |
| §3 权限检查管道 | ADAPT | 顺序映射到现有 `PermissionChecker`，并修正 too-complex 的安全位置。 |
| §4 模式状态机与持久化 | ADAPT | 状态归入 `SessionState`，更新只经 `applyPermissionUpdate`。 |
| §5 auto 分类器管道 | ADAPT | 采用 Stage 1 fast filter + Stage 2 reasoned review，以 provider-neutral RPC 实现且绝不建成 subagent。 |
| §6 子代理权限 | ADAPT | 复用既有 fork/hook 路径，但隔离每个 session 的 auto 瞬态状态。 |
| §7 ask 处置链 | ADAPT | 接入现有 runtime gate，并保留 MiCode 的交互竞速与 headless hooks。 |
| §8 并发控制 | ADAPT | 复用 scheduling class、queue 与保序机制，级联收窄为仅 `run_bash` failure。 |
| §9 错误恢复与降级 | ADAPT | 沿用 API retry，但工具不重试且 classifier fail-closed。 |
| §10 配置持久化与迁移 | ADAPT | 扩展现有 `ConfigStore`，按四个决策域分别定义来源语义。 |
| §11 提示词与安全约束 | ADAPT | 静态 prompt 不随模式变化，退出提示使用动态 attachment。 |
| §12 审计与测试 | ADOPT | 接受脱敏审计与行为测试目标，具体落到 MiCode 测试层级。 |

## 3. 核心类型与状态归属

```ts
export type PermissionMode = 'build' | 'plan' | 'auto'

export type PermissionEvaluationMode =
  | PermissionMode
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'dontAsk'

export type ToolPermissionResult =
  | { behavior: 'allow'; decisionReason?: PermissionDecisionReason }
  | { behavior: 'deny'; message: string; decisionReason: PermissionDecisionReason }
  | { behavior: 'ask'; message: string; decisionReason?: PermissionDecisionReason }
  | { behavior: 'passthrough'; decisionReason?: PermissionDecisionReason }

export interface AutoPermissionState {
  readonly denial: { readonly consecutive: number; readonly total: number }
  readonly strippedDangerousRules: readonly PermissionRule[]
  readonly exitAttachmentPending: boolean
}
```

`SessionState` 是 `sessionId`、session allowlist、auto denial、dangerous stash、exit attachment 防抖的唯一 mutation boundary。fork 创建独立的 `AutoPermissionState`；父规则快照可以继承，但 fork 与父会话不能共享 denial 计数或 stash 引用。

所有权限规则与模式变化只通过：

```ts
applyPermissionUpdate(
  snapshot: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext
```

该函数是唯一规则状态变换实现。mode transition、配置 reload、remember、always allow 都不得复制 add/remove/replace 逻辑。

### 3.1 `isDangerousAllowRule` 的权威语义

`isDangerousAllowRule(rule)` 是 auto dangerous stash 的唯一分区判定。Task 2 的进入 auto、add/remove/replace、reload、resume/repartition 都只能调用该函数，不得在 `SessionState`、配置层或 resolver 维护第二套命令表、正则或例外。

判定前先 canonicalize tool ID：`Task`、`Agent`、`AgentTool` 均归一为 `spawn_agent`。随后按以下完整规则求值：

1. 全局 tool allow `*` 为危险。
2. canonical `spawn_agent` 的任意 allow（裸规则、具体内容或 wildcard）均为危险。
3. canonical `run_bash` 的裸 allow 为危险。
4. `run_bash` 的 rule content 含未转义 wildcard，或使用 legacy prefix wildcard（包括 `:*`）时为危险；wildcard 不尝试证明窄化安全。
5. 对 exact `run_bash` 内容，去掉前置环境变量赋值，提取首个可执行文件；Windows 下大小写不敏感并去掉 `.exe`。若 executable 属于以下任一集合，则为危险：
   - shell/interpreter：`sh`、`bash`、`zsh`、`fish`、`pwsh`、`powershell`、`cmd`、`python`、`python3`、`node`、`deno`、`bun`、`ruby`、`perl`、`php`、`lua`、`osascript`；
   - runner/indirect executor：`npx`、`npm`、`pnpm`、`yarn`、`bunx`、`uv`、`pipx`、`xargs`、`env`、`make`、`just`、`task`、`docker`、`podman`、`kubectl`。
6. 其他 exact `run_bash` 规则（例如精确的 `git status`）以及其他 canonical tool 的 exact allow 不因此判为危险；它们仍须经过普通权限与 safety 管道。

alias 只在 canonicalize 阶段处理；wildcard 只按上述全局、`spawn_agent`、`run_bash` 规则处理，不允许 alias 展开或 prefix 匹配产生额外授权。

## 4. 规则与 MCP 匹配语义

规则先规范化 tool name，再区分 tool-level 与 content-level。MCP 规则使用 `__` 作为 server/tool 分隔符；server 名和 tool 名允许单下划线 `_`，但不允许把 `__` 当作普通名称字符。

决策表：

| Rule | Candidate tool | 结果 |
|---|---|---|
| `mcp__server_one__tool_a` | `mcp__server_one__tool_a` | exact match |
| `mcp__server_one__tool_a` | `mcp__server_one__tool_b` | 不匹配 |
| `mcp__server_one` | `mcp__server_one__tool_a` | server-level match |
| `mcp__server_one__*` | `mcp__server_one__tool_a` | server wildcard match |
| `mcp__server_one` | `mcp__server_two__tool_a` | 不匹配 |

解析必须先检查完整字符串 exact。只有 rule 在 `mcp__<server>` 处结束，或 tool segment 精确为 `*`，才获得整 server 匹配能力。具体 tool rule 永远不能退化为 server prefix match。

## 5. 同步权限管道与 AST too-complex

同步管道仍由 `PermissionChecker` 负责。顺序是：

1. canonical tool name。
2. tool-level deny。
3. raw content deny 与 explicit ask。
4. Bash structural parse；成功时对子命令再执行 deny/explicit ask。
5. 可从原始输入确定的内置危险命令、路径安全、requiresUserInteraction 等强约束。
6. AST too-complex fallback。
7. mode-specific discretionary allow。
8. ordinary allow rule。
9. 未决结果转换为 ask。

> **run_bash 例外的实际位置（§6.4）**：`PermissionChecker` 保持 authority-neutral，第 7 步（discretionary allow）与第 8 步（ordinary allow）的 allow 语义对三种 authority 完全一致——enforced+auto+`run_bash` 的 allow→ask 降级**不在 checker 内发生**，而是在 `executeToolCall` 的 authority-aware routing 中（`runtime.authority==='enforced'` gating）。第 2-6 步的 hard deny / safety / protected-settings / requiresInteraction 由 checker 直接产生，仍是最早终止点。详见 §6.4。

AST too-complex 不是一个高于强规则的早退 deny，也不是放行条件：

```text
tool/raw deny 命中            -> deny
tool/raw explicit ask 命中    -> ask
AST 可解析且子命令 deny 命中  -> deny
AST 可解析且子命令 ask 命中   -> ask
原始输入可确定的内置 safety 命中 -> 对应 deny/ask
AST too-complex 且无强规则命中 -> ask
```

因此 too-complex 绝不能把已经确定的 deny 降级为 ask。解析失败后也不能继续进入 auto allowlist、acceptEdits 或 classifier。

## 6. Auto ask resolver

Core Anchor：

```ts
export interface PermissionAskResolver {
  resolve(request: PermissionAskResolutionRequest): Promise<SecurityDecision>
}
```

`executeToolCall()` 的固定数据流：

```text
PermissionChecker
  -> PermissionAskResolver
  -> PermissionClassifier
  -> RuntimeSecurityGate
  -> executor
```

这是权限裁决的唯一生产链。三层职责不可合并：

1. `PermissionAskResolver` 负责权限编排：接收同步 checker 结果，执行 safety、denial、allowlist、acceptEdits simulation、hooks/interactive 等本地路径；只有本地规则与 fast-path 均未解决的 ask 才调用 `PermissionClassifier`。其中 acceptEdits simulation 的 fast-path **只服务于非 `run_bash` 工具**；canonical `run_bash` ask 不经 fast-path 解决，必须进入 classifier（见固定顺序第 8 步与 §6.2 不可绕过不变量）。
2. `PermissionClassifier` 负责可信输入投影、Stage 1/Stage 2 状态机、输出协议校验与 fail-closed 映射；它只返回 `allow | deny` 裁决，不拥有 tool registry、executor 或 runtime gate 引用。
3. `PermissionClassifierProvider` 负责一次直接的底层 provider API 调用。它不得经过 `spawn_agent`、任何 tool registry、`streamingQuery`、Agent loop 或正常 assistant 消息流。

上图中的 `PermissionClassifier` 是条件调用节点：resolver 本地解决时 classifier 零调用；需要模型裁决时则必须等待 classifier 的最终决定，之后才允许进入 `RuntimeSecurityGate`。classifier 不能执行、重放、改写或排队被审核 tool；被审核调用只能由 gate 授权后交给 executor。

resolver 顺序是安全语义，不允许重排：

1. 非 ask：原样返回。
2. `safetyCheck.classifierApprovable === false`：立即停止所有自动路径。主会话保留 ask；headless 进入 PermissionRequest hooks，hooks 无决定则 deny。
3. `safetyCheck.classifierApprovable === true`：跳过 allowlist 与 acceptEdits simulation，直接 classifier。
4. `requiresUserInteraction`：保留 ask，主会话交互；headless 按 hooks -> deny。
5. denial threshold：主会话回退交互，headless deny/abort。
6. explicit ask rule（reason_code `permission.explicit_ask`）：跳过 allowlist 与 acceptEdits simulation，直接 classifier。
7. 明确安全 allowlist。
8. canonical `run_bash` 强制 classifier 短路：未被前置强约束终止的 canonical `run_bash` ask 直接进入 classifier，禁止落入 allowlist 命中（第 7 步已不可能，因 `run_bash` 不在集合）与 acceptEdits simulation（第 9 步）。该短路覆盖 reason_code `permission.auto_run_bash_requires_classifier`（checker 在 enforced + auto 下对 run_bash allow 的降级产物，§6.4 锚点 1）以及任何其他原因进入 resolver 的 canonical `run_bash` ask。详见 §6.4 强制不变量与 §6.2 不可绕过不变量。
9. acceptEdits simulation（仅服务于非 `run_bash` 工具）。
10. classifier。

### 6.1 auto safe allowlist 的唯一真相源

allowlist 属于 resolver，而不属于 classifier。唯一常量定义在 `src/permission/ask-resolver.ts`：

```ts
export const AUTO_SAFE_TOOL_ALLOWLIST = new Set([
  'read_file',
  'glob',
  'grep',
  'load_skill',
  'schedule_list',
  'memory_read',
  'memory_list',
  'read_inbox',
  'read_plan_file',
])
```

匹配发生在 canonicalize 之后，只做 canonical tool ID exact match。`run_bash`、`spawn_agent`、MCP、写入/变更工具与 wildcard 均不在该集合。classifier 模块不得导入、复制或检查该集合，也不得实现等价 fast-path；resolver 命中后直接 allow 且 classifier 零调用，未命中才继续后续步骤。

### 6.2 acceptEdits simulation

该 fast-path 必须使用内部 evaluation mode：

```ts
tool.checkPermissions(input, {
  ...permissionContext,
  evaluationMode: 'acceptEdits',
})
```

禁止用 `build` 替代。`build` 的默认写操作语义是 ask，而 `acceptEdits` 是专门的本地 discretionary allow 求值；两者不是别名。

simulation 只消费 allow。若返回 deny，最终结果仍 deny；若返回 ask/passthrough，继续 classifier。simulation 不能看到被 non-classifierApprovable safety 拦截的请求。

**不可绕过不变量（canonical `run_bash`）**：canonical `run_bash` 的 unresolved auto ask 永远不进入 acceptEdits simulation。无论 `checkWithEvaluationMode('run_bash', input, 'acceptEdits')` 的实现实际返回什么（当前宿主 `PermissionChecker` 实现确实返回 `allow`，这是 §5 discretionary allow 的既有语义），resolver 都不得为 canonical `run_bash` ask 调用该 simulation，也不得消费其结果作为自动 allow/deny。canonical `run_bash` ask 在 allowlist 未命中之后必须直接进入 `PermissionClassifier`（对应 §6 固定顺序第 8 步）。`write_file`/`edit_file` 等非 `run_bash` 写工具继续保留 acceptEdits fast-path，本不变量不扩大到这些工具。

> 本段是 §6.4 强制不变量在 resolver 层的投影。§6.4 把不变量实现为三锚点（authority-aware allow→ask 降级 + resolver 短路 + executeToolCall 后置 rewrite 失效）：resolver 短路（本段）只是其中一环。若仅靠 resolver 短路，`PermissionChecker` 的 ordinary allow rule（§5 第 8 步）会直接返回 allow（不经 resolver），`executeToolCall` 的 sessionAllowlist/subagent rewrite 也会把 ask 改写为 allow。三锚点缺一即漏，必须同步守住。根因：`PermissionChecker → resolver → classifier` 这条"ask 阶段"链路只覆盖 checker 返回 ask 的情形；checker 直接返回 allow、或 checker 之后 ask 被改写为 allow 的路径都不经 resolver，故不变量必须锚定在"gate 前的 effectiveDecision 事实"，而非"resolver 内部顺序"。降级由 `executeToolCall` 的 authority-aware routing 完成（`runtime.authority==='enforced'` gating），checker 本体不改。

### 6.3 non-classifierApprovable safety

该检查严格早于 allowlist、acceptEdits simulation、classifier。其主会话结果是 ask；headless 结果只能来自 PermissionRequest hook，hook 无决定为 deny。auto allowlist 命中也不得改变这个顺序。

### 6.4 canonical run_bash classifier 强制不变量（enforced authority）

§6.1-§6.3 描述的是 resolver 内部对 ask 的本地化处理；但 Auto 模式的核心产品契约更强：

> "任何真正准备执行的 canonical `run_bash` 命令，在 Auto 模式下都必须先经过 LLM command reviewer；LLM `ALLOW` 才能执行，`DENY`/失败必须阻止。"

`PermissionChecker → PermissionAskResolver → PermissionClassifier → RuntimeSecurityGate → executor` 这条"ask 阶段"链路本身不足以表达该契约，因为：

- `PermissionChecker` 可能对 canonical `run_bash` 直接返回最终 `allow`（ordinary allow rule、discretionary allow），根本不进 resolver；
- `executeToolCall` 的 origin 路由层还可能在 checker 之后把 `ask` 改写为 `allow`（sessionAllowlist exact-match、subagent silent policy），也不进 resolver/classifier。

因此权威不变量不是"resolver 不绕过 classifier"，而是如下 gate 前事实：

> **在 `AUTO_PERMISSION_AUTHORITY=enforced` 下，Auto 模式的 canonical `run_bash`：**
> - **同步阶段已经产生最终 deny 的请求可以在 classifier 前直接终止为 deny；**
> - **除此之外，任何进入 `RuntimeSecurityGate`/executor 的 `allow` 必须携带"当前 executable tool call 已经由 `PermissionClassifier` 产生 ALLOW"的事实。**
>
> 没有该 classifier ALLOW → gate/executor 不可达。任何本地 allow（ordinary allow rule、persistent allow、session allowlist、acceptEdits fast-path、subagent silent policy）都不得替代该 LLM 审核。

该不变量只锁定 `enforced` authority。`legacy` 保持既有诊断行为；`shadow` 保持 `legacy` authoritative + candidate 只观察的迁移语义（A85），本次修复不改变 legacy/shadow 的授权语义。

**关键架构事实（决定锚点位置）**：`PermissionChecker` 是 legacy/shadow/enforced 三种 authority 共用的进程级单例，**没有 authority 概念**。若把 enforced+auto+run_bash 的 allow→ask 降级放进 checker（按 `mode==='auto'`），会同时改变 legacy（本应 allow 的 run_bash 变 ask，无法执行）与 shadow（legacy authoritative decision 从 allow 变 ask，违反 A85"shadow 最终授权由 legacy 决定"）。因此：

1. **`PermissionChecker` 保持 authority-neutral，本次不修改**：它的 §5 同步管道（含 gate 7 discretionary allow、gate 8 ordinary allow rule）对三种 authority 行为完全一致。legacy/shadow 的 checker 行为完全不变。
2. **enforced-only 语义由 authority-aware runtime routing 保证**：`createExecutionRuntimeForTurn` 将 authority 显式注入 `ToolExecutionRuntime`；enforced-only 守卫全部集中在 `executeToolCall`（唯一能感知 authority 的生产节点），由 `runtime.authority==='enforced'` gating。
3. **不新增第二条 classifier 授权链**：allow→ask 降级后仍进入现有 `DefaultPermissionAskResolver → PermissionClassifier`，不新建 barrier、不复制 classifier 调用逻辑。

**实现锚点（authority-aware execution routing，三个点必须同步守住，缺一即漏）**：

```text
authority routing / executeToolCall:
  createExecutionRuntimeForTurn 将 authority 显式带入 ToolExecutionRuntime。

  仅当 authority === enforced && mode === auto && canonical tool === run_bash:

    若同步 checker 已产生最终 deny:
      保持 deny，classifier 不调用（同步阶段已终止）。

    若 checker 产生 allow:
      在 authority-aware execution routing 中降级为
      permission.auto_run_bash_requires_classifier ask，
      然后进入既有 resolver。

    若 checker 原本就是 ask:
      进入既有 resolver（无降级，已是 ask）。

  resolver:
    canonical run_bash 跳过 allowlist / acceptEdits，
    直接 resolveByClassifier。

  executeToolCall 后置 rewrite:
    在同一 enforced+auto+run_bash 条件下，
    SessionAllowlist / subagent silent policy 等不得把
    未经 classifier ALLOW 的 decision 改写成最终 allow。

  classifier ALLOW → RuntimeSecurityGate → executor
  classifier DENY/failure → executor 0
```

具体三锚点（与上图一一对应）：

1. **authority-aware allow→ask 降级（executeToolCall 内）**：在 `checkDecision` 之后、origin 路由 if/else 链之前，对 `runtime.authority==='enforced' && mode==='auto' && canonical 'run_bash' && decision.behavior==='allow'` 降级为 `ask`，固定 reason_code `permission.auto_run_bash_requires_classifier`。同步 checker 已产生的 deny 不降级（直接终止）；原本就是 ask 的不降级。checker 本体零修改。
2. **resolver canonical run_bash ask → classifier 短路**：进入 resolver 的 canonical `run_bash` ask（含锚点 1 降级产物）走 resolver 固定顺序第 8 步直进 `resolveByClassifier`，不进 allowlist、不进 acceptEdits simulation（详见 §6.2）。resolver 只在 enforced/shadow 下构造；shadow 下 resolver 是 candidate，`createShadowResolver` 返回 `request.decision`（checker 原始结果），不受短路影响。
3. **executeToolCall 后置 rewrite 失效（authority-gated）**：在同一 `authority==='enforced' && mode==='auto' && run_bash` 条件下，sessionAllowlist `rewriteToAllow` 与 subagent silent policy（`applySubagentSilentPolicy`）不得把未经 classifier ALLOW 的 decision 改写成最终 allow。enforced authority 下 subagent 共享 parent turn runtime 的 `askResolver`（A35），走 headless 路径仍到 classifier。

锚点 1 是上游阻断（在 allow 到达 gate 前降级），锚点 2/3 是 defense-in-depth。三者共同保证：即使其中一处被未来修改破坏，其余两处仍能阻断 bypass。该不变量用 §11 5b 的生产链集成测试证明：配置了 `run_bash` allow 规则、sessionAllowlist 命中、subagent origin 的 enforced + auto session，执行该 run_bash 时 classifier 必有 ≥1 call，且 gate/executor 只在 classifier ALLOW 后可达；legacy/shadow 回归证明 checker 行为不变。

## 7. 独立 Permission Classifier 通道

### 7.1 最小可信输入

classifier 不接收普通 transcript，而接收一次不可变的最小投影：

```ts
export interface PermissionClassifierInput {
  readonly authenticUserMessages: readonly AuthenticUserMessage[]
  readonly executableToolCall: ExecutableToolCall
}

export interface AuthenticUserMessage {
  readonly role: 'user'
  readonly source: 'user'
  readonly authoredByUser: true
  readonly content: string
}

export interface ExecutableToolCall {
  readonly callId: string
  readonly canonicalToolName: string
  readonly input: Readonly<Record<string, unknown>>
}
```

输入只允许：

1. 经消息来源与 authorship 校验的真实 user-authored messages；
2. 当前待审核的 executable tool call；

第一版每次只审核一个当前 `executableToolCall`。同一 assistant turn 产生多个 tool calls 时，每个调用都独立执行 `PermissionChecker -> PermissionAskResolver -> PermissionClassifier -> RuntimeSecurityGate -> executor`，不得合并授权、共享 classifier decision 或用一个调用的 ALLOW 推导另一个调用。第一版不实现 tool-call 关联算法；未来若需要原子多调用授权，必须另行设计输入、事务和失败语义。

assistant prose、assistant thinking/reasoning、其他 tool call、tool output、tool result、file 内容、MCP 返回内容、hook 内容、system/agent 转述一律在投影前删除，不建立 `untrustedEvidence` 分桶，也不把它们交给模型。若 `authenticUserMessages` 为空，`PermissionClassifier` 在 provider 调用前直接 deny，reason code 为 `permission.classifier_missing_user_authorization`。

### 7.2 两阶段裁决协议

Stage 1 与 Stage 2 使用相同、不可变的输入前缀；Stage 2 不得添加正常 Agent transcript、tool result 或 TUI 状态。

| 阶段 | 调用与输出 | 状态转换 |
|---|---|---|
| Stage 1 fast filter | `PermissionClassifierProvider` 直接 RPC；支持时关闭 reasoning；权威输出协议是严格单个枚举 decision `ALLOW | FLAG`，无额外文本 | `ALLOW` -> classifier 最终 allow；`FLAG` -> 调用 Stage 2 |
| Stage 2 reasoned review | 复用同一输入前缀；允许 provider 内部 reasoning；严格解析最终单个 `ALLOW | DENY` decision | `ALLOW` -> allow；`DENY` -> deny |

Stage 1 返回 `ALLOW` 时 Stage 2 调用次数必须为 0。Stage 1 的 `FLAG` 只是内部升级信号，不是最终权限决定。两个阶段的 timeout、provider error、输入超限、parse failure、额外 token/字段、未知 decision 或其他 protocol failure 全部 fail-closed 为 deny；classifier 不返回 ask，也不把失败交给 Agent 自行解释。

### 7.3 `PermissionClassifierProvider` 边界

```ts
export interface PermissionClassifierProvider {
  readonly capabilities: ClassifierProviderCapabilities
  invoke(request: ClassifierProviderRequest): Promise<unknown>
}
```

provider adapter 只封装底层模型 RPC、认证、连接与 provider-specific 参数翻译；返回值必须由 `PermissionClassifier` 的严格协议解析器验证。该接口不接受 `ToolRegistry`、`RuntimeSecurityGate`、Agent state、message sink 或 TUI callback，因此无法间接执行被审核工具，也不能产生普通 assistant message、thinking block、tool call、tool result 或可见 TUI 输出。

Stage 1 优化属于 provider capability，不属于权限语义。adapter 在 provider 支持时尽量请求：

- reasoning/thinking disabled；
- minimum output budget；provider 支持时把 max output 压到其实现允许的最低值；
- deterministic/low-variance decoding；
- 复用 client、connection、固定输入前缀与 prompt cache。

目标是最小输出预算，但不得把协议表述为跨 provider 必然等于一个 tokenizer token 或固定字节数。`ALLOW`、`FLAG` 是枚举值，不是 tokenizer/编码承诺。

第一版不做运行时网络 capability discovery。`ClassifierProviderCapabilities` 只能由各 provider adapter 或已有 provider 配置静态声明；未声明、缺失或未知能力一律视为 unsupported。unsupported hint 直接省略，不增加 capability probe RPC，不进入 Agent runtime，也不改变权限语义。adapter 按 provider 的最小可用 RPC 发送，客户端仍严格只接受一个合法 decision，其他响应 deny。能力缺失只影响延迟、成本或方差，不改变 `ALLOW/FLAG`、`ALLOW/DENY` 协议与 fail-closed 结果。

### 7.4 `ClassifierModelPolicy`

模型选择由独立、可替换的 policy 完成，不在 classifier 或 provider adapter 中写死模型名：

```ts
export interface ClassifierModelPolicy {
  selectStage1(context: ClassifierModelContext): ModelRef
  selectStage2(context: ClassifierModelContext, stage1Model: ModelRef): ModelRef
}
```

模型选择与绑定语义固定为：

1. 显式配置了 `classifierModel`：必须将该模型绑定为本次 classifier model，不得静默替换。模型不存在、静态已知不可用、timeout、provider failure 或协议失败时，本次权限裁决 fail-closed deny。
2. 未显式配置 `classifierModel`：当前 provider 已知或配置的 fast classifier model 是 advisory optimization；如果请求前根据静态 adapter/config 信息已知它不可选，则绑定当前 session 主模型。
3. 未显式配置且没有可选 fast classifier model：绑定当前 session 主模型。第一版不要求第二模型，因此 auto 仍可工作。

模型在 Stage 1 RPC 前绑定。绑定后，同一次权限裁决的 RPC failure、timeout、parse/protocol failure 不得触发临时跨模型切换或用另一模型重新判权；现有 retry policy 若适用，也只能重试同一个已绑定模型，耗尽后 deny。选择不能仅以价格最低为依据，也不假设“最便宜模型”具有足够安全性。

默认 `selectStage2` 必须返回 Stage 1 已绑定模型。接口保留未来策略选择 stronger Stage 2 model 的能力，但本轮不增加独立 Stage 2 配置、多模型竞速或动态路由。

### 7.5 非消息化与生命周期

classifier RPC 是权限链内部调用，不加入主 session message history，不触发 Agent loop，不参与 turn thinking 生命周期，也不发送 TUI delta。只有最终裁决与脱敏 audit metadata 返回 resolver。resolver 必须 await 该裁决；在此之前，被审核 tool 不得进入 `RuntimeSecurityGate`，更不得进入 executor。

## 8. 交互、hooks 与 remember

主会话剩余 ask 可进入交互链。Bash 的自动检查与 dialog delay 使用可注入 timer 竞速：自动决定在 2 秒内完成则不创建 dialog，超时才显示。ESC 产生 deny 并 abort 尚未完成的自动检查。

headless 不创建 dialog。PermissionRequest hooks 是唯一外部静默授权通道；首个明确 allow/deny 生效，异常按无决定处理，全部无决定后 deny。

`accept-session` 写入现有 `SessionAllowlist`，仅覆盖同 canonical tool + exact structured input 的普通 confirmation ask，并随 `SessionState.transitionTo()` 清理。`always allow` 产生持久化 `PermissionUpdate`，仍需重新经过完整同步管道，不能覆盖 hard deny/safety ask。

resume 是两个可观察阶段：`SessionState.transitionTo(resumedSessionId)` 先清 session allowlist、denial、stash、attachment pending；随后 `resumePermissionSession()` 读取持久规则，并只通过 `applyPermissionUpdate(replaceRules)` reload/repartition。稳定态由重载后的规则决定，因此恢复到 `auto` 且持久规则含危险 allow 时，最终 stash 必须重新包含该规则，visible allows 不包含它。

## 9. Config、prompt、audit、并发与 retry

不能用一条 `policy > CLI > ...` 同时解释不同决策域；以下四组 precedence 相互独立。

### 9.1 Permission rule source precedence

规则先按安全行为合并：任一来源的 hard deny 高于任一 explicit ask，任一 explicit ask 高于 allow，来源优先级不能把 deny/ask 降级。行为相同且 normalized scope 重叠时，权威 provenance 顺序为 `policySettings > flagSettings > command > session > localSettings > projectSettings > userSettings`。`flagSettings` 作为用户直接提供的 CLI 规则来源采用；`cliArg` 只表示启动 mode flag，不是规则来源；`sdkSettings` 本期舍弃，因为 MiCode 没有可信 SDK 配置边界。

### 9.2 Startup/default mode precedence

先求 requested startup mode：显式 CLI `--permission-mode` > 已清洗且允许恢复的 resumed session mode > `userSettings.defaultMode` > 内置 `build`。`projectSettings`、`localSettings`、rule `command/session` 不选择启动默认模式；它们只贡献各自允许的规则或运行时更新。

### 9.3 Policy restriction/gate precedence

requested mode 求出后再依次经过 compiled/runtime capability gate、managed policy restriction、environment/remote/headless restriction。gate 只能拒绝或降级，不能授予更高权限。启动时请求非法或不允许的 `auto`，回退 `build` 并审计；运行时切换被拒绝时，当前 mode 保持不变。managed policy 的 deny/restriction 不得被 CLI、resume 或 settings 覆盖。

### 9.4 Classifier config trusted sources

classifier control-plane rules 与显式 `classifierModel` 只采用 `policySettings`、`userSettings`、`localSettings` 与用户直接传入的 `flagSettings`，按 `userSettings -> localSettings -> flagSettings -> policySettings` 的稳定 section 顺序投影，且组织 policy section 不可被替换。`projectSettings`、`command`、`session`、tool/file/MCP 内容均排除；`cliArg` 仅用于 mode，不携带 classifier prompt/model；`sdkSettings` 本期明确 `DROP-DEFER`，不建立尚不存在的 SDK trust boundary。配置规则是 control plane，不会把被排除的 runtime 内容重新引入 classifier input。

其余设计：

- 模式切换：slash command、TAB cycle、plan approval 共用 `transitionPermissionMode()`，由它产生 `PermissionUpdate`；UI/config 是 observer。
- 配置：扩展现有 `ConfigStore`；session destination 不写盘，settings destination 原子写。未知字段保留，JSON 错误保留 last-known-good，undefined 表示删除。
- prompt：模式不改变 static system prompt；`auto_mode_exit` 是 dynamic attachment，每 session transition 最多一个。
- audit：只记录 decision ID、canonical tool、behavior、reason code、source、latency bucket；禁止 command、raw path、file content、classifier prompt。
- 并发：复用 `StreamingToolExecutor`；barrier 证明只读并行、写工具独占、输出保序。mode 不改变 concurrency classification；只有 `run_bash` execution failure abort 未完成 sibling，其他 unsafe tool failure 只记录自身。
- retry：只用于 API/classifier，不用于 tool executor。base delay cap 是 32 秒，jitter 后最终小于 40 秒。

## 10. A1-A88 的 MiCode 重定义

未列出的 A 编号沿用 reference 的行为意图，但证明必须来自 MiCode implementation plan 正文中的具体测试。以下编号以本节定义覆盖 reference 的歧义或不适合 MiCode 宿主的表达：

| ID | MiCode 权威定义 | 相对 reference 的差异/澄清 |
|---|---|---|
| A6 | 具体 MCP tool rule 只 exact；仅 server-level 或 `*` 匹配整 server；server 名支持 `_` | 禁止具体 tool prefix 扩权 |
| A11 | 先返回已命中的 deny/explicit ask；仅 too-complex 且无强规则命中时 ask | 明确禁止 deny -> ask 降级 |
| A17 | 进入 auto 时危险 allow 被分区到 session stash | stash 属于 SessionState |
| A18 | 退出只恢复退出时仍在当前逻辑 stash 的规则 | 不恢复已删除/替换规则 |
| A21 | resume 先清 auto denial、stash、attachment pending，再重载并重新分区持久规则；auto 下持久危险 allow 最终重新进入 stash | 区分瞬态清理与稳定 reload 状态 |
| A24 | resolver 的 canonical exact safe allowlist 命中后直接 allow 且 classifier 零调用；canonical `run_bash` 的 unresolved ask 禁止由 acceptEdits simulation 自动解决，必须进入 classifier；classifier 不实现 allowlist，也不实现 run_bash fast-path；**enforced authority 下 §6.4 三锚点不变量**：executeToolCall 的 authority-aware routing 对 enforced+auto+run_bash allow 降级为 ask（reason_code `permission.auto_run_bash_requires_classifier`，checker 本体不改）、resolver 第 8 步短路直进 classifier、executeToolCall 的 sessionAllowlist/subagent rewrite 对 enforced+auto+run_bash 失效——三者共同保证 enforced + auto + canonical `run_bash` 除同步最终 deny 外必经 classifier | allowlist 唯一真相源属 resolver；run_bash classifier 强制不变量由 executeToolCall authority-routing（enforced gating）+ resolver + executeToolCall rewrite 守卫共同保证，是 gate 前 effectiveDecision 事实而非 checker 内部顺序；PermissionChecker 保持 authority-neutral |
| A25 | CWD write fast-path 必须以 `evaluationMode: 'acceptEdits'` 求值且 classifier 零调用 | `build` 不能代替 acceptEdits |
| A27 | non-classifierApprovable 在 allowlist/simulation/classifier 前停止；主会话 ask，headless hooks -> deny | 明确最高前置优先级 |
| A28 | 任一阶段的 model unavailable/timeout/provider/input-limit/parse/protocol failure 全部 deny；已绑定模型失败时禁止跨模型重判 | classifier fail-closed 且不经 Agent 解释错误 |
| A29 | Stage 1 `FLAG` 是唯一 Stage 2 入口；Stage 1 `ALLOW` 直接 allow 且 Stage 2 零调用；Stage 2 默认复用已绑定模型；classifier 不返回 ask | 用两阶段内部升级替代 ambiguous/transcript fallback |
| A32 | add/remove/replace/reload 同步更新 visible rules 与 stash，禁止权限复活 | stash 是当前逻辑状态 |
| A39 | fork 复制规则值但独立持有 denial/stash 引用 | 消除跨 session 全局状态 |
| A59 | base delay 最大 32000ms，jitter 后范围 `[32000, 40000)`，Retry-After 优先 | cap 指 base 而非 final delay |
| A64 | session rotate/resume 先清所有 auto 瞬态状态；持久规则 reload/repartition 后形成稳定状态，危险 allow 在 auto 下重新进入 stash | 与 SessionState 生命周期及持久规则对齐 |
| A73 | legacy build/plan/config 与两条 provider 执行路径都经过同一 gate | MiCode 宿主兼容定义 |
| A77 | auto 修改受保护设置先返回 classifierApprovable safety ask，再由 classifier 决定 | 不进入 non-approvable fast-path |
| A78 | bypass 修改受保护设置仍 ask | bypass 不覆盖 safety |
| A79 | 只有可信 user/local/直接 CLI flag/policy 规则可影响 classifier prompt；project/command/session/cliArg/SDK/tool/file/MCP 不可 | 明确 transcript/config 双信任边界与 SDK defer |
| A80 | 非空可信 user rules replace 默认规则段；空段回退默认；组织规则位置固定 | 不做普通字符串拼接 |
| A84 | mock 必须覆盖 Stage 1 ALLOW、FLAG -> Stage 2 ALLOW/DENY，以及两阶段 failure -> deny；同时断言非消息化和调用次数 | 以 provider RPC 状态机替代普通 classifier outcome 表 |
| A85 | shadow 记录 candidate 差异但返回 legacy authoritative decision；candidate 故障不能放行 | MiCode cutover 语义 |
| A88 | `SessionState.transitionTo()` 清 allowlist、denial、stash、attachment debounce；同 session no-op | 统一 reset hook |

## 11. 验证原则

1. A1-A88 matrix 只是“编号 -> task -> test 名”的覆盖索引，不参与运行时证明。
2. 每个编号必须在 implementation plan 正文出现一个具体测试名和至少一个行为断言。
3. 并发测试使用 deferred/barrier，不用 wall-clock 阈值证明并行。
4. MCP 测试必须同时断言 exact、server wildcard、跨 server 隔离、server 名含 `_`。
5. resolver 测试必须断言调用顺序与调用次数，尤其 safety 早退后三个自动路径均为 0 次。
5a. canonical `run_bash` 的 unresolved auto ask 集成测试必须使用真实 `PermissionChecker` + 真实 `DefaultPermissionAskResolver`，禁止以 resolver stub 伪造 `evaluateWithMode` 对 `run_bash` 的返回。必须断言：(a) acceptEdits 不提前完成授权（classifier ≥ 1 call）；(b) classifier `ALLOW` 后 gate/executor 各 1；(c) classifier `DENY` 时 executor 0；(d) `write_file`/`edit_file` 等非 `run_bash` 写工具的 acceptEdits fast-path 未被本次修复误删。测试必须包含一个 sanity 断言，证明真实 `checkWithEvaluationMode('run_bash', …, 'acceptEdits')` 当前确实返回 `allow`，以防止未来用 stub 把根因行为重新伪造掉。
5b. §6.4 三锚点不变量的生产链集成测试必须证明"enforced + auto + canonical run_bash 除同步最终 deny 外必经 classifier"，且覆盖 checker 之外的 bypass 点。必须使用真实 `PermissionChecker`（注入持久 `run_bash` allow 规则）、真实 `DefaultPermissionAskResolver`、真实 `executeToolCall`（`runtime.authority==='enforced'`）、真实 `RuntimeSecurityGate`、classifier spy 与 executor spy。至少证明以下路径：
    - **路径 1（persistent allow rule）**：checker §5 第 8 步命中 `run_bash: <cmd>` allow 规则返回 allow → executeToolCall authority-routing 降级为 `auto_run_bash_requires_classifier` ask → classifier=1 call，classifier ALLOW 后 gate/executor 各 1，classifier DENY 时 executor 0；
    - **路径 2（sessionAllowlist 命中）**：预先在 sessionAllowlist 写入 `run_bash` exact match → 执行同命令 → classifier=1 call（rewriteToAllow 被守卫拦），executor 只在 classifier ALLOW 后 1 次；
    - **路径 3（subagent origin）**：enforced authority 下 origin=subagent 的 run_bash → 共享 parent `askResolver`（A35）→ classifier=1 call，executor 只在 ALLOW 后 1 次；
    - **路径 4（同步 deny 优先）**：checker §5 第 2-6 步对 run_bash 命中 deny → classifier=0 calls，gate 直接 denied，executor 0；
    - **回归**：build 模式下相同 `run_bash` allow 规则仍直接 allow（classifier=0），证明降级只在 enforced+auto 生效；
    - **legacy 不受影响**：authority=legacy 时 run_bash allow rule 直接执行（classifier=0，executor=1），行为与修复前一致；
    - **shadow 不受影响**：authority=shadow 时 checker allow → resolver 不触发（checker 返回 allow 非 ask）→ candidate classifier 不跑 → executor=1，legacy authoritative 语义不变（A85）。
    测试不得用对 `run_bash` 返回 ask 的 evaluateWithMode stub、不得用绕过真实 `executeToolCall` authority-routing 的 resolver-only stub。三锚点必须同时被同一组真实生产路径覆盖，否则任一锚点单独被破坏都无法被测试捕获。legacy/shadow 回归在 RED 阶段必须 PASS（证明修复前行为正确）。
6. classifier 测试必须直接覆盖：无 authentic user input -> provider 零调用并 deny；Stage 1 ALLOW -> Stage 2 零调用；FLAG -> Stage 2；任一 failure -> deny。
7. 多 tool-call 测试必须证明同一 assistant turn 的每个 executable call 分别投影、分别裁决、分别等待 gate；输入结构只含当前 `executableToolCall`，不含第二个 tool call，也不共享 decision。
8. model policy 测试必须覆盖：显式模型不替换；无显式模型时 fast advisory -> 主模型 fallback；请求绑定后 failure 不跨模型重判；Stage 2 默认与 Stage 1 模型相同。
9. classifier 集成测试必须证明 provider 路径未构造 Agent/tool registry/`streamingQuery`，不产生 assistant/thinking/tool_result/TUI 事件，且 gate 在裁决完成前零调用。
10. provider capability 测试必须证明声明来自静态 adapter/config，unknown -> unsupported，省略 hint 不触发探测 RPC；支持与不支持 hints 的权限结果协议相同。
11. Stage 1 协议测试必须只接受无额外文本的单个 `ALLOW | FLAG` 枚举，不对 tokenizer token 数或字节数作跨 provider 断言。
12. resume 测试必须分别观察瞬态清空与持久规则 reload/repartition 后的稳定 stash。
13. retry 测试通过注入 random/timer 确定性验证 base cap、jitter 和 Retry-After。
14. implementation plan 不包含修改 reference spec 的任务；本文是唯一 MiCode 设计输入。

## 12. 实现门禁

本设计和配套 implementation plan 审核通过前，不修改生产代码。执行阶段继续遵循现有宿主集成、单一 `applyPermissionUpdate`、SessionState、barrier 并发测试与 retry base cap 设计。
