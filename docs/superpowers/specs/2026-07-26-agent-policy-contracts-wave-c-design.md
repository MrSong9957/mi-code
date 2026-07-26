# mi-code Agent Policy Contracts — Wave C

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix、Wave A Root Contracts、Wave B Contracts
> 覆盖机制：M-002、M-003、M-004、M-009、M-012、M-026、M-031、M-043、M-054、M-056、M-059、M-067、M-069
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave C 冻结六个 Policy Root Contract：

| Wave C Root Contract | 机制 | 机制 Owner |
|---|---|---|
| CRC-1 Prompt Resolution Policy | M-002、M-003、M-004 | Phase 1 |
| CRC-2 Trusted Capability Override | M-059 | Phase 1 |
| CRC-3 Context Routing & Memory Typing | M-009、M-012、M-043 | Phase 2 |
| CRC-4 Tool Policy & No-Tool Contract | M-026、M-031 | M-026=P3；M-031=P4 |
| CRC-5 Delegation & Injection Boundary | M-067、M-069 | Phase 5 |
| CRC-6 Observability Safety Policy | M-054、M-056 | Phase 6 |

CRC 是跨模块政策契约，不是一个中央 Policy Engine。各机制继续服从冻结 DAG 的唯一 Owner、Band、Layer 和 D-edge。

## 2. 设计目标

Wave C 必须定义：

1. 多个 Prompt 候选如何选择唯一 base，并如何处理 append。
2. section 如何确定 static/dynamic scope，且不虚构缓存收益。
3. 条件 section 如何以封闭、确定、三态的表达式求值。
4. 第三方兼容 endpoint 如何通过受信配置修正 capability。
5. environment 如何成为可注入 block，而不是原始环境转储。
6. Markdown 来源如何经过 trusted routing；文件、schema 和路径本身为什么不能建立信任。
7. Auto Memory candidate 使用什么类型和最低 metadata。
8. tool description 如何投影真实 runtime policy，而不是取代 policy。
9. no-tools 任务如何由 API/tool view 强制，而不是只靠 Prompt 警告。
10. delegation 如何经过 permission、scope propagation 和 handoff validation。
11. injection suspicion 为什么只能是软信号。
12. decision trace 如何记录确定性子系统，而不记录隐藏思维。
13. production telemetry 如何在字段 allowlist、PII 标签和 redaction 后才允许发送。
14. 每个 CRC 向 Wave D 交付什么，以及 Wave D 不能假设什么。

## 3. 明确排除

本文不设计或实施：

- Mode-Specific Prompt Profile 的最终 section 集；
- CLAUDE.md/project rules 的 meta-message 注入闭环；
- Memory admission、持久化、检索、选择或失效算法；
- tool name/reference 完整性扫描；
- shell AST parser、shadow evaluator 或 Plan Mode allowlist；
- Prompt/tool schema component telemetry；
- Memory selection、verification 或 bounded entrypoint；
- context meta retention、post-compact reinjection；
- inline environment assignment 防御；
- Prompt cache 收益度量；
- Prompt 原文选择、改写、评测、批准或嵌入；
- 实现类、文件布局、测试任务、数据迁移、工期和 Git 操作。

这些能力属于 Wave D 以后或实施计划。

## 4. 现状与复用边界

### 4.1 可复用输入

| 现有或冻结能力 | Wave C 复用方式 |
|---|---|
| RC-1 Prompt Asset Governance | 只选择 approved asset；保留 asset/version identity |
| RC-2 Placement、tool identity 和 base order | 不重新定义语义平面、tool ID 或 canonical order |
| RC-3 DiscoveredRuleSource | 作为 Markdown routing 候选，不自动 trusted |
| RC-4 CompletionReport | delegation child result 的结构化结果输入 |
| RC-5 SecurityDecision/UserDecision | tool、delegation 和 ingress 的唯一 allow/ask/deny 机器协议 |
| BRC-1 Prompt sections/snapshot | CRC-1 的候选和编译目标 |
| BRC-2 capability/tool view | CRC-1 conditions、CRC-2 override、CRC-4 no-tools 的基础 |
| BRC-3 ContextSourceEnvelope | CRC-3 routing、environment block 和 memory candidate 的输入 |
| BRC-4 AgentPromptProfile | CRC-5 delegation role/task identity |
| BRC-5 Pair Integrity | 全局 transcript 不变量；Wave C 不新增直接 D-edge |
| BRC-6 action provenance/blocking ask | CRC-5 delegation gate |
| BRC-7 observability planes | CRC-6 decision trace 与 production telemetry gate |

### 4.2 已确认缺口

- 当前 Prompt 拼接只有固定代码顺序，没有结构化 base winner、append 或排除证据。
- static/dynamic 不是显式 scope，也没有 cache telemetry。
- 条件 Prompt 由零散 `if` 拼接，缺少封闭 condition schema。
- 自定义 base URL/model 没有受信 capability override schema。
- 主 Agent 没有统一 environment section。
- Markdown 文件可以被 loader 读取，但没有统一 trust proof 和 route decision。
- Memory 条目缺少强制 type、confidence、evidence、freshness 和 invalidation metadata。
- tool description 与 runtime Permission/Plan policy 没有可验证 projection。
- compaction summary call 仍主要依赖自然语言禁止工具。
- delegation permission propagation 存在 expected failure，child output 没有统一 handoff trust envelope。
- Tool Result/attachment 等来源没有统一 injection suspicion signal。
- Permission/bash policy 没有结构化 decision trace。
- 生产 telemetry 没有字段 allowlist、PII 标签、redaction 和 drop policy。

## 5. 跨契约数据流

