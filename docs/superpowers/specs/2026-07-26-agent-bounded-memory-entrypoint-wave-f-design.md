# mi-code Bounded Memory Entrypoint — Wave F

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix、Wave A～E 设计规格
> 覆盖机制：M-013
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave F 只有一个节点，不再拆分多个跨模块契约。

本文冻结一个契约：

| Wave F Contract | 机制 | 机制 Owner |
|---|---|---|
| FRC-1 Bounded Memory Entrypoint | M-013 | Phase 2 |

FRC-1 不直接读取整个 Memory 目录，也不把 `MEMORY.md` 文件存在视为可注入资格。它消费 ERC-2 已冻结的 catalog、selection、durability 和 use-decision 语义，生成一个不可变、可审计、有明确溢出状态的 Memory entrypoint snapshot。

最终入口由两层组成：

1. **Navigation Layer**：只包含经 scope/type 过滤和 selection 选中的 catalog metadata；
2. **Verified Detail Layer**：只包含已检索、且 `MemoryUseDecision(status='use')` 明确允许的 verified claim projection。

两层共享同一 task、context、catalog、selection 和 budget snapshot。任何一层失败都不能回退为“加载全部 Memory”。

FRC-1 可以把内容放入 system message 的 Memory section，但 Placement 不改变其 Authority、Trust、Freshness 或来源类别。Auto Memory 仍是 Memory，不是 System Rule、Project Instruction 或当前用户消息。

## 2. 设计目标

Wave F 必须回答：

1. 什么条件下 Memory 可以成为请求入口候选。
2. 为什么 catalog entry 不等于 Memory 正文。
3. 为什么 selected 不等于 use。
4. 如何把 navigation metadata 与 verified detail 分开预算和渲染。
5. 如何绑定 task、current context、catalog、selection 和 use-decision snapshot。
6. 如何在不采用 Claude 200 行/25KB 参数的前提下建立硬预算。
7. 如何确定性处理 entry 数量、字节、行数和估算 token 溢出。
8. 为什么截断只能发生在 entry/claim 边界，不能切断语义单元。
9. 如何表达“有更多 Memory 未进入本次入口”，而不静默声称完整。
10. 空入口、部分入口、拒绝入口分别具有什么语义。
11. 缓存可以优化什么，不能改变什么。
12. FRC-1 如何接入 Prompt Compiler，但不获得 Prompt Registry、Placement 或 Security 的所有权。
13. Wave G M-049 可以消费什么、不能假设什么。
14. 为什么 M-013 不反向修改 admission、persistence、catalog、selection 或 use。

## 3. 明确排除

本文不设计或实施：

- Memory candidate 的发现、类型化或 admission；
- Memory detail/index 的持久化事务；
- catalog repair、rebuild 或 migration；
- topic/keyword 的分词、归一化、模糊匹配或同义词算法；
- Memory claim 的事实核验算法；
- confidence 的重新评分；
- Memory detail 的模型摘要；
- 自动生成新的 Memory；
- Project Instruction、CLAUDE.md、AGENTS.md 或其他规则入口；
- post-compact Pinned Working Set 重建；
- compaction 触发条件或摘要算法；
- Claude 的 200 行、25KB 或其他阈值作为 mi-code 默认值；
- Prompt cache 命中策略或成本收益声明；
- Prompt 原文选择、改写、评测、批准或嵌入；
- 生产代码、实现文件、测试任务、数据迁移、工期或 Git 操作。

这些能力已经由上游契约负责、属于 Wave G，或留给全部设计冻结后的详细实施计划。

## 4. 现状、方案比较与复用边界

### 4.1 当前事实

Baseline 已确认：

- `MemoryManager` 已有 detail 文件和 `MEMORY.md` catalog；
- 已有关键词选择和 detail 注入辅助方法；
- 主请求链路没有调用这些自动选择/注入方法；
- 当前 Memory 缺少强制 evidence、confidence、freshness、invalidation 和 use-decision 语义；
- 当前没有 bounded Memory entrypoint contract。

现有能力可以作为存储、读取和索引实现的复用候选，但不能直接成为 FRC-1 的信任或注入依据。

### 4.2 方案比较

#### 方案 A：直接加载整个 `MEMORY.md`

优点：

- 最接近 Claude 的入口形态；
- 实现表面简单；
- 能显示完整 catalog。

缺点：

- 文件存在会被误当作注入资格；
- 绕过 ERC-2 的 governed catalog 和 selection；
- 旧数据可能借自动加载获得未审查 Authority；
- catalog 变大后污染请求预算；
- 文件级截断可能切断语义并隐藏 overflow。

结论：拒绝。

#### 方案 B：只注入 selected detail 正文

优点：

