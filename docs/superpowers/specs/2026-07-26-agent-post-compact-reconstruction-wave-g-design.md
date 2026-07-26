# mi-code Post-Compact Reconstruction — Wave G

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix、Wave A～F 设计规格
> 覆盖机制：M-049
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave G 是 Design Wave 的最后一个节点，不再拆分。

本文冻结一个契约：

| Wave G Contract | 机制 | 机制 Owner |
|---|---|---|
| GRC-1 Post-Compact Reconstruction | M-049 | Phase 4 |

GRC-1 不恢复压缩前的完整 transcript，也不把旧 Prompt、旧 meta message、旧 Memory entrypoint 或 compaction summary 原样拼回请求。

它执行一个不可变、可恢复、原子发布的 Reconstruction Transaction：

```text
capture
  → preflight tool-pair validation
  → compact
  → resolve pinned sources
  → rebuild context-bound assets
  → assemble working set
  → postflight validation
  → atomic publish
```

最终输出是按语义 plane 分离的 `RestoredWorkingSetSnapshot`，而不是无类型消息数组：

- restored meta-context refs；
- compact summary ref；
- rebuilt bounded Memory entrypoint handoff；
- current user message ref；
- 非 Provider-visible execution-state refs；
- 显式 omission/degradation manifest。

GRC-1 的核心原则是：

> 重建当前仍然有效的工作集，而不是复活过去的请求。

## 2. 设计目标

Wave G 必须回答：

1. 什么条件允许开始 compaction。
2. 为什么 tool-use/tool-result pairing 必须在 compaction 前通过。
3. 为什么 completed tool call 不能在 reconstruction 中重新执行。
4. 什么是 Pinned Working Set。
5. current user message、project instruction、summary、Memory 和 execution state 如何分 plane。
6. `preserve`、`reload_required`、`invalidated` 如何进入重建决策。
7. 为什么 reload marker 不等于 reload 已完成。
8. 哪些来源允许复用正文，哪些必须重新加载或重新构建。
9. 为什么旧 system prompt 字符串不能直接恢复。
10. 为什么旧 `MemoryUseDecision` 不能跨 post-compact context 复用。
11. compaction summary 的 Authority 和 Trust 是什么。
12. required item 与 optional item 的失败语义如何区分。
13. working set 如何确定性排序并原子发布。
14. reconstruction failure 如何恢复，且不破坏原 transcript。
15. 如何避免 current user message、meta context 或 summary 重复注入。
16. 如何在 publish 前再次验证 transcript 和 request invariants。
17. cache、telemetry 和日志为什么不能拥有 reconstruction 语义。
18. Wave G 完成后，71 个机制如何进入最终覆盖审计。

## 3. 明确排除

本文不设计或实施：

- compaction 触发阈值；
- 空闲 session 的离线维护式 compaction；
- L1/L2/L3/L4 压缩算法；
- 摘要模型、Prompt、fallback 文案或 max token 参数；
- source discovery、trusted extraction 或 project rule routing；
- meta-context activation；
- Memory admission、persistence、selection、use 或 entrypoint budget；
- tool execution、tool result 修复或重试；
- SecurityDecision、PermissionDecision 或 AwaitingUser UI；
- session serializer 的文件格式；
- 完整 transcript dump、远程日志或 production telemetry；
- Prompt cache/provider cache 配置；
- Prompt 原文选择、改写、评测、批准或嵌入；
- 生产代码、实现文件、测试任务、数据迁移、工期或 Git 操作。

GRC-1 只协调已冻结 contract 的输出，不接管其内部算法或状态所有权。

## 4. 现状、方案比较与复用边界

### 4.1 当前事实

Baseline 与源码确认：

- 当前 `runCompaction` 先执行 snip，再执行 micro compact；
- 字符估算超过阈值后可进入 L4 summary；
- `compactHistory` 与 `compactHistoryWithLLM` 最终只返回一条 user summary message；
- tool result 在 summary 序列化中被替换为占位文本；
- 当前压缩没有显式 post-compact reinjection；
- 当前 message model 没有完整 meta lifecycle；
- 当前实现不能证明压缩前后所有 tool pair、project rule、Memory 和 current-user invariants 被保持。

这些事实是迁移输入，不是目标语义。

### 4.2 方案比较

#### 方案 A：恢复完整 pre-compact transcript

优点：

- 信息保真度最高；
- 不需要 source 分类；
- 表面上最容易恢复上下文。

缺点：

- 直接抵消 compaction；
- 可能重新暴露已淘汰敏感内容；
- 可能重复 Provider-visible tool use/result；
- 会把 stale 环境、规则和 Memory 一起恢复；
- 无法证明旧权限和旧 use decision 仍有效。

结论：拒绝。

#### 方案 B：直接复用旧 Pinned 内容

优点：

- 成本较低；
- 可快速恢复 meta context 和 Memory；
- 容易缓存。

缺点：

- `reload_required` 会被误当作已加载；
- 旧 Memory use decision 会跨 context 泄漏；
- 旧 system prompt 可能与当前 Registry/Policy 不一致；
- source freshness 变化无法反映；
- cache 容易变成隐式 Authority。

结论：拒绝。

#### 方案 C：原子 Reconstruction Transaction

优点：

- preflight/postflight 均可验证；
- preserve/reload/invalidate 语义明确；
- 对 context-bound 资产强制重新构建；
- working set 分 plane，不靠字符串猜角色；
- 失败时不发布半成品；
- 可以确定性恢复或重试；
- 直接满足 M-008/M-013/M-038/M-070 的冻结边界。

