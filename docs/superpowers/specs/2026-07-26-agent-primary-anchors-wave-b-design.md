# mi-code Agent Primary Anchors — Wave B Contracts

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix、Wave A Root Contracts
> 覆盖机制：M-001、M-011、M-014、M-020、M-024、M-035、M-039、M-040、M-042、M-050、M-051、M-058、M-063、M-066、M-070
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave B 不实现十五个孤立功能，也不建立中央 Prompt、Context、Security 或 Observability Manager。它冻结七个跨 Phase、可独立演进的 Root Contract：

| Wave B Root Contract | 机制 | 机制 Owner |
|---|---|---|
| BRC-1 Prompt Compilation | M-001 | Phase 1 |
| BRC-2 Capability-Aware Tool View | M-020、M-024、M-058 | M-020/M-024=P3；M-058=P1 |
| BRC-3 Typed Context Intake | M-011、M-039、M-040、M-042、M-050 | M-011/M-039/M-042/M-050=P2；M-040=P5 |
| BRC-4 Agent Prompt Profiles | M-014、M-035 | Phase 3 |
| BRC-5 Tool Transcript Integrity | M-070 | Phase 4 |
| BRC-6 Runtime Security Gates | M-063、M-066 | Phase 5 |
| BRC-7 Observability Planes | M-051 | Phase 6 |

机制继续服从 Gap / Value Matrix 的唯一 Owner。BRC 只冻结输入、输出、状态、错误语义和跨域不变量，不要求七个实现类、七个 Registry 或七个运行时服务。

## 2. 设计目标

Wave B 必须让后续设计获得以下稳定输入：

1. system Prompt 如何从可治理 section 形成不可变快照。
2. 模型能力、工具描述和每请求 overlay 如何形成最终工具视图。
3. Context 来源如何经过来源识别、规范化、清洗、分权、预算和 provenance 处理。
4. Agent Role 与 Task Template 如何组合而不自行扩大工具或权限。
5. Provider 可见 transcript 如何保持 tool use/result 因果完整。
6. 子进程秘密和跨机器动作如何进入不可绕过的 runtime gate。
7. 不同敏感度的观测数据如何分平面管理，且不因“可观测”默认开始采集。
8. 每个 BRC 冻结后，Wave C 可以消费什么，以及不能假设什么。

Wave B 完成后，Wave C 不应重新定义 section identity、capability truth source、context source envelope、role/task identity、tool pairing、blocking ask 或 observability plane。

## 3. 明确排除

本文不设计或实施：

- Prompt precedence、replace/append 冲突解析；
- static/dynamic cache boundary；
- feature flag 或条件 section 表达式；
- 第三方模型 capability override；
- 项目规则的最终 trusted routing 或注入 Placement；
- Auto Memory 的具体类型枚举、admission、检索或失效算法；
- tool-local policy 文本、sandbox 说明或命令 AST；
- compaction 的 no-tools 专用请求；
- delegation handoff classifier；
- Prompt-injection 的模型软告警文案；
- telemetry redaction、PII taxonomy、decision dump 或生产采集；
- Prompt 原文选择、改写、批准或运行时嵌入；
- 数据库迁移、文件布局、类名、测试文件或实施批次；
- 生产代码修改、Git commit、push 或 PR。

这些能力属于 Wave C 以后或后续实施计划。Wave B 只提供它们依赖的稳定协议。

## 4. 现状与复用边界

### 4.1 已有轮子

| 现有能力 | 当前位置 | Wave B 处理 |
|---|---|---|
| system Prompt 字符串拼接 | `src/index.ts`、`src/prompts/index.ts` | 作为迁移输入；不把现有拼接顺序自动认定为新 precedence |
| Tool Registry 与 definitions | `src/agent/tool-registry.ts`、`src/agent/types.ts` | 复用 tool identity、schema 与 executor；派生 immutable request view |
| Provider adapters | `src/agent/*-stream-client.ts` | 复用传输转换；禁止 adapter 决定 capability、visibility 或 Authority |
| explore/plan/general roles | `src/agent/roles.ts`、`src/agent/subagent.ts` | 复用现有角色和过滤入口；补 role/task profile 语义 |
| MemoryManager | `src/memory/memory-manager.ts`、`src/memory/types.ts` | 复用存储能力；不把现有条目自动升级为 instruction memory |
| PermissionChecker | `src/permission/checker.ts`、`src/permission/types.ts` | 复用现有判定入口；迁移到真实阻塞的 RC-5 ask 语义 |
| StreamEventBus | `src/agent/stream-event-bus.ts` | 作为未来事件承载输入；Wave B 不默认启用新采集 |
| Compression | `src/agent/compression.ts` | 作为 M-070 检查点消费者；Wave B 不设计 no-tools compaction call |

### 4.2 已确认缺口

- Prompt 片段没有稳定 `section_id`、来源引用、哈希或 snapshot identity。
- 工具定义存在，但没有不可变 base view、显式 overlay 或 capability truth source。
- 模型能力主要由 Provider/模型名称和分支代码隐式表达。
- 项目规则、环境、Memory、Tool Result 尚未共享统一 Context Source Envelope。
- 环境字段直接拼接，缺少 allowlist、freshness 和 privacy 语义。
- instruction memory 与 auto memory 没有强制 writer/Authority 分离。
- source 截断只有局部工具结果策略，缺少 source-specific overflow contract。
- 子 Agent role、task workflow、tool visibility 和 result contract 没有统一 profile snapshot。
- tool use/result identity 已存在，但发送、持久化和压缩前没有统一 pairing validator。
- 子进程环境没有统一 scrub contract。
- Permission `ask` 仍可能继续执行，尚不是真实 blocking state。
- 日志、完整请求 dump、decision trace 和 production telemetry 没有敏感度平面。

Wave B 不直接修复上述代码；它冻结后续实现必须满足的契约。

## 5. 跨契约数据流

