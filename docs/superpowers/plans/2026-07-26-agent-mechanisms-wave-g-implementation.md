# mi-code Agent Mechanisms Wave G Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 M-049/GRC-1 Post-Compact Reconstruction，在压缩前后验证 tool transcript，把当前仍有效的 project instruction、target-context Memory、summary、current user 和 structural execution state 重建为不可变 candidate，并通过可恢复的原子发布替换 active working set。

**Architecture:** Wave G 采用单一 Reconstruction Transaction。主路径依次执行 capture → preflight → compaction result validation → pinned-source resolution → target-context rebuild → candidate assembly → postflight → atomic publish；required item 未解析时阻断，optional Memory 失败时显式降级，任何失败都保留最后一个 durable active snapshot。`reconstructPostCompactWorkingSet()` 是纯协调核心，不拥有 Prompt 编译、source trust、Memory use、tool pairing、压缩算法或 session storage 语义。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、Node `crypto`、现有 compression engine、Wave B `ToolTranscriptValidation`、Wave D/E project-instruction lifecycle、Wave F bounded Memory entrypoint、现有 `SessionStore`。

## Global Constraints

- 唯一设计输入是冻结的主实施计划、Wave A～F 实施计划和 `2026-07-26-agent-post-compact-reconstruction-wave-g-design.md`。
- 本计划只覆盖 M-049，并且只映射到 GRC-1。
- M-049 只消费冻结 D-edge：M-008、M-013、M-038、M-070；不得新增 M-031、M-033、M-052、M-060 或任意 Hold 机制的 D-edge。
- GRC-1 不恢复完整 pre-compact transcript，只重建当前仍有效的 Pinned Working Set。
- Preflight `ToolTranscriptValidation(checkpoint='before_compaction')` 未 accepted 时不得执行 compaction。
- Postflight `ToolTranscriptValidation(checkpoint='before_provider_send')` 未 accepted 时不得 publish 或 send。
- Completed tool call 在 reconstruction、retry、resume、recovery 或 publish 中都不得重新执行。
- Summary 是 text-only derived context；不是 tool result、SecurityDecision、PermissionDecision、CompletionReport、current user、project instruction 或 Memory use evidence。
- 旧 system Prompt string 不进入 Pinned Working Set；下一次请求仍由 BRC-1 独立编译。
- Project instruction 只能按 `preserve_exact`、`reload`、`exclude` 或 `block` 处理；`reload_required` marker 不等于 reload acknowledgement。
- `invalidated` source 不得从 summary、cache、旧正文或旧 snapshot 复活。
- 旧 `BoundedMemoryEntrypointSnapshot` 只提供 rebuild identity；旧 `MemoryUseDecision` 不得跨 target context 复用。
- Current user message 必须 exact preserve、只出现一次，并保持在 `current_user` plane。
- Execution state 只保存结构化 refs，不进入 Provider-visible 正文。
- Required item 未解析时不得 partial publish；optional item 缺失必须写入 omission/degradation manifest。
- Candidate 在 postflight accepted 前不可发送；publish 必须是 active working set pointer 的原子替换或等价语义。
- Durable publish acknowledgement 完成前，最后一个有效 pre-compact/active snapshot 必须保持可恢复。
- 相同 idempotency key 不重复 compaction、reload、Memory rebuild、消息插入或 publish。
- Cache、telemetry 和日志只提供性能或观测，不拥有 resolution、ordering、validation、publish 或 recovery 语义。
- Reconstruction failure 不提升 trust/use/completion/publish 状态，也不改变业务 `TurnOutcome`。
- 每项行为修改执行 RED→GREEN→REFACTOR，保留失败原因正确的 RED 证据。
- Wave G 冻结前执行 targeted tests、影响模块回归、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`，并执行 post-compact continue 的 V3 等价 E2E。
- 本计划不授权生产部署、依赖升级、数据迁移、Prompt Library 激活或 Git 历史写操作。

---

## 1. 文件结构与所有权

```text
src/agent/context/
└── reconstruction.ts                  # GRC-1 contracts, pure planning, resolution, candidate/postflight

src/agent/
├── compression.ts                     # immutable CompactionResultSnapshot adapter
├── streaming-query.ts                 # activation/cutover; no reconstruction semantics
└── index.ts                           # Wave G public exports

src/session/
└── store.ts                           # transaction, recovery point, atomic publish acknowledgement
```

测试：

```text
src/__tests__/agent/
├── reconstruction-capture.test.ts
├── reconstruction-preflight.test.ts
├── reconstruction-source-resolution.test.ts
├── reconstruction-memory.test.ts
├── reconstruction-candidate.test.ts
├── reconstruction-postflight.test.ts
├── reconstruction-publish.test.ts
├── reconstruction-recovery.test.ts
├── reconstruction-activation.test.ts
└── reconstruction-invariants.test.ts

