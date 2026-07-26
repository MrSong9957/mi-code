# mi-code Agent Mechanisms Wave F Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 实现 M-013/FRC-1 Bounded Memory Entrypoint，把 ERC-2 的 governed catalog、selection、retrieval 和 current-context use decisions 编译为不可变、有硬预算、有显式 overflow 的双层 Memory section snapshot。

**Architecture:** FRC-1 采用 Navigation Layer 与 Verified Detail Layer 分权。构建过程一次性捕获 task/context/catalog/selection/policy/budget/detail/use snapshots，依次完成 eligibility、projection、语义边界预算、确定性 render 和 immutable snapshot；任何失败都不会读取全部 Memory、修改 ERC-2 状态或改变 TurnOutcome。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、Node `crypto/Buffer`、Wave B Prompt compiler、Wave E governed Memory catalog/selection/use contracts。

## Global Constraints

- 唯一设计输入是冻结的主实施计划、Wave A～E 实施计划和 `2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md`。
- 本计划只覆盖 M-013，并且只映射到 FRC-1。
- FRC-1 只消费冻结 D-edge：M-042、M-043、M-044、M-045、M-046、M-050 的上游产物；不重新调用其内部流程。
- 不得新增 M-013→M-038、M-052、M-065 或 Hold 机制的依赖。
- Catalog 只提供导航和完整性 metadata，不是 Memory 正文。
- Selection 只提供候选引用；只有 current-context `MemoryUseDecision(status='use')` 的 verified claim 可进入正文。
- Navigation 与 Verified Detail 使用独立预算，另有最终 total-section 硬预算。
- 所有预算必须来自受信 policy；不得使用 Claude 200 行、25KB 或其他外部参数作为默认值。
- 预算只能省略完整 navigation item 或完整 verified claim；不得切断多字节字符、claim、provenance label 或 entry。
- 任意 eligible 内容被省略时必须产生 `partial` 或 `rejected`，并携带 overflow manifest。
- system Placement 不提升 `authority='memory'`；Memory 不成为 System Rule、Project Instruction、current user、tool policy 或 SecurityDecision。
- Empty 入口通过省略 section 表达，不生成“No memories”或其他伪内容。
- Cache 只优化性能；不得恢复 stale/do_not_use/needs_refresh/omitted raw detail。
- FRC-1 只读 snapshot，不修改 admission、record、transaction、catalog、selection、use、confidence 或 evidence。
- Build、cache 或 compiler failure 不改变 TurnOutcome，不回退 full-load。
- Prompt compiler 使用 approved render-profile/template asset 作为包装器身份；动态 Memory 内容本身不获得 Prompt asset approval。
- 每项行为修改执行 RED→GREEN→REFACTOR，保留失败原因正确的 RED 证据。
- Wave F 冻结前执行 targeted tests、影响模块回归、`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
- 本计划不授权生产部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作。

---

## 1. 文件结构与所有权

```text
src/agent/context/
├── bounded-memory.ts                  # FRC-1 identity/projection/core builder
├── bounded-memory-budget.ts           # semantic-boundary budgeting
├── bounded-memory-render.ts           # deterministic Memory section render
└── bounded-memory-cache.ts            # optional immutable snapshot cache

src/agent/prompt/
└── compiler.ts                        # approved render-template handoff

src/agent/
└── streaming-query.ts                 # activation/pre-send integration
```

共享文件串行修改：

| 文件 | 顺序 |
|---|---|
| `src/agent/context/bounded-memory.ts` | Task 1 → Task 2 → Task 3 → Task 6 → Task 9 |
| `src/agent/context/bounded-memory-budget.ts` | Task 4 → Task 6 |
| `src/agent/context/bounded-memory-render.ts` | Task 5 → Task 6 → Task 8 |
| `src/agent/context/bounded-memory-cache.ts` | Task 7 → Task 9 |
| `src/agent/prompt/compiler.ts` | Task 8 |
| `src/agent/streaming-query.ts` | Task 9 |

## 2. Task 依赖

```text
T1 Policy + Immutable Input Capture
 ├→ T2 Navigation Projection
 └→ T3 Verified Claim Projection