缺点：

- 需要 transaction、manifest 和 acknowledgement；
- 发布前必须等待 required source resolution。

结论：采用。

### 4.3 Wheel Reuse Check

| 冻结或现有能力 | GRC-1 复用方式 |
|---|---|
| DRC-2 `ProjectInstructionActivation` | 提供 project-instruction meta identity |
| ERC-1 `MetaMessageLifecycleRecord` | 提供 preserve/reload_required/invalidated |
| FRC-1 `BoundedMemoryEntrypointSnapshot` | 提供 Memory entrypoint 与 rebuild identity |
| BRC-5 `ToolTranscriptValidation` | 提供 pre/post-compaction pairing gate |
| RC-2 Semantic Request Boundary | 保持 system/meta/conversation/tool plane 分离 |
| 当前 compaction engine | 只作为 summary/compacted-history producer |
| 现有 session/transcript persistence | 保存原 snapshot、transaction 和 publish acknowledgement |

GRC-1 不建立第二个 Prompt Compiler、meta lifecycle、Memory builder、tool validator 或 session store。BRC-1 在 compaction 之外照常为下一次请求独立编译当前 system snapshot；该过程不是 M-049 的输入或输出。

### 4.4 冻结 D-edge

| Wave G 机制 | 冻结 D 前置 |
|---|---|
| M-049 | M-008、M-013、M-038、M-070 |

GRC-1 可以消费这些机制已经冻结的 contract，但不能新增：

- M-031 → M-049；
- M-033 → M-049；
- M-052 → M-049；
- M-060 → M-049；
- 任意 Hold 机制 → M-049。

No-tool compaction 等全局安全约束仍然适用，但不因此改变冻结 DAG 的机制所有权。

## 5. 跨契约数据流

```text
Pre-Compact Transcript Snapshot
        │
        ▼
ToolTranscriptValidation(before_compaction)
        ├─ blocked/rejected → no compaction
        └─ accepted
                │
                ▼
       Compaction Result Snapshot
       ├─ compact summary
       ├─ source transcript identity
       └─ compactor acknowledgement
                │
                ▼
       Pinned Working Set Plan
       ├─ current user message: preserve exact
       ├─ project instructions: lifecycle resolve
       ├─ bounded Memory: rebuild for new context
       ├─ summary: derived context
       └─ execution state: structural only
                │
                ▼
       Source Resolution
       ├─ preserve + fresh → exact reuse
       ├─ reload_required → trusted reload pipeline
       ├─ invalidated → exclude
       └─ rebuild_required → owning contract rebuild
                │
                ▼
       RestoredWorkingSetCandidate
                │
                ▼
       Postflight Validation
       ├─ tool transcript pairing
       ├─ identity/order/dedup
       ├─ Authority/Placement
       ├─ freshness/current context
       └─ request budget
                │
                ▼
       Atomic Publish
                │
                ▼
       RestoredWorkingSetSnapshot
```

任何 `blocked/rejected` 路径都不会覆盖最后一个可恢复的 pre-compact snapshot。

## 6. 共同词汇与身份

### 6.1 Contract reference

```ts
interface WaveGContractRef {
  contract_id: string;
  protocol_version: string;
}
```

### 6.2 Reconstruction state

```ts
type ReconstructionState =
  | 'requested'
  | 'preflight_accepted'
  | 'compacted'
  | 'sources_resolved'
  | 'assembled'
  | 'postflight_accepted'
  | 'published'
  | 'blocked'
  | 'rejected';
```

成功路径：

```text
requested
  → preflight_accepted
  → compacted
  → sources_resolved
  → assembled
  → postflight_accepted
  → published
```

`blocked/rejected` 不能直接跳到 `published`。

### 6.3 Item requirement

```ts
type WorkingSetRequirement =
  | 'required_exact'
  | 'required_current'
  | 'optional_current'
  | 'structural_only';
```

语义：

| Requirement | 含义 |
|---|---|
| `required_exact` | 必须以相同 identity/hash 保留 |
| `required_current` | 必须通过当前上下文重新解析或构建 |
| `optional_current` | 只能在当前有效时加入；失败可显式省略 |
| `structural_only` | 只保留 runtime identity/state，不进入 Provider-visible正文 |

### 6.4 Resolution action

```ts
type ReconstructionResolutionAction =
  | 'preserve_exact'
  | 'reload'
  | 'rebuild'
  | 'exclude'
  | 'block';
```

Action 不改变来源 Authority、Trust 或事实状态。

## 7. GRC-1 — Post-Compact Reconstruction

### 7.1 目标

GRC-1 负责：

1. 捕获 reconstruction input；
2. 执行 compaction preflight；
3. 接收不可变 compaction result；
4. 建立 Pinned Working Set plan；
5. 协调 preserve/reload/rebuild/exclude；
6. 组装分 plane candidate；
7. 执行 postflight；
8. 原子发布新 working set；
9. 记录 omission/degradation/recovery；
10. 输出最终覆盖审计所需机制状态。

GRC-1 不修改上游 source、policy、use decision、tool result 或 Prompt asset。

### 7.2 Reconstruction policy

```ts
interface ReconstructionPolicy {
  reconstruction_policy_protocol_version: string;
  policy_id: string;
  policy_version: string;
  current_user_requirement: 'required_exact';
  compact_summary_requirement: 'required_current';
  project_instruction_requirement: 'required_current';
  memory_entrypoint_requirement: 'optional_current';
  execution_state_requirement: 'structural_only';
  publish_mode: 'atomic';
  source_failure_behavior: 'block_required_omit_optional';
  duplicate_behavior: 'reject';
  unknown_item_behavior: 'reject';
  request_budget_policy_ref: string;
}
```