- 入口体积较小；
- 与当前任务相关度较高；
- 不需要展示 catalog。

缺点：

- selected 容易被误解为可用；
- 失去 bounded entrypoint 的导航语义；
- detail 全文仍可能绕过 verified claim gate；
- 缺少对未选中/未注入条目的显式 overflow 表达。

结论：拒绝。

#### 方案 C：不可变双层 EntryPoint Snapshot

优点：

- Navigation 与 verified detail 权限分离；
- 直接消费 ERC-2 的 catalog、selection 和 use decision；
- 可以对每层独立预算；
- 能显式表达 omitted/overflow；
- 可以作为 Wave G 的稳定重建输入；
- cache 只复用 snapshot，不拥有语义。

缺点：

- 比直接拼接字符串多一个结构化编译步骤；
- 需要维护 snapshot identity 和跨输入一致性。

结论：采用。

### 4.3 Wheel Reuse Check

FRC-1 必须优先复用：

| 冻结或现有能力 | FRC-1 复用方式 |
|---|---|
| ERC-2 `MemoryCatalogSnapshot` | 作为唯一 catalog 输入 |
| ERC-2 `MemorySelectionResult` | 作为唯一 navigation selection 输入 |
| ERC-2 durability evidence | 排除半完成或未经兼容校验的旧条目 |
| DRC-2 `MemoryUseDecision` | 作为 verified detail 的硬 gate |
| BRC-3 `SourceBudgetPolicy` / `BoundedContextSource` | 复用 source guard 和显式 overflow 语义 |
| BRC-1 Prompt Compilation | 接收已经冻结的 Memory section snapshot |
| RC-2 Semantic Request Boundary | 复用 Placement 与 Authority 分离语义 |
| 现有 `MemoryManager` | 仅复用符合 ERC-2 输出契约的存储/读取能力 |

FRC-1 不建立第二套 Memory 存储、第二个 selector、第二个 use policy 或第二个 Prompt Compiler。

### 4.4 冻结 D-edge

| Wave F 机制 | 冻结 D 前置 |
|---|---|
| M-013 | M-042、M-043、M-044、M-045、M-046、M-050 |

Wave E 的直接 handoff 只有 ERC-2/M-045 与 ERC-2/M-046。M-042～M-044 和 M-050 已经通过上游 frozen contracts 被传递，FRC-1 不绕过 ERC-2 重新调用其内部流程。

不得新增以下 D-edge：

- M-013 → M-038；
- M-013 → M-052；
- M-013 → M-065；
- M-013 →任意 Hold 机制。

## 5. 跨契约数据流

```text
Current Task / Context Snapshot
        │
        ├───────────────┐
        │               │
        ▼               ▼
MemoryCatalogSnapshot   MemorySelectionResult
        │               │
        └───────┬───────┘
                │ identity / scope / rank validation
                ▼
       Navigation Projection
                │
selected record refs
                ▼
       bounded detail retrieval
                │
                ▼
       MemoryUseDecision
       ├─ use
       ├─ do_not_use
       └─ needs_refresh
                │
                ▼
      Verified Claim Projection
                │
                ▼
        EntryPoint Budgeting
        ├─ navigation budget
        ├─ verified detail budget
        └─ total section budget
                │
                ▼
 BoundedMemoryEntrypointSnapshot
        ├─ rendered section ref
        ├─ overflow manifest
        ├─ provenance manifest
        └─ cache identity
                │
                ▼
      BRC-1 Prompt Compilation
                │
                ▼
     system message / Memory section
```

任何失败路径都不会产生“加载全部 detail”的 fallback。

## 6. 共同词汇与身份

### 6.1 Contract reference

```ts
interface WaveFContractRef {
  contract_id: string;
  protocol_version: string;
}
```

FRC-1 的协议版本独立于：

- Memory record version；
- catalog protocol/version；
- selection protocol/version；
- MemoryUseDecision protocol/version；
- source budget policy version；
- Prompt asset version；
- Prompt compilation protocol version；
- model/provider version。

### 6.2 EntryPoint state

```ts
type MemoryEntrypointState =
  | 'prepared'
  | 'ready'
  | 'empty'
  | 'partial'
  | 'rejected';
```

语义：

| State | 含义 |
|---|---|
| `prepared` | 输入已捕获，尚未完成一致性和预算校验 |
| `ready` | 至少一个合法 navigation 或 verified detail item 可进入 section，且无被省略内容 |
| `empty` | 输入有效，但本次没有可进入入口的 item |
| `partial` | 至少一个合法 item 可进入，同时存在显式 budget/eligibility omission |
| `rejected` | identity、policy、provenance、freshness、hash 或结构校验失败，不能生成 section |

`partial` 表示入口不完整，不表示任务 `TurnOutcome=partial`。