```text
RC-1 Prompt Asset Governance
        │ approved asset refs
        ▼
BRC-1 Prompt Compilation
        │ CompiledPromptSnapshot
        ├────────────────────────────────────────────┐
        │                                            │
        │                              BRC-7 Observability Planes
        │                                  metadata only by default
        ▼
Semantic Request Snapshot

RC-2 Tool identity/base order + RC-1 tool prompt assets + RC-5 decisions
        │
        ▼
BRC-2 Capability-Aware Tool View
        │ immutable RequestToolViewSnapshot
        ▼
Provider adapter

RC-3 DiscoveredRuleSource + environment + memory + untrusted ingress
        │
        ▼
BRC-3 Typed Context Intake
  normalize → sanitize → separate authority → budget → provenance
        │
        ▼
BoundedContextSource[]

RC-1 role/task assets + RC-4 CompletionReport + BRC-2 tool view request
        │
        ▼
BRC-4 Agent Prompt Profiles
        │ AgentPromptProfileSnapshot
        ▼
subagent/task-specific request

RC-2 tool_call_id + RC-4 failure outcome
        │
        ▼
BRC-5 Tool Transcript Integrity
        │ accept / block / protocol failure
        ▼
next request, persistence, compaction, finalization

RC-5 SecurityDecision/UserDecision
        │
        ├── BRC-6 child-process environment gate
        └── BRC-6 non-auto-approvable action gate
```

数据流不表示单一中央 orchestrator。每个消费者只接收自身需要的不可变 snapshot 或 envelope。

图中只画出 BRC-1 的 Prompt 编译观测接入点。BRC-1～BRC-6 都可以通过各自的 `component_ref` 产生 BRC-7 event envelope；这不允许它们共享敏感 payload，也不表示对应观测平面已经启用。

## 6. 共同词汇

### 6.1 Identity

Wave B 延续 Wave A 的身份分离：

| Identity | 含义 |
|---|---|
| `asset_id + asset_version` | Prompt 内容资产 |
| `registry_snapshot_id` | 一组不可变 Prompt/tool 资产视图 |
| `section_id` | 一个可治理 Prompt section |
| `capability_snapshot_id` | 某 Provider/model 的有效能力快照 |
| `tool_view_snapshot_id` | 某请求的最终工具视图 |
| `context_source_id` | 一个 Context 来源实例 |
| `profile_snapshot_id` | 一个 Agent role/task 组合 |
| `tool_call_id` | 一次具体工具调用 |
| `decision_id` | 一次 SecurityDecision |
| `event_id` | 一次观测事件 |

这些 ID 不得互相代替。

### 6.2 Snapshot

本文中的 snapshot 都满足：

1. 创建后不可变。
2. 携带自身 schema/protocol version。
3. 引用输入 snapshot 或 source identity。
4. 不持有 Provider SDK 专用对象。
5. 不能被 adapter、Agent 或 Prompt 文本反向修改。

### 6.3 Unknown

`unknown` 是有效状态，不等于 false、allow、trusted 或 empty。

- capability unknown：禁用依赖该能力的可选行为；
- trust unknown：不能进入受信通道；
- environment field unknown：不注入猜测值；
- pairing state unknown：阻止发送或最终化；
- security provenance unknown：不能 allow；
- observability sensitivity unknown：不得进入生产 telemetry。

## 7. BRC-1 — Prompt Compilation

### 7.1 目标

把已批准、已选择、已确定顺序的 system sections 编译为不可变 `CompiledPromptSnapshot`。BRC-1 负责结构化组装，不负责 Wave C 的 precedence、条件判断或 cache scope。

### 7.2 输入

```ts
interface PromptSectionInput {
  section_id: string;
  asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  placement: 'system_static' | 'system_dynamic';
  authority: string;
  trust: string;
  retention: string;
  ordinal: number;
  content: string;
  content_hash: string;
  provenance_refs: string[];
}

interface PromptCompilationInput {
  compiler_protocol_version: string;
  registry_snapshot_id: string;
  request_snapshot_id: string;
  sections: PromptSectionInput[];
}
```

输入只能包含已由上游明确纳入当前请求的 section。BRC-1 不从候选集合自行选择有效 Prompt。

### 7.3 输出

```ts
interface CompiledPromptSnapshot {
  compiler_protocol_version: string;
  compiled_prompt_snapshot_id: string;
  registry_snapshot_id: string;
  request_snapshot_id: string;
  sections: ReadonlyArray<PromptSectionInput>;
  section_order: string[];
  aggregate_hash: string;
}
```

Provider adapter 可把 `sections` 编码为 Provider system blocks，但不能改变顺序、内容或 metadata。

### 7.4 规则

1. `section_id` 在一个 snapshot 内唯一。
2. `ordinal` 在一个 snapshot 内唯一。
3. 编译顺序为 `(ordinal ASC, section_id ASC)`；`section_id` 仅作确定性兜底，不掩盖重复 ordinal。
4. `content_hash` 必须与 `content` 一致。
5. `aggregate_hash` 覆盖有序 section identity、asset version、placement 和 content hash。
6. 编译过程中 Registry 或运行态变化不能混入已捕获输入。
7. BRC-1 不把 `meta_context`、conversation 或 tool plane 复制进 system text。
8. 未批准资产不能因被传入 compiler 而自动变为 approved；上游输入验证失败时拒绝编译。
9. 空 section 输入必须拒绝；上游若决定不注入，应省略该 section，并在上游 diagnostic 中记录原因。

### 7.5 错误语义

- 重复 `section_id` 或 ordinal：编译失败。
- asset ref 不可解析或状态非 approved：编译失败。
- content hash 不匹配：编译失败。
- placement 非 system plane：编译失败。
- Provider 无法保持 section order：请求不得发送。
- 编译期间输入变化：继续使用已捕获 snapshot，不重新读取 mutable state。

### 7.6 Wave C handoff

Wave C 可以获得：

- 稳定的 `PromptSectionInput`；
- 确定性 section order；
- 不可变 `CompiledPromptSnapshot`；
- section、asset、request 和 aggregate identity；
- 不依赖 Provider SDK 的编译边界。

Wave C 不能假设：

- BRC-1 已定义 override/append/replace precedence；
- `system_static` 已等于可缓存；
- capability 或 feature flag 已决定 section 是否出现；
- Claude 的 Prompt 顺序就是 mi-code 的目标 precedence；
- compiler 可读取 mutable Registry 或直接选择候选资产。

直接消费者：M-002、M-003、M-004。

## 8. BRC-2 — Capability-Aware Tool View

### 8.1 目标

从 Wave A immutable base tool snapshot、工具 Prompt metadata、模型能力和当前请求限制派生最终工具视图。它不修改 base schema，也不替代 PermissionChecker。

