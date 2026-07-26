# mi-code Agent Foundation — Wave A Root Contracts

> 状态：冻结
> 日期：2026-07-26
> 上游输入：冻结版 Agent Operating Model、Baseline、Claude Mechanism Index、Gap / Value Matrix
> 覆盖机制：M-006、M-010、M-018、M-019、M-023、M-037、M-057、M-062
> 当前阶段：设计规格，不是实施计划

## 1. 结论

Wave A 不实现八个独立功能，也不建立中央 Agent FSM。它冻结五个可独立演进、通过显式契约协作的 Root Contract：

| Root Contract | 机制 | 机制 Owner |
|---|---|---|
| RC-1 Prompt Asset Governance | M-018 | Phase 1 |
| RC-2 Semantic Request Boundary | M-006、M-019、M-023、M-057 | M-006=P2；M-019/M-023=P3；M-057=P1 |
| RC-3 Project Rule Discovery | M-010 | Phase 2 |
| RC-4 Completion & Agent Result | M-037 | Phase 3 |
| RC-5 Security Decision Vocabulary | M-062 | Phase 5 |

RC 是共同规格边界，不创建第二套 Owner。各机制继续服从 T2 的唯一 Owner。五个 RC 只冻结语义、数据边界、不变量和错误分类。类名、文件布局、实现库、迁移批次和测试文件属于实施计划，不在本文决定。

## 2. 设计目标

Wave A 必须为后续 Wave 提供以下稳定输入：

1. Prompt 资产为什么存在、从哪里来、哪个版本可运行。
2. Context、messages、tools 以什么语义平面进入 Provider 请求。
3. 项目规则候选如何被发现，但不被自动提升为可信指令。
4. Agent 或子 Agent 如何报告 Outcome、终止原因、验证和交付物。
5. Security policy 如何以统一的 `allow/ask/deny` 协议返回决策。
6. Tool definition、tool call 和 tool result 使用什么身份语义。
7. Provider adapter 可以转换什么，禁止改变什么。

完成 Wave A 后，后续设计不应再次定义上述基础词汇。

## 3. 明确排除

本文不设计或实施：

- Prompt compiler、section 拼装和 replace/append 冲突规则；
- Project rules 内容读取、可信提取、注入、截断或 retention；
- mode/role tool overlay；
- Provider capability registry；
- Tool use/result pairing validator；
- Permission `ask` 的 UI、持久化和恢复实现；
- command AST、路径、子进程环境和 delegation enforcement；
- telemetry、Prompt dump 或评测执行框架；
- Prompt 原文选择、改写或嵌入；
- 数据库、远程 Registry 服务或在线 A/B 平台。

这些能力分别属于 Wave B 以后。Wave A 只保证它们有稳定的上游契约。

## 4. 现状与复用边界

### 4.1 已有轮子

M-019 与 M-057 的输入等级是 `Required Reuse`：必须冻结并消费其接口语义，但禁止以 Wave A 为由重写 Provider tool plane 或 Provider adapter。

| 现有能力 | 当前位置 | Wave A 处理 |
|---|---|---|
| `ToolDefinition` | `src/agent/types.ts` | 复用名称、description、parameters 语义 |
| `ToolUseBlock.id` | `src/agent/types.ts` | 作为现有 tool call identity 输入 |
| `ToolResultBlock.tool_use_id` | `src/agent/types.ts` | 作为现有 pairing identity 输入 |
| `ToolRegistry` | `src/agent/tool-registry.ts` | 复用注册与执行能力；补冻结顺序契约，不重写 |
| Anthropic/OpenAI/Google clients | `src/agent/*-stream-client.ts` | 复用 Provider 转换层 |
| `PermissionBehavior` | `src/permission/types.ts` | 复用 `allow/ask/deny` 三态 |
| `PermissionChecker.check()` | `src/permission/checker.ts` | 作为 RC-5 的现状输入，不在 Wave A 修改 |
| `SubagentResult` | `src/agent/subagent.ts` | 迁移到 RC-4 正交语义，不直接沿用现有 status 联合 |
| `StreamEventBus` | `src/agent/stream-event-bus.ts` | 后续承载 decision/result 事件；Wave A 不扩展事件 |

