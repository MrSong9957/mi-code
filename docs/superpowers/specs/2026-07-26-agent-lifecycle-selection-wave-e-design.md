# mi-code Agent Lifecycle & Selection Contracts — Wave E

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix、Wave A～D Contracts
> 覆盖机制：M-038、M-045、M-046、M-052、M-065
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave E 冻结四个 Lifecycle & Selection Root Contract：

| Wave E Root Contract | 机制 | 机制 Owner |
|---|---|---|
| ERC-1 Meta Context Lifecycle | M-038 | Phase 4 |
| ERC-2 Memory Persistence & Retrieval | M-045、M-046 | Phase 2 |
| ERC-3 Buffered Local Diagnostics | M-052 | Phase 6 |
| ERC-4 Executable Environment Defense | M-065 | Phase 5 |

`1 + 2 + 1 + 1 = 5`，五个 Wave E 机制全部归入且仅归入一个主 ERC。

M-045 与 M-046 在 ERC-2 内是并列子协议。二者共享 Memory catalog identity 和一致性规则，但冻结 DAG 中没有 `M-045 → M-046` 或 `M-046 → M-045` 的 D-edge。

## 2. 设计目标

Wave E 必须定义：

1. meta context 如何持久化、序列化、压缩和失效。
2. meta message 为什么不计作用户轮次，也不自动获得更高 Authority。
3. M-038 与 M-049 的 retention/reconstruction 边界。
4. admitted Memory 如何以两阶段事务写入 detail 与 bounded index。
5. detail 成功但 index 失败时如何避免半完成 Memory 可见。
6. Memory selector 如何只返回候选引用，而不判定事实正确。
7. M-046 为什么不以 M-045 为设计前置。
8. 已清洗 telemetry event 如何进入有界、非阻塞本地 buffer。
9. dropped event 为什么不能保留原始 payload 以待重试。
10. inline environment assignment 与 inherited environment 如何组合。
11. executable identity 如何绑定 action snapshot，并在 spawn 前复核。
12. `SanitizedExecutionPlan` 为什么不授予执行权限。
13. M-013 作为唯一 Wave F 节点可以消费什么、不能假设什么。
14. M-038 如何保留给 Wave G M-049，而不人为接入 Wave F。

## 3. 明确排除

本文不设计或实施：

- post-compact Pinned Working Set 重建；
- compaction 触发频率或摘要算法；
- MEMORY.md 最终行数、字节或 token 阈值；
- Memory topic 命名、目录布局、全文检索引擎或向量数据库；
- Memory relevance 模型、embedding 或 reranker；
- production telemetry、远程上传或 full request dump；
- debug 日志 UI、导出格式或跨机器同步；
- NTFS ADS、8.3 路径、长路径前缀等 M-068 Hold 范围；
- shell AST policy、Plan Mode allowlist 或 inherited environment scrub；
- 具体 loader/PATH 变量全集、parser/runtime 库选型或平台测试文件；
- Prompt 原文选择、改写、评测、批准或嵌入；
- 实现类、文件布局、测试任务、数据迁移、工期和 Git 操作。

这些能力属于 Wave F/G、Hold 解除后或详细实施计划。

## 4. 现状与复用边界

### 4.1 可复用上游

| 冻结或现有能力 | Wave E 复用方式 |
|---|---|
| RC-2 Semantic Request Boundary | 复用 meta_context Placement，不重新定义 Authority |
| BRC-3 Context Intake/Source Guard | 复用 bounded source、provenance 和 overflow metadata |
| CRC-6 Telemetry Safety | 复用字段 allowlist、PII label 和 redaction/drop |
| DRC-2 MetaContextActivation | ERC-1 的唯一 meta activation 输入 |
| DRC-2 MemoryAdmissionDecision | ERC-2 persistence 的准入输入 |
| DRC-2 MemoryUseDecision | ERC-2 retrieval 后的唯一 use gate |
| DRC-4 ComponentTelemetryEvent/Batch | ERC-3 的唯一 payload 输入 |
| DRC-5 CommandParseResult | ERC-4 的 inline assignment/executable syntax 输入 |
| M-063 inherited environment scrub | ERC-4 的基础环境输入 |
| 现有 MemoryManager | ERC-2 优先复用其 index/detail 能力，不建立第二套存储 |
| 现有 debug/task logs | ERC-3 复用本地日志基础，不引入第二个观测平面 |

### 4.2 已确认缺口

- message model 没有 meta retention/serializer/compactor 契约。
- Memory index/detail 能力没有接入 admission 与 use verification。
- Memory keyword selection 没有进入主请求链路。
- section 级 telemetry 没有有界异步本地日志。
- inline environment assignment、binary identity 与 PATH/loader hijack 没有统一防线。

### 4.3 Wheel Reuse Check

Wave E 必须：

- 在现有 message/session serialization 上增加最小 meta metadata 支持，不建立第二套 conversation；
- 复用 MemoryManager 的现有 index/detail 结构，新增事务和协议边界；
- 复用现有日志 sink/目录规则，新增 sanitized buffer contract；
- 复用 M-063、M-064 和 RC-5，不建立新的 shell permission 系统；
- 复用平台 path/executable resolver 能力；无法证明安全时 fail closed，不自行实现未要求的完整 shell。

### 4.4 冻结 D-edge 对照

| Wave E 机制 | 冻结 D 前置 | 本文消费位置 |
|---|---|---|
| M-038 | M-008 | DRC-2 `MetaContextActivation` |
| M-045 | M-044 | DRC-2 `MemoryAdmissionDecision` |
| M-046 | M-043、M-044 | CRC-3 typed metadata、DRC-2 admission/use gate |
| M-052 | M-051、M-055 | BRC-7 observability plane、DRC-4 sanitized telemetry |
| M-065 | M-063、M-064 | inherited env scrub、DRC-5 command syntax facts |