### 6.3 Identity binding

一个 entrypoint snapshot 必须绑定：

- task snapshot；
- current context snapshot；
- project version；
- catalog snapshot；
- selection result；
- source budget policy；
- entrypoint policy；
- 所有被使用的 MemoryUseDecision；
- render profile；
- 最终内容 hash。

任何 identity 不一致都必须创建新的 snapshot 或拒绝，不能修改旧 snapshot。

## 7. FRC-1 — Bounded Memory Entrypoint

### 7.1 目标

FRC-1 将 ERC-2 的 governed Memory 输出投影为一个有界请求入口。

它只负责：

1. 验证输入 snapshot 的一致性；
2. 生成 navigation projection；
3. 接收并验证 verified claim projection；
4. 执行确定性预算；
5. 生成不可变 section snapshot；
6. 输出显式 overflow/omission metadata；
7. 为 BRC-1 和 Wave G 提供稳定 handoff。

FRC-1 不判断 Memory 是否真实，不决定 Memory 是否应持久化，也不修改 selector 结果。

### 7.2 Entrypoint policy

```ts
interface MemoryEntrypointPolicy {
  entrypoint_policy_protocol_version: string;
  policy_id: string;
  policy_version: string;
  enabled: boolean;
  allowed_memory_types: ReadonlyArray<AutoMemoryType>;
  allowed_scope_refs: ReadonlyArray<string>;
  navigation_budget_policy_ref: string;
  verified_detail_budget_policy_ref: string;
  total_section_budget_policy_ref: string;
  max_navigation_entries: number;
  max_verified_detail_items: number;
  max_verified_claims_per_item: number;
  overflow_behavior: 'entry_boundary_omit' | 'reject';
  empty_behavior: 'omit_section';
  render_profile_ref: string;
}
```

规则：

1. Policy 必须来自受信 runtime/configuration。
2. Prompt、Memory 文件、catalog entry、Tool Result 或 Agent 不能修改 policy。
3. 所有数量和预算必须是有限非负值。
4. `enabled=false` 产生有效 `empty` snapshot，不读取 detail。
5. `empty_behavior` 当前只允许 `omit_section`，不注入“No memories”占位文本。
6. navigation、verified detail 和 total section 使用不同 budget identity。
7. total section budget 是最终硬上限；子预算不能绕过它。
8. 阈值由 mi-code baseline、使用频率和评测决定，不继承 Claude 参数。
9. Policy 不授予 Memory use 资格。
10. Policy 不能改变 Memory Authority、Trust、Freshness 或 Retention。

### 7.3 Build input

```ts
interface MemoryEntrypointBuildInput {
  entrypoint_build_protocol_version: string;
  build_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot: MemoryCatalogSnapshot;
  selection_result: MemorySelectionResult;
  retrieved_details: ReadonlyArray<RetrievedMemoryDetail>;
  memory_use_decisions: ReadonlyArray<MemoryUseDecision>;
  policy_ref: WaveFContractRef;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
}
```

输入必须在 build 开始时一次性捕获。Build 过程中到达的新 catalog、selection、detail 或 use decision 不能混入当前 build。

### 7.4 Retrieved detail

```ts
interface RetrievedMemoryDetail {
  retrieval_protocol_version: string;
  retrieval_id: string;
  memory_record_id: string;
  record_version: string;
  catalog_snapshot_id: string;
  selection_id: string;
  detail_content_ref: string;
  detail_content_hash: string;
  retrieved_claim_refs: ReadonlyArray<string>;
  provenance_refs: ReadonlyArray<string>;
  freshness_ref: string;
}
```

规则：

1. Detail 必须来自 selection 中的 record。
2. record version/hash 必须与 catalog entry 一致。
3. retrieval 不建立 Trust 或 use 资格。
4. 未 selected 的 detail 不进入 build。
5. missing detail 产生 omission/integrity diagnostic，不触发 catalog repair。
6. stale detail 不回退为低置信正文。
7. retrieval failure 不触发“读取全部文件”。

### 7.5 Navigation item

```ts
interface MemoryNavigationItem {
  navigation_item_protocol_version: string;
  memory_record_id: string;
  record_version: string;
  selection_rank: number;
  memory_type: AutoMemoryType;
  scope_ref: string;
  topic_key_refs: ReadonlyArray<string>;
  keyword_key_refs: ReadonlyArray<string>;
  observed_at: string;
  expires_at: string | null;
  detail_content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  durability_evidence_ref: string;
}
```

Navigation item 只能来自：

```text
MemorySelectionResult.selected_entries
    ∩ MemoryCatalogSnapshot.entries
    ∩ policy.allowed_scope_refs
    ∩ policy.allowed_memory_types
    ∩ valid durability evidence
```

