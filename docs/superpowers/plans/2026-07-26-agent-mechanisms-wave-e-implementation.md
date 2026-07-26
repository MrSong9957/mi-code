# mi-code Agent Mechanisms Wave E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 Wave E 的 5 个 Lifecycle & Selection 机制，为 meta context、Memory、local diagnostics 和 executable environment 建立可验证的生命周期、持久化、选择、缓冲与执行前身份防线。

**Architecture:** Wave E 复用 DRC-2/DRC-4/DRC-5 的结构化输出和现有 SessionStore、compression、MemoryManager、pino、PermissionChecker、ToolRegistry。四个 ERC 不建立中央生命周期 Runtime：meta retention、Memory persistence/selection、debug buffer、executable defense 各自拥有独立状态机和 acknowledgement；只有 ERC-2 向 Wave F M-013 提供直接 handoff。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、Node `fs/path/crypto/child_process`、现有 pino 10、现有 MemoryManager/SessionStore/compression/ToolRegistry、Wave A～D contracts。

## Global Constraints

- 唯一设计输入是冻结的主实施计划、Wave A～D 实施计划和 `2026-07-26-agent-lifecycle-selection-wave-e-design.md`。
- 本计划只覆盖 M-038、M-045、M-046、M-052、M-065。
- M-045 与 M-046 是 sibling contracts；共享 catalog schema，但不互为设计前置。
- 只有 ERC-2/M-045/M-046 是 Wave F M-013 的直接输入；ERC-1、ERC-3、ERC-4 不得接入 Wave F。
- ERC-1 只实现 retention/serializer/compressor enforcement，不实现 M-049 post-compact reconstruction。
- Meta message 不计 user turn；Retention 不改变 Authority 或 Trust。
- Serializer 与 compressor 任一不支持 meta metadata 时，不得激活 M-038。
- `admitted ≠ detail_committed ≠ index_committed ≠ completed ≠ selected ≠ retrieved ≠ use`。
- Detail 在匹配的 durable index commit 前不可由 governed catalog 发现。
- Index 只保存导航和完整性 metadata，不保存完整 Memory 正文、conversation 或 project instruction。
- Selector 只读 catalog metadata；search failure 不得回退为加载全部 Memory。
- 既有 MemoryManager 条目不因文件存在自动获得 admission 或 durability evidence。
- 只有 CRC-6/DRC-4 已清洗 event 可以进入 local buffer；raw/dropped payload 不得进入内存队列、临时文件或 retry sidecar。
- Buffer overflow 固定 `drop_newest`；enqueue 不执行磁盘 I/O、不阻塞 streaming loop。
- ERC-4 必须组合 M-063 inherited env、M-064 syntax facts、inline policy、executable resolution、RC-5 permission 和 pre-spawn revalidation。
- `ready_for_permission`、resolved、strip 或 sanitized 都不产生 allow。
- 平台 executable/environment policy 独立版本化；不得把 Unix/Windows/macOS 变量语义互相套用。
- 本 Wave 不声称覆盖 M-068 Hold；symlink/reparse-point 能力不足时返回 unsupported/deny。
- 每项行为修改执行 RED→GREEN→REFACTOR，并保留失败原因正确的 RED 证据。
- Wave E 冻结前执行 targeted tests、影响模块回归、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
- 本计划不授权生产部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作。

---

## 1. 文件结构与所有权

```text
src/agent/
├── context/
│   └── retention.ts                    # ERC-1 / M-038
├── compression.ts                      # ERC-1 compressor adapter
├── observability/
│   └── local-buffer.ts                 # ERC-3 / M-052
├── types.ts                            # SanitizedExecutionPlan execution context
├── tool-registry.ts                    # prevalidated shell spawn adapter
└── streaming-query.ts                  # final execution-plan gate

src/session/
└── store.ts                            # meta serializer round-trip

src/memory/
├── persistence.ts                      # ERC-2 / M-045
├── catalog.ts                          # governed immutable catalog
├── selection.ts                        # ERC-2 / M-046
├── legacy-adapter.ts                   # MemoryManager compatibility
└── memory-manager.ts                   # minimal governed-storage primitives

src/permission/
└── executable-environment.ts           # ERC-4 / M-065
```

共享文件串行修改：

| 文件 | 顺序 |
|---|---|
| `src/agent/context/retention.ts` | Task 1 → Task 2 → Task 3 |
| `src/session/store.ts` | Task 2 |
| `src/agent/compression.ts` | Task 3 |
| `src/memory/persistence.ts` | Task 4 → Task 5 → Task 8 |
| `src/memory/catalog.ts` | Task 5 → Task 6 → Task 8 |
| `src/memory/selection.ts` | Task 6 → Task 7 → Task 8 |
| `src/memory/memory-manager.ts` | Task 4 → Task 5 |
| `src/agent/observability/local-buffer.ts` | Task 9 → Task 10 |
| `src/permission/executable-environment.ts` | Task 11 → Task 12 → Task 13 → Task 14 |
| `src/agent/types.ts` | Task 14 |
| `src/agent/tool-registry.ts` | Task 14 |
| `src/agent/streaming-query.ts` | Task 14 |

## 2. Task 依赖

```text
T1 Meta Retention Decision
 └→ T2 Serializer Round-Trip
     └→ T3 Compressor + Activation Gate

T4 Memory Detail Transaction
 └→ T5 Catalog Commit + Recovery

T6 Memory Selection
 └→ T7 Retrieval + Use Gate

T4 + T5 + T6 + T7
 └→ T8 Memory Core Anchor

T9 Sanitized Local Buffer
 └→ T10 Flush/Rotation/Shutdown

T11 Inline Environment Policy
 └→ T12 Executable Resolution
     └→ T13 Sanitized Execution Plan
         └→ T14 Pre-Spawn Revalidation + Cutover

T1–T14 → T15 Wave E Acceptance
```