### 4.2 已确认的现状缺口

- `ToolRegistry.getDefinitions()` 依赖 Map 当前插入顺序，没有显式 canonical order 契约。
- Provider adapter 会转换 system/messages/tools，但没有统一 Semantic Request Snapshot。
- Project rules 没有发现入口。
- `PermissionDecision` 只有 behavior/reason，缺少 decision identity、policy provenance 和风险分类。
- streaming 主路径只真正阻止 `deny`，`ask` 仍继续执行。
- `SubagentStatus` 把 Outcome、Verification、Termination 和 Execution Mode 混在同一联合类型。
- system prompt 仍是运行时字符串拼接，没有构建时 Registry。

Wave A 不直接修复这些缺口；它冻结后续修复必须服从的契约。

## 5. 跨契约数据流

```text
RC-1 Prompt Asset Governance
        │
        │ approved immutable asset metadata
        ▼
future Prompt Compiler
        │
        ├──────────────┐
        │              │
RC-3 Project Rule     tool registry
Discovery candidates   snapshot
        │              │
        └──────┬───────┘
               ▼
RC-2 Semantic Request Boundary
               │
               │ immutable semantic snapshot
               ▼
        Provider Adapter
               │
               │ provider payload / normalized response
               ▼
        Agent execution loop
          │             │
          │ action      │ completion
          ▼             ▼
RC-5 Security      RC-4 Completion
Decision           & Agent Result
```

RC-5 在任何受保护动作执行前产生决策。RC-4 在 Turn 或子 Agent 终止时产生结果。二者不经过 Prompt 文本间接传递权威状态。

## 6. 共享身份与版本原则

### 6.1 身份类型不得混用

| 身份 | 作用域 | 稳定性 |
|---|---|---|
| `asset_id` | 一项 Prompt/模板资产的逻辑身份 | 跨版本稳定 |
| `asset_version` | 该资产的一次不可变内容修订 | 内容或行为元数据变化时递增 |
| `registry_snapshot_id` | 一次构建产物/运行时 Registry 快照 | 每个构建快照唯一 |
| `tool_id` | 一个注册工具的稳定逻辑身份 | 跨请求稳定 |
| `tool_call_id` | 一次具体工具调用 | session 内唯一 |
| `request_id` | 一次 Provider 请求 | session 内唯一 |
| `turn_id` | 一次 Turn | session 内唯一 |
| `decision_id` | 一次 Security decision | session 内唯一 |
| `protocol_version` | Completion/Security 等协议结构版本 | 协议结构变化时递增 |

### 6.2 `asset_version` 与 `protocol_version`

二者必须独立：

- `asset_version` 只描述 Prompt 资产修订。
- `protocol_version` 只描述结构化协议的字段和语义版本。
- 修改 Prompt 文本不得自动提升 Completion Contract 的 `protocol_version`。
- 修改 Completion schema 不得批量重写所有 Prompt 的 `asset_version`。
- telemetry 必须分别记录二者，不能合并为单一 `version` 字段。

### 6.3 ID 不承载权威性

ID 只用于身份、关联和审计。Authority、Trust、Freshness、Placement 与 Retention 必须由各自字段和策略决定，不能从 ID 前缀、路径或排序位置推断。

## 7. RC-1 — Prompt Asset Governance

### 7.1 目标

建立“构建时源文件 → 校验 → 不可变运行时 Registry”的治理契约，为 Prompt compiler、Agent role、tool prompt 和安全提示资产提供统一来源。

RC-1 不决定本轮加载哪些 Prompt，也不把成熟 Prompt 库中的文件自动批准为运行时资产。

### 7.2 语义记录

每个 Prompt 资产至少具有：