```text
Approved Prompt candidates
  + BRC-1 sections
  + BRC-2 base capability snapshot
        │
        ▼
CRC-1 Prompt Resolution Policy
  base winner → append set → condition result → scope classification
        │
        ▼
BRC-1 CompiledPromptSnapshot

BRC-2 adapter-default capability snapshot
  + trusted config source
        │
        ▼
CRC-2 Trusted Capability Override
        │
        ▼
EffectiveCapabilitySnapshot

BRC-3 ContextSourceEnvelope
        │
        ├── environment → CRC-3 EnvironmentContextBlock
        ├── Markdown → CRC-3 MarkdownRouteDecision
        └── auto memory → CRC-3 TypedMemoryCandidate

BRC-2 final tool view + RC-5 runtime policy
        │
        ▼
CRC-4 ToolPolicyProjection / NoToolRequestContract

BRC-4 AgentPromptProfile + BRC-6 blocking ask + RC-4 CompletionReport
        │
        ▼
CRC-5 DelegationGate / DelegationHandoffEnvelope

BRC-3 untrusted ingress
        │
        ▼
CRC-5 InjectionSuspicionSignal
        │
        └── advisory only; no permission mutation

BRC-7 event envelope + RC-5 decision identity
        │
        ▼
CRC-6 DecisionTrace / TelemetryRedactionResult
```

每条路径保持独立失败语义。一个 policy 的失败不能通过中央“最佳努力”降级为另一个 policy 的 allow。

## 6. 共同政策词汇

### 6.1 Policy identity

```ts
interface PolicyRef {
  policy_id: string;
  policy_version: string;
}

interface PolicyEvaluationRef {
  evaluation_id: string;
  policy_ref: PolicyRef;
  input_snapshot_ids: string[];
  evaluated_at: string;
}
```

所有政策决定必须引用不可变输入 snapshot 和版本化 policy。

### 6.2 Policy result

Policy result 至少区分：

```ts
type PolicyStatus =
  | 'matched'
  | 'not_applicable'
  | 'excluded'
  | 'blocked'
  | 'rejected'
  | 'unknown';
```

`unknown` 不能转为 include、trusted、allow、cacheable 或 send。

### 6.3 Explanation 与 enforcement

| 层 | 作用 |
|---|---|
| machine policy | 产生结构化选择、路由、visibility、allow/ask/deny 或 drop |
| Prompt/tool description | 向模型解释已存在的 runtime policy |
| diagnostic | 向开发者或用户解释 reason code |
| observability | 记录允许记录的 policy metadata |

自然语言解释不能成为 machine policy 的反向输入。

### 6.4 Determinism

同一 `policy_id + policy_version + immutable input snapshots` 必须产生相同机器结果。时间、环境和配置变化必须形成新 snapshot，不能修改旧 evaluation。

## 7. CRC-1 — Prompt Resolution Policy

### 7.1 目标

在 BRC-1 编译前产生唯一、可解释的 `PromptResolutionPlan`，覆盖：

- base Prompt winner；
- append sections；
- condition evaluation；
- static/dynamic scope classification。

CRC-1 不决定 Mode-Specific Profile 的具体内容，也不启用 Provider cache。

### 7.2 Prompt candidate

```ts
type PromptCandidateKind =
  | 'trusted_runtime_override'
  | 'coordinator_profile'
  | 'agent_role_profile'
  | 'approved_custom_profile'
  | 'default_base'
  | 'append_section';

type PromptCandidateOperation = 'replace_base' | 'append';
type PromptCandidateCriticality = 'mandatory' | 'optional';

interface PromptResolutionCandidate {
  candidate_id: string;
  candidate_kind: PromptCandidateKind;
  operation: PromptCandidateOperation;
  criticality: PromptCandidateCriticality;
  section_input_ref: string;
  asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  authority: string;
  trust: string;
  stable_order: number;
  condition_ref: string | null;
  dependency_snapshot_ids: string[];
}
```

只有 approved asset 和 trusted policy 产生的候选可以参与 base 选择。`criticality` 只能由受信 policy 指定，不能由 Prompt 资产正文、profile、Agent 或模型输出自行声明。

### 7.3 Base precedence

`replace_base` 候选采用以下确定顺序：

```text
trusted_runtime_override
  > coordinator_profile
  > agent_role_profile
  > approved_custom_profile
  > default_base
```

该顺序只选择“哪个 approved base Prompt 生效”，不改变 Context Authority：

1. project rules、user message、Memory、Tool Result 不允许作为 base Prompt candidate。
2. Agent 不能创建或修改 `trusted_runtime_override`。
3. override 必须来自受信配置/控制面，并绑定当前 request snapshot。
4. 同一 precedence 层出现多个有效 base candidate 是配置错误，不按顺序猜 winner。
5. 没有有效 base candidate 时 resolution 失败，不发送空 system identity。
6. `append` candidate 不参与 base winner 竞争。

### 7.4 Append policy

Append sections：

1. 必须拥有独立 `section_id` 和 asset ref。
2. 按 `(stable_order ASC, section_id ASC)` 排序。
3. stable order 重复时拒绝，`section_id` 不用于掩盖配置错误。
4. append 不得覆盖 base identity 或修改其他 section 内容。
5. append section 的 Authority、Trust、Placement 保持自身 metadata。
6. user/project context 不通过 append 偷渡到 system plane。
7. `mandatory` append 不得被 mode profile、role profile 或 custom profile 省略；只有受信 condition 明确为 false 时才是不适用。
8. `trusted_runtime_override` 只替换 base winner，不能删除 `mandatory` append。

### 7.5 Condition expression

```ts
type ConditionTruth = 'true' | 'false' | 'unknown';

type PromptCondition =
  | {
      kind: 'control_mode_is';
      expected: string;
    }
  | {
      kind: 'role_is';
      expected: string;
    }
  | {
      kind: 'capability_is';
      capability: string;
      expected: 'supported' | 'unsupported';
    }
  | {
      kind: 'trusted_config_flag_is';
      flag_id: string;
      expected: boolean;
    }
  | {
      kind: 'context_source_present';
      source_class: string;
    }
  | {
      kind: 'all' | 'any';
      children: PromptCondition[];
    }
  | {
      kind: 'not';
      child: PromptCondition;
    };

interface ConditionEvaluation {
  condition_ref: string;
  truth: ConditionTruth;
  evidence_refs: string[];
  reason_code: string;
}
```

规则：

1. condition 使用封闭 DSL，不执行任意脚本或回调。
2. 求值只读 immutable snapshots。
3. `optional` candidate 的 `unknown` 按 false 处理并记录原因。
4. `mandatory` candidate 的 `unknown` 使 resolution 失败。
5. capability condition 只消费 BRC-2 adapter-default snapshot；CRC-2 override 不反向创建新的冻结 D-edge。
6. condition 不检查 Prompt 自身文本。
7. condition 结果必须保留 evidence refs。

