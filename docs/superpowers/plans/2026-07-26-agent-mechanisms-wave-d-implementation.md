# mi-code Agent Mechanisms Wave D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 Wave D 的 6 个 Integrated Capability 机制，把结构化 Prompt profile、受信 Context activation、Memory admission/use、最终工具引用校验、组件级 telemetry 和 shell command structural policy 接入 Wave C 已冻结的 policy contracts。

**Architecture:** Wave D 继续采用“纯契约 → 兼容接入 → 主链路硬门 → Wave 验收”的迁移顺序。DRC-1～DRC-5 保持独立：mode profile 不拥有 mode，Context activation 不建立 trust，Memory admission 与 use 分离，telemetry 只观察，command structural policy 与现有 Plan/argument/path/RC-5 决策做 AND composition。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、现有 `shell-quote` tokenizer、现有 Anthropic/OpenAI/Google adapters、现有 PermissionChecker/RuntimeSecurityGate、现有 BRC-7/CRC-6 observability contracts。

## Global Constraints

- 唯一设计输入是冻结的主实施计划、Wave A～C 实施计划和 `2026-07-26-agent-integrated-capabilities-wave-d-design.md`。
- 本计划只覆盖 M-008、M-028、M-044、M-048、M-055、M-064。
- DRC-1/M-048 与 DRC-3/M-028 没有 Wave E 直接 D-edge；不得为统一 handoff 人为添加。
- DRC-2 内 Project Instruction activation 与 Memory admission/use 是并列子协议，不互为前置。
- mode 只来自 `control_mode_snapshot_id`；Prompt、用户文本、文件内容和模型自报不能创建或切换 mode。
- profile 只能排除 optional section；没有明确 false condition evidence 的 mandatory section 不得省略。
- Project Instruction 与 Auto Memory 使用封闭 channel；不得互相转换、共享 writer、共享 admission 或提升 Authority。
- `admit ≠ persisted ≠ selected ≠ use`；本 Wave 不实现 Memory 持久化或选择。
- Tool reference 必须校验 compiled Prompt 与 final immutable tool view，不得以 base Registry 代替。
- estimator 与 Provider usage 必须使用不同 measurement kind；Provider aggregate 不得伪分配到 component。
- telemetry 正文默认不采集；production event 必须先通过 CRC-6 allowlist、PII classification 和 redaction/drop。
- DRC-5 必须复用现有 `shell-quote` 和 PermissionChecker 作为迁移输入，不新增 parser 依赖，不建立第二套权限词汇。
- structural parser 不执行 expansion、substitution、command、filesystem mutation 或环境解析。
- shadow 没有执行权；`effective_security_decision_ref` 必须为 `null`。
- enforced 使用 Plan allowlist、argument policy、path policy、AST structural policy、RC-5 permission 的 AND composition。
- DRC-5 不实现 M-065 的 executable resolution、PATH trust、loader variable 或 inline env 安全结论。
- 每个行为修改执行 RED→GREEN→REFACTOR；先确认测试因目标行为缺失而失败。
- Wave D 冻结前执行 targeted tests、影响模块回归、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
- 本计划不授权生产部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作。

---

## 1. 文件结构与所有权

```text
src/agent/
├── prompt/
│   ├── profiles.ts                    # DRC-1 / M-048
│   └── compiler.ts                    # DRC-1 compiler adapter
├── context/
│   └── activation.ts                  # DRC-2 / M-008
├── contracts/
│   └── request-snapshot.ts            # meta-context assembly
├── tools/
│   └── reference-validator.ts         # DRC-3 / M-028
└── observability/
    └── telemetry.ts                   # DRC-4 / M-055

src/memory/
└── admission.ts                       # DRC-2 / M-044

src/permission/
└── command-policy.ts                  # DRC-5 / M-064
```

这些文件均属于主计划已冻结的 `prompt/context/tools/observability/memory/permission` 域，不创建中央 Runtime。

共享文件必须串行修改：

| 文件 | 顺序 |
|---|---|
| `src/agent/prompt/profiles.ts` | Task 1 → Task 2 |
| `src/agent/context/activation.ts` | Task 3 → Task 4 → Task 7 |
| `src/agent/contracts/request-snapshot.ts` | Task 4 |
| `src/memory/admission.ts` | Task 5 → Task 6 |
| `src/agent/tools/reference-validator.ts` | Task 8 → Task 9 |
| `src/agent/observability/telemetry.ts` | Task 10 → Task 11 |
| `src/permission/command-policy.ts` | Task 12 → Task 13 → Task 14 |
| `src/agent/streaming-query.ts` | Task 9 → Task 14 |
| `src/permission/checker.ts` | Task 14 |

## 2. Task 依赖

```text
T1 Mode Profile Selection
 └→ T2 Profiled Compiler Input

T3 Project Instruction Activation
 └→ T4 Meta Context Request Integration

T5 Memory Admission
 └→ T6 Memory Use

T3 + T5 + T6
 └→ T7 Trusted Context Anchor

T8 Tool Reference Manifest
 └→ T9 Final Request Reference Gate

T10 Component Measurements
 └→ T11 Telemetry Batch Integration

T12 Command Structural Parse
 └→ T13 Shadow Comparison
     └→ T14 Enforced Composition

T1–T14 → T15 Wave D Acceptance
```

T1、T3、T5、T8、T10、T12 可并行开发，因为不共享生产文件。相邻 Wave 不并行实施。

## Task 1: M-048 Mode Profile Selection