T2 + T3
 ├→ T4 Budget + Overflow
 └→ T5 Deterministic Render

T1–T5
 └→ T6 Core Entrypoint Snapshot
     ├→ T7 Optional Cache
     └→ T8 Prompt Compiler Handoff

T6 + T7 + T8
 └→ T9 Activation + Request Integration

T1–T9 → T10 Wave F Acceptance
```

Task 2 与 Task 3 可并行开发；它们共享输入 identity，但不共享权限。Task 4 冻结 `MemoryBudgetFragmentRenderer` 接口并用确定性 fake 测试预算算法，Task 5 提供唯一生产实现和 conformance test；Task 6 只有在二者都完成后才接线。

## Task 1: FRC-1 Policy 与 Immutable Build Capture

**Files:**
- Create: `src/agent/context/bounded-memory.ts`
- Test: `src/__tests__/agent/bounded-memory-input.test.ts`

**Interfaces:**
- Consumes: task/current-context/project/catalog/selection/policy/budget/render snapshots。
- Produces: `captureMemoryEntrypointBuild(input): PreparedMemoryEntrypointBuild`。

- [ ] **Step 1: 写 identity/policy RED**

```ts
it('rejects a selection bound to another catalog snapshot', () => {
  expect(() => captureMemoryEntrypointBuild({
    ...buildInput,
    catalog_snapshot: catalog({ catalog_snapshot_id: 'catalog-a' }),
    selection_result: selection({ catalog_snapshot_id: 'catalog-b' }),
  })).toThrow(/catalog_snapshot_mismatch/);
});

