# Auto 权限模式宿主集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/auto-mode/mi-code-auto-permission-design.md` 在 MiCode 现有权限链中实现安全 auto 模式，并以 A1-A88 对应的具体行为测试证明完成。

**Architecture:** 保留现有宿主并固定 `PermissionChecker -> PermissionAskResolver -> PermissionClassifier -> RuntimeSecurityGate -> executor`。resolver 仅在本地规则与 fast-path 未解决 ask 时调用独立 classifier；classifier 通过 provider-neutral 直接 RPC 完成两阶段 allow/deny 裁决，不进入 Agent、tool 或正常消息链。

**Tech Stack:** Node.js >= 18、ESM、TypeScript strict/NodeNext、Vitest；复用现有手写 schema 校验、`fs`、`crypto`、provider client 和 Zustand store，不新增运行时依赖。

## Global Constraints

- 权威设计是 `docs/auto-mode/mi-code-auto-permission-design.md`；`docs/auto-mode/auto-mode-spec.md` 是只读 reference，执行本计划不得修改。
- 不创建平行 `src/permissions/*`、第二个 executor、第二个 settings store 或第二个权限 checker。
- 用户模式保持 `build | plan | auto`；内部 fast-path 必须使用 `evaluationMode: 'acceptEdits'`，禁止用 `build` 代替。
- AST too-complex 必须先尊重 tool/raw deny 与 explicit ask；没有强规则命中才返回 ask。
- non-classifierApprovable safety 必须在 allowlist、acceptEdits simulation、classifier 之前结束自动路径。
- classifier 输入固定为 authentic user-authored messages + 当前一个 executable tool call；assistant/thinking/tool output/file/MCP/hook/system/agent/其他 tool call 全部排除。
- classifier 最终只返回 allow/deny。Stage 1 只接受无额外文本的单个 `ALLOW | FLAG`；Stage 2 只接受 `ALLOW | DENY`；任一 provider/timeout/input-limit/parse/protocol failure 都 deny。
- classifier 必须直接调用底层 provider client；禁止经过 Agent、subagent、tool registry、`streamingQuery`、正常 message history 或 TUI pipeline。
- 显式 `classifierModel` 必须绑定使用且失败不 fallback；未显式配置时 fast model 仅作静态 advisory，不能预选则用 session 主模型。一次裁决绑定后禁止跨模型重判，Stage 2 默认复用 Stage 1 模型。
- provider capability 只来自 adapter/已有 config 静态声明；unknown 为 unsupported，不发 discovery RPC。unsupported hint 省略且不改变权限协议。
- MCP 具体 tool rule 只 exact；只有 server-level 与 `*` rule 匹配整 server；server 名支持单下划线 `_`。
- 所有规则/模式变化只调用 `applyPermissionUpdate()`；auto 瞬态状态只属于 `SessionState`。
- auto safe allowlist 的唯一常量与 fast-path 位于 resolver；classifier 禁止复制 allowlist 或实现等价 fast-path。
- dangerous stash 只依赖架构定义的 `isDangerousAllowRule()`；禁止在状态或配置层复制危险命令判定。
- permission rule、startup/default mode、policy restriction/gate、classifier config 分别实现各自 precedence；`flagSettings` 按设计采用，`sdkSettings` 本期舍弃。
- A1-A88 矩阵只是覆盖索引。行为通过必须由任务正文中具名测试的真实断言证明。
- 每个任务执行 RED -> GREEN -> REFACTOR，并在任务结束运行指定的现有回归测试。

---

## Wheel Reuse Check

| Existing component | Reuse decision |
|---|---|
| `src/permission/checker.ts` | 同步强约束与规则判定，移除 auto 无条件 allow |
| `src/permission/command-policy.ts`、`bash-paths.ts` | 复用 Bash 结构与路径解析 |
| `src/permission/decisions.ts` | 复用 `SecurityDecision`、reason code、provenance |
| `src/permission/runtime-gate.ts` | 保持唯一 authorize/execute 出口 |
| `src/permission/session-state.ts`、`session-allowlist.ts` | 扩展 auto 瞬态状态与 remember 生命周期 |
| `src/agent/tool-execution.ts` | Core Anchor 接线点 |
| `src/agent/*-stream-client.ts` | 复用底层 provider client 的直接 text RPC；classifier 不调用 `streamingQuery` |
| `src/agent/streaming-executor.ts` | 并发、独占、保序与错误级联 |
| `src/config/schema.ts`、`store.ts` | 配置源、兼容读取与原子写盘 |
| `src/agent/backoff.ts`、`streaming-query.ts`、`loop.ts` | API/classifier retry；工具 executor 不重试 |
| `src/agent/prompt/*`、`observability/*` | prompt plane、attachment 与脱敏审计 |

## Core Interfaces

```ts
export interface PermissionAskResolutionRequest {
  readonly decision: SecurityDecision
  readonly executableToolCall: ExecutableToolCall
  readonly messages: readonly Message[]
  readonly origin: 'main' | 'subagent'
  readonly permissionContext: ToolPermissionContext
  readonly registerAbort?: (abort: () => void) => void
}

export interface PermissionAskResolver {
  resolve(request: PermissionAskResolutionRequest): Promise<SecurityDecision>
}

export interface PendingAutomaticDecision {
  readonly promise: Promise<SecurityDecision>
  readonly abort: () => void
}

export interface PermissionEvaluationContext extends ToolPermissionContext {
  readonly evaluationMode: PermissionEvaluationMode
}
```

生产数据流固定为：

```text
PermissionChecker
  -> PermissionAskResolver
  -> PermissionClassifier（仅 unresolved ask；本地解决时零调用）
  -> RuntimeSecurityGate
  -> executor
```

## File Map

**Modify:**

- `src/permission/types.ts`, `patterns.ts`, `checker.ts`, `command-policy.ts`, `decisions.ts`, `index.ts`
- `src/permission/session-state.ts`, `session-allowlist.ts`, `runtime-gate.ts`, `subagent-silent-policy.ts`
- `src/agent/types.ts`, `tool-execution.ts`, `streaming-executor.ts`, `subagent.ts`, `llm-vercel.ts`
- `src/agent/anthropic-stream-client.ts`, `openai-stream-client.ts`, `google-stream-client.ts`
- `src/agent/backoff.ts`, `streaming-query.ts`, `loop.ts`
- `src/config/schema.ts`, `store.ts`
- `src/commands/executor.ts`, `src/plan/plan-approval-transition.ts`, `src/index.ts`
- `src/agent/prompt/registry.ts`, `resolution.ts`, `src/agent/observability/decision-trace.ts`

**Create:**

- `src/permission/rules.ts`
- `src/permission/permission-updates.ts`
- `src/permission/denial-tracker.ts`
- `src/permission/classifier-input.ts`
- `src/permission/classifier-prompt.ts`
- `src/permission/classifier-provider.ts`
- `src/permission/classifier-model-policy.ts`
- `src/permission/classifier.ts`
- `src/permission/permission-request-hooks.ts`
- `src/permission/ask-resolver.ts`
- `src/permission/audit.ts`
- `src/config/permission-sources.ts`

---

### Task 1: Canonical 规则与 MCP 匹配（A1-A8、A82）

**Files:**

- Create: `src/permission/rules.ts`
- Modify: `src/permission/types.ts`
- Modify: `src/permission/patterns.ts`
- Modify: `src/permission/checker.ts`
- Modify: `src/permission/index.ts`
- Test: `src/__tests__/permission/permission-rules.test.ts`

**Interfaces:**

- Produces: `parsePermissionRule()`、`serializePermissionRule()`、`matchWildcardPattern()`、`normalizePermissionToolName()`、`parseMcpToolId()`、`toolMatchesRule()`、`detectUnreachableRules()`。
- Fixture helpers: `rule(content)` 构造 `run_bash` content rule；`mcpRule(name)` 构造 tool-level MCP rule。

- [ ] **Step 1: 写 A1-A8、A82 的失败测试**

```ts
describe('canonical permission rules', () => {
  test('[A1] distinguishes exact, legacy prefix and wildcard', () => {
    expect(parsePermissionRule('git status')).toEqual({ type: 'exact', command: 'git status' })
    expect(parsePermissionRule('npm:*')).toEqual({ type: 'prefix', prefix: 'npm' })
    expect(parsePermissionRule('git *')).toEqual({ type: 'wildcard', pattern: 'git *' })
  })

  test('[A2] a single trailing wildcard makes arguments optional', () => {
    expect(matchWildcardPattern('git *', 'git')).toBe(true)
    expect(matchWildcardPattern('git *', 'git status')).toBe(true)
  })

  test('[A3] escaped star remains literal', () => {
    expect(matchWildcardPattern('echo \\*', 'echo *')).toBe(true)
    expect(matchWildcardPattern('echo \\*', 'echo anything')).toBe(false)
  })

  test('[A4] multiple wildcards do not make the tail optional', () => {
    expect(matchWildcardPattern('* run *', 'npm run')).toBe(false)
    expect(matchWildcardPattern('* run *', 'npm run test')).toBe(true)
  })

  test('[A5] wildcard uses dotAll for heredoc content', () => {
    expect(matchWildcardPattern('cat *', 'cat <<EOF\nline\nEOF')).toBe(true)
  })

  test('[A6] concrete MCP tools are exact; server rules support underscores', () => {
    expect(toolMatchesRule('mcp__server_one__tool_a', mcpRule('mcp__server_one__tool_a'))).toBe(true)
    expect(toolMatchesRule('mcp__server_one__tool_b', mcpRule('mcp__server_one__tool_a'))).toBe(false)
    expect(toolMatchesRule('mcp__server_one__tool_b', mcpRule('mcp__server_one'))).toBe(true)
    expect(toolMatchesRule('mcp__server_one__tool_b', mcpRule('mcp__server_one__*'))).toBe(true)
    expect(toolMatchesRule('mcp__server_two__tool_b', mcpRule('mcp__server_one'))).toBe(false)
  })

  test('[A7] reports tool-level deny/ask shadowing content allow', () => {
    expect(detectUnreachableRules(contextWith(
      denyRule('run_bash'), allowRule('run_bash', 'git *'),
    ))).toEqual([expect.objectContaining({ shadowType: 'deny', fix: expect.any(String) })])
    expect(detectUnreachableRules(contextWith(
      sharedAskRule('run_bash'), allowRule('run_bash', 'git *'),
    ))).toEqual([expect.objectContaining({ shadowType: 'ask' })])
  })

  test('[A8] escape/parse/serialize and legacy aliases roundtrip', () => {
    const original = { toolName: 'Task', ruleContent: String.raw`echo \\(x\\) \\*` }
    const serialized = serializePermissionRule(original)
    expect(parseToolRule(serialized)).toEqual({ ...original, toolName: 'spawn_agent' })
  })

  test('[A82] wildcard regression corpus has no mismatches', () => {
    for (const sample of WILDCARD_CORPUS) {
      expect(matchWildcardPattern(sample.pattern, sample.command, sample.caseInsensitive), sample.id)
        .toBe(sample.expected)
    }
  })
})
```

- [ ] **Step 2: 运行测试确认目标行为缺失**

Run: `npx vitest run src/__tests__/permission/permission-rules.test.ts`

Expected: FAIL；至少 A6 的具体 tool exact/server underscore 行为缺失。

- [ ] **Step 3: 实现规则单一真相源**

```ts
export function parseMcpToolId(name: string):
  | { kind: 'server'; server: string }
  | { kind: 'serverWildcard'; server: string }
  | { kind: 'tool'; server: string; tool: string }
  | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const separator = rest.indexOf('__')
  if (separator < 0) return rest ? { kind: 'server', server: rest } : null
  const server = rest.slice(0, separator)
  const tool = rest.slice(separator + 2)
  if (!server || !tool) return null
  return tool === '*' ? { kind: 'serverWildcard', server } : { kind: 'tool', server, tool }
}

export function toolMatchesRule(toolName: string, rule: PermissionRule): boolean {
  const tool = normalizePermissionToolName(toolName)
  const ruleName = normalizePermissionToolName(rule.ruleValue.toolName)
  if (tool === ruleName) return true
  const parsedRule = parseMcpToolId(ruleName)
  const parsedTool = parseMcpToolId(tool)
  if (!parsedRule || !parsedTool || parsedTool.kind !== 'tool') return false
  return (parsedRule.kind === 'server' || parsedRule.kind === 'serverWildcard')
    && parsedRule.server === parsedTool.server
}
```