### 7.6 Static/dynamic scope

```ts
type PromptScopeClass = 'static' | 'dynamic' | 'unknown';

interface PromptScopeDecision {
  section_id: string;
  scope: PromptScopeClass;
  dependency_kinds: string[];
  reason_code: string;
}
```

Static 必须同时满足：

- 内容由 approved immutable asset 决定；
- 不依赖 user/session/turn；
- 不依赖 current time、CWD、environment、Memory、Tool Result 或 attachment；
- 不依赖 request-scoped override；
- 不依赖易变 config；
- 顺序在相同 Registry/policy snapshot 下稳定。

任一条件不满足即 dynamic；证据不足即 unknown，unknown 按 dynamic 处理。

Static/dynamic 只表示 cache-scope eligibility，不表示：

- Provider 一定支持 Prompt cache；
- 已获得 cache hit；
- 已节省 token/成本；
- dynamic section 可以优先被裁剪；
- system Prompt 可以被压缩。

### 7.7 输出

```ts
interface PromptResolutionPlan {
  resolution_protocol_version: string;
  resolution_id: string;
  policy_ref: PolicyRef;
  input_snapshot_ids: string[];
  selected_base_candidate_id: string;
  mandatory_candidate_ids: string[];
  included_append_candidate_ids: string[];
  excluded_candidates: ReadonlyArray<{
    candidate_id: string;
    reason_code: string;
  }>;
  condition_evaluations: ConditionEvaluation[];
  scope_decisions: PromptScopeDecision[];
  ordered_section_refs: string[];
}
```

该 plan 是 BRC-1 `PromptCompilationInput` 的上游政策证据。

### 7.8 错误语义

- 无有效 base：rejected。
- 同层多个 base：rejected。
- candidate asset 非 approved：excluded；若它是唯一 mandatory base 则 rejected。
- mandatory condition unknown：rejected。
- optional condition unknown：excluded。
- append stable order 重复：rejected。
- scope unknown：按 dynamic，不宣称 cache eligibility。
- policy/snapshot 版本缺失：rejected。

### 7.9 Wave D handoff

Wave D 可以获得：

- base winner 与 precedence evidence；
- append include/exclude 结果；
- 每个 condition 的三态结果和 evidence；
- section static/dynamic/unknown classification；
- 不可变 `PromptResolutionPlan`。

Wave D 不能假设：

- static section 已产生 cache hit；
- mode profile 的 section 集已定义；
- 安全、Completion 或 permission section 可以被 profile 省略；
- capability override 已参与 M-004；
- append 可以改变其他 section Authority；
- Claude 的 output style/profile 可以直接成为 mi-code mode。

直接消费者：M-048。

## 8. CRC-2 — Trusted Capability Override

### 8.1 目标

允许第三方兼容 endpoint 通过受信配置对 BRC-2 adapter-default capability snapshot 做显式、可审计修正。Override 是配置权，不是 Agent 权限。

### 8.2 Override record

```ts
interface CapabilityOverrideRecord {
  override_id: string;
  override_version: string;
  source_config_ref: string;
  source_trust_proof_ref: string;
  provider_id: string;
  endpoint_scope: string;
  model_scope: string;
  base_capability_snapshot_id: string;
  changes: Readonly<Record<
    string,
    'supported' | 'unsupported' | 'unknown'
  >>;
  justification: string;
}

interface EffectiveCapabilitySnapshot {
  capability_protocol_version: string;
  effective_capability_snapshot_id: string;
  base_capability_snapshot_id: string;
  applied_override_ref: string | null;
  provider_id: string;
  endpoint_scope: string;
  model_scope: string;
  capabilities: Readonly<Record<
    string,
    'supported' | 'unsupported' | 'unknown'
  >>;
  diagnostics: string[];
}
```

### 8.3 Trust gate

Override 生效必须同时满足：

1. 配置来源在 frozen trusted-config policy 内；
2. 配置通过 schema validation；
3. loader 是确定性受信 loader；
4. provider、endpoint、model scope 与当前 base snapshot 精确匹配；
5. override version 可追溯；
6. 每个 capability key 已在 capability schema 注册。

文件存在、JSON/YAML 合法或 Agent 声称“该模型支持”都不足以建立 trust。

### 8.4 Override 规则

1. Override 可以把 capability 设为 supported、unsupported 或 unknown。
2. `supported` 是“允许尝试对应 Provider 功能”，不授予 tool permission、Security allow 或更高 Authority。
3. Agent、Prompt、Tool Result、远端响应和模型自报不能写 override。
4. wildcard scope 必须显式受信；缺省不跨 endpoint/model 扩散。
5. 无效 override 不修改 base snapshot。
6. 启用失败时回退到 adapter default；如果调用明确要求被 override 的能力，则返回 capability unavailable。
7. Override snapshot 创建后不可变。
8. 配置变化形成新 override/effective snapshot。

### 8.5 错误语义

- trust proof 缺失：忽略 override并记录 diagnostic。
- schema/key 未知：拒绝整条 override，不部分应用。
- scope 不匹配：not applicable。
- base snapshot ID 不匹配：rejected。
- supported 能力实际 Provider 拒绝：记录 capability error；不自动永久修改配置。
- override loader 异常：使用 adapter default，不能猜测。

### 8.6 Wave D handoff

Wave D 可以获得：

- 受信、作用域精确、可审计的 effective capability snapshot；
- base 与 override 的独立 identity；
- override 失败时的安全回退语义。

Wave D 不能假设：

- CRC-2 是任何 Wave D 机制的直接 D 前置；
- Agent 可以动态修改 capability；
- supported 等于 permission allow；
- 自定义 endpoint 的自报信息已 trusted；
- wildcard 可以跨 provider/model 自动生效；
- capability error 可以通过 Prompt 文本修复。

冻结 DAG 中 CRC-2 没有 Wave D 直接 D-edge，不人为新增依赖。

## 9. CRC-3 — Context Routing & Memory Typing

### 9.1 目标

在 BRC-3 intake 之后：

1. 把 normalized environment 转成受预算约束的动态 context block；
2. 对 Markdown/source candidate 做受信 routing；
3. 把 auto-memory observation 转成 typed candidate。