```ts
interface PromptAssetRecord {
  asset_id: string;
  asset_version: string;
  source: {
    kind: 'mi-code' | 'claude-reference' | 'external';
    locator: string;
    license: string | null;
  };
  purpose: string;
  owner: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
  target_models: string[];
  target_capabilities: string[];
  prohibited_placements: string[];
  adaptation_notes: string;
  evaluation: {
    status: 'unverified' | 'candidate' | 'approved' | 'rejected' | 'retired';
    evidence_refs: string[];
  };
  content_ref: string;
}
```

这是语义模型，不是已批准的 TypeScript 文件名或最终字段编码。

### 7.3 状态语义

| 状态 | 是否可进入运行时 Registry | 语义 |
|---|---|---|
| `unverified` | 否 | 只完成收集，来源/许可/用途尚未验证 |
| `candidate` | 否 | 已确认来源，可进入适配和评测 |
| `approved` | 是 | 通过目标模型/能力对应的评测门 |
| `rejected` | 否 | 当前证据表明不适合使用 |
| `retired` | 否 | 曾批准，但已被更新资产或协议淘汰 |

运行时 Registry 只包含 `approved` 资产，并且对当前进程不可变。

### 7.4 不变量

1. `asset_id + asset_version` 唯一定位不可变内容。
2. 同一内容不能通过改名绕过 rejected/retired 状态。
3. `source.license = null` 的外部资产不能进入 approved。
4. schema 合法不等于 Prompt 内容可信或有效。
5. Agent 不能自行把 candidate 提升为 approved。
6. Runtime 不能修改 asset metadata 或 evaluation result。
7. Prompt 原文、适配版和仅参考摘要必须是不同资产版本或不同 asset。
8. `target_capabilities` 由后续 M-058 capability registry 解析，不能用模型名称字符串猜测。
9. `target_models` 只表达经过评测的精确适用范围；空数组表示不做 model-ID 限定，不表示适用于所有能力。

### 7.5 成熟 Prompt 库准入

`claude-code-system-prompts` 中的文件进入 mi-code 时必须经过：

```text
inventory
  → source/license check
  → purpose mapping
  → capability dependency check
  → adaptation
  → behavior evaluation
  → approved asset
```

文件存在、来源成熟或 Claude 正在使用都不是 approved 证据。

### 7.6 错误语义

- 重复 `asset_id + asset_version` 且内容不同：构建失败。
- source 或 license 缺失：保持 unverified，不进入运行时。
- evaluation evidence 引用不存在：不能 approved。
- target capability 未知：保持 candidate，不按默认模型猜测。
- Registry snapshot 校验失败：启动失败或回退到上一个已验证快照；不得部分加载。

## 8. RC-2 — Semantic Request Boundary

### 8.1 目标

在 Prompt compiler 与 Provider adapter 之间建立 Provider-neutral 的请求语义边界，同时冻结 tool plane identity 与 deterministic base order。

### 8.2 语义请求快照

```ts
interface SemanticRequestSnapshot {
  request_id: string;
  turn_id: string;
  registry_snapshot_id: string;
  system_sections: readonly SemanticSection[];
  meta_context: readonly SemanticMessage[];
  conversation: readonly SemanticMessage[];
  tools: ToolDefinitionSnapshot;
}
```

该结构是语义示意，不决定具体 TypeScript 类型。attachment plane 当前处于 Hold，不进入 Wave A 快照。

### 8.3 Placement 词汇

Wave A 冻结以下 Placement 类别：

| Placement | 语义 |
|---|---|
| `system_static` | 跨 Turn 稳定、可形成 cache 前缀的系统规则 |
| `system_dynamic` | 当前请求相关的动态系统上下文 |
| `meta_context` | 系统生成但使用 message plane 承载的上下文 |
| `conversation` | 当前用户输入和历史对话 |
| `tool_plane` | Provider 原生工具定义，不复制进 system 文本 |

Placement 不决定 Authority、Trust、Retention 或淘汰顺序。

### 8.4 Provider adapter 边界

Provider adapter 可以：

- 把 system sections 编码为 Anthropic system、OpenAI system message 或 Gemini systemInstruction；
- 把内部 message/content block 转换为 Provider 格式；
- 把工具 JSON schema 转换为 Provider tool/function declaration；
- 把 Provider tool call/result identity 映射回内部统一字段；
- 处理 Provider API 所需的传输字段。