通配按 escape sentinel -> regex escape -> wildcard expansion -> sentinel restore -> optional single tail -> `s`/optional `i` 的固定顺序实现。现有 `patterns.ts` 委托 `rules.ts`，不保留旧分支。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/permission-rules.test.ts src/__tests__/permission.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/permission src/__tests__/permission/permission-rules.test.ts
git commit -m "feat: unify canonical permission rules"
```

---

### Task 2: 单一 PermissionUpdate 与 SessionState（A17-A19、A32、A64、A88）

**Files:**

- Create: `src/permission/permission-updates.ts`
- Modify: `src/permission/session-state.ts`
- Modify: `src/permission/session-allowlist.ts`
- Modify: `src/permission/checker.ts`
- Test: `src/__tests__/permission/auto-session-state.test.ts`

**Interfaces:**

- Produces: `applyPermissionUpdate(snapshot, update)`、`isDangerousAllowRule(rule)`、`partitionDangerousAllows()`、`SessionState.permissionSnapshot`、`SessionState.denialState`、`SessionState.transitionTo()`。

- [ ] **Step 1: 写具体失败测试**

```ts
describe('auto permission session state', () => {
  test('isDangerousAllowRule covers canonical aliases, Bash breadth and wildcards', () => {
    expect(isDangerousAllowRule(allowRule('*'))).toBe(true)
    for (const alias of ['spawn_agent', 'Task', 'Agent', 'AgentTool']) {
      expect(isDangerousAllowRule(allowRule(alias))).toBe(true)
    }
    expect(isDangerousAllowRule(allowRule('run_bash'))).toBe(true)
    expect(isDangerousAllowRule(allowRule('run_bash', '*'))).toBe(true)
    expect(isDangerousAllowRule(allowRule('run_bash', 'git:*'))).toBe(true)
    expect(isDangerousAllowRule(allowRule('run_bash', 'printf \\*'))).toBe(false)
    for (const command of ['API_KEY=x bash -lc true', 'PYTHON.EXE -c pass', 'npx eslint .', 'docker run image']) {
      expect(isDangerousAllowRule(allowRule('run_bash', command)), command).toBe(true)
    }
    expect(isDangerousAllowRule(allowRule('run_bash', 'git status'))).toBe(false)
    expect(isDangerousAllowRule(allowRule('read_file', 'src/a.ts'))).toBe(false)
  })

  test('[A17] entering auto strips dangerous allows into session stash', () => {
    const next = applyPermissionUpdate(contextWith(dangerousBashAllow()), setMode('auto'))
    expect(visibleAllowRules(next)).not.toContainEqual(dangerousBashAllow())
    expect(next.strippedDangerousRules).toEqual([dangerousBashAllow()])
  })

  test('[A18] exit restores only rules still present in current stash', () => {
    const entered = applyPermissionUpdate(contextWith(dangerousBashAllow()), setMode('auto'))
    const removed = applyPermissionUpdate(entered, removeAllow(dangerousBashAllow()))
    const exited = applyPermissionUpdate(removed, setMode('build'))
    expect(visibleAllowRules(exited)).not.toContainEqual(dangerousBashAllow())
    expect(exited.strippedDangerousRules).toEqual([])
  })

  test('[A19] same-mode transition preserves snapshot identity and emits no effects', () => {
    const state = makeSessionState({ mode: 'auto' })
    expect(state.transitionPermissionMode('auto')).toEqual({ snapshot: state.permissionSnapshot, effects: [] })
  })

  test('[A32] add/remove/replace/reload update visible rules and stash together', () => {
    const state = makeSessionState({ mode: 'auto' })
    state.apply(addAllow(dangerousBashAllow()))
    expect(state.permissionSnapshot.strippedDangerousRules).toContainEqual(dangerousBashAllow())
    state.apply(replaceAllows([safeReadAllow()]))
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([])
    state.reloadPermissionRules([dangerousBashAllow()])
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([dangerousBashAllow()])
  })

  test('[A64] resume clears transient state then repartitions persisted dangerous rules', () => {
    const state = populatedAutoSession()
    const persisted = [dangerousBashAllow()]
    state.transitionTo('resumed-session')
    expect(state.denialState).toEqual({ consecutive: 0, total: 0 })
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([])
    expect(state.takeAttachments()).toEqual([])
    state.reloadPermissionRules(persisted)
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual(persisted)
    expect(visibleAllowRules(state.permissionSnapshot)).not.toContainEqual(dangerousBashAllow())
  })

  test('[A88] transitionTo clears every session cache; same id is a no-op', () => {
    const state = populatedAutoSession('s1')
    state.transitionTo('s1')
    expect(state.sessionAllowlist.size).toBeGreaterThan(0)
    state.transitionTo('s2')
    expect(state.sessionAllowlist.size).toBe(0)
    expect(state.denialState).toEqual({ consecutive: 0, total: 0 })
    expect(state.permissionSnapshot.strippedDangerousRules).toEqual([])
    expect(state.exitAttachmentPending).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-session-state.test.ts`

Expected: FAIL；当前 `SessionState` 只有 session ID 与 allowlist。

- [ ] **Step 3: 实现唯一状态变换**

`isDangerousAllowRule()` 先 canonicalize alias，再按架构中的裸/wildcard/interpreter/runner 完整表判定。`partitionDangerousAllows()` 与 `applyPermissionUpdate()` 只能调用该函数，不能另设正则、命令表或例外。`applyPermissionUpdate()` 深复制输入；auto 中新增危险 allow 进入 stash；remove 同时删 visible/stash；replace 先清目标 behavior 的两处状态再重新分区；reload 走 replace；退出合并当前 stash。返回快照冻结。`SessionState` 只能调用该函数，不内嵌规则变换。resume 先由 `transitionTo()` 清瞬态，再用 reload/repartition 建立持久规则稳定态。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-session-state.test.ts src/__tests__/permission/session-state.test.ts src/__tests__/permission/session-allowlist-lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/permission src/__tests__/permission/auto-session-state.test.ts
git commit -m "feat: add authoritative permission session state"
```

---

### Task 3: 同步强约束与 Bash AST 管道（A9-A16）

**Files:**

- Modify: `src/permission/checker.ts`
- Modify: `src/permission/command-policy.ts`
- Modify: `src/permission/bash-paths.ts`
- Modify: `src/agent/dispatch-map.ts`
- Test: `src/__tests__/permission/auto-pipeline.test.ts`
- Test: `src/__tests__/permission/command-structural-parse.test.ts`
- Test: `src/__tests__/regression/permission-executor-integration.test.ts`

**Interfaces:**

- Produces: `PermissionChecker.checkWithEvaluationMode(tool, input, evaluationMode)`；结果域 `allow|deny|ask|passthrough`。
- Fixed order: tool/raw strong rules -> parsed subcommand strong rules -> raw-input-determinable safety/requiresInteraction -> too-complex fallback -> discretionary allow -> ordinary allow -> ask。

- [ ] **Step 1: 写 A9-A16 失败测试**

```ts
describe('synchronous permission pipeline', () => {
  test('[A9] deny wins for an in-workspace action', () => {
    expect(autoChecker({ deny: ['write_file(src/**)'] }).check('write_file', { path: 'src/a.ts' }).behavior)
      .toBe('deny')
  })

  test('[A10] a denied compound subcommand denies the whole command', () => {
    expect(autoChecker({ deny: ['run_bash(git push *)'] })
      .check('run_bash', { command: 'pwd && git push origin main' }).behavior).toBe('deny')
  })

  test('[A11] too-complex preserves raw deny/ask before conservative ask', () => {
    expect(checkerWithRawDeny('run_bash(git push *)').check('run_bash', { command: 'git push $(target)' }).behavior)
      .toBe('deny')
    expect(checkerWithRawAsk('run_bash(git push *)').check('run_bash', { command: 'git push $(target)' }).behavior)
      .toBe('ask')
    expect(autoChecker().check('run_bash', { command: 'echo $(dynamic)' }).behavior)
      .toBe('ask')
  })

  test('[A11] raw-input safety and interaction requirements run before too-complex fallback', () => {
    const input = { command: 'echo $(dynamic)' }
    expect(checkerWithRawSafetyDeny().check('run_bash', input).behavior).toBe('deny')
    expect(checkerWithRequiresInteraction().check('run_bash', input).behavior).toBe('ask')
  })

  test('[A12] bypass cannot approve protected settings', () => {
    expect(checker().checkWithEvaluationMode('write_file', { path: '.git/config' }, 'bypassPermissions').behavior)
      .toBe('ask')
  })

  test('[A13] bypass cannot override explicit content ask', () => {
    expect(checkerWithRawAsk('run_bash(npm publish *)')
      .checkWithEvaluationMode('run_bash', { command: 'npm publish pkg' }, 'bypassPermissions').behavior)
      .toBe('ask')
  })

  test('[A14] requiresUserInteraction remains ask in every evaluation mode', () => {
    for (const mode of ['build', 'auto', 'acceptEdits', 'bypassPermissions'] as const) {
      expect(checker().checkWithEvaluationMode('ask_user_question', {}, mode).behavior).toBe('ask')
    }
  })

  test('[A15] unresolved write becomes ask', () => {
    expect(buildChecker().check('write_file', { path: 'src/a.ts' }).behavior).toBe('ask')
  })

  test('[A16] real read-only Bash reaches the registered executor', async () => {
    const executor = vi.fn().mockResolvedValue('clean')
    const result = await executeToolCall(registryWithRunBash(executor), bashCall('git status --short'), allowedRuntime())
    expect(result).toMatchObject({ status: 'success', output: 'clean' })
    expect(executor).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-pipeline.test.ts src/__tests__/permission/command-structural-parse.test.ts`

Expected: FAIL；当前 auto 模式无条件 allow，too-complex 顺序也未由测试锁定。

- [ ] **Step 3: 修改现有 checker**

删除 auto 无条件 allow。结构解析返回 `{ kind: 'parsed', subcommands } | { kind: 'too-complex' }`。实现顺序固定为 tool/raw strong rules -> parsed subcommand strong rules -> raw-input-determinable safety/requiresInteraction -> too-complex fallback -> discretionary allow -> ordinary allow -> ask。too-complex 只有在强规则与可由 raw input 确定的 safety/interaction 都未命中时才返回 ask；不得在 safety 前早退。任何 deny 直接终止，不能被后续 ask/mode 改写。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-pipeline.test.ts src/__tests__/permission/command-policy-enforced.test.ts src/__tests__/regression/permission-executor-integration.test.ts`

Expected: PASS；deny 路径 executor 调用次数为 0。

- [ ] **Step 5: Commit**

```bash
git add src/permission src/agent/dispatch-map.ts src/__tests__/permission src/__tests__/regression/permission-executor-integration.test.ts
git commit -m "feat: enforce strong rules before auto evaluation"
```

---

### Task 4: Denial 与独立两阶段 PermissionClassifier（A28-A31、A33、A81、A84）

**Files:**

- Create: `src/permission/denial-tracker.ts`
- Create: `src/permission/classifier-input.ts`
- Create: `src/permission/classifier-prompt.ts`
- Create: `src/permission/classifier-provider.ts`
- Create: `src/permission/classifier-model-policy.ts`
- Create: `src/permission/classifier.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/anthropic-stream-client.ts`
- Modify: `src/agent/openai-stream-client.ts`
- Modify: `src/agent/google-stream-client.ts`
- Test: `src/__tests__/permission/auto-classifier-input.test.ts`
- Test: `src/__tests__/permission/auto-classifier-model-policy.test.ts`
- Test: `src/__tests__/permission/auto-classifier-provider.test.ts`
- Test: `src/__tests__/permission/auto-classifier.test.ts`

**Interfaces:**

```ts
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

export interface PermissionClassifierInput {
  readonly authenticUserMessages: readonly AuthenticUserMessage[]
  readonly executableToolCall: ExecutableToolCall
}

export interface ModelRef {
  readonly providerId: string
  readonly modelId: string
}

export interface ClassifierProviderCapabilities {
  readonly reasoningControl: boolean
  readonly minimumOutputTokens?: number
  readonly decodingControl: boolean
  readonly promptCache: boolean
}

export interface ClassifierProviderRequest {
  readonly stage: 1 | 2
  readonly model: ModelRef
  readonly prefix: string
  readonly instruction: string
  readonly signal: AbortSignal
  readonly reasoning?: 'disabled' | 'enabled'
  readonly maxOutputTokens?: number
  readonly temperature?: 0
}

export interface PermissionClassifierProvider {
  readonly capabilities: ClassifierProviderCapabilities
  invoke(request: ClassifierProviderRequest): Promise<unknown>
}

export interface ClassifierModelContext {
  readonly classifierModel?: ModelRef
  readonly providerFastClassifierModel?: ModelRef
  readonly staticallySelectableModels: readonly ModelRef[]
  readonly sessionMainModel: ModelRef
}

export interface ClassifierModelPolicy {
  selectStage1(context: ClassifierModelContext): ModelRef
  selectStage2(context: ClassifierModelContext, stage1Model: ModelRef): ModelRef
}

export type ClassifierDecision = Extract<SecurityDecision, { behavior: 'allow' | 'deny' }>

export interface PermissionClassifier {
  classify(input: PermissionClassifierInput, signal: AbortSignal): Promise<ClassifierDecision>
}

export interface DirectProviderTextRequest {
  readonly model: ModelRef
  readonly systemPrompt: string
  readonly prompt: string
  readonly signal: AbortSignal
  readonly reasoning?: 'disabled' | 'enabled'
  readonly maxOutputTokens?: number
  readonly temperature?: 0
}

export interface DirectProviderTextClient {
  completeText(request: DirectProviderTextRequest): Promise<string>
}
```

- `classifier-input.ts` 只产出 `projectPermissionClassifierInput(messages, executableToolCall): PermissionClassifierInput`；输入类型没有第二个 tool-call 字段或多调用关联算法。
- `classifier-prompt.ts` 产出不可变 `buildClassifierPromptPrefix()`、`renderClassifierRuleSections()`、`STAGE1_INSTRUCTION`、`STAGE2_INSTRUCTION`。
- `classifier-provider.ts` 产出 `buildClassifierProviderRequest()`、`unsupportedClassifierCapabilities()` 与 direct-RPC `PermissionClassifierProvider`；不导入 Agent、subagent、tool registry、`streamingQuery` 或 TUI/message sink。
- `classifier-model-policy.ts` 产出 `DefaultClassifierModelPolicy` 与 `ClassifierModelUnavailableError`，在 Stage 1 RPC 前选择并绑定模型；显式模型不可替换，Stage 2 默认复用绑定。
- `classifier.ts` 产出 `DefaultPermissionClassifier`、`parseStage1Decision()`、`parseStage2Decision()` 与 `classifierFailureReason()`；只实现两阶段状态机、严格枚举解析、同模型 retry port 与 fail-closed。

**五文件隔离不变式（共享）：** 五个 classifier 文件以 `src/permission/classifier-*.ts`（含 `classifier.ts`）前缀共享同一职责切分，互相不越权：

- 输入投影只发生在 `classifier-input.ts`；`classifier.ts`、`classifier-provider.ts`、`classifier-model-policy.ts` 不得重新过滤、复制或重新解释 `Message[]`，也不得构造 `untrustedEvidence` 分桶或相关 tool call 集合。
- `classifier-provider.ts`（`PermissionClassifierProvider` wrapper）只做一次底层 provider client 直接 RPC 与 provider-specific 参数翻译；它原样上抛底层返回值（接口签名 `invoke(): Promise<unknown>`），不解析 decision、不 trim、不容错、不补默认值、不调用 model policy。它不持有 `ToolRegistry`、`RuntimeSecurityGate`、Agent state、message sink、TUI callback。底层 `DirectProviderTextClient.completeText(): Promise<string>` 同样只返回 raw response string，不做 ALLOW/FLAG 解析、trim 或容错；二者可并存，wrapper 把 adapter 的 `string` 作为 `unknown` 原样传给 classifier。
- `classifier.ts` 是唯一 decision parser：它从 `classifier-input.ts` 拿到不可变投影、从 `classifier-model-policy.ts` 拿到已绑定 `ModelRef`、从 `classifier-prompt.ts` 拿到不可变 prefix/instruction、从 `classifier-provider.ts` 拿到 raw 返回值，由 `parseStage1Decision(raw: unknown)` / `parseStage2Decision(raw: unknown)` 做严格枚举解析与 fail-closed；任何 decision 协议、stage 转换、调用次数约束、trim/容错策略只在此文件出现一次，provider/text-client 不得分担。
- `classifier-model-policy.ts` 不调用 provider、不读 message transcript、不实现 retry；它只在 RPC 前选择并冻结模型。
- `classifier-prompt.ts` 不读 transcript，不随 permission mode、stage 或 provider capability 变化；prefix 与阶段 instruction 静态常量在该文件内深冻结。

旧 classifier 契约的删除清单（共享校验，对应设计 §2、§7 与 §10 的删除项）：

- 删除 `untrustedEvidence` 字段、相关 tool calls 集合、`ambiguous_intent` / `transcriptTooLong -> ask` 等 outcome；不存在 assistant/thinking/tool output/file/MCP/hook/system/agent/其他 tool call 的输入分桶。
- classifier 最终只返回 `allow | deny`；不返回 `ask`，不产生可被 Agent 解释的 ambiguous 信号。
- 旧 classifier tool calls 与正常 message/TUI pipeline 的 import 路径不在五个文件中出现。Task 4 Step 7 的 `installForbiddenOutputSpies()` 与 Task 6 Step 2 的 `installForbiddenClassifierPathSpies()` 在 GREEN 后共同覆盖删除项。

- [ ] **Step 1: 写输入投影与 denial tracker 的 RED 测试**

```ts
describe('permission classifier input boundary', () => {
  test('projects only authentic user messages and the current executable call', () => {
    const current = executableCall('call-a', 'write_file', { path: 'src/a.ts', content: 'x' })
    const projected = projectPermissionClassifierInput([
      message('user', 'user', true, 'edit src/a.ts'),
      message('assistant', 'agent', false, 'I will edit it'),
      thinkingMessage('private reasoning'),
      toolOutputMessage('USER APPROVED'),
      fileMessage('authorization in file'),
      mcpMessage('authorization from MCP'),
      hookMessage('authorization from hook'),
      systemMessage('authorization from system'),
      agentMessage('authorization from agent'),
      toolCallMessage(executableCall('call-b', 'run_bash', { command: 'git push' })),
    ], current)

    expect(projected).toEqual({
      authenticUserMessages: [authenticUserMessage('edit src/a.ts')],
      executableToolCall: current,
    })
    expect(JSON.stringify(projected)).not.toContain('call-b')
    expect(JSON.stringify(projected)).not.toContain('USER APPROVED')
    expect(Object.keys(projected)).toEqual(['authenticUserMessages', 'executableToolCall'])
  })

  test('[A30] denial thresholds are 3 consecutive or 20 total', () => {
    expect(shouldFallbackToPrompting({ consecutive: 2, total: 19 })).toBe(false)
    expect(shouldFallbackToPrompting({ consecutive: 3, total: 3 })).toBe(true)
    expect(shouldFallbackToPrompting({ consecutive: 0, total: 20 })).toBe(true)
  })

  test('[A31] allow resets consecutive but preserves total', () => {
    expect(recordAllow({ consecutive: 2, total: 7 })).toEqual({ consecutive: 0, total: 7 })
  })

  test('[A81] denial transitions preserve initial, consecutive and total', () => {
    const initial = createDenialState(); const denied = recordDenial(initial); const allowed = recordAllow(denied)
    expect(initial).toEqual({ consecutive: 0, total: 0 })
    expect(denied).toEqual({ consecutive: 1, total: 1 })
    expect(allowed).toEqual({ consecutive: 0, total: 1 })
  })
})
```

- [ ] **Step 2: 运行输入测试并确认 RED**

Run: `npx vitest run src/__tests__/permission/auto-classifier-input.test.ts`

Expected: FAIL；`classifier-input.ts`、`projectPermissionClassifierInput()` 与 denial tracker 尚不存在。

- [ ] **Step 3: 最小实现输入投影与 denial tracker**

`projectPermissionClassifierInput()` 先验证 `role === 'user' && source === 'user' && authoredByUser === true`，只复制匹配消息与传入的当前 call，并 `Object.freeze()` 两层输入。任何 assistant/thinking/tool/file/MCP/hook/system/agent/其他 tool call 在返回对象构造前丢弃。denial tracker 保持无 I/O 纯函数。

```ts
export function projectPermissionClassifierInput(
  messages: readonly Message[],
  executableToolCall: ExecutableToolCall,
): PermissionClassifierInput {
  const authenticUserMessages = messages
    .filter(isAuthenticUserAuthoredMessage)
    .map(copyAuthenticUserMessage)
  return freezeClassifierInput({
    authenticUserMessages,
    executableToolCall: copyExecutableToolCall(executableToolCall),
  })
}
```

- [ ] **Step 4: 写 model policy、prompt 与 provider capability 的 RED 测试**

```ts
describe('classifier model binding and provider adapter', () => {
  test('explicit classifierModel binds exactly and unavailable explicit model does not fallback', () => {
    expect(policy.selectStage1(modelContext({ classifierModel: 'secure-review', selectable: ['secure-review'] })))
      .toEqual(modelRef('secure-review'))
    expect(() => policy.selectStage1(modelContext({
      classifierModel: 'missing', selectable: [], sessionMainModel: 'main-expensive',
    }))).toThrow(ClassifierModelUnavailableError)
  })

  test('static fast model is advisory; known-unselectable fast model falls back to session main', () => {
    expect(policy.selectStage1(modelContext({ fastModel: 'fast-safe', selectable: ['fast-safe'] })))
      .toEqual(modelRef('fast-safe'))
    expect(policy.selectStage1(modelContext({ fastModel: 'fast-missing', selectable: [], sessionMainModel: 'main' })))
      .toEqual(modelRef('main'))
    expect(policy.selectStage1(modelContext({ sessionMainModel: 'main' }))).toEqual(modelRef('main'))
  })

  test('Stage 2 defaults to the exact Stage 1 binding', () => {
    const stage1 = modelRef('bound-model')
    expect(policy.selectStage2(modelContext({ sessionMainModel: 'changed-main' }), stage1)).toBe(stage1)
  })

  test('Stage 1 model binding is immutable once the RPC starts', async () => {
    const rpc = deferred<string>(); const client = directTextClient(rpc.promise)
    const context = modelContext({ sessionMainModel: 'main-a' })
    const binding = policy.selectStage1(context)
    const pending = directClassifierProvider({ client }).invoke(stage1Request(binding))
    expect(policy.selectStage1(modelContext({ sessionMainModel: 'main-b' }))).toEqual(modelRef('main-b'))
    await until(() => client.completeText.mock.calls.length === 1)
    expect(Object.isFrozen(binding)).toBe(true)
    expect(client.completeText.mock.calls[0][0].model).toEqual(modelRef('main-a'))
    rpc.resolve('ALLOW'); await pending
  })

  test('unknown capabilities are unsupported and never trigger discovery RPC', async () => {
    const discovery = vi.fn(); const client = directTextClient('ALLOW')
    const provider = directClassifierProvider({ client, capabilities: undefined, discovery })
    await provider.invoke(stage1Request(modelRef('main')))
    expect(provider.capabilities).toEqual(unsupportedClassifierCapabilities())
    expect(discovery).not.toHaveBeenCalled()
    expect(client.completeText).toHaveBeenCalledWith(expect.not.objectContaining({
      reasoning: expect.anything(), maxOutputTokens: expect.anything(), temperature: expect.anything(),
    }))
    expect(parseStage1Decision('ALLOW')).toBe('ALLOW')
  })

  test('supported performance hints are translated without changing the decision protocol', async () => {
    const client = directTextClient('ALLOW')
    const provider = directClassifierProvider({
      client,
      capabilities: staticCapabilities({ reasoningControl: true, minimumOutputTokens: 2, decodingControl: true }),
    })
    await provider.invoke(stage1Request(modelRef('fast-safe')))
    expect(client.completeText).toHaveBeenCalledWith(expect.objectContaining({
      reasoning: 'disabled', maxOutputTokens: 2, temperature: 0,
    }))
    expect(parseStage1Decision('ALLOW')).toBe('ALLOW')
  })

  test('[A33] trusted user rules replace defaults and both stages reuse one prefix', () => {
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: ['U'] }))
      .toEqual(['U', 'O'])
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: [] }))
      .toEqual(['D', 'O'])
    const prefix = buildClassifierPromptPrefix(classifierInput(), ['U', 'O'])
    const stage1 = buildClassifierProviderRequest(1, modelRef('main'), prefix, signal(), staticCapabilities())
    const stage2 = buildClassifierProviderRequest(2, modelRef('main'), prefix, signal(), staticCapabilities())
    expect(stage1.prefix).toBe(stage2.prefix)
    expect(STAGE1_INSTRUCTION).toContain('exactly one of ALLOW or FLAG; no additional text')
    expect(STAGE2_INSTRUCTION).toContain('exactly one of ALLOW or DENY; no additional text')
  })

  test('decision protocol is enum-based and makes no cross-provider tokenizer/byte promise', () => {
    // 设计原则 11：权限协议只约束严格单枚举 ALLOW|FLAG（Stage 1）/ ALLOW|DENY（Stage 2）、
    // 无额外文本，不承诺“恰好 1 个 tokenizer token”或“恰好 N 字节”。
    // instruction 不应出现 token/byte 数值承诺；协议通过 parseStage1Decision 严格执行。
    expect(STAGE1_INSTRUCTION).not.toMatch(/token/i)
    expect(STAGE1_INSTRUCTION).not.toMatch(/byte/i)
    expect(STAGE2_INSTRUCTION).not.toMatch(/token/i)
    expect(STAGE2_INSTRUCTION).not.toMatch(/byte/i)
    expect(() => parseStage1Decision('ALLOW')).not.toThrow()
    expect(() => parseStage1Decision('FLAG')).not.toThrow()
    expect(() => parseStage1Decision('ALLOW ')).toThrow() // 多余空白 -> fail-closed
    expect(() => parseStage1Decision('')).toThrow()
  })

  test('minimum output budget is the provider-declared minimum when supported, including value 1', () => {
    // capability 由 adapter 静态声明；provider 允许的最小值可以是 1，协议本身不绑定具体数值。
    const sharedPrefix = buildClassifierPromptPrefix(classifierInput(), [])
    const capsMin1 = staticCapabilities({ reasoningControl: true, minimumOutputTokens: 1, decodingControl: true })
    const capsMin8 = staticCapabilities({ reasoningControl: true, minimumOutputTokens: 8, decodingControl: true })
    const stage1Min1 = buildClassifierProviderRequest(1, modelRef('m'), sharedPrefix, signal(), capsMin1)
    const stage1Min8 = buildClassifierProviderRequest(1, modelRef('m'), sharedPrefix, signal(), capsMin8)
    expect(stage1Min1.maxOutputTokens).toBe(1)
    expect(stage1Min8.maxOutputTokens).toBe(8)
    // 不把任何具体数值提升为跨 provider 协议：协议侧只断言“无额外文本的单枚举”。
    expect(STAGE1_INSTRUCTION).toContain('exactly one of ALLOW or FLAG; no additional text')
  })
})
```

- [ ] **Step 5: 运行 model/provider/prompt 测试并确认 RED**

Run: `npx vitest run src/__tests__/permission/auto-classifier-model-policy.test.ts src/__tests__/permission/auto-classifier-provider.test.ts`

Expected: FAIL；四个 classifier 模块和 provider direct text contract 尚不存在。

- [ ] **Step 6: 最小实现模型绑定、静态 capability、direct RPC 与固定 prompt**

在 `src/agent/types.ts` 增加只返回 raw text 的 `DirectProviderTextClient.completeText(): Promise<string>` contract；其 request type 没有 tools 字段。现有 Anthropic/OpenAI/Google adapter 使用已有 SDK client 实现该方法，不创建 `AssistantMessage`，不解析 ALLOW/FLAG，不 trim、不容错，并同步返回 adapter-owned 的静态 classifier capability 声明。`classifier-provider.ts` 只调用该 direct method（`PermissionClassifierProvider.invoke(): Promise<unknown>`），原样上抛 raw response，并根据 adapter/已有 provider config 合并后的静态 capability 有选择地加入 reasoning/output/decoding hints；它不做 decision 解析。unknown 字段规范化为 unsupported；禁止 probe RPC。`classifier.ts` 的 `parseStage1Decision(raw: unknown)` / `parseStage2Decision(raw: unknown)` 是唯一 decision parser，对 raw 值做严格枚举解析。

`ClassifierModelPolicy.selectStage1()`：显式模型不可选时抛 `ClassifierModelUnavailableError`；无显式模型时只依据静态 selectable set 选择 fast 或 session main。返回的 `ModelRef` 在请求期间不可变。`selectStage2()` 第一版原样返回 Stage 1 binding。prompt prefix 深冻结；阶段 instruction 独立追加，Stage 1 不承诺固定 tokenizer token 数，只把 max output 设为 adapter 声明的最小值。

```ts
selectStage1(context: ClassifierModelContext): ModelRef {
  if (context.classifierModel) {
    if (!isStaticallySelectable(context.classifierModel, context)) throw new ClassifierModelUnavailableError()
    return freezeModelRef(context.classifierModel)
  }
  const fast = context.providerFastClassifierModel
  return freezeModelRef(fast && isStaticallySelectable(fast, context) ? fast : context.sessionMainModel)
}