### 8.2 Capability snapshot

```ts
type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

interface ModelCapabilitySnapshot {
  capability_protocol_version: string;
  capability_snapshot_id: string;
  provider_id: string;
  model_id: string;
  adapter_version: string;
  source: 'provider_adapter_default';
  capabilities: Readonly<Record<string, CapabilitySupport>>;
  diagnostics: string[];
}
```

规则：

1. capability 来自 Provider adapter 的显式默认声明，不从模型名称字符串猜测。
2. `unknown` 采用安全默认：不启用依赖该能力的可选字段、工具或 Prompt。
3. Wave B 不允许 runtime Agent 修改 capability。
4. 第三方 endpoint override 属于 Wave C M-059。
5. capability snapshot 与 Prompt asset version、Completion protocol version 正交。

### 8.3 Tool-local Prompt metadata

```ts
interface ToolPromptMetadata {
  tool_id: string;
  description_asset_ref: {
    asset_id: string;
    asset_version: string;
  } | null;
  required_capabilities: string[];
  declared_policy_refs: string[];
  evaluation_status: 'approved' | 'candidate' | 'rejected';
}
```

`declared_policy_refs` 只声明工具说明与哪些 runtime policy 对齐，不把文本声明当作 enforcement。

### 8.4 Request overlay

```ts
interface ToolViewOverlayInput {
  base_tool_snapshot_id: string;
  capability_snapshot_id: string;
  control_mode: string;
  role_id: string | null;
  security_policy_snapshot_id: string;
  requested_visibility: Readonly<Record<string, 'include' | 'exclude'>>;
}

interface RequestToolViewEntry {
  tool_id: string;
  canonical_order: number;
  visibility: 'included' | 'excluded';
  exclusion_reason_code: string | null;
  description_asset_ref: {
    asset_id: string;
    asset_version: string;
  } | null;
  provider_annotations: Readonly<Record<string, string | number | boolean>>;
}

interface RequestToolViewSnapshot {
  tool_view_protocol_version: string;
  tool_view_snapshot_id: string;
  base_tool_snapshot_id: string;
  capability_snapshot_id: string;
  security_policy_snapshot_id: string;
  entries: ReadonlyArray<RequestToolViewEntry>;
}
```

### 8.5 Overlay 不变量

1. overlay 只能排除工具或附加已知 Provider annotation，不能新增 base snapshot 中不存在的工具。
2. overlay 不能修改 `tool_id`、canonical order、parameters schema 或 executor。
3. role/mode 请求只能进一步收窄可见性。
4. Prompt 文本不能把 excluded 工具恢复为 included。
5. capability 为 unsupported/unknown 且工具明确依赖该能力时，工具必须 excluded。
6. description asset 必须 approved；candidate/rejected 不进入 Provider schema。
7. 最终 included entries 保持 base snapshot 相对顺序。
8. tool description 的权限声明不得超过 runtime policy。
9. Provider adapter 只能转换 `included` entries，不重新过滤或排序。

### 8.6 错误语义

- capability snapshot 缺失、过期或 model/provider 不匹配：相关可选能力禁用；无法形成基础请求时停止。
- overlay 引用未知 tool ID：overlay 无效。
- requested include 违反 base/capability/security 限制：保持 excluded，并记录 reason code。
- approved description asset 不可解析：对应工具不得暴露。
- Provider 不支持必需 tool schema 语义：返回 capability error，不降级为 system 文本模拟工具。

### 8.7 Wave C handoff

Wave C 可以获得：

- provider/model 的三态 capability snapshot；
- tool-local Prompt metadata identity；
- immutable base → per-request view 的派生协议；
- included/excluded 的结构化 reason code；
- mode、role、capability、security 对同一 tool view snapshot 的引用。

Wave C 不能假设：

- 第三方兼容 endpoint 已可信覆盖 capability；
- tool description 是 policy truth source；
- overlay 可以修改 schema、executor 或 permission；
- excluded 工具可通过 Prompt 指令恢复；
- sandbox、路径和网络限制已被写入工具说明；
- `unknown` capability 可以乐观启用。

直接消费者：M-004、M-026、M-031、M-059。

## 9. BRC-3 — Typed Context Intake

### 9.1 目标

为项目规则候选、环境、Memory、Tool Result、attachment 和其他外部内容提供统一但不等权的入口 envelope。所有来源先保持 identity 和 trust 边界，再执行确定性规范化、清洗、分权、预算和 provenance 格式化。

### 9.2 Source envelope

```ts
type ContextWriterKind =
  | 'user'
  | 'trusted_instruction_loader'
  | 'auto_memory_writer'
  | 'runtime_collector'
  | 'tool_executor'
  | 'external_ingress';

interface ContextSourceEnvelope {
  context_protocol_version: string;
  context_source_id: string;
  source_class:
    | 'instruction_candidate'
    | 'auto_memory'
    | 'environment'
    | 'tool_result'
    | 'attachment'
    | 'external_content';
  source_ref: string;
  scope_ref: string;
  authority: string;
  trust: 'trusted' | 'untrusted' | 'unknown';
  freshness: {
    observed_at: string;
    expires_at: string | null;
  };
  requested_placement: string | null;
  retention: string;
  writer_kind: ContextWriterKind;
  raw_content_ref: string;
  provenance_refs: string[];
}
```

`raw_content_ref` 是受控读取引用，不表示原文可以直接进入 Prompt。

`writer_kind` 是封闭域：

- `instruction_candidate` 只接受 `user` 或 `trusted_instruction_loader`；
- `auto_memory` 只接受 `auto_memory_writer`；
- `environment` 只接受 `runtime_collector`；
- `tool_result` 只接受 `tool_executor`；
- `attachment` 与 `external_content` 只接受 `external_ingress`。

未知 writer kind 或 source class/writer 组合不匹配时拒绝 envelope，不能通过任意字符串绕过 writer 分权。

### 9.3 Environment normalization

```ts
interface NormalizedEnvironmentSnapshot {
  environment_snapshot_id: string;
  platform_family: string;
  shell_family: string | null;
  workspace_root: string;
  working_directory: string;
  repository_present: boolean;
  allowed_fields: Readonly<Record<string, string | boolean | number>>;
  omitted_field_codes: string[];
  observed_at: string;
}
```