T1、T4、T6、T9、T11 可并行开发，因为不共享生产文件。T4/M-045 与 T6/M-046 的并行表示 sibling design independence；Task 8 只是公共入口，不把二者改写为相互前置。

## Task 1: M-038 Meta Retention Decision

**Files:**
- Create: `src/agent/context/retention.ts`
- Test: `src/__tests__/agent/meta-retention.test.ts`

**Interfaces:**
- Consumes: DRC-2 `MetaContextActivation`、受信 `MetaRetentionPolicy`、session/freshness snapshot。
- Produces: `decideMetaRetention(input, policy): MetaRetentionDecision` 与 `createMetaLifecycleRecord()`。

- [ ] **Step 1: 写 lifecycle/Authority RED**

```ts
it.each([
  ['fresh', 'preserve'],
  ['stale_refreshable', 'mark_reload_required'],
  ['invalidated_source', 'invalidate'],
] as const)('maps %s source state to %s without changing authority', (sourceState, action) => {
  const decision = decideMetaRetention(inputFor(sourceState), policy);
  expect(decision.action).toBe(action);
  expect(decision.authority).toBe(metaActivation.authority);
  expect(decision.trust).toBe(metaActivation.trust);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/meta-retention.test.ts
```

- [ ] **Step 3: 实现 policy/decision**

实现 `preserve | mark_reload_required | invalidate`。Policy 只来自受信 runtime/config；source content、Prompt 和 Agent 不能声明永久保留。

- [ ] **Step 4: 实现 lifecycle record**

状态封闭为 `resident | serialized | reload_required | invalidated`。转换必须绑定 session/message/activation/retention/serializer/compressor identity；旧 record immutable。

- [ ] **Step 5: 写 failure matrix**

```text
activation/message mismatch  → invalid
unknown policy/version       → invalid
freshness unavailable        → reload_required 或 invalidated
content hash mismatch        → invalidated
metadata persistence failure → session persistence failure, Outcome unchanged
```

`reload_required` 只登记 marker，不读取 source、不注入消息。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/meta-retention.test.ts src/__tests__/agent/project-instruction-activation.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 retention 没有改变 user-turn count、Authority/Trust，也没有实现 M-049。

## Task 2: ERC-1 Session Serializer Round-Trip

**Files:**
- Modify: `src/agent/context/retention.ts`
- Modify: `src/session/store.ts`
- Test: `src/__tests__/session/meta-lifecycle-serialization.test.ts`

**Interfaces:**
- Consumes: `MetaContextActivation`、`MetaRetentionDecision`、`MetaMessageLifecycleRecord`。
- Produces: `serializeMetaLifecycleRecord()`、`deserializeMetaLifecycleRecord()`。

- [ ] **Step 1: 写 round-trip RED**

```ts
it('preserves meta identity without increasing the user turn count', async () => {
  await store.saveMetaLifecycle(record);
  const restored = await store.loadMetaLifecycle(record.session_snapshot_id);
  expect(restored[0]).toEqual(record);
  expect(await store.countUserTurns()).toBe(initialUserTurnCount);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/session/meta-lifecycle-serialization.test.ts
```

- [ ] **Step 3: 实现独立 record kind**

Session serializer 保存 message ID、`is_meta=true`、Placement、source/activation/retention identity、Authority/Trust、provenance/freshness、ordinal、content hash、lifecycle state。

Meta lifecycle 使用独立结构化 record kind，不塞入 Provider-visible conversation JSONL。

- [ ] **Step 4: 实现 unknown-version fail closed**

Unknown metadata/version、`is_meta` 丢失、ordinal/hash 不匹配时，session snapshot 不可恢复；不得降级为普通 user message。

- [ ] **Step 5: 写 invalidated-source 测试**

即使 serializer record 存在，只要 source 已 invalidated，就不能恢复正文或 resident 状态。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/session/meta-lifecycle-serialization.test.ts src/__tests__/session/session-store.test.ts src/__tests__/agent/meta-context-request.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 `load()`/`loadSync()` 的 Provider-visible conversation 没有混入 lifecycle control record。

## Task 3: ERC-1 Compressor Enforcement 与 Activation Gate

**Files:**
- Modify: `src/agent/context/retention.ts`
- Modify: `src/agent/compression.ts`
- Test: `src/__tests__/agent/meta-context-compression.test.ts`
- Test: `src/__tests__/agent/meta-retention-activation.test.ts`

**Interfaces:**
- Consumes: lifecycle records、compressor snapshot、serializer capability evidence。
- Produces: `applyMetaRetentionToCompression()`、`canActivateMetaRetention()`。

- [ ] **Step 1: 写 preserve/reload/invalidate RED**

```ts
it.each([
  ['resident', 'preserve_body'],
  ['reload_required', 'emit_reload_marker'],
  ['invalidated', 'emit_invalidation_marker'],
] as const)('handles %s as %s', (state, expected) => {
  const result = applyMetaRetentionToCompression(compactionInputFor(state));
  expect(result.meta_directive).toBe(expected);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/meta-context-compression.test.ts
```

- [ ] **Step 3: 实现 compressor directives**

- preserve：普通 history eviction 不得删除正文；
- reload_required：正文可省略，但 marker/source/provenance/freshness/ordinal 必须保留；
- invalidated：保留 reason，不静默消失。

Compressor 不读取 project files、不改变 Authority、不触碰 tool pairing/current-user Pinned Working Set。

