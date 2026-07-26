# Wave E Verification

> 验证时间: 2026-07-27
> 分支: feature/agent-mechanisms-wave-a (Wave A+B+C+D+E)
> 规格: docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md
> 计划: docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-e-implementation.md

## changed (新增/修改文件)

### Wave E-1 (5 并行子代理)

**ERC-1 Meta Retention (T1, M-038)**
- src/agent/context/retention.ts (新建 decideMetaRetention + createMetaLifecycleRecord, 417 行)
- src/__tests__/agent/meta-retention.test.ts (32 tests)

**ERC-2 Memory Detail (T4, M-045)**
- src/memory/persistence.ts (新建 prepareMemoryPersistence + commitMemoryDetails)
- src/memory/memory-manager.ts (加 writeGovernedDetail/readGovernedDetail)
- src/__tests__/memory/memory-detail-transaction.test.ts (24 tests)

**ERC-2 Memory Selection (T6, M-046)**
- src/memory/catalog.ts (新建最小 snapshot 类型)
- src/memory/selection.ts (新建 selectMemoryEntries)
- src/__tests__/memory/memory-selection.test.ts (21 tests)

**ERC-3 Local Buffer (T9, M-052)**
- src/agent/observability/local-buffer.ts (新建 createLocalDiagnosticBuffer, 358 行)
- src/__tests__/agent/local-diagnostic-buffer.test.ts (22 tests)

**ERC-4 Inline Env (T11, M-065)**
- src/permission/executable-environment.ts (新建 classifyInlineAssignments + decideInlineEnvironment, 687 行)
- src/__tests__/permission/inline-environment-policy.test.ts (29 tests)

### Wave E-2 (5 并行子代理)

**ERC-1 Serializer (T2)**
- src/agent/context/retention.ts (追加 serialize/deserialize)
- src/session/store.ts (加 saveMetaLifecycle/loadMetaLifecycle/countUserTurns)
- src/__tests__/session/meta-lifecycle-serialization.test.ts (17 tests)

**ERC-2 Catalog Commit (T5)**
- src/memory/persistence.ts (追加 recoverMemoryPersistence)
- src/memory/catalog.ts (扩展 commitMemoryCatalog)
- src/memory/legacy-adapter.ts (新建 buildLegacyCatalogSnapshot)
- src/memory/memory-manager.ts (加 catalog primitives)
- src/__tests__/memory/memory-catalog-commit.test.ts (14 tests)
- src/__tests__/memory/memory-legacy-adapter.test.ts (11 tests)

**ERC-2 Retrieval (T7)**
- src/memory/selection.ts (追加 retrieveSelectedMemory)
- src/__tests__/memory/memory-retrieval-use-gate.test.ts (13 tests)

**ERC-3 Flush (T10)**
- src/agent/observability/local-buffer.ts (追加 flushDiagnosticBuffer/shutdownDiagnosticBuffer)
- src/__tests__/agent/local-diagnostic-flush.test.ts (18 tests)

**ERC-4 Resolution (T12)**
- src/permission/executable-environment.ts (追加 resolveExecutableIdentity)
- src/__tests__/permission/executable-resolution.test.ts (20 tests)

### Wave E-3 (3 并行子代理)

**ERC-1 Compressor Gate (T3)**
- src/agent/context/retention.ts (追加 applyMetaRetentionToCompression + canActivateMetaRetention)
- src/agent/compression.ts (加 meta directive helper 占位)
- src/__tests__/agent/meta-context-compression.test.ts (16 tests)
- src/__tests__/agent/meta-retention-activation.test.ts (15 tests)

**ERC-2 Memory Anchor (T8)**
- src/memory/persistence.ts (追加 persistAndSelectMemory)
- src/__tests__/memory/persist-and-select-memory.test.ts (19 tests)

**ERC-4 Sanitized Plan (T13)**
- src/permission/executable-environment.ts (追加 buildSanitizedExecutionPlan)
- src/__tests__/permission/sanitized-execution-plan.test.ts (33 tests)

### Wave E-4 (T14 子代理 + 主代理接入)

**ERC-4 Revalidation (T14)**
- src/permission/executable-environment.ts (追加 revalidateExecutableIdentity + executeSanitizedCommand)
- src/__tests__/permission/executable-revalidation.test.ts (25 tests)
- src/__tests__/permission/sanitized-execution-cutover.test.ts (14 tests)

**主代理接入**
- src/agent/types.ts (ToolExecutionContext 加 sanitizedExecutionPlan 可选字段)

### Wave E-5 (公共出口 + INV 验收)

**公共导出**
- src/agent/index.ts (ERC-1 + ERC-3 导出)
- src/memory/index.ts (ERC-2 persistence/catalog/selection/legacy 导出)
- src/permission/index.ts (ERC-4 executable-environment 导出)

**INV-E1~E20 验收**
- src/__tests__/agent/wave-e-contracts.test.ts (22 tests)

## mechanisms

M-038, M-045, M-046, M-052, M-065 (5 个机制, 4 个 ERC)

## verification_level

V3 (targeted + regression + typecheck + lint + build + full test)

## green_evidence