规则：

1. 字段必须来自 allowlist。
2. 不注入完整 parent environment。
3. shell、platform、路径和 repository 字段先规范化再格式化。
4. 不可确定字段省略并记录 code，不使用猜测值。
5. privacy mode 可以进一步删除字段，不能恢复被 policy 禁止的字段。
6. 环境 snapshot 有 freshness；session resume 时必须重新验证易变字段。

### 9.4 Deterministic sanitization

```ts
interface ContextSanitizationResult {
  context_source_id: string;
  sanitization_policy_id: string;
  sanitization_policy_version: string;
  status: 'accepted' | 'transformed' | 'rejected';
  transformation_codes: string[];
  finding_codes: string[];
  sanitized_content_ref: string | null;
}
```

规则：

1. secret/path/schema 检测在 Prompt 注入前执行。
2. finding 记录类型和位置引用，不复制 secret 原值到日志。
3. ToolResultEnvelope 本身不能提升为 trusted。
4. 只有 Wave A 冻结的 trusted extraction 三重门控可以产生新的受信结构化数据；原 envelope 仍保持原 trust。
5. 模型“认为安全”不能覆盖 deterministic rejection。
6. sanitizer 不决定最终 Authority 或 Placement。

### 9.5 Instruction / Auto Memory separation

至少强制以下分离：

| 维度 | Instruction source | Auto Memory |
|---|---|---|
| 写入主体 | 用户、受信项目加载器或确定性配置流程 | 专用 auto-memory writer |
| Authority | 按 frozen Context Model 计算 | 不得自动成为项目/系统规则 |
| Placement | 由后续 trusted routing 决定 | 独立 Memory channel |
| 更新条件 | 明确用户/项目变更 | admission policy 与 evidence |
| 失败记忆 | 不适用 | 必须携带 confidence、context 和 freshness |

存储后端相同也不能合并 writer、Authority 或 loader。

### 9.6 Source size guard

```ts
interface SourceBudgetPolicy {
  source_class: string;
  max_bytes: number;
  max_lines: number | null;
  overflow_behavior: 'reject' | 'deterministic_truncate';
  policy_id: string;
  policy_version: string;
}

interface BoundedContextSource {
  context_source_id: string;
  sanitization_result_ref: string;
  budget_policy_ref: string;
  content_ref: string;
  bytes_included: number;
  lines_included: number | null;
  truncated: boolean;
  overflow_ref: string | null;
  provenance_label: string;
}
```

规则：

1. budget 按 source class 定义，不能只设全局总阈值。
2. 截断位置必须确定。
3. 截断不得静默；`truncated=true` 且必须提供 overflow metadata。
4. source guard 不负责总请求 budget 或淘汰历史。
5. 当前用户消息和 pinned working set 不按普通 source overflow 规则丢弃。
6. Claude 的 200 行、25KB、20KB/60KB 等参数不自动成为 mi-code 默认值。

### 9.7 Provenance formatting

provenance label 必须来自 envelope metadata，而不是从正文自报来源。格式化至少能表达：

- source identity；
- source class；
- scope；
- authority/trust label；
- freshness；
- truncation状态；
- source path 的安全显示形式。

格式化文字不能通过“OVERRIDE”措辞提升 Authority。

### 9.8 Intake 顺序

```text
source identity
  → platform/source normalization
  → deterministic sanitization
  → instruction/auto-memory separation
  → source-specific budget
  → provenance formatting
  → bounded source output
```

最终 Placement 与 trusted routing 属于 Wave C M-012；Wave B 不把 bounded source 自动注入请求。

### 9.9 错误语义

- source identity 缺失：拒绝。
- trust unknown：可保留为 untrusted/unknown 分析输入，但不能走受信路由。
- sanitizer 配置缺失或异常：fail closed，来源不注入。
- environment 必需字段不可验证：省略字段；若任务要求该字段则来源 unavailable。
- instruction source 使用 auto-memory writer：拒绝写入。
- budget policy 缺失：来源不注入，不采用无限预算。
- deterministic truncation 无 overflow metadata：协议错误。
- provenance path 无法安全显示：保留 source ID，省略原路径。

### 9.10 Wave C handoff

Wave C 可以获得：

- `ContextSourceEnvelope`；
- normalized environment snapshot；
- deterministic sanitization result；
- instruction/auto-memory writer 与 Authority 分离；
- per-source budget 和显式 overflow metadata；
- provenance label 的机器来源。

Wave C 不能假设：

- discovered file 已 trusted；
- Markdown 扩展名或合法 schema 已建立信任；
- bounded source 已决定 Placement；
- auto memory 已有最终类型枚举或 admission 资格；
- truncated 内容等同完整内容；
- 模型软告警可以覆盖 deterministic sanitizer；
- Claude 的预算参数适用于 mi-code。

直接消费者：M-009、M-012、M-043、M-069。

## 10. BRC-4 — Agent Prompt Profiles

### 10.1 目标

把“Agent 是什么角色”与“当前执行什么结构化任务”分开，并将二者组合为不可变 profile。Profile 只请求能力和工具视图，不授予权限。

### 10.2 Role profile

```ts
interface AgentRoleProfile {
  role_id: string;
  role_version: string;
  prompt_asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  purpose: string;
  requested_tool_ids: string[];
  required_capabilities: string[];
  completion_protocol_version: string;
  verification_requirement: string;
}
```

### 10.3 Task template

```ts
interface TaskPromptTemplate {
  task_type: string;
  template_version: string;
  prompt_asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  input_schema_id: string;
  output_schema_id: string;
  required_capabilities: string[];
  no_tool_requirement: boolean;
}
```

Role 表达长期职责；Task Template 表达一次工作流和结构化输入输出。两者版本独立。

### 10.4 Composed profile

```ts
interface AgentPromptProfileSnapshot {
  profile_protocol_version: string;
  profile_snapshot_id: string;
  role_ref: {
    role_id: string;
    role_version: string;
  };
  task_ref: {
    task_type: string;
    template_version: string;
  } | null;
  requested_tool_ids: string[];
  required_capabilities: string[];
  completion_protocol_version: string;
  prompt_asset_refs: ReadonlyArray<{
    asset_id: string;
    asset_version: string;
  }>;
}
```