- [ ] **Step 4: 实现六门 Activation Gate**

```text
message model supports is_meta/lifecycle identity
serializer round-trip verified
compressor handles all three actions
resume/compaction keeps user-turn count
unknown metadata fails closed
M-008/M-038 message/source identity matches
```

任一门缺失返回 inactive；不得用 Prompt reminder 替代。

- [ ] **Step 5: 写 no-Wave-F / Wave-G marker 测试**

输出允许包含给 M-049 的 reload marker，但不得 import FRC-1、触发 M-013 或声明 reconstruction complete。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/agent/meta-context-compression.test.ts src/__tests__/agent/meta-retention-activation.test.ts src/__tests__/compression.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 ERC-1 没有 Wave F direct edge；M-049 handoff 只是 marker/identity。

## Task 4: M-045 Memory Detail Transaction

**Files:**
- Create: `src/memory/persistence.ts`
- Modify: `src/memory/memory-manager.ts`
- Test: `src/__tests__/memory/memory-detail-transaction.test.ts`

**Interfaces:**
- Consumes: `MemoryAdmissionDecision(status='admit')`、TypedMemoryCandidate、legacy storage adapter。
- Produces: `prepareMemoryPersistence()`、`commitMemoryDetail()`。

- [ ] **Step 1: 写 admit/idempotency/version RED**

```ts
it('does not create a transaction for a non-admitted candidate', async () => {
  await expect(prepareMemoryPersistence(rejectedAdmission, candidate, storage))
    .rejects.toThrow(/admission_not_admit/);
});

it('reuses the same detail commit for an identical idempotency key', async () => {
  const first = await commitMemoryDetail(transaction, record, storage);
  const second = await commitMemoryDetail(transaction, record, storage);
  expect(second.detail_commit_ref).toBe(first.detail_commit_ref);
  expect(storage.detailWriteCount).toBe(1);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-detail-transaction.test.ts
```

- [ ] **Step 3: 实现 record/transaction**

实现 `prepared → detail_committed` 和 `failed/recovery_required`。Record 必须复制 admitted type/scope/evidence/confidence/freshness/invalidation/provenance，commit 前验证 content hash。

- [ ] **Step 4: 扩展 MemoryManager governed primitives**

只增加：

```ts
writeGovernedDetail(record): DurableCommitAcknowledgement
readGovernedDetail(ref): string | null
```

Detail 写入 `.memory/.records/`，不进入现有根目录 `list()`，因此 index commit 前不可发现。使用 temp file + same-directory rename；ack 只在 write/flush/rename 完成后产生。

- [ ] **Step 5: 实现 lost-update/conflict**

更新既有 record 必须匹配 `expected_record_version`。相同 idempotency key + 不同 content/hash 为 conflict，不覆盖旧 detail。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-detail-transaction.test.ts src/__tests__/memory.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 detail commit 未调用 selector、未更新正式 catalog、未把 project instruction/credential/deferred candidate 写入。

## Task 5: M-045 Catalog Commit、Recovery 与 Legacy Adapter

**Files:**
- Modify: `src/memory/persistence.ts`
- Create: `src/memory/catalog.ts`
- Create: `src/memory/legacy-adapter.ts`
- Modify: `src/memory/memory-manager.ts`
- Test: `src/__tests__/memory/memory-catalog-commit.test.ts`
- Test: `src/__tests__/memory/memory-legacy-adapter.test.ts`

**Interfaces:**
- Consumes: durable detail acknowledgement、catalog budget policy、existing MemoryManager entries。
- Produces: `commitMemoryCatalog()`、`recoverMemoryPersistence()`、`buildLegacyCatalogSnapshot()`。

- [ ] **Step 1: 写不可见/原子替换 RED**

```ts
it('keeps a detail undiscoverable when catalog commit fails', async () => {
  const result = await commitMemoryCatalog(detailCommittedTransaction, failingCatalogStore);
  expect(result.state).toBe('recovery_required');
  expect(await governedCatalog.find(result.memory_record_id)).toBeNull();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-catalog-commit.test.ts
```

- [ ] **Step 3: 实现 immutable catalog**

Catalog entry 只保存 record/version/admission/durability/type/scope/topic/keyword/time/provenance/hash。禁止正文、credential、evidence body、conversation、project instruction。

Catalog 使用 canonical entry order/hash；写入 temp JSON 后在同目录 rename 为 governed catalog snapshot。只有 detail/index identity、version、hash 全部一致后 transaction 才 `completed`。

- [ ] **Step 4: 实现 budget/recovery**

预算不足返回 `update_rejected | rebuild_required`，不截断既有 entry。Index commit 失败使 detail 保持不可发现并产生 recovery record；recovery 只完成或回滚同一 transaction。

- [ ] **Step 5: 实现 legacy compatibility**

Legacy adapter 读取现有 MemoryManager metadata，但只有同时具备确定性 schema compatibility、admission evidence 和 existing-store durability evidence 的条目进入 governed snapshot。未分类旧数据留在 snapshot 外。

- [ ] **Step 6: 写 evidence-kind 分离测试**

`existing_store_durability` 不能冒充 `two_step_transaction_ack`；`source_kind='existing_memory_manager'` 不改变 Trust 或 selection 权限。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-catalog-commit.test.ts src/__tests__/memory/memory-legacy-adapter.test.ts src/__tests__/memory/memory-detail-transaction.test.ts src/__tests__/memory.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认正式可见性只来自 governed catalog，writer/recovery failure 不改变 TurnOutcome。

## Task 6: M-046 Deterministic Memory Selection