该表只复述冻结矩阵。M-045 与 M-046 不互为设计前置；M-038、M-052、M-065 也不因同属 Wave E 而形成依赖。

## 5. 跨契约数据流

```text
DRC-2 MetaContextActivation
        │
        ▼
ERC-1 MetaRetentionDecision
        │
        ├─ Session serializer record
        ├─ Compressor preservation directive
        └─ Reload-required marker ───────► future M-049

DRC-2 MemoryAdmissionDecision(admit)
        │
        ▼
ERC-2 MemoryPersistenceTransaction
        │ detail committed
        ▼
MemoryCatalogSnapshot
        │
        ▼
ERC-2 MemorySelectionResult
        │ selected refs
        ▼
Detail retrieval
        │
        ▼
DRC-2 MemoryUseDecision

DRC-4 sanitized telemetry batch
        │
        ▼
ERC-3 bounded local buffer
        │
        ▼
Local diagnostic sink

M-063 scrubbed inherited environment
  + DRC-5 executable/env syntax facts
        │
        ▼
ERC-4 InlineEnvironmentDecision
  + ExecutableResolutionResult
        │
        ▼
SanitizedExecutionPlan
        │
        ▼
RC-5 permission gate / process spawn
```

ERC-3 只消费已经通过 CRC-6/DRC-4 的事件。ERC-4 只产生可供 RC-5 再判定的执行计划，不能自行触发进程。

## 6. 共同生命周期词汇

### 6.1 Contract identity

```ts
interface LifecycleContractRef {
  contract_id: string;
  contract_version: string;
}

interface LifecycleSnapshotSet {
  session_snapshot_id: string | null;
  request_snapshot_id: string | null;
  action_snapshot_id: string | null;
  input_snapshot_ids: string[];
  captured_at: string;
}
```

每个 ERC 只使用与自身相关的 snapshot 字段。不同 snapshot 不能通过空值或相同字符串假装等价。

### 6.2 状态转换原则

1. 状态只能沿协议声明的边迁移。
2. 终态不能被日志、重试或下游 consumer 反向改写。
3. 配置、source、catalog、session、buffer 或 executable identity 变化形成新 snapshot。
4. failure 不能升级为 retained、completed、selected、flushed、safe 或 allowed。
5. 解释性文本不是状态转换事件。

### 6.3 Side-effect acknowledgement

发生持久化或本地写入的 ERC 必须区分：

- decision 已产生；
- side effect 已提交；
- side effect 仅部分提交；
- side effect 失败；
- recovery 是否需要。

不得用“函数返回成功”代替 durable acknowledgement。

### 6.4 Outcome independence

Memory persistence、debug logging 和 retention metadata 写入失败不改变已有 TurnOutcome。Executable defense 属于执行前安全门，其失败阻止执行，但不能把失败包装为 completed。

## 7. ERC-1 — Meta Context Lifecycle

### 7.1 目标

为 DRC-2 `MetaContextActivation` 定义独立 retention、serializer 和 compressor 语义，使项目规则不会被当作普通 conversation 静默裁剪，也不会被误认为当前用户输入。

ERC-1 不执行 post-compact reconstruction；该能力属于 M-049。

### 7.2 Retention policy

```ts
type MetaRetentionAction =
  | 'preserve'
  | 'mark_reload_required'
  | 'invalidate';

interface MetaRetentionPolicy {
  retention_policy_id: string;
  retention_policy_version: string;
  source_classes: string[];
  max_age_ms: number | null;
  preserve_across_serialization: boolean;
  preserve_across_compaction: boolean;
  reload_when_stale: boolean;
}
```

Policy 必须来自受信 runtime/configuration。Prompt、source content 或 Agent 不能自行声明永久保留。

### 7.3 Retention decision

```ts
interface MetaRetentionDecision {
  retention_protocol_version: string;
  retention_decision_id: string;
  session_snapshot_id: string;
  message_id: string;
  activation_id: string;
  source_context_id: string;
  policy_ref: LifecycleContractRef;
  action: MetaRetentionAction;
  authority: string;
  trust: string;
  freshness_ref: string;
  provenance_refs: string[];
  reason_codes: string[];
}
```

Retention action 不改变 `authority` 或 `trust`，只决定生命周期。

### 7.4 Lifecycle record

```ts
type MetaLifecycleState =
  | 'resident'
  | 'serialized'
  | 'reload_required'
  | 'invalidated';

interface MetaMessageLifecycleRecord {
  meta_lifecycle_protocol_version: string;
  lifecycle_record_id: string;
  session_snapshot_id: string;
  message_id: string;
  retention_decision_id: string;
  state: MetaLifecycleState;
  serializer_snapshot_id: string;
  compressor_snapshot_id: string;
  last_transition_event_id: string;
  content_hash: string;
  reason_codes: string[];
}
```

`reload_required` 只登记缺口，不读取 source、不注入消息，也不宣称 M-049 已完成。

### 7.5 Serializer contract

Serializer 至少保留：

- `message_id`；
- `is_meta=true`；
- Placement；
- source/activation/retention identity；
- Authority、Trust；
- provenance/freshness refs；
- stable ordinal；
- content hash；
- lifecycle state。

规则：

1. meta message 不增加 user turn count。
2. resume 后不得把 meta message 转成普通 conversation。
3. serializer round-trip 必须保持 identity、ordinal 和 content hash。
4. unknown metadata/version 不能静默降级为普通 user message。
5. session snapshot 变化产生新 lifecycle record，不修改旧记录。
6. source 已 invalidated 时不得仅因序列化记录存在而恢复正文。

### 7.6 Compressor contract

1. 普通 history eviction 不得删除 `preserve` 的 meta message。
2. `mark_reload_required` 可以从压缩输出省略正文，但必须保留重载 marker、source identity 和 provenance。
3. `invalidate` 必须保留 reason，不静默消失。
4. compressor 不提升 Authority，不修改 source content。
5. tool-use/result pairing 和当前用户 Pinned Working Set 继续服从既有不变量。
6. compressor 不自行重新读取 project files。
7. 压缩输出必须能区分 resident、reload_required 和 invalidated。

