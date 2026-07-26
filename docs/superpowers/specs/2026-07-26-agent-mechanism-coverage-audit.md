# mi-code Agent Mechanism Coverage Audit

> 状态：冻结
> 日期：2026-07-26
> 审计对象：M-001～M-071
> 冻结输入：Claude Mechanism Index、Gap / Value Matrix、Wave A～G 设计规格
> 当前阶段：设计覆盖审计，不是实施计划

## 1. 结论

M-001～M-071 共 71 个机制全部具有唯一处置：

```text
Designed / Actionable  49
Deferred               14
Hold                    8
Total                  71
```

集合检查结果：

- 无缺失 ID；
- 无重复处置；
- 49 个 designed/actionable 机制各有且只有一个主 Wave Contract；
- 14 个 Deferred 各有保留边界和未来触发条件；
- 8 个 Hold 各有冻结 Evidence gate；
- Required Reuse 与 Required Dependency 没有被误报为独立新实现；
- Wave A～G 的冻结 D-edge 无倒置；
- Contract count、mechanism count 与 invariant count 已分离。

Design Wave 全线冻结只表示 49 个 actionable 机制完成规格设计。它不表示 14 个 Deferred 或 8 个 Hold 已被设计或授权实施。

## 2. 审计口径

### 2.1 三类计数

| 计数 | 定义 |
|---|---|
| Contract count | RC/BRC/CRC/DRC/ERC/FRC/GRC 的实际数量 |
| Mechanism count | 唯一 M-ID 数量 |
| Invariant count | 唯一 INV-ID 数量 |

三者不能互换。

### 2.2 处置类型

| 处置 | 语义 |
|---|---|
| Designed / Actionable | 位于 T2 Design Wave，已映射到一个冻结主 Contract |
| Deferred | 不阻塞当前 P0～P2 闭包，保留边界与触发条件 |
| Hold | 缺少冻结 Evidence gate 所要求的证据，当前不得激活 |

### 2.3 审计方法

1. 以冻结 Gap / Value Matrix §17 取得 71 项 Owner、Band 和输入等级。
2. 以 Wave A～G 顶部 `覆盖机制` 元数据取得 designed 集合。
3. 以各 Wave 主责表取得 Contract 映射。
4. 以冻结 DAG §11 复核 D 前置与 Layer。
5. 以 Matrix §12.2 取得 Hold Evidence gate。
6. 以 Mechanism Index 的边界声明和 Value Matrix 判断收敛 Deferred 触发条件。
7. 对三个集合执行并集、交集、连续性和唯一性检查。

## 3. 汇总复算

### 3.1 Contract、机制与不变量

| Wave | Contract | Contract 数 | Designed 机制数 | Invariant |
|---|---|---:|---:|---:|
| A | RC-1～RC-5 | 5 | 8 | 8 |
| B | BRC-1～BRC-7 | 7 | 15 | 13 |
| C | CRC-1～CRC-6 | 6 | 13 | 15 |
| D | DRC-1～DRC-5 | 5 | 6 | 18 |
| E | ERC-1～ERC-4 | 4 | 5 | 20 |
| F | FRC-1 | 1 | 1 | 16 |
| G | GRC-1 | 1 | 1 | 20 |
| **合计** |  | **29** | **49** | **110** |

此前“46 个设计 Wave 契约”的表述混用了 Wave A 的 Contract 数与 Wave B～G 的机制数。正确值是：

- 29 个 Contract；
- 49 个 designed/actionable 机制；
- 110 条不变量。

### 3.2 71 项处置

| 处置 | 数量 | 占全部机制 |
|---|---:|---:|
| Designed / Actionable | 49 | 69.0% |
| Deferred | 14 | 19.7% |
| Hold | 8 | 11.3% |
| **总计** | **71** | **100%** |

百分比只用于完整性展示，不用于调整冻结优先级。

## 4. Designed / Actionable 逐 ID 审计

### 4.1 Wave A — Root Contracts