**Files:**
- Modify: `src/agent/prompt/profiles.ts`
- Test: `src/__tests__/agent/mode-profile-selection.test.ts`

**Interfaces:**
- Consumes: CRC-1 `PromptResolutionPlan`、BRC-2 effective capability snapshot、结构化 control/role/task snapshot。
- Produces: `selectModeProfile(input, registry): ModeProfileSelection`。

- [ ] **Step 1: 写 mandatory coverage 与结构化 mode RED**

```ts
it('rejects a profile that omits a mandatory section', () => {
  const selection = selectModeProfile({
    ...selectionInput,
    control_mode_snapshot_id: 'mode:plan@1',
    candidate_section_ids: ['base', 'security'],
  }, registryWithProfile({
    control_mode: 'plan',
    included_section_ids: ['base'],
  }));

  expect(selection.status).toBe('invalid');
  expect(selection.diagnostics).toContain('profile.mandatory_missing.security');
});

it('does not infer mode from user or prompt text', () => {
  expect(() => selectModeProfile({
    ...selectionInput,
    control_mode_snapshot_id: '',
    candidate_section_ids: ['text-says-plan'],
  }, registry)).toThrow(/control_mode_snapshot_id/);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/mode-profile-selection.test.ts
```

Expected: FAIL，`selectModeProfile` 尚不存在。

- [ ] **Step 3: 实现 profile definition 与 registry**

精确实现 Wave D §7.2～§7.4：

```ts
export function selectModeProfile(
  input: ModeProfileSelectionInput,
  registry: ModeProfileRegistry,
): ModeProfileSelection
```

Registry 只接受 approved immutable asset 或受信构建配置。一个 control mode 最多一个 default；role/task override 必须精确匹配；capability tag 只读取 effective capability snapshot。

- [ ] **Step 4: 实现 mandatory/optional 投影**

规则：

```text
mandatory + condition true       → included
mandatory + condition false      → not_applicable + evidence ref
mandatory + condition unknown    → invalid
optional + unsupported           → excluded + reason code
optional + capability unknown    → excluded + reason code
candidate 不在 resolution plan   → invalid
```

Profile 不改变 section content/hash/asset version/Authority/Trust/Placement/scope。

- [ ] **Step 5: 增加确定性与错误矩阵**

覆盖：

```text
unknown mode
multiple defaults
multiple role/task override matches
unapproved profile asset
request snapshot mismatch
mandatory false without evidence
duplicate included section
```

相同 immutable input 必须产生相同 `selection_id` 和排序。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/mode-profile-selection.test.ts src/__tests__/agent/prompt-resolution.test.ts src/__tests__/agent/agent-prompt-profiles.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 profile 没有 mode setter、permission API、cache-hit 字段或 section metadata mutation。

## Task 2: DRC-1 Profiled Compiler Input

**Files:**
- Modify: `src/agent/prompt/profiles.ts`
- Modify: `src/agent/prompt/compiler.ts`
- Test: `src/__tests__/agent/profiled-prompt-compilation.test.ts`

**Interfaces:**
- Consumes: `ModeProfileSelection(status='valid')`、CRC-1 `PromptResolutionPlan`、BRC-1 section resolver。
- Produces: `compileProfiledPrompt(selection, plan, dependencies): CompiledPromptSnapshot`。

- [ ] **Step 1: 写 selection/snapshot 绑定 RED**

```ts
it('refuses to compile a selection from another request snapshot', () => {
  expect(() => compileProfiledPrompt(
    validSelection({ request_snapshot_id: 'request-b' }),
    resolutionPlan({ request_snapshot_id: 'request-a' }),
    dependencies,
  )).toThrow(/request_snapshot_mismatch/);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/profiled-prompt-compilation.test.ts
```

- [ ] **Step 3: 实现 profiled adapter**

Adapter 只把 `included_section_ids` 投影为既有 `compileResolvedPrompt()` 输入。它必须验证：

- selection/plan/request identity 一致；
- included section 全部来自 plan；
- mandatory coverage 完整；
- excluded section 不进入 compiler；
- section scope 与 plan 一致；
- selection invalid 时没有旧字符串拼接 fallback。

- [ ] **Step 4: 写 metadata 不变测试**

对输入 section 的 content hash、Authority、Trust、Placement、asset version 和 scope 做前后深比较；profile 只能改变 included/excluded 集。

- [ ] **Step 5: 运行回归**

```powershell
npx vitest run src/__tests__/agent/profiled-prompt-compilation.test.ts src/__tests__/agent/prompt-resolution-compiler.test.ts src/__tests__/agent/prompt-compiler.test.ts
npm run typecheck
```

- [ ] **Step 6: Review checkpoint**

确认 DRC-1 没有为 Wave E 节点增加 import 或直接 handoff，且未宣称 cache/token 收益。

## Task 3: M-008 Project Instruction Activation

**Files:**
- Create: `src/agent/context/activation.ts`
- Test: `src/__tests__/agent/project-instruction-activation.test.ts`

**Interfaces:**
- Consumes: CRC-3 `MarkdownRouteDecision(target='project_instruction_context')`、BRC-3 bounded/sanitized source。
- Produces: `activateProjectInstruction(input): MetaContextActivation`。

- [ ] **Step 1: 写四重 trust 与 channel RED**

```ts
it.each([
  ['wrong_route', { route_target: 'auto_memory_context' }],
  ['missing_trust', { trust_proof_ref: null }],
  ['sanitizer_rejected', { sanitization_status: 'rejected' }],
  ['missing_budget', { source_budget_ref: null }],
] as const)('rejects %s activation', (_name, failure) => {
  expect(() => activateProjectInstruction({
    ...activationInput,
    ...failure,
  })).toThrow();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/project-instruction-activation.test.ts
```