### 7.7 Activation gate

M-038 运行时激活必须同时满足：

- message model 支持 `is_meta` 和 lifecycle identity；
- session serializer round-trip 保留 metadata；
- compressor 能执行 preserve/reload-required/invalidate；
- resume/compaction 不增加 user turn count；
- unknown metadata fail closed；
- M-008 activation 与 M-038 retention 绑定相同 message/source identity。

任一门未满足时，不能通过 Prompt 警告代替 lifecycle enforcement。

### 7.8 错误语义

- activation/retention identity 不匹配：invalid。
- serializer 丢失 `is_meta`：session snapshot 不可恢复。
- compressor 不识别 retention action：禁止 compaction。
- source freshness 不可验证：mark_reload_required 或 invalidate，不继续 preserve 旧内容。
- content hash mismatch：invalidate。
- unknown policy/version：不持久化为普通 conversation。
- lifecycle metadata 写入失败：报告 session persistence failure，不改变 TurnOutcome。

### 7.9 Wave F 与后续 handoff

ERC-1/M-038 没有 Wave F 直接 D-edge。

Wave F 不能为了统一入口让 M-013 依赖 meta retention。

Wave G M-049 可以获得：

- `MetaMessageLifecycleRecord`；
- preserve/reload_required/invalidated 状态；
- source、message、provenance 和 freshness identity；
- compressor/serializer acknowledgement；
- content hash 与 stable ordinal。

M-049 不能假设：

- reload_required 已完成 source reload；
- retained meta 是当前有效规则；
- meta 提升 Authority；
- M-013 Memory entrypoint 可以替代 project-rule reload。

## 8. ERC-2 — Memory Persistence & Retrieval

### 8.1 目标

ERC-2 冻结两个并列子协议：

1. M-045 Two-Step Memory Persistence
2. M-046 Memory Search Guidance

二者共享 catalog identity 和 entry schema，但不互为设计前置。M-046 可以消费现有 MemoryManager 或任何符合本契约的 catalog snapshot。

### 8.2 Memory record identity

```ts
interface DurableMemoryRecord {
  memory_record_protocol_version: string;
  memory_record_id: string;
  record_version: string;
  admission_decision_id: string;
  memory_type: AutoMemoryType;
  scope_ref: string;
  detail_content_ref: string;
  detail_content_hash: string;
  evidence_refs: string[];
  confidence: number;
  observed_at: string;
  expires_at: string | null;
  invalidation_conditions: string[];
  provenance_refs: string[];
}
```

只有 `MemoryAdmissionDecision(status='admit')` 可以产生 durable record。Record 不改变原 candidate/admission identity。

### 8.3 Persistence transaction

```ts
type MemoryPersistenceState =
  | 'prepared'
  | 'detail_committed'
  | 'index_committed'
  | 'completed'
  | 'failed'
  | 'recovery_required';

interface MemoryPersistenceTransaction {
  persistence_protocol_version: string;
  transaction_id: string;
  idempotency_key: string;
  admission_decision_id: string;
  memory_record_id: string;
  expected_record_version: string | null;
  catalog_snapshot_id: string;
  state: MemoryPersistenceState;
  detail_commit_ref: string | null;
  index_commit_ref: string | null;
  recovery_ref: string | null;
  reason_codes: string[];
}
```

允许的成功路径：

```text
prepared
  → detail_committed
  → index_committed
  → completed
```

`failed/recovery_required` 不能直接跳到 completed；重试必须使用同一 idempotency key 或显式创建新 transaction。

### 8.4 Detail commit

1. detail content 必须绑定 admitted type/scope/evidence。
2. commit 前验证 content hash。
3. 更新既有 record 必须携带 expected version，禁止 lost update。
4. detail commit 后、index commit 前，record 处于不可发现状态。
5. 不可发现 detail 不进入 selector 或 bounded entrypoint。
6. 同一 idempotency key 重试不得创建重复 record。
7. detail 写入失败使 transaction failed。
8. writer 不得把 Project Instruction、credential 或 deferred candidate 写入 detail。

### 8.5 Index entry

```ts
interface MemoryCatalogEntry {
  memory_record_id: string;
  record_version: string;
  admission_decision_id: string;
  durability_evidence_ref: string;
  memory_type: AutoMemoryType;
  scope_ref: string;
  topic_keys: string[];
  keyword_keys: string[];
  observed_at: string;
  expires_at: string | null;
  provenance_refs: string[];
  detail_content_hash: string;
}
```

Index entry 禁止包含：

- 完整 claim/body；
- credential；
- 完整 evidence body；
- user conversation transcript；
- Prompt/project instruction 正文。

Index 只提供导航、过滤和完整性校验所需 metadata。

### 8.6 Catalog snapshot

```ts
interface MemoryCatalogSnapshot {
  memory_catalog_protocol_version: string;
  catalog_snapshot_id: string;
  source_kind:
    | 'existing_memory_manager'
    | 'two_step_persistence';
  entry_order: string[];
  entries: Readonly<Record<string, MemoryCatalogEntry>>;
  catalog_hash: string;
  budget_policy_ref: string;
  overflow_state:
    | 'within_budget'
    | 'update_rejected'
    | 'rebuild_required';
}
```

Catalog snapshot 创建后不可变。M-046 不根据 `source_kind` 改变 Trust 或 selection 权限。

`existing_memory_manager` 只表示复用存储实现，不表示历史条目已 admitted。进入 governed catalog 的既有条目必须有确定性兼容校验产生的 admission 与 durability evidence；未分类旧数据保留在 governed snapshot 之外，不静默提升状态。

### 8.7 Index commit

