# mi-code Agent Integrated Capability Contracts — Wave D

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix、Wave A Root Contracts、Wave B Contracts、Wave C Policy Contracts
> 覆盖机制：M-008、M-028、M-044、M-048、M-055、M-064
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave D 冻结五个 Integrated Capability Root Contract：

| Wave D Root Contract | 机制 | 机制 Owner |
|---|---|---|
| DRC-1 Mode Profile Projection | M-048 | Phase 1 |
| DRC-2 Trusted Context Activation | M-008、M-044 | Phase 2 |
| DRC-3 Tool Reference Integrity | M-028 | Phase 3 |
| DRC-4 Component Telemetry Attribution | M-055 | Phase 6 |
| DRC-5 Shell Command Structural Policy | M-064 | Phase 5 |

`1 + 2 + 1 + 1 + 1 = 6`，六个 Wave D 机制全部归入且仅归入一个主 DRC。

DRC 是跨模块能力契约，不是新的中央 Runtime。DRC-2 把 M-008 与 M-044 放在同一契约内，是为了冻结 Project Instruction 与 Auto Memory 的禁止串线不变量；二者仍是并列子协议，不新增相互 D-edge。

## 2. 设计目标

Wave D 必须定义：

1. 结构化 mode 如何选择 Prompt section profile。
2. mandatory Prompt section 如何在 profile 投影中保持不可省略。
3. project instruction 如何成为 meta user context，而不混入 system base 或当前用户消息。
4. Memory candidate 如何分别经过写入准入和使用前验证。
5. Project Instruction 与 Auto Memory 为什么不能互相转换。
6. Prompt 中的工具引用如何对最终请求 tool view 做完整性校验。
7. component telemetry 如何按稳定 ID 归因 bytes、chars、tokens、hash 和 variant。
8. estimator token 与 Provider 实际 token 如何避免混记。
9. production telemetry 如何继续服从 CRC-6 字段政策与 PII gate。
10. shell command 如何在不执行的情况下解析为结构化语法和风险事实。
11. shadow 与 enforced 如何成为机器状态，而不是日志措辞。
12. AST policy 为什么只能补强、不能替代 Plan Mode allowlist。
13. 每个 DRC 向 Wave E 交付什么，以及 Wave E 不能假设什么。

## 3. 明确排除

本文不设计或实施：

- meta context 的 serializer、retention、compaction 或恢复逻辑；
- Memory topic file、MEMORY.md index、atomic writer 或 keyword selector；
- bounded Memory entrypoint；
- post-compact pinned working set 重注入；
- binary hijack、PATH resolution 或前导环境赋值清洗；
- Prompt cache control、cache hit 收益或 Provider cache 配置；
- tool deferred loading、dynamic attachment plane 或复杂工具 few-shot；
- full request dump、远程 production sink 或日志 rotation；
- shell parser 库选型、平台语法包、测试语料文件或 shadow rollout 百分比；
- Prompt 原文选择、改写、评测、批准或嵌入；
- 实现类、文件布局、测试任务、数据迁移、工期和 Git 操作。

这些能力属于 Wave E 以后或详细实施计划。

## 4. 现状与复用边界

### 4.1 可复用上游

| 冻结能力 | Wave D 复用方式 |
|---|---|
| RC-1 Prompt Asset Governance | 保留 asset/version/evaluation identity，不重新批准 Prompt |
| RC-2 Semantic Request Boundary | 复用 Placement、tool plane 和 Provider adapter 边界 |
| RC-3 Project Rule Discovery | 复用 source/provenance identity，不把 discovery 当作 trust |
| RC-5 SecurityDecision/UserDecision | DRC-5 的唯一 allow/ask/deny 机器协议 |
| BRC-1 Prompt Compiler | 接收 DRC-1 投影后的 compilation input；提供稳定 section/request identity |
| BRC-2 Capability/Tool View | 提供 effective capability 和最终不可变 tool view |
| BRC-3 Context Intake | 提供 bounded/sanitized source envelope 和 overflow metadata |
| BRC-7 Observability Planes | 提供 component/event/plane identity，不授予采集许可 |
| CRC-1 Prompt Resolution Policy | 提供 base、mandatory/optional、condition 和 scope evidence |
| CRC-3 Context Routing & Memory Typing | 提供 trusted route 与 typed memory candidate |
| CRC-4 Tool Policy & No-Tool Contract | 提供 tool projection 和 machine-enforced empty tool view |
| CRC-6 Observability Safety Policy | 提供 DecisionTrace、字段 allowlist、PII label、redaction/drop gate |

### 4.2 已确认缺口

- Normal/Plan 之外没有结构化 Prompt profile 投影。
- 项目规则没有独立 meta user context activation。
- Memory 缺少写入准入与使用前验证的分离决策。
- Prompt 工具名称与最终 tool view 可能漂移。
- 只有 Provider 总 token，无法定位到具体 Prompt section 或 tool schema。
- estimator token 与 Provider usage 没有统一来源标签。
- bash policy 仍以现有 parser/字符串规则为主，没有 AST/shadow/too-complex 契约。

### 4.3 Wheel Reuse Check

Wave D 必须复用：

- 现有 Prompt compiler 与不可变 snapshot；
- 现有 Tool Registry、tool view 与 Provider tool plane；
- 现有 MemoryManager 的后续存储能力，但本 Wave 不接入写盘；
- 现有 PermissionChecker 与 Plan Mode allowlist，DRC-5 不建立第二套权限系统；
- BRC-7/CRC-6 的观测与清洗协议，DRC-4 不建立旁路 telemetry plane；
- 现有 bash parser 作为迁移基线或 shadow comparator，而不是直接判定其永久真值地位。

### 4.4 冻结 D-edge 对照

| Wave D 机制 | 冻结 D 前置 | 本文消费位置 |
|---|---|---|
| M-008 | M-006、M-010、M-011、M-012、M-050 | RC-2/RC-3、CRC-3 route、BRC-3 provenance/budget |
| M-028 | M-024、M-026 | BRC-2 final tool view、CRC-4 policy projection |
| M-044 | M-040、M-043 | BRC-3 deterministic ingress、CRC-3 typed candidate |
| M-048 | M-001、M-004、M-058 | BRC-1 compiler、CRC-1 conditions、BRC-2 capability |
| M-055 | M-001、M-018、M-020、M-023、M-051、M-056 | BRC-1/RC-1/BRC-2/BRC-7、CRC-6 |
| M-064 | M-054、M-062 | CRC-6 decision trace、RC-5 security vocabulary |