**Files:**
- Modify: `src/memory/catalog.ts`
- Create: `src/memory/selection.ts`
- Test: `src/__tests__/memory/memory-selection.test.ts`

**Interfaces:**
- Consumes: immutable `MemoryCatalogSnapshot`、structured task snapshot、bounded `MemorySearchQuery`。
- Produces: `buildMemorySearchQuery()`、`selectMemoryEntries()`。

- [ ] **Step 1: 写 metadata-only 与预算 RED**

```ts
it('selects from metadata without reading detail bodies', () => {
  const result = selectMemoryEntries(query, catalog, {
    readDetail: detailReaderSpy,
  });
  expect(result.selected_entries).toHaveLength(2);
  expect(detailReaderSpy).not.toHaveBeenCalled();
});

it('marks overflow instead of claiming completeness', () => {
  const result = selectMemoryEntries({ ...query, max_selected_entries: 1 }, catalog);
  expect(result.selected_entries).toHaveLength(1);
  expect(result.overflowed).toBe(true);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-selection.test.ts
```

- [ ] **Step 3: 实现确定性 query normalization**

`topic_terms`/`keyword_terms` 使用 Unicode NFKC、trim、locale-independent lowercase、空白/标点分词、去空、去重。当前只支持精确 normalized-key 匹配；不实现模糊匹配、同义词、embedding 或 reranker。

- [ ] **Step 4: 实现 filter/rank**

顺序固定：

```text
scope filter → type filter → normalized topic/keyword match
→ catalog entry order → memory_record_id tie-break
```

Rank 只表示本 query 导航顺序，不表达 confidence/Truth/Trust/Authority/use。

- [ ] **Step 5: 实现 query budgets**

同时限制 `max_selected_entries` 与 `max_index_metadata_bytes`。达到任一上限时停止于完整 entry 边界并设置 `overflowed=true`。

- [ ] **Step 6: 写 failure matrix**

Stale catalog、非法预算、missing detail ref、expired entry、search error 分别产生结构化 excluded/diagnostic；不得加载全部 detail。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-selection.test.ts src/__tests__/memory/memory-catalog-commit.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 selector 不修改 catalog/record/confidence/admission，也不调用 persistence 修复缺口。

## Task 7: M-046 Retrieval 与 MemoryUseDecision Gate

**Files:**
- Modify: `src/memory/selection.ts`
- Test: `src/__tests__/memory/memory-retrieval-use-gate.test.ts`

**Interfaces:**
- Consumes: `MemorySelectionResult`、governed detail reader、DRC-2 `decideMemoryUse()`。
- Produces: `retrieveSelectedMemory(input, dependencies): MemoryRetrievalResult`。

- [ ] **Step 1: 写 selected ≠ use RED**

```ts
it('does not expose selected detail when current-context use rejects it', async () => {
  const result = await retrieveSelectedMemory(selection, {
    readDetail,
    decideUse: () => useDecision({ status: 'do_not_use' }),
  });
  expect(result.usable_claim_refs).toEqual([]);
  expect(result.rejected_record_ids).toContain('memory-1');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/memory-retrieval-use-gate.test.ts
```

- [ ] **Step 3: 实现 detail integrity**

读取 detail 后验证 record/version/hash/provenance 与 catalog entry 一致，再调用 current-context `MemoryUseDecision`。Missing/mismatched detail 只产生 integrity diagnostic。

- [ ] **Step 4: 实现 use gate**

只有 `status='use'` 的 `verified_claim_refs` 进入 `usable_claim_refs`。`needs_refresh` 和 `do_not_use` 不进入 Prompt 或行为依据。

- [ ] **Step 5: 写 failure fallback 测试**

Detail reader、use verifier 或 search failure 均不触发 `MemoryManager.inject()` 或“加载全部 Memory”。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/memory/memory-retrieval-use-gate.test.ts src/__tests__/memory/memory-selection.test.ts src/__tests__/memory/memory-use-decision.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 retrieval 没有直接生成 FRC-1 section，selection/use identity 保持独立。

## Task 8: Wave E Memory Core Anchor

**Files:**
- Modify: `src/memory/persistence.ts`
- Modify: `src/memory/catalog.ts`
- Modify: `src/memory/selection.ts`
- Test: `src/__tests__/memory/persist-and-select-memory.test.ts`

**Interfaces:**
- Consumes: Task 4～7 的 persistence/catalog/selection/retrieval APIs。
- Produces: `persistAndSelectMemory(request, dependencies): Promise<MemoryLifecycleOperationResult>`。

- [ ] **Step 1: 写 sibling independence RED**

```ts
it('runs selection against an existing catalog without invoking persistence', async () => {
  const result = await persistAndSelectMemory({
    operation: 'select',
    query,
    catalog: existingManagerCatalog,
  }, dependencies);
  expect(result.kind).toBe('selection');
  expect(dependencies.persist).not.toHaveBeenCalled();
});

it('persists an admitted candidate without invoking selection', async () => {
  const result = await persistAndSelectMemory({
    operation: 'persist',
    admission,
    candidate,
  }, dependencies);
  expect(result.kind).toBe('persistence');
  expect(dependencies.select).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/memory/persist-and-select-memory.test.ts
```

- [ ] **Step 3: 实现封闭 operation union**

```ts
export type MemoryLifecycleOperationRequest =
  | PersistAdmittedMemoryRequest
  | SelectCatalogMemoryRequest
  | RetrieveSelectedMemoryRequest;
```

Core Anchor 只按 operation 调用一个 sibling path；不隐式执行“persist 后立即 select”，不调用 catalog repair。

- [ ] **Step 4: 实现 acknowledgement passthrough**