1. index commit 必须引用已经 durable acknowledged 的 detail record。
2. commit 必须是原子的 catalog snapshot replacement 或等价语义。
3. catalog budget 超限不得静默截断既有 entry。
4. 无法在预算内安全更新时使用 `update_rejected/rebuild_required`。
5. index commit 失败时 detail 保持不可发现，并产生 recovery record。
6. recovery 只能完成/回滚该 transaction，不能修改 TurnOutcome。
7. completed 只在 detail/index identity、version、hash 全部一致后产生。
8. catalog order 必须确定且可重放。
9. existing-store durability evidence 与新 transaction acknowledgement 使用不同 evidence kind，不能伪装成同一事务来源。

### 8.8 Search query

```ts
interface MemorySearchQuery {
  memory_search_protocol_version: string;
  query_id: string;
  task_snapshot_id: string;
  catalog_snapshot_id: string;
  scope_refs: string[];
  allowed_memory_types: AutoMemoryType[];
  topic_terms: string[];
  keyword_terms: string[];
  max_selected_entries: number;
  max_index_metadata_bytes: number;
}
```

Query 由任务的结构化语义和受控关键词构造；不把整个 user conversation 复制进 index search。

### 8.9 Selection result

```ts
interface MemorySelectionResult {
  memory_selection_protocol_version: string;
  selection_id: string;
  query_id: string;
  task_snapshot_id: string;
  catalog_snapshot_id: string;
  selected_entries: ReadonlyArray<{
    memory_record_id: string;
    record_version: string;
    selection_rank: number;
    matched_key_refs: string[];
    reason_codes: string[];
  }>;
  excluded_entries: ReadonlyArray<{
    memory_record_id: string;
    reason_code: string;
  }>;
  budget_used: {
    selected_entries: number;
    index_metadata_bytes: number;
  };
  overflowed: boolean;
}
```

Selection rank 只表达本次 query 的导航顺序，不表达 confidence、Truth、Authority 或 use eligibility。

### 8.10 Selection rules

1. selector 只读取 catalog metadata，不全量读取 detail 后再筛选。
2. scope/type 先过滤，topic/keyword 后匹配。
3. 相同 query/catalog snapshot 必须产生相同顺序。
4. tie 必须使用确定性 record identity/order 规则。
5. budget 达到上限后显式 `overflowed=true`，不声称结果完整。
6. expired entry 可以被选择为 refresh candidate，但不能直接 use。
7. index entry 指向缺失 detail 时产生 integrity diagnostic。
8. selector 不修改 catalog、record、confidence 或 admission。
9. selection result 默认是 untrusted references。
10. detail retrieval 后必须调用 DRC-2 `MemoryUseDecision`。
11. `needs_refresh/do_not_use` claim 不进入 Prompt 或行为依据。
12. search failure 不回退为“加载全部 Memory”。

### 8.11 Sibling contract boundary

1. M-045 与 M-046 共享 `MemoryCatalogSnapshot` schema。
2. M-046 不要求 source_kind 是 two-step persistence。
3. 现有 MemoryManager 只要产生合法 snapshot 就可独立启用 selection。
4. M-045 不调用 selector 来决定是否提交 admitted record。
5. M-046 不调用 persistence 来修复 missing detail/index。
6. catalog repair 是独立维护流程，不在 query 路径隐式发生。
7. 二者归并不增加冻结 D-edge。

### 8.12 状态不变量

```text
admitted
  ≠ detail_committed
  ≠ index_committed
  ≠ persisted(completed)
  ≠ selected
  ≠ retrieved
  ≠ use
```

任何下游不得根据前一状态推断后一状态。

### 8.13 错误语义

- admission 非 admit：拒绝创建 transaction。
- record hash/version mismatch：failed。
- detail 成功、index 失败：recovery_required，record 不可发现。
- catalog budget 超限：update_rejected/rebuild_required，不静默截断。
- duplicate idempotency key 且内容不同：conflict。
- stale catalog query：拒绝或使用已捕获 snapshot，不混入新 entry。
- query budget 非法：selection invalid。
- missing detail：排除并记录 integrity diagnostic。
- MemoryUseDecision 不可用：selected detail 不进入 Prompt。
- persistence/search failure：不改变 TurnOutcome。

### 8.14 Wave F handoff

Wave F M-013 可以获得：

- immutable `MemoryCatalogSnapshot`；
- completed persistence transaction identity，或经确定性兼容校验的 existing-store durability evidence；
- bounded index entry schema；
- deterministic `MemorySelectionResult`；
- 显式 selection budget/overflow；
- detail provenance/hash；
- retrieval 后必须调用 MemoryUseDecision 的 gate。

M-013 不能假设：

- index entry 包含完整 Memory；
- admit/detail commit/index commit/selected 等于 use；
- selector 结果已 trusted；
- catalog 可以无限增长；
- overflow 可以静默忽略；
- M-013 可以把所有 detail 注入请求。

## 9. ERC-3 — Buffered Local Diagnostics

### 9.1 目标

把 DRC-4 已清洗、允许进入本地 debug plane 的事件写入有界、非阻塞 buffer，并按确定性 flush/rotation/retention policy 输出到本地诊断文件。

ERC-3 不重建 dropped payload、不启用 full dump，也不把日志当作完整请求复现。

### 9.2 Logging policy

```ts
type LocalDebugLevel =
  | 'error'
  | 'warn'
  | 'info'
  | 'debug'
  | 'trace';

interface LocalDebugLoggingPolicy {
  logging_policy_id: string;
  logging_policy_version: string;
  enabled: boolean;
  minimum_level: LocalDebugLevel;
  max_buffer_events: number;
  max_buffer_bytes: number;
  max_file_bytes: number;
  max_files: number;
  retention_ms: number;
  overflow_behavior: 'drop_newest';
  sink_location_ref: string;
}
```

Policy 来自受信本地配置。用户内容、Prompt 或模型不能修改 sink path、retention 或启用 full dump。

### 9.3 Buffered event