实际 tool view 必须由 BRC-2 计算；profile 的 `requested_tool_ids` 不是授权。

### 10.5 不变量

1. Role 与 Task Template 不使用同一个 version 字段。
2. Profile 只能引用 approved Prompt asset。
3. Profile 声明的 capability 必须能由 BRC-2 capability snapshot验证。
4. Profile 请求的工具必须经过 mode、role、capability 和 Security overlay。
5. Task Template 不对应真实 runtime capability 时不得激活。
6. Completion protocol 必须引用 RC-4，不允许自由文本状态替代。
7. Verification role 不能仅凭自身结论产生 `completed`；父流程仍验证 evidence。
8. 子 Agent 输出默认是带 provenance 的 evidence，不自动成为受信指令。
9. 不为了覆盖 Claude Prompt 库而预建未使用角色或 task type。

### 10.6 错误语义

- role/task asset 非 approved：profile 无效。
- role 与 task capability 不兼容：profile 无效。
- task output schema 与 CompletionReport 冲突：拒绝 task template。
- requested tool 被 overlay 排除：保持排除，并向 profile 返回结构化 diagnostic。
- verification requirement 不可满足：不得启动会被错误宣称 completed 的任务。

### 10.7 Wave C handoff

Wave C 可以获得：

- role 与 task template 的正交 identity；
- profile snapshot；
- requested tools 与 actual tool view 的分离；
- CompletionReport 与 verification requirement 引用；
- child output 的 provenance 边界。

Wave C 不能假设：

- profile 请求的工具已经获批；
- delegation 已通过 permission；
- child output 是 trusted；
- Verification role 可以替代父 Agent 验证；
- Prompt 库中的每个角色都应注册；
- task template 的自然语言约束可以替代 runtime no-tools 或 Security gate。

直接消费者：M-067。M-031 可复用 task profile vocabulary，但其冻结 D-前置仍只有 M-024，不新增 DAG 边。

## 11. BRC-5 — Tool Transcript Integrity

### 11.1 目标

在下一次 Provider 请求、持久化、压缩和 finalization 前验证 tool use/result 因果完整，不自动合成看似成功的占位 result。

### 11.2 Pair state

```ts
type ToolPairState =
  | 'pending_execution'
  | 'paired'
  | 'missing_result'
  | 'orphan_result'
  | 'duplicate_result'
  | 'identity_conflict';

interface ToolPairRecord {
  session_id: string;
  turn_id: string;
  tool_id: string;
  tool_call_id: string;
  tool_use_message_ref: string;
  tool_result_message_ref: string | null;
  state: ToolPairState;
  execution_state_ref: string | null;
}

interface ToolTranscriptValidation {
  validation_protocol_version: string;
  validation_id: string;
  transcript_snapshot_id: string;
  checkpoint:
    | 'before_provider_send'
    | 'before_persistence'
    | 'before_compaction'
    | 'before_finalization';
  status: 'accepted' | 'blocked' | 'rejected';
  validator_policy_id: string;
  validator_policy_version: string;
  pair_records: ReadonlyArray<ToolPairRecord>;
  reason_codes: string[];
}
```

### 11.3 不变量

1. `tool_call_id` 在 session 内唯一。
2. 一个 result 必须引用同一 session 中一个已存在 use。
3. 一个 use 最多对应一个最终 result。
4. progress、dispatch receipt、日志或自然语言摘要不是 tool result。
5. Provider adapter 不能更换 ID。
6. `pending_execution` 只允许存在于明确的执行中状态；它会阻止下一次 Provider send、compaction 和 finalization。
7. 进程恢复所需 pending action 可存于独立执行 journal，但不能伪造成 Provider-visible result。
8. persistence 不得保存一份会被恢复为“已配对”的不完整 transcript。
9. 真实工具执行失败可以产生带匹配 identity 的失败 result；该 result 必须来自已记录的执行失败，validator 不能自行合成。
10. validation 基于不可变 transcript snapshot。
11. `ToolTranscriptValidation` 创建后不可变；对同一 `transcript_snapshot_id + checkpoint + validator_policy_id + validator_policy_version` 的重复校验必须返回确定性相同的 status、pair records 和 reason codes。异步 result 到达后必须形成新的 transcript snapshot，不能修改旧 validation。

### 11.4 确定性恢复

| 状态 | 恢复语义 |
|---|---|
| 已知工具仍在执行 | `blocked`，等待真实 result |
| result 已产生但尚未附加，且 identity 可验证 | `repairable`，只允许附加该真实 result |
| 缺少/重复 ID 或 orphan result | `rejected`，协议失败 |
| 进程恢复后执行状态不确定 | `awaiting_user` 或 failed/partial，不能猜测成功 |
| compaction 输入不完整 | 拒绝 compaction，不静默丢 pair |

`VerificationFailureKind` 仍遵守 frozen INV-9/INV-9A：分类必须基于确定性条件，Agent 不能因多次失败自行降级为 unrecoverable。

### 11.5 错误与 Outcome

- pairing 失败本身不自动决定 `partial` 或 `failed`。
- 如果存在已验证的独立交付物，可按 RC-4 产生 partial。
- 没有已验证交付物且无法恢复时产生 failed。
- 只有 `UserAborted` 产生 cancelled。
- pairing validator 异常时 fail closed，不能发送、压缩或 finalizing。

### 11.6 Wave C handoff

Wave C 可以获得：

- `ToolPairRecord` 与四个强制检查点；
- pending/paired/protocol-failure 的确定性区分；
- 禁止伪造成功 result 的硬边界；
- pairing failure 到 RC-4 Outcome 的映射约束。

Wave C 不能假设：

- M-070 已设计 compaction no-tools 请求；
- incomplete transcript 可以通过摘要修复；
- dispatch receipt、progress 或 child summary 是 tool result；
- validator 可以判断工具业务结果是否正确；
- Wave C 机制具有新的 D 边。冻结 DAG 中没有 Wave C Primary Anchor 直接依赖 M-070；其主要后续消费者仍是 M-049 和 M-033。

## 12. BRC-6 — Runtime Security Gates

### 12.1 目标

在两类 Prompt 无法可靠约束的执行边界实施硬 gate：

1. 子进程只能获得任务所需的最小环境。
2. 跨机器或来源不明的动作不能被 classifier 自动批准，必须进入真实 blocking ask。