规则：

1. Policy 来自受信 runtime/configuration。
2. Prompt、summary、source content、Tool Result 或 Agent 不能修改 policy。
3. `publish_mode` 当前只允许 `atomic`。
4. current user message 不能降级为 optional。
5. compact summary 失败时不能发布“无历史”的新 snapshot。
6. active required project instruction 失败时必须 block。
7. Memory entrypoint 可以显式省略，但不能复用 stale snapshot。
8. execution state 不能因“重要”而进入 Provider-visible正文。
9. unknown item 不能默认 preserve。
10. Policy 不授予 source trust、permission 或 use。

### 7.3 Pre-compact snapshot

```ts
interface PreCompactSnapshot {
  precompact_protocol_version: string;
  precompact_snapshot_id: string;
  session_id: string;
  turn_id: string;
  task_snapshot_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  transcript_snapshot_id: string;
  current_user_message_ref: string;
  current_user_message_hash: string;
  active_project_activation_refs: ReadonlyArray<string>;
  active_meta_lifecycle_refs: ReadonlyArray<string>;
  memory_entrypoint_snapshot_ref: string | null;
  execution_state_refs: ReadonlyArray<string>;
  request_budget_snapshot_id: string;
  captured_at: string;
}
```

Snapshot 创建后不可变。

Compaction 开始后到达的新 user message、tool result、source activation 或 Memory decision 必须形成新的 pre-compact snapshot，不能混入当前 transaction。

### 7.4 Preflight validation

Preflight 必须同时满足：

1. `ToolTranscriptValidation.checkpoint='before_compaction'`；
2. validation 绑定当前 transcript snapshot；
3. validation status 为 `accepted`；
4. 不存在 `pending_execution`；
5. 不存在 missing/orphan/duplicate/identity-conflict pair；
6. current user message identity/hash 可验证；
7. system Prompt 不在 transcript reconstruction 范围内；
8. reconstruction policy 与 request budget snapshot 可用；
9. transaction idempotency key 可建立；
10. pre-compact snapshot 已持久化或具有等价 durable acknowledgement。

任一条件失败时不执行 compaction。

### 7.5 Compaction result

```ts
type CompactionMethod =
  | 'deterministic_local'
  | 'model_summary';

interface CompactionResultSnapshot {
  compaction_result_protocol_version: string;
  compaction_result_id: string;
  precompact_snapshot_id: string;
  source_transcript_snapshot_id: string;
  preflight_validation_id: string;
  method: CompactionMethod;
  method_version: string;
  compact_summary_ref: string;
  compact_summary_hash: string;
  compact_summary_bytes: number;
  compact_summary_lines: number;
  compactor_ack_ref: string;
  created_at: string;
}
```

规则：

1. Summary 只表达 derived continuity context。
2. Summary 不继承被总结内容的最高 Authority。
3. Summary 不是 tool result、SecurityDecision、PermissionDecision 或 CompletionReport。
4. Summary 不能证明某个 action 已执行或成功。
5. Summary 不能替代 current user message。
6. Summary 不能替代 project instruction reload。
7. Summary 不能替代 Memory use decision。
8. Summary 必须是 text-only derived content，不能包含 tool-use/tool-result block。
9. text-only 校验只验证 compaction result 形状，不接管 M-031 的 compactor 内部策略。
10. source transcript identity/hash 不匹配时 result `rejected`。
11. summary 空或 hash 不可验证时不进入 source resolution。
12. compactor failure 保留 pre-compact snapshot，不发布新 working set。

### 7.6 Working Set plan

```ts
type WorkingSetItemKind =
  | 'current_user_message'
  | 'compact_summary'
  | 'project_instruction_meta'
  | 'bounded_memory_entrypoint'
  | 'execution_state';

interface PinnedWorkingSetPlanItem {
  plan_item_protocol_version: string;
  plan_item_id: string;
  item_kind: WorkingSetItemKind;
  source_ref: string;
  source_hash: string | null;
  requirement: WorkingSetRequirement;
  lifecycle_record_ref: string | null;
  target_plane:
    | 'system'
    | 'meta_context'
    | 'conversation_summary'
    | 'current_user'
    | 'execution_state';
  stable_ordinal: number;
  resolution_action: ReconstructionResolutionAction;
  reason_codes: ReadonlyArray<string>;
}

interface PinnedWorkingSetPlan {
  working_set_plan_protocol_version: string;
  working_set_plan_id: string;
  reconstruction_transaction_id: string;
  precompact_snapshot_id: string;
  compaction_result_id: string;
  target_context_snapshot_id: string;
  item_refs: ReadonlyArray<string>;
  plan_hash: string;
}
```

Plan 创建后不可变。

### 7.7 Required item matrix

| Item kind | Requirement | Resolution |
|---|---|---|
| current user message | `required_exact` | exact identity/hash preserve |
| compact summary | `required_current` | validate current compaction result |
| active project instruction meta | `required_current` | lifecycle preserve/reload/invalidate |
| bounded Memory entrypoint | `optional_current` | FRC-1 rebuild for target context |
| tool/execution state | `structural_only` | keep runtime refs outside Provider-visible正文 |

GRC-1 不把旧 system Prompt body 列为 Pinned Working Set item。System Prompt 不属于被压缩 transcript；下一次请求继续由 BRC-1 独立编译，不形成 `M-001 → M-049` D-edge。