该表只复述冻结矩阵，不新增同 Wave D 机制之间的 D-edge。特别是 M-055 不是 M-064 前置，M-008 与 M-044 也不互为前置。

## 5. 跨契约数据流

```text
Structured control mode / role / task
  + CRC-1 PromptResolutionPlan
  + BRC-2 effective capability
        │
        ▼
DRC-1 ModeProfileProjection
        │ profiled compilation input
        ▼
BRC-1 Prompt Compiler

CRC-3 project_instruction route
  + bounded ContextSourceEnvelope
        │
        ▼
DRC-2 ProjectInstructionActivation
        │ meta context message
        ▼
RC-2 meta_context plane

CRC-3 TypedMemoryCandidate
  + current context/version evidence
        │
        ▼
DRC-2 MemoryAdmissionDecision / MemoryUseDecision

BRC-1 final compiled Prompt
  + BRC-2 final tool view
  + CRC-4 tool policy projection
        │
        ▼
DRC-3 ToolReferenceValidation

BRC-1/BRC-2 stable components
  + BRC-7 event identity
  + CRC-6 field/redaction policy
        │
        ▼
DRC-4 ComponentTelemetryBatch

Command action snapshot
  + shell dialect
  + RC-5 policy
  + CRC-6 DecisionTrace vocabulary
        │
        ▼
DRC-5 CommandParseResult
  + shadow/enforced composition
        │
        ▼
RC-5 SecurityDecision
```

DRC-4 只观察其他契约的结构化输出，不能反向参与 DRC-1～DRC-3 或 DRC-5 的业务判定。DRC-5 不依赖 M-055；它直接消费 CRC-6 的 decision trace 契约，避免新增冻结 DAG D-edge。

## 6. 共同能力词汇

### 6.1 Contract identity

```ts
interface IntegratedContractRef {
  contract_id: string;
  contract_version: string;
}

interface ImmutableInputSet {
  request_snapshot_id: string;
  input_snapshot_ids: string[];
  captured_at: string;
}
```

相同 contract version 与相同不可变输入必须产生相同结构化结果。时间、配置、mode、tool view、source 或 policy 变化必须形成新 snapshot。

### 6.2 Decision provenance

每个 DRC 输出至少保留：

- 自身 protocol version；
- decision/validation/batch identity；
- policy/contract ref；
- input snapshot refs；
- reason/diagnostic codes；
- 状态；
- 下游引用需要的稳定 component IDs。

解释性文字不能替代 reason code，也不能成为下一次机器判定的隐式输入。

### 6.3 Activation 与设计完成分离

协议冻结不等于运行时启用：

| 能力 | 运行时启用门 |
|---|---|
| DRC-1 profile | profile registry、mandatory coverage 和行为回归通过 |
| DRC-2 meta context | Provider conversion、message ordering 和 source trust 验证通过 |
| DRC-2 Memory admission/use | admission policy、current-context verifier 和 Memory writer 边界就绪 |
| DRC-3 reference validation | final tool view 与 tool manual identity 可重放 |
| DRC-4 production telemetry | CRC-6 最小字段政策、redaction/drop 已生效 |
| DRC-5 enforced | shell grammar、shadow divergence、too-complex policy 和 Plan allowlist composition 验证通过 |

### 6.4 Outcome independence

Telemetry sink、Memory writer 或 debug logger 的失败不能重写 TurnOutcome。安全判定失败不能因可观测性不可用而自动 allow；观测失败只能导致观测事件被 drop 或记录最小本地计数。

## 7. DRC-1 — Mode Profile Projection

### 7.1 目标

把结构化 control mode、role/task identity、effective capability 与 CRC-1 resolution plan 投影为 BRC-1 可编译的 section 集。

DRC-1 不创建 mode、不从自然语言猜 mode、不决定 Provider cache，也不改变 section Authority。

### 7.2 Profile definition

```ts
interface ModeProfileDefinition {
  profile_id: string;
  profile_version: string;
  source_asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  control_mode: string;
  allowed_role_refs: string[];
  allowed_task_type_refs: string[];
  include_capability_tags: string[];
  exclude_capability_tags: string[];
  default_for_mode: boolean;
}
```

规则：

1. profile definition 必须来自 approved immutable asset 或受信构建配置。
2. 一个 control mode 最多有一个有效 default profile。
3. role/task override 必须精确匹配，不支持隐式 substring 或 Prompt 内容判断。
4. capability tag 只消费 BRC-2 effective capability snapshot。
5. profile 不能创建 capability、permission 或新的 section。

### 7.3 Selection input

```ts
interface ModeProfileSelectionInput {
  profile_protocol_version: string;
  request_snapshot_id: string;
  prompt_resolution_plan_id: string;
  control_mode_snapshot_id: string;
  role_profile_snapshot_id: string | null;
  task_profile_snapshot_id: string | null;
  effective_capability_snapshot_id: string;
  candidate_section_ids: string[];
}
```

`control_mode_snapshot_id` 是唯一 mode 真相源。用户文本、文件正文、模型自报和 Prompt 中的 “plan/build/auto” 字样不参与 mode 判定。

### 7.4 Selection output

```ts
interface ModeProfileSelection {
  profile_protocol_version: string;
  selection_id: string;
  request_snapshot_id: string;
  selected_profile_ref: {
    profile_id: string;
    profile_version: string;
  };
  prompt_resolution_plan_id: string;
  included_section_ids: string[];
  excluded_sections: ReadonlyArray<{
    section_id: string;
    reason_code: string;
  }>;
  mandatory_coverage: ReadonlyArray<{
    section_id: string;
    status: 'included' | 'not_applicable';
    condition_evidence_ref: string | null;
  }>;
  status: 'valid' | 'invalid';
  diagnostics: string[];
}
```

只有 `status=valid` 的 selection 可以形成 BRC-1 `PromptCompilationInput`。

### 7.5 Projection 不变量

1. CRC-1 `mandatory_candidate_ids` 必须全部出现在 `included_section_ids`，或有受信 condition 明确 false 的 `not_applicable` evidence。
2. optional section 才能因 mode、role、task 或 capability 不适用而排除。
3. `trusted_runtime_override` 只影响 CRC-1 base winner，不能删除 mandatory append。
4. profile 不改变 section content、hash、asset version、Authority、Trust 或 Placement。
5. profile 不把 meta context、conversation 或 tool plane 复制进 system section。
6. selected profile 与 resolution plan 必须绑定同一 request snapshot。
7. capability unknown 不乐观 include 需要 capability 的 optional section。
8. profile 选择结果不等于 behavior evaluation 通过。
9. static/dynamic scope 保持 CRC-1 结果；profile 不重新分类。
10. section exclude 必须有结构化 reason code。