两类 gate 共享 RC-5 SecurityDecision 词汇，但不要求共享实现模块。

### 12.2 Child-process environment gate

```ts
interface ChildProcessEnvironmentInput {
  launch_snapshot_id: string;
  launcher_kind: string;
  executable_ref: string;
  parent_environment_ref: string;
  required_variable_names: string[];
  environment_policy_id: string;
  environment_policy_version: string;
}

interface ChildProcessEnvironmentDecision {
  launch_snapshot_id: string;
  security_decision_ref: string;
  sanitized_environment_ref: string | null;
  allowed_variable_names: string[];
  removed_variable_names: string[];
  missing_required_variable_names: string[];
}
```

规则：

1. parent environment 不得整包传入子进程。
2. allow/deny 策略按 launcher kind 审计，不照搬 Claude 变量列表。
3. 日志可以记录变量名和 reason code，不记录 secret value。
4. 命令文本中的 inline assignment 属于后续 M-065；本契约只处理继承环境。
5. scrubber 异常、policy 缺失或必需安全判断未知时 deny launch。
6. wrapper 所需变量必须以显式 required list 进入策略审计。

### 12.3 Non-auto-approvable action

```ts
interface ActionProvenance {
  action_snapshot_id: string;
  origin_scope: 'local' | 'cross_machine' | 'unknown';
  origin_ref: string;
  propagation_refs: string[];
  content_trust: 'trusted' | 'untrusted' | 'unknown';
}

interface PendingSecurityDecision {
  decision_id: string;
  action_snapshot_id: string;
  session_id: string;
  status: 'awaiting_user' | 'approved_once' | 'rejected' | 'expired';
  created_at: string;
  resolved_at: string | null;
  user_decision_ref: string | null;
}
```

规则：

1. `cross_machine` 与 `unknown` action 不可由 classifier 自动 allow。
2. 有效 policy 返回 ask 后，action 必须暂停。
3. 没有可持久化 ask 通道时，ask 降级为 deny，不是 allow。
4. `approved_once` 只允许原 action snapshot 执行一次。
5. action 内容、目标、参数或 provenance 变化后旧批准失效。
6. session suspend/resume 保留 pending decision identity，并重新验证易变 action 字段。
7. 一次批准不能写成永久 auto-approval 规则。
8. 模型 soft warning 不能完成 UserDecision。

### 12.4 多 gate 合并

同一 action 同时经过多个 SecurityDecision 时继续遵守：

```text
deny > ask > allow
```

合并结果必须保留每个 deciding layer 的 decision refs，不能只保留最终文字原因。

### 12.5 错误语义

- environment policy 不存在或损坏：deny。
- sanitized environment 无法构造：deny。
- action provenance 缺失：跨边界 action 不得 allow。
- ask 无 decision ID：deny。
- UserDecision 引用过期/未知 ID：拒绝执行。
- resume 后 action snapshot 变化：旧批准失效并重新决策。
- UI/transport 无法阻塞：deny 并报告 unavailable ask channel。

### 12.6 Wave C handoff

Wave C 可以获得：

- child-process environment 的最小暴露协议；
- action provenance；
- non-auto-approvable 分类；
- 可持久化 `PendingSecurityDecision`；
- approved-once 与 action snapshot 绑定；
- 多层 decision 的确定性合并规则。

Wave C 不能假设：

- inline environment assignment 已处理；
- AST command policy 已设计；
- delegation 已自动批准；
- child output 已 trusted；
- 一次用户批准可复用到后续 action；
- ask channel 缺失时可以继续执行。

直接消费者：M-067 消费 M-066 的 action provenance 与 blocking ask。M-063 的直接后续消费者是 Wave E M-065，不为 Wave C 人为新增依赖。

## 13. BRC-7 — Observability Planes

### 13.1 目标

把开发日志、完整请求转储、decision trace 和生产 telemetry 分成不同敏感度与准入规则的数据平面。定义平面不等于启用采集。

### 13.2 Plane vocabulary

```ts
type ObservabilityPlane =
  | 'local_debug'
  | 'full_request_dump'
  | 'decision_trace'
  | 'production_telemetry';

interface ObservabilityEventEnvelope {
  observability_protocol_version: string;
  event_id: string;
  event_type: string;
  plane: ObservabilityPlane;
  occurred_at: string;
  session_ref: string | null;
  request_snapshot_ref: string | null;
  component_ref: string;
  payload_schema_id: string;
  sensitivity: 'low' | 'internal' | 'sensitive' | 'unknown';
  redaction_state: 'not_required' | 'pending' | 'redacted' | 'dropped';
  payload_ref: string | null;
}
```

### 13.3 Plane rules

| Plane | 默认状态 | 允许的最低前置 |
|---|---|---|
| `local_debug` | 可配置 | 本地边界、最小字段、明确 retention |
| `full_request_dump` | 关闭 | 显式访问控制、默认关闭、有界 retention、敏感内容告警 |
| `decision_trace` | 仅定义 envelope | Wave C M-054 定义 subsystem schema 后才可使用 |
| `production_telemetry` | 禁用 | Wave C M-056 redaction/PII/drop policy 生效后才可启用 |

### 13.4 不变量

1. plane 之间不共享“默认允许”的 payload schema。
2. 完整 Prompt、用户消息、工具结果或 secret 不得因 debug flag 自动进入 production telemetry。
3. sensitivity unknown 的事件不能进入 production telemetry。
4. redaction pending 的事件不能发送。
5. redaction failure 产生 dropped，不回退为未清洗发送。
6. event identity 与 request/section/tool/decision identity 分离。
7. observability 不能记录或推断模型隐藏思维。
8. BRC-7 只定义 envelope 和准入；字段级 schema 属于各消费者。
9. 没有 retention/access policy 的 full dump 保持关闭。

### 13.5 错误语义

- plane 未知：drop。
- payload schema 未注册：drop 并记录本地 diagnostic。
- production event redaction pending/failed：drop。
- full dump 未显式启用：不创建 payload。
- event serialization 失败：不得影响 Agent Outcome，但必须产生最小本地错误计数。
- observability sink 失败：不改变业务 SecurityDecision 或 CompletionReport。

### 13.6 Wave C handoff

Wave C 可以获得：