Navigation item 禁止包含：

- 完整 Memory body；
- 未经 use decision 的 claim；
- credential；
- 完整 evidence body；
- conversation transcript；
- Project Instruction 或 Prompt 正文；
- 模型生成的事实摘要；
- 未验证的“建议”“结论”或行为指令。

### 7.6 Verified claim projection

```ts
interface VerifiedMemoryClaimProjection {
  claim_projection_protocol_version: string;
  claim_projection_id: string;
  memory_record_id: string;
  record_version: string;
  retrieval_id: string;
  memory_use_decision_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  verified_claim_ref: string;
  content_ref: string;
  content_hash: string;
  provenance_refs: ReadonlyArray<string>;
  freshness_ref: string;
}
```

只有同时满足以下条件的 claim 可以生成 projection：

```text
selected
AND retrieved
AND detail hash/version valid
AND MemoryUseDecision.status = use
AND claim ∈ verified_claim_refs
AND claim ∉ stale_claim_refs
AND no unresolved conflicting evidence
AND current context identity matches
AND project version is compatible
```

Projection 只提取已验证 claim 对应的确定性内容范围，不进行模型改写、补写、摘要或推断。

`do_not_use` 与 `needs_refresh` 都不能生成 verified claim projection。

### 7.7 Navigation ordering

Navigation ordering 必须确定：

1. 先使用 `selection_rank`；
2. rank 相同使用 catalog `entry_order`；
3. 仍相同使用 `memory_record_id` 升序；
4. 不按 confidence 重新排序；
5. 不按 detail 长度重新排序；
6. 不由模型调整；
7. 相同输入 snapshot 必须产生相同顺序。

FRC-1 不修改 `MemorySelectionResult`，只验证并投影其顺序。

### 7.8 Verified detail ordering

Verified claim ordering 必须确定：

1. 先按对应 navigation item 的最终顺序；
2. 同一 record 内按 `verified_claim_refs` 的稳定顺序；
3. 同一 claim 不重复投影；
4. duplicate claim identity 只保留完全相同 hash 的一项；
5. 相同 identity、不同 hash 使 build `rejected`；
6. 不因内容措辞或模型相关度重新排序。

### 7.9 Budget application

Budget 按以下顺序执行：

```text
eligible navigation items
  → navigation count cap
  → navigation source budget
  → eligible verified claim projections
  → per-item claim cap
  → verified detail count cap
  → verified detail source budget
  → combined render
  → total section budget
```

硬规则：

1. Budget 使用确定性计量方法和明确 policy version。
2. bytes/lines 来自最终规范化 render，不使用源文件近似值。
3. estimated tokens 必须标注 estimator identity，不能冒充 Provider usage。
4. 只能在完整 navigation item 或完整 verified claim projection 边界省略。
5. 禁止在多字节字符、frontmatter、链接、claim 或 provenance label 中间截断。
6. 单个 item 超过其子预算时省略整个 item。
7. total section budget 超限时，先省略最低优先级 verified claim，再省略最低优先级 navigation item。
8. 已省略内容必须进入 overflow manifest。
9. 任何省略都使 state 至少为 `partial`。
10. `overflow_behavior='reject'` 时任一超限使 build `rejected`。
11. Budget 不能通过删除 provenance、freshness、memory type 或 scope metadata来容纳正文。
12. Budget 不能通过提升 Authority 或压缩语义来容纳更多内容。
13. Budget failure 不改变 TurnOutcome。

### 7.10 Overflow manifest

```ts
type MemoryEntrypointOmissionReason =
  | 'navigation_count_limit'
  | 'navigation_budget_limit'
  | 'verified_detail_count_limit'
  | 'verified_detail_budget_limit'
  | 'total_section_budget_limit'
  | 'not_selected'
  | 'detail_missing'
  | 'detail_hash_mismatch'
  | 'use_denied'
  | 'refresh_required'
  | 'stale'
  | 'conflicting_evidence'
  | 'scope_excluded'
  | 'type_excluded'
  | 'durability_unverified';

interface MemoryEntrypointOverflowManifest {
  overflow_protocol_version: string;
  overflow_manifest_id: string;
  entrypoint_snapshot_id: string;
  truncated: boolean;
  navigation_overflowed: boolean;
  verified_detail_overflowed: boolean;
  total_budget_overflowed: boolean;
  omitted_records: ReadonlyArray<{
    memory_record_id: string;
    reason_codes: ReadonlyArray<MemoryEntrypointOmissionReason>;
  }>;
  omitted_claim_refs: ReadonlyArray<{
    memory_record_id: string;
    claim_ref: string;
    reason_codes: ReadonlyArray<MemoryEntrypointOmissionReason>;
  }>;
  budget_policy_refs: ReadonlyArray<string>;
}
```