### 7.6 错误语义

- control mode 未注册：invalid，不猜 default。
- 同一 mode 多个 default profile：invalid。
- role/task override 多重匹配：invalid。
- mandatory section 缺失：invalid，请求不得编译。
- mandatory `not_applicable` 无 condition evidence：invalid。
- candidate section 不在 resolution plan：invalid。
- capability snapshot 不匹配 request：invalid。
- profile asset 非 approved：invalid。
- optional capability unknown：排除并记录 reason，不升级为 supported。

### 7.7 Wave E handoff

冻结 DAG 中 DRC-1/M-048 没有 Wave E 直接 D-edge。

Wave E 可以把 DRC-1 视为已冻结的全局 profile 边界，但不能：

- 为方便给 M-038、M-045、M-046、M-052 或 M-065 新增 DRC-1 直接依赖；
- 假设 profile 已产生 cache hit 或 token 节省；
- 通过 lifecycle/selection 省略 mandatory section；
- 反向改变 mode 或 section Authority。

## 8. DRC-2 — Trusted Context Activation

### 8.1 目标

DRC-2 包含两个并列子协议：

1. M-008 `ProjectInstructionActivation`
2. M-044 `MemoryAdmissionDecision` 与 `MemoryUseDecision`

共同目标是把 CRC-3 的已路由内容送入正确通道，同时禁止 Project Instruction 与 Auto Memory 互相提升、复制或转换。

### 8.2 Channel boundary

```ts
type TrustedContextChannel =
  | 'project_instruction'
  | 'auto_memory';

interface ContextActivationIdentity {
  activation_protocol_version: string;
  activation_id: string;
  request_snapshot_id: string;
  source_context_id: string;
  route_decision_id: string;
  channel: TrustedContextChannel;
}
```

Channel 由 CRC-3 `MarkdownRouteDecision.target` 决定。Agent、正文标签或下游 consumer 无权改写。

### 8.3 Project instruction activation input

```ts
interface ProjectInstructionActivationInput {
  activation_identity: ContextActivationIdentity;
  context_source_id: string;
  route_decision_id: string;
  bounded_content_ref: string;
  content_hash: string;
  provenance_refs: string[];
  authority: string;
  trust: string;
  freshness_ref: string;
  overflow_metadata_ref: string | null;
}
```

输入必须同时满足：

- route target 是 `project_instruction_context`；
- CRC-3 四重 trust proof 完整；
- BRC-3 sanitizer 已 accepted/transformed；
- source budget 存在且 overflow 显式；
- source 与 route identity 一致。

### 8.4 Meta context output

```ts
interface MetaContextActivation {
  activation_protocol_version: string;
  activation_id: string;
  request_snapshot_id: string;
  message_id: string;
  semantic_role: 'user';
  placement: 'meta_context';
  is_meta: true;
  source_context_id: string;
  route_decision_id: string;
  content_ref: string;
  content_hash: string;
  authority: string;
  trust: string;
  provenance_refs: string[];
  freshness_ref: string;
  overflow_metadata_ref: string | null;
  retention_state: 'unassigned';
  ordinal: number;
}
```

`semantic_role='user'` 是 Provider message plane 编码，不代表内容来自当前用户。`is_meta=true` 只区分消息类别，不提升 Trust、Authority 或 Retention。

### 8.5 Meta context placement

1. meta context 进入 RC-2 `meta_context` plane，不进入 `system_static/system_dynamic`。
2. meta context 位于 conversation 之前，但不计作当前用户轮次。
3. 当前用户消息仍属于 Pinned Working Set，不被 meta message 替代。
4. 多个 meta context 按上游 scope/provenance order 与稳定 ordinal 排序。
5. ordinal 冲突使 activation invalid，不按路径字符串猜顺序。
6. Provider adapter 只能转换 semantic message，不能修改 role/placement/authority/trust。
7. `retention_state='unassigned'` 明确表示 M-038 尚未完成，不能按普通 conversation 或永久 pinned 自行解释。
8. content 超预算时只消费 BRC-3 已显式处理的 bounded 结果，不能二次静默截断。

### 8.6 Memory admission input

```ts
interface MemoryAdmissionInput {
  admission_protocol_version: string;
  memory_candidate_id: string;
  memory_policy_ref: IntegratedContractRef;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  candidate_evidence_refs: string[];
}
```

只接受 CRC-3 `TypedMemoryCandidate`。Project instruction route、Tool Result 原文、模型 summary 和任意 Markdown 文件不能绕过 typed candidate 直接 admission。

### 8.7 Memory admission decision

```ts
type MemoryAdmissionStatus =
  | 'admit'
  | 'reject'
  | 'defer';

interface MemoryAdmissionDecision {
  admission_protocol_version: string;
  admission_decision_id: string;
  memory_candidate_id: string;
  policy_ref: IntegratedContractRef;
  current_context_snapshot_id: string;
  status: MemoryAdmissionStatus;
  accepted_scope_ref: string | null;
  accepted_type: AutoMemoryType | null;
  verification_requirements: string[];
  reason_codes: string[];
  evidence_refs: string[];
}
```

`admit` 只表示允许交给后续 M-045 持久化，不表示已经写入，也不表示以后可以无验证使用。

### 8.8 Admission policy

以下内容默认 reject：

- credential、secret、token、private key 或认证材料；
- 仅对当前 turn 有效的临时状态；
- 未绑定 scope、evidence 或 freshness 的结论；
- 从失败一次直接推导的永久禁止规则；
- 把 Project Instruction 复制为 Auto Memory 的候选；
- 与 frozen system/project rule 重复且会造成 Authority 混淆的内容；
- 来源或 writer 与 BRC-3/CRC-3 channel 不匹配的内容。

以下情况使用 defer：

- evidence 存在但当前上下文不足以确认；
- candidate freshness 已过期但存在确定性刷新路径；
- project/model/tool version 无法与当前 snapshot 对齐；
- admission policy 要求用户决定，且当前没有可安全自动判断的偏好语义。

`defer` 不等于 admit，也不能写入长期存储。

### 8.9 Confidence 语义

1. `confidence` 必须是有限数值且满足 `0 <= confidence <= 1`，包含两个端点。
2. confidence 只表达 candidate producer 对 observation 的置信，不表达 Authority、Trust 或 admission。
3. 不同 memory type 的 confidence 不具有默认全局排序语义。
4. threshold 必须属于明确的 type-specific policy。
5. `confidence=1` 仍需 evidence、freshness 和使用前验证。
6. NaN、Infinity、负数和大于 1 的值使 candidate invalid。