主规格：`2026-07-26-agent-foundation-wave-a-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-018 | Feature-Gated Prompt Evolution | P1 | P2 | Required Dependency | RC-1 |
| M-006 | Five-Plane Placement | P2 | P1 | Core | RC-2 |
| M-019 | Independent Tool API Plane | P3 | P2 | Required Reuse | RC-2 |
| M-023 | Deterministic Tool Ordering | P3 | P1 | Core | RC-2 |
| M-057 | Provider Adapter Branches | P1 | P2 | Required Reuse | RC-2 |
| M-010 | Hierarchical Rule Discovery | P2 | P1 | Core | RC-3 |
| M-037 | Strict Result Schema for Delegated Work | P3 | P1 | Core | RC-4 |
| M-062 | Layered Security Enforcement | P5 | P1 | Core | RC-5 |

Wave A：8 项，唯一主责，无重复。

### 4.2 Wave B — Primary Anchors

主规格：`2026-07-26-agent-primary-anchors-wave-b-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-001 | Section Array Assembly | P1 | P1 | Core | BRC-1 |
| M-020 | Per-Tool Prompt Source | P3 | P2 | Required Dependency | BRC-2 |
| M-024 | Per-Request Tool Overlay | P3 | P1 | Core | BRC-2 |
| M-058 | Runtime Model Capability Detection | P1 | P1 | Core | BRC-2 |
| M-011 | Rule Provenance Formatting | P2 | P1 | Core | BRC-3 |
| M-039 | Cross-Platform Environment Normalization | P2 | P2 | Conditional | BRC-3 |
| M-040 | Context Ingress Sanitization | P5 | P1 | Core | BRC-3 |
| M-042 | Instruction Memory / Auto Memory Separation | P2 | P1 | Core | BRC-3 |
| M-050 | Source Size Guard | P2 | P1 | Core | BRC-3 |
| M-014 | Role-Specific Agent Prompt | P3 | P2 | Conditional | BRC-4 |
| M-035 | Task-Specific Prompt Templates | P3 | P2 | Conditional | BRC-4 |
| M-070 | Strict Tool-Use / Result Pair Integrity | P4 | P0 | Core | BRC-5 |
| M-063 | Child-Process Environment Scrubbing | P5 | P1 | Core | BRC-6 |
| M-066 | Non-Auto-Approvable Cross-Machine Actions | P5 | P2 | Conditional | BRC-6 |
| M-051 | Layered Observability Planes | P6 | P1 | Core | BRC-7 |

Wave B：15 项，唯一主责，无重复。

### 4.3 Wave C — Policy Contracts

主规格：`2026-07-26-agent-policy-contracts-wave-c-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-002 | Effective Prompt Precedence | P1 | P1 | Core | CRC-1 |
| M-003 | Static / Dynamic Boundary | P1 | P2 | Conditional | CRC-1 |
| M-004 | Conditional Section Resolution | P1 | P2 | Conditional | CRC-1 |
| M-059 | Third-Party Capability Override | P1 | P2 | Conditional | CRC-2 |
| M-009 | Environment Snapshot Section | P2 | P2 | Conditional | CRC-3 |
| M-012 | Markdown Prompt Source Routing | P2 | P1 | Core | CRC-3 |
| M-043 | Typed Auto Memory | P2 | P2 | Required Dependency | CRC-3 |
| M-026 | Tool-Local Policy and Sandbox Context | P3 | P1 | Core | CRC-4 |
| M-031 | No-Tool Compaction Sandwich | P4 | P1 | Core | CRC-4 |
| M-067 | Delegation Permission and Handoff Validation | P5 | P2 | Conditional | CRC-5 |
| M-069 | Prompt-Injection Suspicion Signaling | P5 | P1 | Core | CRC-5 |
| M-054 | Decision-Subsystem Dump | P6 | P1 | Core | CRC-6 |
| M-056 | Telemetry Redaction and PII Labels | P6 | P1 | Core | CRC-6 |

Wave C：13 项，唯一主责，无重复。

### 4.4 Wave D — Integrated Capabilities

主规格：`2026-07-26-agent-integrated-capabilities-wave-d-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-048 | Mode-Specific Prompt Profiles | P1 | P2 | Conditional | DRC-1 |
| M-008 | User Context Prepend | P2 | P1 | Core | DRC-2 |
| M-044 | Memory Admission and Verification Policy | P2 | P1 | Core | DRC-2 |
| M-028 | Name-to-Manual Indirection | P3 | P2 | Conditional | DRC-3 |
| M-055 | Prompt and Tool Schema Telemetry | P6 | P1 | Core | DRC-4 |
| M-064 | AST Command Policy with Shadow Evaluation | P5 | P2 | Conditional | DRC-5 |