`truncated=true` 只表示本次入口没有包含全部 eligible 内容，不表示源 Memory 被修改。

因 `not_selected` 产生的记录可以只保留聚合计数，不必暴露所有未选中 identity；因 integrity/use/freshness 失败产生的 omission 必须保留可审计 reason。

### 7.11 Entrypoint item

```ts
interface BoundedMemoryEntrypointItem {
  entrypoint_item_protocol_version: string;
  entrypoint_item_id: string;
  memory_record_id: string;
  record_version: string;
  navigation_ref: string;
  verified_claim_projection_refs: ReadonlyArray<string>;
  authority: 'memory';
  trust_ref: string;
  freshness_ref: string;
  provenance_refs: ReadonlyArray<string>;
  item_content_ref: string;
  item_content_hash: string;
  bytes_included: number;
  lines_included: number;
  estimated_tokens: number | null;
  token_estimator_ref: string | null;
}
```

`authority='memory'` 是封闭值。FRC-1 不允许 item 声明：

- `system`；
- `project_instruction`；
- `current_user`；
- `tool_policy`；
- `security_decision`。

### 7.12 Entrypoint snapshot

```ts
interface BoundedMemoryEntrypointSnapshot {
  entrypoint_protocol_version: string;
  entrypoint_snapshot_id: string;
  build_id: string;
  state: MemoryEntrypointState;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  catalog_snapshot_id: string;
  selection_id: string;
  policy_ref: WaveFContractRef;
  request_budget_snapshot_id: string;
  render_profile_ref: string;
  navigation_item_refs: ReadonlyArray<string>;
  verified_claim_projection_refs: ReadonlyArray<string>;
  item_refs: ReadonlyArray<string>;
  memory_use_decision_refs: ReadonlyArray<string>;
  overflow_manifest_ref: string;
  provenance_manifest_ref: string;
  rendered_section_ref: string | null;
  rendered_section_hash: string | null;
  bytes_included: number;
  lines_included: number;
  estimated_tokens: number | null;
  token_estimator_ref: string | null;
  created_at: string;
  reason_codes: ReadonlyArray<string>;
}
```

Snapshot 创建后不可变。

状态约束：

| State | `rendered_section_ref` | 可交给 BRC-1 |
|---|---|---|
| `prepared` | null | 否 |
| `ready` | 非 null | 是 |
| `empty` | null | 是，以“省略该 section”表达 |
| `partial` | 非 null | 是，必须同时携带 overflow manifest |
| `rejected` | null | 否 |

### 7.13 Render contract

Memory section 使用稳定 section identity：

```text
section_id = memory.bounded_entrypoint
```

Render 必须表达：

- 这是长期 Memory 的有界入口；
- 每项的 Memory 类型与 scope；
- 来源/provenance label；
- freshness 或 observation identity；
- navigation metadata；
- 只有通过 use gate 的 verified claim 内容；
- 存在 overflow 时的机器可追踪标记。

Render 禁止表达：

- “以下内容是系统规则”；
- “必须无条件服从 Memory”；
- “selected 表示事实正确”；
- “未显示的 Memory 不存在”；
- “partial entrypoint 是完整 Memory”；
- 任何 SecurityDecision、PermissionDecision 或 CompletionOutcome。

### 7.14 Placement and Authority

FRC-1 输出进入 BRC-1 的 `memory.bounded_entrypoint` section。

Placement 可以是 system message 内的独立 section，但必须保持：

| 维度 | 值或来源 |
|---|---|
| Authority | `memory` |
| Trust | 来自上游 trust/admission/use metadata |
| Freshness | 来自 record/use-decision/current-context 校验 |
| Retention | 不由 FRC-1 提升；后续由相应 lifecycle policy决定 |
| Placement | 由 BRC-1/RC-2 的编译与请求边界决定 |

物理位置不能隐式覆盖这五个维度。

### 7.15 Prompt Compiler handoff

BRC-1 可以获得：

- 不可变 entrypoint snapshot；
- 稳定 section ID；
- rendered section ref/hash；
- Authority/Trust/Freshness/Provenance metadata；
- bytes/lines/estimated token measurement；
- overflow manifest；
- policy/version identity。

BRC-1 不能：

- 重新选择 Memory；
- 读取未投影 detail；
- 把 `do_not_use/needs_refresh` claim 加回正文；
- 移除 overflow 标记并声称完整；
- 将 Memory section 提升为 System Rule；
- 在编译过程中混入新的 catalog 或 use decision；
- 因 cache hit 改变正文或排序。

### 7.16 Cache semantics

Section cache 是可选优化，不是 FRC-1 的正确性前置。