src/__tests__/
├── compression.test.ts
├── streaming-query.test.ts
└── session/session-store.test.ts
```

共享文件串行修改：

| 文件 | 顺序 |
|---|---|
| `src/agent/context/reconstruction.ts` | Task 1 → 3 → 4 → 5 → 6 → 7 → 8 → 11 |
| `src/session/store.ts` | Task 2 → 9 → 10 |
| `src/agent/compression.ts` | Task 3 → 10 |
| `src/agent/streaming-query.ts` | Task 10 |
| `src/agent/index.ts` | Task 11 |

实现者必须先复核当前分支是否已有同名等价模块或上游计划产物；存在时修改既有文件，不创建第二套 contract、store、validator 或 compiler。

## 2. Task 依赖

```text
T1 Policy + Immutable Capture
 ├→ T2 Transaction Persistence + Idempotency
 └→ T3 Preflight + Compaction Result Adapter

T1 + T3
 ├→ T4 Pinned Working Set Plan
 ├→ T5 Project Instruction Resolution
 └→ T6 Target-Context Memory Rebuild

T4 + T5 + T6
 └→ T7 Candidate Assembly + Omission/Budget
     └→ T8 Postflight Validation

T2 + T8
 └→ T9 Atomic Publish + Recovery
     └→ T10 Activation + Streaming Cutover

T1–T10 → T11 Public Export + INV-G1～G20 Acceptance
```

Task 5 与 Task 6 可以并行开发；两者只共享冻结的 plan/input identities，不共享状态所有权。Task 9 必须在 Task 8 的 immutable accepted result 之后接线。Task 10 是唯一主路径切换点，在此之前新旧路径并存。

迁移批次：

| 批次 | Tasks | 允许状态 |
|---|---|---|
| Contract | 1、3、4、7、8 | 新 contract/纯函数存在，生产路径不切换 |
| Adapter | 2、5、6 | 复用现有 store、lifecycle、FRC-1，不重写 |
| Cutover | 9、10 | activation gate 全通过后原子切换 |
| Retirement | 10、11 | 回归和恢复测试通过后移除旧“summary-only replace”主路径 |

---

## Task 1: GRC-1 Policy、Identity 与 Immutable Capture

**Files:**
- Create: `src/agent/context/reconstruction.ts`
- Test: `src/__tests__/agent/reconstruction-capture.test.ts`

**Interfaces:**
- Consumes: session/turn/task/context/transcript/current-user/project/meta/Memory/execution/budget snapshots。
- Produces: `capturePreCompactSnapshot(input): PreCompactSnapshot`、`createReconstructionTransactionRequest(input): PostCompactReconstructionTransaction`。

- [ ] **Step 1: 写 policy 封闭值域 RED**

```ts
it('rejects a policy that makes current user optional', () => {
  expect(() => createReconstructionPolicy({
    ...validPolicy,
    current_user_requirement: 'optional_current',
  } as never)).toThrow(/current_user_requirement/);
});