- [ ] **Step 3: 实现 identity 与 output**

实现规格 §8.2～§8.4。输出必须固定：

```ts
{
  semantic_role: 'user',
  placement: 'meta_context',
  is_meta: true,
  retention_state: 'unassigned'
}
```

Authority、Trust、provenance、freshness、overflow metadata 只能从已验证输入复制，不能由 placement 推断。

- [ ] **Step 4: 实现 ordinal 与 source identity**

多个 activation 使用上游 scope/provenance order 和稳定 ordinal；ordinal 冲突直接 invalid。content hash、source context、route decision 必须相互匹配；不按路径字符串重排。

- [ ] **Step 5: 写跨通道负向测试**

Project Instruction activation 不能输出 `memory_candidate_id`、`admission_decision_id`、Memory writer 或 system placement。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/project-instruction-activation.test.ts src/__tests__/agent/markdown-routing.test.ts src/__tests__/agent/context-intake.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 `is_meta=true` 没有改变 Authority、Trust 或 Retention。

## Task 4: DRC-2 Meta Context Request Integration

**Files:**
- Modify: `src/agent/context/activation.ts`
- Modify: `src/agent/contracts/request-snapshot.ts`
- Modify: `src/agent/anthropic-stream-client.ts`
- Modify: `src/agent/openai-stream-client.ts`
- Modify: `src/agent/google-stream-client.ts`
- Test: `src/__tests__/agent/meta-context-request.test.ts`
- Test: `src/__tests__/agent/provider-meta-context-conformance.test.ts`

**Interfaces:**
- Consumes: ordered `MetaContextActivation[]`、conversation、system sections。
- Produces: `attachMetaContext(requestInput, activations)` 与 Provider message conversion。

- [ ] **Step 1: 写 plane/order RED**

```ts
it('prepends meta context before conversation without replacing the current user', () => {
  const snapshot = attachMetaContext(requestInput, [metaActivation]);
  expect(snapshot.meta_context.map((item) => item.message_id)).toEqual(['meta-1']);
  expect(snapshot.conversation.at(-1)?.message_id).toBe('current-user');
  expect(snapshot.meta_context[0].is_meta).toBe(true);
  expect(snapshot.conversation.at(-1)?.is_meta).toBe(false);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/meta-context-request.test.ts
```

- [ ] **Step 3: 实现 request assembly**

只接收 `MetaContextActivation`；按 ordinal 排序后写入 `SemanticRequestSnapshot.meta_context`。不得复制到 system sections 或 conversation；不得把 meta 算作 current user turn。

- [ ] **Step 4: 写 Provider conformance RED**

三家 adapter 都必须保持 semantic user role、meta-before-conversation 顺序和内容 hash 对应关系。Provider SDK 不支持独立 meta metadata 时，metadata 保留在内部 snapshot，adapter 只编码 message；不能改写为 system role。

- [ ] **Step 5: 接入三家 adapters**

Adapter 只做协议转换。若目标 Provider 无法保持 user-role/order 语义，返回结构化 conversion failure，请求不得发送。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/meta-context-request.test.ts src/__tests__/agent/provider-meta-context-conformance.test.ts src/__tests__/agent/request-snapshot.test.ts src/__tests__/agent/provider-adapter-conformance.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认没有实现 M-038 retention/serializer/compressor 逻辑，也没有二次静默截断 bounded content。

## Task 5: M-044 Memory Admission

**Files:**
- Create: `src/memory/admission.ts`
- Test: `src/__tests__/memory/memory-admission.test.ts`

**Interfaces:**
- Consumes: CRC-3 `TypedMemoryCandidate`、current context/project version、type-specific policy。
- Produces: `decideMemoryAdmission(input, policy): MemoryAdmissionDecision`。

- [ ] **Step 1: 写默认 reject/defer RED**

```ts
it.each([
  ['credential', typedCandidate({ content_class: 'credential' })],
  ['turn_state', typedCandidate({ validity_scope: 'current_turn' })],
  ['missing_evidence', typedCandidate({ evidence_refs: [] })],
  ['project_instruction_copy', typedCandidate({ source_channel: 'project_instruction' })],
] as const)('rejects %s', (_name, candidate) => {
  expect(decideMemoryAdmission(inputFor(candidate), policy).status).toBe('reject');
});

it('defers stale evidence when a deterministic refresh path exists', () => {
  const result = decideMemoryAdmission(inputFor(staleCandidate), policy);
  expect(result.status).toBe('defer');
  expect(result.reason_codes).toContain('memory.freshness.refresh_required');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-admission.test.ts
```

- [ ] **Step 3: 实现 admission contract**

实现 `admit | reject | defer`、accepted scope/type、verification requirements、reason/evidence refs。只接受 `TypedMemoryCandidate`；非法 confidence（NaN/Infinity/<0/>1）reject。

- [ ] **Step 4: 实现 policy matrix**

逐项编码规格 §8.8/§8.9。`confidence=1` 仍需 evidence、freshness 和后续 use verification；不同 memory type 不做全局 confidence 排序。

- [ ] **Step 5: 写无副作用测试**

`decideMemoryAdmission()` 不读取或写入 MemoryManager，不产生 persistence/select/use 状态，不改变 TurnOutcome。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-admission.test.ts src/__tests__/memory/memory-candidate.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 `admit` 只表示可交给 Wave E M-045，不表示已写入或事实正确。