Cache key 至少绑定：

- entrypoint protocol version；
- entrypoint policy version；
- task snapshot；
- current context snapshot；
- project version；
- catalog snapshot/hash；
- selection identity；
- 使用的 MemoryUseDecision identity；
- render profile；
- budget policy identities；
- 最终 section hash。

规则：

1. Cache miss 只影响性能。
2. Cache hit 必须返回与同输入重新构建完全相同的 snapshot。
3. current context、project version、freshness 或 use decision 变化使旧 cache 不可复用。
4. Cache 不能保存被省略的 raw detail 作为旁路。
5. Cache 不能恢复 `do_not_use/needs_refresh` 内容。
6. 没有 telemetry 证据时不得宣称 cache 成本收益。
7. Cache corruption 使 cache entry invalid；允许无 cache 重建，不允许加载全部 Memory。

### 7.17 Empty behavior

以下情况产生 `empty`，不是错误：

- policy disabled；
- catalog 合法但无 entry；
- selection 合法但无 selected entry；
- 所有 selected entry 都被 scope/type policy 排除；
- 所有 retrieved detail 都为 `do_not_use/needs_refresh`，且无 navigation item 可进入；
- 合法预算为零。

`empty` 时：

- 不注入“No memories recorded”；
- 不创建伪 Memory item；
- 不把 absence 解释为 Memory 系统不可用；
- 不触发自动写入或 catalog rebuild；
- 可以产生 metadata-only diagnostic。

### 7.18 Error semantics

| 条件 | 结果 |
|---|---|
| catalog snapshot mutable/hash mismatch | `rejected` |
| selection 引用不同 catalog/task snapshot | `rejected` |
| current context 与 use decision 不一致 | claim omitted；全部不一致时 `empty/partial` |
| record version/hash mismatch | record omitted + integrity diagnostic |
| durability evidence 缺失 | record omitted |
| detail missing | record/claim omitted，不触发 full-load |
| `needs_refresh` | claim omitted，保留 refresh reason |
| `do_not_use` | claim omitted |
| unresolved conflicting evidence | claim omitted |
| budget policy 缺失/非法 | `rejected` |
|单项超预算 |整项 omitted + overflow |
| total section 超预算 |确定性低优先级 omission，或按 policy `rejected` |
| render hash mismatch | `rejected` |
| cache corruption |丢弃 cache，按同一输入重建 |
| Prompt compiler 不支持 section metadata |禁止激活 FRC-1 |
| entrypoint build failure |不改变 TurnOutcome |

### 7.19 Activation gate

M-013 运行时激活必须同时满足：

1. `MemoryCatalogSnapshot` 不可变并可校验 hash；
2. governed catalog 只含具有 durability evidence 的 entry；
3. `MemorySelectionResult` 确定且带显式 budget/overflow；
4. detail retrieval 绑定 record version/hash；
5. `MemoryUseDecision` 绑定 current context；
6. 只有 `status='use'` 的 verified claim 可进入正文；
7. BRC-3 source budget 与 overflow metadata 可用；
8. BRC-1 支持稳定 section ID、metadata 和不可变 snapshot；
9. Authority/Trust/Placement 分离可被保留；
10. empty section 可以被省略且不产生伪内容；
11. failure 不回退加载全部 Memory；
12. 关键 snapshot/ordering/budget/use-gate 行为有确定性验证。

任一门不满足时，不能用 Prompt 警告代替协议 enforcement。

## 8. Wave F 不变量

### INV-F1 — Snapshot 不混合

同一 entrypoint build 只能消费一次捕获的 task、context、catalog、selection、policy、budget、detail 和 use-decision snapshots。

### INV-F2 — Catalog 不等于正文

Catalog entry 只提供导航与完整性 metadata，不能被当作完整 Memory claim。

### INV-F3 — Selected 不等于 Use

Selection 只产生候选引用。只有 current-context `MemoryUseDecision(status='use')` 的 verified claim 可以进入正文。

### INV-F4 — Navigation 与 Verified Detail 分权

Navigation item 不携带未经 use gate 的正文；verified detail 不获得修改 navigation rank 的权限。

### INV-F5 — EntryPoint 有硬上限

Navigation、verified detail 和 total section 都必须有有限预算；缺失预算不能解释为无限预算。

### INV-F6 — Overflow 不静默

任何 eligible 内容被预算省略时，snapshot 必须为 `partial` 或 `rejected`，并携带 overflow manifest。

### INV-F7 — 只在语义边界省略

不得截断多字节字符、claim、provenance label 或 entry 的中间内容。

### INV-F8 — Placement 不提升 Authority

Memory section 即使位于 system message，也保持 `authority='memory'`，不能成为 System Rule、Project Instruction 或 User Message。