### 8.10 Memory use decision

```ts
type MemoryUseStatus =
  | 'use'
  | 'do_not_use'
  | 'needs_refresh';

interface MemoryUseDecision {
  memory_use_protocol_version: string;
  memory_use_decision_id: string;
  stored_memory_ref: string;
  admission_decision_id: string;
  current_context_snapshot_id: string;
  project_version_ref: string | null;
  status: MemoryUseStatus;
  verified_claim_refs: string[];
  stale_claim_refs: string[];
  conflicting_evidence_refs: string[];
  reason_codes: string[];
}
```

M-046 可以先按 bounded index 选择需要检索的候选文件；检索出的 claim 在进入 Prompt、回答或行为依据前，必须回到本协议生成 `MemoryUseDecision`。只有 `status='use'` 的已验证 claim 可以实际使用。`needs_refresh` 不能被当作低置信 use；刷新失败时按 `do_not_use` 处理，除非任务进入独立 awaiting-user 流程。

### 8.11 Cross-channel 不变量

1. `project_instruction` 不能改写为 `auto_memory`。
2. `auto_memory` 不能注入为 project instruction 或 system rule。
3. 共享存储后端不允许共享 writer、Authority、loader 或 admission 结果。
4. Project instruction activation 不产生 Memory admission。
5. Memory admission 不产生 Prompt placement。
6. Meta message 的 user role 不表示当前用户授权。
7. Memory `admit` 不表示事实正确；Memory `use` 必须绑定当前 context snapshot。
8. admission policy 和 use policy 可以共享 evidence vocabulary，但必须有独立 protocol/decision ID。
9. failure observation 必须保留 failure context、confidence 和 invalidation conditions。
10. cancelled turn 不自动形成失败结论 Memory。
11. Memory writer 失败不改变 TurnOutcome。
12. route、admission、use、persistence、selection、retention 是五个独立状态。

### 8.12 错误语义

- route target 与 channel 不匹配：reject activation。
- trust proof/sanitizer/budget 缺失：不注入、不 admission。
- meta ordinal 冲突：activation invalid。
- Provider 无法保持 meta role/placement：请求不得发送。
- candidate schema/type/evidence 缺失：admission reject。
- confidence 非法：admission reject。
- policy/snapshot/version 不匹配：defer 或 reject，不猜测。
- 使用前验证器不可用：needs_refresh/do_not_use，不乐观 use。
- current context 与 stored claim 冲突：do_not_use，并保留 evidence。
- writer 失败：记录持久化失败，不改变 admission decision 或 TurnOutcome。

### 8.13 Wave E handoff

M-038 可以获得：

- 不可变 `MetaContextActivation`；
- `message_id`、`is_meta=true`、Placement、Authority、Trust 和 provenance；
- `retention_state='unassigned'`；
- stable ordinal 与 current-user 分离语义。

M-038 不能假设：

- meta message 已拥有 retention policy；
- meta 表示更高 Authority；
- serializer/compressor 已识别该消息；
- meta message 可以被普通 conversation 裁剪。

M-045 可以获得：

- `MemoryAdmissionDecision(status='admit')`；
- accepted type/scope、evidence 和 verification requirements；
- admission 与 TurnOutcome 分离语义。

M-045 不能假设：

- admit 等于已持久化；
- writer 失败可以改变 TurnOutcome；
- MEMORY.md 可以无限增长；
- candidate 可以改写为 project rule。

M-046 可以获得：

- admitted memory identity；
- admission metadata 与 verification requirements；
- scope、type、freshness 和 provenance；
- 检索后调用 `MemoryUseDecision` 的确定性 gate。

M-046 不能假设：

- admission 等于 use；
- selector 可以重新提升 Authority；
- `needs_refresh` 可以进入 Prompt；
- 选择结果已 trusted、已通过 use verification 或已完成预算控制。

## 9. DRC-3 — Tool Reference Integrity

### 9.1 目标

验证最终 Prompt 请求中的工具引用、最终 tool view 和 tool-local manual identity 一致。

DRC-3 检查 final immutable request snapshot，不以静态 Tool Registry、未应用 overlay 的 base schema 或 Prompt 源文件作为最终真值。

### 9.2 Reference manifest

```ts
interface ToolReferenceRecord {
  reference_id: string;
  section_id: string;
  tool_id: string;
  canonical_tool_name: string;
  source_kind:
    | 'structured_asset_metadata'
    | 'compiler_reference_token'
    | 'deterministic_render_scan';
  evidence_ref: string;
}

interface ToolReferenceManifest {
  reference_manifest_protocol_version: string;
  reference_manifest_id: string;
  compiled_prompt_snapshot_id: string;
  records: ToolReferenceRecord[];
}
```

结构化 asset metadata/compiler token 是首选来源。确定性 render scan 只能识别已登记 canonical name，不使用模型语义判断“这句话大概指某工具”。

### 9.3 Validation input

```ts
interface ToolReferenceValidationInput {
  validation_protocol_version: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  reference_manifest_id: string;
  tool_policy_projection_ids: string[];
  no_tool_validation_id: string | null;
}
```

所有输入必须绑定同一 request snapshot。base registry 和 final tool view identity 不得混用。

### 9.4 Validation output

```ts
interface ToolReferenceValidation {
  validation_protocol_version: string;
  validation_id: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  reference_manifest_id: string;
  status: 'valid' | 'invalid';
  checked_records: ReadonlyArray<{
    reference_id: string;
    tool_id: string;
    visible_in_final_view: boolean;
    canonical_name_matches: boolean;
    manual_identity_resolved: boolean;
    policy_projection_matches: boolean;
  }>;
  orphan_reference_ids: string[];
  undeclared_rendered_reference_refs: string[];
  diagnostics: string[];
}
```

### 9.5 Integrity rules

1. 每个 Prompt tool reference 必须解析到唯一 `tool_id`。
2. 对应工具必须存在于 final tool view。
3. canonical name 必须与 final tool definition 一致。
4. tool manual/description asset identity 必须可解析且与 policy projection 一致。
5. excluded tool 不得残留在 Prompt。
6. no-tools request 的 manifest 必须为空，final tool view 必须为空。
7. Prompt section 与 tool view 必须属于同一 request snapshot。
8. 重命名工具必须形成新的 manifest/asset version，不能靠 alias 静默兼容。
9. final tool view 中存在但 Prompt 未引用的工具不是自动错误；是否要求引用由独立 policy 决定。
10. 名称引用完整不表示复杂工具 manual 足够，也不替代 M-025 few-shot 或 M-026 policy。
11. validation 不改变 tool visibility、permission 或 order。
12. 同一不可变输入重复校验必须得到相同结果。

