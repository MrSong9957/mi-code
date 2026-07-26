# mi-code Agent Mechanisms Wave C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 Wave C 的六个 Policy Contract，把 Wave B 的稳定 snapshot/envelope 转换为可重放、fail-closed、权限不升级的 resolution、routing、projection、delegation 和 observability policy。

**Architecture:** Policy 以纯函数和不可变输入为核心，各 CRC 保持独立错误语义，不建立中央 Policy Engine。机器政策先产生结构化结果，Prompt/description 只投影结果；CRC-2 与 CRC-5 保持无 Wave D 直接 D-edge。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、`node:crypto`、现有 ConfigStore、Prompt compiler、Context intake、RuntimeSecurityGate 和 Observability envelopes。

## Global Constraints

- 冻结规格：`docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md`。
- 覆盖且只覆盖 M-002、M-003、M-004、M-009、M-012、M-026、M-031、M-043、M-054、M-056、M-059、M-067、M-069。
- 同一 policy/version + immutable input snapshots 必须产生确定相同结果。
- Prompt precedence 只选择 approved base，不改变 Context Authority。
- Condition DSL 封闭、三态、无任意脚本/callback；unknown 不乐观 include。
- Static 只表示 cache eligibility，不宣称 support/hit/token/cost 收益。
- Capability override 只能来自四重受信 gate；supported 不等于 permission allow。
- 文件、Markdown、文件名、路径、frontmatter、schema 和正文自报都不建立 trust。
- TypedMemoryCandidate 不等于 admitted/stored/selected/used memory。
- Tool description 只投影 runtime policy，不产生 SecurityDecision。
- No-tools 必须同时满足 profile、空 tool view、Provider omission、runtime rejection。
- Delegation 不扩大 parent scope/tool/control mode；child output 默认 untrusted。
- Injection suspicion 是 soft signal，不能修改 permission/Trust/Authority/Placement。
- Observability 先最小化字段，再 redaction；credential/sensitive_auth 默认 drop event。
- CRC-2、CRC-5 不得被接成 Wave D 直接依赖。
- 本计划不实现 Wave D 能力、Deferred/Hold、Prompt 原文适配、部署、依赖升级或 Git 写操作。

---

## 1. 文件责任图

```text
src/agent/
├── prompt/
│   └── resolution.ts                  # CRC-1
├── tools/
│   ├── policy-projection.ts           # CRC-4 / M-026
│   └── no-tool-contract.ts            # CRC-4 / M-031
├── context/
│   ├── routing.ts                     # CRC-3 / M-009 + M-012
│   └── injection-signal.ts            # CRC-5 / M-069
└── observability/
    ├── decision-trace.ts              # CRC-6 / M-054
    └── redaction.ts                   # CRC-6 / M-056

src/memory/
└── candidates.ts                      # CRC-3 / M-043

src/permission/
└── delegation.ts                      # CRC-5 / M-067

src/config/
└── capability-override.ts             # CRC-2 / M-059
```

这些文件是主计划既有 `prompt/context/tools/memory/permission/observability` 域的内部细化，不新增架构域。公共出口继续由各域 `index.ts` 控制。

共享文件串行修改：

| 文件 | 顺序 |
|---|---|
| `src/agent/prompt/resolution.ts` | Task 1 → Task 2 → Task 3 |
| `src/agent/context/routing.ts` | Task 5 → Task 6 |
| `src/agent/streaming-query.ts` | Task 9 后 Task 10 |
| `src/agent/subagent.ts` | Task 10 后 Task 11 |
| `src/permission/delegation.ts` | Task 10 → Task 11 |
| `src/agent/observability/envelopes.ts` | Task 13 → Task 14 |

## 2. Task 依赖

```text
T1 Condition + Scope
 └→ T2 Prompt Resolution
     └→ T3 Compiler Cutover

T4 Capability Override

T5 Environment Context Block
T6 Markdown Routing
T7 Typed Memory Candidate

T8 Tool Policy Projection
 └→ T9 No-Tool Contract

T10 Delegation Gate
 └→ T11 Handoff Validation

T12 Injection Signal

T13 Decision Trace
 └→ T14 Telemetry Redaction

T1–T14 ─→ T15 Wave C Acceptance
```

## Task 1: M-003/M-004 Condition DSL 与 Scope Classification