Provider adapter 禁止：

- 选择或删除 Prompt 资产；
- 改变 Context Authority、Trust、Placement 或 Retention；
- 改变 tool visibility、permission 或 canonical order；
- 根据模型名称猜测 capability；
- 合成“已通过验证”或“已获得用户批准”等语义；
- 在转换中静默丢弃无法表达的语义字段。

无法无损表达时必须返回 capability/protocol error，由上层决定降级或停止。

### 8.5 Tool plane identity contract

M-019 的交付物是 identity contract，不是 Provider tool plane 重实现：

```text
tool_id
  └─ 稳定标识一个注册工具

tool_call_id
  ├─ 标识一次具体调用
  ├─ session 内唯一
  └─ 由对应 tool_result 原样引用
```

不变量：

1. 每个 tool use 必须具有非空 `tool_call_id`。
2. `tool_result.tool_call_id` 必须引用同一 session 中一个已存在的 tool use。
3. Provider adapter 不得在 tool use 与 tool result 之间更换 ID。
4. progress/event ID 可以引用 `tool_call_id`，但不能充当最终 tool result。
5. background dispatch receipt 不是 tool result completion。
6. pairing 的运行时验证和失败恢复属于 Wave B M-070；Wave A 只冻结身份语义。

### 8.6 Deterministic base order

每个 Tool Descriptor 必须拥有不可变 `canonical_order`。Base snapshot 按以下键排序：

```text
(canonical_order ASC, tool_id ASC)
```

规则：

- `canonical_order` 在同一 Registry snapshot 中必须唯一。
- 初始值应以现有注册顺序为迁移种子，避免无证据改变模型行为。
- 可选工具缺席时，剩余工具相对顺序不变。
- Provider adapter 必须保持 snapshot 顺序。
- mode/role overlay 只能从 immutable base snapshot 派生，属于 Wave B M-024。
- 运行时临时注册不能修改已经发送请求所引用的 snapshot。

### 8.7 快照不变量

1. Snapshot 创建后不可变。
2. 同一 `registry_snapshot_id + request inputs` 必须得到相同 base tool order。
3. system/tools/messages 是独立语义平面。
4. tool description 中的能力声明不得超出 runtime permission。
5. Request snapshot 不持有 Provider SDK 专用对象。
6. Adapter 输出不得反向污染 semantic snapshot。

### 8.8 错误语义

- 重复 tool ID：Registry snapshot 无效。
- 重复 canonical order：Registry snapshot 无效。
- tool call ID 缺失或重复：Provider response protocol error。
- Provider 无法保持 identity：该 Provider capability 不可用。
- adapter 丢失 placement：请求不得发送。
- 请求构建期间 Registry 变化：继续使用已捕获 snapshot，不混入新状态。

## 9. RC-3 — Project Rule Discovery

### 9.1 目标

在明确的 workspace/repository 边界内发现项目规则候选，输出确定性的 source candidates。Discovery 不读取候选为高权威规则，也不决定其最终 Placement。

### 9.2 输入

```ts
interface ProjectRuleDiscoveryInput {
  workspace_root: string;
  repository_root: string | null;
  working_directory: string;
  source_policy_id: string;
}
```

`source_policy_id` 指向构建时配置的候选文件名/目录规则。Wave A 不冻结具体文件名单。

### 9.3 输出

```ts
interface DiscoveredRuleSource {
  source_id: string;
  candidate_kind: string;
  absolute_path: string;
  scope_root: string;
  relative_depth: number;
  discovery_order: number;
  diagnostics: string[];
}
```

输出不包含：

- 已提升的 Authority；
- trusted 标记；
- 文件正文；
- Prompt Placement；
- “必须服从”的模型指令。

### 9.4 发现边界