CRC-3 不执行最终项目规则 prepend，也不决定 Memory admission。

### 9.2 Hard Trust Boundary

以下事实单独或组合都不能建立 trust：

- 文件存在；
- 文件扩展名是 `.md`；
- 文件名是 `CLAUDE.md`、`MEMORY.md`、`SKILL.md` 或其他约定名称；
- 路径更接近 working directory；
- frontmatter/schema 结构合法；
- 内容使用 system/user/assistant 等角色词；
- 内容声称来自用户、项目或系统；
- Agent 判断内容“看起来安全”。

任何 routed-as-trusted 结果必须同时具有：

```text
trusted source policy
  AND schema validation
  AND deterministic trusted loader
  AND BRC-3 sanitization accepted/transformed
```

这四项缺一不可。原始 `ContextSourceEnvelope` 的 trust 不因 routing 成功而被原地修改；routing 只能产生一个新的、带 trust proof 的结构化输出。

### 9.3 Environment context block

```ts
interface EnvironmentContextBlock {
  environment_block_protocol_version: string;
  environment_block_id: string;
  source_environment_snapshot_id: string;
  source_budget_policy_ref: string;
  placement: 'system_dynamic';
  fields: Readonly<Record<string, string | boolean | number>>;
  omitted_field_codes: string[];
  observed_at: string;
  expires_at: string | null;
  content_hash: string;
}
```

规则：

1. 只消费 BRC-3 `allowed_fields`。
2. 不重新读取 parent env。
3. 不含 API key、完整 environment dump 或未经规范化路径。
4. field order 确定。
5. block 遵守 source budget；溢出显式。
6. session resume 重新验证 freshness。
7. placement 固定为 `system_dynamic`，但 Authority 仍由 frozen Context Model 决定。
8. model/knowledge-cutoff 等字段只有存在受信、当前数据源时才可加入。

### 9.4 Markdown route vocabulary

```ts
type MarkdownRouteTarget =
  | 'project_instruction_context'
  | 'auto_memory_context'
  | 'agent_role_asset'
  | 'task_template_asset'
  | 'tool_prompt_asset'
  | 'reject';

interface MarkdownSourceRouteInput {
  context_source_id: string;
  source_policy_id: string;
  schema_id: string;
  loader_id: string;
  loader_version: string;
  sanitization_result_ref: string;
  bounded_source_ref: string;
}

interface MarkdownRouteDecision {
  route_protocol_version: string;
  route_decision_id: string;
  policy_ref: PolicyRef;
  context_source_id: string;
  target: MarkdownRouteTarget;
  trust_proof_refs: string[];
  placement_request: string | null;
  authority: string;
  retention: string;
  reason_code: string;
}
```

Route target 语义：

| Target | 含义 |
|---|---|
| `project_instruction_context` | 可供 Wave D M-008 构造 meta context；不是 system base |
| `auto_memory_context` | 进入 Memory candidate/admission 路径；不是 project instruction |
| `agent_role_asset` | 进入 RC-1 asset governance；不直接激活 role |
| `task_template_asset` | 进入 RC-1 asset governance；不直接激活 task |
| `tool_prompt_asset` | 进入 M-020 metadata/governance；不直接修改 tool description |
| `reject` | 不进入任何 Prompt/Memory 路径 |

### 9.5 Routing 不变量

1. route policy 基于 source policy 和 loader identity，不基于正文自报。
2. schema validation 只证明结构，不证明内容可信。
3. project instruction route 不等于已注入；M-008 仍需独立 Placement/retention。
4. auto memory route 不等于已存储；M-044 仍需 admission。
5. agent/task/tool asset route 不等于 approved；RC-1 仍需 provenance、license、evaluation。
6. 路径层级只确定 scope，不自动提升 Authority。
7. symlink/path escape/sanitization failure 不能通过 route 继续。
8. unknown source policy/loader/schema 产生 reject。
9. Agent 无权修改 route target 或 trust proof。

### 9.6 Typed Auto Memory

mi-code 冻结四个初始 candidate type：

```ts
type AutoMemoryType =
  | 'user_preference'
  | 'project_fact'
  | 'workflow_pattern'
  | 'failure_observation';

interface TypedMemoryCandidate {
  memory_candidate_protocol_version: string;
  memory_candidate_id: string;
  source_context_id: string;
  type: AutoMemoryType;
  claim: string;
  scope_ref: string;
  evidence_refs: string[];
  confidence: number;
  observed_at: string;
  expires_at: string | null;
  context_refs: string[];
  invalidation_conditions: string[];
  sensitivity_labels: string[];
}
```

类型语义：

| Type | 用途 | 禁止 |
|---|---|---|
| `user_preference` | 用户稳定表达的工作偏好 | 推断敏感属性、把单次请求当长期偏好 |
| `project_fact` | 有证据的项目结构/约束事实 | 保存易变状态却无 freshness/invalidation |
| `workflow_pattern` | 经验证的项目操作或排障路径 | 把任意命令保存为必须执行的规则 |
| `failure_observation` | 某上下文中失败的路径和证据 | 自动升级为永久禁止规则 |

### 9.7 Memory candidate 不变量

1. `confidence` 范围为 0～1。
2. evidence refs 为空时不得形成 candidate。
3. failure observation 必须含 context refs 和 invalidation conditions。
4. cancelled turn 不自动生成 failure observation。
5. secret、credential、短期 token、原始 tool dump 不形成 candidate。
6. candidate 不具有 instruction Authority。
7. candidate 不能自行决定 store、replace、merge 或 delete。
8. retrieved memory 使用前验证属于 M-044，不在本契约假装完成。
9. Claude 的四类记忆不作为 mi-code 类型来源；上述类型由当前使用语义定义。

### 9.8 错误语义

- environment snapshot 过期且无法刷新：不注入 block。
- route trust gate 任一项失败：reject。
- target 与 source class 不兼容：reject。
- typed memory evidence 缺失：reject candidate。
- confidence 越界：reject candidate。
- unknown memory type：reject candidate。
- writer 不是 BRC-3 `auto_memory_writer`：reject candidate。
- admission policy 未存在：candidate 可保留为待评估输入，但不得存储。

### 9.9 Wave D handoff