- 四个 observability plane 的稳定枚举；
- event identity、component/request refs 和 sensitivity；
- redaction state gate；
- full dump 默认关闭和 production telemetry 默认禁用的准入规则。

Wave C 不能假设：

- decision trace payload schema 已存在；
- PII taxonomy、redactor 或 drop policy 已完成；
- production telemetry 已启用；
- full request dump 可以复用 production sink；
- observability failure 可以改变业务 Outcome；
-“将来会清洗”足以允许当前采集原始数据。

直接消费者：M-054、M-056。

## 14. 跨契约不变量

### INV-B1 — Snapshot 不可变

BRC-1、BRC-2、BRC-3、BRC-4 和 BRC-5 的请求级输入在捕获后不可混入新 Registry、capability、policy、context 或 transcript 状态。

### INV-B2 — Identity 不混用

asset、section、tool、tool call、context source、profile、decision、event 和 protocol version 必须使用不同字段。

### INV-B3 — Provider adapter 不拥有语义

Adapter 只转换 snapshot；不能选择 Prompt、猜 capability、改变 tool visibility、提升 Trust、合成 result 或重排 section/tool。

### INV-B4 — Trust 单向不提升

untrusted/unknown source、Tool Result、child output 或跨机器内容不能由 Agent 文本判断提升为 trusted。

### INV-B5 — Runtime enforcement 优先

Prompt 中的安全、no-tools、tool preference 或 permission 文字不能覆盖 BRC-2、BRC-5、BRC-6 和 RC-5 的结构化决定。

### INV-B6 — Unknown 采用安全默认

unknown capability 不启用；unknown trust 不走受信路由；unknown provenance 不 allow；unknown sensitivity 不发送生产 telemetry。

### INV-B7 — Ask 必须阻塞

任何 BRC-6/RC-5 ask 在匹配 UserDecision 前不得进入 action execution；无阻塞通道时 deny。

### INV-B8 — Pairing 先于生命周期操作

Provider-visible transcript 在 next send、persistence、compaction 和 finalization 前必须通过 BRC-5；pending execution state只能存在于独立执行状态。

### INV-B9 — Budget 不静默

任何 source truncation 必须有确定性边界和 overflow metadata；不得把截断内容报告为完整内容。

### INV-B10 — Profile 不授予能力

Role/Task profile 只能请求 tool/capability；BRC-2 与 RC-5 决定最终可用视图和执行权限。

### INV-B11 — Observability 不等于采集许可

定义 event/plane 不代表允许构造敏感 payload、启用 full dump 或发送 production telemetry。

### INV-B12 — 版本正交

Prompt asset、compiler、capability、tool view、context、profile、pairing、SecurityDecision、CompletionReport 和 observability protocol 各自独立版本化。

### INV-B13 — Failure 不伪造成成功

sanitizer、pairing、environment gate、ask channel、redactor 或 Provider capability 失败时，不得生成虚假 approved、trusted、paired、completed 或 sent 状态。

## 15. 兼容与废止关系

| 当前语义 | Wave B 结论 |
|---|---|
| system Prompt 字符串数组直接 join | 作为迁移输入；未来由 BRC-1 section snapshot 承载 |
| Provider adapter 内隐式模型分支 | 保留传输适配；capability truth 提升为 BRC-2 snapshot |
| Plan/role 直接过滤 tools | 作为 overlay 输入；不得修改 immutable base |
| description 与 schema 同文件 | 可以保留；M-020 不强制机械拆文件 |
| 子 Agent 直接拼接环境文本 | 标记为待迁移；未来消费 BRC-3 normalized environment |
| Memory 条目无 instruction/auto 类型边界 | 保留数据但不得推断 Authority；后续迁移需显式分类 |
| streaming 中 ask 继续执行 | 与 INV-B7 冲突；M-066 activation 前必须废止 |
| 缺失 tool result 时补占位内容 | 与 BRC-5 冲突；不得作为兼容行为保留 |
| debug log 与请求内容混写 | 标记为待分层；未完成 BRC-7/M-056 前不得扩大采集 |

本文不决定迁移代码顺序；实施计划必须先建立行为保护测试，再逐入口替换。

## 16. Wave C Handoff 总表

| Wave C 机制 | 消费 Wave B | 可以依赖 | 禁止假设 |
|---|---|---|---|
| M-002 Effective Prompt Precedence | BRC-1 | section identity、明确顺序、compiled snapshot | 当前顺序就是目标 precedence |
| M-003 Static/Dynamic Boundary | BRC-1 | system_static/system_dynamic placement、section hash | static 已具备 Provider cache 收益 |
| M-004 Conditional Section Resolution | BRC-1、BRC-2 | section snapshot、capability snapshot | 模型名字符串可替代 capability |
| M-059 Third-Party Capability Override | BRC-2 | adapter default capability snapshot | Agent 可自行提升 capability |
| M-009 Environment Snapshot Section | BRC-3 | normalized、allowlisted、fresh environment | 原始 env 可直接注入 |
| M-012 Markdown Source Routing | BRC-3 | source envelope、trust、bounded content、provenance | Markdown/schema/file presence 建立信任 |
| M-043 Typed Auto Memory | BRC-3 | auto-memory writer/Authority 分离 | Claude 四类就是目标枚举 |
| M-026 Tool-Local Policy | BRC-2 + RC-5 | tool metadata、final tool view、runtime policy refs | description 是 enforcement |
| M-031 No-Tool Compaction | BRC-2 | 可构造 empty tool view | Prompt 双重警告足以禁止工具 |
| M-067 Delegation/Handoff Validation | BRC-4、BRC-6 + RC-4/RC-5 | role/profile identity、blocking ask、action provenance、CompletionReport | delegation 已批准或 child output trusted |
| M-069 Injection Suspicion | BRC-3 + RC-5 | untrusted envelope、deterministic ingress result | 模型怀疑可改变权限 |
| M-054 Decision-Subsystem Dump | BRC-7 + RC-5 | decision/event identity、decision_trace plane | 可以记录隐藏思维或未清洗输入 |
| M-056 Telemetry Redaction | BRC-7 | sensitivity、redaction state、production gate | redaction 允许扩大采集范围 |