## Task 6: M-044 Current-Context Memory Use

**Files:**
- Modify: `src/memory/admission.ts`
- Test: `src/__tests__/memory/memory-use-decision.test.ts`

**Interfaces:**
- Consumes: admitted stored-memory metadata、current context/project version、claim verification evidence。
- Produces: `decideMemoryUse(input, verifier): MemoryUseDecision`。

- [ ] **Step 1: 写 current-context 绑定 RED**

```ts
it('does not reuse a use decision from another context snapshot', () => {
  const result = decideMemoryUse({
    ...memoryUseInput,
    current_context_snapshot_id: 'context-new',
    prior_decision: useDecision({ current_context_snapshot_id: 'context-old' }),
  }, verifier);
  expect(result.status).not.toBe('use');
  expect(result.reason_codes).toContain('memory.context_snapshot_mismatch');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-use-decision.test.ts
```

- [ ] **Step 3: 实现 use decision**

实现 `use | do_not_use | needs_refresh`。只有当前 context 中验证通过的 claim 进入 `verified_claim_refs`；stale/conflicting claim 分开记录。

- [ ] **Step 4: 实现 failure semantics**

```text
verifier unavailable       → needs_refresh 或 do_not_use
refresh failed             → do_not_use
project version mismatch   → needs_refresh
conflicting evidence       → do_not_use
missing admission decision → do_not_use
```

不得把 `needs_refresh` 作为低置信 use。

- [ ] **Step 5: 写 admission/use 正交测试**

断言 admit 不自动产生 use，use 不改变原 admission，writer failure/TurnOutcome 不属于本函数输出。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-use-decision.test.ts src/__tests__/memory/memory-admission.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认没有实现 Wave E persistence/selector，也没有把 Memory 放入 Prompt。

## Task 7: DRC-2 Trusted Context Anchor

**Files:**
- Modify: `src/agent/context/activation.ts`
- Test: `src/__tests__/agent/trusted-context-activation.test.ts`

**Interfaces:**
- Consumes: Task 3 `MetaContextActivation`、Task 5 `MemoryAdmissionDecision`、Task 6 `MemoryUseDecision`。
- Produces: `activateTrustedContext(input, dependencies): TrustedContextActivationResult`。

- [ ] **Step 1: 写封闭 channel RED**

```ts
it('does not convert project instructions into auto memory', () => {
  const result = activateTrustedContext({
    channel: 'project_instruction',
    project_instruction_input: projectInstructionInput,
    memory_candidate: null,
    memory_use_input: null,
  }, dependencies);
  expect(result.kind).toBe('meta_context_activation');
  expect(result).not.toHaveProperty('memory_admission_decision');
});

it('does not project admitted memory into prompt placement', () => {
  const result = activateTrustedContext({
    channel: 'auto_memory_admission',
    project_instruction_input: null,
    memory_candidate: typedCandidate,
    memory_use_input: null,
  }, dependencies);
  expect(result.kind).toBe('memory_admission_decision');
  expect(result).not.toHaveProperty('placement');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/trusted-context-activation.test.ts
```

- [ ] **Step 3: 实现 discriminated union**

```ts
export type TrustedContextActivationInput =
  | ProjectInstructionActivationRequest
  | AutoMemoryAdmissionRequest
  | AutoMemoryUseRequest;

export type TrustedContextActivationResult =
  | { kind: 'meta_context_activation'; value: MetaContextActivation }
  | { kind: 'memory_admission_decision'; value: MemoryAdmissionDecision }
  | { kind: 'memory_use_decision'; value: MemoryUseDecision };
```

`activateTrustedContext()` 只按封闭 channel 调用对应纯函数；不创建新 trust、Authority、Placement、Retention、persistence 或 selection 状态。

- [ ] **Step 4: 实现 identity/channel validation**

输入 route/source/context snapshot 必须与所选子协议匹配。混合字段、缺失字段、未知 channel 或跨 channel identity 一律 reject，不猜测意图。

- [ ] **Step 5: 写失败不升级状态测试**

Project activation、admission 或 use 任一失败都返回对应结构化 failure；不得回退到另一 channel，不得生成 system section、Memory write 或 `use`。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/trusted-context-activation.test.ts src/__tests__/agent/project-instruction-activation.test.ts src/__tests__/memory/memory-admission.test.ts src/__tests__/memory/memory-use-decision.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 Core Anchor 只是 DRC-2 的确定性编排器，不是中央 Context Runtime。

## Task 8: M-028 Tool Reference Manifest

**Files:**
- Create: `src/agent/tools/reference-validator.ts`
- Modify: `src/agent/prompt/compiler.ts`
- Test: `src/__tests__/agent/tool-reference-manifest.test.ts`

**Interfaces:**
- Consumes: compiled Prompt sections、structured asset metadata/compiler reference tokens、canonical tool identity。
- Produces: `buildToolReferenceManifest(input): ToolReferenceManifest`。

- [ ] **Step 1: 写结构化 manifest RED**

```ts
it('records stable tool ids instead of display-name guesses', () => {
  const manifest = buildToolReferenceManifest({
    compiled_prompt_snapshot_id: 'prompt-1',
    declarations: [{
      section_id: 'tools',
      tool_id: 'tool:run_bash',
      canonical_tool_name: 'run_bash',
      source_kind: 'compiler_reference_token',
      evidence_ref: 'asset:tools@1',
    }],
  });
  expect(manifest.records[0].tool_id).toBe('tool:run_bash');
  expect(manifest.records[0].source_kind).toBe('compiler_reference_token');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/tool-reference-manifest.test.ts
```