### 9.6 错误语义

- reference 指向不可见工具：invalid，请求不得发送。
- canonical name 漂移：invalid。
- 一个 name 对应多个 tool ID：invalid。
- manual identity 缺失或版本不匹配：invalid。
- policy projection 与 final view 不匹配：invalid。
- no-tools manifest 非空：protocol error。
- deterministic scan 发现未声明 canonical reference：invalid，不能静默补登记。
- scanner 无法确定普通自然语言是否为工具引用：不猜测；要求结构化 declaration。
- telemetry 不可用：不影响 validation。

### 9.7 Wave E handoff

冻结 DAG 中 DRC-3/M-028 没有 Wave E 直接 D-edge。

Wave E 不能：

- 让 M-038/M-045/M-046/M-052/M-065 依赖 reference validation；
- 把工具名称存在理解为 manual 完整；
- 用 telemetry 推断引用正确；
- 反向改变 final tool view 以让校验通过。

## 10. DRC-4 — Component Telemetry Attribution

### 10.1 目标

为 Prompt section、tool schema、compiled request 和 profile variant 生成可归因、可比较、默认不含正文的结构化指标。

DRC-4 不启用 full dump，不决定 Prompt/tool 行为，不把估算 token 冒充 Provider usage。

### 10.2 Component vocabulary

```ts
type TelemetryComponentKind =
  | 'prompt_section'
  | 'tool_schema'
  | 'compiled_prompt'
  | 'tool_view'
  | 'semantic_request';

interface TelemetryComponentRef {
  component_kind: TelemetryComponentKind;
  component_id: string;
  component_version: string;
  source_snapshot_id: string;
}
```

`component_id` 必须来自 RC/BRC/CRC 已冻结的 stable identity，不从数组下标或显示名称临时生成。

### 10.3 Measurement vocabulary

```ts
type TokenMeasurementKind =
  | 'estimated_component_tokens'
  | 'provider_reported_input_tokens'
  | 'provider_reported_output_tokens';

interface TokenMeasurement {
  measurement_kind: TokenMeasurementKind;
  value: number;
  scope:
    | 'component'
    | 'compiled_prompt'
    | 'tool_view'
    | 'request'
    | 'response';
  method_id: string;
  method_version: string;
  provider_id: string | null;
  model_id: string | null;
}
```

Provider 只报告 request aggregate 时，不得按字符比例伪造 section 级 Provider token。section 级数据只能标记为 estimator。

### 10.4 Component event

```ts
interface ComponentTelemetryEvent {
  component_telemetry_protocol_version: string;
  event_id: string;
  request_snapshot_id: string;
  component_ref: TelemetryComponentRef;
  profile_ref: string | null;
  variant_ref: string | null;
  included: boolean;
  inclusion_reason_code: string;
  byte_count: number;
  character_count: number;
  content_hash: string;
  token_measurements: TokenMeasurement[];
  field_policy_ref: string;
  redaction_result_ref: string;
}
```

`content_hash` 用于漂移检测，不等于允许记录 content。hash 也不被描述为匿名化。

### 10.5 Telemetry batch

```ts
interface ComponentTelemetryBatch {
  component_telemetry_protocol_version: string;
  batch_id: string;
  request_snapshot_id: string;
  compiled_prompt_snapshot_id: string;
  final_tool_view_snapshot_id: string;
  profile_selection_id: string | null;
  events: ComponentTelemetryEvent[];
  provider_usage_ref: string | null;
  status: 'ready' | 'dropped';
  reason_codes: string[];
}
```

Batch 只包含通过 CRC-6 字段 allowlist、PII classification 和 redaction/drop 的事件。

### 10.6 Attribution rules

1. bytes 按最终序列化前的内部 canonical encoding 统计，并记录 method/version。
2. characters 明确为 Unicode scalar/code point 或实现选定口径，不能与 bytes 混称。
3. estimator 必须记录 tokenizer/estimator identity 和 model scope。
4. Provider usage 只记录 Provider 实际返回的 scope。
5. byte/character/token count 必须是有限、非负整数；非法值使对应 event/measurement 无效。
6. component total 与 aggregate total 不可比较时必须保留口径差异。
7. included/excluded section 都可以记录 metadata，但 excluded 内容正文仍不采集。
8. tool schema 使用 final tool view 顺序和 identity。
9. profile、asset、schema、compiler 与 telemetry protocol version 相互独立。
10. 默认事件不包含 Prompt body、tool description body、user content、source code、filesystem path 或 credential。
11. debug/full-dump plane 仍按 BRC-7 独立治理，不能由本契约自动启用。
12. telemetry event 不成为下一轮 Prompt 条件或 permission 输入。
13. sink failure 不重试未清洗 payload，不改变业务 Outcome。

### 10.7 Drift semantics

允许报告：

- 同一 stable component ID 的 version/hash 变化；
- section/tool view 数量变化；
- profile include/exclude 变化；
- estimator 口径内的 token 变化；
- Provider aggregate usage 变化。

禁止直接推断：

- hash 变化一定是回归；
- estimator 下降等于 Provider 成本下降；
- static section 已 cache hit；
- Prompt 变短等于行为更好；
- tool schema 较大就是应该 deferred loading。

这些判断需要后续 evaluation 或 Evidence 门。

### 10.8 错误语义

- component identity 缺失：drop event。
- field policy/redaction result 缺失：drop event。
- measurement method/version 缺失：丢弃对应 measurement。
- estimator 被标成 Provider usage：batch invalid。
- Provider total 被伪分配到 component：batch invalid。
- credential/sensitive_auth：drop event。
- unknown field 或缺失 PII label：按 CRC-6 drop。
- sink unavailable：业务继续，batch 不缓存未清洗副本。
- component hash 计算失败：drop component event，不发送空 hash 冒充成功。

### 10.9 Wave E handoff

M-052 可以获得：

- 已通过 CRC-6 gate 的 `ComponentTelemetryEvent/Batch`；
- request/session/component correlation identity；
- event sensitivity、redaction/drop 结果；
- 明确的 estimator/Provider measurement source。

M-052 不能假设：

- local buffering、flush、rotation 或 retention 已完成；
- 可以把 dropped event 原文重新读取写盘；
- debug log 等于可复现最终请求；
- sink failure 可以影响 Agent Outcome；
- full dump 已获得访问许可。

## 11. DRC-5 — Shell Command Structural Policy

### 11.1 目标