Wave D：6 项，唯一主责，无重复。

### 4.5 Wave E — Lifecycle & Selection

主规格：`2026-07-26-agent-lifecycle-selection-wave-e-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-038 | Meta Context Retention | P4 | P1 | Core | ERC-1 |
| M-045 | Two-Step Memory Persistence | P2 | P3 | Conditional | ERC-2 |
| M-046 | Memory Search Guidance | P2 | P2 | Conditional | ERC-2 |
| M-052 | Buffered Local Debug Logging | P6 | P2 | Conditional | ERC-3 |
| M-065 | Binary Hijack and Env-Assignment Defense | P5 | P2 | Conditional | ERC-4 |

Wave E：5 项，唯一主责，无重复。

### 4.6 Wave F — Bounded Memory Entrypoint

主规格：`2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-013 | Bounded Memory Entrypoint | P2 | P2 | Conditional | FRC-1 |

Wave F：1 项。

### 4.7 Wave G — Post-Compact Reconstruction

主规格：`2026-07-26-agent-post-compact-reconstruction-wave-g-design.md`

| ID | 机制 | Owner | Band | 输入等级 | 主责 |
|---|---|---|---|---|---|
| M-049 | Post-Compact Selective Reinjection | P4 | P2 | Conditional | GRC-1 |

Wave G：1 项。

## 5. Deferred 逐 ID 处置

Deferred 机制未进入当前 Design Wave。下表的“触发条件”全部满足前，只保留 Mechanism Index 已冻结边界，不写实现任务。

| ID | 机制 | Owner | 冻结边界 | 重新进入设计的证据触发条件 |
|---|---|---|---|---|
| M-005 | Section Cache and Invalidation | P1 | 本地 section cache 与 Provider prompt cache 分离 | section 构造/失效成本、重复率和确定性收益达到可测阈值 |
| M-007 | Late System Context Append | P2 | session-start git snapshot 不是实时状态 | git 状态注入频率、token 成本、过时率和用户收益基线形成 |
| M-015 | Agent Context Trimming | P3 | 不能为 token 节省丢失必要规则 | 子 Agent 上下文成本与任务质量回归集证明 trimming 有净收益 |
| M-016 | Byte-Exact Fork Inheritance | P3 | 字节相同不能牺牲 child 安全边界 | fork cache/重复成本可测，且 byte-exact 不破坏角色、权限和环境差异 |
| M-017 | Teammate Prompt Addendum | P3 | Prompt 不能替代任务所有权和权限隔离 | 真实 team/teammate 工作流、通信频率与 ownership enforcement 已存在 |
| M-021 | Context-Aware Schema Generation | P3 | 动态 schema 会影响 cache 稳定性 | 静态 schema 无法表达的真实工具场景和收益基线形成 |
| M-022 | Session Tool Schema Cache | P3 | 本地对象缓存与 Provider cache 分离 | schema 构造成本、session 重用率和 cache hit 数据形成 |
| M-025 | Tool-Local Few-Shot Examples | P3 | 不能给所有工具扩写长手册 | 特定复杂工具出现稳定误用，且 schema/policy 仍不足 |
| M-030 | Layer-Local Negative Constraints | P6 | 负面规则按失败模式增加，不按数量移植 | 规则违反率与定位到具体 Placement 的失败样本形成 |
| M-032 | Structured Few-Shot Contract | P6 | 示例需适配 mi-code，不原文复制 | 结构化输出在 schema/result contract 下仍反复失败 |
| M-033 | Draft / Deliverable Separation | P4 | 不要求或持久化隐藏思维链 | summary fidelity、交付物质量与显式 checklist/schema 的评测证明需要 |
| M-034 | Quantified Conciseness Anchors | P6 | Claude 节省数字不可外推 | mi-code 出现可复现的输出冗长问题和行为评测基线 |
| M-053 | Bounded Prompt Request Dump | P6 | 高敏感，默认关闭 | M-056 已生效，且有明确诊断需求、访问控制与有界 retention |
| M-061 | Model Lifecycle Metadata | P1 | marketing name 不决定 capability | 多模型生命周期、弃用或版本漂移已产生可复现治理问题 |