1. 不向 workspace/repository 明确边界之外无限向上遍历。
2. repository root 存在时，项目级发现不得越过 repository root。
3. working directory 不在 workspace root 内时，Discovery 失败，不尝试猜测新 root。
4. 发现顺序必须确定；路径位置只表示 scope，不表示 Authority。
5. 同一物理文件通过多条路径被发现时只产生一个 canonical candidate。
6. symlink、路径逃逸和内容清洗由后续 M-040 enforcement；Discovery 必须保留诊断信息，不自行提升信任。
7. 不可读候选产生 diagnostic，不静默当作“规则不存在”。

### 9.5 层级语义

候选来源记录：

- 它适用于哪个 scope root；
- 它与 working directory 的层级距离；
- 它由哪条 source policy 发现。

冲突优先级、provenance formatting 和 trusted routing 分别属于 M-002、M-011、M-012。Discovery 不通过“离当前目录更近”自动覆盖其他来源。

### 9.6 错误语义

- root 非绝对路径：输入无效。
- working directory 越界：Discovery 失败。
- source policy 不存在：配置错误，不返回空成功。
- 单个候选不可读：保留 candidate diagnostic，其他候选可继续发现。
- 路径解析结果不确定：标记待后续 validator 处理，不进入 trusted loader。

## 10. RC-4 — Completion & Agent Result

### 10.1 目标

统一主 Agent、子 Agent 和高结构任务的结果协议，把 Outcome、Termination、Verification 和 Execution Mode 正交化。

### 10.2 顶层协议

```ts
interface CompletionReport {
  protocol_version: string;
  subject: {
    kind: 'turn' | 'subagent';
    id: string;
  };
  outcome: 'completed' | 'partial' | 'failed' | 'cancelled';
  termination_reason: string;
  execution_mode: 'foreground';
  verification: VerificationReport;
  deliverables: DeliverableReport[];
  summary: string;
  remaining_uncertainty: string[];
}
```

后台启动不产生 CompletionReport：

```ts
interface DispatchReceipt {
  protocol_version: string;
  execution_mode: 'background';
  task_id: string;
  accepted: boolean;
}
```

### 10.3 Outcome 不变量

1. `completed` 只能在最低 Verification level 满足后产生。
2. `partial` 必须至少包含一个已验证的独立交付物。
3. `failed` 表示没有可独立交付的已验证成果，且系统不能继续。
4. `cancelled` 只能由用户主动中止产生。
5. Provider error、budget exhaustion、max turns 不自动产生 cancelled。
6. Outcome 一旦写入 final report 不可更改。
7. Background receipt 不是 Outcome。
8. summary 文本不能覆盖结构化 Outcome。

### 10.4 VerificationReport

```ts
interface VerificationReport {
  required_level: 'V0' | 'V1' | 'V2' | 'V3';
  achieved_level: 'V0' | 'V1' | 'V2' | 'V3' | null;
  status: 'passed' | 'failed' | 'blocked' | 'not_run';
  evidence_refs: string[];
  failure_kind: 'repairable' | 'blocked' | 'unrecoverable' | null;
}
```

规则：

- achieved level 低于 required level 时不能 completed。
- `unrecoverable` 必须满足 frozen INV-9/INV-9A 的确定性分类规则。
- evidence 为空不能声称 passed。
- Memory 写入结果不属于交付物验证证据。

### 10.5 DeliverableReport

每个独立交付物记录：

```ts
interface DeliverableReport {
  deliverable_id: string;
  description: string;
  verification_level: 'V0' | 'V1' | 'V2' | 'V3';
  evidence_refs: string[];
}
```

`partial` 的合法性由 deliverables 决定，而不是由 termination reason 决定。

### 10.6 现有 SubagentStatus 迁移

| 当前状态/原因 | 新 execution mode | 新 verification | 新 outcome |
|---|---|---|---|
| `background` | background | 不适用 | 不产生 Outcome，只返回 DispatchReceipt |
| `completed + end_turn` | foreground | 按证据重新计算 | 达到最低等级才 completed，否则 partial/failed |
| `incomplete + max_turns` | foreground | blocked 或未达标 | 有已验证独立交付物则 partial，否则 failed |
| `incomplete + error` | foreground | failed/blocked | 有已验证独立交付物则 partial，否则 failed |
| `incomplete + user_abort` | foreground | 保留已获得证据 | cancelled |
| `incomplete + no final summary` | foreground | insufficient | 有已验证独立交付物则 partial，否则 failed |
| `unverified + end_turn` | foreground | insufficient | 有其他已验证独立交付物则 partial，否则 failed |