### INV-F9 — Freshness 绑定当前上下文

旧 session 的 use decision、过期 project version 或 stale claim 不能因 cache、catalog 或历史注入而继续使用。

### INV-F10 — Failure 不 Full-Load

Selection、retrieval、use、budget、render 或 cache 失败都不能回退为读取全部 Memory。

### INV-F11 — Cache 不拥有语义

Cache hit/miss 不改变 item 集合、顺序、正文、Authority、Trust、Freshness、overflow 或 Outcome。

### INV-F12 — 空入口不造内容

没有合法 item 时省略 section，不生成“No memories”、默认规则或推断内容。

### INV-F13 — FRC-1 不反向写 Memory

Entrypoint build 不修改 admission、record、persistence transaction、catalog、selection、use decision、confidence 或 evidence。

### INV-F14 — Version 正交

Entrypoint、record、catalog、selection、use、budget、render、Prompt compilation 和 model/provider version 独立演进。

### INV-F15 — Failure 不改变 TurnOutcome

Memory entrypoint 的 unavailable、empty、partial、rejected 或 cache failure 不直接改变业务 TurnOutcome。

### INV-F16 — 不新增冻结 D-edge

M-013 只消费冻结 DAG 中已有前置。Wave F 不依赖 M-038、M-052、M-065 或 Hold 机制。

## 9. 兼容与废止关系

| 当前语义 | Wave F 结论 |
|---|---|
| 直接读取 `.memory/MEMORY.md` | 只能作为存储实现输入；必须先形成 governed catalog snapshot |
| 文件存在即自动注入 | 废止；需要 catalog、selection、budget 和 use gate |
| `getIndexContent()` 返回字符串即可拼接 | 迁移为 immutable navigation projection |
| `selectByKeywords()` 结果直接注入 | 废止；selection 只产生候选引用 |
| `inject(slugs)` 注入完整 detail | 废止；只投影 verified claim |
| `MAX_INJECT` 是唯一预算 | 废止；navigation/detail/total 使用结构化多维预算 |
| 找不到 detail 时忽略 | 改为显式 omission/integrity diagnostic |
|截断后仍声称完整 | 废止；必须 partial + overflow manifest |
|注入 system prompt 即获得 system authority |禁止；Placement 与 Authority 分离 |
| cache 保存字符串即可复用 | cache 必须绑定完整 snapshot identity |
|没有 Memory 时注入占位说明 |省略 section |
| Memory 加载失败影响任务 Outcome |禁止；报告 entrypoint 状态，不重写 Outcome |

## 10. Wave G Handoff

Wave G 唯一节点为 M-049 Post-Compact Reconstruction。

M-049 可以从 FRC-1 获得：

- `BoundedMemoryEntrypointSnapshot`；
- entrypoint/content hash；
- task/current-context/project/catalog/selection identity；
- navigation item refs；
- verified claim projection refs；
- MemoryUseDecision refs；
- policy、render 和 budget refs；
- overflow manifest；
- provenance/freshness refs；
- empty/ready/partial/rejected 状态；
- 可重新构建入口所需的结构化 identity。

M-049 不能假设：

- 旧 entrypoint snapshot 在压缩后仍 fresh；
- reload marker 表示 source 已重新读取；
- 旧 MemoryUseDecision 可以跨 current-context snapshot 复用；
- catalog、selection、detail 或 project version 未变化；
- partial entrypoint 是完整 Memory；
- cache entry 可以替代 source/use revalidation；
- reconstruction 可以加载全部 Memory；
- M-013 可以替代 M-038 的 meta lifecycle；
- M-049 可以反向修改 FRC-1 budget、selection 或 use 语义。

Wave G 必须把“重新构建请求”与“已经重新构建”区分为不同状态。

## 11. 防御边界

| 高频失败 | FRC-1 防护原则 |
|---|---|
| `MEMORY.md` 存在即 trusted | 只接受 governed catalog snapshot |
|旧条目自动进入新入口 |要求兼容 admission 与 durability evidence |
| selected 当作事实正确 |强制 MemoryUseDecision |
| detail 全文直接注入 |只投影 verified claim |
| scope/type 不匹配 |先过滤，再渲染 |
| catalog/selection snapshot 混合 | identity mismatch → rejected |
| stale use decision 继续使用 |绑定 current context/project version |
| hash/version 漂移 |整项 omitted 或 build rejected |
|单项过大被切半 |只在完整 item/claim 边界省略 |
| overflow 静默 |partial/rejected + manifest |
| budget 缺失时无限加载 |fail closed |
|空入口生成误导性占位 |省略 section |
| system Placement 提升 Authority |强制 `authority='memory'` |
| cache 恢复旧正文 |完整 identity key + freshness invalidation |
|失败回退加载全部 Memory |明确禁止 full-load fallback |
| entrypoint 反向修 Memory |只读 snapshot contract |
| Prompt 文案代替 use gate |activation gate 要求 runtime enforcement |