`required_current` 要求得到确定的当前解析结果，不要求旧正文永久存在。经受信 lifecycle 判定的 `invalidated → exclude` 是成功 resolution；来源状态未知、reload 未确认或校验失败才是阻塞。

### 7.8 Project instruction resolution

对每个 active `ProjectInstructionActivation`：

```text
activation identity
  + MetaMessageLifecycleRecord
  + target context/project snapshot
  → reconstruction resolution
```

规则：

1. `preserve` 只有在 source freshness、project version、content hash 和 activation identity 仍有效时才可 `preserve_exact`。
2. `reload_required` 必须走受信 discovery/routing/loading/activation pipeline。
3. `reload_required` 本身不读取 source，也不表示 reload 完成。
4. `invalidated` 必须 `exclude`，不能保留旧正文。
5. source reload 必须产生新的 source/route/activation/lifecycle identity。
6. Agent、summary 或旧 meta content 不能自报 reload 成功。
7. reload 后内容相同仍形成新的 acknowledgement；不能复用旧 freshness 证明。
8. required instruction reload 失败使 transaction `blocked`。
9. 多个 meta context 继续使用上游 stable ordinal；ordinal conflict 使 transaction `rejected`。
10. meta context 不计作 current user turn。

### 7.9 Memory entrypoint resolution

旧 `BoundedMemoryEntrypointSnapshot` 只提供 rebuild identity，不自动恢复正文。

规则：

1. post-compact target context snapshot 与旧 context snapshot 不同。
2. 旧 `MemoryUseDecision` 不能跨 target context 自动复用。
3. GRC-1 必须向 FRC-1 发出结构化 rebuild request。
4. FRC-1 继续拥有 selection/use/budget/render 语义。
5. GRC-1 不能读取全部 Memory 或直接生成 verified claim。
6. 新的 FRC-1 snapshot 必须绑定 target context。
7. `ready/partial` 可以进入 system section plane。
8. `empty` 显式省略 Memory section。
9. `rejected/unavailable` 按 optional failure 记录 degradation，并省略 section。
10. 旧 cache 只有在 FRC-1 自身判定完整 identity 可复用时才可命中；GRC-1 不能越权复用。
11. Memory failure 不改变 TurnOutcome。
12. Memory omission 不能被 summary 填补。

### 7.10 Current user resolution

1. current user message 必须与 pre-compact identity/hash 完全一致。
2. current user message 只出现一次。
3. current user message 位于 `current_user` plane。
4. summary、meta context 或 Memory 不能替代 current user message。
5. 没有 active current-user turn 时，本契约拒绝启动；空闲 session 的维护式 compaction 不属于 M-049 当前设计范围。
6. 新 user message 在 transaction 期间到达时，当前 transaction 不得发布；必须基于新 snapshot 重启或安全串行化。
7. current user message 不按普通 source overflow 规则截断。

### 7.11 Execution-state resolution

Execution state 只保留：

- tool call identity；
- completed/failed/cancelled execution acknowledgement；
- permission/security decision refs；
- 已验证的 pair state；
- pending action journal ref（仅在 compaction 被阻止前用于恢复）。

规则：

1. completed tool call 不重新执行。
2. tool result 不从 summary、日志或自然语言重建。
3. `pending_execution` 阻止 compaction，因此不能出现在 published post-compact snapshot。
4. completed pair 可以被 summary 描述，但 summary 不是 result。
5. execution state 不进入 Provider-visible正文，除非已有独立 contract 明确投影。
6. GRC-1 不修复 missing result。
7. reconstruction retry 不重复提交 tool action。

### 7.12 Source resolution record

```ts
type SourceResolutionStatus =
  | 'resolved'
  | 'excluded'
  | 'blocked'
  | 'rejected';

interface ReconstructionSourceResolution {
  resolution_protocol_version: string;
  resolution_id: string;
  reconstruction_transaction_id: string;
  plan_item_id: string;
  source_ref_before: string;
  source_ref_after: string | null;
  source_hash_before: string | null;
  source_hash_after: string | null;
  action: ReconstructionResolutionAction;
  status: SourceResolutionStatus;
  freshness_ref: string | null;
  provenance_refs: ReadonlyArray<string>;
  acknowledgement_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}
```

Resolution record 创建后不可变。相同 source 发生新变化时创建新 record，不修改旧 record。

### 7.13 Reconstruction transaction

```ts
interface PostCompactReconstructionTransaction {
  reconstruction_protocol_version: string;
  reconstruction_transaction_id: string;
  idempotency_key: string;
  session_id: string;
  turn_id: string;
  precompact_snapshot_id: string;
  preflight_validation_id: string;
  compaction_result_id: string | null;
  working_set_plan_id: string | null;
  target_context_snapshot_id: string;
  state: ReconstructionState;
  source_resolution_refs: ReadonlyArray<string>;
  candidate_snapshot_ref: string | null;
  postflight_validation_ref: string | null;
  publish_ack_ref: string | null;
  recovery_ref: string | null;
  reason_codes: ReadonlyArray<string>;
}
```

规则：

1. 相同 idempotency key 不重复 compaction、reload、rebuild 或 publish。
2. 不同输入 snapshot 不能共享 idempotency key。
3. state transition 只能前进或进入 blocked/rejected。
4. blocked transaction 可以在所需外部条件满足后创建新 attempt，不能修改旧 record。
5. rejected transaction 不能发布。
6. publish acknowledgement 只能由 atomic publish path 产生。
7. transaction failure 不覆盖 pre-compact durable snapshot。

### 7.14 Candidate working set