明确禁止：

- `completed + termination_reason=user_abort`；
- `completed + verification.status=insufficient`；
- 用 `incomplete` 或 `unverified` 继续充当顶层 Outcome；
- 把 `[Subagent status=...]` 文本前缀作为唯一机器协议。

### 10.7 `asset_version` 与 `protocol_version`

CompletionReport 只携带自己的 `protocol_version`。如果结果需要引用 Prompt 资产，应另附 `asset_id + asset_version`，不得把 Prompt 版本写入 Completion protocol version。

### 10.8 错误语义

- 缺少 protocol version：报告无效。
- completed 但验证未达标：协议拒绝，降级逻辑必须显式运行。
- partial 无 deliverables：协议拒绝并归类 failed。
- cancelled 非 UserAborted：协议拒绝。
- evidence ref 不可解析：对应 verification 不成立。
- background 同时携带 Outcome：协议拒绝。

## 11. RC-5 — Security Decision Vocabulary

### 11.1 目标

让 Permission、command、path、delegation、cross-machine 和未来安全层使用同一决策协议。RC-5 定义语言，不实现具体检测器。

### 11.2 决策协议

```ts
interface SecurityDecision {
  protocol_version: string;
  decision_id: string;
  action: {
    kind: string;
    subject_id: string;
    snapshot_id: string;
  };
  behavior: 'allow' | 'ask' | 'deny';
  deciding_layer: string;
  risk_kind: string;
  policy_id: string;
  policy_version: string;
  reason_code: string;
  human_reason: string;
  provenance_refs: string[];
}
```

### 11.3 三态语义

| behavior | 语义 |
|---|---|
| `allow` | 当前 action snapshot 可执行一次 |
| `ask` | action 暂停，等待独立 UserDecision；未获批准前不得执行 |
| `deny` | 当前 action 被拒绝，不得执行 |

`allow` 不是永久授权。`ask` 不是 warning。`deny` 不能被 Prompt 文本覆盖。

### 11.4 UserDecision 分离

用户回答是独立协议：

```ts
interface UserDecision {
  protocol_version: string;
  decision_id: string;
  response: 'approved_once' | 'rejected';
  decided_at: string;
}
```

规则：

1. UserDecision 必须引用 pending `decision_id`。
2. `approved_once` 只批准原 action snapshot。
3. action 内容变化后必须重新决策。
4. 旧 callback 不能完成新的 decision。
5. pending decision 必须可持久化和恢复，具体实现属于 Wave B。
6. 没有可用 ask 通道时，不得把 ask 降级为 allow。

### 11.5 Layered enforcement 词汇

`deciding_layer` 至少能区分：

- ingress；
- permission；
- command；
- environment；
- path；
- delegation；
- information disclosure。

Wave A 不要求七层全部实现，也不要求安全检测顺序固定为上述列表。每个实际 layer 必须有独立 attack model 和测试证据。

### 11.6 不变量

1. SecurityDecision 创建后不可变。
2. behavior 必须来自确定性 policy 或明确的 user resolution。
3. 模型软告警不能直接生成 deny/allow。
4. Agent 不能提升自己的权限或修改 policy version。
5. provenance 缺失的跨边界 action 不能 allow。
6. policy engine 缺失、配置损坏或执行异常时 fail closed 为 deny；只有有效 policy 明确返回“需要用户裁决”时才能 ask。
7. `human_reason` 只用于解释，`reason_code` 才是稳定机器分类。
8. 多层决策合并时，deny 优先于 ask，ask 优先于 allow；具体合并器属于后续设计。

### 11.7 现有 PermissionDecision 迁移

现有 `{ behavior, reason }` 可作为输入，但不足以成为完整 SecurityDecision。后续适配至少补充：