**Files:**
- Create: `src/agent/prompt/resolution.ts`
- Test: `src/__tests__/agent/prompt-condition-scope.test.ts`

**Interfaces:**
- Consumes: immutable control-mode/role/capability/config/context snapshots。
- Produces: `evaluatePromptCondition()`、`classifyPromptScope()`。

- [ ] **Step 1: 写三态 RED 测试**

```ts
it('treats unknown capability as unknown rather than false or supported', () => {
  const result = evaluatePromptCondition({
    kind: 'capability_is',
    capability: 'image_input',
    expected: 'supported',
  }, {
    control_mode: 'build',
    role_id: null,
    capabilities: { image_input: 'unknown' },
    trusted_flags: {},
    present_source_classes: new Set(),
    evidence_refs: ['capability:cap-1'],
  });
  expect(result.truth).toBe('unknown');
  expect(result.evidence_refs).toEqual(['capability:cap-1']);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/prompt-condition-scope.test.ts
```

- [ ] **Step 3: 实现封闭 DSL**

精确实现规格 §7.5 的 `PromptCondition`、`ConditionTruth`、`ConditionEvaluation`。拒绝未知 kind、函数、脚本文本和循环对象；`all/any/not` 递归深度上限固定为 16，超过返回 unknown + `condition.depth_exceeded`。

- [ ] **Step 4: 实现 scope classifier**

```ts
export function classifyPromptScope(input: {
  section_id: string;
  immutable_asset: boolean;
  dependency_kinds: readonly string[];
  stable_order: boolean;
}): PromptScopeDecision
```

只要依赖 user/session/turn/time/CWD/environment/memory/tool_result/attachment/request_override/mutable_config 即 dynamic；证据不足为 unknown，调用 resolution 时按 dynamic。

- [ ] **Step 5: 增加 cache 禁止性测试**

断言 `PromptScopeDecision` 没有 `cache_hit`、`saved_tokens` 或 `provider_cache_supported` 字段。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/prompt-condition-scope.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认没有执行任意 callback，没有使用 CRC-2 effective capability 反向新增 D-edge。

## Task 2: M-002 PromptResolutionPlan

**Files:**
- Modify: `src/agent/prompt/resolution.ts`
- Test: `src/__tests__/agent/prompt-resolution.test.ts`

**Interfaces:**
- Consumes: Task 1 evaluator、approved candidate lookup、`PromptResolutionCandidate[]`。
- Produces: `resolvePromptPolicy(): PromptResolutionPlan`。

- [ ] **Step 1: 写 base precedence 与 mandatory append RED**

```ts
it('selects one base while preserving mandatory append sections', () => {
  const plan = resolvePromptPolicy({
    resolution_protocol_version: '1',
    policy_ref: { policy_id: 'prompt-resolution', policy_version: '1' },
    input_snapshot_ids: ['request-1', 'registry-1'],
    candidates: [
      candidate('default', 'default_base', 'replace_base', 'mandatory', 0),
      candidate('role', 'agent_role_profile', 'replace_base', 'mandatory', 0),
      candidate('security', 'append_section', 'append', 'mandatory', 10),
    ],
    condition_context: contextWithKnownValues(),
    approvedAsset: () => true,
  });
  expect(plan.selected_base_candidate_id).toBe('role');
  expect(plan.mandatory_candidate_ids).toContain('security');
  expect(plan.ordered_section_refs).toEqual(['role-section', 'security-section']);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/prompt-resolution.test.ts
```

- [ ] **Step 3: 实现封闭 precedence**

固定 rank：

```ts
const baseRank = {
  trusted_runtime_override: 0,
  coordinator_profile: 1,
  agent_role_profile: 2,
  approved_custom_profile: 3,
  default_base: 4,
} as const;
```

同层多个有效 base 直接 rejected，并输出冲突 candidate IDs/source refs 的 diagnostic；不得猜 winner。

- [ ] **Step 4: 实现 append/condition/scope**

- append 按 `(stable_order, candidate_id)`；
- duplicate stable order rejected；
- mandatory unknown rejected；
- optional unknown excluded；
- override 不能删除 mandatory append；
- user/project/memory/tool candidate 不能作为 base；
- scope unknown 写为 dynamic effective classification，同时保留 unknown 原始决定。

- [ ] **Step 5: 实现可重放 identity**