把 shell command 解析为不执行的结构化 AST 与风险事实，在 `shadow` 或 `enforced` 状态下与现有 policy 组合。

DRC-5 不替代 Plan Mode allowlist，不实现 M-065 binary/env defense，也不创建新的 permission vocabulary。

### 11.2 Policy state

```ts
type CommandPolicyMode =
  | 'shadow'
  | 'enforced';

interface CommandPolicyState {
  command_policy_protocol_version: string;
  policy_ref: IntegratedContractRef;
  mode: CommandPolicyMode;
  shell_dialect: string;
  grammar_version: string;
  complexity_policy_ref: string;
  plan_allowlist_policy_ref: string;
}
```

`mode` 必须来自受信 runtime configuration。Prompt、用户命令正文、模型建议或 telemetry 不能切换 shadow/enforced。

### 11.3 Evaluation input

```ts
interface CommandPolicyEvaluationInput {
  evaluation_protocol_version: string;
  action_snapshot_id: string;
  command_content_ref: string;
  command_hash: string;
  shell_dialect: string;
  control_mode_snapshot_id: string;
  working_directory_snapshot_id: string;
  plan_allowlist_decision_ref: string;
  argument_policy_decision_ref: string;
  path_policy_decision_ref: string;
  legacy_policy_decision_ref: string | null;
  policy_state_ref: string;
}
```

Parser 可以读取 command content，但不得执行 expansion、substitution、command、filesystem mutation 或环境解析副作用。

### 11.4 Parse result

```ts
type CommandParseStatus =
  | 'parsed'
  | 'invalid_syntax'
  | 'unsupported_syntax'
  | 'too_complex';

interface CommandRiskFact {
  fact_id: string;
  kind:
    | 'command'
    | 'pipeline'
    | 'redirect'
    | 'substitution'
    | 'expansion'
    | 'control_flow'
    | 'environment_assignment'
    | 'executable_candidate';
  source_range_ref: string;
  risk_code: string;
}

interface CommandParseResult {
  parse_protocol_version: string;
  parse_result_id: string;
  action_snapshot_id: string;
  command_hash: string;
  shell_dialect: string;
  grammar_version: string;
  status: CommandParseStatus;
  ast_ref: string | null;
  risk_facts: CommandRiskFact[];
  complexity_metrics: Readonly<Record<string, number>>;
  diagnostics: string[];
}
```

`environment_assignment` 和 `executable_candidate` 只输出语法事实；它们是否安全属于 Wave E M-065。

### 11.5 Shadow result

```ts
interface CommandShadowComparison {
  shadow_protocol_version: string;
  comparison_id: string;
  action_snapshot_id: string;
  legacy_decision_ref: string;
  ast_candidate_behavior: 'allow' | 'ask' | 'deny' | null;
  divergence:
    | 'none'
    | 'legacy_more_permissive'
    | 'ast_more_permissive'
    | 'classification_mismatch'
    | 'not_comparable';
  reason_codes: string[];
  decision_trace_event_id: string;
}
```

Shadow mode：

1. 实际执行仍使用被冻结的现行 policy 结果。
2. AST candidate 不能 allow、ask、deny、取消或修改动作。
3. divergence 只进入 CRC-6 允许的 decision trace/telemetry。
4. telemetry 不可用时不影响现行 decision。
5. shadow 不是“部分 enforcement”，也不能对某些命令静默生效。

### 11.6 Enforced decision composition

Enforced mode 采用硬门组合：

```text
Plan allowlist decision
  AND argument policy
  AND path policy
  AND AST structural policy
  AND RC-5 permission
```

```ts
interface CommandStructuralDecision {
  structural_decision_protocol_version: string;
  structural_decision_id: string;
  action_snapshot_id: string;
  parse_result_id: string;
  policy_state_ref: string;
  mode: CommandPolicyMode;
  candidate_behavior: 'allow' | 'ask' | 'deny' | null;
  effective_security_decision_ref: string | null;
  gate_decision_refs: string[];
  reason_codes: string[];
  status: 'valid' | 'invalid';
}
```

Shadow mode 的 `effective_security_decision_ref` 必须为 `null`；无法解析出候选判定时使用 `candidate_behavior=null` 与 `divergence='not_comparable'`。Enforced mode 的有效结果必须具有非空 `candidate_behavior`，并引用由 RC-5 vocabulary 表达、绑定同一 action snapshot 的 `SecurityDecision`。

组合规则：

1. 任一硬门 `deny` → 最终 deny。
2. 没有 deny 且至少一个硬门 `ask` → 阻塞 ask。
3. 全部门明确 allow 才允许执行。
4. Plan Mode 未知命令保持默认拒绝；用户决定只能退出/切换模式，不能在 Plan Mode 内把该动作批准为 allow。
5. Normal Mode 的 unsupported/too-complex 按受信风险 policy 得到 ask 或 deny，不能默认 allow。
6. ask channel unavailable → deny。
7. AST decision 必须输出 RC-5 `SecurityDecision`，并引用同一 action snapshot。
8. enforcement failure 不能回退到 shadow 后继续执行。

### 11.7 AST policy rules

至少结构化识别：

- command sequence 与 control operator；
- pipeline；
- input/output redirect；
- command substitution；
- variable/parameter expansion；
- subshell/grouping；
- executable candidate；
- leading environment assignment；
- parser complexity。

规则：

1. shell dialect 必须显式，不能用当前 OS 名称猜语法。
2. grammar/version 不匹配时 unsupported，不使用另一 shell 猜解析。
3. parser 不执行 expansion 或解析实际 secret 值。
4. `too_complex` 由确定性阈值产生，不由 Agent“感觉复杂”。
5. source ranges 必须可回指原命令 snapshot。
6. parser normalization 不得改变引号、转义或操作符语义。
7. AST policy 不负责 executable resolution、PATH trust、loader variable 或 binary hijack。
8. Plan allowlist、argument/path policy 与 AST 是独立证据，不互相覆盖。
9. 决策解释只使用 reason/risk codes，不记录隐藏思维。

### 11.8 Activation gate

从 shadow 切换到 enforced 至少需要：

- 目标 shell dialect 的 grammar/version 已冻结；
- 基准 corpus 覆盖 substitution、redirect、pipeline、control flow 和 quoting；
- legacy/AST divergence 有明确分类；
- false allow/false deny 基线已记录；
- `too_complex` policy 已冻结；
- Plan allowlist/argument/path/RC-5 composition 已验证；
- action snapshot 与 blocking ask 可持久化；
- rollback 只切换 policy state，不修改历史 decision。

这些是 Activation 门，不新增 M-055 或 M-065 为 DRC-5 设计前置。