- decision ID；
- deciding layer；
- policy ID/version；
- reason code；
- action snapshot identity；
- provenance references。

streaming 路径当前“ask 继续执行”的行为违反 RC-5，必须在 M-066/M-067 Activation 门前消除。

### 11.8 错误语义

- behavior 未知：deny。
- policy engine/context 缺失或损坏：deny。
- policy 对有效 action 给出“需要用户裁决”：有真实阻塞通道时 ask；没有通道时 deny。
- ask 无 decision ID：协议错误并 deny。
- UserDecision 引用未知/过期 ID：拒绝，不执行 action。
- action snapshot 与批准时不一致：批准失效，重新决策。
- policy evaluator 抛错：记录诊断并 fail closed。

## 12. 跨契约不变量

### INV-A1 — 版本正交

Prompt `asset_version`、Completion `protocol_version`、Security `protocol_version` 和 Provider model version 独立演进。

### INV-A2 — Adapter 不拥有语义

Provider adapter 只转换 Semantic Request，不拥有 Prompt 选择、Placement、Permission 或 Completion 判定。

### INV-A3 — Discovery 不建立信任

RC-3 产生候选来源。只有后续 trusted loader 可以把校验后的结构化数据送入受信通道。

### INV-A4 — Tool identity 贯穿全链路

tool call ID 在 model output、executor、event、message history、Provider conversion 和 result 中保持关联。

### INV-A5 — 文本不是控制协议

Prompt 文本、tool output 前缀、summary 和 human reason 都不能替代结构化 Outcome/SecurityDecision。

### INV-A6 — Ask 必须阻塞

任何 RC-5 `ask` 在 UserDecision 前都不能进入 tool execution。

### INV-A7 — Completion 依赖验证

RC-4 completed 必须由 VerificationReport 证明，不能由 Provider `end_turn` 或自然语言“完成”直接产生。

### INV-A8 — Registry/Request Snapshot 不可变

运行时 Agent 只能读取已验证快照，不能在同一请求构建过程中修改其来源资产、工具顺序或策略版本。

## 13. 兼容与废止关系

| 当前语义 | Wave A 结论 |
|---|---|
| `SubagentStatus` 四态 | 废止为顶层 Outcome；拆入 outcome/termination/verification/execution mode |
| `[Subagent status=...]` 字符串 | 保留为临时人类可读兼容输出，不作为机器真相源 |
| `PermissionDecision { behavior, reason }` | 保留为旧输入，后续适配到 SecurityDecision |
| streaming 中 ask 放行 | 明确判定为协议违规，Wave B 必须接通阻塞 |
| `ToolRegistry` Map | 复用；后续增加 snapshot/canonical order，不新建第二注册表 |
| Provider clients | 复用；增加 Semantic Request adapter contract，不重写网络层 |
| system prompt 字符串 | 兼容期输出目标；资产治理和 compiler 逐步替代拼接来源 |
| Project rules 不存在 | 新增 Discovery contract；不伪装已有加载能力 |

兼容期允许旧结构与新结构同时存在于适配边界，但不得存在两个同时可写的真相源。

## 14. Wave B Handoff

| Wave B 机制 | 从 Wave A 消费 |
|---|---|
| M-001 Prompt compiler | RC-1 Registry snapshot、RC-2 Placement |
| M-011 Provenance Formatting | RC-3 DiscoveredRuleSource identity |
| M-014 Subagent Prompt Contract | RC-4 CompletionReport |
| M-020 Tool-local Prompt Metadata | RC-1 asset identity、RC-2 tool ID |
| M-024 Per-Request Overlay | RC-2 immutable base snapshot、RC-5 decision vocabulary |
| M-035 Structured Role Templates | RC-1 asset governance、RC-4 result protocol |
| M-039 Environment Normalization | RC-2 Placement、RC-5 security vocabulary |
| M-040 Context Ingress Sanitization | RC-3 candidates、RC-5 decision vocabulary |
| M-042 Memory Separation | RC-2 Placement vocabulary |
| M-050 Source Size Guard | RC-3 source identity |
| M-051 Observability Planes | 全部 RC 的 stable IDs 与独立 version fields |
| M-058 Capability Registry | RC-2 adapter boundary、RC-1 target capabilities |
| M-063 Environment Scrubbing | RC-5 SecurityDecision |
| M-066 Non-Auto-Approvable Actions | RC-5 ask/UserDecision |
| M-070 Pair Integrity | RC-2 tool plane identity、RC-4 failure outcome |