- [ ] **Step 3: 实现 declaration 与 manifest**

优先使用 structured asset metadata/compiler token。`deterministic_render_scan` 只扫描已登记 canonical name；普通自然语言歧义不猜测。

- [ ] **Step 4: 接入 compiler 输出**

Compiler 接收显式 tool declarations 并生成独立 manifest ID；manifest 不改变 Prompt 内容、tool order、visibility 或 permission。

- [ ] **Step 5: 写漂移与歧义测试**

重复 reference ID、一个 canonical name 映射多个 tool ID、未登记 rendered canonical reference、缺 evidence ref 均 invalid。重命名必须形成新 manifest/asset version。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/tool-reference-manifest.test.ts src/__tests__/agent/prompt-compiler.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认名称存在不等于 manual 充分，也没有实现 Deferred M-025 few-shot。

## Task 9: DRC-3 Final Request Reference Gate

**Files:**
- Modify: `src/agent/tools/reference-validator.ts`
- Modify: `src/agent/streaming-query.ts`
- Test: `src/__tests__/agent/tool-reference-validation.test.ts`
- Test: `src/__tests__/agent/request-reference-gate.test.ts`

**Interfaces:**
- Consumes: `ToolReferenceManifest`、compiled Prompt snapshot、final tool view、CRC-4 policy projection/no-tool validation。
- Produces: `validateToolReferences(input): ToolReferenceValidation` 与 pre-send hard gate。

- [ ] **Step 1: 写 final-view RED**

```ts
it('rejects a prompt reference to a tool excluded by the final view', () => {
  const result = validateToolReferences({
    ...validationInput,
    manifest: manifestReferencing('tool:run_bash'),
    finalToolView: toolViewExcluding('tool:run_bash'),
  });
  expect(result.status).toBe('invalid');
  expect(result.orphan_reference_ids).toContain('ref:run_bash');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/tool-reference-validation.test.ts
```

- [ ] **Step 3: 实现 deterministic validator**

每个 record 检查：

- final view visibility；
- canonical name；
- manual/description asset identity；
- policy projection；
- request/Prompt/tool-view snapshot identity。

同一 immutable input 重复调用必须深相等。

- [ ] **Step 4: 实现 no-tools 与 pre-send gate**

No-tools request 要求 manifest 与 final view 均为空。Invalid validation 阻止 Provider 调用；不得删除 Prompt 引用或改变 tool view 来“修复”。

- [ ] **Step 5: 写 execution/network spy**

```ts
expect(provider.send).not.toHaveBeenCalled();
expect(toolExecutor.execute).not.toHaveBeenCalled();
```

覆盖 orphan reference、canonical drift、manual mismatch、policy mismatch、undeclared rendered reference。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/tool-reference-validation.test.ts src/__tests__/agent/request-reference-gate.test.ts src/__tests__/agent/tool-policy-projection.test.ts src/__tests__/agent/no-tool-contract.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 validator 只检查 final request，不以 ToolRegistry base snapshot 代替，也没有 Wave E consumer。

## Task 10: M-055 Component Measurements

**Files:**
- Create: `src/agent/observability/telemetry.ts`
- Test: `src/__tests__/agent/component-telemetry.test.ts`

**Interfaces:**
- Consumes: BRC/CRC stable component refs、canonical encoded metadata、estimator/Provider usage。
- Produces: `measureTelemetryComponent(input): ComponentTelemetryEvent | DroppedTelemetryEvent`。

- [ ] **Step 1: 写 measurement-kind RED**

```ts
it('keeps estimator and provider usage in different kinds and scopes', () => {
  const event = measureTelemetryComponent(componentInput({
    estimated_tokens: 120,
    provider_input_tokens: 900,
  }));
  expect(event.token_measurements).toContainEqual(expect.objectContaining({
    measurement_kind: 'estimated_component_tokens',
    scope: 'component',
  }));
  expect(event.token_measurements).toContainEqual(expect.objectContaining({
    measurement_kind: 'provider_reported_input_tokens',
    scope: 'request',
  }));
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/component-telemetry.test.ts
```

- [ ] **Step 3: 实现 component/measurement vocabulary**

支持 `prompt_section | tool_schema | compiled_prompt | tool_view | semantic_request`。Stable ID 来自上游 snapshot，不从数组下标或显示名称生成。

每个 bytes/chars/tokens measurement 必须携带 method/version；数值必须有限、非负整数。

- [ ] **Step 4: 实现 metadata-only event**

默认字段只含 include reason、bytes、characters、content hash、measurements 和 refs。禁止 Prompt body、tool description body、user content、source code、filesystem path、credential。

- [ ] **Step 5: 写错误矩阵**

```text
missing component identity       → drop event
missing method/version           → drop measurement
provider usage at component scope→ invalid
invalid number                   → drop measurement/event
hash failure                     → drop event
```

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/component-telemetry.test.ts src/__tests__/agent/telemetry-redaction.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 hash 没有被描述为匿名化，estimator 变化没有被声明为 Provider 成本变化。

## Task 11: DRC-4 Telemetry Batch Integration

**Files:**
- Modify: `src/agent/observability/telemetry.ts`
- Modify: `src/agent/observability/envelopes.ts`
- Modify: `src/agent/stream-event-bus.ts`
- Test: `src/__tests__/agent/component-telemetry-batch.test.ts`