### 11.9 错误语义

- shell dialect 未知：unsupported。
- grammar version 缺失：evaluation invalid。
- AST parser 异常：Plan Mode deny；Normal Mode 按风险 policy ask/deny。
- too complex：确定性 ask/deny，不 allow。
- action snapshot/hash 不匹配：deny。
- Plan allowlist/argument/path decision 缺失：deny。
- shadow comparator 缺失：仍可产生 parse result，但不能声称 shadow comparison 完成。
- enforced 状态发生 parser failure：不能回退 legacy allow。
- decision trace 写入失败：不改变 SecurityDecision。

### 11.10 Wave E handoff

M-065 可以获得：

- 不可变 `CommandParseResult`；
- executable candidate 与 environment-assignment syntax facts；
- shell dialect、grammar version 和 source ranges；
- action snapshot 与 RC-5 decision identity；
- AST policy 已处理的 substitution/control-flow 风险。

M-065 不能假设：

- executable 已可信或已完成真实路径解析；
- PATH、loader variable 或 inline env assignment 已安全；
- AST allow 可以覆盖 M-063 environment scrub；
- Plan Mode allowlist 已被 AST 替代；
- M-065 可以改写历史 AST/SecurityDecision。

## 12. 跨契约不变量

### INV-D1 — Snapshot 一致

每个 DRC 的输入、输出和下游引用必须绑定同一 request/action/context snapshot；不得混用刷新前后的 mode、tool view、source 或 policy。

### INV-D2 — Profile 不删除 Mandatory

DRC-1 只能排除 optional/capability-specific section。没有明确 false condition evidence 的 mandatory section 必须保留。

### INV-D3 — Mode 是结构化状态

Prompt 文本、用户输入、文件内容和模型自报不能创建或切换 mode profile。

### INV-D4 — Placement 不等于 Authority

Meta user placement、system placement、Memory channel 和 tool plane 都不能隐式提升或降低 Authority。

### INV-D5 — Project Instruction 与 Auto Memory 分权

两条通道不得互相转换、共享 admission、共享 writer 或借共享存储提升 Authority。

### INV-D6 — Admission 与 Use 分离

Memory admit 只允许进入持久化阶段；只有绑定当前 context 的 use decision 才允许 claim 被后续选择。

### INV-D7 — Confidence 不等于事实

任何 confidence 值都不能替代 evidence、freshness、Trust、Authority、admission 或 use verification。

### INV-D8 — Meta 不等于 Retained

`is_meta=true` 只建立消息类别；Retention 必须由 Wave E M-038 独立决定。

### INV-D9 — Reference 校验最终视图

Tool reference integrity 只以 final immutable tool view 和 compiled Prompt snapshot 为输入，不以 base Registry 代替。

### INV-D10 — Name 不等于 Manual

工具名称解析成功不证明复杂工具说明充分，也不授予 permission。

### INV-D11 — Telemetry 只观察

Telemetry event、hash、metric、drift 或 sink 状态不能改变 Prompt、Memory、tool view、SecurityDecision 或 TurnOutcome。

### INV-D12 — Measurement 来源显式

Estimator 与 Provider usage 必须用不同 kind/scope/method 标记；禁止伪造 component 级 Provider token。

### INV-D13 — 先最小化和清洗再发送

正文默认不采集；任何 production event 必须先经过 CRC-6 allowlist、PII classification 和 redaction/drop。

### INV-D14 — Shadow 无执行权

DRC-5 shadow result 不改变任何实际执行、permission、ask 或 Outcome。

### INV-D15 — AST 与 Plan Policy 是 AND

AST 只能增加结构化风险证据，不能覆盖 Plan allowlist、argument/path policy 或 RC-5 permission。

### INV-D16 — Failure 不升级状态

Profile、activation、admission、validation、telemetry、parser 或 sink 失败不能产生 include、trusted、admit、use、valid、sent、allow 或 completed。

### INV-D17 — 版本正交

Profile、activation、admission、memory use、reference manifest、reference validation、component telemetry、token measurement、command parse、shadow comparison 和 SecurityDecision protocol 独立版本化。

### INV-D18 — 不新增冻结 D-edge

DRC-1 与 DRC-3 没有 Wave E 直接 D-edge；DRC-4 不成为 DRC-5 前置；DRC-2 内两个子协议不互相形成 D-edge。

## 13. 兼容与废止关系

| 当前语义 | Wave D 结论 |
|---|---|
| Normal/Plan 两套 Prompt 拼接 | 迁移证据；最终由结构化 profile selection 表达 |
| mode 通过 Prompt 文案体现 | 文案只解释，结构化 control mode 才是输入 |
| 项目规则未进入请求 | 通过 M-008 meta context activation 建立独立通道 |
| system-generated user message 被当作普通历史 | M-008 标记 meta；Retention 留 M-038 |
| memory tool 可直接写字符串 | 新 Auto Memory 必须先 typed candidate + admission；显式用户工具行为另行映射 |
| 读取 Memory 后直接相信 | 必须产生 current-context `MemoryUseDecision` |
| Prompt 手写工具名 | 迁移为 reference manifest + final-view validation |
| tool Registry 存在即视为引用正确 | 废止；必须检查 overlay 后 final tool view |
| `chars/4` 粗估 token | 可保留 baseline estimator，但必须带 method identity，不能冒充 Provider usage |
| Provider 总 token | 保留 request aggregate，不伪分配到 section |
| debug 日志可写任意 payload | 必须先走 CRC-6 field/redaction gate |
| bash parser/denylist | 可作为 shadow comparator；不自动成为 AST truth source |
| AST allow 即可执行 | 禁止；仍需 Plan/argument/path/RC-5 全部门允许 |
| parser 异常回退旧 allow | 废止；enforced failure fail closed |

## 14. Wave E Handoff 总表

| Wave E 机制 | 消费 Wave D | 可以依赖 | 禁止假设 |
|---|---|---|---|
| M-038 Meta Context Retention | DRC-2/M-008 | meta message identity、isMeta、Placement、provenance、unassigned retention | meta 已 retained；meta 提升 Authority |
| M-045 Two-Step Memory Persistence | DRC-2/M-044 | admitted decision、accepted type/scope、evidence、verification requirements | admit 等于已写入；writer failure 改变 Outcome |
| M-046 Memory Search Guidance | DRC-2/M-044 | admission metadata、verification requirements、检索后 use-decision gate | admission/selection 等于 use；selection 提升 Trust |
| M-052 Buffered Local Debug Logging | DRC-4/M-055 | 已清洗 component events、correlation identity、measurement source | full dump、buffer、rotation、retention 已完成 |
| M-065 Binary/Env Defense | DRC-5/M-064 | AST syntax facts、executable/env nodes、action/decision identity | executable/env 已安全；AST 替代 M-063 |