```ts
interface RestoredWorkingSetCandidate {
  working_set_candidate_protocol_version: string;
  candidate_snapshot_id: string;
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: ReadonlyArray<string>;
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: ReadonlyArray<string>;
  source_resolution_refs: ReadonlyArray<string>;
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  candidate_hash: string;
}
```

Candidate 创建后不可变，但还不能发送给 Provider。

### 7.15 Plane ownership

| Plane | 内容 | Owner |
|---|---|---|
| system prompt |不属于 reconstruction；下一次请求独立编译 | BRC-1，GRC-1 不消费 |
| Memory section handoff | rebuilt bounded Memory entrypoint snapshot ref | FRC-1 |
| meta context | active/reloaded project instruction meta messages | DRC-2 + ERC-1 |
| conversation summary | compaction derived context | compaction result |
| current user | active current user message | session/turn lifecycle |
| execution state | tool/security/runtime refs |对应 runtime contract |

GRC-1 只组装 refs，不接管 plane Owner。

### 7.16 Ordering contract

GRC-1 输出的 reconstruction 顺序：

```text
bounded Memory entrypoint handoff (独立 system-section consumer)
  + meta context messages by stable ordinal
  → compact summary
  → current user message (if active)
```

Execution-state refs 不进入该消息顺序。

规则：

1. GRC-1 不定义 system Prompt 或 system section ordering。
2. meta context ordering 服从 activation stable ordinal。
3. summary 只出现一次。
4. current user message 只出现一次且位于 conversation tail。
5. Memory entrypoint 只作为 FRC-1 snapshot handoff，不转成 user/meta message。
6. duplicate identity 或 ordinal conflict 使 candidate rejected。
7. GRC-1 不按正文内容或模型判断重新排序。

### 7.17 Omission and degradation manifest

```ts
type ReconstructionOmissionReason =
  | 'source_invalidated'
  | 'optional_reload_failed'
  | 'optional_rebuild_failed'
  | 'memory_empty'
  | 'memory_partial'
  | 'budget_excluded'
  | 'freshness_failed'
  | 'project_version_changed'
  | 'identity_conflict'
  | 'unknown_item';

interface ReconstructionOmissionManifest {
  omission_protocol_version: string;
  omission_manifest_id: string;
  reconstruction_transaction_id: string;
  degraded: boolean;
  omitted_items: ReadonlyArray<{
    plan_item_id: string;
    source_ref: string;
    reason_codes: ReadonlyArray<ReconstructionOmissionReason>;
  }>;
  blocked_required_items: ReadonlyArray<{
    plan_item_id: string;
    source_ref: string;
    reason_codes: ReadonlyArray<string>;
  }>;
}
```

Required item 未得到确定 resolution 时，不能只写入 omission 后继续 publish。经受信 lifecycle 确认 invalidated 的 source 已得到确定 resolution，可以排除并发布；Optional item 缺失可以 degraded publish，但必须显式记录。

### 7.18 Request budget

1. Reconstruction 使用 target request budget snapshot。
2. pre-compact budget 不能自动复用。
3. current user message和 mandatory system/security/completion sections 不按普通历史淘汰。
4. project instruction source 继续使用自身 source budget；GRC-1 不二次静默截断。
5. Memory entrypoint 继续使用 FRC-1 三层预算。
6. summary 使用独立 bounded result。
7. 总请求预算不足时必须按已冻结淘汰/优先级策略处理，不能由 GRC-1 临时发明顺序。
8. required item 无法在合法预算中表示时 transaction blocked/rejected，不静默删除。
9. optional Memory 可以显式省略。
10. bytes/lines/estimated token measurement 保留 method identity。

### 7.19 Postflight validation

Candidate publish 前必须验证：

1. candidate/transaction/target-context identity 一致；
2. preflight validation 仍属于 source transcript；
3. required project instruction 全部 resolved；
4. invalidated source 未残留；
5. meta content/hash/ordinal 与 resolution acknowledgement 一致；
6. Memory snapshot 绑定 target context；
7. current user identity/hash/出现次数正确；
8. summary identity/hash/出现次数正确；
9. execution-state refs 未进入 Provider-visible正文；
10. tool transcript post-compaction validation accepted；
11. 不存在 pending/missing/orphan/duplicate/conflict pair；
12. request budget accepted；
13. duplicate detector accepted；
14. omission manifest 与实际省略一致；
15. candidate hash 可重放。

Postflight validation 创建后不可变。

### 7.20 Postflight tool pairing

```ts
interface PostCompactToolValidationRef {
  validation_id: string;
  transcript_snapshot_id: string;
  checkpoint: 'before_provider_send';
  expected_status: 'accepted';
}
```

规则：

1. post-compact snapshot 不伪造 tool result。
2. summary 中的工具描述不参与 pairing。
3. structural execution refs 不参与 Provider-visible pairing。
4. preflight accepted 不自动等于 postflight accepted。
5. postflight blocked/rejected 禁止 publish/send。
6. validator 不自行合成 missing result。

### 7.21 Atomic publish

```ts
interface ReconstructionPublishAcknowledgement {
  publish_protocol_version: string;
  publish_ack_id: string;
  reconstruction_transaction_id: string;
  candidate_snapshot_id: string;
  restored_working_set_snapshot_id: string;
  previous_active_snapshot_id: string;
  target_context_snapshot_id: string;
  published_hash: string;
  committed_at: string;
}
```

规则：