**Interfaces:**
- Consumes: Task 10 component events、CRC-6 field policy/redaction result、BRC-7 plane envelope。
- Produces: `buildComponentTelemetryBatch(input): ComponentTelemetryBatch` 与 production metadata event。

- [ ] **Step 1: 写 CRC-6 gate RED**

```ts
it('drops the batch when an event lacks an accepted redaction result', () => {
  const batch = buildComponentTelemetryBatch({
    ...batchInput,
    events: [componentEvent({ redaction_result_ref: '' })],
  });
  expect(batch.status).toBe('dropped');
  expect(batch.reason_codes).toContain('telemetry.redaction_result_missing');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/component-telemetry-batch.test.ts
```

- [ ] **Step 3: 实现 batch identity**

Batch 绑定 request、compiled Prompt、final tool view 和 profile selection identity。Provider aggregate 只保留 request/response scope，不按 component 分配。

- [ ] **Step 4: 接入 BRC-7/CRC-6**

只有通过 allowlist、PII classification 和 redaction/drop 的 event 可进入 production batch。Dropped event 原文不可由 bus、retry queue 或 error handler重新读取。

- [ ] **Step 5: 写 sink failure 独立性测试**

Listener/serialization/sink failure 不改变 Prompt snapshot、Memory decision、SecurityDecision 或 TurnOutcome；只记录最小本地 counter。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/component-telemetry-batch.test.ts src/__tests__/agent/component-telemetry.test.ts src/__tests__/agent/telemetry-redaction.test.ts src/__tests__/agent/observability-envelopes.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 full dump 仍禁用，未实现 Wave E local buffer/flush/rotation/retention。

## Task 12: M-064 Command Structural Parse

**Files:**
- Create: `src/permission/command-policy.ts`
- Test: `src/__tests__/permission/command-structural-parse.test.ts`
- Test: `src/__tests__/permission/fixtures/command-structural-corpus.ts`

**Interfaces:**
- Consumes: immutable command/action snapshot、显式 shell dialect/grammar version、complexity policy。
- Produces: `parseCommandStructure(input, policy): CommandParseResult`。

- [ ] **Step 1: 写 corpus RED**

```ts
it.each([
  ['pipeline', 'cat a | grep x', 'pipeline'],
  ['redirect', 'echo x > out.txt', 'redirect'],
  ['substitution', 'echo $(whoami)', 'substitution'],
  ['expansion', 'echo \"$HOME\"', 'expansion'],
  ['control_flow', 'test -f a && echo yes', 'control_flow'],
  ['environment_assignment', 'NODE_ENV=test npm test', 'environment_assignment'],
  ['executable_candidate', 'npm test', 'executable_candidate'],
] as const)('records %s without executing input', (_name, command, kind) => {
  const result = parseCommandStructure(commandInput(command), policy);
  expect(result.status).toBe('parsed');
  expect(result.risk_facts.map((fact) => fact.kind)).toContain(kind);
  expect(executionSpy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/command-structural-parse.test.ts
```

- [ ] **Step 3: 实现显式 dialect 与 grammar**

首个 grammar 只登记当前已有 `shell-quote` 能确定性覆盖的 `posix-shell-quote-v1`。Parser 调用 `shell-quote.parse(command)` 时不传 env resolver，不执行 substitution/expansion；原始 syntax scan 只产生结构事实和 source range。

未知 dialect/grammar 返回 `unsupported_syntax`，不得用当前 OS 或另一 shell 猜测。新 dialect 必须作为后续独立 grammar/version 进入，不在本 Task 预建。

- [ ] **Step 4: 实现 complexity policy**

固定读取 policy 中的 token、operator、nesting、source-length 上限。超过任一阈值返回 `too_complex` 和结构化 metric/reason；不得由 Agent 主观判断。

- [ ] **Step 5: 实现 AST/risk facts**

输出 command/pipeline/redirect/substitution/expansion/control_flow/environment_assignment/executable_candidate。环境赋值和 executable 只作为 syntax facts，不产生安全结论。

- [ ] **Step 6: 写失败与无副作用测试**

覆盖 invalid syntax、unsupported syntax、hash mismatch、source range、quoting/escaping preservation。Spy 断言未调用 child process、filesystem、env lookup 或 PermissionChecker。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/permission/command-structural-parse.test.ts src/__tests__/regression/bash-normalize.test.ts src/__tests__/regression/bash-path-sandbox.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认未新增 parser 依赖，environment assignment/executable candidate 已进入 corpus，且未实现 M-065。

## Task 13: DRC-5 Shadow Comparison

**Files:**
- Modify: `src/permission/command-policy.ts`
- Test: `src/__tests__/permission/command-policy-shadow.test.ts`

**Interfaces:**
- Consumes: `CommandParseResult`、legacy decision、受信 `CommandPolicyState(mode='shadow')`、CRC-6 decision trace builder。
- Produces: `compareCommandPolicyShadow(input): CommandShadowComparison`。

- [ ] **Step 1: 写 shadow 无执行权 RED**

```ts
it('never creates an effective security decision in shadow mode', () => {
  const comparison = compareCommandPolicyShadow(shadowInput);
  expect(comparison.divergence).toBe('ast_more_permissive');
  expect(comparison).not.toHaveProperty('effective_security_decision_ref');
  expect(runtimeGate.evaluate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/command-policy-shadow.test.ts
```

- [ ] **Step 3: 实现 divergence**

封闭为：

```text
none
legacy_more_permissive
ast_more_permissive
classification_mismatch
not_comparable
```