Persistence 返回 transaction/durable acknowledgement；selection 返回 immutable selected refs；retrieval 返回 use-gated claims。Anchor 不折叠这些状态为单个 success boolean。

- [ ] **Step 5: 写状态分离矩阵**

验证 admitted/detail/index/completed/selected/retrieved/use 七种状态不能由前一状态自动推导。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/memory/persist-and-select-memory.test.ts src/__tests__/memory/memory-detail-transaction.test.ts src/__tests__/memory/memory-catalog-commit.test.ts src/__tests__/memory/memory-selection.test.ts src/__tests__/memory/memory-retrieval-use-gate.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 Core Anchor 没有给 M-045/M-046 新增相互 D-edge；它只是公共 discriminated entrypoint。

## Task 9: M-052 Sanitized Bounded Local Buffer

**Files:**
- Create: `src/agent/observability/local-buffer.ts`
- Test: `src/__tests__/agent/local-diagnostic-buffer.test.ts`

**Interfaces:**
- Consumes: DRC-4 sanitized `ComponentTelemetryEvent/Batch`、trusted local logging policy。
- Produces: `createLocalDiagnosticBuffer()`、`enqueueDiagnosticEvent()`。

- [ ] **Step 1: 写 sanitize-before-buffer RED**

```ts
it('never stores raw or dropped payloads', () => {
  const buffer = createLocalDiagnosticBuffer(policy);
  buffer.enqueue(rawEvent({ redaction_result_ref: '' }));
  buffer.enqueue(droppedEvent);
  expect(buffer.snapshot().queued_event_count).toBe(0);
  expect(buffer.inspectForTest()).not.toContain(secret);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/local-diagnostic-buffer.test.ts
```

- [ ] **Step 3: 实现 policy/state/event**

Policy disabled、sink location 不可信、capacity 非法时 state=`disabled`。Buffered event 只保存 sanitized payload ref、redaction ref、correlation IDs、level、byte count 和 enqueue time。

- [ ] **Step 4: 实现 non-blocking enqueue**

Enqueue 只操作内存 queue，不执行磁盘 I/O。顺序为 event timestamp + event ID；重复 source event ID 去重。

- [ ] **Step 5: 实现 fixed overflow**

达到 event/byte 上限固定 `drop_newest`，只增加 drop counter/reason；不保存 dropped payload 的 hash、slice、temporary copy 或 retry closure。

- [ ] **Step 6: 写 streaming latency/exception 测试**

Sink 未提供或 buffer 内部异常时 enqueue 立即返回 degraded/drop 结果，不抛到 streaming loop、不改变 Outcome。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/local-diagnostic-buffer.test.ts src/__tests__/agent/component-telemetry-batch.test.ts src/__tests__/agent/telemetry-redaction.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认没有 full dump、raw sidecar、远程 sink 或 Wave F import。

## Task 10: ERC-3 Flush、Rotation 与 Bounded Shutdown

**Files:**
- Modify: `src/agent/observability/local-buffer.ts`
- Test: `src/__tests__/agent/local-diagnostic-flush.test.ts`

**Interfaces:**
- Consumes: sanitized buffer、trusted sink root、existing pino dependency。
- Produces: `flushDiagnosticBuffer()`、`shutdownDiagnosticBuffer()`、`DiagnosticFlushResult`。

- [ ] **Step 1: 写 durable acknowledgement RED**

```ts
it('removes only durably acknowledged events after a partial flush', async () => {
  const result = await flushDiagnosticBuffer(bufferWith(['e1', 'e2']), sinkCommitting(['e1']));
  expect(result.status).toBe('partial');
  expect(result.committed_event_ids).toEqual(['e1']);
  expect(buffer.snapshot().queued_event_ids).toEqual(['e2']);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/local-diagnostic-flush.test.ts
```

- [ ] **Step 3: 实现 trusted sink identity**

`sink_location_ref` 先由受信配置解析到固定 local log root。对 root/parent 执行 realpath，拒绝 path escape、symlink/reparse mismatch；目标文件只能位于该 root。

- [ ] **Step 4: 实现 pino sink adapter**

Pino 只序列化已清洗 event。写入后执行 destination flush 和文件 sync，再生成 committed acknowledgement；未 ack event 保留在内存 queue。

- [ ] **Step 5: 实现 rotation/retention**

Rotation 前重新验证 sink identity；失败进入 degraded，不覆盖旧文件。Retention 只删除受信 log root 内已清洗、已登记的 diagnostic files。

- [ ] **Step 6: 实现 bounded shutdown**

Session end 发起异步有界 flush；超时后记录 remaining sanitized event drop count 并结束，不无限等待、不改变 TurnOutcome。

- [ ] **Step 7: 写 sink failure/path tests**

覆盖 partial write、sink unavailable、path escape、symlink mismatch、rotation failure、shutdown timeout。任何路径不得写 raw payload 临时文件。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/local-diagnostic-flush.test.ts src/__tests__/agent/local-diagnostic-buffer.test.ts src/__tests__/agent/observability-envelopes.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 local log 只能证明 enqueue/flush metadata，不能被描述为完整请求复现或业务成功证据。

## Task 11: M-065 Inline Environment Policy

**Files:**
- Create: `src/permission/executable-environment.ts`
- Test: `src/__tests__/permission/inline-environment-policy.test.ts`

**Interfaces:**
- Consumes: DRC-5 environment-assignment syntax facts、action/control-mode snapshot、platform policy。
- Produces: `classifyInlineAssignments()`、`decideInlineEnvironment()`。

- [ ] **Step 1: 写风险/action RED**