Wave D 可以获得：

- freshness-aware `EnvironmentContextBlock`；
- 带四重 trust proof 的 `MarkdownRouteDecision`；
- project instruction、auto memory、role/task/tool asset 的分离 route；
- 四类 `TypedMemoryCandidate` 和最低 evidence/confidence/freshness/invalidation schema。

Wave D 不能假设：

- Markdown、schema、文件名、路径或内容自报建立 trust；
- project instruction route 已完成 M-008 注入；
- memory candidate 已通过 M-044 admission；
- environment block 可以包含原始 env；
- candidate confidence 等于事实正确；
- failure observation 是永久禁止规则；
- routed asset 已 approved。

直接消费者：M-008、M-044。

## 10. CRC-4 — Tool Policy & No-Tool Contract

### 10.1 目标

建立统一事实来源：

- runtime policy 决定工具是否可见、可调用和需不需要 ask；
- tool description 只投影已存在的 policy；
- no-tools task 由空工具视图和 runtime rejection 强制。

### 10.2 Tool policy projection

```ts
interface ToolPolicyProjectionInput {
  tool_id: string;
  tool_view_snapshot_id: string;
  security_policy_snapshot_id: string;
  policy_decision_refs: string[];
  description_asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  dynamic_constraint_refs: string[];
}

interface ToolPolicyProjection {
  projection_protocol_version: string;
  projection_id: string;
  tool_id: string;
  source_policy_snapshot_id: string;
  source_tool_view_snapshot_id: string;
  description_asset_ref: {
    asset_id: string;
    asset_version: string;
  };
  rendered_constraint_ref: string;
  rendered_constraint_hash: string;
  reason_codes: string[];
}
```

### 10.3 Projection 规则

1. description 中的权限、安全、路径、网络和并行说明必须能追溯到 runtime policy。
2. projection 不能产生新的 allow、ask 或 deny。
3. 动态约束只从受信 policy snapshot读取。
4. secret、完整 deny/allow internal list 和不必要敏感路径不进入 description。
5. projection 失败时，安全关键工具不得用过时约束继续暴露；应 excluded 或使用已验证的安全 base description。
6. description asset 必须 approved。
7. tool-local text 不能覆盖 BRC-2 visibility 或 RC-5 SecurityDecision。
8. 同一 tool/policy/view snapshot 的 projection 确定一致。
9. 主 system Prompt 只引用当前 tool view 中实际 included 的稳定 tool name。

### 10.4 No-tool request

```ts
interface NoToolRequestContract {
  no_tool_protocol_version: string;
  no_tool_request_id: string;
  task_profile_snapshot_id: string;
  tool_view_snapshot_id: string;
  enforcement_policy_ref: PolicyRef;
  expected_output_schema_id: string;
  reason_code: string;
}

interface NoToolValidationResult {
  no_tool_request_id: string;
  tool_view_entry_count: 0;
  provider_tools_omitted: true;
  runtime_tool_use_behavior: 'reject';
  status: 'valid' | 'invalid';
  diagnostics: string[];
}
```

No-tools 必须同时满足：

1. BRC-4 task profile 声明 `no_tool_requirement=true`；
2. BRC-2 派生零 included tool 的 view；
3. Provider request 不携带 tools/function declarations；
4. runtime 对异常 tool call 返回 protocol rejection，不执行；
5. 输出只进入指定 summary/output parser；
6. Prompt preamble/trailer 可作为软防线，但不计入 enforcement。

### 10.5 错误语义

- projection 与 runtime policy version 不一致：projection invalid。
- description 声明工具不可执行但 runtime included，或反之：请求不得发送。
- no-tools view 非空：请求 invalid。
- Provider adapter 仍发送 tools：协议错误。
- Provider 返回 tool call：拒绝执行并将 task 归类为协议失败；是否 partial/failed 由 RC-4 证据决定。
- output parser 失败：不得通过调用工具补救同一 no-tools request。

### 10.6 Wave D handoff

Wave D 可以获得：

- tool description 到 runtime policy 的 projection identity；
- included tool name 与 description 的一致性基础；
- machine-enforced empty tool view；
- no-tools Provider/runtime 双重约束。

Wave D 不能假设：

- tool description 是 permission truth source；
- Prompt 中写“不要调用工具”就满足 no-tools；
- system Prompt 可以引用 excluded tool；
- tool name 稳定就自动保证 reference integrity；
- 复杂工具只写名称就足够；
- Provider 异常 tool call 可以执行后再忽略。

直接消费者：M-028。

## 11. CRC-5 — Delegation & Injection Boundary

### 11.1 目标

把两类模型相关安全语义分开：

- delegation 使用结构化 hard gate、least privilege 和 handoff validation；
- injection suspicion 只产生带 provenance 的 soft signal。

二者不能共享 allow/deny 权限。

### 11.2 Delegation request

```ts
interface DelegationRequest {
  delegation_protocol_version: string;
  delegation_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  parent_action_snapshot_id: string;
  role_profile_snapshot_id: string;
  task_scope_ref: string;
  requested_tool_ids: string[];
  requested_control_mode: string;
  context_source_refs: string[];
  permission_snapshot_id: string;
  action_provenance_ref: string;
}
```

### 11.3 Delegation gate

```ts
interface DelegationGateDecision {
  delegation_id: string;
  security_decision_ref: string;
  effective_task_scope_ref: string | null;
  effective_tool_view_snapshot_id: string | null;
  effective_control_mode: string | null;
  status: 'allowed_once' | 'awaiting_user' | 'denied';
  reason_codes: string[];
}
```

规则：

1. 每次 delegation 都必须经过 policy evaluation。
2. child scope 不能超过 parent objective/scope。
3. child tool view 不能比 parent 当前可用视图更宽。
4. child control mode 不能绕过 parent Plan/side-effect boundary。
5. 跨机器、unknown provenance、side-effect capability 或权限扩张请求不可自动 allow。
6. local、read-only、同 scope delegation 可由明确确定性 policy allow once。
7. ask 必须消费 BRC-6 `PendingSecurityDecision`，无 ask 通道时 deny。
8. approval 只绑定当前 delegation/action snapshot。
9. parent permission changes 形成新 snapshot，旧 decision 失效。
10. delegation Prompt 文本不能声明自己已获授权。