1. publish 是 active working set pointer 的原子替换或等价语义。
2. publish 前旧 snapshot 保持可恢复。
3. 一项 required content 不得先于其他 required content 对 Provider 可见。
4. publish acknowledgement 写入失败时旧 snapshot 继续 active。
5. retry 使用相同 idempotency key，不重复插入消息。
6. publish 成功后旧 snapshot 进入 historical，不被静默删除。
7. publish 不改变 TurnOutcome。

### 7.22 Restored working set

```ts
interface RestoredWorkingSetSnapshot {
  restored_working_set_protocol_version: string;
  restored_working_set_snapshot_id: string;
  reconstruction_transaction_id: string;
  target_context_snapshot_id: string;
  bounded_memory_entrypoint_snapshot_ref: string | null;
  meta_context_message_refs: ReadonlyArray<string>;
  compact_summary_ref: string;
  current_user_message_ref: string;
  execution_state_refs: ReadonlyArray<string>;
  omission_manifest_ref: string;
  request_budget_snapshot_id: string;
  postflight_validation_ref: string;
  publish_ack_ref: string;
  restored_hash: string;
  created_at: string;
}
```

Snapshot 创建后不可变。

### 7.23 Recovery semantics

| Failure | Recovery |
|---|---|
| preflight blocked |等待真实 tool result 或显式 lifecycle decision，不 compact |
| preflight rejected |协议失败；保留原 snapshot |
| compactor failed/empty/hash mismatch |保留原 snapshot；可用新 attempt 重试 |
| required project reload failed | blocked；不发布半工作集 |
| optional Memory rebuild failed | degraded omission；可继续 postflight |
| current user changed |取消当前 attempt，捕获新 snapshot |
| candidate duplicate/conflict | rejected |
| postflight tool validation blocked/rejected |不 publish |
| request budget rejected |不 publish；不得静默删 required item |
| publish acknowledgement failed |旧 snapshot 继续 active |
| 进程在 publish 前退出 | 从 transaction 恢复或放弃，旧 snapshot active |
| 进程在 atomic pointer swap 后退出 | 依据 durable publish acknowledgement 恢复新 snapshot |

Recovery 不重新执行 completed tool call，不复用过期 permission，也不修改旧 transaction。

### 7.24 Idempotency

Idempotency key 至少绑定：

- session/turn；
- pre-compact snapshot；
- preflight validation；
- compaction method/version；
- reconstruction policy；
- target context；
- project version；
- active source identities；
- Memory rebuild identity；
- request budget；
- postflight validator policy。

相同 key 的重复请求必须：

- 返回同一已发布 snapshot；或
- 继续同一未完成 transaction 的安全恢复；
- 不能重复 reload、重复 Memory use、重复消息插入或重复 publish。

### 7.25 Observability boundary

GRC-1 可以产生 metadata-only event：

- transaction state transition；
- source resolution action/status；
- required/optional omission count；
- reconstruction latency；
- retry/recovery count；
- pre/postflight status；
- candidate/published hash refs；
- budget measurement。

默认禁止记录：

- Prompt body；
- current user正文；
- project instruction正文；
- Memory verified claim正文；
- compaction summary正文；
- tool result正文；
- credential 或完整 source path。

Telemetry/logging failure 不改变 reconstruction 或 TurnOutcome。Observability 不成为 M-049 D-edge。

### 7.26 Activation gate

M-049 运行时激活必须同时满足：

1. pre-compact transcript snapshot 不可变；
2. BRC-5 before-compaction validation 可用；
3. compactor 输出不可变 result/summary hash，且 result 通过 text-only shape validation；
4. current user identity 可精确保留；
5. ProjectInstructionActivation 与 MetaMessageLifecycleRecord 可关联；
6. preserve/reload/invalidate 有 runtime enforcement；
7. reload 走受信 pipeline 并产生新 acknowledgement；
8. FRC-1 可为 target context 重建 Memory entrypoint；
9. system Prompt 明确位于 reconstruction 之外；
10. working set 可分 plane 表达；
11. postflight tool validation 可用；
12. duplicate/order/budget validators 可用；
13. active working set 支持原子 publish/rollback；
14. transaction/idempotency/recovery 可持久化；
15. completed tool call 不会被 reconstruction 重新执行；
16. 关键路径具有 deterministic failure/recovery 验证。

任一门不满足时，不能用 summary Prompt 或自然语言 reminder 代替 enforcement。

## 8. Wave G 不变量

### INV-G1 — Reconstruction 不是 Transcript Restore

GRC-1 只重建当前工作集，不恢复完整 pre-compact transcript。

### INV-G2 — Preflight 先于 Compaction

tool transcript pairing 未 accepted 时不得执行 compaction。

### INV-G3 — Completed Tool 不重执行

Reconstruction、retry、resume 或 publish 都不能重新执行已完成 tool call。

### INV-G4 — Reload Marker 不等于 Reload

`reload_required` 只要求重载；只有受信 pipeline acknowledgement 可以证明重载完成。

### INV-G5 — Invalidated 不复活

`invalidated` source 不得因 summary、cache、旧 snapshot 或旧正文而重新进入 working set。

### INV-G6 — Current User 精确保留

Active current user message identity/hash 必须精确保留且只出现一次。

### INV-G7 — Meta 不计 User Turn

恢复后的 project instruction meta context 不增加 user turn count，也不冒充 current user。

### INV-G8 — Summary 是 Derived Context

Compaction summary 不继承 System Rule、Project Instruction、Tool Result、SecurityDecision 或 CompletionReport 的 Authority。

### INV-G9 — System Prompt 不属于 Reconstruction

旧 system Prompt string 不进入 Pinned Working Set；下一次请求由 BRC-1 独立编译，GRC-1 不消费或生成其 snapshot。