```ts
interface BufferedDiagnosticEvent {
  buffered_event_protocol_version: string;
  buffered_event_id: string;
  source_event_id: string;
  source_batch_id: string;
  session_id: string;
  request_snapshot_id: string | null;
  component_ref: string | null;
  level: LocalDebugLevel;
  sanitized_payload_ref: string;
  redaction_result_ref: string;
  byte_count: number;
  enqueued_at: string;
}
```

只有 DRC-4/CRC-6 已确认可保留的 `sanitized_payload_ref` 可以入队。原始 payload 不得成为隐藏字段。

### 9.4 Buffer state

```ts
interface DiagnosticBufferState {
  buffer_protocol_version: string;
  buffer_id: string;
  policy_ref: LifecycleContractRef;
  queued_event_count: number;
  queued_bytes: number;
  dropped_event_count: number;
  last_flush_at: string | null;
  last_flush_result_ref: string | null;
  state:
    | 'disabled'
    | 'accepting'
    | 'flushing'
    | 'degraded'
    | 'closed';
}
```

Buffer state 是观测状态，不改变 session/turn 状态。

### 9.5 Enqueue rules

1. policy disabled 时不构造本地 buffer payload。
2. event 未通过 redaction/drop gate 时拒绝入队。
3. event level 低于 minimum level 时丢弃 sanitized event，不读取原文。
4. event/count/bytes 超限时执行固定 `drop_newest`。
5. overflow 只增加最小 drop counter，不把 dropped payload 写入旁路。
6. enqueue 不等待磁盘 I/O。
7. queue order 使用 event timestamp + event ID 的确定顺序。
8. duplicate source event ID 不重复写入。
9. buffer 不接收 Prompt body、tool body、credential 或 dropped event 原文。
10. buffer failure 不阻塞 streaming loop。

### 9.6 Flush result

```ts
interface DiagnosticFlushResult {
  flush_protocol_version: string;
  flush_id: string;
  buffer_id: string;
  sink_snapshot_id: string;
  attempted_event_ids: string[];
  committed_event_ids: string[];
  failed_event_ids: string[];
  dropped_event_count_since_last_flush: number;
  status:
    | 'completed'
    | 'partial'
    | 'failed';
  reason_codes: string[];
}
```

只有 durable acknowledged 的 event 可以从 buffer 移除。Partial flush 保留未确认的 sanitized event，但不得恢复原始 payload。

### 9.7 Flush、rotation 与 shutdown

1. flush trigger 可以基于受信 policy 的 count/bytes/time/session-end。
2. 周期 flush 不能在 streaming loop 内同步阻塞。
3. rotation 在写入前验证目标 sink identity。
4. sink path 必须位于受信本地日志边界，拒绝 symlink/path escape。
5. retention 到期删除的是已清洗日志文件，不接触业务数据。
6. session 正常结束时发起有界 flush。
7. 进程异常终止允许丢失未 flush sanitized event；不能因此宣称业务失败。
8. shutdown 超出有界时间时记录 drop count 后结束，不无限等待。
9. sink 不可用时进入 degraded，后续行为按 policy retry sanitized events 或 drop。
10. 不得把未清洗 payload 写入临时文件等待 sink 恢复。

### 9.8 Log interpretation boundary

日志可以证明：

- 哪些已清洗事件被 enqueue/flush；
- component/request/session correlation；
- event 时序和 drop/partial 状态；
- measurement source 与 protocol version。

日志不能单独证明：

- 完整最终请求可复现；
- dropped field 的原值；
- 模型实际看到的所有 Provider-specific serialization；
- 业务执行成功；
- SecurityDecision 正确；
- 没有记录就代表事件没有发生。

### 9.9 错误语义

- policy/sink location 不可信：disabled。
- redaction result 缺失：drop event。
- buffer capacity 非法：disabled。
- event 超限：drop_newest + counter。
- sink path escape/symlink mismatch：flush failed。
- partial durable write：只确认 committed IDs。
- rotation 失败：degraded，不覆盖旧文件。
- shutdown flush 超时：drop remaining sanitized events，不改变 Outcome。
- logger 内部异常：最小本地计数；不递归记录完整异常 payload。

### 9.10 Wave F handoff

ERC-3/M-052 没有 Wave F 直接 D-edge。

Wave F 不能：

- 让 M-013 依赖 debug buffer；
- 通过日志恢复 Memory body；
- 把 local diagnostic retention 当作 Memory retention；
- 因 logging 不可用阻止 bounded Memory entrypoint。

## 10. ERC-4 — Executable Environment Defense

### 10.1 目标

把 M-063 已清洗的继承环境与 DRC-5 提取的 executable/inline-assignment 语法事实组合为可审计的 `SanitizedExecutionPlan`，防止 loader、PATH 或 binary replacement 绕过已允许命令。

ERC-4 不授予执行权限，不替代 AST、Plan allowlist、argument/path policy 或 RC-5。

### 10.2 Platform policy

```ts
type ExecutionPlatform =
  | 'windows'
  | 'linux'
  | 'macos';

interface ExecutableEnvironmentPolicy {
  policy_id: string;
  policy_version: string;
  platform: ExecutionPlatform;
  shell_dialect: string;
  safe_assignment_names: string[];
  controlled_assignment_names: string[];
  denied_assignment_names: string[];
  executable_search_policy_ref: string;
  identity_revalidation_policy_ref: string;
}
```

平台 policy 必须独立版本化。Unix loader 变量、Windows PATH/PATHEXT/COMSPEC 语义或 macOS loader 规则不能跨平台自动套用。

### 10.3 Inline assignment record

```ts
type InlineEnvironmentRisk =
  | 'safe_passthrough'
  | 'controlled_override'
  | 'path_resolution_affecting'
  | 'loader_injection'
  | 'unknown';

interface InlineEnvironmentAssignment {
  assignment_id: string;
  name: string;
  value_ref: string;
  value_hash: string;
  source_range_ref: string;
  risk: InlineEnvironmentRisk;
}
```