### 11.4 Handoff envelope

```ts
interface DelegationHandoffEnvelope {
  handoff_protocol_version: string;
  delegation_id: string;
  child_session_id: string;
  child_profile_snapshot_id: string;
  completion_report_ref: string;
  result_content_ref: string;
  result_trust: 'untrusted' | 'unknown';
  provenance_refs: string[];
  sanitization_result_ref: string;
  verification_evidence_refs: string[];
  warning_codes: string[];
}
```

规则：

1. child result 默认 untrusted/unknown，不允许直接成为 instruction。
2. CompletionReport 结构合法不代表内容正确。
3. parent 必须验证独立交付物和 evidence。
4. result sanitizer 失败时不得把正文注入 parent Prompt。
5. warning prefix 不能提升 trust。
6. background DispatchReceipt 不等于 handoff completion。
7. child 的 permission decision 不自动传播为 parent permission。

### 11.5 Injection suspicion

```ts
interface InjectionSuspicionSignal {
  signal_protocol_version: string;
  signal_id: string;
  context_source_id: string;
  source_trust: 'untrusted' | 'unknown';
  deterministic_ingress_result_ref: string;
  signal_source: 'model' | 'deterministic_detector';
  suspicion_kinds: string[];
  evidence_refs: string[];
  user_report_recommended: boolean;
  created_at: string;
}
```

### 11.6 Signal 权限边界

1. model signal 不能生成 SecurityDecision allow/deny。
2. signal 不能修改 source trust、Authority、Placement 或 retention。
3. deterministic ingress rejection 继续由 BRC-3/RC-5 enforcement；M-069 不覆盖。
4. 无 evidence refs 的 model signal 仍可作为低置信提示，但不能阻断执行。
5. 是否向用户报告由独立 policy 根据风险和任务影响决定。
6. signal 不记录或要求模型隐藏思维。
7. false positive 不形成永久 source deny 规则。
8. 同一内容的多个 signal 可关联，但不能用数量投票改变 permission。

### 11.7 错误语义

- delegation provenance 缺失：deny。
- child scope/tool/control mode 扩张：deny 或 ask，不能自动 allow。
- ask channel unavailable：deny。
- handoff CompletionReport 无效：reject handoff。
- handoff sanitizer失败：正文不进入 parent context。
- injection signal schema 无效：丢弃 signal，不改变原 SecurityDecision。
- model signal 与 deterministic sanitizer 冲突：deterministic result 优先。

### 11.8 Wave D handoff

Wave D 可以获得：

- delegation request identity、scope/tool/mode 的 least-privilege gate；
- action snapshot 绑定的 blocking ask；
- untrusted child handoff envelope；
- injection suspicion signal 与 deterministic ingress result 的分离。

Wave D 不能假设：

- CRC-5 是任何 Wave D 机制的直接 D 前置；
- delegation 已自动批准；
- child CompletionReport 证明内容正确；
- child output 可以成为 trusted rule；
- model suspicion 可以 allow/deny；
- warning 数量可以替代确定性 security policy。

冻结 DAG 中 CRC-5 没有 Wave D 直接 D-edge，不人为新增依赖。

## 12. CRC-6 — Observability Safety Policy

### 12.1 目标

为确定性 decision subsystem 定义可诊断 trace，并在任何 production telemetry 发送前执行字段 allowlist、敏感度/PII 标签、redaction 和 drop。

CRC-6 不记录模型隐藏思维，不把 redaction 当作扩大采集的理由。

### 12.2 Decision trace

```ts
interface DecisionTraceEvent {
  decision_trace_protocol_version: string;
  event_id: string;
  decision_id: string;
  subsystem:
    | 'permission'
    | 'command_policy'
    | 'path_policy'
    | 'environment_policy'
    | 'delegation_policy'
    | 'source_router';
  policy_ref: PolicyRef;
  input_snapshot_refs: string[];
  result_ref: string;
  result_code: string;
  error_code: string | null;
  duration_ms: number;
  field_policy_ref: string;
}
```

规则：

1. trace 记录输入 snapshot refs 和结构化结果，不默认复制完整 input。
2. 当前只覆盖实际存在或已冻结的确定性 subsystem；不预建未使用 classifier。
3. 不记录 chain-of-thought、隐藏 reasoning 或要求模型解释内部推理。
4. decision ID 必须引用实际 SecurityDecision/policy result。
5. error 与 deny/ask/allow 分离；系统异常不能伪装成正常 deny reason。
6. duration、result code 等 metadata 不能包含用户正文。

### 12.3 Field classification

```ts
type TelemetryFieldClass =
  | 'operational_metadata'
  | 'pseudonymous_identifier'
  | 'filesystem_path'
  | 'user_content'
  | 'source_code'
  | 'credential'
  | 'unknown';

type TelemetryFieldAction =
  | 'keep'
  | 'hash'
  | 'redact'
  | 'drop_field'
  | 'drop_event';

type TelemetryPiiLabel =
  | 'none'
  | 'potential_identifier'
  | 'direct_identifier'
  | 'sensitive_auth';

interface TelemetryFieldPolicy {
  field_policy_id: string;
  field_policy_version: string;
  event_type: string;
  allowed_fields: Readonly<Record<string, {
    field_class: TelemetryFieldClass;
    pii_label: TelemetryPiiLabel;
    action: TelemetryFieldAction;
  }>>;
}
```

### 12.4 Redaction result

```ts
interface TelemetryRedactionResult {
  redaction_protocol_version: string;
  redaction_id: string;
  source_event_id: string;
  field_policy_ref: string;
  status: 'redacted' | 'dropped';
  output_payload_ref: string | null;
  applied_actions: ReadonlyArray<{
    field_path: string;
    field_class: TelemetryFieldClass;
    pii_label: TelemetryPiiLabel;
    action: TelemetryFieldAction;
  }>;
  reason_codes: string[];
}
```

### 12.5 Production gate