### INV-G10 — Memory 必须绑定 Target Context

旧 Memory entrypoint/use decision 不跨 post-compact target context 自动复用。

### INV-G11 — Plane 不混合

System、meta context、summary、current user 与 execution state 必须保持独立 plane。

### INV-G12 — Required 缺失不 Partial Publish

任一 required item 未解析时不得发布半工作集。

### INV-G13 — Optional 缺失显式降级

Optional item 可以省略，但必须进入 omission manifest，不能声称完整。

### INV-G14 — Publish 原子

Candidate 只有通过全部 postflight gate 后才能一次性替换 active working set。

### INV-G15 — 旧 Snapshot 可恢复

Publish acknowledgement durable 前，最后一个有效 pre-compact/active snapshot 必须保持可恢复。

### INV-G16 — Retry 幂等

相同 reconstruction input 的 retry 不重复 compaction、reload、rebuild、消息插入或 publish。

### INV-G17 — Failure 不提升状态

Summary、reload、rebuild、validation、budget、cache、logging 或 publish failure 不能产生 accepted、trusted、use、completed 或 published。

### INV-G18 — Failure 不改变 TurnOutcome

Reconstruction failure 只改变 reconstruction/session continuity 状态，不直接改写业务 TurnOutcome。

### INV-G19 — Cache/Observability 不拥有语义

Cache、telemetry 和日志不能决定 preserve、reload、rebuild、exclude、order 或 publish。

### INV-G20 — 不新增冻结 D-edge

M-049 只消费 M-008、M-013、M-038、M-070；全局不变量的适用不改变机制所有权。

## 9. 兼容与废止关系

| 当前语义 | Wave G 结论 |
|---|---|
| compact 后只保留一条 user summary |迁移为 summary plane + selective reconstruction |
| summary 冒充当前 user message |废止；current user 独立精确保留 |
| summary 表述 tool action 即视为 result |禁止；pairing 只认结构化 result |
| compact 前不检查 pending tool |废止；preflight accepted 是硬门 |
| 旧 project rule 原文直接拼回 | 只允许 fresh preserve 或受信 reload |
| reload marker 直接恢复正文 |禁止；marker 与 acknowledgement 分离 |
| invalidated source 仍从缓存出现 |禁止 |
| 旧 system Prompt string 保留 | 废止；system Prompt 在 reconstruction 外独立编译 |
| 旧 Memory entrypoint 原样恢复 | 废止；target-context FRC-1 rebuild |
| execution state 写进 summary |只保留 structural runtime refs |
| 逐条消息写入 active session | 迁移为 candidate + atomic publish |
| 失败后继续使用半工作集 | 禁止；required failure blocks |
| optional Memory 失败阻断任务 |显式 degraded omission，不改变 TurnOutcome |
| 日志用于恢复正文 | 禁止；日志不是恢复源 |

## 10. 最终 71 项覆盖审计契约

Wave G 冻结后，必须执行一次独立覆盖审计。该审计不新增机制设计，只验证冻结 Matrix 的 71 项均有明确处置。

### 10.1 计数口径

必须区分：

| 口径 | 定义 |
|---|---|
| Contract count | RC/BRC/CRC/DRC/ERC/FRC/GRC 数量 |
| Designed mechanism count | Wave A～G 元数据 `覆盖机制` 中唯一 M-ID 数量 |
| Deferred count | Matrix 中 Deferred，保留边界但未进入当前设计承诺 |
| Hold count | Matrix 中 Hold，等待 Evidence/Activation gate |
| Total mechanism count | M-001～M-071，共 71 |
| Invariant count | INV-A～INV-G 实际唯一编号数 |

不得用 Contract count 代替 mechanism count。

### 10.2 预期集合

按冻结 T2：

```text
Designed/Actionable: 49
Deferred:            14
Hold:                 8
Total:               71
```

Wave A～F 已设计 48 个唯一机制；Wave G/M-049 冻结后为 49。

### 10.3 审计要求

1. M-001～M-071 每项出现且只出现一次于最终处置表。
2. 49 个 designed/actionable 机制必须映射到一个主规格。
3. 14 个 Deferred 必须保留设计边界和未来触发条件。
4. 8 个 Hold 必须保留 Evidence/Activation gate。
5. Required Reuse 不得被误报为新实现。
6. Required Dependency 不得被误报为独立用户能力。
7. 同一机制的 Consumer 引用不能产生第二 Owner。
8. 跨 Wave handoff 必须闭合。
9. 不得因分数、Wave 或 contract 数量改变冻结 Matrix 分类。
10. 审计结果必须列出实际机制 ID，而不只给汇总数字。

### 10.4 不变量计数

Wave A～F 的实际不变量数为：

```text
INV-A1～A8   = 8
INV-B1～B13  = 13
INV-C1～C15  = 15
INV-D1～D18  = 18
INV-E1～E20  = 20
INV-F1～F16  = 16
合计         = 90
```

Wave G 若按本文冻结 `INV-G1～G20`，全线不变量总数为 110。

此计数只表示规格级不变量数量，不等于测试数量或实现任务数量。

## 11. 防御边界