### Targeted suite (18 文件 / 365 用例全绿)
```
npx vitest run <Wave E 18 个测试文件>
→ Test Files 18 passed (18), Tests 365 passed (365)
```

### typecheck
```
npm run typecheck → tsc --noEmit (零错误)
```

### lint (Wave E 源文件零 error)
```
npm run lint → Wave E 源文件零 error
(修复了 catalog.ts unused import, persistence.ts useless-catch, selection.ts escape chars)
```

### build
```
npm run build → generated: planner.generated.ts + tsc 成功
(build 副产物 planner.generated.ts LF→CRLF 已还原)
```

### full test
```
npm test → Test Files 259 passed | 3 failed (262), Tests 3598 passed | 5 failed | 4 skipped (3607)
```

**5 个 failed 全部是 pre-existing**(Wave C/D 已确认):
- task-tool.test.ts (2): clientProvider is not a function
- thinking-gap-regression.test.ts (1): TUI 渲染 flaky
- tui/layout.test.tsx (2): StatusBar 进度条渲染

**Wave E 改动触及范围: 0 个失败**。

## invariant_evidence

INV-E1 through INV-E20 全部有测试 (wave-e-contracts.test.ts, 22 tests):
- INV-E1 Meta retention preserves Authority/Trust
- INV-E2 Meta does not count as user turn
- INV-E3 Memory snapshot consistency
- INV-E4 Admission ≠ persisted
- INV-E5 Detail undiscoverable before catalog commit
- INV-E6 Selector reads metadata only
- INV-E7 Selected ≠ use
- INV-E8 Buffer stores sanitized only
- INV-E9 Compressor preserves meta by lifecycle state
- INV-E10 Activation gate requires all six
- INV-E11 ERC-1 no Wave F direct edge
- INV-E12 ERC-2 is Wave F direct input
- INV-E13 Buffer non-blocking memory queue
- INV-E14 Inline env does not restore scrubbed
- INV-E15 Resolved ≠ allowed
- INV-E16 ready_for_permission ≠ spawn allowed
- INV-E17 Platform policies independently versioned
- INV-E18 Failures never upgrade state
- INV-E19 Protocol versions orthogonal
- INV-E20 No frozen dependency edge added

## no_direct_wave_f_edge

- ERC-1 (meta retention): applyMetaRetentionToCompression 只输出 marker 给 M-049, 不 import FRC-1
- ERC-3 (local buffer): 纯内存 queue, 无 Wave F import
- ERC-4 (executable env): 纯函数, 无 Wave F hook
- 只有 ERC-2 (M-045/M-046) 是 Wave F M-013 直接输入(设计意图)

## remaining_uncertainty

1. **ERC-4 完整 spawn cutover**: types.ts 加了 sanitizedExecutionPlan 可选字段, 但 tool-registry 的 createBashTool 实际 spawn 改 shell:false 是较大重构。当前 LEGACY(shell:true), enforced 路径需 ERC-4 Activation Gate 激活 + 后续 spawn 重构。这是设计意图(enforced 只在受信配置激活后启用)。

2. **session/store.ts meta lifecycle**: saveMetaLifecycle/loadMetaLifecycle 已实现 sidecar 持久化, 但 streaming-query 尚未在循环中调用(由 Wave G M-049 post-compact reconstruction 接入)。

3. **Memory persistence 真实 fs**: writeGovernedDetail/readGovernedDetail 已实现(temp+rename 原子写入 .memory/.records/), 但生产路径的端到端流程(persist→catalog→select→retrieve→use)需要主 agent 集成调用 persistAndSelectMemory。

4. **local-buffer flush 真实 sink**: flush/shutdown 协调器已实现, 但真实 pino sink adapter 由调用方注入(测试用 mock)。

## deferred_hold_check

no Deferred or Hold implementation activated. 本 Wave 未实现:
- Wave F 能力 (M-013/M-049 post-compact reconstruction)
- Wave G 能力
- ERC-4 spawn cutover 的完整运行时激活
- 部署 / 依赖升级 / 数据库迁移 / Prompt Library 激活 / Git 历史写操作

## 关键设计决策

### T9 typo 修复
T10 子代理发现 T9 遗留的语法 bug(enqueueDiagnosticEvent 缺右括号),修复为 `return buffer.enqueue(event);`。这是跨子代理协作的重要发现。

### T4 memory_record_id 用连字符
T4 子代理用 `memrec-` 而非 `memrec:` 前缀,因为 memory_record_id 会作为 .json 文件名,冒号在 Windows NTFS 是 ADS 分隔符会触发 EINVAL。正确的平台兼容性考虑。

### T5 catalog commit 在 catalog.ts
T5 子代理把 commitMemoryCatalog 放在 catalog.ts(而非 persistence.ts),因为它操作 catalog snapshot。公共导出时需要从 catalog.ts 导出(初次导出错误已修正)。

### ERC-4 接入策略
types.ts 加 sanitizedExecutionPlan 可选字段(unknown 类型避免反向依赖)。tool-registry/streaming-query 的完整 spawn cutover 留给 ERC-4 Activation Gate 激活后的后续工作,与 Wave C/D 的 hook 模式一致。