`value_ref` 是受控引用。日志、diagnostic 和 SecurityDecision 不默认复制实际 secret/value。

### 10.4 Inline environment decision

```ts
type InlineEnvironmentAction =
  | 'preserve'
  | 'strip'
  | 'ask'
  | 'deny';

interface InlineEnvironmentDecision {
  inline_environment_protocol_version: string;
  decision_id: string;
  action_snapshot_id: string;
  assignment_id: string;
  policy_ref: LifecycleContractRef;
  risk: InlineEnvironmentRisk;
  action: InlineEnvironmentAction;
  reason_codes: string[];
}
```

规则：

1. safe passthrough 可以 preserve。
2. controlled override 只能按精确变量 policy preserve/strip/ask。
3. path-resolution-affecting 必须在 executable resolution 前明确处理。
4. loader injection 必须按受信风险/control-mode policy 进入 ask 或 deny；Plan Mode、ask 不可用或来源不明时 deny，不能静默 preserve/strip。
5. unknown 不默认 preserve。
6. strip 必须进入结构化 diff；不能静默改变命令。
7. 只有 policy 明确声明“移除该变量后仍允许执行受限等价动作”时才能 strip；否则 ask/deny。
8. Agent 不能自行判断 strip 前后等价。
9. Agent/Prompt 不能把变量加入 safe list。

### 10.5 Executable resolution input

```ts
interface ExecutableResolutionInput {
  resolution_protocol_version: string;
  action_snapshot_id: string;
  command_parse_result_id: string;
  executable_candidate_ref: string;
  scrubbed_inherited_environment_snapshot_id: string;
  inline_environment_decision_ids: string[];
  working_directory_snapshot_id: string;
  platform_policy_ref: string;
}
```

Resolution 使用应用 inline decision 后的 effective environment，不使用被 deny/strip 的 PATH/loader assignment。

### 10.6 Executable identity

```ts
interface ExecutableIdentity {
  executable_identity_protocol_version: string;
  identity_id: string;
  platform: ExecutionPlatform;
  canonical_path_ref: string;
  file_identity_ref: string;
  content_or_metadata_hash: string;
  resolver_snapshot_id: string;
  resolved_at: string;
}

interface ExecutableResolutionResult {
  resolution_protocol_version: string;
  resolution_id: string;
  action_snapshot_id: string;
  executable_candidate_ref: string;
  identity: ExecutableIdentity | null;
  status:
    | 'resolved'
    | 'not_found'
    | 'ambiguous'
    | 'unsupported'
    | 'denied';
  reason_codes: string[];
}
```

`file_identity_ref` 是平台相关的稳定文件身份抽象；具体 inode/file ID/hash 组合留实施计划选择。

### 10.7 Resolution rules

1. direct path 与 PATH search 使用不同 reason code。
2. relative path 必须绑定 working directory snapshot。
3. PATH/PATHEXT 等搜索输入必须来自 effective environment snapshot。
4. 多个候选且 policy 无法确定唯一 executable 时 ambiguous。
5. symlink/reparse-point 解析必须保留 canonical 与原始 candidate provenance。
6. path policy/identity 能力不足时 unsupported/deny，不声称覆盖 M-068。
7. resolution 不执行 binary。
8. resolved 不等于 trusted/allowed，只产生 identity。
9. identity 必须绑定 action snapshot 和 resolver snapshot。
10. executable name 与 resolved path 不得通过字符串前缀近似匹配。

### 10.8 Sanitized execution plan

```ts
interface SanitizedExecutionPlan {
  execution_plan_protocol_version: string;
  execution_plan_id: string;
  action_snapshot_id: string;
  command_parse_result_id: string;
  inherited_environment_snapshot_id: string;
  inline_environment_decision_ids: string[];
  executable_resolution_id: string;
  executable_identity_id: string;
  preserved_assignment_ids: string[];
  stripped_assignment_ids: string[];
  effective_environment_snapshot_id: string;
  required_security_decision_ref: string;
  status:
    | 'ready_for_permission'
    | 'ask_required'
    | 'denied'
    | 'invalid';
  reason_codes: string[];
}
```

`ready_for_permission` 只表示环境与 executable identity 已形成一致计划，仍需 RC-5 permission 和执行前 identity revalidation。

### 10.9 AND composition

```text
M-063 inherited environment scrub
  AND M-064 AST/Plan/argument/path decision
  AND M-065 inline environment policy
  AND executable identity resolution
  AND RC-5 permission
  AND pre-spawn identity revalidation
```

任一门 deny/invalid 都不能执行。Ask 必须阻塞；ask channel unavailable 时 deny。

### 10.10 TOCTOU revalidation

```ts
interface ExecutableIdentityRevalidation {
  revalidation_protocol_version: string;
  revalidation_id: string;
  execution_plan_id: string;
  action_snapshot_id: string;
  expected_executable_identity_id: string;
  observed_executable_identity_id: string | null;
  status:
    | 'match'
    | 'changed'
    | 'missing'
    | 'unsupported';
  reason_codes: string[];
}
```

规则：

1. revalidation 在 spawn 前、同一 action snapshot 内执行。
2. changed/missing/unsupported 不能继续使用旧 allow。
3. 自动重新解析的新 identity 必须产生新 action snapshot 和新 SecurityDecision。
4. revalidation 不修改历史 resolution/plan。
5. spawn layer 必须验证 match 与 permission 都引用当前 plan。

### 10.11 错误语义

- inherited environment snapshot 缺失：deny。
- inline assignment 无 policy：ask/deny，不 preserve。
- loader injection：ask/deny；Plan Mode 或 ask unavailable 时 deny。
- path-affecting assignment 未先判定：plan invalid。
- executable not found/ambiguous：ask/deny。
- resolver unsupported：deny，不回退 shell 自行搜索。
- identity mismatch before spawn：deny，旧 approval 失效。
- sanitized plan 与 action snapshot 不匹配：deny。
- RC-5 decision 缺失/过期：deny。
- diagnostic/logging 失败：不改变 deny/ask/ready 状态。