it('returns an empty prepared build without reading details when disabled', () => {
  const prepared = captureMemoryEntrypointBuild({
    ...buildInput,
    policy: entrypointPolicy({ enabled: false }),
  });
  expect(prepared.state).toBe('empty');
  expect(detailReader).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-input.test.ts
```

- [ ] **Step 3: 实现 policy/input types**

精确实现 FRC-1 §7.2～§7.4。Policy 数量和 budget refs 必须有限、非负且来自受信配置；`empty_behavior` 只接受 `omit_section`。

- [ ] **Step 4: 实现一次性 capture**

复制并冻结 task/context/project/catalog/selection/policy/request-budget/render identity，以及 retrieved detail/use-decision refs。构建期间的新 catalog、selection、detail 或 use decision不得混入。

- [ ] **Step 5: 实现 identity/hash validation**

验证：

```text
catalog immutable + catalog hash
selection task/catalog identity
retrieval record/version/catalog/selection identity
use decision current-context/project identity
policy/render/request-budget refs
```

Mismatch 产生 `rejected` prepared result，不修改上游 snapshot。

- [ ] **Step 6: 写 version orthogonality 测试**

Entrypoint、record、catalog、selection、use、budget、render、Prompt/model versions 使用独立字段；修改其中一个只生成新 build identity，不改写其他 version。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-input.test.ts src/__tests__/memory/persist-and-select-memory.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认没有读取 `.memory/MEMORY.md`、调用 `selectByKeywords()`/`inject()` 或采用默认 Claude 阈值。

## Task 2: FRC-1 Navigation Projection

**Files:**
- Modify: `src/agent/context/bounded-memory.ts`
- Test: `src/__tests__/agent/bounded-memory-navigation.test.ts`

**Interfaces:**
- Consumes: `PreparedMemoryEntrypointBuild`、selected catalog metadata、durability evidence validator。
- Produces: `projectMemoryNavigation(input): NavigationProjectionResult`。

- [ ] **Step 1: 写交集 eligibility RED**

```ts
it('projects only selected, allowed, durable catalog metadata', () => {
  const result = projectMemoryNavigation(prepared, {
    validateDurability: (ref) => ref === 'durable:ok',
  });
  expect(result.items.map((item) => item.memory_record_id)).toEqual(['memory-allowed']);
  expect(result.omissions).toEqual(expect.arrayContaining([
    expect.objectContaining({ memory_record_id: 'memory-undurable', reason: 'durability_unverified' }),
    expect.objectContaining({ memory_record_id: 'memory-wrong-scope', reason: 'scope_excluded' }),
  ]));
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-navigation.test.ts
```

- [ ] **Step 3: 实现 navigation item**

只复制 record/version/rank/type/scope/topic/keyword/time/hash/provenance/durability metadata。禁止 body、claim content、credential、evidence body、conversation、project instruction 或模型摘要。

- [ ] **Step 4: 实现确定性 ordering**

顺序固定：

```text
selection_rank → catalog entry_order → memory_record_id ASC
```

不使用 confidence、detail length 或模型相关度重新排序；不修改原 selection。

- [ ] **Step 5: 实现 eligibility omissions**

为 scope/type/durability/not-selected/integrity failure 生成结构化 reason。`not_selected` 可仅保留聚合计数；其他失败保留 record identity。

- [ ] **Step 6: 写 metadata leakage test**

递归检查 navigation output 不包含 `body/content/claim/instruction/conversation/security_decision` 字段。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-navigation.test.ts src/__tests__/memory/memory-selection.test.ts src/__tests__/memory/memory-catalog-commit.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 catalog/selection rank 没有被解释为 Truth、Trust、Authority 或 use。

## Task 3: FRC-1 Verified Claim Projection

**Files:**
- Modify: `src/agent/context/bounded-memory.ts`
- Test: `src/__tests__/agent/bounded-memory-verified-claims.test.ts`

**Interfaces:**
- Consumes: selected retrievals、current-context `MemoryUseDecision`、deterministic claim-content lookup。
- Produces: `projectVerifiedMemoryClaims(input, lookup): VerifiedClaimProjectionResult`。

- [ ] **Step 1: 写 selected ≠ retrieved ≠ use RED**

```ts
it.each([
  ['do_not_use', 'do_not_use'],
  ['needs_refresh', 'refresh_required'],
] as const)('omits claims for %s', (status, reason) => {
  const result = projectVerifiedMemoryClaims(
    projectionInput(useDecision({ status })),
    claimLookup,
  );
  expect(result.projections).toEqual([]);
  expect(result.omitted_claims[0].reason).toBe(reason);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-verified-claims.test.ts
```

- [ ] **Step 3: 实现九门 verified projection**

同时验证：

```text
selected
retrieved
detail hash/version valid
use status = use
claim in verified_claim_refs
claim not stale
no unresolved conflict
current context matches
project version compatible
```

- [ ] **Step 4: 实现 deterministic content lookup**

`VerifiedClaimContentLookup` 只能按 claim ref 取得已验证内容范围、content ref/hash；不得调用模型摘要、改写、补全或 inference。

- [ ] **Step 5: 实现 ordering/deduplication**

先按 navigation 最终顺序，再按 use decision 的 `verified_claim_refs` 顺序。同一 claim+hash 去重；相同 identity、不同 hash 使 build rejected。

- [ ] **Step 6: 写 stale/conflict/hash tests**

Stale、conflicting、missing detail、hash/version mismatch 分别产生 omission/integrity diagnostic；不得读取其他 detail 或 full-load。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-verified-claims.test.ts src/__tests__/memory/memory-retrieval-use-gate.test.ts src/__tests__/memory/memory-use-decision.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 projection 只包含 verified claim，不产生新的 Memory、confidence 或 instruction。

## Task 4: FRC-1 Hard Budgets 与 Overflow Manifest

**Files:**
- Create: `src/agent/context/bounded-memory-budget.ts`
- Test: `src/__tests__/agent/bounded-memory-budget.test.ts`

**Interfaces:**
- Consumes: eligible navigation/claim projections、three budget policies、注入的 `MemoryBudgetFragmentRenderer`/estimator。
- Produces: `applyMemoryEntrypointBudgets(input): BudgetedMemoryEntrypoint`。

- [ ] **Step 1: 写三层预算顺序 RED**

```ts
it('applies count, layer, and total budgets in the frozen order', () => {
  const result = applyMemoryEntrypointBudgets(budgetInput);
  expect(result.applied_steps).toEqual([
    'navigation_count',
    'navigation_budget',
    'per_item_claim_count',
    'verified_detail_count',
    'verified_detail_budget',
    'total_section_budget',
  ]);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-budget.test.ts
```

- [ ] **Step 3: 冻结 fragment renderer 接口与最终 render 计量**

```ts
export interface MemoryBudgetFragmentRenderer {
  renderNavigation(item: MemoryNavigationItem): string;
  renderVerifiedClaim(claim: VerifiedMemoryClaimProjection): string;
}
```

每个完整 item/claim 先用注入的 renderer 生成候选片段，再计算：

```ts
bytes = Buffer.byteLength(rendered, 'utf8');
lines = rendered.length === 0 ? 0 : rendered.split('\n').length;
estimated_tokens = estimator ? estimator.measure(rendered) : null;
```

Estimator 必须携带 method/version/model scope，不得冒充 Provider usage。

- [ ] **Step 4: 实现 semantic-boundary omission**

单项超过子预算时整项省略。Total 超限时先按逆序省略最低优先级 verified claim，再按逆序省略最低优先级 navigation item。禁止切 string/Buffer/frontmatter/link/provenance label。

- [ ] **Step 5: 实现 overflow manifest**

记录 navigation/detail/total overflow、omitted records/claims、reason codes 和 budget refs。任何 eligible omission 使 state 至少 `partial`；`overflow_behavior='reject'` 时任一超限直接 rejected。

- [ ] **Step 6: 写 metadata-preservation test**

预算不能删除 Authority、Trust、Freshness、provenance、type、scope 来容纳正文。

- [ ] **Step 7: 写 multibyte/zero-budget tests**

覆盖中文/emoji、单项超限、零预算、count cap、line/byte/token 不同口径和 total-budget 二阶段 omission。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-budget.test.ts src/__tests__/agent/bounded-context-source.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认没有隐含 unlimited budget，没有使用源文件大小近似最终 render。

## Task 5: FRC-1 Deterministic Render

**Files:**
- Create: `src/agent/context/bounded-memory-render.ts`
- Test: `src/__tests__/agent/bounded-memory-render.test.ts`

**Interfaces:**
- Consumes: navigation item、verified claim projection、overflow/provenance metadata、approved render profile。
- Produces: `renderMemoryNavigationFragment()`、`renderVerifiedClaimFragment()`、`renderMemoryEntrypoint()`，并实现 Task 4 `MemoryBudgetFragmentRenderer`。

- [ ] **Step 1: 写稳定 section/Authority RED**

```ts
it('renders a stable Memory section without promoting authority', () => {
  const rendered = renderMemoryEntrypoint(renderInput);
  expect(rendered.section_id).toBe('memory.bounded_entrypoint');
  expect(rendered.authority).toBe('memory');
  expect(rendered.content).not.toContain('system rule');
  expect(rendered.content_hash).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-render.test.ts
```

- [ ] **Step 3: 实现 canonical render profile**

Approved render profile/template 只定义固定标签、字段顺序和 escaping。每项必须表达 memory type、scope、provenance/freshness、navigation metadata；正文只放 verified claim content。

Navigation/claim fragment renderer 是 Task 4 预算计量和最终 combined render 的共同真相源；不得维护一套“估算 render”和另一套“最终 render”。

- [ ] **Step 4: 实现安全 escaping**

对 attribute/label/content 使用确定性 escaping，使 Memory 内容不能闭合包装器或伪造 system/security/completion section。Escaping 不改写 claim 语义，hash 基于最终 render。

- [ ] **Step 5: 实现 overflow marker**

Partial render 必须携带机器可追踪 `overflow_manifest_ref` 和“不完整入口”标记；不能列出未选中敏感 identity，也不能声称完整。

- [ ] **Step 6: 写 forbidden-semantics tests**

Render 不生成 System Rule、must obey、SecurityDecision、PermissionDecision、CompletionOutcome、“未显示 Memory 不存在”等语义。

- [ ] **Step 7: 写 renderer conformance 与 deterministic snapshot test**

把 Task 5 renderer 注入 Task 4，断言预算测得的 fragment bytes/lines 与最终 combined render 中相同 fragment 完全一致。相同 input/profile 重复 render 字节相同、hash 相同；不读取时间、全局状态或 mutable catalog。

- [ ] **Step 8: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-render.test.ts src/__tests__/agent/prompt-compiler.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认 approved 的是 render profile/template，不是动态 Memory 正文。

## Task 6: M-013 Core Entrypoint Snapshot

**Files:**
- Modify: `src/agent/context/bounded-memory.ts`
- Modify: `src/agent/context/bounded-memory-budget.ts`
- Modify: `src/agent/context/bounded-memory-render.ts`
- Test: `src/__tests__/agent/bounded-memory-entrypoint.test.ts`

**Interfaces:**
- Consumes: Task 1～5 的 capture/projection/budget/render APIs。
- Produces: `buildBoundedMemoryEntrypoint(input, dependencies): BoundedMemoryEntrypointSnapshot`。

- [ ] **Step 1: 写状态机 RED**

```ts
it.each([
  ['valid items', readyInput, 'ready'],
  ['valid empty', emptyInput, 'empty'],
  ['eligible omissions', partialInput, 'partial'],
  ['identity failure', rejectedInput, 'rejected'],
] as const)('builds %s as %s', (_name, input, state) => {
  expect(buildBoundedMemoryEntrypoint(input, dependencies).state).toBe(state);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-entrypoint.test.ts
```

- [ ] **Step 3: 实现固定 pipeline**

```text
capture
→ navigation eligibility/order
→ verified claim eligibility/order
→ layer budgets
→ combined render
→ total budget
→ overflow/provenance manifests
→ immutable snapshot
```

不得在 pipeline 中重新读取 catalog、selection 或 MemoryManager。

- [ ] **Step 4: 实现 state/output contract**

```text
ready    → rendered_section_ref/hash non-null, no eligible omission
empty    → rendered_section_ref/hash null
partial  → rendered ref/hash + truncated overflow manifest
rejected → rendered ref/hash null
```

`partial` 不改变 TurnOutcome。

- [ ] **Step 5: 实现 item/snapshot identities**

Hash 覆盖 task/context/project/catalog/selection/policy/budget/render/use decisions、ordered item refs、overflow/provenance 和最终 content hash。所有输出深冻结。

- [ ] **Step 6: 写 no-write/no-full-load spies**

断言未调用 MemoryManager write/delete/rebuild/inject/getIndexContent，以及 search/retrieval failure 时未读取未选 detail。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-entrypoint.test.ts src/__tests__/agent/bounded-memory-input.test.ts src/__tests__/agent/bounded-memory-navigation.test.ts src/__tests__/agent/bounded-memory-verified-claims.test.ts src/__tests__/agent/bounded-memory-budget.test.ts src/__tests__/agent/bounded-memory-render.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 Core Anchor 不反向修改 ERC-2，不生成 project instruction 或 current-user content。

## Task 7: FRC-1 Optional Snapshot Cache

**Files:**
- Create: `src/agent/context/bounded-memory-cache.ts`
- Test: `src/__tests__/agent/bounded-memory-cache.test.ts`

**Interfaces:**
- Consumes: complete build identity、immutable entrypoint snapshot。
- Produces: `createMemoryEntrypointCache()`、`getOrBuildMemoryEntrypoint()`。

- [ ] **Step 1: 写 hit/rebuild 深相等 RED**

```ts
it('returns the same snapshot semantics on hit and rebuild', () => {
  const miss = getOrBuildMemoryEntrypoint(input, cache, builder);
  cache.clear();
  const rebuilt = getOrBuildMemoryEntrypoint(input, cache, builder);
  expect(rebuilt).toEqual(miss);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-cache.test.ts
```

- [ ] **Step 3: 实现两级 content-addressed cache identity**

先用 entrypoint/policy versions、task/context/project、catalog hash、selection、所有 use-decision IDs、render profile和三个 budget policies 生成 `semantic_input_key`。完成 build 后用：

```text
entry_key = hash(semantic_input_key + final_section_hash)
```

Cache index 只保存 `semantic_input_key → entry_key`；entry 保存 final section hash、immutable snapshot 和 manifests。Hit 时必须重新验证 index/entry identity 与 rendered content hash，不能只相信映射。

- [ ] **Step 4: 实现 invalidation**

Context/project/freshness/use decision/catalog/selection/render/budget 任一变化导致 miss。Cache corruption 丢弃 entry 并用同一 captured input 重建。

- [ ] **Step 5: 限制 cache payload**

只保存最终 immutable snapshot、rendered section、overflow/provenance manifests。禁止保存 omitted raw detail、do_not_use/needs_refresh content 或旁路 source。

- [ ] **Step 6: 写 cache-semantic negative tests**

Hit/miss 不改变 item 集、顺序、Authority/Trust/Freshness、overflow、content hash 或 Outcome；无 telemetry 数据时不报告成本收益。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-cache.test.ts src/__tests__/agent/bounded-memory-entrypoint.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 cache 可整体关闭，关闭后正确性和 snapshot 内容不变。

## Task 8: FRC-1 Prompt Compiler Handoff

**Files:**
- Modify: `src/agent/context/bounded-memory-render.ts`
- Modify: `src/agent/prompt/compiler.ts`
- Test: `src/__tests__/agent/bounded-memory-prompt-handoff.test.ts`

**Interfaces:**
- Consumes: ready/partial/empty `BoundedMemoryEntrypointSnapshot`、approved render-profile asset。
- Produces: `toMemoryPromptSection(snapshot, profile): PromptSectionInput | null`。

- [ ] **Step 1: 写 Placement/Authority RED**

```ts
it('keeps Memory authority when projected into a system section', () => {
  const section = toMemoryPromptSection(readySnapshot, approvedRenderProfile);
  expect(section?.placement).toBe('system_dynamic');
  expect(section?.authority).toBe('memory');
  expect(section?.section_id).toBe('memory.bounded_entrypoint');
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-prompt-handoff.test.ts
```

- [ ] **Step 3: 实现 render-template asset boundary**

`asset_ref` 指向 approved immutable Memory render-profile/template；动态 content/ref/hash/provenance 来自 FRC snapshot。Approval 只证明模板获准，不证明 Memory claim 为 Prompt asset。

- [ ] **Step 4: 实现 state handling**

Ready/partial 生成 section；empty 返回 null 并省略 section；prepared/rejected 抛结构化 handoff error。Partial 必须保留 overflow manifest ref。

- [ ] **Step 5: 保护 compiler boundary**

BRC-1 只编译已生成 section，不能重新 select/read detail、恢复 omitted claim、删除 overflow marker、改变 Authority，或混入新 snapshot。

- [ ] **Step 6: 写 compiler failure tests**

Compiler 不支持 metadata、template 未 approved、content hash mismatch、duplicate section/ordinal 均阻止请求；不得回退旧 Memory string join。

- [ ] **Step 7: 验证**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-prompt-handoff.test.ts src/__tests__/agent/prompt-compiler.test.ts src/__tests__/agent/profiled-prompt-compilation.test.ts
npm run typecheck
```

- [ ] **Step 8: Review checkpoint**

确认 FRC-1 没有 Prompt Registry、Placement policy 或 compiler ownership。

## Task 9: M-013 Activation Gate 与 Request Integration

**Files:**
- Modify: `src/agent/context/bounded-memory.ts`
- Modify: `src/agent/context/bounded-memory-cache.ts`
- Modify: `src/agent/streaming-query.ts`
- Test: `src/__tests__/agent/bounded-memory-activation.test.ts`
- Test: `src/__tests__/agent/bounded-memory-request.test.ts`

**Interfaces:**
- Consumes: FRC dependencies、BRC-1 compiler handoff、request context。
- Produces: `canActivateBoundedMemoryEntrypoint()` 与 pre-compilation request integration。

- [ ] **Step 1: 写十二门 Activation Gate RED**

```ts
it.each(activationGateNames)(
  'does not activate when %s is missing',
  (gate) => {
    expect(canActivateBoundedMemoryEntrypoint(evidenceWithout(gate))).toEqual({
      active: false,
      reason_codes: [`memory_entrypoint.gate_missing.${gate}`],
    });
  },
);
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-activation.test.ts
```

- [ ] **Step 3: 实现 activation evidence**

逐项验证 FRC §7.19：

```text
immutable/hash-valid catalog
durability evidence
deterministic bounded selection
version/hash-bound retrieval
current-context use decisions
use-only verified claims
source budgets/overflow
compiler stable section metadata
Authority/Trust/Placement separation
empty omission
no full-load fallback
deterministic test evidence
```

任一缺失保持 inactive，不用 Prompt warning 替代。

- [ ] **Step 4: 接入 request pipeline**

在 Prompt compilation input 捕获前构建 entrypoint；ready/partial 添加 Memory section，empty 省略，rejected/inactive 记录 metadata diagnostic 并省略，不改变 TurnOutcome。

- [ ] **Step 5: 写 capture-then-mutate integration**

Build 开始后修改 catalog/selection/use decision fixtures，断言当前 request 使用旧 captured snapshot；下一 request 才使用新 snapshot。

- [ ] **Step 6: 写 failure/no-full-load integration**

Catalog mismatch、detail missing、use unavailable、budget invalid、render/cache failure 时，spy 断言没有调用 `getIndexContent()/inject()/read-all`。

- [ ] **Step 7: 写 Wave G rebuild handoff**

输出结构化 `MemoryEntrypointRebuildInput` refs：entrypoint/content/task/context/project/catalog/selection/use/policy/render/budget/overflow/provenance/freshness。它只表示可请求重建，不表示已重建。

- [ ] **Step 8: 运行 V2/V3 影响路径**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-activation.test.ts src/__tests__/agent/bounded-memory-request.test.ts src/__tests__/agent/bounded-memory-prompt-handoff.test.ts src/__tests__/streaming-query.test.ts
npm run typecheck
```

- [ ] **Step 9: Review checkpoint**

确认未实现 M-049、未依赖 ERC-1/3/4、旧 use decision 不被声明为可跨 context 复用。

## Task 10: Wave F 公共出口与 INV-F1～F16 验收

**Files:**
- Modify: `src/agent/index.ts`
- Create: `src/__tests__/agent/wave-f-contracts.test.ts`
- Create: `logs/agent-mechanisms-wave-f-verification.md`

**Interfaces:**
- Consumes: Task 1～9。
- Produces: Wave G 稳定 imports、16 条不变量证据和 Wave F 完成报告。

- [ ] **Step 1: 写公共出口 RED**

```ts
it('exports the Wave F entrypoint anchors', () => {
  expect([
    buildBoundedMemoryEntrypoint,
    canActivateBoundedMemoryEntrypoint,
    toMemoryPromptSection,
  ].every((value) => value !== undefined)).toBe(true);
});
```

- [ ] **Step 2: 运行 RED**

```powershell
npx vitest run src/__tests__/agent/wave-f-contracts.test.ts
```

- [ ] **Step 3: 导出稳定接口**

只导出 FRC policy/input/output、core builder、activation result、compiler handoff 和 rebuild identity。Budget internals、escape helper、cache map、claim lookup adapter 不导出。

- [ ] **Step 4: 建立 INV-F1～F16 测试名**

```text
INV-F1 snapshots do not mix
INV-F2 the catalog is not memory body
INV-F3 selected is not use
INV-F4 navigation and verified detail remain separate
INV-F5 every entrypoint layer has a hard limit
INV-F6 overflow is explicit
INV-F7 omission happens only at semantic boundaries
INV-F8 placement does not promote authority
INV-F9 freshness binds to the current context
INV-F10 failure never falls back to full-load
INV-F11 cache does not own semantics
INV-F12 empty entrypoints create no content
INV-F13 FRC-1 never writes memory
INV-F14 protocol versions stay orthogonal
INV-F15 failure does not change TurnOutcome
INV-F16 no frozen dependency edge is added
```

- [ ] **Step 5: 运行 targeted Wave F suite**

```powershell
npx vitest run src/__tests__/agent/bounded-memory-input.test.ts src/__tests__/agent/bounded-memory-navigation.test.ts src/__tests__/agent/bounded-memory-verified-claims.test.ts src/__tests__/agent/bounded-memory-budget.test.ts src/__tests__/agent/bounded-memory-render.test.ts src/__tests__/agent/bounded-memory-entrypoint.test.ts src/__tests__/agent/bounded-memory-cache.test.ts src/__tests__/agent/bounded-memory-prompt-handoff.test.ts src/__tests__/agent/bounded-memory-activation.test.ts src/__tests__/agent/bounded-memory-request.test.ts src/__tests__/agent/wave-f-contracts.test.ts
```

- [ ] **Step 6: 运行影响模块回归**

```powershell
npx vitest run src/__tests__/agent/ src/__tests__/memory/ src/__tests__/streaming-query.test.ts
```

- [ ] **Step 7: 运行 Wave Gate**

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

- [ ] **Step 8: 写验证日志**

`logs/agent-mechanisms-wave-f-verification.md` 必须记录：

```text
changed: 实际修改文件
mechanisms: M-013
verification_level: V3
red_evidence: 命令、目标失败测试、失败原因
green_evidence: 命令、通过文件数、通过测试数
invariant_evidence: INV-F1 through INV-F16
layer_check: navigation metadata only; verified detail requires current-context use
budget_check: navigation, detail, total; semantic-boundary omission only
authority_check: memory even when placed in system
full_load_fallback_check: absent
wave_g_handoff: rebuild request identity only
remaining_uncertainty: 仅列真实未验证项
deferred_hold_check: no Deferred or Hold implementation activated
```

- [ ] **Step 9: Review checkpoint**

逐条对照 Wave F §12 验收矩阵、§13 完成标准和 §10 Wave G handoff。缺少 hard-budget、use-gate、overflow、Authority 或 no-full-load 证据时不得进入 Wave G。

## 3. Wave G Handoff

Wave G M-049 可以依赖：

- `BoundedMemoryEntrypointSnapshot` 和 content hash；
- task/current-context/project/catalog/selection identities；
- navigation/verified claim/use-decision refs；
- policy/render/budget refs；
- overflow/provenance/freshness refs；
- empty/ready/partial/rejected state；
- `MemoryEntrypointRebuildInput`。

Wave G 不能假设：

- 旧 entrypoint 在压缩后仍 fresh；
- 旧 use decision 可跨 target context 复用；
- catalog/selection/detail/project version 未变化；
- partial 是完整 Memory；
- cache 可替代 source/use revalidation；
- reconstruction 可以加载全部 Memory；
- FRC-1 可以替代 M-038 meta lifecycle；
- rebuild request 表示 rebuild 已完成。

## 4. 完成标准

1. M-013 唯一映射到 FRC-1。
2. 10 个 Task 均有独立 RED/GREEN/review checkpoint。
3. INV-F1～F16 均有机器可判定测试或 runtime assertion。
4. Navigation 只来自 selected governed catalog metadata。
5. Verified Detail 只包含 current-context use 的 verified claims。
6. Catalog、selection、retrieval 和 use identities 保持一致。
7. Navigation、detail、total 三层预算均有限且版本化。
8. 预算只在完整 item/claim 边界省略。
9. Eligible omission 产生 partial/rejected 和 overflow manifest。
10. Empty 入口省略 section，不生成伪内容。
11. system Placement 保持 `authority='memory'`。
12. Approved render template 不等于动态 Memory 正文 approved。
13. Cache hit/miss 不改变语义。
14. 任何失败不回退读取全部 Memory。
15. FRC-1 不写入或修复 ERC-2 状态。
16. Activation Gate 12 项全部可验证。
17. Wave G handoff 只交付 rebuild identity，不提前重建。
18. 未依赖 M-038/M-052/M-065/Hold。
19. Targeted、regression、typecheck、lint、build、full test 有新鲜证据。
20. 未实现 Wave G、Deferred 或 Hold。
21. 未执行部署、依赖升级、数据库迁移、Prompt Library 激活或 Git 历史写操作。