```ts
it.each([
  ['safe_passthrough', 'preserve'],
  ['controlled_override', 'ask'],
  ['path_resolution_affecting', 'deny'],
  ['loader_injection', 'deny'],
  ['unknown', 'ask'],
] as const)('maps %s to %s in normal mode', (risk, expected) => {
  const decision = decideInlineEnvironment(assignment({ risk }), normalPolicy);
  expect(decision.action).toBe(expected);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/inline-environment-policy.test.ts
```

- [ ] **Step 3: 冻结最小平台 policy**

初始 policy 保守定义：

```text
windows denied: PATH, PATHEXT, COMSPEC
linux denied:   PATH, LD_PRELOAD, LD_LIBRARY_PATH
macos denied:   PATH, DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH
safe:           empty by default
controlled:     empty by default
unknown:        ask in Normal; deny in Plan or ask-unavailable
```

Windows 变量名用 invariant uppercase 比较；Linux/macOS 保持 case-sensitive。扩充名单必须提升独立 policy version并经过安全评审。

- [ ] **Step 4: 实现 preserve/strip/ask/deny**

Strip 只有在精确 policy 声明“移除后仍是受限等价动作”时允许，并进入结构化 diff；Agent 不能判断等价或修改 safe list。

- [ ] **Step 5: 写 inherited/inline AND 测试**

M-065 只能在 M-063 scrubbed inherited snapshot 上应用 inline decision；不得恢复已被 M-063 移除的变量。

- [ ] **Step 6: 写 secret non-observability**

Decision/log/diagnostic 只保存 value ref/hash/source range/risk/reason，不复制实际值。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/permission/inline-environment-policy.test.ts src/__tests__/permission/child-environment.test.ts src/__tests__/permission/command-structural-parse.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认平台 policy 不混用，Plan/ask-unavailable loader injection 为 deny，未声称变量全集完整。

## Task 12: M-065 Executable Resolution

**Files:**
- Modify: `src/permission/executable-environment.ts`
- Test: `src/__tests__/permission/executable-resolution.test.ts`

**Interfaces:**
- Consumes: applied inline decisions、scrubbed effective env、working-directory/action snapshot、executable candidate。
- Produces: `resolveExecutableIdentity(input, platformAdapter): ExecutableResolutionResult`。

- [ ] **Step 1: 写 direct/PATH/ambiguity RED**

```ts
it.each([
  ['direct path', directPathInput, 'resolved', 'executable.direct_path'],
  ['PATH search', pathSearchInput, 'resolved', 'executable.path_search'],
  ['multiple matches', ambiguousInput, 'ambiguous', 'executable.ambiguous'],
] as const)('%s', async (_name, input, status, reason) => {
  const result = await resolveExecutableIdentity(input, fakePlatform);
  expect(result.status).toBe(status);
  expect(result.reason_codes).toContain(reason);
  expect(fakePlatform.spawn).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/executable-resolution.test.ts
```

- [ ] **Step 3: 实现 effective-environment search**

Direct path 与 PATH search 分开；relative path 绑定 working-directory snapshot。Windows PATHEXT 只来自 effective environment；被 deny/strip 的 PATH/loader assignment 不参与 search。

- [ ] **Step 4: 实现 executable identity**

先 realpath，再读取 stat。`file_identity_ref` 使用平台、canonical path、dev/ino（可用时）、size、mtime、mode 的 canonical identity；`content_or_metadata_hash` 为该 identity 的 SHA-256。保留原 candidate 与 symlink/reparse provenance。

- [ ] **Step 5: 实现 fail-closed status**

Not found、multiple candidate、platform capability不足、path policy不足分别返回 `not_found | ambiguous | unsupported | denied`。不得让 shell 自行搜索，也不得近似前缀匹配。

- [ ] **Step 6: 写 no-execution/M-068 boundary 测试**

Resolver 不 spawn binary；Windows ADS/8.3/long-path 能力无法验证时返回 unsupported/deny，不宣称覆盖 M-068。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/permission/executable-resolution.test.ts src/__tests__/permission/inline-environment-policy.test.ts src/__tests__/regression/bash-path-sandbox.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 resolved 只产生 identity，不产生 trusted/allow。

## Task 13: M-065 Sanitized Execution Plan

**Files:**
- Modify: `src/permission/executable-environment.ts`
- Test: `src/__tests__/permission/sanitized-execution-plan.test.ts`

**Interfaces:**
- Consumes: M-063 scrub snapshot、M-064 structural decision、inline decisions、executable resolution、RC-5 decision ref。
- Produces: `buildSanitizedExecutionPlan(input): SanitizedExecutionPlan`。

- [ ] **Step 1: 写六门 AND RED**

```ts
it.each([
  'inherited_environment',
  'structural_policy',
  'inline_environment',
  'executable_resolution',
  'permission',
] as const)('does not become ready when %s gate is invalid', (gate) => {
  const plan = buildSanitizedExecutionPlan(inputWithInvalidGate(gate));
  expect(plan.status).not.toBe('ready_for_permission');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/sanitized-execution-plan.test.ts
```

- [ ] **Step 3: 实现 plan identity/diff**

Plan 绑定 action、parse、inherited env、inline decision、resolution、executable identity 和 required SecurityDecision。Preserved/stripped assignment IDs 必须形成结构化 diff。

- [ ] **Step 4: 实现 status**

```text
inline ask or RC-5 ask          → ask_required
any deny/invalid/mismatch       → denied/invalid
all environment/identity gates → ready_for_permission
```

`ready_for_permission` 仍不表示 permission allow 或 spawn allowed。

- [ ] **Step 5: 限定首个 executable path**