1. event type 必须有字段 allowlist；未列字段默认 drop。
2. credential 默认 `drop_event`，不能 hash 后发送。
3. `sensitive_auth` 默认 `drop_event`；`direct_identifier` 至少 `drop_field`；`potential_identifier` 不得原样 `keep`，至少 hash/redact/drop，策略可以更严格。
4. user content/source code 默认不进入 production telemetry。
5. filesystem path 和 identifier 仍是敏感字段；hash 不等于匿名化。
6. unknown field class 或缺失 PII label 默认 `drop_field`；影响事件语义时 `drop_event`。
7. redaction 在 serialization/sink 前完成。
8. redaction failure → dropped。
9. output payload 不得携带原始值的旁路副本。
10. decision trace 若进入 production plane，必须先通过同一字段政策。
11. local full dump 仍受 BRC-7 独立访问和 retention 规则；不能借 CRC-6 自动启用。
12. sink failure 不改变 Agent Outcome、SecurityDecision 或 CompletionReport。

### 12.6 错误语义

- event type 无 policy：drop event。
- field 未注册：drop field/event。
- credential 检测：drop event。
- redactor 异常：drop event并产生最小本地错误计数。
- output payload schema 不匹配：drop。
- decision trace 引用未知 decision ID：拒绝 trace。
- sink unavailable：业务继续，但不缓存未清洗 payload 等待重发。

### 12.7 Wave D handoff

Wave D 可以获得：

- 确定性 subsystem 的 `DecisionTraceEvent`；
- input snapshot refs、decision/result/error 的分离；
- 字段级 allowlist、敏感度/PII classification；
- redacted/dropped 的确定结果；
- production telemetry 的发送前 gate。

Wave D 不能假设：

- command AST/shadow policy 已完成；
- decision trace 可以记录隐藏思维或完整输入；
- Prompt/tool telemetry 可以包含正文；
- hash 后的路径/ID 已匿名；
- redaction 允许扩大事件或字段范围；
- sink failure 可以改变业务 Outcome。

直接消费者：M-064、M-055。

## 13. 跨契约不变量

### INV-C1 — Policy 可重放

同一 policy/version 和不可变输入 snapshot 必须产生确定相同的机器结果。

### INV-C2 — Precedence 不等于 Authority

CRC-1 base winner 只决定 approved base Prompt 选择，不改变 user/project/memory/tool content 的 Authority。

### INV-C3 — Condition 是封闭三态

Prompt condition 不执行任意代码；unknown 不乐观 include。

### INV-C4 — Cache eligibility 不等于收益

static classification 不代表 Provider cache support、hit 或成本节省。

### INV-C5 — Capability override 是受信配置权

Agent、Prompt、Tool Result、Provider 自报不能修改 effective capability。

### INV-C6 — 文件与 schema 不建立信任

Markdown、文件名、路径、frontmatter、schema 合法或内容自报都不能单独或组合绕过 CRC-3 四重 trust gate。

### INV-C7 — Memory candidate 不等于 admitted memory

TypedMemoryCandidate 不能自行 store、merge、replace、delete 或提升 Authority。

### INV-C8 — Runtime policy 是工具事实来源

Tool description 只投影 policy；visibility、permission 和 no-tools 由结构化 runtime contract 决定。

### INV-C9 — No-tools 是硬协议

No-tools request 必须零工具视图、Provider 不发送 tools、runtime 拒绝异常 tool call。

### INV-C10 — Delegation 不扩大权限

Child scope、tool view 和 control mode 不得超过 parent 当前边界；child output 默认 untrusted。

### INV-C11 — Injection suspicion 是软信号

模型怀疑不能改变 allow/ask/deny、Trust、Authority 或 Placement。

### INV-C12 — Observability 先最小化再清洗

先定义最小事件和字段 allowlist，再执行 redaction；redaction 不是扩大采集的许可。

### INV-C13 — 冻结 DAG 不反向修改

CRC-2、CRC-5 无 Wave D 直接 D-edge；同 Wave/后续消费者不得用“方便”新增隐式依赖。

### INV-C14 — Failure 不升级权限

Policy、loader、router、projection、ask、redactor 或 sink 失败不能产生 include、trusted、allow、approved、sent 或 completed。

### INV-C15 — 版本正交

resolution、condition、scope、capability override、routing、memory candidate、tool projection、no-tools、delegation、signal、decision trace 和 redaction protocol 独立版本化。

## 14. 兼容与废止关系

| 当前语义 | Wave C 结论 |
|---|---|
| 固定字符串拼接顺序 | 可作为迁移证据，不自动成为 CRC-1 precedence |
| 零散 `if` 条件拼接 | 迁移到封闭 condition DSL；禁止 arbitrary callback |
| 动态 Prompt 每轮重建 | 可以保留执行方式；必须产出 scope/condition evidence |
| Provider/model 名称分支 | 保留 adapter default；第三方修正必须走 CRC-2 |
| 子 Agent 环境文本 | 迁移到 CRC-3 environment block |
| Markdown loader 直接使用正文 | 在 routing/trust gate 前不得注入 |
| Memory 无类型追加 | 旧数据不自动分类；新 candidate 必须 typed |
| tool description 写安全说明 | 保留文本，但必须能追溯 runtime policy |
| compaction Prompt 写“禁止工具” | 仅保留软防线；必须零工具视图 |
| delegation 部分透传 permission | 与 CRC-5 least-privilege gate 对齐 |
| child result 文本直接返回 parent | 迁移到 untrusted handoff envelope |
| Permission/bash 日志是自由文本 | 迁移到 DecisionTraceEvent |
| telemetry 任意 payload | 未经字段 policy/redaction 一律不得生产发送 |

## 15. Wave D Handoff 总表

| Wave D 机制 | 消费 Wave C | 可以依赖 | 禁止假设 |
|---|---|---|---|
| M-048 Mode-Specific Prompt Profiles | CRC-1 | resolution plan、condition evidence、scope classification | static 有收益；安全/Completion 可省略 |
| M-008 User Context Prepend | CRC-3 | trusted route、bounded content、Authority/Placement request | Markdown/schema/file presence 建立信任 |
| M-044 Memory Admission | CRC-3 | typed candidate、evidence/confidence/freshness/invalidation | candidate 已正确或已 admitted |
| M-028 Name-to-Manual Indirection | CRC-4 | included tool names、policy projection、no-tools contract | 名称存在即 reference 完整 |
| M-064 AST Command Policy | CRC-6 + RC-5 | decision trace、error taxonomy、redaction gate | trace 等于 command policy；AST 替代 Plan allowlist |
| M-055 Prompt/Tool Telemetry | CRC-6 + BRC-1/BRC-2/BRC-7 | stable component IDs、field policy、redaction/drop result | 可以采集正文；redaction 允许扩大范围 |