### 10.12 Wave F handoff

ERC-4/M-065 没有 Wave F 直接 D-edge。

Wave F 不能：

- 让 M-013 依赖 executable resolution；
- 复用 executable identity 作为 Memory provenance；
- 让 Memory entrypoint 触发 command resolution；
- 因 executable defense 不可用而修改 Memory 行为。

## 11. 跨契约不变量

### INV-E1 — Snapshot 不混合

Session、catalog、task、action、environment 和 executable snapshot 只能在各自契约内按显式 identity 关联。

### INV-E2 — Meta 不计用户轮次

Meta context 在序列化、恢复和压缩后仍不能增加 user turn count 或冒充当前用户输入。

### INV-E3 — Retention 不改变 Authority

Preserve、reload-required 或 invalidate 都只改变生命周期，不改变 Trust 或 Authority。

### INV-E4 — Serializer/Compressor 一致

Serializer 与 compressor 必须识别同一 meta identity/version；任一不支持时不能激活 M-038。

### INV-E5 — Retention 不等于 Reconstruction

M-038 可以保留 reload marker，但不能执行或宣称 M-049 source reload/reinjection。

### INV-E6 — Memory 状态严格分离

Admitted、detail committed、index committed、completed、selected、retrieved 和 use 均为不同状态。

### INV-E7 — 两阶段可见性

Detail 只有在匹配的 index commit durable 后才能通过正式 catalog 被发现。

### INV-E8 — Index 不是正文

Catalog entry 只能包含导航和完整性 metadata，不能成为完整 Memory 内容通道。

### INV-E9 — Selection 不建立 Trust

Selection rank、keyword match 和 index presence 都不能产生 use、Truth、Trust 或 Authority。

### INV-E10 — M-045/M-046 无相互 D-edge

Persistence 与 retrieval 共享 schema，但设计、启用和失败状态独立。

### INV-E11 — 清洗后入 Buffer

只有已通过 CRC-6/DRC-4 gate 的 sanitized payload 可以进入 ERC-3；原始或 dropped payload 不得暂存。

### INV-E12 — Logging 非阻塞且不改 Outcome

Enqueue、flush、rotation、retention 或 sink failure 都不能阻塞 streaming loop 或修改 Agent Outcome。

### INV-E13 — Dropped Payload 不可恢复

Drop 只保留最小计数和 reason，不保留能重建原始敏感内容的副本。

### INV-E14 — Inherited/Inline Environment 是 AND

M-063 的环境清洗不能替代 M-065，M-065 也不能恢复 M-063 已移除的变量。

### INV-E15 — Executable Identity 绑定 Action

Resolution、permission、revalidation 和 spawn 必须引用同一 action/execution plan identity。

### INV-E16 — Sanitization 不授予权限

`ready_for_permission`、strip 或 resolved 都不能产生 allow。

### INV-E17 — 平台 Policy 不混用

Windows、Linux、macOS 的 environment/executable policy 独立版本化，不能按相似变量名自动复用。

### INV-E18 — Failure 不升级状态

Lifecycle、persistence、selection、logging、resolution 或 revalidation failure 不能产生 preserved、completed、selected-as-use、flushed、safe、ready 或 allow。

### INV-E19 — 版本正交

Meta retention、serializer、compressor、memory record、persistence、catalog、selection、logging、buffer、flush、environment policy、resolution、execution plan 和 revalidation protocol 独立版本化。

### INV-E20 — 不新增 Wave F D-edge

只有 ERC-2/M-045/M-046 是 M-013 的 Wave F 输入；ERC-1、ERC-3、ERC-4 不直接接入 Wave F。

## 12. 兼容与废止关系

| 当前语义 | Wave E 结论 |
|---|---|
| system-generated user message 进入普通历史 | 迁移为 meta lifecycle；不计 user turn |
| compaction 普通裁剪所有旧消息 | meta 按 preserve/reload-required/invalidate 独立处理 |
| meta 存在即永久有效 | 废止；freshness/source invalidation 仍生效 |
| memory tool 直接写 entry/index | 新 auto-memory 走 admission + persistence transaction |
| detail 写入成功即视为 Memory 可用 | 废止；需要 index commit + completed |
| index 保存完整正文 | 废止；index 只做导航 |
| keyword selector 输出直接注入 | 废止；retrieve 后走 MemoryUseDecision |
| selector 失败则加载全部 Memory | 禁止 |
| debug event 同步写盘 | 迁移为 sanitized bounded buffer |
| logger 暂存原文、发送前清洗 | 废止；清洗后才能入 buffer |
| buffer 满时阻塞 streaming | 废止；确定性 drop_newest |
| shell 自行按 PATH 找 executable | 必须形成可审计 resolution identity |
| 删除全部 inline env assignment | 禁止；按平台 policy preserve/strip/ask/deny |
| strip 后自动执行 | 禁止；仍需 RC-5 permission |
| resolve 一次后永久信任路径 | 废止；spawn 前 identity revalidation |

## 13. Wave F Handoff 总表

| Wave F 机制 | 消费 Wave E | 可以依赖 | 禁止假设 |
|---|---|---|---|
| M-013 Bounded Memory Entrypoint | ERC-2/M-045/M-046 | immutable catalog、durability evidence、bounded index、selection result、provenance/hash、use-decision gate | index 是正文；旧数据自动 admitted；admit/selected 等于 use；全部 detail 可注入 |

ERC-1/M-038、ERC-3/M-052、ERC-4/M-065 没有 Wave F 直接 D-edge。

M-038 的直接后续消费者是 Wave G M-049；本文保留该 deferred handoff，但不把 M-049 提前到 Wave F 设计。

## 14. 防御边界