Deferred：14 项，无缺失、无重复。

## 6. Hold 逐 ID 处置

Hold 机制不受 ValueScore 自动解锁。只有 Evidence gate 满足并经过独立评审，才可重新分类。

| ID | 机制 | Owner | Evidence gate |
|---|---|---|---|
| M-027 | Deferred Tool Discovery | P3 | Provider tokenizer、per-tool schema 成本、调用频率与延迟加载阈值 |
| M-029 | Cache-Preserving Dynamic Attachments | P2 | attachment 数量、体积、来源、失败率；同时为 M-041 提供共享基线 |
| M-036 | Problem-Driven Counterweights | P6 | 规则违反率、失败模式与行为回归集 |
| M-041 | Attachment Budget | P2 | attachment 使用基线；Claude 阈值不得替代 mi-code 证据 |
| M-047 | Scoped Memory Backends | P2 | Team/Agent memory 使用率、跨机器传播路径与审批证据 |
| M-060 | Model-Aware Prompt Caching | P1 | cache hit/miss、Provider token、stable block 与 variant telemetry |
| M-068 | Cross-Platform Windows Path Bypass Detection | P5 | 当前 path checker 审计及 NTFS ADS/8.3/长路径前缀回归语料 |
| M-071 | Information-Disclosure Policy Layers | P5 | mi-code 分发模型、产品政策 owner 与信息披露边界决策 |

Hold：8 项，无缺失、无重复。

## 7. 集合与连续性验证

### 7.1 集合

```text
Designed ∩ Deferred = ∅
Designed ∩ Hold     = ∅
Deferred ∩ Hold     = ∅

Designed ∪ Deferred ∪ Hold = {M-001 ... M-071}
```

### 7.2 连续性

- 最小 ID：M-001；
- 最大 ID：M-071；
- 期望数量：71；
- 实际唯一数量：71；
- 缺号：0；
- 重号：0。

### 7.3 Required 语义

| 类型 | ID | 审计结论 |
|---|---|---|
| Required Dependency | M-018、M-020、M-043 | 均已设计为下游基础输入，不被误报为独立用户能力 |
| Required Reuse | M-019、M-057 | 均冻结接口/identity，明确禁止重写 Provider tool plane 或 adapter |

## 8. DAG 与 Wave 闭包

### 8.1 Designed Wave 计数

| Wave | 机制数 |
|---|---:|
| A | 8 |
| B | 15 |
| C | 13 |
| D | 6 |
| E | 5 |
| F | 1 |
| G | 1 |
| **合计** | **49** |

### 8.2 闭包结果

对 49 个 designed/actionable 节点逐项复核：

- 每个节点的所有 D 前置均位于更早 Wave；
- Wave 内没有通过新增 D-edge 形成隐式顺序；
- M-045/M-046 保持 sibling；
- M-013 只在二者稳定后设计；
- M-049 只消费 M-008/M-013/M-038/M-070；
- BRC-1/M-001 与 CRC-4/M-031 未被隐式添加为 M-049 前置；
- 49 个节点没有依赖倒置。

### 8.3 全局 DAG

冻结 Matrix 的全局 DAG 保持：

- 71 节点；
- 127 条纯 D 边；
- L0～L7；
- 无环；
- Deferred/Hold 仍保留在 DAG 中。

本审计不重写 DAG，只验证 Design Wave 没有偏离它。

## 9. Phase Owner 完整性

| Owner Phase | 机制数 |
|---|---:|
| P1 Prompt Kernel | 12 |
| P2 Context Intelligence | 18 |
| P3 Tool & Agent Intelligence | 16 |
| P4 Context Lifecycle | 5 |
| P5 Security Boundary | 10 |
| P6 Evaluation System | 10 |
| **合计** | **71** |