Unsupported/invalid/too-complex 且无法产生候选行为时为 `not_comparable`。

- [ ] **Step 4: 接入 decision trace**

只写 action/policy/parse/legacy snapshot refs、result/reason codes；不写完整 command、hidden reasoning 或 secret expansion。Trace/telemetry failure 不影响 legacy actual decision。

- [ ] **Step 5: 写受信状态测试**

Prompt、用户命令正文、模型输出和 telemetry 不能切换 shadow/enforced。历史 comparison immutable；policy state 变化形成新 snapshot。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/permission/command-policy-shadow.test.ts src/__tests__/agent/decision-trace.test.ts src/__tests__/permission/security-decision.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 shadow 不改变 allow/ask/deny、tool execution、pending decision 或 Outcome。

## Task 14: DRC-5 Enforced AND Composition

**Files:**
- Modify: `src/permission/command-policy.ts`
- Modify: `src/permission/checker.ts`
- Modify: `src/agent/streaming-query.ts`
- Test: `src/__tests__/permission/command-policy-enforced.test.ts`
- Test: `src/__tests__/permission/command-policy-cutover.test.ts`

**Interfaces:**
- Consumes: Plan allowlist、argument/path/AST decisions、RC-5 permission、RuntimeSecurityGate。
- Produces: `composeCommandStructuralDecision(input): CommandStructuralDecision` 与 run_bash pre-execution hard gate。

- [ ] **Step 1: 写 AND composition RED**

```ts
it.each([
  ['deny wins', ['allow', 'allow', 'deny', 'allow', 'allow'], 'deny'],
  ['ask blocks', ['allow', 'ask', 'allow', 'allow', 'allow'], 'ask'],
  ['all allow', ['allow', 'allow', 'allow', 'allow', 'allow'], 'allow'],
] as const)('%s', (_name, gates, expected) => {
  const result = composeCommandStructuralDecision(enforcedInput(gates));
  expect(result.candidate_behavior).toBe(expected);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/command-policy-enforced.test.ts
```

- [ ] **Step 3: 实现 fail-closed composition**

规则：

```text
任一 deny                       → deny
无 deny 且至少一个 ask          → blocking ask
全部明确 allow                  → allow
缺失 gate/identity/hash mismatch→ deny
ask channel unavailable         → deny
```

Plan Mode unknown command 保持 deny；用户只能退出/切换模式，不能在 Plan Mode 内批准该动作。

- [ ] **Step 4: 实现 parse failure policy**

Plan Mode 的 invalid/unsupported/too-complex 一律 deny。Normal Mode 只按受信 risk policy得到 ask 或 deny，不默认 allow。Enforced failure 不能回退 shadow/legacy allow。

- [ ] **Step 5: 接入 PermissionChecker 与 streaming gate**

使用兼容 adapter 把现有 bash/path/argument 结果映射为结构化 gate refs；RuntimeSecurityGate 仍是执行前唯一入口。`mode='shadow'` 时保留 legacy actual decision；只有 Task 14 Activation Gate 全部满足且受信配置切换为 enforced，才消费 structural result。

- [ ] **Step 6: 实现 Activation Gate assertion**

切换 enforced 前必须具有：

```text
grammar/version frozen
corpus includes substitution/redirect/pipeline/control-flow/quoting
corpus includes environment_assignment/executable_candidate
divergence baseline recorded
false-allow/false-deny baseline recorded
too-complex policy frozen
Plan/argument/path/RC-5 composition verified
pending ask persistence verified
rollback policy-state-only verified
```

缺任一项拒绝 activation。

- [ ] **Step 7: 写 executor/ask integration tests**

```ts
expect(executor.execute).not.toHaveBeenCalled();
expect(pendingDecision.status).toBe('awaiting_user');
```

覆盖 deny、ask、unavailable ask、stale action snapshot、parser failure、shadow/enforced 切换和 rollback。

- [ ] **Step 8: 运行 V3 影响路径**

```powershell
npx vitest run src/__tests__/permission/command-policy-enforced.test.ts src/__tests__/permission/command-policy-cutover.test.ts src/__tests__/permission/runtime-gate.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 AST 没有替代 Plan allowlist、argument/path policy、RC-5 permission 或 M-063 env scrub；未实现 executable resolution/PATH/env assignment 安全结论。

## Task 15: Wave D 公共出口与 INV-D1～D18 验收

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/memory/index.ts`
- Modify: `src/permission/index.ts`
- Create: `src/__tests__/agent/wave-d-contracts.test.ts`
- Create: `logs/agent-mechanisms-wave-d-verification.md`

**Interfaces:**
- Consumes: Task 1～14。
- Produces: Wave E 稳定 imports、18 条不变量证据和 Wave D 完成报告。

- [ ] **Step 1: 写公共出口 RED**

```ts
it('exports every Wave D capability anchor', () => {
  expect([
    selectModeProfile,
    activateProjectInstruction,
    activateTrustedContext,
    decideMemoryAdmission,
    decideMemoryUse,
    validateToolReferences,
    buildComponentTelemetryBatch,
    parseCommandStructure,
    composeCommandStructuralDecision,
  ].every((value) => value !== undefined)).toBe(true);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/wave-d-contracts.test.ts
```

- [ ] **Step 3: 导出稳定接口**

只导出 DRC input/output、builder、validator 和 policy refs。内部 tokenizer adapter、hash helper、rank、legacy mapper 和 test corpus 不导出。

- [ ] **Step 4: 建立 INV-D1～D18 测试名**