Wave B 不得修改 Wave A 字段语义来规避实现困难；需要变更时必须提升对应 Root Contract 的 protocol/schema version 并重新评审下游影响。

## 15. 防御边界

| 高频失败 | Wave A 防护原则 |
|---|---|
| Prompt 来源不明 | RC-1 未验证资产禁止进入运行时 |
| Provider 差异侵入 Prompt | RC-2 adapter 不拥有语义 |
| 工具顺序漂移 | canonical order + immutable snapshot |
| tool call/result ID 丢失 | identity contract；后续 pairing validator |
| 项目文件即可信规则 | RC-3 只输出 candidate |
| 子 Agent 中间文本冒充完成 | RC-4 结构化 Outcome + Verification |
| user abort 被报告为完成 | cancelled 只能由 UserAborted 产生 |
| permission ask 被静默放行 | RC-5 ask 必须阻塞 |
| 安全检测异常后默认放行 | fail closed |
| 版本字段混用 | asset/protocol/model version 正交 |

## 16. 规格级验收矩阵

### RC-1

- 同一 `asset_id + asset_version` 对应两份不同内容时必须判定冲突。
- external asset 缺 license 时不能 approved。
- Agent 运行时无法修改 Registry。
- Claude Prompt 文件存在不能直接产生 approved。

### RC-2

- 同一 base registry snapshot 重复构造得到相同 tool order。
- Provider round-trip 后 tool call/result identity 不变。
- Provider adapter 不能修改 Placement 或 permission。
- duplicate tool ID/order 使 snapshot 无效。

### RC-3

- 相同 workspace 输入得到相同 candidate 顺序。
- 不越过 repository/workspace root。
- candidate 不带 trusted/Authority。
- 不可读文件产生 diagnostic 而非静默成功。

### RC-4

- user abort 只能得到 cancelled。
- max turns 无已验证交付物得到 failed。
- max turns 有已验证独立交付物得到 partial。
- insufficient verification 不能 completed。
- background 只返回 DispatchReceipt。
- `asset_version` 变化不改变 `protocol_version`。

### RC-5

- ask 未获 UserDecision 前 action 不执行。
- approved_once 不能复用到变化后的 action。
- evaluator 缺失或异常不能 allow。
- deny 优先于 ask/allow。
- 模型怀疑信号不能直接改变 behavior。

### 跨契约

- stable IDs 可以连接 request、tool、decision、completion 和 telemetry。
- 各 version 字段独立演进。
- 任何人类可读文本都不是唯一机器真相源。
- Wave B 所列每个机制都能找到唯一上游 RC。

## 17. 设计完成标准

Wave A 只有在以下条件全部满足后才能冻结：

1. 八个机制全部映射且无重复主责。
2. 五个 RC 的输入、输出、不变量和错误语义完整。
3. `asset_version` 与 `protocol_version` 明确分离。
4. M-019 被定义为 identity contract，不被误写为 Provider 重实现。
5. SubagentStatus 迁移不违反 frozen Outcome 规则。
6. `ask` 的阻塞语义没有降级路径。
7. Existing wheel reuse 与废止边界明确。
8. Wave B handoff 完整，不含循环依赖。
9. 未选择或嵌入任何 Prompt 原文。
10. 未进入实现文件、任务拆分或工期估算。

## 18. 后续流程

本文审核冻结后：

1. 以五个 Root Contract 为 Wave B 设计的固定输入；
2. 按 T2 Wave B 节点编写下一批跨 Phase 设计；
3. 在所有 Phase 设计冻结前不编写实施计划；
4. Prompt 原文选择只在 Registry、capability 和 evaluation contract 均已冻结后进行。