## 12. 规格级验收矩阵

### FRC-1 Identity

1. EntryPoint snapshot 绑定 task、context、project、catalog、selection、policy、budget 和 render identity。
2. Snapshot 创建后不可变。
3. record/catalog/selection/use/entrypoint/Prompt/model version 正交。
4. 任意跨 snapshot identity mismatch 有确定性失败。

### Navigation

1. Navigation 只来自 selected catalog metadata。
2. Navigation 不包含完整正文或未经验证 claim。
3. scope/type/durability gate 先于渲染。
4. ordering 对相同输入确定。
5. selector rank 不被 FRC-1 重新解释为 confidence 或 Truth。

### Verified Detail

1. Detail 必须 selected 且 hash/version 匹配。
2. Retrieval 不建立 use 资格。
3. `status='use'` 是正文投影的必要条件。
4. Projection 只包含 `verified_claim_refs`。
5. stale/conflicting/do_not_use/needs_refresh claim 不进入正文。
6. Projection 不进行模型摘要、改写或补全。

### Budget

1. Navigation、verified detail 和 total section 均有有限预算。
2. Claude 参数不成为默认值。
3. 只在完整 item/claim 边界省略。
4. bytes/lines 基于最终 render 计算。
5. estimated token 带 estimator identity。
6. 省略内容产生 `partial/rejected` 和 overflow manifest。
7. Budget failure 不回退 full-load。

### Placement and Rendering

1. Section identity 稳定为 `memory.bounded_entrypoint`。
2. system Placement 不提升 `authority='memory'`。
3. Trust/Freshness/Provenance metadata 不因预算被删除。
4. empty 时省略 section，不生成伪内容。
5. Prompt Compiler 不能重新选择或读取 Memory。
6. Render 不产生 SecurityDecision、PermissionDecision 或 Outcome。

### Cache

1. Cache 是可选优化。
2. 相同输入 cache hit 与重建结果一致。
3. context/project/freshness/use 变化使旧 cache 无效。
4. Cache 不保存 omitted raw detail 旁路。
5. Cache failure 不改变正文语义或 TurnOutcome。

### Wave G Handoff

1. M-049 获得 entrypoint snapshot 和完整 rebuild identity。
2. reload request 与 rebuild completion 分离。
3. 旧 use decision 不跨 context 自动复用。
4. reconstruction 不加载全部 Memory。
5. M-013 不替代 M-038 meta lifecycle。

### Cross-Contract

1. INV-F1～INV-F16 无冲突。
2. M-013 只映射到 FRC-1。
3. FRC-1 只消费冻结 D-edge。
4. FRC-1 不反向修改 ERC-2。
5. Failure 不提升 Authority、Trust、Freshness、Use 或 Outcome。
6. 未选择 Prompt 原文或进入实现任务。

## 13. 设计完成标准

Wave F 只有在以下条件全部满足后才能冻结：

1. M-013 唯一映射到 FRC-1。
2. ERC-2/M-045/M-046 handoff 被完整消费。
3. Navigation 与 verified detail 形成双层入口。
4. Catalog 不被当作正文。
5. Selected 不被当作 Use。
6. Use decision 绑定 current context。
7. Navigation、detail 和 total budget 均有硬上限。
8. Overflow 显式且确定。
9. 截断不跨语义边界。
10. system Placement 不提升 Memory Authority。
11. empty 不生成伪内容。
12. Cache 不拥有语义。
13. Failure 不回退 full-load。
14. FRC-1 不写入或修复 Memory。
15. INV-F1～INV-F16 可由结构化协议验证。
16. Wave G M-049 handoff 完整且无提前实现。
17. 未新增冻结 DAG D-edge。
18. 未选择、改写或嵌入 Claude Prompt 原文。
19. 未进入生产代码、实施文件、工期或 Git 操作。

## 14. 后续流程

本文审核冻结后：

1. 进入 Wave G M-049 Post-Compact Reconstruction 设计。
2. Wave G 只能消费冻结的 FRC-1 snapshot/rebuild identity 与 ERC-1 lifecycle marker。
3. Wave G 不得反向修改 M-013 selection、use、budget 或 render 语义。
4. Wave G 冻结后，核对 71 个机制的设计覆盖状态。
5. 全部设计冻结后，才编写主 Agent/Prompt 机制的详细实施计划。
6. Prompt Library Import 继续作为独立资产快照，不改变任何 Memory admission、persistence、selection、use、entrypoint 或 reconstruction 状态。