BRC-5 没有 Wave C 的直接 D-edge。Wave C 可以遵守其全局 transcript 不变量，但不得将此理解为新增依赖或宣布 compaction/persistence 已集成 pairing validator。

## 17. 防御边界

| 高频失败 | Wave B 防护原则 |
|---|---|
| compiler 接收重复或未批准 section | 拒绝 snapshot，不自动去重 |
| capability 识别失败 | unknown → 禁用依赖能力 |
| overlay 试图新增/改写工具 | 拒绝 overlay |
| Context sanitizer 异常 | fail closed，不注入 |
| auto memory 试图写入 instruction channel | 拒绝写入 |
| source 超预算 | 显式 reject/truncate + overflow metadata |
| role 请求不可见工具 | 保持 excluded，返回 diagnostic |
| missing tool result | 阻止 send/compact/finalize，不伪造成功 |
| 子进程 scrub policy 缺失 | deny launch |
| cross-machine action 无 ask 通道 | deny |
| resume 后 action 变化 | 旧 UserDecision 失效 |
| production event 未 redacted | drop |
| full dump 未显式启用 | 不创建 payload |
| observability sink 失败 | 不改变业务 Outcome |

## 18. 规格级验收矩阵

### BRC-1

1. 能表示 stable section ID、asset ref、placement、ordinal、content hash 和 provenance。
2. 重复 ID/ordinal、未批准资产和 hash mismatch 都有确定性失败。
3. system、meta、conversation、tool plane 没有被混成一个字符串平面。
4. 明确把 precedence、conditions 和 cache policy留给 Wave C。
5. Wave C handoff 同时列出可消费产物和禁止假设。

### BRC-2

1. capability 使用 supported/unsupported/unknown 三态。
2. capability 不由模型名称猜测，unknown 不乐观启用。
3. overlay 只能收窄或附加允许的 annotation。
4. base schema、tool ID、order、executor 和 permission 不可由 overlay 修改。
5. tool description candidate/rejected 不进入请求。
6. Wave C handoff 覆盖 M-004/M-026/M-031/M-059。

### BRC-3

1. Source Envelope 同时表达 source class、Authority、Trust、Freshness、Retention 和 writer。
2. environment 先规范化和 allowlist，再进入格式化。
3. sanitizer 不记录 secret 原值，不允许模型提升 trust。
4. instruction 与 auto memory 在 writer、Authority、Placement 上分离。
5. source truncation 显式、确定且带 overflow metadata。
6. provenance 由 metadata 生成，不由正文自报。
7. Wave C handoff 覆盖 M-009/M-012/M-043/M-069。
8. `writer_kind` 是封闭域，且 source class/writer 组合不匹配时拒绝 envelope。

### BRC-4

1. Role 与 Task Template identity/version 正交。
2. profile 请求工具但不授予工具。
3. CompletionReport 与 verification requirement 显式引用。
4. child output 默认不是 trusted。
5. 不预建未使用角色或模板。
6. Wave C handoff 明确 M-067 的可用输入与禁止假设。

### BRC-5

1. tool call/result 使用 session-unique `tool_call_id`。
2. pending、paired、missing、orphan、duplicate 和 conflict 可区分。
3. next send、persistence、compaction、finalization 都有检查点。
4. 不把 progress/receipt/summary 当作 result。
5. pairing failure 不直接伪造 completed。
6. 明确声明没有 Wave C 直接 D-edge。
7. 同一 transcript snapshot、checkpoint 和 validator policy 的重复校验结果确定一致。

### BRC-6

1. child environment 不整包继承 parent env。
2. environment policy 异常时 deny。
3. cross-machine/unknown action 不可自动 allow。
4. ask 可持久化且与 action snapshot 绑定。
5. 无 ask 通道时 deny。
6. 多层 decision 保持 `deny > ask > allow`。
7. Wave C handoff 区分 M-066→M-067 与 M-063→M-065。

### BRC-7

1. 四个观测平面有不同准入语义。
2. full dump 默认关闭。
3. production telemetry 在 M-056 前禁用。
4. sensitivity unknown 和 redaction pending/failed 不发送。
5. observability failure 不改变业务 Outcome。
6. Wave C handoff覆盖 M-054/M-056。

### 跨契约

1. INV-B1～INV-B13 无内部冲突。
2. 七个 BRC 共覆盖 15 个 Wave B 机制且无重复主责。
3. 每个 BRC 都有输入、输出、不变量、错误语义和 Wave C handoff。
4. Wave C 总表覆盖全部 13 个 Policy Contracts。
5. 没有创建新的 D-edge 或改变冻结 Owner/Band/Layer。
6. 没有选择 Prompt 原文或进入实现文件、任务拆分和工期估算。

## 19. 设计完成标准

Wave B 只有在以下条件全部满足后才能冻结：

1. 15 个 Primary Anchors 全部映射到且仅映射到一个主 BRC。
2. 七个 BRC 的输入、输出、状态和错误语义完整。
3. BRC-1 不提前决定 M-002/M-003/M-004。
4. BRC-2 不把 tool description 或 capability guess 当作 policy。
5. BRC-3 不通过文件、schema 或模型判断提升 trust。
6. BRC-4 不把 role/task profile 当作权限。
7. BRC-5 不伪造 tool result，且不新增 Wave C D-edge。
8. BRC-6 的 ask 无降级路径，environment gate fail closed。
9. BRC-7 在 M-056 前不允许生产采集。
10. INV-B1～INV-B13 全部可由结构化协议验证。
11. 每个 BRC 都明确 Wave C 可以拿到什么、不能假设什么。
12. Wave C 13 个机制全部有明确上游 handoff。
13. 未选择、改写或嵌入 Claude Prompt 原文。
14. 未进入实施文件、测试任务、工期或 Git 操作。

## 20. 后续流程

本文审核冻结后：

1. Wave C 只能消费本文冻结的 snapshot、envelope、profile、decision 和 event 语义。
2. Wave C 不得反向修改 Wave A/Wave B identity、Trust、Authority、blocking ask 或 pairing contract。
3. Wave C 设计完成并冻结后，继续按 DAG 进入 Wave D。
4. 所有 Wave 设计冻结后，才编写主 Agent/Prompt 机制的详细实施计划。
5. Prompt Library Import 仍是独立资产归档流，不改变本文任何 `approved`、capability、Trust 或 runtime activation 语义。