`resolution_id` hash 覆盖 policy/version、input snapshot IDs、selected/excluded/evaluation/scope 的 canonical JSON。

- [ ] **Step 6: 运行验证**

```powershell
npx vitest run src/__tests__/agent/prompt-condition-scope.test.ts src/__tests__/agent/prompt-resolution.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 precedence 没有改写 candidate Authority/Trust/Placement。

## Task 3: CRC-1 → BRC-1 Compiler Cutover

**Files:**
- Modify: `src/agent/prompt/resolution.ts`
- Modify: `src/agent/prompt/compiler.ts`
- Test: `src/__tests__/agent/prompt-resolution-compiler.test.ts`

**Interfaces:**
- Consumes: `PromptResolutionPlan`、section resolver、BRC-1 compiler。
- Produces: `compileResolvedPrompt(plan, resolveSection, approvalLookup)`。

- [ ] **Step 1: 写只编译 plan 所列 section 的 RED 测试**

```ts
it('does not compile excluded or unplanned sections', () => {
  const compiled = compileResolvedPrompt(planIncluding(['base', 'security']), {
    resolveSection: (ref) => sectionFixtures[ref],
    approvalLookup,
  });
  expect(compiled.section_order).toEqual(['base', 'security']);
  expect(compiled.section_order).not.toContain('candidate-only');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/prompt-resolution-compiler.test.ts
```

- [ ] **Step 3: 实现 adapter**

adapter 只把 `ordered_section_refs` 解引用为 `PromptCompilationInput`；缺失 ref、asset identity 漂移、section metadata 与 plan 不一致均拒绝。

- [ ] **Step 4: 验证 mandatory section 防省略**

删除/省略 plan 中 mandatory ID 必须使编译失败，不能回退旧字符串 join。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/agent/prompt-resolution-compiler.test.ts src/__tests__/agent/prompt-compiler.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认未实现 Mode-specific section 集（M-048）或 Provider cache。

## Task 4: M-059 Trusted Capability Override

**Files:**
- Create: `src/config/capability-override.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/store.ts`
- Test: `src/__tests__/config/capability-override.test.ts`

**Interfaces:**
- Consumes: adapter-default `ModelCapabilitySnapshot`、trusted config loader evidence。
- Produces: `applyCapabilityOverride(): EffectiveCapabilitySnapshot`。

- [ ] **Step 1: 写四重 gate RED**

```ts
it.each([
  ['trusted_source', { trusted_source: false }],
  ['schema', { schema_valid: false }],
  ['loader', { deterministic_loader: false }],
  ['scope', { exact_scope_match: false }],
] as const)('does not apply override when %s gate fails', (_name, failure) => {
  const effective = applyCapabilityOverride(base, override, {
    trusted_source: true,
    schema_valid: true,
    deterministic_loader: true,
    exact_scope_match: true,
    registered_capability_keys: new Set(['native_tools']),
    ...failure,
  });
  expect(effective.applied_override_ref).toBeNull();
  expect(effective.capabilities).toEqual(base.capabilities);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/config/capability-override.test.ts
```

- [ ] **Step 3: 实现 override/effective 类型**

精确实现规格 §8.2。未知 capability key 拒绝整条 override；scope/provider/model/base snapshot 必须精确匹配。

- [ ] **Step 4: 接入受信 ConfigStore**

只有本地受信配置 loader 可构造 `CapabilityOverrideRecord`。Agent、Prompt、Tool Result、Provider response 没有写入口。配置变化形成新 override/effective snapshot。

- [ ] **Step 5: 运行验证**

```powershell
npx vitest run src/__tests__/config/capability-override.test.ts src/__tests__/config.test.ts src/__tests__/agent/capability-snapshot.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 supported 未被映射成 Security allow，未给 Wave D 建立直接 consumer。

## Task 5: M-009 EnvironmentContextBlock

**Files:**
- Create: `src/agent/context/routing.ts`
- Test: `src/__tests__/agent/environment-context-block.test.ts`

**Interfaces:**
- Consumes: BRC-3 `NormalizedEnvironmentSnapshot` + `SourceBudgetPolicy`。
- Produces: `buildEnvironmentContextBlock()`。

- [ ] **Step 1: 写 dynamic placement 与 freshness RED**

```ts
it('builds a deterministic dynamic block from allowed fields only', () => {
  const block = buildEnvironmentContextBlock(environmentSnapshot, budgetPolicy);
  expect(block.placement).toBe('system_dynamic');
  expect(block.fields).toEqual(environmentSnapshot.allowed_fields);
  expect(block).not.toHaveProperty('authority', 'system');
  expect(block.content_hash).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/environment-context-block.test.ts
```

- [ ] **Step 3: 实现 field canonicalization**

字段按 key 排序；只读 `allowed_fields`，不读取 `process.env`；超预算按 BRC-3 policy 显式省略并记录 code。

- [ ] **Step 4: 实现 freshness gate**

过期且无 refreshed snapshot 时返回 unavailable，不构造 block。`placement='system_dynamic'` 不改变 Authority。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/agent/environment-context-block.test.ts src/__tests__/agent/environment-normalization.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认没有原始 env dump、API key 或 model knowledge-cutoff 猜测。

## Task 6: M-012 Markdown Trusted Routing

**Files:**
- Modify: `src/agent/context/routing.ts`
- Test: `src/__tests__/agent/markdown-routing.test.ts`

**Interfaces:**
- Consumes: BRC-3 envelope/sanitization/bounded source、trusted source/schema/loader policies。
- Produces: `routeMarkdownSource(): MarkdownRouteDecision`。

- [ ] **Step 1: 写“合法 Markdown 仍不 trusted”RED**

```ts
it.each([
  ['file_exists', { trusted_source_policy: false }],
  ['schema_only', { deterministic_loader: false }],
  ['loader_only', { schema_valid: false }],
  ['sanitizer_rejected', { sanitization_accepted: false }],
] as const)('rejects when only %s evidence exists', (_name, failure) => {
  const decision = routeMarkdownSource(input, {
    trusted_source_policy: true,
    schema_valid: true,
    deterministic_loader: true,
    sanitization_accepted: true,
    ...failure,
  });
  expect(decision.target).toBe('reject');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/markdown-routing.test.ts
```

- [ ] **Step 3: 实现四重 AND gate**

实现规格 §9.4 的六个 route target。route policy 只依据 source policy/loader/schema/sanitization refs；正文、文件名、路径深度不能决定 target。

- [ ] **Step 4: 实现 target/source 兼容矩阵**

```text
instruction_candidate → project_instruction_context | agent/task/tool asset | reject
auto_memory           → auto_memory_context | reject
environment           → reject
tool_result           → reject
attachment/external   → reject
```

Asset route 只进入 RC-1 candidate governance，不返回 approved。

- [ ] **Step 5: 运行验证**

```powershell
npx vitest run src/__tests__/agent/markdown-routing.test.ts src/__tests__/agent/context-intake.test.ts src/__tests__/agent/context-sanitizer.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 route 不等于 M-008 injection 或 M-044 admission。

## Task 7: M-043 TypedMemoryCandidate

**Files:**
- Create: `src/memory/candidates.ts`
- Test: `src/__tests__/memory/memory-candidate.test.ts`

**Interfaces:**
- Consumes: `auto_memory_writer` envelope、observation metadata。
- Produces: `createTypedMemoryCandidate()`。

- [ ] **Step 1: 写 evidence/confidence/failure 约束 RED**

```ts
it('rejects failure observations without context and invalidation', () => {
  expect(() => createTypedMemoryCandidate({
    ...candidateInput,
    type: 'failure_observation',
    context_refs: [],
    invalidation_conditions: [],
  })).toThrow('failure_observation');
});

it.each([-0.1, Number.NaN, Number.POSITIVE_INFINITY, 1.1])(
  'rejects invalid confidence %s',
  (confidence) => {
    expect(() => createTypedMemoryCandidate({ ...candidateInput, confidence }))
      .toThrow('confidence');
  },
);
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-candidate.test.ts
```

- [ ] **Step 3: 实现四类 candidate**

精确实现 `user_preference/project_fact/workflow_pattern/failure_observation` 及全部 metadata。secret/credential/raw tool dump、empty evidence、非 auto-memory writer 一律拒绝。

- [ ] **Step 4: 实现 cancelled/failure 边界**

API 要求显式 `turn_outcome`；cancelled 不得生成 failure observation。Candidate 无 store/merge/delete 方法，也无 instruction Authority。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-candidate.test.ts src/__tests__/memory.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认旧 MemoryManager 条目未被自动分类，M-044 admission 未提前实现。

## Task 8: M-026 ToolPolicyProjection

**Files:**
- Create: `src/agent/tools/policy-projection.ts`
- Test: `src/__tests__/agent/tool-policy-projection.test.ts`

**Interfaces:**
- Consumes: final tool view、Security policy snapshot、approved description asset。
- Produces: `projectToolPolicy()`。

- [ ] **Step 1: 写 policy version 漂移 RED**

```ts
it('rejects a projection built from a stale security policy', () => {
  expect(() => projectToolPolicy(input, {
    current_security_policy_snapshot_id: 'security-2',
    approvedAsset: () => true,
    renderConstraints: () => 'read-only',
  })).toThrow('security_policy_snapshot_id');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/tool-policy-projection.test.ts
```

- [ ] **Step 3: 实现 projection**

精确实现规格 §10.2。只允许 policy refs 生成 constraint；过滤 secret、完整 allow/deny list 和不必要敏感路径。Projection 无 behavior 字段，不能产生 allow/ask/deny。

- [ ] **Step 4: 验证 included/description 一致性**

excluded tool 不生成 active projection；安全关键 projection 失败时 tool 保持 excluded 或使用同 policy version 的 verified base description。

- [ ] **Step 5: 运行验证**

```powershell
npx vitest run src/__tests__/agent/tool-policy-projection.test.ts src/__tests__/agent/tool-view-overlay.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 description 不是 PermissionChecker 的输入真相源。

## Task 9: M-031 No-Tool Request Contract

**Files:**
- Create: `src/agent/tools/no-tool-contract.ts`
- Modify: `src/agent/query-engine.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/agent/compression.ts`
- Test: `src/__tests__/agent/no-tool-contract.test.ts`
- Test: `src/__tests__/compression.test.ts`

**Interfaces:**
- Consumes: no-tool task profile、empty RequestToolViewSnapshot、Provider request。
- Produces: `validateNoToolRequest()`、runtime tool-use rejection。

- [ ] **Step 1: 写四重 enforcement RED**

```ts
it.each([
  ['profile', { profile_requires_no_tools: false }],
  ['view', { included_tool_count: 1 }],
  ['provider', { provider_tools_omitted: false }],
  ['runtime', { runtime_tool_use_behavior: 'execute' }],
] as const)('invalidates no-tool request when %s gate fails', (_name, failure) => {
  expect(validateNoToolRequest({ ...validNoToolState, ...failure }).status).toBe('invalid');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/no-tool-contract.test.ts
```

- [ ] **Step 3: 实现 contract/validation**

精确实现规格 §10.4。`tool_view_entry_count` 必须为字面量 0，Provider tools 必须 omitted，而非发送空的模拟 system tool 文本。

- [ ] **Step 4: 接入 compaction/final summary**

为 no-tool request 向 QueryEngine/streamingQuery 传 contract；若 Provider 返回 tool call，产生 protocol rejection result，executor 调用次数为 0。Output parser 失败不得再调用工具补救同一 request。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/agent/no-tool-contract.test.ts src/__tests__/compression.test.ts src/__tests__/streaming-query.test.ts src/__tests__/subagent-result-integrity.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 Prompt preamble/trailer 只作软防线，异常 tool call 未执行。

## Task 10: M-067 Delegation Least-Privilege Gate

**Files:**
- Create: `src/permission/delegation.ts`
- Modify: `src/agent/tools/spawn-agent-tool.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/agent/streaming-query.ts`
- Test: `src/__tests__/permission/delegation-gate.test.ts`
- Test: `src/__tests__/regression/subagent-permission-passthrough.test.ts`

**Interfaces:**
- Consumes: parent scope/tool view/control mode、BRC-6 action provenance/blocking ask。
- Produces: `evaluateDelegationGate(): Promise<DelegationGateDecision>`。

- [ ] **Step 1: 写权限不扩张 RED**

```ts
it.each([
  ['scope', { requested_scope: 'workspace', parent_scope: 'file' }],
  ['tools', { requested_tools: ['write_file'], parent_tools: ['read_file'] }],
  ['mode', { requested_mode: 'build', parent_mode: 'plan' }],
] as const)('never auto-allows %s expansion', async (_name, values) => {
  const decision = await evaluateDelegationGate(delegation(values), dependencies);
  expect(decision.status).not.toBe('allowed_once');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/delegation-gate.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts
```

- [ ] **Step 3: 实现 request/gate**

精确实现规格 §11.2/§11.3。local + read-only + same scope 仅在确定性 policy 明确时 allow once；cross-machine、unknown provenance、side-effect 或扩张请求进入 blocking ask，无通道 deny。

- [ ] **Step 4: 接入 spawn**

spawn 前必须获得 gate decision。Child tool view 是 parent final view 的交集；child control mode 不得高于 parent。Decision 绑定 delegation/action snapshot，只消费一次。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/permission/delegation-gate.test.ts src/__tests__/regression/subagent-permission-passthrough.test.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-explicit-delegation.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 delegation Prompt 文本没有授权能力，CRC-5 未成为 Wave D 直接依赖。

## Task 11: Delegation Handoff Validation

**Files:**
- Modify: `src/permission/delegation.ts`
- Modify: `src/agent/subagent.ts`
- Modify: `src/ui/subagent-presentation.ts`
- Test: `src/__tests__/permission/delegation-handoff.test.ts`

**Interfaces:**
- Consumes: valid CompletionReport、sanitization result、child evidence。
- Produces: `createDelegationHandoffEnvelope()`。

- [ ] **Step 1: 写 child result 默认 untrusted RED**

```ts
it('keeps a completed child result untrusted', () => {
  const handoff = createDelegationHandoffEnvelope(validInput);
  expect(handoff.result_trust).toBe('untrusted');
  expect(handoff.completion_report_ref).toBe('completion-1');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/delegation-handoff.test.ts
```

- [ ] **Step 3: 实现 handoff**

精确实现 §11.4。无效 CompletionReport 或 sanitizer failure 时正文 ref 必须为 null/rejected，不进入 parent Context。DispatchReceipt 不能构造 handoff completion。

- [ ] **Step 4: 接入 parent**

parent 只接收 handoff envelope；独立验证 deliverables/evidence 后才能使用。Child permission decision 不回传为 parent permission。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/permission/delegation-handoff.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/ui/subagent-presentation.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 warning prefix 和 completed outcome 都不提升 result trust。

## Task 12: M-069 InjectionSuspicionSignal

**Files:**
- Create: `src/agent/context/injection-signal.ts`
- Test: `src/__tests__/agent/injection-signal.test.ts`

**Interfaces:**
- Consumes: untrusted/unknown source + deterministic ingress result + advisory evidence。
- Produces: `createInjectionSuspicionSignal()`。

- [ ] **Step 1: 写软信号权限边界 RED**

```ts
it('cannot mutate source or create a security decision', () => {
  const source = freezeSnapshot(untrustedSource);
  const signal = createInjectionSuspicionSignal(input);
  expect(signal).not.toHaveProperty('behavior');
  expect(signal).not.toHaveProperty('security_decision_ref');
  expect(source.trust).toBe('untrusted');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/injection-signal.test.ts
```

- [ ] **Step 3: 实现 signal**

精确实现 §11.5。Model signal 可以无 evidence 作为低置信提示，但不能阻断；deterministic rejection 始终优先。多个 signal 只关联，不投票。

- [ ] **Step 4: 实现 report recommendation policy**

`user_report_recommended` 由独立确定性 policy 根据风险/任务影响产生，不由模型自由布尔值决定；signal 不记录隐藏思维。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/agent/injection-signal.test.ts src/__tests__/agent/context-sanitizer.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 false positive 不写永久 deny，signal schema failure 不改变原 SecurityDecision。

## Task 13: M-054 DecisionTraceEvent

**Files:**
- Create: `src/agent/observability/decision-trace.ts`
- Modify: `src/agent/observability/envelopes.ts`
- Test: `src/__tests__/agent/decision-trace.test.ts`

**Interfaces:**
- Consumes: actual deterministic policy result/decision refs。
- Produces: `createDecisionTraceEvent()`。

- [ ] **Step 1: 写最小字段 RED**

```ts
it('stores snapshot refs instead of raw decision inputs', () => {
  const trace = createDecisionTraceEvent(validTraceInput);
  expect(trace.input_snapshot_refs).toEqual(['action-1', 'policy-1']);
  expect(trace).not.toHaveProperty('raw_input');
  expect(trace).not.toHaveProperty('reasoning');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/decision-trace.test.ts
```

- [ ] **Step 3: 实现实际 subsystem 枚举**

只包含 permission、command_policy、path_policy、environment_policy、delegation_policy、source_router。Decision ID 必须可由 registry lookup 验证；error_code 与 result_code 分离。

- [ ] **Step 4: 包装 BRC-7 envelope**

plane 固定 `decision_trace`，payload 仍不能进入 production，直到 Task 14 field policy/redaction 通过。

- [ ] **Step 5: 验证**

```powershell
npx vitest run src/__tests__/agent/decision-trace.test.ts src/__tests__/agent/observability-envelopes.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认没有预建 classifier，没有完整输入或隐藏思维。

## Task 14: M-056 Telemetry Field Policy 与 Redaction

**Files:**
- Create: `src/agent/observability/redaction.ts`
- Modify: `src/agent/observability/envelopes.ts`
- Test: `src/__tests__/agent/telemetry-redaction.test.ts`

**Interfaces:**
- Consumes: minimal event payload、`TelemetryFieldPolicy`。
- Produces: `redactTelemetryEvent()`、`TelemetryRedactionResult`。

- [ ] **Step 1: 写 credential/unknown 默认 drop RED**

```ts
it.each([
  ['credential', 'none', 'drop_event'],
  ['operational_metadata', 'sensitive_auth', 'drop_event'],
  ['unknown', 'none', 'drop_field'],
  ['pseudonymous_identifier', 'direct_identifier', 'drop_field'],
] as const)('applies minimum action for %s/%s', (fieldClass, pii, expected) => {
  const result = redactTelemetryEvent(eventWithField('value'), policyFor(fieldClass, pii, 'keep'));
  expect(result.applied_actions[0].action).toBe(expected);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/telemetry-redaction.test.ts
```

- [ ] **Step 3: 实现字段策略**

精确实现 §12.3/§12.4。未列字段 drop；user_content/source_code 默认不生产发送；potential identifier 至少 hash/redact/drop；hash 结果仍标记敏感。

- [ ] **Step 4: 实现 production gate**

redaction 在 serialization/sink 前；失败 drop event；不得保留 raw sidecar。Decision trace 进入 production 也必须经过相同 gate。

- [ ] **Step 5: sink failure 测试**

sink unavailable 时不缓存未清洗 payload、不改变 Outcome/SecurityDecision/CompletionReport，只增加最小本地计数。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/telemetry-redaction.test.ts src/__tests__/agent/decision-trace.test.ts src/__tests__/agent/observability-envelopes.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 redaction 没有扩大采集字段，full dump 仍关闭。

## Task 15: Wave C 公共出口与 INV-C1～C15 验收

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/memory/index.ts`
- Modify: `src/permission/index.ts`
- Modify: `src/config/index.ts`
- Create: `src/__tests__/agent/wave-c-contracts.test.ts`
- Create: `logs/agent-mechanisms-wave-c-verification.md`

**Interfaces:**
- Consumes: Task 1～14。
- Produces: Wave D 稳定 imports、15 条不变量证据。

- [ ] **Step 1: 写公共出口 RED**

```ts
it('exports every Wave C policy anchor', () => {
  expect([
    resolvePromptPolicy,
    applyCapabilityOverride,
    buildEnvironmentContextBlock,
    routeMarkdownSource,
    createTypedMemoryCandidate,
    projectToolPolicy,
    validateNoToolRequest,
    evaluateDelegationGate,
    createInjectionSuspicionSignal,
    createDecisionTraceEvent,
    redactTelemetryEvent,
  ].every((value) => value !== undefined)).toBe(true);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/wave-c-contracts.test.ts
```

- [ ] **Step 3: 导出公共接口**

只导出 policy input/result/builder；内部 rank、hash、formatter、legacy adapter 不导出。

- [ ] **Step 4: 建立 INV-C1～C15 测试名**

```text
INV-C1 policy evaluation is replayable
INV-C2 precedence does not change authority
INV-C3 conditions are closed and tri-state
INV-C4 cache eligibility is not measured benefit
INV-C5 capability override requires trusted configuration
INV-C6 files and schemas do not establish trust
INV-C7 memory candidate is not admitted memory
INV-C8 runtime policy is the tool truth source
INV-C9 no-tools is enforced across four gates
INV-C10 delegation cannot widen parent boundaries
INV-C11 injection suspicion is advisory only
INV-C12 observability minimizes before redaction
INV-C13 frozen DAG gains no reverse dependency
INV-C14 failure never upgrades privilege or state
INV-C15 protocol versions remain orthogonal
```

- [ ] **Step 5: 运行 targeted suite**

```powershell
npx vitest run src/__tests__/agent/prompt-condition-scope.test.ts src/__tests__/agent/prompt-resolution.test.ts src/__tests__/agent/prompt-resolution-compiler.test.ts src/__tests__/config/capability-override.test.ts src/__tests__/agent/environment-context-block.test.ts src/__tests__/agent/markdown-routing.test.ts src/__tests__/memory/memory-candidate.test.ts src/__tests__/agent/tool-policy-projection.test.ts src/__tests__/agent/no-tool-contract.test.ts src/__tests__/permission/delegation-gate.test.ts src/__tests__/permission/delegation-handoff.test.ts src/__tests__/agent/injection-signal.test.ts src/__tests__/agent/decision-trace.test.ts src/__tests__/agent/telemetry-redaction.test.ts src/__tests__/agent/wave-c-contracts.test.ts
```

- [ ] **Step 6: 运行受影响回归**

```powershell
npx vitest run src/__tests__/streaming-query.test.ts src/__tests__/compression.test.ts src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts src/__tests__/permission.test.ts src/__tests__/config.test.ts src/__tests__/memory.test.ts src/__tests__/regression/
```

- [ ] **Step 7: 静态、构建与全量验证**

```powershell
npm run typecheck
npm run lint
npm run build
npm test
```

- [ ] **Step 8: 写验证日志**

```markdown
# Wave C Verification

- changed: [实际文件]
- mechanisms: M-002, M-003, M-004, M-009, M-012, M-026, M-031, M-043, M-054, M-056, M-059, M-067, M-069
- verification_level: V3
- red_evidence: [命令与失败原因]
- green_evidence: [命令与通过计数]
- invariant_evidence: INV-C1 through INV-C15
- no_direct_wave_d_edge: CRC-2, CRC-5
- remaining_uncertainty: [仅列真实未验证项]
- deferred_hold_check: no Deferred or Hold implementation activated
```

- [ ] **Step 9: Review checkpoint**

逐条对照 Wave C §17 验收矩阵、§18 完成标准和 §15 Wave D handoff。缺少测试/runtime assertion 时不得进入 Wave D。

## 3. Wave D Handoff

Wave C 通过后，Wave D 可以依赖：

- deterministic PromptResolutionPlan、condition evidence、scope classification；
- freshness-aware EnvironmentContextBlock；
- four-gate MarkdownRouteDecision；
- evidence/confidence/freshness/invalidation 完整的 TypedMemoryCandidate；
- runtime-policy-backed ToolPolicyProjection；
- machine-enforced NoToolRequestContract；
- DecisionTraceEvent；
- field allowlist、PII labels、redacted/dropped result。

Wave D 不能假设：

- static 已产生 cache 收益；
- mode profile 可省略 mandatory/security/completion sections；
- file/schema/path 建立 trust；
- memory candidate 已 admitted；
- tool name 存在就 reference 完整；
- decision trace 就是 command policy；
- Prompt/tool telemetry 可采集正文；
- redaction 允许扩大范围。

CRC-2 与 CRC-5 只保留全局边界，没有 Wave D 直接 D-edge。

## 4. 完成标准

1. 13 个机制均有唯一主 Task。
2. 6 个 CRC 均有公开 policy anchor。
3. INV-C1～C15 均有机器可判定证据。
4. CRC-1 condition/resolution/compiler 按 T1→T2→T3 串行。
5. 同层 base 冲突和 mandatory unknown 均 rejected。
6. Capability override 四重 gate 缺一不生效。
7. Markdown routing 四重 trust gate 缺一 reject。
8. TypedMemoryCandidate 没有 storage/admission 权限。
9. No-tools 四重 enforcement 均生效。
10. Delegation 不扩张，handoff 默认 untrusted。
11. Injection signal 没有 permission/trust mutation API。
12. Credential/sensitive_auth 默认 drop event。
13. CRC-2/CRC-5 无 Wave D 直接依赖。
14. targeted、regression、typecheck、lint、build、full test 有新鲜证据。
15. 没有实现 Wave D、Deferred 或 Hold。
16. 未执行部署、依赖升级、数据库迁移或 Git 历史写操作。