首个 activated path 只支持 DRC-5 已解析为单一 executable + literal argv、无 pipeline/redirect/substitution/control-flow 的 command。复杂 shell structure 返回 invalid/deny，不回退 `shell:true`。

- [ ] **Step 6: 验证**

```powershell
npx vitest run src/__tests__/permission/sanitized-execution-plan.test.ts src/__tests__/permission/executable-resolution.test.ts src/__tests__/permission/command-policy-enforced.test.ts src/__tests__/permission/runtime-gate.test.ts
npm run typecheck
```

- [ ] **Step 7: Review checkpoint**

确认 plan 没有 spawn 方法，没有恢复 stripped env，也没有把 resolved 当作 allowed。

## Task 14: ERC-4 Pre-Spawn Revalidation 与 Cutover

**Files:**
- Modify: `src/permission/executable-environment.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/tool-registry.ts`
- Modify: `src/agent/streaming-query.ts`
- Test: `src/__tests__/permission/executable-revalidation.test.ts`
- Test: `src/__tests__/permission/sanitized-execution-cutover.test.ts`

**Interfaces:**
- Consumes: `SanitizedExecutionPlan`、current filesystem identity、current RC-5 allow。
- Produces: `revalidateExecutableIdentity()` 与 `executeSanitizedCommand()` pre-spawn gate。

- [ ] **Step 1: 写 TOCTOU RED**

```ts
it.each(['changed', 'missing', 'unsupported'] as const)(
  'does not spawn when executable identity is %s',
  async (status) => {
    const result = await executeSanitizedCommand(plan, {
      revalidate: () => revalidation({ status }),
      spawn: spawnSpy,
    });
    expect(result.status).toBe('denied');
    expect(spawnSpy).not.toHaveBeenCalled();
  },
);
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/permission/executable-revalidation.test.ts
```

- [ ] **Step 3: 实现 revalidation**

Spawn 前、同一 action snapshot 内重新 realpath/stat/hash。只有 `match` 可继续；changed/missing/unsupported 使旧 approval 失效。自动重新解析必须创建新 action snapshot 和新 SecurityDecision。

- [ ] **Step 4: 扩展 ToolExecutionContext**

为 `run_bash` 增加受控 `sanitizedExecutionPlan`；其他工具忽略。Cutover 后 `run_bash` enforced path 缺 plan 直接拒绝。

- [ ] **Step 5: 实现 shell:false 执行**

只对 Task 13 的单一 executable + literal argv 调用：

```ts
spawn(canonicalExecutablePath, literalArgv, {
  shell: false,
  env: effectiveEnvironment,
  cwd: capturedWorkingDirectory,
  windowsHide: true,
});
```

禁止把原始 command 重新传给 `shell:true`。复用现有 timeout、output cap、encoding 和 `killProcessTree`。

- [ ] **Step 6: 接入 streaming/runtime gate**

顺序固定：

```text
DRC-5 structural decision
→ ERC-4 plan
→ RC-5 blocking permission
→ identity revalidation
→ ToolRegistry execute
```

Ask 必须等待；ask unavailable、stale decision、plan/action mismatch 均 deny。

- [ ] **Step 7: 写 cutover/rollback tests**

Shadow/default 路径保持当前行为但不宣称 M-065 生效。Enforced path 只在平台 policy/resolver/revalidation/permission gate ready 后启用；rollback 只切换受信 policy state，不修改历史 plan/decision。

- [ ] **Step 8: 运行 V3 影响路径**