DRC-1/M-048 与 DRC-3/M-028 没有 Wave E 直接 D-edge。它们的结果继续作为全局已冻结能力存在，但不得为了“统一 handoff”人为添加到 Wave E 节点。

## 15. 防御边界

| 高频失败 | Wave D 防护原则 |
|---|---|
| profile 漏掉 mandatory section | selection invalid，请求不编译 |
| mode 从用户文本猜测 | 拒绝，必须使用 control mode snapshot |
| project instruction 写入 Memory | channel mismatch，拒绝 |
| memory admit 后永久相信 | 每次使用绑定 current-context verification |
| confidence 为 1 就提升 Authority | 禁止，仍需 evidence/freshness/use decision |
| meta message 被当作当前用户 | 独立 identity/isMeta/placement |
| meta message 被当作永久 retained | retention_state 保持 unassigned，交给 M-038 |
| Prompt 引用 excluded tool | validation invalid，请求不发送 |
| no-tools Prompt 残留工具名 | protocol error |
| estimator 冒充 Provider token | batch invalid |
| telemetry 请求正文 | 默认不采集；未经 CRC-6 gate 则 drop |
| hash 被宣称匿名化 | 禁止该结论 |
| shadow AST 改变执行 | 协议违规 |
| enforced parser 失败回退 allow | fail closed |
| AST 替代 Plan allowlist | 禁止；AND composition |
| too-complex 由 Agent 主观判断 | 使用确定性 complexity policy |
| M-065 假设 AST 已处理 PATH/env | handoff 明确禁止 |

## 16. 规格级验收矩阵

### DRC-1

1. mode/profile 输入来自结构化 snapshot。
2. profile definition 来源受信且版本化。
3. mandatory coverage 可机器验证。
4. optional exclude 有 reason code。
5. profile 不改变 content/hash/Authority/Trust/Placement。
6. capability unknown 不乐观 include。
7. static/dynamic 不被 profile 重分类。
8. 明确无 Wave E 直接 D-edge。

### DRC-2

1. Project Instruction 与 Auto Memory 使用封闭 channel。
2. route、activation、admission、use、persistence、selection、retention 分离。
3. Meta context 不进入 system 或 current-user plane。
4. `is_meta` 不提升 Trust/Authority/Retention。
5. `MemoryAdmissionDecision` 与 `MemoryUseDecision` 独立。
6. confidence 范围、端点和非法值语义明确。
7. admission 默认排除 secret/临时状态/无 evidence 结论。
8. use decision 绑定 current context。
9. writer failure 不改变 TurnOutcome。
10. Wave E handoff 覆盖 M-038/M-045/M-046。

### DRC-3

1. 校验输入是 final tool view 与 compiled Prompt。
2. 每个 reference 唯一解析到可见 tool ID。
3. manual identity 和 policy projection 一致。
4. excluded/no-tools 工具引用被拒绝。
5. scanner 不用模型语义猜引用。
6. validation 不改变 tool view/permission/order。
7. 同 snapshot 重复校验确定。
8. 明确无 Wave E 直接 D-edge。

### DRC-4

1. component identity 来自冻结 stable ID。
2. bytes/chars/tokens 都携带 measurement method。
3. estimator 与 Provider usage 明确分离。
4. Provider aggregate 不伪分配到 section。
5. 正文默认不采集。
6. production event 先通过 CRC-6 gate。
7. telemetry 不参与业务或安全判定。
8. sink failure 不改变 Outcome。
9. Wave E handoff 覆盖 M-052。

### DRC-5

1. shadow/enforced 是结构化受信状态。
2. parser 不执行 command、expansion 或 substitution。
3. shell dialect/grammar version 显式。
4. too-complex 由确定性 policy 产生。
5. shadow 不改变执行。
6. enforced 使用 Plan/argument/path/AST/RC-5 AND composition。
7. Plan unknown 保持拒绝，不能在 Plan 内批准执行。
8. parser failure 不回退 allow。
9. M-064 不实现 M-065 的 env/binary 安全结论。
10. Wave E handoff 覆盖 M-065。

### 跨契约

1. INV-D1～INV-D18 无冲突。
2. 五个 DRC 覆盖六个 Wave D 机制且无重复主责。
3. 五个 Wave E 机制全部有明确上游 handoff。
4. DRC-1/DRC-3 未被添加为 Wave E 直接依赖。
5. DRC-4 未被添加为 DRC-5 前置。
6. DRC-2 两个子协议未形成相互 D-edge。
7. Runtime enforcement、Memory Authority 与 telemetry 始终分离。
8. 未选择 Prompt 原文或进入实现任务。

## 17. 设计完成标准

Wave D 只有在以下条件全部满足后才能冻结：

1. 六个机制全部映射到且仅映射到一个主 DRC。
2. 五个 DRC 都有输入、输出、不变量、错误语义和 Wave E handoff。
3. DRC-1 不允许 profile 省略 mandatory section。
4. DRC-2 冻结 Project Instruction 与 Auto Memory 禁止串线。
5. DRC-2 分离 Memory admission 与 use verification。
6. DRC-3 校验 final request，而不是静态 Registry。
7. DRC-4 分离 estimator 与 Provider usage。
8. DRC-4 默认不采集正文。
9. DRC-5 shadow 无执行权。
10. DRC-5 AST 与 Plan policy 是 AND 关系。
11. DRC-5 不提前实现 M-065。
12. INV-D1～INV-D18 可由结构化协议验证。
13. Wave E 五个机制 handoff 完整。
14. 未新增冻结 DAG D-edge。
15. 未选择、改写或嵌入 Claude Prompt 原文。
16. 未进入生产代码、实施文件、工期或 Git 操作。

## 18. 后续流程

本文审核冻结后：

1. Wave E 只能消费本文冻结的 meta identity、Memory decisions、sanitized telemetry 和 command syntax facts。
2. Wave E 不得反向修改 Wave A/B/C/D 的 identity、Trust、Authority、Placement、permission、mandatory coverage 或 measurement source。
3. Wave E 设计完成并冻结后，继续按 DAG 进入 Wave F。
4. 全部 Wave 设计冻结后，才编写主 Agent/Prompt 机制的详细实施计划。
5. Prompt Library Import 仍是独立资产快照，不改变本文任何 approved、trusted、admit、use、valid、sent、allow 或 runtime activation 状态。