每项机制只有一个 Owner。Consumer 不产生第二实现，也不改变 Band、输入等级或 Evidence gate。

## 10. Activation Gate 保留情况

以下跨机制 Activation gate 在设计完成后仍然有效：

| 目标 | Gate |
|---|---|
| M-024/M-026 | tool visibility、PermissionChecker 和 executor 使用同一 policy snapshot |
| M-038/M-049 | serializer 与 compressor 支持 meta/pinned metadata |
| M-051/M-052/M-054/M-055 | M-056 redaction/drop policy 已生效 |
| M-053 | M-056 + 访问控制 + 默认关闭 + bounded retention |
| M-066/M-067 | Permission ask 是可持久化、不可绕过的阻塞通道 |
| M-069 | M-040 deterministic ingress 存在；软信号不改变权限 |
| M-070 | pairing failure 有确定性恢复路径 |

机制完成设计不等于满足 runtime Activation gate。

## 11. 不变量审计

| Wave | 范围 | 数量 |
|---|---|---:|
| A | INV-A1～INV-A8 | 8 |
| B | INV-B1～INV-B13 | 13 |
| C | INV-C1～INV-C15 | 15 |
| D | INV-D1～INV-D18 | 18 |
| E | INV-E1～INV-E20 | 20 |
| F | INV-F1～INV-F16 | 16 |
| G | INV-G1～INV-G20 | 20 |
| **合计** |  | **110** |

检查结果：

- 每个 Wave 内编号连续；
- 无重复 INV-ID；
- 上游不变量未被下游放宽；
- Failure 不提升状态、权限、Trust、Use 或 Outcome；
- Snapshot、Authority/Placement、Tool Pairing、Memory Use 和 Atomic Publish 的核心不变量闭合。

## 12. 审计发现

### 12.1 已纠正的统计口径

| 旧表述 | 正确口径 |
|---|---|
| Wave A“核心机制 5” | 5 是 RC 数；实际机制为 8 |
| A～G“46 个 Wave 契约” | 实际为 29 个 Contract |
| A～F“45 个机制” | 实际为 48 个 designed 机制 |
| A～F“66 条不变量” | 实际为 90 条 |
| A～G“全部 71 个机制均完成设计” | 49 已设计；14 Deferred；8 Hold |

这些是汇总口径错误，不改变任何冻结 M-ID、D-edge、Owner、Band 或 Contract 内容。

### 12.2 无设计缺口

未发现：

- designed 机制缺少主规格；
- Deferred/Hold 被误纳入当前实现承诺；
- Hold 缺少 Evidence gate；
- Required Reuse 被重新实现；
- 跨 Wave 依赖倒置；
- M-049 新增隐式 D-edge。

## 13. 审核与冻结标准

本审计只有在以下条件全部满足后才能冻结：

1. M-001～M-071 连续且唯一。
2. Designed=49、Deferred=14、Hold=8。
3. 三集合互斥且并集为 71。
4. 49 个 designed 机制均有唯一主 Contract。
5. 14 个 Deferred 均有边界和触发条件。
6. 8 个 Hold 均有 Evidence gate。
7. Required Dependency/Reuse 语义正确。
8. 49 个 Wave 节点无依赖倒置。
9. 71 节点/127 D-edge/L0～L7 的冻结 DAG 未被改写。
10. Phase Owner 计数为 12/18/16/5/10/10。
11. Contract count=29。
12. Invariant count=110。
13. 未修改任何冻结输入文档。
14. 未进入生产代码、实施任务、工期或 Git 操作。

## 14. 后续流程

本审计审核冻结后：

1. Design Wave 与 71 项处置阶段完成。
2. 使用 `writing-plans` 编写主 Agent/Prompt 机制详细实施计划。
3. 实施计划必须以 49 个 designed/actionable 机制为当前范围。
4. 14 个 Deferred 不进入实施任务，除非触发条件形成并重新评审。
5. 8 个 Hold 不进入实施任务，除非 Evidence gate 解除并重新分类。
6. 实施顺序服从冻结 DAG/Wave，而不是 ValueScore 排名或 Phase 编号。
7. Prompt Library Import 保持独立资产快照；其存在不代表候选 Prompt 已 approved 或 activated。