```powershell
npx vitest run src/__tests__/permission/executable-revalidation.test.ts src/__tests__/permission/sanitized-execution-cutover.test.ts src/__tests__/permission/sanitized-execution-plan.test.ts src/__tests__/permission/runtime-gate.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/regression/bash-process-control.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 spawn 同时验证 current plan/current permission/current identity；任何旧 approval 都不能跨新 action snapshot。

## Task 15: Wave E 公共出口与 INV-E1～E20 验收

**Files:**
- Modify: `src/agent/index.ts`
- Modify: `src/memory/index.ts`
- Modify: `src/permission/index.ts`
- Create: `src/__tests__/agent/wave-e-contracts.test.ts`
- Create: `logs/agent-mechanisms-wave-e-verification.md`

**Interfaces:**
- Consumes: Task 1～14。
- Produces: Wave F/G 稳定 imports、20 条不变量证据和 Wave E 完成报告。

- [ ] **Step 1: 写公共出口 RED**

```ts
it('exports every Wave E lifecycle anchor', () => {
  expect([
    decideMetaRetention,
    canActivateMetaRetention,
    persistAndSelectMemory,
    createLocalDiagnosticBuffer,
    flushDiagnosticBuffer,
    decideInlineEnvironment,
    resolveExecutableIdentity,
    buildSanitizedExecutionPlan,
    revalidateExecutableIdentity,
  ].every((value) => value !== undefined)).toBe(true);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/wave-e-contracts.test.ts
```

- [ ] **Step 3: 导出稳定接口**

只导出 ERC input/output、policy、builder、validator 和 acknowledgement。Filesystem temp names、pino destination、normalization helpers、platform stat adapter、legacy mapper 不导出。

- [ ] **Step 4: 建立 INV-E1～E20 测试名**

```text
INV-E1 snapshots do not mix
INV-E2 meta does not count as a user turn
INV-E3 retention does not change authority
INV-E4 serializer and compressor agree
INV-E5 retention is not reconstruction
INV-E6 memory states stay separate
INV-E7 detail is invisible before index commit
INV-E8 the index is not memory body
INV-E9 selection does not establish trust
INV-E10 persistence and retrieval remain siblings
INV-E11 only sanitized payload enters the buffer
INV-E12 logging is non-blocking and outcome-independent
INV-E13 dropped payload cannot be recovered
INV-E14 inherited and inline environment compose with AND
INV-E15 executable identity binds to the action
INV-E16 sanitization does not grant permission
INV-E17 platform policies do not mix
INV-E18 failures never upgrade state
INV-E19 protocol versions stay orthogonal
INV-E20 only ERC-2 feeds Wave F
```

- [ ] **Step 5: 运行 targeted Wave E suite**

```powershell
npx vitest run src/__tests__/agent/meta-retention.test.ts src/__tests__/session/meta-lifecycle-serialization.test.ts src/__tests__/agent/meta-context-compression.test.ts src/__tests__/agent/meta-retention-activation.test.ts src/__tests__/memory/memory-detail-transaction.test.ts src/__tests__/memory/memory-catalog-commit.test.ts src/__tests__/memory/memory-legacy-adapter.test.ts src/__tests__/memory/memory-selection.test.ts src/__tests__/memory/memory-retrieval-use-gate.test.ts src/__tests__/memory/persist-and-select-memory.test.ts src/__tests__/agent/local-diagnostic-buffer.test.ts src/__tests__/agent/local-diagnostic-flush.test.ts src/__tests__/permission/inline-environment-policy.test.ts src/__tests__/permission/executable-resolution.test.ts src/__tests__/permission/sanitized-execution-plan.test.ts src/__tests__/permission/executable-revalidation.test.ts src/__tests__/permission/sanitized-execution-cutover.test.ts src/__tests__/agent/wave-e-contracts.test.ts
```

- [ ] **Step 6: 运行影响模块回归**

```powershell
npx vitest run src/__tests__/agent/ src/__tests__/memory/ src/__tests__/permission/ src/__tests__/session/ src/__tests__/compression.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/streaming-permission-passthrough.test.ts src/__tests__/regression/bash-process-control.test.ts
```

- [ ] **Step 7: 运行 Wave Gate**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

- [ ] **Step 8: 写验证日志**

`logs/agent-mechanisms-wave-e-verification.md` 必须记录：

```text
changed: 实际修改文件
mechanisms: M-038, M-045, M-046, M-052, M-065
verification_level: V3
red_evidence: 命令、目标失败测试、失败原因
green_evidence: 命令、通过文件数、通过测试数
invariant_evidence: INV-E1 through INV-E20
memory_sibling_check: M-045 and M-046 share schema but no direct dependency
wave_f_direct_input: ERC-2 only
wave_g_deferred_handoff: ERC-1 reload marker only; reconstruction not implemented
remaining_uncertainty: 仅列真实未验证项
deferred_hold_check: no Deferred or Hold implementation activated
```

- [ ] **Step 9: Review checkpoint**

逐条对照 Wave E §15 验收矩阵、§16 完成标准和 §13 Wave F handoff。缺少 durable acknowledgement、runtime assertion、RED/GREEN 或回归证据时不得进入 Wave F。

## 3. Wave F / G Handoff

Wave F M-013 只能依赖 ERC-2：

- immutable governed `MemoryCatalogSnapshot`；
- completed transaction identity 或确定性 legacy durability evidence；
- bounded metadata-only index；
- deterministic `MemorySelectionResult`；
- selection budgets/overflow；
- detail provenance/hash；
- retrieval 后的 current-context `MemoryUseDecision` gate。

Wave F 不能假设：

- index 包含正文；
- 既有 Memory 自动 admitted；
- admit/detail/index/selected 等于 use；
- catalog/selection 可以无限增长；
- overflow 可以静默；
- 所有 detail 可以注入。

ERC-1、ERC-3、ERC-4 没有 Wave F direct edge。

Wave G M-049 可以消费 ERC-1 的 `MetaMessageLifecycleRecord` 和 preserve/reload_required/invalidated marker，但不能假设 reload 已完成、meta 当前仍有效或 Memory entrypoint 可以替代 project-rule reload。

## 4. 完成标准

1. M-038、M-045、M-046、M-052、M-065 均有唯一主 Task。
2. ERC-1～ERC-4 均有公开 lifecycle anchor。
3. INV-E1～E20 均有机器可判定测试或 runtime assertion。
4. Meta serializer/compressor round-trip 不增加 user turn count。
5. Retention 不改变 Authority/Trust，且不实现 M-049。
6. Serializer/compressor 任一不支持时 M-038 不激活。
7. Memory detail 在 durable index commit 前不可发现。
8. Persistence 使用 idempotency/version 防重复和 lost update。
9. Catalog budget 超限不静默截断。
10. Legacy Memory 条目不自动 admitted。
11. Selector 只读 metadata，预算/overflow 显式。
12. Selection/retrieval 不绕过 current-context MemoryUseDecision。
13. M-045/M-046 没有相互 D-edge。
14. Raw/dropped telemetry 从未进入 buffer 或临时文件。
15. Buffer overflow 固定 drop_newest，enqueue 不阻塞 streaming。
16. Flush 只移除 durable acknowledged events，shutdown 有界。
17. inherited/inline environment 是 AND，平台 policy 不混用。
18. Executable resolution 不执行 binary，不产生 allow。
19. Sanitized plan 仍需 RC-5 permission。
20. Spawn 前 identity revalidation；变化使旧 approval 失效。
21. Enforced command path 不回退 `shell:true`。
22. 只有 ERC-2 形成 Wave F direct edge。
23. Targeted、regression、typecheck、lint、build、full test 有新鲜证据。
24. 未实现 Wave F/G、Deferred 或 Hold。
25. 未执行部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作。