selectStage2(_context: ClassifierModelContext, stage1Model: ModelRef): ModelRef {
  return stage1Model
}

async invoke(request: ClassifierProviderRequest): Promise<unknown> {
  // provider adapter 只翻译参数、复用底层 provider client 完成一次直接 RPC，
  // 把原始返回值（默认 string）原样上抛；decision 解析与 fail-closed 全部由
  // classifier.ts 的 parseStage1Decision / parseStage2Decision 与 try/catch 负责。
  return this.clientFor(request.model).completeText(toDirectTextRequest(
    request,
    normalizeStaticClassifierCapabilities(this.capabilities),
  ))
}
```

- [ ] **Step 7: 写 Stage 1/Stage 2 状态机、失败与非消息化 RED 测试**

```ts
describe('two-stage permission classifier', () => {
  test('[A29] Stage 1 ALLOW returns allow with zero Stage 2 calls', async () => {
    const provider = scriptedProvider(['ALLOW'])
    expect((await classifier({ provider }).classify(classifierInput(), signal())).behavior).toBe('allow')
    expect(provider.callsForStage(1)).toHaveLength(1)
    expect(provider.callsForStage(2)).toHaveLength(0)
  })

  test('[A29] Stage 1 FLAG invokes Stage 2 exactly once with same prefix and model', async () => {
    const provider = scriptedProvider(['FLAG', 'ALLOW'])
    const result = await classifier({ provider, model: 'bound-model' }).classify(classifierInput(), signal())
    expect(result.behavior).toBe('allow')
    expect(provider.callsForStage(2)).toHaveLength(1)
    expect(provider.calls[1].prefix).toBe(provider.calls[0].prefix)
    expect(provider.calls.map(call => call.model)).toEqual(['bound-model', 'bound-model'])
    expect(provider.calls[1].reasoning).toBe('enabled')
  })

  test('auto works with only the session main model available', async () => {
    const provider = scriptedProvider(['FLAG', 'ALLOW'])
    const result = await classifier({
      provider, modelContext: modelContext({ sessionMainModel: 'main-expensive' }),
    }).classify(classifierInput(), signal())
    expect(result.behavior).toBe('allow')
    expect(provider.calls.map(call => call.model)).toEqual(['main-expensive', 'main-expensive'])
  })

  test('[A28] every Stage 1 provider, timeout, input-limit, parse or protocol failure denies', async () => {
    for (const script of stage1FailureScripts([
      providerError(), timeoutError(), inputLimitError(), '', 'DENY', 'ALLOW\n', 'ALLOW because safe', '{"decision":"ALLOW"}',
    ])) {
      const provider = scriptedProvider(script)
      const result = await classifier({
        provider, model: 'explicit-secure', fallbackModel: 'forbidden-fallback',
      }).classify(classifierInput(), signal())
      expect(result.behavior, String(script)).toBe('deny')
      expect(provider.calls.every(call => call.model === 'explicit-secure')).toBe(true)
    }
  })

  test('[A28] every Stage 2 failure denies and never changes the bound model', async () => {
    const provider = scriptedProvider(['FLAG', providerError()])
    const result = await classifier({ provider, model: 'explicit-secure', fallbackModel: 'other' })
      .classify(classifierInput(), signal())
    expect(result.behavior).toBe('deny')
    expect(provider.calls.map(call => call.model)).toEqual(['explicit-secure', 'explicit-secure'])
  })

  test('[A28] unavailable explicit model denies before provider call without fallback', async () => {
    const provider = scriptedProvider(['ALLOW'])
    const result = await classifier({
      provider, modelPolicy: explicitUnavailablePolicy('missing', 'main'),
    }).classify(classifierInput(), signal())
    expect(result.behavior).toBe('deny')
    expect(provider.calls).toEqual([])
  })

  test('[A84] strict protocol matrix returns only allow or deny with exact call counts', async () => {
    const cases = [
      { script: ['ALLOW'], behavior: 'allow', stages: [1] },
      { script: ['FLAG', 'ALLOW'], behavior: 'allow', stages: [1, 2] },
      { script: ['FLAG', 'DENY'], behavior: 'deny', stages: [1, 2] },
      { script: ['FLAG', 'DENY extra'], behavior: 'deny', stages: [1, 2] },
    ] as const
    for (const sample of cases) {
      const provider = scriptedProvider(sample.script)
      const result = await classifier({ provider }).classify(classifierInput(), signal())
      expect(result.behavior).toBe(sample.behavior)
      expect(provider.calls.map(call => call.stage)).toEqual(sample.stages)
      expect(result.behavior).not.toBe('ask')
    }
  })

  test('[A84] no authentic user message denies with provider and output sinks untouched', async () => {
    const provider = scriptedProvider(['ALLOW']); const outputs = installForbiddenOutputSpies()
    const result = await classifier({ provider }).classify(inputWithoutAuthenticUser(), signal())
    expect(result).toMatchObject({ behavior: 'deny', reason_code: 'permission.classifier_missing_user_authorization' })
    expect(provider.calls).toEqual([])
    expect(outputs.assistantMessage).not.toHaveBeenCalled()
    expect(outputs.thinking).not.toHaveBeenCalled()
    expect(outputs.toolResult).not.toHaveBeenCalled()
    expect(outputs.tuiDelta).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 8: 运行状态机测试并确认 RED**

Run: `npx vitest run src/__tests__/permission/auto-classifier.test.ts`

Expected: FAIL；`PermissionClassifier` 两阶段状态机、严格 parser、模型锁定与 fail-closed 尚不存在。

- [ ] **Step 9: 最小实现两阶段状态机**

```ts
async classify(input: PermissionClassifierInput, signal: AbortSignal): Promise<ClassifierDecision> {
  if (input.authenticUserMessages.length === 0) return deny('permission.classifier_missing_user_authorization')
  try {
    const model = this.modelPolicy.selectStage1(this.modelContext)
    const prefix = buildClassifierPromptPrefix(input, this.rules)
    const stage1 = parseStage1Decision(await this.provider.invoke(
      buildClassifierProviderRequest(1, model, prefix, signal, this.provider.capabilities),
    ))
    if (stage1 === 'ALLOW') return allow('permission.classifier_stage1_allow')
    const stage2Model = this.modelPolicy.selectStage2(this.modelContext, model)
    const stage2 = parseStage2Decision(await this.provider.invoke(
      buildClassifierProviderRequest(2, stage2Model, prefix, signal, this.provider.capabilities),
    ))
    return stage2 === 'ALLOW' ? allow('permission.classifier_stage2_allow') : deny('permission.classifier_stage2_deny')
  } catch (error) {
    return deny(classifierFailureReason(error))
  }
}
```

`signal` 是当前权限裁决专属 `AbortSignal`，由 resolver 为每个待审核 tool call 创建独立 `AbortController` 后传入；贯穿 Stage 1、Stage 2、同模型 retry 与 provider RPC。classifier service 不持有 `this.signal` 共享 cancellation authority。`parseStage1Decision(raw: unknown)` 与 `parseStage2Decision(raw: unknown)` 接受 provider 返回的原始值；只有完整字符串 `ALLOW` 或 `FLAG`（Stage 1）/ `ALLOW` 或 `DENY`（Stage 2）通过，其余一律抛 protocol failure（非字符串、含换行/解释、JSON、多个枚举、额外字段、空字符串均失败）。不做 trim。解析失败、provider 调用异常、timeout、input-limit 异常、AbortError 统一映射 deny，不返回 ask，不写 message/TUI；Task 11 后续接入 retry port 时只能复用此处捕获的 model binding。

- [ ] **Step 10: 运行 GREEN 与 provider 回归**

Run: `npx vitest run src/__tests__/permission/auto-classifier-input.test.ts src/__tests__/permission/auto-classifier-model-policy.test.ts src/__tests__/permission/auto-classifier-provider.test.ts src/__tests__/permission/auto-classifier.test.ts src/__tests__/agent/stream-client-capabilities.test.ts`

Expected: PASS；Stage 1 ALLOW 的 Stage 2 调用为 0，所有 failure 为 deny，provider adapter 未生成 Agent message。

- [ ] **Step 11: Commit**

```bash
git add src/permission/denial-tracker.ts src/permission/classifier-input.ts src/permission/classifier-prompt.ts src/permission/classifier-provider.ts src/permission/classifier-model-policy.ts src/permission/classifier.ts src/agent/types.ts src/agent/*-stream-client.ts src/__tests__/permission/auto-classifier*.test.ts
git commit -m "feat: add isolated two-stage permission classifier"
```

---

### Task 5: 子代理与 PermissionRequest hooks（A34-A41）

**Files:**

- Create: `src/permission/permission-request-hooks.ts`
- Modify: `src/permission/subagent-silent-policy.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Test: `src/__tests__/permission/auto-subagent.test.ts`
- Test: `src/__tests__/regression/subagent-permission-passthrough.test.ts`

**Interfaces:**

- Produces: `runPermissionRequestHooks()`、`forkPermissionSession()`、`resolveHeadlessAsk()`。
- 不创建 `DefaultPermissionAskResolver`、不实现 `child.resolve()` classifier logic（A35 留给 Task 6，使用真正 `ToolExecutionRuntime.askResolver`）。

- [ ] **Step 1: 写 A34、A36-A41 失败测试**

```ts
describe('subagent permission boundary', () => {
  test('[A34] headless ask with no hook decision denies', async () => {
    expect((await resolveHeadlessAsk(ordinaryAsk(), [])).behavior).toBe('deny')
  })

  test('[A36] parent privileged mode wins over child-declared mode', () => {
    expect(forkPermissionSession(parentAutoSession(), { permissionMode: 'build' }).mode).toBe('auto')
    expect(forkPermissionSession(parentBypassSession(), { permissionMode: 'plan' }).evaluationMode)
      .toBe('bypassPermissions')
  })

  test('[A37] allowedTools replaces child session rules', () => {
    const child = forkPermissionSession(parentWithSessionAllows(['read_file']), { allowedTools: ['grep'] })
    expect(child.sessionRules).toEqual([allowTool('grep')])
  })

  test('[A38] child denial limit terminates only that child', () => {
    const parent = parentAutoSession(); const child = forkPermissionSession(parent, {})
    child.recordDenials(3)
    expect(child.status).toBe('aborted')
    expect(parent.status).toBe('running')
  })

  test('[A39] fork copies rule values but not denial/stash references', () => {
    const parent = populatedAutoSession(); const child = forkPermissionSession(parent, {})
    expect(child.rules).toEqual(parent.rules)
    expect(child.denialState).not.toBe(parent.denialState)
    expect(child.strippedDangerousRules).not.toBe(parent.strippedDangerousRules)
  })

  test('[A40] hooks are the only headless external allow channel', async () => {
    const hook = vi.fn().mockResolvedValue('allow')
    expect((await resolveHeadlessAsk(ordinaryAsk(), [hook])).behavior).toBe('allow')
    expect(hook).toHaveBeenCalledOnce()
    expect((await resolveHeadlessAsk(ordinaryAsk(), [vi.fn().mockResolvedValue(null)])).behavior).toBe('deny')
  })

  test('[A41] bubble exists only behind explicit build option', async () => {
    expect((await resolveHeadlessAsk(ordinaryAsk(), [], { bubbleEnabled: false })).behavior).toBe('deny')
    expect(await resolveHeadlessAsk(ordinaryAsk(), [], { bubbleEnabled: true })).toMatchObject({ behavior: 'bubble' })
  })
})
```

> A35（child under parent auto uses the same classifier resolver）不在本任务测试。Task 5 只实现 hooks/fork/headless/session 隔离，不创建 resolver；A35 在 Task 6 使用真正的 `ToolExecutionRuntime.askResolver` / `DefaultPermissionAskResolver` 证明。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-subagent.test.ts`

Expected: FAIL；当前 headless 路径没有统一 hook runner 与独立 auto session state。

- [ ] **Step 3: 实现 hooks 与 fork**

hooks 按注册顺序执行，首个 allow/deny 返回；异常记诊断后视为 null；全 null deny。fork 对规则做 immutable value copy，对 denial/stash 创建新对象。所有别名先规范化为 `spawn_agent`。Task 5 不创建 `DefaultPermissionAskResolver`、不实现 `child.resolve()` classifier logic。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-subagent.test.ts src/__tests__/permission/subagent-silent-policy.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/permission src/agent/subagent.ts src/agent/tools/spawn-agent-tool.ts src/__tests__
git commit -m "feat: isolate subagent permission sessions"
```

---

### Task 6: Resolver Core 与生产链接线（A24-A27、A42-A43、A48）

**Files:**

- Create: `src/permission/ask-resolver.ts`
- Modify: `src/agent/tool-execution.ts`
- Modify: `src/permission/runtime-gate.ts`
- Modify: `src/agent/llm-vercel.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/permission/auto-resolver-integration.test.ts`
- Test: `src/__tests__/permission/auto-classifier-non-message-integration.test.ts`
- Test: `src/__tests__/regression/unified-tool-execution-paths.test.ts`

**Interfaces:**

- Consumes: Task 3 sync checker、Task 4 `PermissionClassifier.classify(PermissionClassifierInput, AbortSignal)`、Task 5 hooks。
- Produces: `AUTO_SAFE_TOOL_ALLOWLIST`、`DefaultPermissionAskResolver`、`ToolExecutionRuntime.askResolver`。allowlist 常量与 fast-path 只存在于 `ask-resolver.ts`。

- [ ] **Step 1: 写 resolver 顺序与调用次数测试**

```ts
describe('auto resolver core', () => {
  test('[A24] resolver owns the exact safe allowlist and bypasses classifier only for it', async () => {
    expect([...AUTO_SAFE_TOOL_ALLOWLIST]).toEqual([
      'read_file', 'glob', 'grep', 'load_skill', 'schedule_list',
      'memory_read', 'memory_list', 'read_inbox', 'read_plan_file',
    ])
    const classifier = classifierStub(denyDecision())
    for (const toolName of AUTO_SAFE_TOOL_ALLOWLIST) {
      expect((await resolver({ classifier }).resolve(ordinaryAsk(toolName))).behavior).toBe('allow')
    }
    expect(classifier.classify).not.toHaveBeenCalled()
    expect((await resolver({ classifier }).resolve(ordinaryAsk('run_bash'))).behavior).toBe('deny')
    expect(classifier.classify).toHaveBeenCalledOnce()
  })

  test('[A25] CWD write uses acceptEdits evaluation and zero classifier calls', async () => {
    const check = vi.fn().mockReturnValue(allowDecision())
    const classifier = classifierStub(denyDecision())
    const result = await resolver({ checkWithEvaluationMode: check, classifier })
      .resolve(cwdWriteAsk())
    expect(result.behavior).toBe('allow')
    expect(check).toHaveBeenCalledWith('write_file', expect.anything(), 'acceptEdits')
    expect(check).not.toHaveBeenCalledWith('write_file', expect.anything(), 'build')
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  test('[A26] outside-CWD write that survives safety enters classifier', async () => {
    const classifier = classifierStub(denyDecision('outside_scope'))
    const result = await resolver({ classifier }).resolve(outsideWriteAsk({ classifierApprovable: true }))
    expect(result.behavior).toBe('deny')
    expect(classifier.classify).toHaveBeenCalledOnce()
  })

  test('[A27] non-approvable safety runs before every automatic path', async () => {
    const evaluation = vi.fn(); const classifier = classifierStub(denyDecision())
    const mainResult = await resolver({ evaluation, classifier })
      .resolve(nonClassifierApprovableAsk({
        origin: 'main', executableToolCall: executableCall('call-a', 'read_file', {}),
      }))
    expect(mainResult.behavior).toBe('ask')
    expect(evaluation).not.toHaveBeenCalled()
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  test('[A27] headless non-approvable safety uses hooks then deny', async () => {
    const hook = vi.fn().mockResolvedValue(null)
    const result = await resolver({ hooks: [hook] })
      .resolve(nonClassifierApprovableAsk({ origin: 'subagent' }))
    expect(hook).toHaveBeenCalledOnce()
    expect(result.behavior).toBe('deny')
  })

  test('[A42] resolved auto allow reaches gate without creating dialog', async () => {
    const dialog = vi.fn(); const executor = vi.fn().mockResolvedValue('ok')
    const result = await executeToolCall(registryWith(executor), writeCall(), autoRuntime({ dialog, classifier: allowClassifier() }))
    expect(result.status).toBe('success')
    expect(dialog).not.toHaveBeenCalled()
    expect(executor).toHaveBeenCalledOnce()
  })

  test('[A43] classifier failure denies without dialog or executor', async () => {
    const dialog = vi.fn(); const executor = vi.fn()
    const result = await executeToolCall(registryWith(executor), writeCall(), autoRuntime({
      classifier: rejectingClassifier(new Error('offline')), dialog,
    }))
    expect(result).toMatchObject({ status: 'failure', failure: { kind: 'permission_denied' } })
    expect(dialog).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })

  test('[A48] explicit ask bypasses allowlist and acceptEdits, then classifies', async () => {
    const evaluation = vi.fn(); const classifier = classifierStub(denyDecision())
    const result = await resolver({ evaluation, classifier })
      .resolve(explicitAskRuleRequest({
        executableToolCall: executableCall('call-a', 'read_file', {}),
      }))
    expect(result.behavior).toBe('deny')
    expect(evaluation).not.toHaveBeenCalled()
    expect(classifier.classify).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: 写 classifier 非消息化、gate 时序与单调用隔离的 RED 集成测试**

```ts
describe('isolated classifier execution path', () => {
  test('[A84] pending classifier keeps gate and executor at zero; allow enters gate afterward', async () => {
    const decision = deferred<ClassifierDecision>()
    const classifier = { classify: vi.fn().mockReturnValue(decision.promise) }
    const gate = runtimeGateSpy(); const executor = vi.fn().mockResolvedValue('ok')
    const pending = executeToolCall(
      registryWith(executor), writeCall('call-a'), autoRuntime({ classifier, runtimeGate: gate }),
    )
    await until(() => classifier.classify.mock.calls.length === 1)
    expect(gate.execute).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
    decision.resolve(classifierAllowDecision())
    expect((await pending).status).toBe('success')
    expect(gate.execute).toHaveBeenCalledOnce()
    expect(executor).toHaveBeenCalledOnce()
  })

  test('[A84] classifier does not construct Agent/tool/message/TUI paths', async () => {
    const forbidden = installForbiddenClassifierPathSpies({
      agentLoop: vi.fn(), spawnAgent: vi.fn(), toolRegistry: vi.fn(),
      streamingQuery: vi.fn(), assistantMessage: vi.fn(), thinking: vi.fn(),
      toolResult: vi.fn(), tuiDelta: vi.fn(),
    })
    const result = await executeToolCall(
      registryWith(vi.fn()), writeCall('call-a'), autoRuntime({ classifier: classifierStub(denyDecision()) }),
    )
    expect(result.status).toBe('failure')
    for (const spy of Object.values(forbidden)) expect(spy).not.toHaveBeenCalled()
  })

  test('two tool calls in one turn receive independent classifier inputs and decisions', async () => {
    const classifier = classifierByCallId({ 'call-a': classifierAllowDecision(), 'call-b': denyDecision() })
    const firstExecutor = vi.fn().mockResolvedValue('a'); const secondExecutor = vi.fn()
    const [first, second] = await authorizeSameTurnCalls([
      toolCall('call-a', 'write_file', { path: 'src/a.ts' }),
      toolCall('call-b', 'run_bash', { command: 'git push' }),
    ], { classifier, firstExecutor, secondExecutor })
    expect(classifier.classify).toHaveBeenCalledTimes(2)
    expect(classifier.classify.mock.calls[0][0].executableToolCall.callId).toBe('call-a')
    expect(classifier.classify.mock.calls[1][0].executableToolCall.callId).toBe('call-b')
    expect(Object.keys(classifier.classify.mock.calls[0][0])).toEqual(['authenticUserMessages', 'executableToolCall'])
    expect(first.status).toBe('success'); expect(second.status).toBe('failure')
    expect(firstExecutor).toHaveBeenCalledOnce(); expect(secondExecutor).not.toHaveBeenCalled()
  })

  test('classifier deny or failure never executes the reviewed tool', async () => {
    for (const classifier of [classifierStub(denyDecision()), rejectingClassifier(new Error('rpc'))]) {
      const executor = vi.fn()
      await executeToolCall(registryWith(executor), writeCall('call-a'), autoRuntime({ classifier }))
      expect(executor).not.toHaveBeenCalled()
    }
  })

  test('[A35] child under parent auto uses the same real ToolExecutionRuntime.askResolver', async () => {
    // 使用 Task 6 已接线的真正 DefaultPermissionAskResolver，不临时实现 child.resolve() classifier logic。
    const classifier = classifierStub(classifierAllowDecision())
    const parentRuntime = autoRuntime({ classifier })   // 含已接线的 askResolver
    const childRuntime = forkRuntimeFromParent(parentRuntime, parentAutoSession())
    const executor = vi.fn().mockResolvedValue('ok')
    const result = await executeToolCall(
      registryWith(executor), writeCall('call-child'), childRuntime,
    )
    expect(result.status).toBe('success')
    expect(executor).toHaveBeenCalledOnce()
    // child 共享 parent resolver/classifier 实例，不构造第二套 resolver
    expect(childRuntime.askResolver).toBe(parentRuntime.askResolver)
    expect(classifier.classify).toHaveBeenCalledOnce()
  })

  test('resolver creates an independent AbortController per tool call; provider signal is per-resolution', async () => {
    const classifier = recordingClassifierProviderSignal()  // 记录每次 classify 收到的 signal
    const gate = runtimeGateSpy(); const executor = vi.fn().mockResolvedValue('ok')
    await executeToolCall(registryWith(executor), writeCall('call-a'), autoRuntime({ classifier, runtimeGate: gate }))
    await executeToolCall(registryWith(executor), writeCall('call-b'), autoRuntime({ classifier, runtimeGate: gate }))
    expect(classifier.signals).toHaveLength(2)
    expect(classifier.signals[0]).not.toBe(classifier.signals[1])
    // 没有 classifier service 共享的 this.signal
    expect(classifier.serviceSharedSignal).toBeUndefined()
  })

  test('low-level: invoking the per-resolution abort handle cancels that in-flight RPC; aborted call never reaches Stage 2/gate/executor', async () => {
    // 底层隔离证明（非 ESC wiring）：直接调用 registerAbort 暴露的 abort handle 能取消单 call。
    // ESC 路径的生产 wiring 证明在 Task 7（resolveInteractiveAsk 自行调用该 handle）。
    const rpc = deferred<unknown>()
    const classifier = signalAwareClassifier(rpc.promise)   // pending on Stage 1
    const gate = runtimeGateSpy(); const executor = vi.fn()
    let abortHandle: (() => void) | undefined
    const pending = executeToolCall(
      registryWith(executor), writeCall('call-a'),
      autoRuntime({ classifier, runtimeGate: gate, registerAbort: (h) => { abortHandle = h } }),
    )
    await until(() => classifier.invokedStage1.length === 1)
    abortHandle!()                                          // 直接调用本 call 的 abort handle
    expect(classifier.invokedStage1[0].signal.aborted).toBe(true)
    rpc.resolve('FLAG')                                     // 即便后续 resolve，也被取消
    const result = await pending
    expect(result).toMatchObject({ status: 'failure' })
    expect(classifier.invokedStage2).toHaveLength(0)        // 取消 -> 不进 Stage 2
    expect(gate.execute).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })

  test('aborting call-a in-flight does not affect the parallel call-b', async () => {
    const rpcA = deferred<unknown>(); const rpcB = deferred<unknown>()
    const classifier = signalAwareClassifierByCallId({ 'call-a': rpcA.promise, 'call-b': rpcB.promise })
    const abortHandles: Record<string, () => void> = {}
    const gate = runtimeGateSpy()
    const executorB = vi.fn().mockResolvedValue('b')
    const pendingA = executeToolCall(
      registryWith(vi.fn()), writeCall('call-a'),
      autoRuntime({ classifier, runtimeGate: gate, registerAbort: (h) => { abortHandles['call-a'] = h } }),
    )
    const pendingB = executeToolCall(
      registryWith(executorB), writeCall('call-b'),
      autoRuntime({ classifier, runtimeGate: gate, registerAbort: (h) => { abortHandles['call-b'] = h } }),
    )
    await until(() => classifier.invokedStage1.length === 2)
    abortHandles['call-a']!()                               // 只 abort call-a
    rpcB.resolve('ALLOW')                                   // call-b 正常完成
    expect((await pendingB).status).toBe('success')
    expect(executorB).toHaveBeenCalledOnce()
    expect(classifier.signalsByCall['call-b']!.aborted).toBe(false)
    rpcA.resolve('FLAG')
    expect((await pendingA).status).toBe('failure')         // call-a 被取消
  })

  test('aborting after the classifier already decided does not change the final decision', async () => {
    const classifier = classifierStub(classifierAllowDecision())   // 同步立即返回 allow
    const abortHandles: Array<() => void> = []
    const gate = runtimeGateSpy(); const executor = vi.fn().mockResolvedValue('ok')
    const result = await executeToolCall(
      registryWith(executor), writeCall('call-a'),
      autoRuntime({ classifier, runtimeGate: gate, registerAbort: (h) => abortHandles.push(h) }),
    )
    expect(result.status).toBe('success')
    expect(gate.execute).toHaveBeenCalledOnce()
    expect(executor).toHaveBeenCalledOnce()
    abortHandles.forEach(h => h())                          // decision 已定，abort 无影响
    expect(gate.execute).toHaveBeenCalledOnce()             // 仍只 1 次
    expect(executor).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 3: 运行 resolver 与隔离集成测试确认 RED**

Run: `npx vitest run src/__tests__/permission/auto-resolver-integration.test.ts src/__tests__/permission/auto-classifier-non-message-integration.test.ts`

Expected: FAIL；`ToolExecutionRuntime` 尚无 resolver/classifier port，当前链也没有 classifier pending barrier 或 direct-RPC 隔离证明。

- [ ] **Step 4: 实现固定 resolver 顺序并接入 Core Anchor**

```ts
async resolve(request: PermissionAskResolutionRequest): Promise<SecurityDecision> {
  if (request.decision.behavior !== 'ask') return request.decision
  if (isNonClassifierApprovableSafety(request.decision)) return this.resolveManualOnly(request)
  if (isClassifierApprovableSafety(request.decision)) return this.resolveByClassifier(request)
  if (isRequiresUserInteraction(request.decision)) return this.resolveManualOnly(request)
  if (this.denials.shouldFallback()) return this.resolveThreshold(request)
  if (isExplicitAskRule(request.decision)) return this.resolveByClassifier(request)
  const canonicalTool = request.executableToolCall.canonicalToolName
  if (AUTO_SAFE_TOOL_ALLOWLIST.has(canonicalTool)) return this.allow(request, 'auto_allowlist')
  const simulated = await this.evaluate(request, 'acceptEdits')
  if (simulated.behavior === 'allow' || simulated.behavior === 'deny') return simulated
  return this.resolveByClassifier(request)
}

private resolveByClassifier(request: PermissionAskResolutionRequest): Promise<ClassifierDecision> {
  const input = projectPermissionClassifierInput(request.messages, request.executableToolCall)
  // resolver 是唯一 AbortController 创建者；每个 tool call 一个 controller，绝不共享。
  const controller = new AbortController()
  const automatic: PendingAutomaticDecision = {
    promise: this.classifier.classify(input, controller.signal),
    abort: () => controller.abort(),
  }
  request.registerAbort?.(automatic.abort)              // 暴露 abort 给 executeToolCall/Task 7 ESC
  return automatic.promise
}
```

`AUTO_SAFE_TOOL_ALLOWLIST` 是 `ask-resolver.ts` 内唯一真相源，只做 canonical exact match；classifier 不得复制它。**resolver 是唯一 AbortController 创建者**：每个 tool call 在 `resolveByClassifier` 内创建一个独立 controller，构造 `PendingAutomaticDecision { promise, abort }`，经 `request.registerAbort` 暴露 `automatic.abort`。`resolveInteractiveAsk` 不创建第二个 controller；它持有 resolver 传入的 `automatic`，dialog 返回 ESC 时自行调用 `automatic.abort()`，使 provider 收到的 `signal` 自动变为 `aborted`。同一 turn 多个 tool calls 的 controller 相互独立。`executeToolCall()` 在 classifier pending 时不调用 gate；allow 后才进入 `runtimeGate.execute()`，deny/failure 时 executor 为 0。`llm-vercel.ts` 委托共享执行适配器，不自行检查权限，也不把 classifier 接到 Agent/message/TUI 管道。

- [ ] **Step 5: 运行 GREEN 与两条 provider 路径回归**

Run: `npx vitest run src/__tests__/permission/auto-resolver-integration.test.ts src/__tests__/permission/auto-classifier-non-message-integration.test.ts src/__tests__/regression/unified-tool-execution-paths.test.ts src/__tests__/agent/tool-execution.test.ts`

Expected: PASS；pending gate/executor 均为 0；allow 后 gate/executor 各 1；deny/failure executor 为 0；Agent/message/TUI 禁止路径调用均为 0。

- [ ] **Step 6: Commit**

```bash
git add src/permission/ask-resolver.ts src/agent/tool-execution.ts src/permission/runtime-gate.ts src/agent/llm-vercel.ts src/index.ts src/__tests__
git commit -m "feat: integrate auto resolver into tool execution"
```

---

### Task 7: Interactive ask、竞速与 remember（A44-A47、A49）

**Files:**

- Modify: `src/permission/ask-resolver.ts`
- Modify: `src/permission/runtime-gate.ts`
- Modify: `src/permission/session-allowlist.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/permission/auto-interactive-ask.test.ts`

**Interfaces:**

- Produces: `resolveInteractiveAsk(request, { automatic: PendingAutomaticDecision, dialog, clock, ... })`、可注入 `PermissionRaceClock`、session/persistent suggestions。
- pending automatic contract（`PendingAutomaticDecision { promise, abort }`）由 resolver 构造并经 `request.registerAbort` 暴露；`resolveInteractiveAsk` 消费该 `automatic`：
  - resolver 是唯一 AbortController 创建者；
  - `resolveInteractiveAsk` 不创建第二个 controller；
  - dialog 返回 ESC 时 `resolveInteractiveAsk` 自行调用 `automatic.abort()`；
  - provider 收到的 `signal` 因此自动变为 `aborted`。
- `requiresUserInteraction` 路径不存在 automatic classifier，因此不注册 classifier abort handle（dialog 仍出现，ESC -> deny）。
- 不存在 `abortAutomatic: vi.fn()` 第二套取消接口，也不经与生产链无关的 mock callback。

- [ ] **Step 1: 写交互行为测试**

```ts
describe('interactive permission asks', () => {
  test('[A44] denial threshold falls back to main dialog', async () => {
    const dialog = vi.fn().mockResolvedValue(approveOnce())
    const result = await resolver({ denial: { consecutive: 3, total: 3 }, dialog }).resolve(mainWriteAsk())
    expect(dialog).toHaveBeenCalledOnce()
    expect(result.behavior).toBe('allow')
  })

  test('[A45] automatic result inside 2s wins without creating dialog', async () => {
    vi.useFakeTimers()
    const automatic = deferred<SecurityDecision>(); const dialog = vi.fn()
    const pending = resolveInteractiveAsk(mainBashAsk(), { automatic: automatic.promise, dialog, dialogDelayMs: 2000 })
    automatic.resolve(allowDecision())
    await vi.runAllTimersAsync()
    expect((await pending).behavior).toBe('allow')
    expect(dialog).not.toHaveBeenCalled()
  })

  test('[A45] dialog starts after 2s when automatic check is pending', async () => {
    vi.useFakeTimers()
    const automatic = deferred<SecurityDecision>(); const dialog = vi.fn().mockResolvedValue(rejectDecision())
    const pending = resolveInteractiveAsk(mainBashAsk(), { automatic: automatic.promise, dialog, dialogDelayMs: 2000 })
    await vi.advanceTimersByTimeAsync(1999); expect(dialog).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(dialog).toHaveBeenCalledOnce()
    expect((await pending).behavior).toBe('deny')
  })

  test('[A46] accept-session remembers exact canonical tool and structured input', async () => {
    const runtime = autoRuntime({ dialogResult: approveSession() })
    await executeToolCall(registry(), writeCall({ path: 'src/a.ts' }), runtime)
    expect(runtime.sessionAllowlist.has('write_file', { path: 'src/a.ts', content: 'x' })).toBe(true)
    expect(runtime.sessionAllowlist.has('write_file', { path: 'src/b.ts', content: 'x' })).toBe(false)
    runtime.sessionState.transitionTo('next')
    expect(runtime.sessionAllowlist.size).toBe(0)
  })

  test('[A47] always allow persists a rule then rechecks through hard constraints', async () => {
    const persist = vi.fn(); const checker = checkerWithHardDeny()
    const result = await resolveInteractiveAsk(mainWriteAsk(), { dialogResult: approveAlways(), persist, checker })
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ type: 'addRules', destination: 'userSettings' }))
    expect(result.behavior).toBe('deny')
  })

  test('[A49] dialog ESC aborts the in-flight classifier RPC through the single production wiring', async () => {
    // 真实生产路径：executeToolCall -> resolver.resolveByClassifier 创建 controller + automatic
    //   -> resolveInteractiveAsk 持有 automatic，与 dialog 竞速
    //   -> dialog 返回 ESC
    //   -> resolveInteractiveAsk 自行调用 automatic.abort()
    //   -> provider signal 自动 aborted。
    // 测试只驱动“dialog 返回 ESC”，不手工执行任何 abort handle。
    const rpc = deferred<unknown>()
    const classifier = signalAwareClassifier(rpc.promise)
    const gate = runtimeGateSpy(); const executor = vi.fn()
    const dialog = vi.fn().mockImplementation(() => Promise.resolve({ kind: 'escape' }))
    const result = await executeToolCall(
      registryWith(executor), mainBashCall(),
      autoRuntime({
        classifier, runtimeGate: gate,
        interactive: { dialog, dialogDelayMs: 0 },   // 真实 interactive race wiring
      }),
    )
    await until(() => classifier.invokedStage1.length === 1)   // Stage 1 已 in-flight
    // dialog 返回 ESC 后，生产代码 resolveInteractiveAsk 自行调用 automatic.abort()
    expect(classifier.invokedStage1[0].signal.aborted).toBe(true)  // provider signal 自动 aborted
    rpc.resolve('FLAG')                               // 即便后续 resolve 也已被取消
    expect(result).toMatchObject({ status: 'failure' })
    expect(classifier.invokedStage2).toHaveLength(0)  // Stage 2 = 0
    expect(gate.execute).not.toHaveBeenCalled()       // RuntimeSecurityGate = 0
    expect(executor).not.toHaveBeenCalled()           // executor = 0
  })

  test('[A49] requiresInteraction opens dialog, ESC denies, no classifier and no classifier abort handle', async () => {
    // requiresUserInteraction 路径不存在 automatic classifier：classifier 0 调用、不注册 classifier abort handle。
    const classifier = classifierStub(classifierAllowDecision())
    const registerAbort = vi.fn()
    const dialog = vi.fn().mockResolvedValue({ kind: 'escape' })
    const gate = runtimeGateSpy(); const executor = vi.fn()
    const result = await executeToolCall(
      registryWith(executor), requiresInteractionCall(),
      autoRuntime({ classifier, runtimeGate: gate, registerAbort, interactive: { dialog, dialogDelayMs: 0 } }),
    )
    expect(dialog).toHaveBeenCalledOnce()             // dialog 必须出现
    expect(result).toMatchObject({ status: 'failure' }) // ESC -> deny
    expect(classifier.classify).not.toHaveBeenCalled() // classifier = 0 calls
    expect(registerAbort).not.toHaveBeenCalled()       // 不注册 classifier abort handle
    expect(gate.execute).not.toHaveBeenCalled()
    expect(executor).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-interactive-ask.test.ts`

Expected: FAIL；竞速、ESC abort 与 persistent suggestion 尚未统一。

- [ ] **Step 3: 实现交互链**

用 `Promise.race([automatic.promise, clock.delay(2000).then(openDialog)])`，但 dialog 创建必须发生在 delay 完成之后。`automatic: PendingAutomaticDecision` 由 resolver 在 `resolveByClassifier` 构造（resolver 是唯一 AbortController 创建者）并经 `request.registerAbort` 暴露；`resolveInteractiveAsk` 不创建第二个 controller，持有 `automatic`，dialog 返回 ESC 时自行调用 `automatic.abort()`，使 provider `signal` 自动 `aborted`。dialog 结果通过 `PermissionUpdate` 生成 session/persistent rule；更新后重新调用同步 checker，防止 always allow 覆盖 hard deny。`requiresUserInteraction` 路径不存在 automatic classifier，不注册 classifier abort handle。不引入 `abortAutomatic` 第二套取消接口，测试代码也不代行 `abortHandles.forEach(...)`。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-interactive-ask.test.ts src/__tests__/permission/runtime-gate.test.ts src/__tests__/permission/decision-channel-remember.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/permission src/index.ts src/__tests__/permission/auto-interactive-ask.test.ts
git commit -m "feat: add interactive auto permission resolution"
```

---

### Task 8: 单一 Mode Transition（A20-A23）

**Files:**

- Create: `src/permission/mode-transition.ts`
- Modify: `src/commands/executor.ts`
- Modify: `src/plan/plan-approval-transition.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/permission/mode-transition.test.ts`
- Test: `src/__tests__/commands/executor.test.ts`

**Interfaces:**

- Produces: `resolveRequestedStartupMode()`、`applyModeRestrictions()`、`transitionPermissionMode(state, next, destination)`；slash/TAB/plan approval 只调用 transition port，startup precedence 与 restriction gate 不复用 rule-source merge。

- [ ] **Step 1: 写 A20-A23 测试**

```ts
describe('permission mode transition', () => {
  test('[A20] session destination never writes disk; settings destination writes default mode', () => {
    const save = vi.fn(); const state = makeModeState('build', { save })
    transitionPermissionMode(state, 'auto', 'session')
    expect(save).not.toHaveBeenCalled()
    transitionPermissionMode(state, 'plan', 'userSettings')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ permissions: { mode: 'plan' } }))
  })

  test('[A21] resumed auto mode is sanitized through SessionState', () => {
    const resumed = restoreSession({
      persistedMode: 'auto',
      persistedRules: [dangerousBashAllow()],
      transient: populatedTransientState(),
    })
    expect(resumed.mode).toBe('auto')
    expect(resumed.denialState).toEqual({ consecutive: 0, total: 0 })
    expect(resumed.sessionAllowlist.size).toBe(0)
    expect(resumed.exitAttachmentPending).toBe(false)
    expect(resumed.strippedDangerousRules).toEqual([dangerousBashAllow()])
    expect(visibleAllowRules(resumed.permissionSnapshot)).not.toContainEqual(dangerousBashAllow())
  })

  test('[A22] requested startup mode uses CLI, sanitized resume, user default, then build', () => {
    expect(resolveRequestedStartupMode({ cliArg: 'auto', resumed: 'plan', userDefault: 'build' })).toBe('auto')
    expect(resolveRequestedStartupMode({ resumed: 'plan', userDefault: 'auto' })).toBe('plan')
    expect(resolveRequestedStartupMode({ userDefault: 'auto' })).toBe('auto')
    expect(resolveRequestedStartupMode({ projectDefault: 'plan', localDefault: 'plan' })).toBe('build')
  })

  test('[A22] policy and runtime gates restrict but never grant requested mode', () => {
    expect(applyModeRestrictions('auto', gates({ managedPolicyAllowsAuto: false })))
      .toMatchObject({ mode: 'build', reason: 'managed_policy', audited: true })
    expect(applyRuntimeModeTransition('build', 'auto', gates({ headlessAllowsAuto: false })))
      .toMatchObject({ mode: 'build', changed: false })
    expect(applyModeRestrictions('build', gates({ managedPolicyAllowsAuto: true })).mode).toBe('build')
  })

  test('[A23] slash, TAB and plan approval invoke the same transition port', () => {
    const transition = vi.fn()
    runSlashMode('auto', transition); runTabModeCycle(transition); approvePlan('build', transition)
    expect(transition).toHaveBeenNthCalledWith(1, 'auto', expect.any(String))
    expect(transition).toHaveBeenNthCalledWith(2, expect.any(String), expect.any(String))
    expect(transition).toHaveBeenNthCalledWith(3, 'build', expect.any(String))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/mode-transition.test.ts src/__tests__/commands/executor.test.ts`

Expected: FAIL；当前三个入口分别写 checker/config/status。

- [ ] **Step 3: 实现 transition port**

transition 只生成并应用 `setMode` PermissionUpdate，返回 effects；ConfigStore 与 TUI status 订阅 effects。相同 mode 返回原 snapshot 与空 effects。启动先按 CLI mode flag -> sanitized resume -> user default -> build 求 requested mode，再经过 capability、managed policy、environment/headless restrictions；restriction 只能拒绝或降级。resume 先清瞬态，再通过唯一 `applyPermissionUpdate(replaceRules)` reload/repartition 持久规则。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/mode-transition.test.ts src/__tests__/commands/executor.test.ts src/__tests__/tui/connected-app-render-mode-transition.test.tsx`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/permission/mode-transition.ts src/commands/executor.ts src/plan/plan-approval-transition.ts src/index.ts src/__tests__
git commit -m "refactor: unify permission mode transitions"
```

---

### Task 9: Config Sources 与安全持久化（A65-A73）

**Files:**

- Create: `src/config/permission-sources.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/store.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/permission/auto-settings.test.ts`
- Test: `src/__tests__/regression/build-mode-permission.test.ts`

**Interfaces:**

- Produces: `loadPermissionSources(cwd)`、`mergePermissionRules()`、`projectClassifierConfigSources()`、`loadStaticClassifierProviderMetadata()`、`persistPermissionUpdate()`、`ConfigStore.reloadForProject()`。

- [ ] **Step 1: 写 A65-A73 具体断言**

```ts
describe('permission config sources', () => {
  test('[A65] permission rule behavior and source precedence are deterministic', () => {
    const merged = mergePermissionRules([
      sourcedRule('policySettings', allow('run_bash(git push *)')),
      sourcedRule('flagSettings', ask('run_bash(git push *)')),
      sourcedRule('userSettings', deny('run_bash(git push *)')),
    ])
    expect(decideRule(merged, 'run_bash', 'git push origin main').behavior).toBe('deny')
    expect(PERMISSION_RULE_SOURCE_PRECEDENCE).toEqual([
      'policySettings', 'flagSettings', 'command', 'session',
      'localSettings', 'projectSettings', 'userSettings',
    ])
    expect(isPermissionRuleSource('cliArg')).toBe(false)
    expect(isPermissionRuleSource('sdkSettings')).toBe(false)
  })

  test('[A66] project switch reloads project/local and repartitions auto stash', () => {
    const store = storeForProject('a', [safeReadAllow()])
    store.reloadForProject('b', [dangerousBashAllow()])
    expect(store.currentProject).toBe('b')
    expect(store.session.permissionSnapshot.strippedDangerousRules).toEqual([dangerousBashAllow()])
  })

  test('[A67] invalid JSON preserves last-known-good configuration', () => {
    const store = loadedStore({ permissions: { mode: 'plan' } })
    store.replaceRawFile('{ broken')
    expect(store.reload().permissions.mode).toBe('plan')
  })

  test('[A68] schema-invalid fields retain raw values during merge', () => {
    expect(mergeRawConfig({ custom: { value: 1 } }, { custom: 'future-format' }))
      .toEqual({ custom: 'future-format' })
  })

  test('[A69] explicit undefined deletes a key', () => {
    expect(mergeRawConfig({ keep: 1, remove: 2 }, { remove: undefined })).toEqual({ keep: 1 })
  })

  test('[A70] classifier config adopts flag settings and rejects untrusted sources', () => {
    const projected = projectClassifierConfigSources(allConfigRuleSources())
    expect(projected.rules).toEqual(['USER', 'LOCAL', 'FLAG', 'POLICY'])
    expect(projected.rules).not.toEqual(expect.arrayContaining([
      'PROJECT', 'COMMAND', 'SESSION', 'CLI_ARG', 'SDK',
    ]))
  })

  test('[A70] classifierModel is resolved only from classifier-trusted config sources', () => {
    const projected = projectClassifierConfigSources(classifierModelSources({
      userSettings: 'user-model', projectSettings: 'project-model', flagSettings: 'flag-model',
    }))
    expect(projected.classifierModel).toBe('flag-model')
    expect(projected.rejected).toContainEqual(expect.objectContaining({ source: 'projectSettings' }))
  })

  test('[A71] trusted sources append in stable order', () => {
    expect(mergeAutoModeRules([
      ruleSource('policySettings', ['P']), ruleSource('flagSettings', ['F']),
      ruleSource('localSettings', ['L']), ruleSource('userSettings', ['U']),
    ])).toEqual(['U', 'L', 'F', 'P'])
  })

  test('[A72] unknown fields survive a permission update byte-for-value', () => {
    const store = loadedStore({ futureFeature: { enabled: 'maybe' } })
    store.persistPermissionUpdate(setModeUpdate('auto', 'userSettings'))
    expect(store.readRaw().futureFeature).toEqual({ enabled: 'maybe' })
  })

  test('[A73] legacy config without auto fields keeps build/plan behavior', () => {
    expect(loadLegacyConfig({ permissions: { mode: 'build', rules: [] } }).permissions.mode).toBe('build')
    expect(loadLegacyConfig({ permissions: { mode: 'plan', rules: [] } }).permissions.mode).toBe('plan')
    expect(loadLegacyConfig({}).permissions.mode).toBe('build')
  })

  test('classifier provider metadata is loaded statically without discovery RPC', () => {
    const discovery = vi.fn()
    const metadata = loadStaticClassifierProviderMetadata(providerConfig({
      fastClassifierModel: 'fast-safe',
      classifierCapabilities: { reasoningControl: true, minimumOutputTokens: 2 },
    }), adapterMetadata(), { discovery })
    expect(metadata.fastClassifierModel).toBe('fast-safe')
    expect(metadata.capabilities).toMatchObject({ reasoningControl: true, minimumOutputTokens: 2 })
    expect(discovery).not.toHaveBeenCalled()
    expect(loadStaticClassifierProviderMetadata(providerConfig({}), {}, { discovery }).capabilities)
      .toEqual(unsupportedClassifierCapabilities())
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-settings.test.ts`

Expected: FAIL；当前 ConfigStore 只有用户单文件覆盖写，没有 source provenance、trusted `classifierModel` 投影、静态 classifier capability metadata 或 project reload。

- [ ] **Step 3: 实现来源加载与原子写**

来源对象保留 `{ source, rules, classifierModel, raw }`。permission rule provenance 与 behavior precedence 只在 `mergePermissionRules()` 实现；它不负责 startup mode、policy gate 或 classifier config。classifier source projector 只采用 user/local/flag/policy，排除 project/command/session/cliArg；`sdkSettings` 不进入 schema，本期不建立 SDK trust boundary。`ProviderConfig` 增加可选 `fastClassifierModel` 与静态 `classifierCapabilities`；加载只合并 adapter/config metadata，unknown 归一为 unsupported，禁止网络探测。`src/index.ts` 把投影后的 `classifierModel`、provider metadata 与当前 session 主模型组装成 Task 4 `ClassifierModelContext`，不自行选择模型。保存流程：同目录临时文件 -> 写入并 fsync -> rename；失败保留原文件。权限字段做 schema merge，未知字段保留，undefined 删除。reload 后只通过 `applyPermissionUpdate(replaceRules)` 更新 session snapshot。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-settings.test.ts src/__tests__/permission/auto-classifier-model-policy.test.ts src/__tests__/regression/build-mode-permission.test.ts src/__tests__/cli.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/config src/index.ts src/__tests__/permission/auto-settings.test.ts src/__tests__/regression/build-mode-permission.test.ts
git commit -m "feat: add safe permission config sources"
```

---

### Task 10: Streaming 并发、保序与级联（A50-A56）

**Files:**

- Modify: `src/agent/streaming-executor.ts`
- Test: `src/__tests__/agent/streaming-executor-auto.test.ts`

**Interfaces:**

- Produces: schema 未确认 concurrency safe 时视为 unsafe；mode 不参与并发分类。

- [ ] **Step 1: 写 barrier 行为测试**

```ts
describe('streaming executor safety', () => {
  test('[A50] safe tools both start before either barrier releases', async () => {
    const first = deferred<string>(); const second = deferred<string>(); const started: string[] = []
    const executor = makeStreamingExecutor({
      read_file: async () => { started.push('read'); return first.promise },
      grep: async () => { started.push('grep'); return second.promise },
    })
    executor.addTool(call('1', 'read_file')); executor.addTool(call('2', 'grep'))
    await until(() => started.length === 2)
    expect(started).toEqual(['read', 'grep'])
    first.resolve('r'); second.resolve('g')
  })

  test('[A51] unsafe tool excludes every sibling until released', async () => {
    const write = deferred<string>(); const read = vi.fn().mockResolvedValue('r')
    const executor = makeStreamingExecutor({ write_file: () => write.promise, read_file: read })
    executor.addTool(call('1', 'write_file')); executor.addTool(call('2', 'read_file'))
    await nextMicrotask(); expect(read).not.toHaveBeenCalled()
    write.resolve('w'); await until(() => read.mock.calls.length === 1)
  })

  test('[A52] results yield in tool-call order even when second finishes first', async () => {
    const first = deferred<string>(); const second = deferred<string>(); const executor = pairedExecutor(first, second)
    second.resolve('second'); first.resolve('first')
    expect(await collectOutputs(executor)).toEqual(['first', 'second'])
  })

  test('[A53] read failure does not abort a safe sibling', async () => {
    const sibling = vi.fn().mockResolvedValue('ok')
    const results = await runPair(failingRead(), siblingRead(sibling))
    expect(results[0].status).toBe('failure'); expect(results[1].status).toBe('success')
    expect(sibling).toHaveBeenCalledOnce()
  })

  test('[A54] Bash failure aborts unfinished siblings', async () => {
    const sibling = abortAwareDeferred()
    await runPair(failingBash(), sibling.tool)
    expect(sibling.signal.aborted).toBe(true)
  })

  test('[A54] non-Bash unsafe failure does not abort unfinished siblings', async () => {
    const sibling = abortAwareDeferred()
    const pair = runPair(failingWrite(), sibling.tool)
    await until(() => sibling.started)
    expect(sibling.signal.aborted).toBe(false)
    sibling.resolve('ok')
    expect((await pair)[1].status).toBe('success')
  })

  test('[A55] malformed concurrency declaration is unsafe', () => {
    expect(isConcurrencySafe('plugin_tool', {}, malformedSchema())).toBe(false)
  })

  test('[A56] build and auto produce identical scheduling classes', () => {
    expect(scheduleClasses(calls(), 'build')).toEqual(scheduleClasses(calls(), 'auto'))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/agent/streaming-executor-auto.test.ts`

Expected: FAIL；至少 unsafe schema 或 Bash abort 行为尚未满足。

- [ ] **Step 3: 最小修改 executor**

保留现有 queue 与按输入顺序 yield。给 executing tool 关联 AbortController；只有 canonical `run_bash` execution failure abort sibling。其他 unsafe tool（包括写工具）failure 与 read failure 都只记录自身，不触发 sibling abort。并发判断不读取 permission mode。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/agent/streaming-executor-auto.test.ts src/__tests__/streaming-executor.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/agent/streaming-executor.ts src/__tests__/agent/streaming-executor-auto.test.ts
git commit -m "fix: enforce safe streaming concurrency"
```

---

### Task 11: API Retry 与工具单次执行（A57-A63）

**Files:**

- Modify: `src/agent/backoff.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/permission/classifier.ts`
- Test: `src/__tests__/agent/auto-retry.test.ts`
- Test: `src/__tests__/agent/tool-execution.test.ts`

**Interfaces:**

- Produces: `getRetryDelay(attempt, random, retryAfterMs?)`、`isRetryableApiError()`、`RetrySleeper.wait(delayMs, signal): Promise<void>`；classifier 与 foreground 共用 delay/error policy，但 classifier retry 固定使用 Task 4 已绑定模型。
- classifier retry 必须使用同一个 per-resolution `AbortSignal`：retry 期间该 signal 既传入 provider RPC，也传入 `retrySleeper.wait(delayMs, signal)`；abort 时 wait 立即终止（reject `AbortError`），后续 provider 调用次数不再增加，不进 Stage 2/gate/executor。
- `AbortError` 不属于 retryable API error；provider RPC 本身因 signal abort 时同样不得 retry。
- foreground retry 保留既有 fallback-model 语义；classifier 永不跨模型 fallback。

- [ ] **Step 1: 写 A57-A62 测试**

```ts
describe('auto API retry', () => {
  test('[A57] side-effect tool failure executes exactly once', async () => {
    const write = vi.fn().mockRejectedValue(new Error('disk'))
    await executeToolCall(registryWith(write), writeCall(), allowedRuntime())
    expect(write).toHaveBeenCalledOnce()
  })

  test('[A58] ordinary 400 is not retryable', () => {
    expect(isRetryableApiError(httpError(400, 'bad request'))).toBe(false)
    expect(isRetryableApiError(httpError(400, 'context overflow'))).toBe(true)
  })

  test('[A59] base caps at 32s, jitter stays below 40s, Retry-After wins', () => {
    expect(getRetryDelay(20, () => 0)).toBe(32_000)
    expect(getRetryDelay(20, () => 0.999)).toBeGreaterThan(39_000)
    expect(getRetryDelay(20, () => 0.999)).toBeLessThan(40_000)
    expect(getRetryDelay(0, () => 0.5, 7_000)).toBe(7_000)
  })

  test('[A60] classifier 529 uses the same retry schedule as foreground', async () => {
    const classifierRun = await runClassifierWith([http529(), success('ALLOW')], { boundModel: 'classifier-model' })
    expect(classifierRun.delays).toEqual((await runForegroundWith([http529(), success()])).delays)
    expect(classifierRun.models).toEqual(['classifier-model', 'classifier-model'])
  })

  test('[A61] streaming reconnect keeps the current attempt number', async () => {
    const trace = await runStreamingReconnect({ initialAttempt: 2, errors: [http529(), success()] })
    expect(trace.retryAttempts).toEqual([2, 3])
  })

  test('[A62] foreground fallback activates after three 529s but classifier never switches', async () => {
    expect((await runWithFallback([http529(), http529(), success()])).models).toEqual(['primary', 'primary', 'primary'])
    expect((await runWithFallback([http529(), http529(), http529(), success()])).models.at(-1)).toBe('fallback')
    const classifierRun = await runClassifierWith(
      [http529(), http529(), http529(), http529()],
      { boundModel: 'classifier-model', fallbackModel: 'forbidden-fallback' },
    )
    expect(classifierRun.models).toEqual(Array(classifierRun.models.length).fill('classifier-model'))
    expect(classifierRun.decision.behavior).toBe('deny')
  })

  test('[A63] exhausted classifier retry stays on the bound model then denies', async () => {
    const result = await runClassifierWith(
      [http529(), http529(), http529(), http529()],
      { boundModel: 'classifier-model', fallbackModel: 'forbidden-fallback' },
    )
    expect(result.models).toEqual(Array(result.models.length).fill('classifier-model'))
    expect(result.decision).toMatchObject({
      behavior: 'deny', reason_code: 'permission.classifier_unavailable',
    })
  })

  test('AbortError is not a retryable API error', () => {
    expect(isRetryableApiError(abortError())).toBe(false)        // signal abort 不触发 retry
  })

  test('classifier 529 backoff aborted mid-wait: retry wait terminates, no further provider call, no Stage 2/gate/executor', async () => {
    // classifier 收到 529 进入 backoff；abort signal 后 retry wait 立即终止。
    const sleeper = deferredSleeper()                            // 控制 retrySleeper.wait 的 deferred
    const provider = scriptedProvider([http529()])               // 第一次 RPC -> 529，随后进入 backoff wait
    const controller = new AbortController()
    const run = runClassifierWithProvider(provider, {
      boundModel: 'classifier-model', signal: controller.signal, retrySleeper: sleeper,
    })
    await until(() => provider.calls.length === 1)               // 第一次 provider 调用已发生（529）
    await until(() => sleeper.pendingWaits === 1)                // 已进入 retry wait
    controller.abort()                                           // abort 同一 per-resolution signal
    const result = await run
    expect(provider.calls).toHaveLength(1)                       // 后续 provider 调用次数不增加
    expect(result.invokedStage2).toHaveLength(0)                 // 不启动 Stage 2
    expect(result.gateCalls).toBe(0)                             // 不进入 gate
    expect(result.executorCalls).toBe(0)                         // 不进入 executor
    expect(result.decision.behavior).toBe('deny')
    expect(sleeper.abortedWaits).toBe(1)                         // retry wait 因 abort 立即终止
  })

  test('provider RPC itself aborted via signal is not retried', async () => {
    // provider RPC 因 signal abort 抛 AbortError 时，同样不得 retry。
    const provider = scriptedProvider([abortRpcError()])         // provider 直接因 abort 失败
    const controller = new AbortController()
    const run = runClassifierWithProvider(provider, {
      boundModel: 'classifier-model', signal: controller.signal,
    })
    controller.abort()
    const result = await run
    expect(provider.calls).toHaveLength(1)                       // 不 retry
    expect(result.invokedStage2).toHaveLength(0)
    expect(result.decision.behavior).toBe('deny')
  })

  test('unaborted classifier retry still uses the same bound ModelRef and never cross-model fallbacks', async () => {
    const result = await runClassifierWith(
      [http529(), http529(), success('ALLOW')],
      { boundModel: 'classifier-model', fallbackModel: 'forbidden-fallback' },
    )
    expect(result.models).toEqual(['classifier-model', 'classifier-model', 'classifier-model'])
    expect(result.decision.behavior).toBe('allow')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/agent/auto-retry.test.ts src/__tests__/agent/tool-execution.test.ts`

Expected: FAIL；当前 backoff 是 30 秒 full jitter、没有 Retry-After 分类，也没有 classifier retry 固定 bound model 的保护，且 retry wait 不可取消、`AbortError` 未被排除在 retryable 之外。

- [ ] **Step 3: 实现共享 API policy**

`base = min(1000 * 2 ** attempt, 32000)`；无 Retry-After 时 `floor(base + random() * 0.25 * base)`；Retry-After 取非负服务端值。工具执行函数不包重试器。`RetrySleeper.wait(delayMs, signal)` 在 signal 已 aborted 或被 abort 时立即 reject `AbortError`（不等待剩余 delay）。classifier retry loop 把同一个 per-resolution `AbortSignal` 同时传给 provider RPC 和 `retrySleeper.wait(delayMs, signal)`；abort 时 wait 立即终止，后续 provider 调用不再增加，分类结果 fail-closed deny，不进 Stage 2/gate/executor。`isRetryableApiError()` 明确排除 `AbortError`；provider RPC 因 signal abort 失败时同样不 retry。foreground 保留既有 fallback-model 语义；classifier 只复用 backoff/error classification，所有 retry 继续传同一个已绑定 `ModelRef`，耗尽后 deny，永不跨模型 fallback，禁止调用 foreground fallback selector。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/agent/auto-retry.test.ts src/__tests__/permission/auto-classifier.test.ts src/__tests__/agent/tool-execution.test.ts src/__tests__/agent-loop.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/agent/backoff.ts src/agent/streaming-query.ts src/agent/loop.ts src/permission/classifier.ts src/__tests__/agent
git commit -m "fix: separate API retry from tool execution"
```

---

### Task 12: Prompt Plane 与 Attachments（A74-A80）

**Files:**

- Modify: `src/agent/prompt/registry.ts`
- Modify: `src/agent/prompt/resolution.ts`
- Modify: `src/index.ts`
- Test: `src/__tests__/permission/auto-prompt-attachments.test.ts`

**Interfaces:**

- Consumes: Task 4 `buildClassifierPromptPrefix()` / `renderClassifierRuleSections()`，Task 9 `projectClassifierConfigSources()`。
- Produces: dynamic `auto_mode_exit` attachment、protected settings prompt boundary；normal Agent prompt 与 classifier stage prompt 保持物理隔离。

- [ ] **Step 1: 写 A74-A80 失败测试**

```ts
describe('auto prompt and attachments', () => {
  test('[A74] mode switch does not change static system prompt hash', () => {
    expect(compilePromptForMode('build').staticHash).toBe(compilePromptForMode('auto').staticHash)
  })

  test('[A75] auto exit emits one dynamic attachment per session transition', () => {
    const state = autoSession(); state.exitAuto(); state.exitAuto()
    expect(state.takeAttachments()).toEqual([{ type: 'auto_mode_exit' }])
    expect(state.takeAttachments()).toEqual([])
  })

  test('[A76] dynamic attachment changes dynamic hash only', () => {
    const before = compilePrompt({ attachments: [] })
    const after = compilePrompt({ attachments: [{ type: 'auto_mode_exit' }] })
    expect(after.staticHash).toBe(before.staticHash)
    expect(after.dynamicHash).not.toBe(before.dynamicHash)
  })

  test('[A77] auto protected-setting write reaches classifier after safety ask', async () => {
    const classifier = classifierStub(denyDecision())
    const evaluation = vi.fn()
    await resolver({ classifier, evaluation }).resolve(protectedSettingsAsk({ classifierApprovable: true }))
    expect(classifier.classify).toHaveBeenCalledOnce()
    expect(evaluation).not.toHaveBeenCalled()
  })

  test('[A78] bypass cannot approve protected settings', () => {
    expect(checker().checkWithEvaluationMode('write_file', { path: '.micode/config.json' }, 'bypassPermissions').behavior)
      .toBe('ask')
  })

  test('[A79] only trusted user/local/flag/policy sources affect classifier prompt', () => {
    const rules = projectClassifierConfigSources(allRuleSources()).rules
    const prompt = buildClassifierPromptPrefix(classifierInput(), rules)
    expect(prompt).toContain('USER_RULE')
    expect(prompt).toContain('LOCAL_RULE')
    expect(prompt).toContain('FLAG_RULE')
    expect(prompt).toContain('POLICY_RULE')
    expect(prompt).not.toContain('PROJECT_RULE')
    expect(prompt).not.toContain('COMMAND_RULE')
    expect(prompt).not.toContain('SESSION_RULE')
    expect(prompt).not.toContain('CLI_ARG_RULE')
    expect(prompt).not.toContain('SDK_RULE')
    expect(prompt).not.toContain('TOOL_OUTPUT_RULE')
  })

  test('[A80] non-empty user section replaces defaults; empty uses defaults', () => {
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: ['U'] })).toEqual(['U', 'O'])
    expect(renderClassifierRuleSections({ defaults: ['D'], organization: ['O'], user: [] })).toEqual(['D', 'O'])
  })

  test('classifier stage prompts never enter the normal Agent prompt', () => {
    const agentPrompt = compilePromptForMode('auto').text
    expect(agentPrompt).not.toContain(STAGE1_INSTRUCTION)
    expect(agentPrompt).not.toContain(STAGE2_INSTRUCTION)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-prompt-attachments.test.ts`

Expected: FAIL；当前无 auto exit attachment、classifier trusted-config projection 与 Agent/classifier prompt plane 隔离。

- [ ] **Step 3: 实现 plane 隔离**

mode 不进入 static system sections。auto exit 写 dynamic attachment queue。classifier rules 先经 Task 9 source filter，再由 Task 4 独立 renderer 写入固定 classifier prefix；Stage 1/2 instruction 不注册到 Agent prompt registry，也不产生正常 message/TUI 输出。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-prompt-attachments.test.ts src/__tests__/agent/profiled-prompt-compilation.test.ts src/__tests__/agent/prompt-condition-scope.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/agent/prompt src/index.ts src/__tests__/permission/auto-prompt-attachments.test.ts
git commit -m "feat: isolate auto prompt attachments"
```

---

### Task 13: 脱敏权限审计（A86-A87）

**Files:**

- Create: `src/permission/audit.ts`
- Modify: `src/agent/observability/decision-trace.ts`
- Modify: `src/permission/runtime-gate.ts`
- Test: `src/__tests__/permission/auto-audit.test.ts`

**Interfaces:**

- Produces: `logPermissionDecision()`、`PermissionAuditEvent`；每个最终 decision 一个 result event。

- [ ] **Step 1: 写 A86-A87 失败测试**

```ts
describe('permission audit', () => {
  test('[A86] every final decision emits exactly one sourced result event', async () => {
    const sink = memoryAuditSink()
    await authorizeWithAudit(classifierAllowDecision(), sink)
    expect(sink.events.filter(e => e.phase === 'result')).toHaveLength(1)
    expect(sink.events[0]).toMatchObject({ behavior: 'allow', source: 'classifier', toolName: 'write_file' })
  })

  test('[A87] audit excludes commands, content, raw paths and classifier prompt', () => {
    const event = buildAuditEvent(decisionFor({
      command: 'cat secret.txt', path: 'C:/secret.txt', content: 'token', classifierPrompt: 'private',
    }))
    const json = JSON.stringify(event)
    expect(json).not.toContain('cat secret.txt')
    expect(json).not.toContain('C:/secret.txt')
    expect(json).not.toContain('token')
    expect(json).not.toContain('private')
    expect(event).toEqual(expect.objectContaining({ decisionId: expect.any(String), reasonCode: expect.any(String) }))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-audit.test.ts`

Expected: FAIL；auto audit fan-out 不存在。

- [ ] **Step 3: 实现审计 allowlist**

事件字段固定为 decision ID、canonical tool、behavior、reason code、source、latency bucket、phase。`runtimeGate.authorize()` 在最终结果确定后调用一次 result sink；observer 异常只记本地诊断，不改变授权。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/__tests__/permission/auto-audit.test.ts src/__tests__/agent/decision-trace.test.ts src/__tests__/agent/telemetry-redaction.test.ts`

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/permission/audit.ts src/permission/runtime-gate.ts src/agent/observability/decision-trace.ts src/__tests__/permission/auto-audit.test.ts
git commit -m "feat: add redacted permission audit"
```

---

### Task 14: Compatibility Corpus 与 Shadow Cutover（A83、A85）

**Files:**

- Modify: `src/index.ts`
- Create: `src/__tests__/permission/fixtures/auto-compat-corpus.ts`
- Create: `src/__tests__/permission/auto-shadow.test.ts`
- Modify: `src/__tests__/regression/unified-tool-execution-paths.test.ts`

**Interfaces:**

- Produces: `AUTO_PERMISSION_AUTHORITY=legacy|shadow|enforced`、`resolveAuthority(envValue)`；matrix 不参与运行时验证。

- [ ] **Step 1: 写 authority resolution、兼容与 shadow 断言**

```ts
describe('auto permission cutover', () => {
  test('authority default and explicit resolution are deterministic', () => {
    expect(resolveAuthority(undefined)).toBe('enforced')           // env unset -> enforced
    expect(resolveAuthority('legacy')).toBe('legacy')              // 显式诊断模式
    expect(resolveAuthority('shadow')).toBe('shadow')              // 显式迁移模式
    expect(resolveAuthority('enforced')).toBe('enforced')          // 正式权限链
    // 非法显式值 fail-safe 到 enforced，不静默回到会放行的 legacy
    expect(resolveAuthority('LEGACY')).toBe('enforced')
    expect(resolveAuthority('experimental')).toBe('enforced')
    expect(resolveAuthority('  enforced  ')).toBe('enforced')      // 合法值 trim 后识别
  })

  test('[A83] compatibility corpus preserves expected build/plan/security decisions', async () => {
    for (const sample of AUTO_COMPAT_CORPUS) {
      const result = await evaluatePermissionSample(sample, 'enforced')
      expect(result.decision, sample.id).toEqual(sample.expectedDecision)
      expect(result.executorCalls, sample.id).toBe(sample.expectedExecutorCalls)
    }
  })

  test('[A85] shadow records disagreement but returns legacy authority', async () => {
    const result = await evaluateAuthority('shadow', {
      legacy: allowDecision(), candidate: denyDecision(),
    })
    expect(result.authoritative.behavior).toBe('allow')
    expect(result.observations).toContainEqual(expect.objectContaining({
      kind: 'permission_disagreement', legacy: 'allow', candidate: 'deny',
    }))
  })

  test('[A85] candidate failure in shadow cannot change or broaden legacy result', async () => {
    const result = await evaluateAuthority('shadow', {
      legacy: denyDecision(), candidate: Promise.reject(new Error('candidate failed')),
    })
    expect(result.authoritative.behavior).toBe('deny')
    expect(result.observations).toContainEqual(expect.objectContaining({ kind: 'candidate_error' }))
  })

  test('production default uses enforced (new permission chain) when env unset', async () => {
    // 证明：env 未设置时，正常 auto 走新权限链（resolver + classifier + gate），不经 legacy fast-path。
    delete process.env.AUTO_PERMISSION_AUTHORITY
    const chain = buildProductionChain()           // 解析 authority 并接线
    expect(chain.authority).toBe('enforced')
    expect(chain.usesLegacyFastPath).toBe(false)
    expect(chain.usesResolverAndClassifier).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/permission/auto-shadow.test.ts`

Expected: FAIL；authority resolution（默认 enforced + 非法值 fail-safe）、authority gate 与 compatibility corpus 不存在。

- [ ] **Step 3: 实现 cutover gate**

`resolveAuthority(envValue)`：`undefined`/空串 -> `enforced`（正式完成本计划后默认走新权限链）；显式 `'legacy'` / `'shadow'` / `'enforced'`（trim 后）按值返回；任何其他显式值 fail-safe 到 `enforced`，不静默回到会直接放行的 `legacy`。`legacy`、`shadow` 只作为显式诊断/迁移模式，默认生产路径必须是 `enforced`。legacy 不构造 classifier；shadow 求 candidate 但始终返回 legacy；enforced 返回 candidate。corpus 至少含 build read/write、plan read/write、危险 Bash、工作区外路径、session remember、subagent、MCP server rule、两条 provider 执行路径。`src/index.ts` 启动时调用 `resolveAuthority(process.env.AUTO_PERMISSION_AUTHORITY)` 并接线对应 chain。

- [ ] **Step 4: 全量验证**

Run L1: `npx vitest run src/__tests__/permission/ src/__tests__/agent/auto-retry.test.ts src/__tests__/agent/streaming-executor-auto.test.ts`

Run L2: `npx vitest run src/__tests__/regression/`

Run L3: `npm run typecheck && npm run lint && npm test && npm run build`

Expected: 所有命令 exit 0；无 unused、floating promise、prompt generation drift；reference spec 未被修改。

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/__tests__/permission src/__tests__/regression/unified-tool-execution-paths.test.ts
git commit -m "test: gate auto permission cutover"
```

---

### Task 15: Post-implementation corrective — enforced+auto run_bash classifier 强制不变量（设计 §6.4）

> 本任务是**独立小修复**，不重新执行原 Task 1-14。
>
> 起因：原计划只保护 `PermissionChecker` 返回 `ask` 的 resolver 路径，未覆盖 `PermissionChecker` 直接返回 `allow`（ordinary/persistent allow rule）以及 `executeToolCall` 在 checker 之后把 `ask` 改写为 `allow`（sessionAllowlist / subagent silent policy）的 bypass。这使 enforced+auto+canonical `run_bash` 可在 `PermissionClassifier` 零调用下执行，违反设计 §6.4 产品契约。
>
> 已批准契约（权威设计 §6.4）：在 `AUTO_PERMISSION_AUTHORITY=enforced` 下，auto 模式的 canonical `run_bash` 除同步阶段已经产生的最终 `deny` 外，任何进入 `RuntimeSecurityGate`/executor 的 allow 必须携带"当前 executable tool call 已经由 `PermissionClassifier` ALLOW"的事实。
>
> 三锚点（缺一即漏，全部在 `executeToolCall` 内 authority-gated）：
> 1. **锚点 1（allow→ask 降级）**：`executeToolCall` 在 `checkDecision` 后，对 `authority==='enforced' && mode==='auto' && run_bash && behavior==='allow'` 降级为 `ask`，reason_code `permission.auto_run_bash_requires_classifier`；deny 不降级。**checker 本体零修改**（它是 legacy/shadow/enforced 共用单例，无 authority 概念）。
> 2. **锚点 2（resolver 短路）**：canonical `run_bash` ask 走 resolver 第 8 步短路直进 `resolveByClassifier`，跳过 allowlist + acceptEdits simulation。resolver 只在 enforced/shadow 构造；shadow 返回 legacy decision 不受影响。
> 3. **锚点 3（rewrite 失效）**：sessionAllowlist `rewriteToAllow`、`applySubagentSilentPolicy` 对 enforced+auto+`run_bash` 失效，保持 ask 进 resolver/classifier。
>
> 不变量只锁定 enforced（由 `runtime.authority==='enforced'` gating，`createExecutionRuntimeForTurn` 唯一赋值）。legacy/shadow 与非 `run_bash` 工具行为不变。

**Files:**

- Modify: `src/agent/tool-execution.ts`（authority-gated run_bash allow→ask 降级 + sessionAllowlist/subagent rewrite 失效守卫；`ToolExecutionRuntime` 增 `authority` 字段）
- Modify: `src/permission/ask-resolver.ts`（canonical run_bash ask → resolveByClassifier 短路）
- Modify: `src/permission/authority-gate.ts`（`createExecutionRuntimeForTurn` 在返回的 runtime 上设 `authority`）
- Test: `src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`（新建，唯一新增测试文件）

**Interfaces:**

- Produces: 新增 reason_code `permission.auto_run_bash_requires_classifier`（`tool-execution.ts` 导出常量 `AUTO_RUN_BASH_REQUIRES_CLASSIFIER`）；`ToolExecutionRuntime` 增可选字段 `authority?: PermissionAuthority`。
- Consumes: 现有 `PermissionChecker.checkDecision`（不改 checker 本体）、`DefaultPermissionAskResolver.resolve`（固定顺序）、`executeToolCall` origin 路由 if/else 链、`createExecutionRuntimeForTurn`（唯一设置 authority 的入口）。

> **authority 隔离的关键设计决策（§6.4 enforced-only）：**
>
> `PermissionChecker` 是进程级单例，被 legacy/shadow/enforced 三种 authority 共用，且**没有 authority 概念**。如果把 run_bash allow→ask 降级放进 checker（按 `mode==='auto' && run_bash`），会同时改变 legacy 与 shadow 的行为——legacy 下本应 allow 的 run_bash 变成 ask（无法执行），shadow 下 legacy authoritative decision 从 allow 变成 ask（违反 A85"shadow 最终授权由 legacy 决定"）。
>
> 因此**三个锚点全部不在 checker 内实现**，而是集中在 `executeToolCall`——唯一能感知 authority 的生产节点（经新字段 `runtime.authority`，由 `createExecutionRuntimeForTurn` 设置）。checker 本体零修改，保持 legacy/shadow 既有 `checkDecision` 行为不变。
>
> shadow 的正确语义：candidate classifier 仍跑（观察），但 effective decision 来自 checker 原始结果；anchor 守卫只在 `authority==='enforced'` 时触发，shadow 的 allow 不被降级。

- [ ] **Step 1: 写 RED 测试集（7 组真实生产链断言）**

新建 `src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`。关键约束：**禁止**用对 `run_bash` 返回 ask 的 `evaluateWithMode` stub；必须用真实 `PermissionChecker` + 真实 `DefaultPermissionAskResolver`（经 `createExecutionRuntimeForTurn` 或等价接线）+ 真实 `executeToolCall` + 真实 `RuntimeSecurityGate`。classifier 用 spy（只替换 provider 文本返回），executor 用 spy。

```ts
// 设计 §6.4 三锚点不变量的真实生产链证明。
// 严禁：用 evaluateWithMode → ask 的 stub 绕过真实 checker 行为。
// 必须用真实 PermissionChecker + 真实 DefaultPermissionAskResolver + 真实 executeToolCall。
//
// classifier 两阶段协议（设计 §7.2 / classifier.ts）：
//   Stage 1 completeText -> 'ALLOW' | 'FLAG'；ALLOW 直接 allow（Stage2=0）；FLAG 触发 Stage2。
//   Stage 2 completeText -> 'ALLOW' | 'DENY'。
// 故 spy 按调用序返回：第 1 次返 stage1，第 2 次（仅 FLAG 时）返 stage2。
import { describe, test, expect, vi } from 'vitest';
import { PermissionChecker, type PermissionRule } from '../../permission/checker.js';
import { RuntimeSecurityGate, type PendingDecisionStore, type PendingSecurityDecision } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { executeToolCall } from '../../agent/tool-execution.js';
import { createExecutionRuntimeForTurn, type TurnRuntimeDeps } from '../../permission/authority-gate.js';
import type { StreamingLLMClient, StreamEvent, AssistantMessage, ToolUseBlock } from '../../agent/types.js';

/**
 * classifier provider spy。按 classifier 两阶段协议返回。
 * - outcome='allow'：Stage1='ALLOW'（1 次 completeText）。
 * - outcome='deny'：Stage1='FLAG' -> Stage2='DENY'（2 次 completeText）。
 */
class ClassifierSpyClient implements StreamingLLMClient {
  completeTextCalls = 0;
  constructor(private readonly outcome: 'allow' | 'deny') {}
  async completeText(): Promise<string> {
    this.completeTextCalls++;
    // 第 1 次 = Stage1；outcome=allow -> 'ALLOW'；outcome=deny -> 'FLAG'（触发 Stage2）
    if (this.completeTextCalls === 1) return this.outcome === 'allow' ? 'ALLOW' : 'FLAG';
    // 第 2 次 = Stage2（仅 FLAG 时到达）；outcome=deny -> 'DENY'
    return 'DENY';
  }
  async *stream(): AsyncGenerator<StreamEvent | AssistantMessage> {
    yield { type: 'message_start', messageId: 'm', model: 'f', inputTokens: 1 };
    yield { type: 'message_stop' };
  }
}
class FakePendingStore implements PendingDecisionStore {
  async save(): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}

function runBashCall(command: string, id = 'c1'): ToolUseBlock {
  return { type: 'tool_use', id, name: 'run_bash', input: { command } };
}
function writeCall(): ToolUseBlock {
  return { type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'src/a.ts', content: 'x' } };
}
function bashRegistry(executor: ReturnType<typeof vi.fn>): ToolRegistry {
  const r = new ToolRegistry();
  r.register(
    { name: 'run_bash', description: 'b', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    executor,
  );
  r.register(
    { name: 'write_file', description: 'w', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
    async () => 'ok',
  );
  return r;
}
function makeDeps(overrides: Partial<TurnRuntimeDeps> = {}): TurnRuntimeDeps {
  const streamClient = new ClassifierSpyClient('allow');
  const permissionChecker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
  const sessionAllowlist = new SessionAllowlist();
  const sessionState = new SessionState(sessionAllowlist, 's1');
  const runtimeGate = new RuntimeSecurityGate({ pendingStore: new FakePendingStore(), channel: null });
  return {
    authority: 'enforced',
    streamClient: streamClient as unknown as StreamingLLMClient,
    providerId: 'test', modelId: 'test-model',
    permissionChecker, runtimeGate, sessionAllowlist, sessionState,
    hooks: [],
    ...overrides,
  };
}
/**
 * 构造 legacy runtime（无 resolver，复用 createExecutionRuntimeForTurn(authority:'legacy')）。
 * legacy 下 askResolver undefined；run_bash 走既有 fast-path。
 */
function makeLegacyRuntime(overrides: Partial<TurnRuntimeDeps> = {}): ToolExecutionRuntime {
  const deps = makeDeps({ authority: 'legacy', ...overrides });
  return createExecutionRuntimeForTurn(deps);
}
/** classifier 被"调用过"的断言助手：completeText 至少 1 次（allow=1，deny=2）。 */
function expectClassifierInvoked(spy: ClassifierSpyClient) {
  expect(spy.completeTextCalls).toBeGreaterThanOrEqual(1);
}
function expectClassifierNotInvoked(spy: ClassifierSpyClient) {
  expect(spy.completeTextCalls).toBe(0);
}

describe('[§6.4] enforced+auto canonical run_bash 必经 classifier', () => {
  test('组1 普通 unresolved run_bash：classifier ALLOW → classifier invoked, gate=1, executor=1', async () => {
    const deps = makeDeps();           // ClassifierSpyClient('allow') -> Stage1 ALLOW
    const spy = deps.streamClient as unknown as ClassifierSpyClient;
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
    });
    expect(result.status).toBe('success');
    expectClassifierInvoked(spy);              // 未被任何本地 allow 绕过
    expect(executor).toHaveBeenCalledOnce();
  });

  test('组1 普通 unresolved run_bash：classifier DENY → classifier invoked, executor=0', async () => {
    const deps = makeDeps({ streamClient: new ClassifierSpyClient('deny') as unknown as StreamingLLMClient });
    const spy = deps.streamClient as unknown as ClassifierSpyClient;
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);
    expect(executor).not.toHaveBeenCalled();
  });

  test('组1 sanity：真实 checkWithEvaluationMode(run_bash, acceptEdits) 当前确实返回 allow', () => {
    // 钉死根因行为：acceptEdits simulation 对 run_bash 会返回 allow。
    // 若未来 checker 改成对 run_bash 不 allow，本测试会先失败，提示此不变量的根因前提已变。
    const checker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
    const sim = checker.checkWithEvaluationMode('run_bash', { command: 'echo hi' }, 'acceptEdits');
    expect(sim.behavior).toBe('allow');
  });

  test('组2 persistent run_bash allow rule：build 模式直接执行（classifier 未调用）', async () => {
    // 回归：build 模式下 persistent allow rule 仍直接生效，本次修复只对 auto 生效。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const checker = new PermissionChecker({ mode: 'build', rules: [rule], workdir: process.cwd() });
    const spy = new ClassifierSpyClient('allow');
    const runtimeGate = new RuntimeSecurityGate({ pendingStore: new FakePendingStore(), channel: null });
    const sessionAllowlist = new SessionAllowlist();
    // build 模式不走 enforced resolver；用 legacy runtime 验证 classifier 未被调用
    const runtime = { permissionChecker: checker, runtimeGate, sessionAllowlist };
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime);
    expect(result.status).toBe('success');
    expect(executor).toHaveBeenCalledOnce();
    expectClassifierNotInvoked(spy);           // build 模式不经 classifier
  });

  test('组2 persistent run_bash allow rule：enforced+auto 不能直接执行，classifier invoked，DENY→executor=0', async () => {
    // 本轮最关键回归：捕获 resolver 完全看不到的 bypass。
    // 真实 checker 注入可命中的 run_bash allow rule，enforced+auto 下仍必须进 classifier。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const checker = new PermissionChecker({ mode: 'auto', rules: [rule], workdir: process.cwd() });
    // sanity：build 模式下该 rule 确实 allow（证明 rule 可命中）
    const buildCheck = new PermissionChecker({ mode: 'build', rules: [rule], workdir: process.cwd() });
    expect(buildCheck.check('run_bash', { command: 'git status' }).behavior).toBe('allow');

    const spy = new ClassifierSpyClient('deny');
    const deps = makeDeps({
      permissionChecker: checker,
      streamClient: spy as unknown as StreamingLLMClient,
    });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime, {
      messages: [{ role: 'user', content: 'run git status', authoredByUser: true }],
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);              // persistent allow 未直接放行
    expect(executor).not.toHaveBeenCalled();
  });

  test('组3 sessionAllowlist bypass：exact 命中仍 classifier invoked，DENY→executor=0', async () => {
    const spy = new ClassifierSpyClient('deny');
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    // 预写 session allow（exact match）
    deps.sessionAllowlist.add('run_bash', { command: 'ls' });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('ls'), runtime, {
      messages: [{ role: 'user', content: 'run ls', authoredByUser: true }],
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);              // sessionAllowlist rewrite 被守卫拦
    expect(executor).not.toHaveBeenCalled();
  });

  test('组4 subagent bypass：origin=subagent 共享 parent askResolver，classifier invoked，DENY→executor=0', async () => {
    const spy = new ClassifierSpyClient('deny');
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn();
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
      origin: 'subagent',
    });
    expect(result.status).toBe('failure');
    expectClassifierInvoked(spy);              // subagent silent policy 未静默 allow
    expect(executor).not.toHaveBeenCalled();
  });

  test('组4 subagent：classifier ALLOW → executor=1', async () => {
    const spy = new ClassifierSpyClient('allow');
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('echo hi'), runtime, {
      messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }],
      origin: 'subagent',
    });
    expect(result.status).toBe('success');
    expectClassifierInvoked(spy);
    expect(executor).toHaveBeenCalledOnce();
  });

  test('组5 非 run_bash 回归：write_file 保留 acceptEdits fast-path（classifier 未调用）', async () => {
    const spy = new ClassifierSpyClient('deny');   // 即便 deny，write_file 也不应进 classifier
    const deps = makeDeps({ streamClient: spy as unknown as StreamingLLMClient });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('ok');
    const result = await executeToolCall(bashRegistry(executor), writeCall(), runtime, {
      messages: [{ role: 'user', content: 'edit file', authoredByUser: true }],
    });
    expect(result.status).toBe('success');
    expectClassifierNotInvoked(spy);           // write_file acceptEdits fast-path 未被误删
    expect(executor).toHaveBeenCalledOnce();
  });

  // ─── 组6/7：legacy / shadow authority 回归（§6.4 enforced-only）─────────────
  // 关键：本次修复不得改变 legacy/shadow 的既有行为。
  // legacy：无 resolver，run_bash allow rule 直接执行（classifier 未调用）。
  // shadow：candidate classifier 跑（观察），但 effective decision = checker 原始 allow（执行）。

  test('组6 legacy + auto + run_bash allow rule：直接执行，classifier 未调用（行为不变）', async () => {
    // 注入可命中的 run_bash allow rule，authority=legacy。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const spy = new ClassifierSpyClient('deny');   // 即便 candidate 会 deny，legacy 不应跑 classifier
    const checker = new PermissionChecker({ mode: 'auto', rules: [rule], workdir: process.cwd() });
    const runtime = makeLegacyRuntime({
      permissionChecker: checker,
      streamClient: spy as unknown as StreamingLLMClient,
    });
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime);
    expect(result.status).toBe('success');
    expect(executor).toHaveBeenCalledOnce();
    expectClassifierNotInvoked(spy);           // legacy 不经 classifier（无 resolver）
  });

  test('组7 shadow + auto + run_bash allow rule：legacy authoritative，执行不变（classifier 未触发）', async () => {
    // shadow：checker allow → effective allow（执行）。checker 返回 allow 而非 ask，
    // resolver 不被调用，candidate classifier 也不跑（与 legacy 同路径）。
    // 本次修复不改变 shadow：authority!=='enforced' → 无降级守卫 → allow 直进 gate。
    const rule: PermissionRule = { tool: 'run_bash', behavior: 'allow', content: 'git status' };
    const spy = new ClassifierSpyClient('deny');   // 即便 candidate 会 deny，shadow 不应触发 classifier
    const checker = new PermissionChecker({ mode: 'auto', rules: [rule], workdir: process.cwd() });
    const deps = makeDeps({
      authority: 'shadow',
      permissionChecker: checker,
      streamClient: spy as unknown as StreamingLLMClient,
    });
    const runtime = createExecutionRuntimeForTurn(deps);
    const executor = vi.fn().mockResolvedValue('done');
    const result = await executeToolCall(bashRegistry(executor), runBashCall('git status'), runtime, {
      messages: [{ role: 'user', content: 'run git status', authoredByUser: true }],
    });
    // shadow authoritative = checker allow → 执行（未被降级，因 authority!=='enforced'）
    expect(result.status).toBe('success');
    expect(executor).toHaveBeenCalledOnce();
    expectClassifierNotInvoked(spy);           // checker allow → resolver 不触发 → candidate 不跑
  });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`

Expected: FAIL。具体失败原因（实现前真实行为）：
- 组1 ALLOW/DENY：`completeTextCalls` 期望 ≥1，实际 0（acceptEdits simulation 提前 allow，resolver 不进 classifier）；`sanity` 测试单独会 PASS（钉死根因前提）。
- 组2 enforced+auto+persistent：`completeTextCalls` 期望 ≥1，实际 0（checker gate 5 ordinary allow 直接返回 allow；executeToolCall 无降级守卫，allow 直进 gate）。
- 组3 sessionAllowlist：`completeTextCalls` 期望 ≥1，实际 0（`rewriteToAllow` 把 ask 改写为 allow）。
- 组4 subagent：`completeTextCalls` 期望 ≥1，实际 0（`applySubagentSilentPolicy` 静默 allow）。
- 组5 write_file、组2 build：实现前应已 PASS（保护性回归）。
- 组6 legacy、组7 shadow：实现前应已 PASS（无降级守卫，行为与修复前一致）。

> 必须逐组确认失败原因与上表一致；组6/组7 在 RED 阶段必须 PASS——它们是"不得改变 legacy/shadow"的回归锚点。若组6/组7 在实现前 FAIL，说明测试 fixture 错把 legacy/shadow 当 enforced 处理，先修正 fixture。

- [ ] **Step 3: authority 隔离 wiring — `ToolExecutionRuntime.authority` 字段**

修改 `src/agent/tool-execution.ts`：

1. 在文件顶部新增导出常量（reason_code）：
```ts
/** enforced+auto 下 canonical run_bash 的 allow 降级 reason_code（设计 §6.4 锚点 1）。 */
export const AUTO_RUN_BASH_REQUIRES_CLASSIFIER = 'permission.auto_run_bash_requires_classifier';
```

2. 在 `ToolExecutionRuntime` interface 增可选字段（authority 唯一消费点是 Step 4 的锚点守卫）：
```ts
export interface ToolExecutionRuntime {
  permissionChecker: PermissionChecker;
  runtimeGate: RuntimeSecurityGate;
  callbacks?: ToolExecutionCallbacks;
  sessionAllowlist?: SessionAllowlist;
  askResolver?: PermissionAskResolver;
  /**
   * Task 15（设计 §6.4）：当前 turn 的 authority。
   * 由 createExecutionRuntimeForTurn 设置（唯一赋值点）；executeToolCall 据此判断
   * run_bash 强制 classifier 守卫是否生效。undefined 时按 legacy 处理（守卫不触发）。
   */
  authority?: PermissionAuthority;
}
```
import `PermissionAuthority` from `./permission/cutover.js`。

修改 `src/permission/authority-gate.ts`：

在 `createExecutionRuntimeForTurn` 的三个返回点都设 `authority`：
```ts
// legacy
return { ...base, authority: 'legacy' };
// enforced
return { ...base, askResolver: resolver, authority: 'enforced' };
// shadow
return { ...base, askResolver: createShadowResolver(resolver), authority: 'shadow' };
```

- [ ] **Step 4: 锚点 1 + 锚点 3 — executeToolCall authority-gated run_bash 强制 classifier**

修改 `src/agent/tool-execution.ts` 的 origin 路由 if/else 链（约 427-460 行）。**三个锚点合并为一处 authority-gated 守卫**，集中在 `checkDecision` 之后、`gate.execute` 之前。

helper（模块内私有）：
```ts
/** enforced+auto+canonical run_bash 必经 classifier（设计 §6.4）。 */
function isEnforcedAutoRunBash(
  runtime: ToolExecutionRuntime,
  call: ToolUseBlock,
): boolean {
  return (
    runtime.authority === 'enforced' &&
    runtime.permissionChecker.getMode() === 'auto' &&
    call.name === 'run_bash'
  );
}
```

**锚点 1（allow→ask 降级）**：在 `let effectiveDecision = decision;` 之后、现有 if/else 链之前，插入降级：
```ts
// 锚点 1（§6.4）：enforced+auto+run_bash 的 allow 不得直接进 gate，
// 降级为 ask（auto_run_bash_requires_classifier），交 resolver/classifier。
// legacy/shadow 不降级（authority !== 'enforced'），保持既有 checker 决策。
if (
  isEnforcedAutoRunBash(runtime, call) &&
  decision.behavior === 'allow'
) {
  effectiveDecision = {
    ...decision,
    behavior: 'ask',
    reason_code: AUTO_RUN_BASH_REQUIRES_CLASSIFIER,
    human_reason: 'Auto mode requires classifier for run_bash',
  };
}
```
> 注意：deny 不降级（同步阶段已产生最终 deny 可直接终止）；ask 不降级（已是 ask）。只降级 allow。降级后 decision 仍带原结构字段（action/protocol_version 等），后续 resolver/gate 能读 snapshot_id。

**锚点 3（rewrite 失效守卫）**：降级后的 effectiveDecision.behavior==='ask'，会进入现有 if/else 链。在分支 1 已被 askResolver 处理（enforced 下 askResolver 存在）。分支 2/3 加 `isEnforcedAutoRunBash` 守卫：
```ts
} else if (origin === 'subagent') {
  // 锚点 3 守卫：enforced+auto+run_bash 不得被 subagent silent policy 静默 allow。
  // （enforced 下 askResolver 存在时分支 1 已处理；此处 defense-in-depth。）
  effectiveDecision = isEnforcedAutoRunBash(runtime, call)
    ? effectiveDecision   // 保持降级后的 ask，交 gate fail-closed
    : applySubagentSilentPolicy(decision);
} else if (
  decision.behavior === 'ask' &&
  decision.reason_code === 'permission.user_confirmation_required' &&
  runtime.sessionAllowlist?.has(call.name, executorInput) === true
) {
  // 锚点 3 守卫：enforced+auto+run_bash 不得被 sessionAllowlist rewrite 绕过 classifier。
  effectiveDecision = isEnforcedAutoRunBash(runtime, call)
    ? effectiveDecision   // 保持降级后的 ask
    : rewriteToAllow(decision);
}
```

> legacy（authority undefined 或 'legacy'）：`isEnforcedAutoRunBash` 恒 false → 不降级、不守卫，checker 的 allow/deny/ask 原样进 gate。既有 subagent silent policy / sessionAllowlist rewrite 行为不变。
>
> shadow（authority 'shadow'）：`isEnforcedAutoRunBash` 恒 false → checker 的 allow 不被降级。shadow resolver 仍跑 candidate classifier（观察），但 `createShadowResolver` 返回 `request.decision`（即 checker 原始 allow），effectiveDecision 保持 allow → gate 执行。A85"shadow 最终授权由 legacy 决定"语义不变；candidate classifier 结果只用于 observation。

- [ ] **Step 5: 锚点 2 — resolver canonical run_bash ask → resolveByClassifier 短路**

修改 `src/permission/ask-resolver.ts`：本锚点不依赖 authority（resolver 只在 enforced/shadow 下构造；shadow 下 resolver 是 candidate，结果不参与授权）。短路按 canonical tool name，覆盖所有进入 resolver 的 canonical run_bash ask（含锚点 1 降级产物）。

在 `resolve()` 固定顺序中，第 7 步（`AUTO_SAFE_TOOL_ALLOWLIST.has`）之后、第 9 步（acceptEdits simulation）之前，插入：
```ts
// 8. canonical run_bash 强制 classifier 短路（设计 §6.4 锚点 2）
//    覆盖 reason_code permission.auto_run_bash_requires_classifier（executeToolCall 降级产物）
//    以及任何其他原因进入 resolver 的 canonical run_bash ask。
if (request.executableToolCall.canonicalToolName === 'run_bash') {
  return this.resolveByClassifier(request);
}
```
该短路使 canonical `run_bash` 永不进入第 9 步 acceptEdits simulation。按 tool name 短路而非 reason_code 字符串，更稳健。

- [ ] **Step 6: 运行 GREEN + 回归**

Run: `npx vitest run src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts`

Expected: 全部 PASS。逐组确认：
- 组1 ALLOW：classifier invoked（completeText=1）, executor=1；组1 DENY：classifier invoked（completeText=2）, executor=0；组1 sanity：acceptEdits 对 run_bash 仍 allow（根因前提钉死）。
- 组2 build：classifier 未调用, executor=1（降级只对 enforced+auto 生效）；组2 enforced+auto+DENY：classifier invoked, executor=0。
- 组3 sessionAllowlist：classifier invoked, executor=0。
- 组4 subagent DENY：classifier invoked, executor=0；组4 subagent ALLOW：classifier invoked, executor=1。
- 组5 write_file：classifier 未调用, executor=1（acceptEdits fast-path 保留）。
- 组6 legacy：classifier 未调用, executor=1（legacy 行为不变，无降级守卫）。
- 组7 shadow：classifier 未调用, executor=1（checker allow → resolver 不触发 → candidate 不跑；authority!=='enforced' 无降级）。

Run L2（影响模块）: `npx vitest run src/__tests__/permission/ src/__tests__/agent/`

Expected: PASS。重点关注既有 `auto-resolver-integration.test.ts`、`authority-gate-contracts.test.ts`、`authority-gate-production.test.ts`、`auto-resolver-build-mode-guard.test.ts` 不回归。

- [ ] **Step 7: 静态检查**

Run: `npm run typecheck && npm run lint`

Expected: exit 0；无 unused（新常量被 checker/resolver 引用）；无 floating promise。

- [ ] **Step 8: Commit**

```bash
git add src/agent/tool-execution.ts src/permission/ask-resolver.ts src/permission/authority-gate.ts src/__tests__/permission/auto-run-bash-classifier-invariant.test.ts
git commit -m "fix: enforce classifier for enforced+auto run_bash (§6.4, authority-gated)"
```

---

## A1-A88 Coverage Index

> 本表只用于从验收编号导航到正文测试，不作为行为通过证明。

| A | Task / concrete test |
|---|---|
| A1 | T1 `distinguishes exact, legacy prefix and wildcard` |
| A2 | T1 `a single trailing wildcard makes arguments optional` |
| A3 | T1 `escaped star remains literal` |
| A4 | T1 `multiple wildcards do not make the tail optional` |
| A5 | T1 `wildcard uses dotAll for heredoc content` |
| A6 | T1 `concrete MCP tools are exact; server rules support underscores` |
| A7 | T1 `reports tool-level deny/ask shadowing content allow` |
| A8 | T1 `escape/parse/serialize and legacy aliases roundtrip` |
| A9 | T3 `deny wins for an in-workspace action` |
| A10 | T3 `a denied compound subcommand denies the whole command` |
| A11 | T3 `too-complex preserves raw deny/ask before conservative ask` |
| A12 | T3 `bypass cannot approve protected settings` |
| A13 | T3 `bypass cannot override explicit content ask` |
| A14 | T3 `requiresUserInteraction remains ask in every evaluation mode` |
| A15 | T3 `unresolved write becomes ask` |
| A16 | T3 `real read-only Bash reaches the registered executor` |
| A17 | T2 `entering auto strips dangerous allows into session stash` |
| A18 | T2 `exit restores only rules still present in current stash` |
| A19 | T2 `same-mode transition preserves snapshot identity and emits no effects` |
| A20 | T8 `session destination never writes disk; settings destination writes default mode` |
| A21 | T8 `resumed auto mode is sanitized through SessionState`（稳定态重新含持久危险 stash） |
| A22 | T8 两个 requested startup precedence / restriction gate 测试 |
| A23 | T8 `slash, TAB and plan approval invoke the same transition port` |
| A24 | T6 `resolver owns the exact safe allowlist and bypasses classifier only for it` + T15 `[§6.4] enforced+auto canonical run_bash 必经 classifier`（persistent/session/subagent/write_file/build 全路径） |
| A25 | T6 `CWD write uses acceptEdits evaluation and zero classifier calls` |
| A26 | T6 `outside-CWD write that survives safety enters classifier` |
| A27 | T6 `non-approvable safety runs before every automatic path` |
| A28 | T4 Stage 1/Stage 2 failure-deny、显式模型不可用与绑定后不跨模型测试 |
| A29 | T4 `Stage 1 ALLOW returns allow with zero Stage 2 calls` + `FLAG invokes Stage 2 exactly once` |
| A30 | T4 `denial thresholds are 3 consecutive or 20 total` |
| A31 | T4 `allow resets consecutive but preserves total` |
| A32 | T2 `add/remove/replace/reload update visible rules and stash together` |
| A33 | T4 `non-empty trusted user rules replace defaults; empty falls back` |
| A34 | T5 `headless ask with no hook decision denies` |
| A35 | T6 `child under parent auto uses the same real ToolExecutionRuntime.askResolver` |
| A36 | T5 `parent privileged mode wins over child-declared mode` |
| A37 | T5 `allowedTools replaces child session rules` |
| A38 | T5 `child denial limit terminates only that child` |
| A39 | T5 `fork copies rule values but not denial/stash references` |
| A40 | T5 `hooks are the only headless external allow channel` |
| A41 | T5 `bubble exists only behind explicit build option` |
| A42 | T6 `resolved auto allow reaches gate without creating dialog` |
| A43 | T6 `classifier failure denies without dialog or executor` |
| A44 | T7 `denial threshold falls back to main dialog` |
| A45 | T7 两个 `automatic result/dialog starts` fake-timer tests |
| A46 | T7 `accept-session remembers exact canonical tool and structured input` |
| A47 | T7 `always allow persists a rule then rechecks through hard constraints` |
| A48 | T6 `explicit ask bypasses allowlist and acceptEdits, then classifies` |
| A49 | T7 `requiresUserInteraction opens dialog and ESC aborts automatic work` |
| A50 | T10 `safe tools both start before either barrier releases` |
| A51 | T10 `unsafe tool excludes every sibling until released` |
| A52 | T10 `results yield in tool-call order even when second finishes first` |
| A53 | T10 `read failure does not abort a safe sibling` |
| A54 | T10 两个 Bash abort / non-Bash unsafe no-abort 测试 |
| A55 | T10 `malformed concurrency declaration is unsafe` |
| A56 | T10 `build and auto produce identical scheduling classes` |
| A57 | T11 `side-effect tool failure executes exactly once` |
| A58 | T11 `ordinary 400 is not retryable` |
| A59 | T11 `base caps at 32s, jitter stays below 40s, Retry-After wins` |
| A60 | T11 `classifier 529 uses the same retry schedule as foreground` |
| A61 | T11 `streaming reconnect keeps the current attempt number` |
| A62 | T11 foreground fallback + classifier bound-model no-fallback 断言 |
| A63 | T11 `exhausted classifier retry stays on the bound model then denies` |
| A64 | T2 `resume clears transient state then repartitions persisted dangerous rules` |
| A65 | T9 `permission rule behavior and source precedence are deterministic` |
| A66 | T9 `project switch reloads project/local and repartitions auto stash` |
| A67 | T9 `invalid JSON preserves last-known-good configuration` |
| A68 | T9 `schema-invalid fields retain raw values during merge` |
| A69 | T9 `explicit undefined deletes a key` |
| A70 | T9 classifier trusted rules + trusted `classifierModel` 两个测试 |
| A71 | T9 `trusted sources append in stable order` |
| A72 | T9 `unknown fields survive a permission update byte-for-value` |
| A73 | T9 `legacy config without auto fields keeps build/plan behavior` |
| A74 | T12 `mode switch does not change static system prompt hash` |
| A75 | T12 `auto exit emits one dynamic attachment per session transition` |
| A76 | T12 `dynamic attachment changes dynamic hash only` |
| A77 | T12 `auto protected-setting write reaches classifier after safety ask` |
| A78 | T12 `bypass cannot approve protected settings` |
| A79 | T12 `only trusted user/local/flag/policy sources affect classifier prompt` |
| A80 | T12 `non-empty user section replaces defaults; empty uses defaults` |
| A81 | T4 `denial transitions preserve initial/consecutive/total states` |
| A82 | T1 `wildcard regression corpus has no mismatches` |
| A83 | T14 `compatibility corpus preserves expected build/plan/security decisions` |
| A84 | T4 严格两阶段协议/调用次数/零授权输入测试 + T6 pending gate/非消息化集成测试 |
| A85 | T14 两个 shadow authority/candidate failure tests |
| A86 | T13 `every final decision emits exactly one sourced result event` |
| A87 | T13 `audit excludes commands, content, raw paths and classifier prompt` |
| A88 | T2 `transitionTo clears every session cache; same id is a no-op` |

## Defensive Boundaries

- classifier 最终域只有 allow/deny；Stage 1 只接受 `ALLOW | FLAG`，Stage 2 只接受 `ALLOW | DENY`，额外文本或任一 failure -> deny。
- provider `invoke()` 返回原始 `unknown`；decision 解析只发生在 `classifier.ts` 的 `parseStage1Decision/parseStage2Decision`，非完整枚举字符串一律 fail-closed。
- 五个 classifier 文件（`classifier-input.ts` / `classifier-prompt.ts` / `classifier-provider.ts` / `classifier-model-policy.ts` / `classifier.ts`）共享隔离不变式：输入投影、prompt、direct RPC、model binding、协议解析各只出现一次，互相不越权。
- 无 authentic user-authored message -> provider 0 调用并 deny；输入只含当前一个 executable tool call；旧 `untrustedEvidence`、相关 tool calls、`ambiguous_intent` / `transcriptTooLong` 等 outcome 与正常 message/TUI pipeline 均零残留。
- 显式 `classifierModel` 不替换；一次裁决绑定后 retry/Stage 2 不跨模型。静态 capability unknown -> unsupported，且不发 discovery RPC。
- classifier pending -> runtime gate/executor 0 调用；classifier 不创建 Agent/subagent/tool registry/`streamingQuery`/assistant/thinking/tool_result/TUI 路径。
- non-classifierApprovable safety -> 主会话 ask；headless hooks -> 无决定 deny；三个自动 fast-path 调用次数均为 0。
- AST too-complex -> tool/raw/subcommand strong rules 与 raw-input safety/requiresInteraction 均先求值；仍未决才 ask。
- resolver 是 auto safe allowlist 的唯一真相源；stash 是 `isDangerousAllowRule()` 的唯一消费者语义。
- invalid config -> last-known-good；原子写失败 -> 原文件保持。
- unknown concurrency declaration -> unsafe；unknown tool -> executor 0 次。
- shadow candidate error -> legacy authoritative；不能产生 fallback allow。
- session rotate/resume/project switch -> 先清 auto 瞬态状态，再重新加载并分区持久规则；auto 下持久危险 allow 最终回到 stash。
- 只有 `run_bash` execution failure abort sibling；其他 unsafe tool failure 不级联。
- Task 5 不创建 resolver；A35 subagent classifier 证明只在 Task 6 用真 resolver 完成。
- classifier cancellation 是 per-resolution：resolver 是唯一 `AbortController` 创建者，构造 `PendingAutomaticDecision { promise, abort }` 并经 `registerAbort` 暴露；`resolveInteractiveAsk` 持有 `automatic`，dialog ESC 时自行 `automatic.abort()`，不创建第二个 controller；classifier service 不持有共享 `this.signal`。
- classifier retry wait 可取消：同一 per-resolution `AbortSignal` 贯穿 provider RPC 与 `retrySleeper.wait(delayMs, signal)`；abort 时 wait 立即终止，后续 provider 调用不再增加，不进 Stage 2/gate/executor；`AbortError` 不属于 retryable API error，provider RPC 因 signal abort 同样不 retry。
- `AUTO_PERMISSION_AUTHORITY` 未设置时默认 `enforced`（新权限链）；非法显式值 fail-safe 到 `enforced`，不静默回 legacy；`legacy`/`shadow` 仅作显式诊断/迁移模式。
- **§6.4 三锚点（Task 15，authority-gated）**：enforced+auto+canonical `run_bash` 除同步阶段已产生的最终 deny 外，任何进入 gate/executor 的 allow 必须携带本次 `PermissionClassifier` ALLOW。`PermissionChecker` 是 legacy/shadow/enforced 共用的进程级单例，**没有 authority 概念**，故三锚点全部在 `executeToolCall` 内实现，由 `runtime.authority==='enforced'`（`createExecutionRuntimeForTurn` 唯一赋值）gating：(1) allow→ask 降级（reason_code `permission.auto_run_bash_requires_classifier`）；(2) resolver canonical run_bash ask 第 8 步短路直进 classifier（resolver 只在 enforced/shadow 构造，shadow 返回 legacy decision 不受影响）；(3) sessionAllowlist `rewriteToAllow` 与 `applySubagentSilentPolicy` 对 enforced+auto+run_bash 失效。checker 本体零修改。persistent/session/subagent 三个真实 bypass + legacy/shadow 回归（组6/组7）由同一组真实生产链测试覆盖；不得用 `evaluateWithMode → ask` stub 绕过。legacy/shadow 与非 run_bash 工具行为不变。

## Self-Review Record

1. **Spec coverage:** classifier 五文件职责、单 call 输入、两阶段协议、model binding、静态 capability、非消息化和 gate barrier 均有正文 RED/GREEN；Task 2/3/8/9/10 保留设计修正。
   - Req 1（五文件职责）：Task 4 新增"五文件隔离不变式"与"旧契约删除清单"，逐文件列出不越权边界，并以 Task 4 Step 7 `installForbiddenOutputSpies()` + Task 6 Step 2 `installForbiddenClassifierPathSpies()` 校验。
   - Req 2（删旧契约）：grep 结果为 `untrustedEvidence` / `ambiguous_intent` / `transcriptTooLong` / related tool calls / classifier 返回 ask 均零残留；`ClassifierDecision` 类型为 `allow | deny`。
   - Req 3（Stage 1）：T4 Step 7 `Stage 1 ALLOW returns allow with zero Stage 2 calls`、`FLAG invokes Stage 2 exactly once`、`every Stage 1 provider/timeout/input-limit/parse or protocol failure denies`、新增"decision protocol is enum-based"测试覆盖严格枚举、关闭 reasoning、最小输出预算与无 token 承诺。
   - Req 4（Stage 2）：T4 Step 7 `every Stage 2 failure denies and never changes the bound model` 与 `FLAG invokes Stage 2 exactly once with same prefix and model`（断言 Stage 2 可 reasoning、失败 deny、不换模型）。
   - Req 5（model policy）：T4 Step 4 七条断言覆盖显式绑定、显式不可用 deny 不 fallback、static fast advisory、不可选 fast -> main、无第二模型、Stage 1 RPC 后冻结、Stage 2 默认复用。
   - Req 6（capability）：T4 Step 4 `unknown capabilities are unsupported and never trigger discovery RPC`、`supported performance hints are translated without changing the decision protocol`、T9 `classifier provider metadata is loaded statically without discovery RPC`。
   - Req 7（输入边界）：T4 Step 1 `projects only authentic user messages and the current executable call`、T6 Step 2 `two tool calls in one turn receive independent classifier inputs and decisions`；`projects` 测试覆盖 assistant/thinking/tool output/file/MCP/hook/system/agent/其他 tool call 全部排除，以及 `authenticUserMessages` 为空路径。
   - Req 8（非消息化集成）：T6 Step 2 `pending classifier keeps gate and executor at zero`、`classifier does not construct Agent/tool/message/TUI paths`、`classifier deny or failure never executes the reviewed tool`。
   - Req 9（A 编号同步）：A24 在 T6 resolver、A28/A29 在 T4 两阶段、A84 在 T4 严格协议 + T6 集成；Coverage Index 与正文一致（见第 5 项）。
   - Req 10（已批准修正）：T3 `tool/raw strong rules -> subcommand -> raw safety/interaction -> too-complex -> discretionary allow -> ordinary allow -> ask`、T2 唯一 `isDangerousAllowRule()`、T2/T8 resume 两阶段 stash、T10 仅 `run_bash` failure abort sibling、T9 四种 precedence 分别实现。
   - Req 11（TDD）：所有任务保留 Step 1 RED、失败原因、最小实现、GREEN 命令、回归测试与 commit；不存在用 A 编号或 coverage matrix 代替行为证明的步骤。
2. **Placeholder scan:** 正文无占位标记、泛化错误处理、跨任务省略引用或没有代码/命令的抽象步骤。
3. **Type/signature consistency:** Task 4 产出的 `PermissionClassifierInput`、`PermissionClassifierProvider.invoke(): Promise<unknown>`、`ClassifierModelPolicy`、`PermissionClassifier.classify(input, signal): Promise<ClassifierDecision>` 与设计 §7.1/§7.3/§7.4 与 Task 5/6/9/11/12 使用名称一致；`classifier.ts` 的 `parseStage1Decision(raw: unknown)`/`parseStage2Decision(raw: unknown)` 是 `unknown -> enum` 的唯一解析器；classifier 返回类型不含 ask。`classify` 的 `signal` 是 per-resolution 参数，代码中无 `this.signal` 作为 cancellation authority（`this.signal` 字样仅在"不持有共享 this.signal"的禁止性说明中出现）。计划中所有 `.classify(` 调用点（Task 4 的 A29/A28/A84/missing-user/main-model fallback 共 8 处，以及 Task 6 resolver `resolveByClassifier` 的 `this.classifier.classify(input, controller.signal)`）均传入两个参数；grep 结果无遗留的单参数 `.classify(classifierInput())` 契约。
4. **Task dependency order:** Task 3 sync checker -> Task 4 classifier subsystem -> Task 5 hooks（不创建 resolver、不实现 child classifier）-> Task 6 resolver integration（含 A35 subagent 用真 resolver + per-resolution cancellation）-> Task 9 config metadata -> Task 11 retry integration -> Task 12 prompt-plane isolation；不存在反向创建同一接口，不存在 Task 5 依赖 Task 6 接口的倒置。
5. **A1-A88 evidence:** 每个 A 编号都在正文具名测试中出现并包含实际 `expect`；Coverage Index 只导航。A24 在 T6，A28/A29 在 T4，A35 在 T6（使用真 `ToolExecutionRuntime.askResolver`，非 Task 5 临时 child.resolve()），A84 由 T4 严格协议/调用次数/零授权输入测试 + T6 pending gate/非消息化集成测试共同证明，与设计 A84 重定义一致。
6. **Legacy classifier scan:** 被替换的宽输入、旧 outcome（`ambiguous_intent`/`transcriptTooLong -> ask`）、`untrustedEvidence` 分桶、额外 tool-call 输入和 Agent 化 classifier 契约均为零残留；grep 结果均空。
7. **Safety/regression:** strong -> subcommand -> raw safety -> too-complex 顺序、唯一 `isDangerousAllowRule()`、resume 两阶段 stash、仅 `run_bash` failure 级联、四种 precedence 均有正文断言。
8. **Single host path:** 不创建 `src/permissions/*`，状态只经 `applyPermissionUpdate`，被审核工具只在 classifier allow 后进入 runtime gate/executor。
9. **Task 5/6 dependency inversion fix:** Task 5 只实现 hooks/fork/headless/session 隔离（A34、A36-A41），不创建 `DefaultPermissionAskResolver`、不实现 `child.resolve()` classifier logic；A35 移到 Task 6，使用真正的 `ToolExecutionRuntime.askResolver`/`DefaultPermissionAskResolver`（`forkRuntimeFromParent` 共享 parent resolver/classifier 实例）。Coverage Index A35 行已同步到 T6。
10. **Per-resolution cancellation + Task 7 唯一 abort wiring + Task 11 retry wait 可取消:** `PermissionClassifier.classify(input, signal)` 接受 per-resolution `AbortSignal`；**resolver 是唯一 `AbortController` 创建者**：`resolveByClassifier` 为每个 tool call 创建一个独立 controller，构造 `PendingAutomaticDecision { promise, abort }`，经 `request.registerAbort` 暴露 `automatic.abort`。`resolveInteractiveAsk` 消费该 `automatic`，不创建第二个 controller，dialog 返回 ESC 时自行调用 `automatic.abort()`，使 provider `signal` 自动 `aborted`；signal 贯穿 Stage 1/Stage 2/同模型 retry/provider RPC。代码中无 `this.signal` 作为共享 cancellation authority（`this.signal` 仅在禁止性说明中出现）。不存在 `abortAutomatic` 第二套取消接口，测试代码也不代行 `abortHandles.forEach(...)`/`abortHandle()`。Task 6 保留底层隔离测试（直接调用 abort handle 能取消单 call、不影响 sibling）与已决定后 abort no-op 测试，但它们不是 ESC wiring 证明。Task 7 A49 ESC 测试经真实 `executeToolCall` 生产路径发起 classifier，只驱动“dialog 返回 ESC”，断言 `classifier.invokedStage1[0].signal.aborted === true`、Stage 2=0、gate=0、executor=0；`requiresUserInteraction` 测试断言 classifier=0 calls 且不注册 classifier abort handle。Task 11 新增 retry-cancellation 测试：classifier 529 backoff 期间 abort -> retry wait 立即终止、后续 provider 调用不增加、不进 Stage 2/gate/executor；`AbortError` 不属于 retryable API error；provider RPC 因 signal abort 同样不 retry；未取消 retry 始终用同一绑定 `ModelRef`、永不跨模型 fallback。
11. **Authority default enforced + 非法值 fail-safe:** Task 14 新增 `resolveAuthority()` 测试覆盖 env unset -> enforced、explicit legacy/shadow/enforced、非法值 fail-safe 到 enforced（不静默回 legacy）、trim 后识别合法值；`production default uses enforced` 测试证明 env 未设置时走新权限链（resolver+classifier+gate），不经 legacy fast-path。`legacy`/`shadow` 仅作显式诊断/迁移模式。compatibility/shadow 测试保留。
12. **§6.4 三锚点 run_bash classifier 强制不变量（Task 15，authority-gated）:** 原 Task 6 只保护 checker→ask→resolver 路径，未覆盖 checker 直接 allow（persistent/ordinary allow rule）与 executeToolCall 后置 rewrite（sessionAllowlist/subagent silent policy）两类 bypass。Task 15 作为独立 post-implementation corrective task，不重做 Task 1-14。**authority 隔离关键决策**：`PermissionChecker` 是 legacy/shadow/enforced 共用的进程级单例，没有 authority 概念；若把 run_bash allow→ask 降级放进 checker（按 `mode==='auto'`），会改变 legacy（本应 allow 的 run_bash 变 ask）与 shadow（legacy authoritative 从 allow 变 ask，违反 A85）。故三锚点全部在 `executeToolCall` 内实现，由 `runtime.authority==='enforced'`（`ToolExecutionRuntime.authority` 字段，`createExecutionRuntimeForTurn` 唯一赋值）gating：(1) allow→ask 降级在 `checkDecision` 后、if/else 链前，对 `authority==='enforced' && mode==='auto' && run_bash && behavior==='allow'` 降级为 ask（reason_code `permission.auto_run_bash_requires_classifier`，`tool-execution.ts` 导出常量 `AUTO_RUN_BASH_REQUIRES_CLASSIFIER`）；deny 不降级；(2) resolver 第 7 步后插入 `canonicalToolName === 'run_bash'` 短路直进 `resolveByClassifier`（resolver 只在 enforced/shadow 构造；shadow 返回 `request.decision` 即 checker 原始 allow，不受短路影响）；(3) executeToolCall 分支 2（subagent）与分支 3（sessionAllowlist）加 `isEnforcedAutoRunBash` 守卫。checker 本体零修改。Task 15 测试组（7 组真实生产链）：组1 普通 run_bash ALLOW/DENY + sanity 钉死 acceptEdits→allow 根因；组2 persistent allow rule（build 回归 classifier 未调用 + enforced+auto classifier invoked）；组3 sessionAllowlist bypass；组4 subagent bypass ALLOW/DENY；组5 write_file 回归；**组6 legacy + auto + run_bash allow rule（classifier 未调用，executor=1，行为不变）；组7 shadow + auto + run_bash allow rule（checker allow → resolver 不触发 → classifier 未调用，executor=1，authority!=='enforced' 无降级，A85 不变）**。组6/组7 在 RED 阶段必须 PASS（回归锚点）。classifier 两阶段协议正确建模：spy 按 completeText 调用序返回（allow -> 'ALLOW' 1 次；deny -> 'FLAG'+'DENY' 2 次）；断言 `completeTextCalls >= 1`。严禁 `evaluateWithMode → ask` stub。Coverage Index A24 已同步指向 T15。

## Execution Handoff

本计划仅供审核；当前不执行实现。审核通过后可选择：

1. **Subagent-Driven（推荐）** — 使用 `superpowers:subagent-driven-development`，逐任务实施并做规格/质量两阶段审查。
2. **Inline Execution** — 使用 `superpowers:executing-plans`，按任务批次执行并在每个出口复核。