CRC-2 与 CRC-5 没有 Wave D 直接 D-edge，只提供全局边界和后续机制输入。

## 16. 防御边界

| 高频失败 | Wave C 防护原则 |
|---|---|
| 同层多个 base candidate | resolution rejected |
| mandatory condition unknown | resolution rejected |
| scope 证据不足 | 按 dynamic |
| override 来源/作用域不可信 | 不应用 override |
| Markdown/schema 看似合法 | 仍走四重 trust gate |
| route 目标与 source class 不兼容 | reject |
| memory evidence 缺失 | reject candidate |
| tool projection 与 runtime policy 漂移 | 请求不得发送 |
| no-tools request 仍携带 tools | protocol error |
| delegation 请求权限扩张 | deny/ask，不自动 allow |
| child handoff sanitizer 失败 | 正文不进入 parent |
| model injection signal 无证据 | 只作低置信提示 |
| decision trace 请求完整输入 | 使用 refs/minimal fields |
| telemetry 字段未知 | drop field/event |
| redactor 或 sink 失败 | drop，不影响业务 Outcome |

## 17. 规格级验收矩阵

### CRC-1

1. base precedence 是封闭且确定的。
2. precedence 与 Context Authority 明确分离。
3. append 不参与 base winner 且不覆盖其他 section。
4. mandatory append 不能被 mode/role/custom profile 或 base override 省略。
5. condition DSL 封闭、三态、可提供 evidence。
6. mandatory/optional unknown 有不同确定语义。
7. static 分类要求无易变依赖，unknown 按 dynamic。
8. 不宣称 cache hit 或成本收益。
9. Wave D handoff 明确 M-048 可消费/禁止假设。

### CRC-2

1. Override 同时经过 trusted source、schema、loader 和 scope gate。
2. Agent/Prompt/Tool Result 不能写 override。
3. supported 不等于 permission allow。
4. 无效 override 不修改 base snapshot。
5. 配置变化产生新 snapshot。
6. 明确无 Wave D 直接 D-edge。

### CRC-3

1. Environment block 只使用 normalized allowlisted fields。
2. Markdown route 有四重 trust gate。
3. 文件、文件名、路径、frontmatter、schema 和正文自报均不能建立 trust。
4. route 不等于 injection/admission/approval。
5. 四类 memory candidate 有清晰用途和禁止项。
6. candidate 强制 evidence、confidence、freshness/context/invalidation。
7. failure observation 不成为永久禁止规则。
8. Wave D handoff 覆盖 M-008/M-044。

### CRC-4

1. ToolPolicyProjection 能追溯 runtime policy。
2. projection 不产生 SecurityDecision。
3. no-tools 同时约束 profile、tool view、Provider request 和 runtime。
4. Prompt preamble/trailer 不计作 enforcement。
5. 异常 tool call 不执行。
6. Wave D handoff 明确 M-028 可消费/禁止假设。

### CRC-5

1. delegation 每次经过 gate。
2. child scope/tool/mode 不扩大。
3. 高风险 delegation 无 auto-allow。
4. child handoff 默认 untrusted。
5. parent 必须验证 CompletionReport evidence。
6. injection signal 不改变 permission/trust/Authority。
7. 明确无 Wave D 直接 D-edge。

### CRC-6

1. decision trace 不记录隐藏思维或默认复制完整输入。
2. subsystem、decision result 和 error 独立字段表达。
3. production telemetry 使用字段 allowlist。
4. credential 默认 drop event。
5. 每个允许字段都有 PII label，敏感认证信息和直接标识符采用确定的最低处置强度。
6. unknown、缺失 PII label 或 redaction failure 默认 drop。
7. hash 不被描述为匿名化。
8. sink failure 不改变业务 Outcome。
9. Wave D handoff 覆盖 M-064/M-055。

### 跨契约

1. INV-C1～INV-C15 无冲突。
2. 六个 CRC 共覆盖 13 个 Wave C 机制且无重复主责。
3. 六个 Wave D 机制全部有明确上游 handoff。
4. CRC-2/CRC-5 没有被添加为 Wave D 直接依赖。
5. Runtime enforcement 与解释性 Prompt 始终分离。
6. 未选择 Prompt 原文或进入实现任务。

## 18. 设计完成标准

Wave C 只有在以下条件全部满足后才能冻结：

1. 13 个 Policy Contracts 全部映射到且仅映射到一个主 CRC。
2. 六个 CRC 都有输入、输出、不变量、错误语义和 Wave D handoff。
3. CRC-1 precedence 不改变 Context Authority。
4. CRC-1 static 分类不宣称缓存收益。
5. CRC-2 不允许 Agent 修改 capability。
6. CRC-3 把文件/schema 不建立信任写成硬协议与验收条件。
7. CRC-3 typed candidate 不冒充 admitted memory。
8. CRC-4 no-tools 有 API/runtime enforcement。
9. CRC-5 delegation hard gate 与 injection soft signal 权限分离。
10. CRC-6 decision trace 与 redaction/drop 同时冻结。
11. INV-C1～INV-C15 可由结构化协议验证。
12. Wave D 六个机制 handoff 完整。
13. 未新增冻结 DAG D-edge。
14. 未选择、改写或嵌入 Claude Prompt 原文。
15. 未进入生产代码、实施文件、工期或 Git 操作。

## 19. 后续流程

本文审核冻结后：

1. Wave D 只能消费本文冻结的 resolution、route、memory candidate、tool projection、delegation、signal、decision trace 和 redaction语义。
2. Wave D 不得反向修改 Wave A/B/C 的 identity、Trust、Authority、blocking ask、pairing 或 runtime policy truth source。
3. Wave D 设计完成并冻结后，继续按 DAG 进入 Wave E。
4. 全部 Wave 设计冻结后，才编写主 Agent/Prompt 机制的详细实施计划。
5. Prompt Library Import 仍是独立资产快照，不改变本文任何 approved、trusted、admitted、supported 或 runtime activation 状态。