| 高频失败 | GRC-1 防护原则 |
|---|---|
| pending tool 时 compact | preflight pairing gate |
| summary 冒充 tool result | summary 永不参与 pairing |
| completed tool 被重执行 | structural acknowledgement + idempotency |
| 恢复完整 transcript | selective working set only |
| reload marker 当成正文 | marker/acknowledgement 分离 |
| stale project rule 被 preserve | freshness/project/hash gate |
| invalidated source 被缓存复活 | exclude + postflight scan |
| 旧 Prompt string 被恢复 | system Prompt 在 reconstruction 外独立编译 |
| 旧 Memory use permission 被复用 | target-context FRC-1 rebuild |
| current user 丢失或重复 | required_exact + duplicate gate |
| meta 被计作 user turn | plane/role invariant |
| execution state 泄入 Prompt | structural-only plane |
| required item 缺失仍 publish | block |
| optional item 缺失无记录 | omission manifest |
| budget 静默删 required item | block/reject |
| 半工作集逐步可见 | atomic publish |
| publish 失败覆盖旧 snapshot | durable acknowledgement 前旧 snapshot active |
| retry 重复 reload/publish | idempotency key |
| telemetry/log 恢复正文 | observability 非恢复源 |

## 12. 规格级验收矩阵

### Preflight

1. Pre-compact snapshot 不可变。
2. before-compaction tool validation 必须 accepted。
3. pending/missing/orphan/duplicate/conflict 均阻止 compaction。
4. current user identity/hash 可验证。
5. compaction 前有 durable recovery point。

### Compaction Result

1. Summary 绑定 source transcript 和 preflight validation。
2. Summary 有 content hash 与 method identity。
3. Summary 通过 text-only shape validation，且该校验不接管 M-031。
4. Summary 不继承高 Authority。
5. Summary 不替代 user/rule/Memory/result。
6. 失败保留原 snapshot。

### Project Instruction

1. preserve 同时要求 freshness/project/hash/activation 有效。
2. reload_required 走受信 pipeline。
3. reload marker 不等于 acknowledgement。
4. invalidated source 被排除。
5. required reload failure blocks。
6. meta 不增加 user turn。

### Memory

1. 旧 entrypoint 只提供 rebuild identity。
2. 旧 use decision 不跨 target context。
3. 新的 Memory section 来自 FRC-1。
4. GRC-1 不 full-load Memory。
5. empty/rejected/unavailable 有确定性 omission。
6. Memory failure 不改变 Outcome。

### Working Set

1. System/meta/summary/user/execution state 分 plane。
2. 旧 system Prompt string 不恢复，且 GRC-1 不消费 BRC-1 snapshot。
3. current user exact 且只出现一次。
4. summary 只出现一次。
5. execution state 不进入 Provider-visible正文。
6. ordering 可确定重放。
7. duplicate/ordinal conflict 被拒绝。

### Postflight and Publish

1. candidate 尚不可发送。
2. postflight pairing accepted。
3. required source 全 resolved。
4. budget/duplicate/order/identity validators accepted。
5. omission manifest 与实际一致。
6. publish 原子。
7. acknowledgement durable 前旧 snapshot 可恢复。
8. retry 不重复 publish。

### Recovery

1. 每个失败状态有确定性恢复路径。
2. failure 不伪造 tool result。
3. failure 不复用 stale permission/use。
4. failure 不产生半工作集。
5. process exit 边界可由 transaction/ack 恢复。
6. failure 不改变 TurnOutcome。

### Final Coverage

1. Contract count 与 mechanism count 分离。
2. Wave A～G designed/actionable 预期为 49。
3. Deferred=14、Hold=8。
4. 49+14+8=71。
5. 处置表列出 M-001～M-071。
6. INV-A～F 为 90；本文冻结后 INV-A～G 为 110。

### Cross-Contract

1. INV-G1～INV-G20 无冲突。
2. M-049 唯一映射到 GRC-1。
3. 只消费 M-008/M-013/M-038/M-070。
4. 不反向修改上游 contract。
5. 未选择 Prompt 原文或进入实现任务。

## 13. 设计完成标准

Wave G 只有在以下条件全部满足后才能冻结：

1. M-049 唯一映射到 GRC-1。
2. 四个冻结 D 前置全部被消费且无新增 D-edge。
3. preflight pairing 是 compaction 硬门。
4. completed tool 不重新执行。
5. Pinned Working Set item/requirement/plane 封闭。
6. current user 精确保留且不重复。
7. project instruction preserve/reload/invalidate 完整。
8. reload marker 与 acknowledgement 分离。
9. invalidated source 不复活。
10. 旧 system Prompt string 不恢复，BRC-1 不成为 M-049 D 前置。
11. Memory 为 target-context FRC-1 rebuild。
12. summary Authority 明确且不替代结构化协议。
13. execution state 仅 structural。
14. candidate/postflight/publish 三阶段分离。
15. required failure block、optional failure 显式 degraded。
16. publish 原子且旧 snapshot 可恢复。
17. retry 幂等。
18. INV-G1～INV-G20 可结构化验证。
19. 最终 71 项覆盖审计口径明确。
20. 未选择、改写或嵌入 Claude Prompt 原文。
21. 未进入生产代码、实施文件、工期或 Git 操作。

## 14. 后续流程

本文审核冻结后：

1. 执行 M-001～M-071 最终覆盖审计。
2. 确认 49 个 designed/actionable、14 个 Deferred、8 个 Hold 全部有处置。
3. 确认 Wave A～G handoff 闭合且无新增冻结 DAG D-edge。
4. 记录 Deferred/Hold 的未来 activation/evidence gate，但不提前设计或实施。
5. 全部设计冻结且覆盖审计通过后，使用 writing-plans 编写详细实施计划。
6. 实施计划必须以冻结 contract、DAG、Phase Owner 和 Wave 顺序为依据。
7. Prompt Library Import 继续作为独立 vendor 资产快照；其存在不等于任何 Prompt candidate 已 approved 或 activated。