```text
INV-D1 snapshots stay aligned
INV-D2 profiles preserve mandatory sections
INV-D3 mode comes from structured state
INV-D4 placement does not change authority
INV-D5 project instructions and auto memory stay separate
INV-D6 admission and use stay separate
INV-D7 confidence is not truth
INV-D8 meta is not retained
INV-D9 references validate the final view
INV-D10 a name is not a manual
INV-D11 telemetry only observes
INV-D12 measurement sources are explicit
INV-D13 production telemetry is minimized before sending
INV-D14 shadow has no execution authority
INV-D15 AST and Plan policy compose with AND
INV-D16 failures never upgrade state
INV-D17 protocol versions stay orthogonal
INV-D18 no frozen dependency edge is added
```

- [ ] **Step 5: 运行 targeted Wave D suite**

```powershell
npx vitest run src/__tests__/agent/mode-profile-selection.test.ts src/__tests__/agent/profiled-prompt-compilation.test.ts src/__tests__/agent/project-instruction-activation.test.ts src/__tests__/agent/meta-context-request.test.ts src/__tests__/memory/memory-admission.test.ts src/__tests__/memory/memory-use-decision.test.ts src/__tests__/agent/trusted-context-activation.test.ts src/__tests__/agent/tool-reference-manifest.test.ts src/__tests__/agent/tool-reference-validation.test.ts src/__tests__/agent/component-telemetry.test.ts src/__tests__/agent/component-telemetry-batch.test.ts src/__tests__/permission/command-structural-parse.test.ts src/__tests__/permission/command-policy-shadow.test.ts src/__tests__/permission/command-policy-enforced.test.ts src/__tests__/agent/wave-d-contracts.test.ts
```

- [ ] **Step 6: 运行影响模块回归**

```powershell
npx vitest run src/__tests__/agent/ src/__tests__/memory/ src/__tests__/permission/ src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts
```

- [ ] **Step 7: 运行 Wave Gate**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

- [ ] **Step 8: 写验证日志**

`logs/agent-mechanisms-wave-d-verification.md` 必须记录：

```text
changed: 实际修改文件
mechanisms: M-008, M-028, M-044, M-048, M-055, M-064
verification_level: V3
red_evidence: 命令、目标失败测试、失败原因
green_evidence: 命令、通过文件数、通过测试数
invariant_evidence: INV-D1 through INV-D18
activation_state: DRC-5 shadow by default; enforced only when every gate passes
no_direct_wave_e_edge: DRC-1, DRC-3
remaining_uncertainty: 仅列真实未验证项
deferred_hold_check: no Deferred or Hold implementation activated
```

- [ ] **Step 9: Review checkpoint**

逐条对照 Wave D §16 验收矩阵、§17 完成标准和 §14 Wave E handoff。缺少 runtime assertion、RED/GREEN 或回归证据时不得进入 Wave E。

## 3. Wave E Handoff

Wave D 通过后，Wave E 可以依赖：

- M-038：不可变 meta message identity、`is_meta=true`、Placement/Authority/Trust/provenance、`retention_state='unassigned'`；
- M-045：`MemoryAdmissionDecision(status='admit')`、accepted type/scope、evidence 和 verification requirements；
- M-046：admission metadata、scope/type/freshness/provenance 与确定性 `MemoryUseDecision` gate；
- M-052：已通过 CRC-6 gate 的 component event/batch、correlation identity 和 measurement source；
- M-065：CommandParseResult、executable/environment syntax facts、source range、action/decision identity。

Wave E 不能假设：

- meta 已 retained，或 serializer/compressor 已支持 meta metadata；
- admit 已持久化；
- admission/selection 等于 use；
- dropped telemetry 原文可以恢复；
- local buffer/flush/rotation 已存在；
- executable、PATH、loader variable 或 inline env assignment 已安全；
- AST allow 可以覆盖 M-063 env scrub、Plan allowlist 或 RC-5 permission；
- DRC-1/DRC-3 是 Wave E 直接依赖。

## 4. 完成标准

1. M-008、M-028、M-044、M-048、M-055、M-064 均有唯一主 Task。
2. DRC-1～DRC-5 均有公开 capability anchor。
3. INV-D1～D18 均有机器可判定测试或 runtime assertion。
4. Mode profile 只消费结构化 mode，且不能省略 mandatory section。
5. Project Instruction 只进入 meta context，不进入 system/current-user/Memory。
6. `is_meta=true` 不改变 Authority、Trust 或 Retention。
7. Memory admission 与 current-context use decision 独立。
8. Tool reference 校验 final immutable request，不校验 base Registry。
9. Invalid reference 在 Provider send 前 fail closed。
10. Estimator 与 Provider usage 的 kind/scope/method 分离。
11. Production telemetry 默认 metadata-only，并先过 CRC-6 gate。
12. Command parser 不执行 command/expansion/substitution/filesystem/env lookup。
13. Command corpus 覆盖 environment assignment 与 executable candidate。
14. Shadow 不改变 permission、execution、ask 或 Outcome。
15. Enforced 使用 Plan/argument/path/AST/RC-5 AND composition。
16. Parser failure、missing gate 和 ask unavailable 均不回退 allow。
17. DRC-5 不实现 M-065 executable/env 安全结论。
18. DRC-1/DRC-3 无 Wave E 直接 D-edge。
19. Targeted、regression、typecheck、lint、build、full test 有新鲜证据。
20. 未实现 Wave E、Deferred 或 Hold。
21. 未执行部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作。