it('accepts only atomic publish and reject-unknown behavior', () => {
  expect(() => createReconstructionPolicy({
    ...validPolicy,
    publish_mode: 'incremental',
  } as never)).toThrow(/publish_mode/);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-capture.test.ts
```

- [ ] **Step 3: 实现共同词汇和 policy**

精确实现 GRC-1 §6、§7.2：

```text
ReconstructionState
WorkingSetRequirement
ReconstructionResolutionAction
ReconstructionPolicy
PreCompactSnapshot
PostCompactReconstructionTransaction
```

Policy 只能来自受信 runtime/configuration；Prompt、summary、source、Tool Result 和 Agent 不得覆盖。

- [ ] **Step 4: 实现一次性 immutable capture**

捕获：

```text
session/turn/task/current-context/project
transcript snapshot
current user ref/hash
active project activation refs
active meta lifecycle refs
old Memory entrypoint ref
structural execution refs
target request budget
```

Capture 后到达的新 user message、tool result、activation 或 Memory decision 不得混入当前 attempt。

- [ ] **Step 5: 实现 deterministic transaction identity**

Idempotency input 至少包含 GRC-1 §7.24 的 session/turn、preflight、compactor method/version、policy、target context、project/source identities、Memory rebuild identity、budget 和 postflight policy。不同 input snapshot 不得共享 key。

- [ ] **Step 6: 写 snapshot/version 正交测试**

断言 snapshot 深冻结；修改 policy、compactor、project、Memory、budget 或 validator version 只生成新的 transaction identity，不改写其他 protocol/version 字段。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-capture.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认输入中没有旧 system Prompt body、完整 transcript 恢复开关、Prompt Library asset 或 summary-derived permission。

---

## Task 2: Reconstruction Transaction Persistence 与 Idempotency

**Files:**
- Modify: `src/session/store.ts`
- Test: `src/__tests__/agent/reconstruction-recovery.test.ts`
- Test: `src/__tests__/session/session-store.test.ts`

**Interfaces:**
- Consumes: immutable pre-compact snapshot、transaction records、idempotency key。
- Produces: `ReconstructionPersistence` adapter、durable recovery acknowledgement、attempt lookup。

- [ ] **Step 1: 写 crash/retry RED**

```ts
it('keeps the old active snapshot when the process exits before publish', async () => {
  await store.savePreCompactSnapshot(precompact);
  await store.saveReconstructionTransaction(transaction({ state: 'assembled' }));
  await store.recoverSession('session-1');
  expect(await store.getActiveWorkingSetId('session-1')).toBe('working-set-old');
});

it('returns the existing attempt for the same idempotency key', async () => {
  await store.saveReconstructionTransaction(transaction({ idempotency_key: 'k1' }));
  await expect(store.beginReconstructionAttempt(transaction({ idempotency_key: 'k1' })))
    .resolves.toMatchObject({ reconstruction_transaction_id: 'tx-1' });
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-recovery.test.ts src/__tests__/session/session-store.test.ts
```

- [ ] **Step 3: 冻结 persistence port**

最小接口：

```ts
interface ReconstructionPersistence {
  savePreCompactSnapshot(snapshot: PreCompactSnapshot): Promise<DurableAcknowledgement>;
  beginAttempt(transaction: PostCompactReconstructionTransaction): Promise<AttemptRecord>;
  appendState(record: ReconstructionStateRecord): Promise<void>;
  loadByIdempotencyKey(key: string): Promise<AttemptRecord | null>;
  getActiveWorkingSet(sessionId: string): Promise<ActiveWorkingSetRecord>;
}
```

接口只定义语义，不规定 session serializer 文件格式。

- [ ] **Step 4: 实现 append-only transaction records**

旧 transaction record 不修改；状态前进产生新 record。`blocked` 可在外部条件满足后创建新 attempt，`rejected` 不可发布。

- [ ] **Step 5: 实现 durable pre-compact recovery point**

Compaction 只能在 `savePreCompactSnapshot()` acknowledgement 后开始。持久化失败保持旧 active snapshot，不调用 compactor。

- [ ] **Step 6: 实现 idempotent resume**

相同 key：

- 已 published → 返回同一 restored snapshot；
- 未完成 → 从最后 durable state 安全续跑；
- input identity 不同 → reject；
- 不重新执行 completed side effects。

- [ ] **Step 7: 写损坏/缺失记录测试**

损坏 transaction、缺失 precompact、ack 不一致、未知 state 默认 fail closed；不得从日志正文或 summary 猜测恢复状态。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-recovery.test.ts src/__tests__/session/session-store.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认没有建立第二个 session store，也没有用 telemetry/debug log 作为恢复源。

---

## Task 3: Preflight Gate 与 Immutable Compaction Result Adapter

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Modify: `src/agent/compression.ts`
- Test: `src/__tests__/agent/reconstruction-preflight.test.ts`
- Test: `src/__tests__/compression.test.ts`

**Interfaces:**
- Consumes: `PreCompactSnapshot`、BRC-5 `validateToolTranscript()`、现有 compactor output。
- Produces: `runReconstructionPreflight()`、`createCompactionResultSnapshot()`。

- [ ] **Step 1: 写 before-compaction hard-gate RED**

```ts
it.each([
  'pending_execution',
  'missing_result',
  'orphan_result',
  'duplicate_result',
  'identity_conflict',
])('does not call the compactor for %s', async (pairState) => {
  const compact = vi.fn();
  const result = await runReconstructionPreflight(
    precompactWith(pairState),
    { validateToolTranscript, compact },
  );
  expect(result.status).not.toBe('accepted');
  expect(compact).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-preflight.test.ts
```

- [ ] **Step 3: 实现十项 preflight**

逐项实现 GRC-1 §7.4。Validation 必须绑定当前 transcript snapshot 和 `checkpoint='before_compaction'`；current-user identity/hash、policy、budget、idempotency 和 durable recovery point 全部通过后才返回 accepted。

- [ ] **Step 4: 包装现有 compactor**

保留 `runCompaction()`、`compactHistory()`、`compactHistoryWithLLM()` 的算法所有权，只新增 adapter，把 compactor 的不可变输出包装为 `CompactionResultSnapshot`：

```text
precompact/source transcript/preflight refs
method + method_version
summary ref/hash/bytes/lines
compactor acknowledgement
```

- [ ] **Step 5: 实现 summary shape validator**

验证 summary 非空、hash 可重放、text-only，不含 tool-use/tool-result block。Validator 只检查结果形状，不评价摘要质量，不接管 M-031。

- [ ] **Step 6: 写 summary 不拥有协议语义测试**

Summary 文本即使声称“tool succeeded”“permission granted”“memory verified”，也不能生成 result、permission、use、completion 或 execution acknowledgement。

- [ ] **Step 7: 写 compactor failure 测试**

异常、空 summary、source hash mismatch、ack 缺失均不进入 source resolution；旧 pre-compact snapshot 仍 active。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-preflight.test.ts src/__tests__/compression.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认本 Task 没有改变压缩阈值、摘要 Prompt、fallback 文案、max token 或 L1～L4 算法。

---

## Task 4: Pinned Working Set Plan、Current User 与 Structural Execution

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Test: `src/__tests__/agent/reconstruction-source-resolution.test.ts`

**Interfaces:**
- Consumes: accepted preflight、`CompactionResultSnapshot`、active source refs、target context。
- Produces: `buildPinnedWorkingSetPlan(): PinnedWorkingSetPlan`。

- [ ] **Step 1: 写封闭 item matrix RED**

```ts
it('builds the five item kinds with frozen requirements and planes', () => {
  const plan = buildPinnedWorkingSetPlan(validPlanInput);
  expect(plan.items.map(({ item_kind, requirement, target_plane }) => [
    item_kind, requirement, target_plane,
  ])).toEqual(expectedFrozenMatrix);
});

it('rejects old system prompt as a working-set item', () => {
  expect(() => buildPinnedWorkingSetPlan(inputWithOldSystemPrompt()))
    .toThrow(/unknown_item|system_prompt_not_reconstructable/);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-source-resolution.test.ts
```

- [ ] **Step 3: 实现 required item matrix**

精确映射：

```text
current_user_message      required_exact    current_user
compact_summary           required_current  conversation_summary
project_instruction_meta  required_current  meta_context
bounded_memory_entrypoint optional_current  system-section handoff only
execution_state           structural_only   execution_state
```

- [ ] **Step 4: 实现 current-user exact preserve**

Identity/hash 必须与 pre-compact snapshot 完全一致，只出现一次且位于 conversation tail。Transaction 期间新 user message 到达时，当前 attempt 不可 publish，必须捕获新 snapshot。

- [ ] **Step 5: 实现 structural execution refs**

只保留 tool call identity、completed/failed/cancelled acknowledgement、permission/security refs 和 accepted pair state。不得把 execution state、tool result 或 pending journal 正文加入 Provider-visible planes。

- [ ] **Step 6: 写 completed-tool no-reexecution 测试**

对 retry/resume/recovery 各执行一次，spy 断言 tool executor、permission gate 和 action submit 调用次数均为 0；summary 中的 tool 描述也不能触发调用。

- [ ] **Step 7: 实现稳定 ordinal 与 plan hash**

排序仅使用冻结的 source ordinal/identity，不根据正文或模型判断。Duplicate identity、ordinal conflict、unknown item 直接 rejected。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-source-resolution.test.ts src/__tests__/agent/tool-transcript-validator.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认旧 system Prompt string、完整 transcript、Provider-visible execution state 和 synthetic tool result 都不在 plan。

---

## Task 5: Project Instruction Preserve / Reload / Invalidate

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Test: `src/__tests__/agent/reconstruction-source-resolution.test.ts`

**Interfaces:**
- Consumes: DRC-2 `ProjectInstructionActivation`、ERC-1 `MetaMessageLifecycleRecord`、target project/context snapshot、受信 reload port。
- Produces: immutable `ReconstructionSourceResolution`。

- [ ] **Step 1: 写三态 resolution RED**

```ts
it.each([
  ['preserve', freshLifecycle(), 'preserve_exact', 'resolved'],
  ['reload_required', reloadLifecycle(), 'reload', 'resolved'],
  ['invalidated', invalidLifecycle(), 'exclude', 'excluded'],
])('resolves %s deterministically', async (_name, lifecycle, action, status) => {
  const result = await resolveProjectInstruction(source, lifecycle, target, deps);
  expect(result).toMatchObject({ action, status });
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-source-resolution.test.ts
```

- [ ] **Step 3: 实现 preserve gate**

只有 source freshness、project version、content hash、activation identity 全部有效时可 `preserve_exact`。Placement 不提升 Authority，meta 不增加 user turn。

- [ ] **Step 4: 实现 trusted reload adapter**

`reload_required` 调用上游受信 discovery/routing/loading/activation pipeline，要求新的 source/route/activation/lifecycle identity 和 acknowledgement。Marker、Agent、summary、旧正文或 cache 不可声明 reload 完成。

- [ ] **Step 5: 实现 invalidated exclude**

受信 lifecycle 判定 `invalidated` 是确定性成功 resolution：旧正文、cache 和 summary 中的副本均不得进入 candidate。

- [ ] **Step 6: 写 required failure/ordinal conflict 测试**

Required reload 失败 → `blocked`；source identity/hash 不一致或 ordinal conflict → `rejected`；两者都不能被 omission manifest 降级后继续 publish。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-source-resolution.test.ts src/__tests__/agent/meta-context-retention.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 GRC-1 没有重新实现 discovery、routing、trusted extraction、activation 或 retention，只消费 acknowledgement。

---

## Task 6: Target-Context Bounded Memory Rebuild

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Test: `src/__tests__/agent/reconstruction-memory.test.ts`
- Test: `src/__tests__/agent/bounded-memory-request.test.ts`

**Interfaces:**
- Consumes: Wave F `MemoryEntrypointRebuildInput`、old entrypoint ref、target context、FRC-1 rebuild port。
- Produces: target-context `BoundedMemoryEntrypointSnapshot` ref 或显式 optional omission。

- [ ] **Step 1: 写 old-use-decision rejection RED**

```ts
it('never reuses an entrypoint bound to the pre-compact context', async () => {
  const build = vi.fn().mockResolvedValue(entrypoint({ context_snapshot_id: 'ctx-new' }));
  const result = await rebuildMemoryEntrypoint({
    old_entrypoint: entrypoint({ context_snapshot_id: 'ctx-old' }),
    target_context_snapshot_id: 'ctx-new',
  }, { build });
  expect(build).toHaveBeenCalledTimes(1);
  expect(result.context_snapshot_id).toBe('ctx-new');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-memory.test.ts
```

- [ ] **Step 3: 实现结构化 rebuild request**

旧 snapshot 只提供 Wave F 已冻结的 rebuild identity refs。GRC-1 不读取全部 Memory、不运行 selection/use 算法、不生成 verified claim。

- [ ] **Step 4: 调用 FRC-1 owner**

新的 FRC-1 snapshot 必须绑定 target task/context/project/catalog/selection/use/policy/render/budget identities。Cache 是否命中完全由 FRC-1 判断。

- [ ] **Step 5: 实现状态映射**

```text
ready/partial          → resolved, attach snapshot ref
empty                  → excluded with memory_empty
rejected/unavailable   → excluded with optional_rebuild_failed
identity mismatch      → rejected
```

`partial` 必须保留 Wave F overflow/degradation evidence。

- [ ] **Step 6: 写 no-full-load/no-summary-fill 测试**

Rebuild 失败时 spy 断言未调用 `getIndexContent()`、`inject()`、read-all 或 summary-to-memory adapter；失败不改变 TurnOutcome。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-memory.test.ts src/__tests__/agent/bounded-memory-request.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 `selected ≠ use` 仍成立，旧 `MemoryUseDecision` 没有因 compaction 获得跨 context 生命周期。

---

## Task 7: Candidate Assembly、Ordering、Omission 与 Budget

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Test: `src/__tests__/agent/reconstruction-candidate.test.ts`

**Interfaces:**
- Consumes: immutable plan、source resolutions、compaction result、target budget snapshot。
- Produces: `assembleRestoredWorkingSetCandidate(): RestoredWorkingSetCandidate`。

- [ ] **Step 1: 写 plane/order/dedup RED**

```ts
it('assembles refs in the frozen semantic order without execution-state text', () => {
  const candidate = assembleRestoredWorkingSetCandidate(validResolvedInput);
  expect(candidate.provider_visible_order).toEqual([
    'meta:10',
    'meta:20',
    'summary:compact-1',
    'user:user-1',
  ]);
  expect(candidate.provider_visible_order).not.toContain('execution:tool-1');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-candidate.test.ts
```

- [ ] **Step 3: 实现分 plane candidate**

Candidate 只保存 refs：

```text
bounded Memory entrypoint handoff
meta context refs by stable ordinal
compact summary ref
current user ref
structural execution refs outside Provider-visible order
resolution refs
omission manifest
target budget
```

Candidate 深冻结，创建后不可发送。

- [ ] **Step 4: 实现 omission/degradation manifest**

Optional Memory empty/partial/rebuild failure 可 degraded publish，但必须逐项记录。Required 未解析只能进入 `blocked_required_items` 并停止 candidate acceptance。

- [ ] **Step 5: 实现 target-budget gate**

使用新的 request budget snapshot；project instruction、FRC-1 entrypoint、summary 继续遵守各 owner 的预算。GRC-1 不二次截断正文、不临时发明淘汰顺序。

- [ ] **Step 6: 写 required/optional 边界测试**

覆盖：

- required current user 缺失 → blocked；
- required summary 无法表示 → blocked/rejected；
- required project reload 未确认 → blocked；
- optional Memory unavailable → degraded；
- unknown item/duplicate/ordinal conflict → rejected。

- [ ] **Step 7: 实现 deterministic candidate hash**

Hash 基于 canonical identities、ordinal、resolutions、omission、budget 和 target context；不得基于日志时间、对象插入顺序或模型判断。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-candidate.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 candidate 没有旧 system Prompt、原始 tool result、完整 transcript 或未验证 Memory 正文。

---

## Task 8: Postflight Validation 与 Core Anchor

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Test: `src/__tests__/agent/reconstruction-postflight.test.ts`

**Interfaces:**
- Consumes: candidate、transaction、preflight、target-context identities、BRC-5 validator、budget/dedup/order validators。
- Produces: `validateReconstructionPostflight()`、`reconstructPostCompactWorkingSet()`。

- [ ] **Step 1: 写十五项 postflight table RED**

```ts
it.each(postflightGateNames)(
  'does not accept a candidate when %s fails',
  async (gate) => {
    const result = await reconstructPostCompactWorkingSet(
      validReconstructionInput,
      dependenciesWithFailedGate(gate),
    );
    expect(result.status).not.toBe('postflight_accepted');
    expect(result.publishable_candidate).toBeNull();
  },
);
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-postflight.test.ts
```

- [ ] **Step 3: 实现 postflight validator**

逐项实现 GRC-1 §7.19：

```text
transaction/candidate/target identity
source preflight continuity
required source resolution
invalidated exclusion
meta hash/ordinal/ack
Memory target-context binding
current user exact-once
summary exact-once
execution-state plane isolation
before-provider-send transcript accepted
no pending/missing/orphan/duplicate/conflict
budget accepted
duplicate/order accepted
omission matches reality
candidate hash replay
```

- [ ] **Step 4: 实现 postflight tool pairing**

调用 BRC-5 `validateToolTranscript()`，checkpoint 固定为 `before_provider_send`。Summary 中的工具描述和 structural execution refs 不参与 pairing；validator 不合成 missing result。

- [ ] **Step 5: 实现 Core Anchor**

```ts
async function reconstructPostCompactWorkingSet(
  input: ReconstructionInput,
  dependencies: ReconstructionDependencies,
): Promise<ReconstructionAttemptResult>
```

Core Anchor 串联 capture、preflight result、plan、source resolution、Memory rebuild、candidate、postflight，只输出：

```text
postflight_accepted + atomically publishable candidate
blocked + durable recovery ref
rejected + protocol evidence
already_published + existing snapshot ref
```

它不直接调用 Provider、tool executor 或 Prompt compiler。

- [ ] **Step 6: 写 capture-then-mutate 测试**

Core 开始后变更 source lifecycle、Memory use、budget 或 transcript fixture，断言当前 attempt 只使用已捕获 snapshot；新状态只能产生新 attempt/key。

- [ ] **Step 7: 写 deterministic replay 测试**

对同一完整输入重复运行，postflight result、candidate hash、reason codes 和 ordering 深相等。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-postflight.test.ts src/__tests__/agent/tool-transcript-validator.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 Core Anchor 只协调 refs/acknowledgements，不反向修改四个上游 contract，也不拥有 publish storage。

---

## Task 9: Atomic Publish、Durable Acknowledgement 与 Recovery

**Files:**
- Modify: `src/session/store.ts`
- Test: `src/__tests__/agent/reconstruction-publish.test.ts`
- Test: `src/__tests__/agent/reconstruction-recovery.test.ts`
- Test: `src/__tests__/session/session-store.test.ts`

**Interfaces:**
- Consumes: postflight-accepted candidate、expected previous active snapshot、transaction/idempotency identity。
- Produces: `publishRestoredWorkingSetAtomically()`、`ReconstructionPublishAcknowledgement`、`RestoredWorkingSetSnapshot`。

- [ ] **Step 1: 写 compare-and-swap RED**

```ts
it('keeps the old snapshot active until the durable publish acknowledgement exists', async () => {
  const store = createFaultInjectingStore({ failAt: 'publish_ack' });
  await expect(publishRestoredWorkingSetAtomically(candidate, store))
    .rejects.toMatchObject({ code: 'reconstruction.publish_ack_failed' });
  expect(await store.getActiveWorkingSetId('session-1')).toBe('working-set-old');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-publish.test.ts src/__tests__/agent/reconstruction-recovery.test.ts
```

- [ ] **Step 3: 实现 publish port**

```ts
interface WorkingSetPublisher {
  compareAndSwapActiveWorkingSet(input: {
    session_id: string;
    expected_previous_snapshot_id: string;
    candidate: RestoredWorkingSetCandidate;
    transaction_id: string;
    idempotency_key: string;
  }): Promise<ReconstructionPublishAcknowledgement>;
}
```

底层可使用 store 现有能力实现等价原子语义，但不得逐条 append Provider-visible message 后再补 ack。

- [ ] **Step 4: 实现 durable acknowledgement**

Ack 必须绑定 transaction、candidate、restored/previous snapshot、target context、published hash 和 commit time。Ack durable 前旧 snapshot 仍是恢复依据。

- [ ] **Step 5: 实现 failure injection matrix**

逐点注入故障：

```text
candidate persist
pointer compare
pointer swap
publish ack write
transaction published record
process restart
```

每个故障必须恢复到旧 snapshot 或已 durable 的新 snapshot，不能出现半工作集。

- [ ] **Step 6: 实现 idempotent publish retry**

相同 key 已发布时返回同一 snapshot/ack；不得重复插入 meta、summary、user 或 execution refs。不同 candidate 使用相同 key 必须 rejected。

- [ ] **Step 7: 写 concurrent active-pointer change 测试**

如果 expected previous active snapshot 已变化，CAS 失败并创建新 attempt；不得覆盖另一个 turn/session 的更新。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/reconstruction-publish.test.ts src/__tests__/agent/reconstruction-recovery.test.ts src/__tests__/session/session-store.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 publish failure 不改变 TurnOutcome，不删除 historical snapshot，不通过日志猜测 commit 是否成功。

---

## Task 10: Activation Gate、Compression/Streaming Cutover 与旧路径退役

**Files:**
- Modify: `src/agent/compression.ts`
- Modify: `src/agent/streaming-query.ts`
- Modify: `src/session/store.ts`
- Test: `src/__tests__/agent/reconstruction-activation.test.ts`
- Test: `src/__tests__/compression.test.ts`
- Test: `src/__tests__/streaming-query.test.ts`
- Test: `src/__tests__/session/session-store.test.ts`

**Interfaces:**
- Consumes: GRC-1 activation evidence、Core Anchor、publisher、existing streaming compaction boundary。
- Produces: `canActivatePostCompactReconstruction()` 与 transactional post-compact continue 主路径。

- [ ] **Step 1: 写十六门 activation RED**

```ts
it.each(activationGateNames)(
  'keeps GRC-1 inactive when %s is missing',
  (gate) => {
    expect(canActivatePostCompactReconstruction(evidenceWithout(gate))).toEqual({
      active: false,
      reason_codes: [`reconstruction.gate_missing.${gate}`],
    });
  },
);
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-activation.test.ts
```

- [ ] **Step 3: 实现 GRC-1 §7.26 activation gate**

16 项证据全部为 runtime-enforced AND gate。任一缺失保持旧路径或安全阻断；不得用 summary Prompt、reminder、日志或 feature flag 名称冒充 enforcement。

- [ ] **Step 4: 在 compression boundary 接入 transaction**

主路径顺序固定：

```text
capture + durable ack
→ before_compaction validation
→ existing compactor
→ immutable result
→ reconstruct candidate
→ before_provider_send validation
→ atomic publish
→ next request reads published refs
```

不得先替换 `messages` 再补 postflight。

- [ ] **Step 5: 接入 streaming continue**

Provider send 只读取 published `RestoredWorkingSetSnapshot` 和下一次独立 BRC-1 compiled system snapshot。Candidate、blocked/rejected attempt、old system string 均不可发送。

- [ ] **Step 6: 写 post-compact continue 集成测试**

覆盖：

- current user exact-once；
- meta stable order；
- summary exact-once；
- target-context Memory rebuild；
- structural execution state 不可见；
- completed tool executor 调用次数不增加；
- next request 重新编译 system Prompt。

- [ ] **Step 7: 写 blocked/recovery 集成测试**

Required reload failure、new user arrival、postflight pairing failure、budget reject、publish crash 均保持旧 active snapshot；恢复后不重复 compaction/reload/rebuild/publish。

- [ ] **Step 8: 退役旧 summary-only replacement**

只有 activation、integration、recovery 和 V3 evidence 全通过后，移除主路径中：

- `messages = [user summary]` 作为最终 active state；
- summary 冒充 current user；
- “re-run if needed” 被当作 completed tool 恢复策略；
- 逐消息非原子 post-compact 写入。

保留现有 compactor 作为 `CompactionResultSnapshot` producer。

- [ ] **Step 9: 运行 V2/V3 影响路径**

```powershell
npx vitest run src/__tests__/agent/reconstruction-activation.test.ts src/__tests__/agent/reconstruction-preflight.test.ts src/__tests__/agent/reconstruction-postflight.test.ts src/__tests__/agent/reconstruction-publish.test.ts src/__tests__/agent/reconstruction-recovery.test.ts src/__tests__/compression.test.ts src/__tests__/streaming-query.test.ts src/__tests__/session/session-store.test.ts
npm run typecheck
```

随后运行项目现有 CLI/E2E harness，验证真实 post-compact continue；若仓库没有可用 harness，必须记录为未达到 V3，不得用单元测试冒充。

- [ ] **Step 10: Review checkpoint**

确认此处是唯一 cutover；没有改变 compaction trigger/algorithm，没有恢复旧 system Prompt，没有执行 completed tool。

---

## Task 11: Wave G 公共出口、INV-G1～G20 与最终实施覆盖验收

**Files:**
- Modify: `src/agent/context/reconstruction.ts`
- Modify: `src/agent/index.ts`
- Test: `src/__tests__/agent/reconstruction-invariants.test.ts`

**Interfaces:**
- Consumes: Tasks 1～10 的稳定 exports 与验证 evidence。
- Produces: Wave G 公共 imports、20 条不变量证据、49 designed/actionable 机制计划闭环报告。

- [ ] **Step 1: 写公共出口 RED**

```ts
import {
  canActivatePostCompactReconstruction,
  reconstructPostCompactWorkingSet,
  publishRestoredWorkingSetAtomically,
} from '../../agent/index.js';

it('exports the Wave G contract without exporting storage internals', () => {
  expect(canActivatePostCompactReconstruction).toBeTypeOf('function');
  expect(reconstructPostCompactWorkingSet).toBeTypeOf('function');
  expect(publishRestoredWorkingSetAtomically).toBeTypeOf('function');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/reconstruction-invariants.test.ts
```

- [ ] **Step 3: 导出稳定 contract**

只导出：

```text
policy/snapshot/plan/resolution/candidate/postflight/publish types
capture/create/resolve/reconstruct/validate/publish functions
activation evidence/result
```

不导出 SessionStore 私有路径、raw persistence records、compactor internals、Prompt body 或 Memory raw detail。

- [ ] **Step 4: 编写 INV-G1～G20 table tests**

每条不变量至少映射一个 machine-checkable test：

| INV | 必须断言 |
|---|---|
| G1 | 不恢复完整 transcript |
| G2 | preflight accepted 先于 compactor |
| G3 | completed tool 不重执行 |
| G4 | reload marker 不是 acknowledgement |
| G5 | invalidated source 不复活 |
| G6 | current user exact-once |
| G7 | meta 不增加 user turn |
| G8 | summary 只有 derived authority |
| G9 | old system Prompt 不在 reconstruction |
| G10 | Memory 绑定 target context |
| G11 | planes 不混合 |
| G12 | required missing 不 publish |
| G13 | optional missing 显式 degraded |
| G14 | publish 原子 |
| G15 | durable ack 前旧 snapshot 可恢复 |
| G16 | retry 幂等 |
| G17 | failure 不提升状态 |
| G18 | failure 不改变 TurnOutcome |
| G19 | cache/observability 无语义权 |
| G20 | 只消费四条冻结 D-edge |

- [ ] **Step 5: 写 negative dependency audit**

静态/contract 测试断言 M-049 production imports 不依赖 M-031、M-033、M-052、M-060 或任何 Hold implementation；全局安全检查通过调用接口进入，不改变机制 owner。

- [ ] **Step 6: 运行 targeted 与影响模块回归**

```powershell
npx vitest run src/__tests__/agent/reconstruction-capture.test.ts src/__tests__/agent/reconstruction-preflight.test.ts src/__tests__/agent/reconstruction-source-resolution.test.ts src/__tests__/agent/reconstruction-memory.test.ts src/__tests__/agent/reconstruction-candidate.test.ts src/__tests__/agent/reconstruction-postflight.test.ts src/__tests__/agent/reconstruction-publish.test.ts src/__tests__/agent/reconstruction-recovery.test.ts src/__tests__/agent/reconstruction-activation.test.ts src/__tests__/agent/reconstruction-invariants.test.ts
npx vitest run src/__tests__/compression.test.ts src/__tests__/streaming-query.test.ts src/__tests__/session/session-store.test.ts src/__tests__/agent/tool-transcript-validator.test.ts src/__tests__/agent/bounded-memory-request.test.ts
```

- [ ] **Step 7: 运行 Wave Gate**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

- [ ] **Step 8: 执行 V3 post-compact continue**

使用真实 CLI/TTY 或项目等价 E2E harness 验证：

```text
long-running turn reaches compaction
→ no pending tool pair
→ reconstruction publishes once
→ next Provider request contains fresh system + restored planes
→ completed tools remain single-execution
→ session restart resumes the published snapshot
```

记录命令、exit code、关键事件和恢复证据。无法执行时报告 partial，不得声明 Wave G 完成。

- [ ] **Step 9: 生成完成报告**

报告必须包含：

```text
changed
mechanism: M-049
contract: GRC-1
verification level
RED/GREEN evidence
INV-G1～G20 evidence map
atomic publish/recovery evidence
post-compact E2E evidence
remaining uncertainty
```

- [ ] **Step 10: Review checkpoint**

逐条对照 Wave G §12 验收矩阵、§13 完成标准和冻结覆盖审计。任一 activation gate、required-source、postflight、atomic publish、recovery、idempotency 或 V3 证据缺失时，不得声明全线实施完成。

---

## 3. 最终 Handoff

Wave G 是最后一个设计 Wave，不向新的设计机制交付隐式能力。

完成后允许全局实施验收依赖：

- immutable `RestoredWorkingSetSnapshot`；
- durable `ReconstructionPublishAcknowledgement`；
- transaction/idempotency/recovery evidence；
- preflight/postflight `ToolTranscriptValidation` refs；
- project instruction resolution records；
- target-context Memory rebuild ref；
- omission/degradation manifest；
- INV-G1～G20 machine-checkable evidence；
- V3 post-compact continue evidence。

全局验收不能假设：

- 14 个 Deferred 已实现；
- 8 个 Hold 已激活；
- Prompt Library candidate 已 approved；
- compaction summary 质量已行为评测；
- production telemetry、Provider cache 或完整 dump 已上线；
- failed/partial Wave 可因 Wave G 是最后节点而视为 completed。

## 4. 完成标准

Wave G 只有在以下条件全部满足后才能声明实施完成：

1. M-049 唯一映射到 GRC-1。
2. 只消费 M-008、M-013、M-038、M-070 四条冻结 D-edge。
3. Pre-compact snapshot 和 transaction input 不可变。
4. Durable recovery point 先于 compaction。
5. Before-compaction pairing accepted 是硬门。
6. Compaction result 绑定 source transcript、preflight、method 和 hash。
7. Summary 只作为 derived text context。
8. Pinned Working Set item/requirement/plane 值域封闭。
9. Current user exact preserve 且只出现一次。
10. Completed tool 在 retry/resume/recovery 中从不重执行。
11. Project instruction preserve/reload/invalidate 由受信 acknowledgement 决定。
12. `reload_required` 不被当作 reload 已完成。
13. Invalidated source 不复活。
14. 旧 system Prompt string 不进入 reconstruction。
15. Memory 通过 FRC-1 为 target context 重建。
16. 旧 Memory use/entrypoint 不跨 context 复用。
17. Required item 缺失阻断，optional 缺失显式 degraded。
18. Candidate 在 postflight accepted 前不可发送。
19. Postflight pairing、identity、order、dedup、budget 和 manifest 全通过。
20. Publish 为原子 CAS 或等价语义。
21. Durable acknowledgement 前旧 snapshot 可恢复。
22. Retry 不重复 compaction、reload、rebuild、消息或 publish。
23. Failure 不提升状态、不改变 TurnOutcome。
24. Cache、telemetry、日志不拥有 reconstruction 语义。
25. INV-G1～G20 全部有 machine-checkable evidence。
26. Targeted、影响模块、全量测试、typecheck、lint、build 全部通过。
27. Post-compact continue 达到 V3，或明确报告 partial。
28. 未实现 Deferred/Hold、未激活 Prompt Library candidate。
29. 未执行部署、依赖升级、数据迁移或 Git 历史写操作。