| 高频失败 | Wave E 防护原则 |
|---|---|
| meta 被计作用户轮次 | serializer/compressor round-trip 验证 |
| meta 被普通裁剪静默删除 | preserve/reload-required/invalidate 三态 |
| stale meta 永久保留 | freshness failure → reload-required/invalidate |
| 把 reload marker 当作已重建 | M-049 独立 handoff |
| detail 写成但 index 失败 | recovery_required，detail 不可发现 |
| 重试产生重复 Memory | idempotency key |
| catalog 超预算静默截断 | update_rejected/rebuild_required |
| selector 加载全部 detail | index-first + budget |
| selection rank 被当作 Truth | 必须经过 MemoryUseDecision |
| 未清洗事件进入 buffer | enqueue 前 gate |
| buffer 满阻塞 streaming | drop_newest + counter |
| dropped payload 被临时保存 | 禁止任何旁路副本 |
| sink path 被劫持 | trusted path + symlink/path check |
| inline env 全部删除 | 按 risk/policy 分类 |
| PATH/loader assignment 绕过 resolver | 先判定 assignment，再构造 effective env |
| binary 在 allow 后被替换 | pre-spawn identity revalidation |
| sanitized plan 被当作 permission | 仍需 RC-5 allow |

## 15. 规格级验收矩阵

### ERC-1

1. Meta 不计 user turn。
2. Retention 与 Authority/Trust 分离。
3. preserve/reload-required/invalidate 有确定语义。
4. serializer round-trip 保持 meta identity/hash/ordinal。
5. compressor 不静默裁剪 preserve meta。
6. unknown metadata 不降级为普通 user message。
7. activation gate 同时要求 serializer/compressor 支持。
8. M-038 不实现 M-049。
9. 明确无 Wave F 直接 D-edge。

### ERC-2

1. M-045/M-046 是 sibling，不互为前置。
2. persistence 四阶段和失败状态完整。
3. detail 在 index commit 前不可发现。
4. idempotency/version 防重复与 lost update。
5. catalog budget 超限不静默截断。
6. index 不保存完整正文。
7. selector 只读 metadata 且有预算。
8. 相同 query/snapshot 结果确定。
9. selection 不建立 Trust/Truth/use。
10. retrieve 后强制 MemoryUseDecision。
11. `admit ≠ persisted ≠ selected ≠ use`。
12. 既有 MemoryManager 条目不因存储存在而自动 admitted。
13. Wave F handoff 唯一覆盖 M-013。

### ERC-3

1. 只有 sanitized event 可以入 buffer。
2. dropped/raw payload 不暂存。
3. buffer 有 event/byte 上限。
4. overflow 固定 drop_newest。
5. enqueue 不执行磁盘 I/O。
6. flush 只移除 durable acknowledged event。
7. rotation/retention/sink path 有边界。
8. shutdown flush 有界。
9. logging failure 不改变 Outcome。
10. 明确无 Wave F 直接 D-edge。

### ERC-4

1. inherited 与 inline environment 是 AND。
2. platform policy 独立。
3. assignment 有 preserve/strip/ask/deny 结构化结果。
4. strip 不能静默改变任务语义。
5. executable resolution 使用 effective environment。
6. resolved 不等于 allowed。
7. execution plan 仍需 RC-5 permission。
8. identity 绑定 action snapshot。
9. spawn 前执行 identity revalidation。
10. identity 变化使旧 approval 失效。
11. 不声称覆盖 M-068 Hold。
12. 明确无 Wave F 直接 D-edge。

### 跨契约

1. INV-E1～INV-E20 无冲突。
2. 四个 ERC 覆盖五个 Wave E 机制且无重复主责。
3. M-013 有且仅有 ERC-2 作为 Wave E handoff。
4. ERC-1/3/4 未被添加为 Wave F 直接依赖。
5. M-038 的 Wave G handoff 被保留但未提前实现。
6. Memory、Logging 与 executable side effect 均有 durable/安全 acknowledgement。
7. Failure 不提升状态或权限。
8. 未选择 Prompt 原文或进入实现任务。

## 16. 设计完成标准

Wave E 只有在以下条件全部满足后才能冻结：

1. 五个机制全部映射到且仅映射到一个主 ERC。
2. 四个 ERC 都有输入、输出、不变量、错误语义和后续 handoff。
3. ERC-1 不把 meta 当作用户轮次或更高 Authority。
4. ERC-1 明确不实现 M-049。
5. ERC-2 不增加 M-045/M-046 相互 D-edge。
6. ERC-2 两阶段持久化没有半完成可见状态。
7. ERC-2 selector 不绕过 MemoryUseDecision。
8. ERC-2 不把既有存储条目静默升级为 admitted。
9. ERC-3 清洗后才入 buffer。
10. ERC-3 不阻塞 streaming 或保留 dropped 原文。
11. ERC-4 inherited/inline env 是 AND。
12. ERC-4 executable identity 有 TOCTOU revalidation。
13. ERC-4 sanitized plan 不授予 permission。
14. INV-E1～INV-E20 可由结构化协议验证。
15. Wave F 唯一节点 M-013 handoff 完整。
16. 未新增冻结 DAG D-edge。
17. 未选择、改写或嵌入 Claude Prompt 原文。
18. 未进入生产代码、实施文件、工期或 Git 操作。

## 17. 后续流程

本文审核冻结后：

1. Wave F M-013 只能消费 ERC-2 的 committed catalog、bounded selection 和 use-decision gate。
2. Wave F 不得反向修改 Memory admission、persistence、catalog、selection 或 use 语义。
3. Wave F 设计冻结后，进入 Wave G M-049。
4. Wave G 可以消费 ERC-1/M-038 的 reload marker，但不得把 marker 当作已重建。
5. 全部 Wave 设计冻结后，才编写主 Agent/Prompt 机制的详细实施计划。
6. Prompt Library Import 仍是独立资产快照，不改变本文任何 retained、persisted、selected、use、logged、resolved、ready 或 runtime activation 状态。
