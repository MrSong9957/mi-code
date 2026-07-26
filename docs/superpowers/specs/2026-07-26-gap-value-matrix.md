# mi-code Gap / Value Matrix

> 状态：冻结（G1/G2 + T1 全局依赖图 + T2 Phase 输入映射）
> 日期：2026-07-26
> Claude 侧输入：冻结版 `2026-07-26-claude-mechanism-index.md`
> mi-code 侧输入：冻结版 `2026-07-26-agent-prompt-baseline.md`
> 当前覆盖：D01～D10 + Cross，M-001～M-071
> 当前不做：目标架构、Prompt 原文选择、实施排期、代码修改

## 1. 评分目的

矩阵回答的不是“Claude 有什么”，而是：

1. mi-code 是否已经具备该机制？
2. 当前差距是缺失、部分已有、已有但未治理，还是无需迁移？
3. 补齐差距能产生多少边际价值？
4. 价值是否有 Baseline 证据，还是依赖尚未测量的假设？
5. 哪些前置依赖会阻止机制直接进入 Phase 1-6 设计？

## 2. 评分契约

### 2.1 Gap 状态

| 状态 | 定义 |
|---|---|
| `Missing` | 主请求链路不存在该能力 |
| `Partial` | 有局部实现，但缺少关键语义或 enforcement |
| `Existing` | 核心机制已存在，只需保留或做轻量治理 |
| `Unknown` | Baseline 没有足够数据确认差距 |
| `N/A` | 不适合 mi-code 当前产品边界 |

### 2.2 数值维度

每项使用 1～5 分：

| 维度 | 1 | 3 | 5 |
|---|---|---|---|
| `B` 边际收益 | 几乎无用户效果 | 明显改善局部行为 | 决定核心 Agent 正确性 |
| `F` 使用频率 | 极少触发 | 常见任务触发 | 几乎每轮请求触发 |
| `R` 风险降低 | 主要是体验 | 降低显著错误/返工 | 防止安全、权限或虚假完成 |
| `C` 实现成本 | 局部、复用充分 | 跨模块改造 | 新基础设施或高复杂验证 |

分数：

```text
ValueScore = (B × F × R) / C
```

分数按十进制 `round half up` 保留一位小数（例如 31.25 → 31.3），不使用银行家舍入。`B` 是相对于 mi-code 当前实现的边际收益，已存在机制不会因 Claude 也采用而获得高收益。

### 2.3 分档

| 分档 | 分数 | 语义 |
|---|---:|---|
| P0 | ≥ 50 | 核心正确性/安全基础，后续设计优先处理 |
| P1 | 25～49.9 | 高价值，应进入对应 Phase 设计 |
| P2 | 10～24.9 | 有价值，需依赖或成本约束 |
| P3 | < 10 | 低收益、局部优化或当前无证据 |
| Hold | 任意 | 关键基线未知或前置能力未建立，不按分数推进 |

分档不是实施顺序。依赖关系优先于分数，例如高分机制依赖 Prompt Kernel 时，不能跳过 Kernel 直接实施。

同分项也不按表格出现顺序推导实施顺序。排序规则为：先按依赖拓扑确定层级；同一拓扑层内再按 Score 降序、机制域顺序、机制编号升序排列。若依赖图尚未完成，只能记录同分，不得预设先后。

### 2.4 置信度

| 置信度 | 定义 |
|---|---|
| High | Baseline 有明确源码/执行证据，收益路径直接 |
| Medium | 差距明确，但收益大小尚无行为评测 |
| Low | 使用频率、实际失败率或成本依赖未来观测 |

## 3. Batch G1 Matrix

### 3.1 D01 — System Prompt 动态组装

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-001 | `Partial`：有字符串片段，无 section ID/compiler/metadata | 5 | 5 | 3 | 3 | 25.0 | P1 | High | Frozen PromptState、Registry |
| M-002 | `Missing`：无统一来源优先级与 replace/append 语义 | 5 | 5 | 4 | 3 | 33.3 | P1 | High | M-001、Authority model |
| M-003 | `Missing`：无静态/动态 boundary 与 cache scope | 3 | 5 | 2 | 3 | 10.0 | P2 | Medium | M-001、M-055、M-060 |
| M-004 | `Partial`：Plan/reminder 条件拼接，无通用 condition model | 4 | 5 | 2 | 3 | 13.3 | P2 | High | M-001、M-058 |
| M-005 | `Missing`：无 section cache/失效事件 | 2 | 5 | 1 | 2 | 5.0 | P3 | Medium | M-001、lifecycle events |

#### D01 判断

- M-001/M-002 是 Prompt Kernel 的结构基础，不以 token 节省为主要价值。
- M-003/M-005 的成本收益尚无真实 cache 数据，因此不能进入 P1。
- M-004 的价值来自减少无关规则和能力漂移，不是复制 Claude feature flags。

### 3.2 D02 — Context 分层与 Placement

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-006 | `Partial`：有 system/tools/messages，无统一 Placement policy | 5 | 5 | 4 | 3 | 33.3 | P1 | High | M-001、Context Model |
| M-007 | `Missing`：主 Agent 无自动 Git snapshot | 2 | 4 | 1 | 2 | 4.0 | P3 | Medium | Freshness、截断 |
| M-008 | `Missing`：无 meta user context prepend | 5 | 5 | 4 | 3 | 33.3 | P1 | High | M-006、M-010～M-012 |
| M-009 | `Partial`：子 Agent 有环境摘要，主 Agent 无统一字段策略 | 3 | 4 | 2 | 2 | 12.0 | P2 | High | M-006、M-039 |
| M-010 | `Missing`：无项目规则层级发现 | 5 | 5 | 4 | 3 | 33.3 | P1 | High | Trusted source allowlist |
| M-011 | `Missing`：无规则来源/path provenance | 4 | 5 | 4 | 2 | 40.0 | P1 | High | M-010、ContextEnvelope |
| M-012 | `Partial`：Markdown sources 存在，但无统一受信路由 | 5 | 5 | 5 | 3 | 41.7 | P1 | High | M-006、Trusted Extraction |
| M-013 | `Partial`：Memory 文件存在，无自动 bounded entrypoint | 4 | 4 | 3 | 2 | 24.0 | P2 | High | M-042～M-046 |

#### D02 判断

- M-010～M-012 共同构成项目规则进入运行时的最小闭环，不能拆成孤立功能。
- M-007 是便利性机制且存在 snapshot 过时风险，当前不进入高优先级。
- M-013 必须等待 Memory 类型、准入和检索语义，不能先做自动注入。

### 3.3 Cross — 子 Agent 与 Prompt 治理

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-014 | `Partial`：已有 explore/plan/general，缺 Verification contract | 3 | 4 | 2 | 2 | 12.0 | P2 | High | Lifecycle、result schema |
| M-015 | `Partial`：角色分 Prompt，无系统化 context trimming | 2 | 3 | 1 | 2 | 3.0 | P3 | Low | Context telemetry |
| M-016 | `Partial`：fork 继承父 Prompt，但会追加环境/skills | 2 | 2 | 1 | 2 | 2.0 | P3 | Low | Cache evidence |
| M-017 | `Partial`：有 team/inbox 工具，无完整 teammate contract | 2 | 2 | 2 | 3 | 2.7 | P3 | Low | Team lifecycle、M-067 |
| M-018 | `Missing`：无不可变 Registry、variant/eval/version | 4 | 3 | 3 | 3 | 12.0 | P2 | High | Build pipeline、M-055 |

#### Cross 判断

- 子 Agent 不是从零建设；高价值工作应补权限传播、结果契约和 Verification，而非增加更多角色。
- M-015～M-017 缺少使用率、缓存收益和团队任务成功率数据，维持 P3。
- M-018 是治理基础，但完整在线 A/B 平台不在当前必要范围。

### 3.4 D03 — Tool Definitions

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-019 | `Existing`：Provider 原生 tool plane 已存在 | 1 | 5 | 2 | 1 | 10.0 | P2 | High | 保持现状 |
| M-020 | `Partial`：工具就地定义，但无 Prompt 元数据 | 3 | 4 | 2 | 2 | 12.0 | P2 | High | M-018 |
| M-021 | `Partial`：工厂可动态构造，缺统一 context-aware builder | 2 | 3 | 1 | 3 | 2.0 | P3 | Medium | M-022/M-023 |
| M-022 | `Missing`：无 schema cache/hash | 2 | 5 | 1 | 2 | 5.0 | P3 | Low | M-055/M-060 |
| M-023 | `Missing`：无显式稳定排序 | 3 | 5 | 2 | 1 | 30.0 | P1 | High | Tool Registry |
| M-024 | `Partial`：有 Plan filter，无 immutable overlay model | 4 | 5 | 4 | 3 | 26.7 | P1 | High | M-023、Permission |
| M-025 | `Missing`：复杂工具无系统化 few-shot | 2 | 3 | 1 | 2 | 3.0 | P3 | Low | Tool misuse eval |
| M-026 | `Partial`：约束分散，tool-local policy 不完整 | 4 | 5 | 4 | 3 | 26.7 | P1 | High | Permission truth source |
| M-027 | `Missing`：33 个工具全量发送，无 defer loading | 3 | 2 | 1 | 4 | 1.5 | Hold | Low | 真实 tokenizer、tool usage |
| M-028 | `Partial`：主 Prompt 引用工具名，但可能与可见性漂移 | 2 | 5 | 2 | 1 | 20.0 | P2 | High | Reference integrity test |
| M-029 | `Missing`：无动态 attachment plane | 2 | 2 | 1 | 4 | 1.0 | Hold | Low | Attachment usage baseline |

#### D03 判断

- M-019 是复用项，不应因分数达到 10 就建立新项目。
- M-023 是低成本确定性改进；M-024/M-026 则直接关联 Plan/Role/Permission 一致性。
- M-027/M-029 因实际使用频率和成本未知进入 Hold，而不是按 Claude 参数实施。

### 3.5 D04 — Prompt Optimization

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-030 | `Partial`：有负面规则，无来源和违反率 | 2 | 4 | 2 | 2 | 8.0 | P3 | Medium | M-018、evaluation |
| M-031 | `Missing`：Compaction 没有 runtime no-tools contract | 4 | 2 | 4 | 1 | 32.0 | P1 | High | Tool visibility gate |
| M-032 | `Missing`：无结构化 few-shot 资产 | 2 | 2 | 1 | 2 | 2.0 | P3 | Low | Format failure evidence |
| M-033 | `Partial`：summary 有 Prompt，无检查/交付 schema 分离 | 3 | 2 | 2 | 2 | 6.0 | P3 | Medium | Compression eval |
| M-034 | `Missing`：无数字长度锚点；Baseline 也无相关问题 | 1 | 3 | 1 | 1 | 3.0 | P3 | High | 无，当前不做 |
| M-035 | `Partial`：已有 planner/roles，缺统一模板治理 | 4 | 4 | 3 | 3 | 16.0 | P2 | High | M-018、Lifecycle |
| M-036 | `Missing`：无问题指标驱动的 counterweight 流程 | 4 | 3 | 3 | 3 | 12.0 | Hold | Medium | M-055、behavior eval |
| M-037 | `Partial`：有 status/evidence 前缀，无统一结果 schema | 5 | 4 | 4 | 2 | 40.0 | P1 | High | Completion Contract |

#### D04 判断

- M-031 与 M-037 是运行时协议问题，不应被简化为复制成熟 Prompt。
- M-030/M-032/M-034/M-036 必须由行为问题触发；当前不建设“更多 Prompt”项目。
- M-035 只治理已存在的高结构任务模板，不扩张模板数量。

## 4. Batch G1 排序结果

### P1 候选

| 顺序 | ID | Score | 原因 |
|---:|---|---:|---|
| 1 | M-012 | 41.7 | 受信 Markdown 来源路由，是规则/Memory/Agent Prompt 的共同边界 |
| 2 | M-011 | 40.0 | provenance 直接服务冲突、安全和调试 |
| 3 | M-037 | 40.0 | 子 Agent 结果与 Completion Contract 的关键缺口 |
| 4 | M-002 | 33.3 | Prompt Authority/replace/append 的统一入口 |
| 5 | M-006 | 33.3 | Placement policy 基础 |
| 6 | M-008 | 33.3 | 项目规则进入请求的必要通道 |
| 7 | M-010 | 33.3 | 项目规则发现入口 |
| 8 | M-031 | 32.0 | Compaction no-tools 的低成本硬边界 |
| 9 | M-023 | 30.0 | 工具 schema 确定性排序，成本低 |
| 10 | M-024 | 26.7 | 统一 mode/role 工具 overlay |
| 11 | M-026 | 26.7 | 工具说明与真实权限策略对齐 |
| 12 | M-001 | 25.0 | 上述 Prompt 能力的结构锚点 |

### Hold

| ID | 原因 | 解锁证据 |
|---|---|---|
| M-027 | 不知道 tool schema 是否达到真实模型的延迟加载收益阈值 | Provider tokenizer + per-tool usage |
| M-029 | 没有 attachment 使用基线 | attachment 数量、体积、来源 |
| M-036 | 没有规则违反率和行为回归集 | Evaluation baseline |

## 5. Batch G1 约束结论

1. P1 中 M-001、M-002、M-006 是基础依赖，实际设计顺序高于单纯 Score 排名。
2. M-008、M-010～M-012 必须作为项目规则闭环一起设计。
3. M-023 可以独立成为低成本确定性改进，但不能替代 M-024 的 runtime overlay。
4. M-031、M-037 应进入 Lifecycle/Tool enforcement 设计，不归入“提示词美化”。
5. 成熟 Prompt 库在 G1 中没有任何“原文直接嵌入”结论；选择必须等 Phase 设计和评测契约。

## 6. Batch G2 Matrix

### 6.1 D05 — Context Injection

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-038 | `Missing`：无 meta message 与独立 retention policy | 5 | 5 | 4 | 3 | 33.3 | P1 | High | M-008、compressor、session serializer |
| M-039 | `Partial`：子 Agent 直接拼环境字段，无统一规范化与隐私策略 | 3 | 3 | 3 | 2 | 13.5 | P2 | High | Platform adapter、field policy |
| M-040 | `Missing`：无统一 Context 入口清洗与来源级策略 | 5 | 5 | 5 | 4 | 31.3 | P1 | High | ContextEnvelope、M-062、trusted loaders |
| M-041 | `Missing`：无独立 attachment plane 与预算；实际使用量未知 | 2 | 1 | 2 | 3 | 1.3 | Hold | Low | Attachment usage baseline、M-040 |

#### D05 判断

- M-038 是 M-008 的生命周期配套，不得用重复注入规则替代 retention。
- M-040 是规则、Memory、工具结果和附件的共同入口安全基础，但不能替代各执行出口的 enforcement。
- M-041 保持 Hold；Claude 的 20KB/60KB 参数不进入 mi-code 目标值。

### 6.2 D06 — Memory

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-042 | `Missing`：规则与模型经验没有 Authority/Writer 强制分离 | 5 | 3 | 5 | 3 | 25.0 | P1 | High | Context Model、separate loaders |
| M-043 | `Missing`：无 type/confidence/evidence/invalidation schema | 4 | 3 | 4 | 3 | 16.0 | P2 | High | Memory schema、validator |
| M-044 | `Missing`：无准入、时效验证与禁止保存策略 | 5 | 3 | 5 | 3 | 25.0 | P1 | High | M-043、Trusted Extraction |
| M-045 | `Partial`：已有索引与条目文件，未接 completion/memory policy | 3 | 2 | 2 | 2 | 6.0 | P3 | High | M-044、atomic writer |
| M-046 | `Partial`：已有 keyword selection，未进入主请求链路 | 4 | 3 | 3 | 3 | 12.0 | P2 | Medium | M-043～M-045、selection budget |
| M-047 | `Partial`：主 Memory 与团队工具存在，无统一 scope contract | 3 | 2 | 5 | 4 | 7.5 | Hold | Low | Team usage baseline、M-066/M-067 |

#### D06 判断

- M-042 与 M-044 是启用自动 Memory 前的准入门，不因当前 Memory 使用率未知而跳过。
- M-043 提供 M-044/M-046 所需的数据契约；其分数低于二者不代表可以后置实施。
- M-045 应复用现有 MemoryManager，不建立第二套存储。
- M-047 涉及跨 Agent/机器信任扩散，团队使用基线和审批通道缺失时保持 Hold。

### 6.3 D07 — Compression / Prompt Sizing

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-048 | `Partial`：只有 Normal/Plan 差异，无 section capability profile | 3 | 5 | 2 | 3 | 10.0 | P2 | Medium | M-001、M-004、M-058 |
| M-049 | `Missing`：压缩后无 Pinned Working Set 选择性重注入 | 5 | 2 | 5 | 3 | 16.7 | P2 | High | M-038、M-070、source reload |
| M-050 | `Missing`：项目规则源不存在统一大小限制和溢出提示 | 4 | 5 | 3 | 2 | 30.0 | P1 | High | M-010～M-013、token budget |

#### D07 判断

- M-048 只能裁剪能力相关 section，不能裁剪安全、权限和 Completion Contract。
- M-049 的触发频率尚未知，因此不因高风险直接升为 P1；但一旦启用 compaction，它是正确性依赖。
- M-050 的价值来自防止单一来源吞噬预算；截断必须显式报告，不能静默丢弃 pinned 内容。

### 6.4 D08 — Observability

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-051 | `Partial`：有日志和总 usage，无敏感度分层观测平面 | 4 | 5 | 4 | 3 | 26.7 | P1 | High | Event model、retention、M-056 |
| M-052 | `Partial`：有 debug/task logs，无 section 级时序事件 | 2 | 5 | 2 | 2 | 10.0 | P2 | High | M-051、stable IDs |
| M-053 | `Missing`：无受限 final request dump 与最近请求环 | 4 | 2 | 3 | 4 | 6.0 | P3 | Medium | M-051、M-056、access gate |
| M-054 | `Missing`：Permission/bash policy 无结构化 decision trace | 4 | 4 | 4 | 2 | 32.0 | P1 | High | Decision ID、error taxonomy |
| M-055 | `Missing`：无法按 Prompt section/tool schema 归因成本和漂移 | 5 | 5 | 4 | 3 | 33.3 | P1 | High | M-001、M-018、compiler snapshot |
| M-056 | `Missing`：无统一 telemetry redaction 与 PII 字段策略 | 5 | 5 | 5 | 3 | 41.7 | P1 | High | M-051、field schema、drop policy |

#### D08 判断

- M-055 是解除 cache、profile 和规则成本未知的主要数据入口，但依赖稳定 Registry/section IDs。
- M-056 必须与 M-051 同批设计；先扩大采集再补 redaction 不满足安全边界。
- M-053 是高敏感诊断能力，不是观测基础设施的默认组成；当前保持 P3、默认关闭。
- M-054 先覆盖已存在的 PermissionChecker 与 bash policy，不创建未使用的 classifier。

### 6.5 D09 — Model Adaptation

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-057 | `Existing`：三家 Provider adapter 已承载传输差异 | 2 | 5 | 2 | 2 | 10.0 | P2 | High | 保持并治理现有 adapter |
| M-058 | `Missing`：无统一 model capability registry | 5 | 5 | 4 | 3 | 33.3 | P1 | High | Model registry、safe fallback |
| M-059 | `Partial`：支持自定义 endpoint/model，无受信 capability override | 4 | 3 | 4 | 3 | 16.0 | P2 | Medium | M-057/M-058、trusted config |
| M-060 | `Missing`：无 model-aware cache control 与命中基线 | 3 | 5 | 2 | 4 | 7.5 | Hold | Low | M-003、M-055、M-058 |
| M-061 | `Partial`：配置中有 model ID，无集中生命周期元数据 | 3 | 3 | 2 | 2 | 9.0 | P3 | Medium | M-018、M-058、release policy |

#### D09 判断

- M-057 是复用项；不建立第四层 Prompt 条件分支去重复 adapter 职责。
- M-058 决定有效能力集合，M-059 只能经受信配置收窄或修正，Agent 无权自行提升。
- M-060 在 cache hit/miss 与真实 token 归因建立前保持 Hold。
- M-061 的营销名称、知识截止和退役信息不得作为 capability 判断依据。

### 6.6 D10 — Security

| ID | mi-code 现状 / Gap | B | F | R | C | Score | 档 | 信心 | 主要依赖 |
|---|---|---:|---:|---:|---:|---:|---|---|---|
| M-062 | `Partial`：权限、路径、bash 与 Prompt 约束存在但未形成统一链路 | 5 | 5 | 5 | 4 | 31.3 | P1 | High | Risk model、decision events |
| M-063 | `Missing`：无统一 child-process environment scrubber | 5 | 4 | 5 | 4 | 25.0 | P1 | High | Subprocess entrypoint、variable policy |
| M-064 | `Partial`：有 parser/denylist；无 AST/shadow/too-complex 契约 | 4 | 4 | 5 | 5 | 16.0 | P2 | Medium | Plan allowlist、decision trace、shell grammar |
| M-065 | `Missing`：无 binary hijack 与前导 env assignment 防御 | 4 | 3 | 5 | 4 | 15.0 | P2 | Medium | M-063/M-064、executable resolution |
| M-066 | `Missing`：跨机器动作没有不可自动批准的真实 ask 门 | 5 | 1 | 5 | 2 | 12.5 | P2 | High | NeedUserDecision、blocking ask |
| M-067 | `Partial`：权限传播有已知缺口，无 handoff validation | 5 | 3 | 5 | 4 | 18.8 | P2 | High | M-037、M-062、permission propagation |
| M-068 | `Unknown`：现有 path checker 对 NTFS 绕过覆盖未确认 | 4 | 3 | 5 | 3 | 20.0 | Hold | Medium | Path regression corpus、checker audit |
| M-069 | `Missing`：无 trust metadata、injection envelope 与怀疑信号通道 | 5 | 5 | 5 | 3 | 41.7 | P1 | High | M-040、ToolResultEnvelope |
| M-070 | `Missing`：INV-8 已冻结，runtime/压缩/恢复尚无配对验证器 | 5 | 4 | 5 | 2 | 50.0 | P0 | High | Tool call ID、message validator |
| M-071 | `Partial`：有零散安全措辞，无产品政策 ownership/version | 2 | 3 | 2 | 3 | 4.0 | Hold | Low | Product boundary、policy owner、M-018 |

#### D10 判断

- M-070 是 G2 唯一 P0：每次工具链路都依赖配对完整性，且已有 frozen INV-8，当前实现缺少硬验证器。
- M-062 是安全层的协调契约，不以复制 Claude 的七层数量为目标。
- M-063/M-065 分别控制继承环境和命令内联变量；不能以其中一个代替另一个。
- M-064 不替代冻结的 Plan Mode allowlist；AST policy 需在现有误拒绝/漏放基线建立后决定实施深度。
- M-066/M-067 的真实前置是接通不可绕过的 blocking `ask` 与权限传播，不是增加 Prompt 警告。
- M-068 因当前路径覆盖未知保持 Hold；M-071 因产品政策边界未确定保持 Hold。

## 7. Batch G2 排序结果

### P0 / P1 候选

| 顺序 | ID | Score | 原因 |
|---:|---|---:|---|
| 1 | M-070 | 50.0 | frozen INV-8 的 runtime 完整性门 |
| 2 | M-056 | 41.7 | 所有生产 telemetry 的安全准入 |
| 3 | M-069 | 41.7 | untrusted context 与 injection 边界 |
| 4 | M-038 | 33.3 | 项目规则和 pinned context 的生命周期 |
| 5 | M-055 | 33.3 | Prompt/tool 成本与漂移的归因基础 |
| 6 | M-058 | 33.3 | Provider/model 有效能力的统一来源 |
| 7 | M-054 | 32.0 | 现有权限/命令判定的可诊断证据 |
| 8 | M-040 | 31.3 | Context 入口的确定性安全过滤 |
| 9 | M-062 | 31.3 | 分散安全防线的统一决策契约 |
| 10 | M-050 | 30.0 | 单一 Context Source 的预算硬边界 |
| 11 | M-051 | 26.7 | 观测数据面的敏感度分层 |
| 12 | M-042 | 25.0 | 指令与自动记忆的 Authority 分权 |
| 13 | M-044 | 25.0 | 自动记忆的准入与使用前验证 |
| 14 | M-063 | 25.0 | 子进程 secret 暴露的执行出口 |

该表按 Score 降序展示候选；同分项暂按机制域顺序和 ID 排列。它不是全局实施顺序，跨域依赖拓扑尚未归并。

### Hold

| ID | 原因 | 解锁证据 |
|---|---|---|
| M-041 | attachment 使用频率、体积和来源未知 | Attachment usage baseline |
| M-047 | Team/Agent memory 使用率及跨机器传播路径未知 | Team usage + trust propagation baseline |
| M-060 | 无 cache hit/miss、Provider token 与 section 成本基线 | M-055 telemetry |
| M-068 | NTFS ADS/8.3/长路径前缀的现有覆盖未知 | Path checker audit + regression corpus |
| M-071 | mi-code 产品分发和信息披露政策边界未决 | Policy ownership decision |

## 8. Batch G2 约束结论

1. G2 首先暴露的是运行时契约缺口：M-070、M-040、M-062、M-069 不能降格为 Prompt 文本项目。
2. 自动 Memory 的依赖链为 M-042 → M-043 → M-044 → M-045/M-046；分数不能覆盖该拓扑。
3. Observability 必须以 M-051/M-056 的分层与清洗为边界，再由 M-055 提供成本归因；不得先开启全量 dump。
4. Model adaptation 以 M-058 capability registry 为真相源，M-057 继续负责 Provider 传输差异。
5. G2 没有产生任何成熟 Prompt 原文直接复用结论。M-069/M-071 即使涉及 Prompt，也分别受确定性入口防御与产品政策 ownership 约束。

## 9. 下一步边界

Batch G2 已冻结，矩阵进入全局归并：

1. 合并 G1/G2 的 P0～P3 与 Hold；
2. 建立跨域依赖图；
3. 在同一拓扑层内应用 Score → 域顺序 → ID 的平分规则；
4. 将机制映射到 Phase 1～6 的设计输入；
5. 仍不编写实施任务、文件改动或 Prompt 原文选择。

## 10. 全局依赖图模型

### 10.1 方案比较

| 方案 | 优点 | 缺陷 | 结论 |
|---|---|---|---|
| 单一总排序 | 阅读简单 | 把价值、依赖和实施顺序混成一个数字 | 拒绝 |
| 无类型 DAG | 能表达前置关系 | 会把启用门、证据门误写成设计阻塞 | 拒绝 |
| 类型化依赖图 | 区分设计、启用和证据约束，可做确定性拓扑检查 | 文档结构更长 | 采用 |

### 10.2 边类型

| 类型 | 语义 | 是否参与拓扑排序 |
|---|---|---|
| `D` Design | 目标机制的语义设计依赖前置机制先稳定 | 是 |
| `A` Activation | 可以先设计，但没有该条件不得在运行时启用 | 否 |
| `E` Evidence | 没有测量证据不得解除 Hold 或宣称收益 | 否 |
| `S` Soft | 互补、可共享数据或共同评测，不构成阻塞 | 否 |

本文中的箭头统一表示“前置 → 目标”。拓扑层只由 `D` 边计算。Layer 越小只表示越早具备设计条件，不表示价值更高；例如无依赖的 M-034 位于 L0，但仍是 P3。

### 10.3 建图约束

1. Phase 0 已冻结的 Operating、Context、Verification、Lifecycle 与 Permission 语义作为外部根，不重复编号。
2. `Existing` 机制仍作为复用锚点进入图，例如 M-019、M-057；进入图不代表重写。
3. Hold 节点保留其理论拓扑层，但在 `E` 门解除前不进入 Phase 设计范围。
4. 双向互补关系不强制制造环；只有“缺少前者就无法稳定定义后者”才登记为 `D`。
5. 同一 Layer 内没有隐含先后，后续只按 Score、域顺序、ID 做展示排序。

## 11. 71 节点 Design 依赖表

### 11.1 M-001～M-018

| ID | D 前置 | Layer | 档 |
|---|---|---:|---|
| M-001 | M-018 | L1 | P1 |
| M-002 | M-001 | L2 | P1 |
| M-003 | M-001 | L2 | P2 |
| M-004 | M-001, M-058 | L2 | P2 |
| M-005 | M-001 | L2 | P3 |
| M-006 | — | L0 | P1 |
| M-007 | M-006, M-039, M-050 | L2 | P3 |
| M-008 | M-006, M-010, M-011, M-012, M-050 | L3 | P1 |
| M-009 | M-006, M-039 | L2 | P2 |
| M-010 | — | L0 | P1 |
| M-011 | M-010 | L1 | P1 |
| M-012 | M-006, M-010, M-040 | L2 | P1 |
| M-013 | M-042, M-043, M-044, M-045, M-046, M-050 | L5 | P2 |
| M-014 | M-037 | L1 | P2 |
| M-015 | M-014, M-055 | L4 | P3 |
| M-016 | M-003, M-014, M-055 | L4 | P3 |
| M-017 | M-014, M-037, M-067 | L3 | P3 |
| M-018 | — | L0 | P2 |

### 11.2 M-019～M-037

| ID | D 前置 | Layer | 档 |
|---|---|---:|---|
| M-019 | — | L0 | P2 |
| M-020 | M-018 | L1 | P2 |
| M-021 | M-023, M-024 | L2 | P3 |
| M-022 | M-023, M-055 | L4 | P3 |
| M-023 | — | L0 | P1 |
| M-024 | M-023, M-062 | L1 | P1 |
| M-025 | M-020 | L2 | P3 |
| M-026 | M-020, M-024, M-062 | L2 | P1 |
| M-027 | M-022, M-055, M-058 | L5 | Hold |
| M-028 | M-024, M-026 | L3 | P2 |
| M-029 | M-040, M-041 | L3 | Hold |
| M-030 | M-018, M-055 | L4 | P3 |
| M-031 | M-024 | L2 | P1 |
| M-032 | M-018 | L1 | P3 |
| M-033 | M-037, M-049, M-070 | L7 | P3 |
| M-034 | — | L0 | P3 |
| M-035 | M-018, M-037 | L1 | P2 |
| M-036 | M-055 | L4 | Hold |
| M-037 | — | L0 | P1 |

### 11.3 M-038～M-050

| ID | D 前置 | Layer | 档 |
|---|---|---:|---|
| M-038 | M-008 | L4 | P1 |
| M-039 | M-006, M-062 | L1 | P2 |
| M-040 | M-006, M-062 | L1 | P1 |
| M-041 | M-040 | L2 | Hold |
| M-042 | M-006 | L1 | P1 |
| M-043 | M-042 | L2 | P2 |
| M-044 | M-040, M-043 | L3 | P1 |
| M-045 | M-044 | L4 | P3 |
| M-046 | M-043, M-044 | L4 | P2 |
| M-047 | M-044, M-066, M-067 | L4 | Hold |
| M-048 | M-001, M-004, M-058 | L3 | P2 |
| M-049 | M-008, M-013, M-038, M-070 | L6 | P2 |
| M-050 | M-006, M-010 | L1 | P1 |

### 11.4 M-051～M-061

| ID | D 前置 | Layer | 档 |
|---|---|---:|---|
| M-051 | M-062 | L1 | P1 |
| M-052 | M-051, M-055 | L4 | P2 |
| M-053 | M-051, M-055, M-056 | L4 | P3 |
| M-054 | M-051, M-062 | L2 | P1 |
| M-055 | M-001, M-018, M-020, M-023, M-051, M-056 | L3 | P1 |
| M-056 | M-051, M-062 | L2 | P1 |
| M-057 | — | L0 | P2 |
| M-058 | M-057 | L1 | P1 |
| M-059 | M-058 | L2 | P2 |
| M-060 | M-003, M-055, M-058 | L4 | Hold |
| M-061 | M-018, M-058 | L2 | P3 |

### 11.5 M-062～M-071

| ID | D 前置 | Layer | 档 |
|---|---|---:|---|
| M-062 | — | L0 | P1 |
| M-063 | M-062 | L1 | P1 |
| M-064 | M-054, M-062 | L3 | P2 |
| M-065 | M-063, M-064 | L4 | P2 |
| M-066 | M-062 | L1 | P2 |
| M-067 | M-014, M-037, M-062 | L2 | P2 |
| M-068 | M-062 | L1 | Hold |
| M-069 | M-040, M-062 | L2 | P1 |
| M-070 | M-019 | L1 | P0 |
| M-071 | M-018, M-039, M-062 | L2 | Hold |

### 11.6 D 边计数口径

D 前置数量的可复现分布为：

```text
0 条 × 9 项  = 0
1 条 × 23 项 = 23
2 条 × 22 项 = 44
3 条 × 13 项 = 39
4 条 × 1 项  = 4
5 条 × 1 项  = 5
6 条 × 2 项  = 12
------------------
合计 71 项、127 条 D 边
```

该计数只包含第 11 节表中的 `D` 前置，不包含第 12 节的 `A/E` 门、`S` 关系或 Phase 0 外部根。9 个零前置节点为 M-006、M-010、M-018、M-019、M-023、M-034、M-037、M-057、M-062。

## 12. Activation 与 Evidence 门

### 12.1 Activation 门

| 目标 | 运行时启用前必须满足 |
|---|---|
| M-024/M-026 | mode/role 可见性、PermissionChecker 与真实工具执行使用同一策略快照 |
| M-038/M-049 | session serializer 与 compressor 都识别 meta/pinned metadata |
| M-051/M-052/M-054/M-055 | M-056 的最小字段策略、redaction 与 drop policy 已生效 |
| M-053 | M-056 已生效，且存在显式访问控制、默认关闭和有界 retention |
| M-066/M-067 | Permission `ask` 已成为不可绕过的阻塞通道，pending decision 可持久化 |
| M-069 | M-040 的确定性入口检查与 ToolResultEnvelope 已存在；软告警不得单独改变权限 |
| M-070 | pairing 失败具有确定性的 failed/partial/awaiting-user 恢复路径 |

### 12.2 Hold 的 Evidence 门

| Hold 节点 | 解除条件 |
|---|---|
| M-027 | Provider tokenizer、per-tool schema 成本、调用频率与延迟加载阈值 |
| M-029 | attachment 数量、体积、来源、失败率；同时解除 M-041 |
| M-036 | 规则违反率、失败模式与行为回归集 |
| M-041 | attachment 使用基线；Claude 阈值不得作为替代证据 |
| M-047 | Team/Agent memory 使用率、跨机器传播路径与审批证据 |
| M-060 | cache hit/miss、Provider token、stable block 与 variant telemetry |
| M-068 | 当前 path checker 审计及 NTFS ADS/8.3/长路径前缀回归语料 |
| M-071 | mi-code 分发模型、产品政策 owner 与信息披露边界决策 |

M-029 与 M-041 共享 attachment 基线，但不是同一机制：M-041 决定预算，M-029 决定动态 attachment plane 是否值得建立。

## 13. Design 拓扑层

以下层级包含全部 71 个节点，包括 Existing、P3 和 Hold。方括号标记 Hold；层级不是实施批次。

| Layer | 节点 |
|---:|---|
| L0 | M-006, M-010, M-018, M-019, M-023, M-034, M-037, M-057, M-062 |
| L1 | M-001, M-011, M-014, M-020, M-024, M-032, M-035, M-039, M-040, M-042, M-050, M-051, M-058, M-063, M-066, M-068 `[Hold]`, M-070 |
| L2 | M-002, M-003, M-004, M-005, M-007, M-009, M-012, M-021, M-025, M-026, M-031, M-041 `[Hold]`, M-043, M-054, M-056, M-059, M-061, M-067, M-069, M-071 `[Hold]` |
| L3 | M-008, M-017, M-028, M-029 `[Hold]`, M-044, M-048, M-055, M-064 |
| L4 | M-015, M-016, M-022, M-030, M-036 `[Hold]`, M-038, M-045, M-046, M-047 `[Hold]`, M-052, M-053, M-060 `[Hold]`, M-065 |
| L5 | M-013, M-027 `[Hold]` |
| L6 | M-049 |
| L7 | M-033 |

### 13.1 关键路径

```text
Project Rules:
M-062 + M-006 + M-010
  → M-040 / M-011 / M-050
  → M-012
  → M-008
  → M-038

Memory:
M-006 → M-042 → M-043
  → M-040 + M-044
  → M-045 / M-046
  → M-013

Observability:
M-062 → M-051 → M-056
M-018 → M-001 / M-020
M-023 + M-001 + M-020 + M-051 + M-056
  → M-055

Tool Safety:
M-019 → M-070
M-023 + M-062 → M-024
M-018 → M-020
M-020 + M-024 + M-062 → M-026

Compression:
M-008 → M-038
Memory path → M-013
M-008 + M-013 + M-038 + M-070
  → M-049
  → M-033
```

## 14. T1 约束结论

1. M-070 虽为唯一 P0，但不是所有设计的全局根；它是 Tool Safety 与 Compression 的关键前置。
2. M-062、M-006、M-010、M-018、M-023、M-037 是 L0 中具有下游放大效应的设计根；M-034 位于 L0 仅因为无依赖，不能据此提升优先级。
3. Project Rules 的最短闭环不是 M-008 单点，而是 M-006/M-010/M-011/M-012/M-040/M-050 → M-008 → M-038。
4. Memory 链维持 G2 冻结语义：M-045 与 M-046 都依赖 M-044，可并行设计；M-013 等二者稳定后形成 bounded entrypoint。
5. Observability 的“可设计”与“可启用”分离：M-051 可先定义，但没有 M-056 不得启用生产采集。
6. 8 个 Hold 节点保留在 DAG 中，避免解除 Evidence 门后重新发明依赖；它们当前不进入 Phase 设计承诺。
7. T1 只冻结机制间依赖语义。通过审核后，下一步才把可行动节点归并为 Phase 1～6 的设计输入和设计批次。

## 15. Phase 输入映射模型

### 15.1 方案比较

| 方案 | 优点 | 缺陷 | 结论 |
|---|---|---|---|
| 按机制域直接复制到 Phase | 省事 | Cross 和 Security/Observability 会重复归属 | 拒绝 |
| 每个机制只记录一个 Phase | 主责清晰 | 丢失跨 Phase 消费关系 | 拒绝 |
| 唯一主责 + 消费者 + 输入等级 | 既能防重复项目，又保留跨域契约 | 需要完整覆盖表 | 采用 |

每个机制只能有一个 Owner Phase。Consumer Phase 只读取 Owner 产出的契约，不复制实现责任。Owner 是设计责任，不保证该机制当前会进入实施。

### 15.2 输入等级

| 等级 | 进入规则 |
|---|---|
| `Core` | P0/P1，必须进入对应 Phase 设计 |
| `Required Dependency` | 分数低于 P1，但位于 Core 的 D-前置闭包中 |
| `Required Reuse` | 已有机制，且位于 Core 的 D-前置闭包中；要求复用和治理，不重写 |
| `Conditional` | P2，或是非 Hold P2 的必要 P3 前置；进入设计但允许条件式落地 |
| `Deferred` | P3 且不阻塞 P0～P2，登记边界但不形成当前设计承诺 |
| `Hold` | Evidence 门未解除，不进入当前 Phase 设计承诺 |

P0/P1 共 26 项。其 D-前置闭包新增 5 项：M-018、M-019、M-020、M-043、M-057。非 Hold P0～P2 的闭包只额外提升一个 P3：M-045。因此全局输入等级为：

```text
Core                 26
Required Dependency   3
Required Reuse        2
Conditional          18
Deferred             14
Hold                  8
-----------------------
Total                71
```

输入等级不修改原始分档；例如 M-043 仍为 P2，只是作为 M-044 的硬前置必须进入设计。

### 15.3 Phase 编号语义

Phase 1～6 是稳定的责任域，不是严格时间轴。跨 Phase 的 `D` 边优先于编号，设计工作按第 18 节 Design Wave 展开。

## 16. Phase 责任边界

| Phase | 主责 | 明确不负责 |
|---|---|---|
| Phase 1 Prompt Kernel | Prompt Registry/compiler、section、profile、model capability | 项目规则内容、工具执行权限、行为评测 |
| Phase 2 Context Intelligence | Context Source、Placement 输入、项目规则、Memory、环境与附件上下文 | 命令执行安全、session 压缩实现 |
| Phase 3 Tool & Agent Intelligence | Tool registry/exposure、Agent role/delegation/result contract | 通用 Context 生命周期、全局安全策略 |
| Phase 4 Context Lifecycle | retention、compression、session continuity、tool pair integrity | Context 来源发现、产品安全政策 |
| Phase 5 Security Boundary | trust、permission、ingress/egress、command/path/delegation enforcement | Prompt 成本优化、生产 telemetry 数据面 |
| Phase 6 Evaluation System | observability planes、telemetry、decision trace、行为回归与 Prompt 资产准入 | 生产权限决策本身 |

## 17. 71 项 Owner / Consumer 映射

### 17.1 Phase 1 — Prompt Kernel

| ID | Band | 输入等级 | Consumer |
|---|---|---|---|
| M-001 | P1 | Core | P2, P3, P6 |
| M-002 | P1 | Core | P2, P3 |
| M-003 | P2 | Conditional | P4, P6 |
| M-004 | P2 | Conditional | P2, P3 |
| M-005 | P3 | Deferred | P4, P6 |
| M-018 | P2 | Required Dependency | P2, P3, P6 |
| M-048 | P2 | Conditional | P2, P3, P4 |
| M-057 | P2 | Required Reuse | P3 |
| M-058 | P1 | Core | P2, P3, P4 |
| M-059 | P2 | Conditional | P5 |
| M-060 | Hold | Hold | P6 |
| M-061 | P3 | Deferred | P5 |

### 17.2 Phase 2 — Context Intelligence

| ID | Band | 输入等级 | Consumer |
|---|---|---|---|
| M-006 | P1 | Core | P1, P4, P5 |
| M-007 | P3 | Deferred | P5 |
| M-008 | P1 | Core | P4, P5 |
| M-009 | P2 | Conditional | P3, P5 |
| M-010 | P1 | Core | P5 |
| M-011 | P1 | Core | P5, P6 |
| M-012 | P1 | Core | P5 |
| M-013 | P2 | Conditional | P4 |
| M-029 | Hold | Hold | P3, P5 |
| M-039 | P2 | Conditional | P3, P5 |
| M-041 | Hold | Hold | P3, P5 |
| M-042 | P1 | Core | P5 |
| M-043 | P2 | Required Dependency | P5, P6 |
| M-044 | P1 | Core | P5, P6 |
| M-045 | P3 | Conditional | P4 |
| M-046 | P2 | Conditional | P6 |
| M-047 | Hold | Hold | P3, P5 |
| M-050 | P1 | Core | P1, P4 |

### 17.3 Phase 3 — Tool & Agent Intelligence

| ID | Band | 输入等级 | Consumer |
|---|---|---|---|
| M-014 | P2 | Conditional | P4, P5 |
| M-015 | P3 | Deferred | P1, P6 |
| M-016 | P3 | Deferred | P1, P6 |
| M-017 | P3 | Deferred | P5 |
| M-019 | P2 | Required Reuse | P4, P5 |
| M-020 | P2 | Required Dependency | P1, P6 |
| M-021 | P3 | Deferred | P1 |
| M-022 | P3 | Deferred | P1, P6 |
| M-023 | P1 | Core | P1, P6 |
| M-024 | P1 | Core | P1, P5 |
| M-025 | P3 | Deferred | P6 |
| M-026 | P1 | Core | P1, P5 |
| M-027 | Hold | Hold | P1, P6 |
| M-028 | P2 | Conditional | P1, P6 |
| M-035 | P2 | Conditional | P1, P4 |
| M-037 | P1 | Core | P4, P6 |

### 17.4 Phase 4 — Context Lifecycle

| ID | Band | 输入等级 | Consumer |
|---|---|---|---|
| M-031 | P1 | Core | P3, P5 |
| M-033 | P3 | Deferred | P3, P6 |
| M-038 | P1 | Core | P2 |
| M-049 | P2 | Conditional | P2, P3 |
| M-070 | P0 | Core | P3, P5 |

### 17.5 Phase 5 — Security Boundary

| ID | Band | 输入等级 | Consumer |
|---|---|---|---|
| M-040 | P1 | Core | P2, P3 |
| M-062 | P1 | Core | P2, P3, P4, P6 |
| M-063 | P1 | Core | P3 |
| M-064 | P2 | Conditional | P3, P6 |
| M-065 | P2 | Conditional | P3 |
| M-066 | P2 | Conditional | P3, P4 |
| M-067 | P2 | Conditional | P3 |
| M-068 | Hold | Hold | P2, P3 |
| M-069 | P1 | Core | P2, P3 |
| M-071 | Hold | Hold | P1, P6 |

### 17.6 Phase 6 — Evaluation System

| ID | Band | 输入等级 | Consumer |
|---|---|---|---|
| M-030 | P3 | Deferred | P1, P3, P4, P5 |
| M-032 | P3 | Deferred | P1, P3 |
| M-034 | P3 | Deferred | P1 |
| M-036 | Hold | Hold | P1, P2, P3, P4, P5 |
| M-051 | P1 | Core | P1, P2, P3, P4, P5 |
| M-052 | P2 | Conditional | P1, P3, P4 |
| M-053 | P3 | Deferred | P1, P3, P4, P5 |
| M-054 | P1 | Core | P3, P5 |
| M-055 | P1 | Core | P1, P3 |
| M-056 | P1 | Core | P5 |

## 18. 跨 Phase Design Wave

Design Wave 只包含 Core、Required Dependency、Required Reuse 和 Conditional。Deferred/Hold 保留映射但不进入当前设计批次。

### Wave A — Root Contracts

| Phase | 输入 |
|---|---|
| P1 | M-018, M-057 |
| P2 | M-006, M-010 |
| P3 | M-019, M-023, M-037 |
| P5 | M-062 |

产出：Registry ownership、Context placement vocabulary、Tool/Result identity、Completion schema、Provider adapter reuse boundary、Security decision vocabulary。

### Wave B — Primary Anchors

| Phase | 输入 |
|---|---|
| P1 | M-001, M-058 |
| P2 | M-011, M-039, M-042, M-050 |
| P3 | M-014, M-020, M-024, M-035 |
| P4 | M-070 |
| P5 | M-040, M-063, M-066 |
| P6 | M-051 |

产出：Prompt compiler anchor、capability registry、provenance、Memory Authority 分离、source guard、tool overlay、pairing contract、ingress/egress 基础和 observability plane。

### Wave C — Policy Contracts

| Phase | 输入 |
|---|---|
| P1 | M-002, M-003, M-004, M-059 |
| P2 | M-009, M-012, M-043 |
| P3 | M-026 |
| P4 | M-031 |
| P5 | M-067, M-069 |
| P6 | M-054, M-056 |

产出：Prompt precedence/profile 条件、trusted routing、Memory schema、tool policy truth source、no-tools contract、delegation/injection enforcement、decision trace 与 telemetry redaction。

### Wave D — Integrated Capabilities

| Phase | 输入 |
|---|---|
| P1 | M-048 |
| P2 | M-008, M-044 |
| P3 | M-028 |
| P5 | M-064 |
| P6 | M-055 |

产出：mode profile、项目规则注入闭环、Memory admission、tool reference integrity、command shadow evaluation、Prompt/tool telemetry。

### Wave E — Lifecycle and Selection

| Phase | 输入 |
|---|---|
| P2 | M-045, M-046 |
| P4 | M-038 |
| P5 | M-065 |
| P6 | M-052 |

### Wave F — Bounded Memory Entrypoint

| Phase | 输入 |
|---|---|
| P2 | M-013 |

### Wave G — Post-Compact Reconstruction

| Phase | 输入 |
|---|---|
| P4 | M-049 |

### Wave 节点计数

| Wave | 节点数 |
|---:|---:|
| A | 8 |
| B | 15 |
| C | 13 |
| D | 6 |
| E | 5 |
| F | 1 |
| G | 1 |
| **合计** | **49** |

Wave 字母不是实现里程碑。每个 Wave 只表示其 Design 前置已满足；同一 Wave 内可以并行评审。

## 19. 反向依赖审计

以下关系证明 Phase 不能按编号串行完成：

| 后续编号 Owner | 前置消费者 | 含义 |
|---|---|---|
| P5 M-040 | P2 M-012/M-044 | Security ingress 必须先于 trusted routing 和 Memory admission |
| P5 M-062 | P3 M-024/M-026 | 安全决策语义必须先于 tool overlay 与 policy truth source |
| P6 M-051/M-056 | P1/P3 的 M-055 消费链 | 观测平面与 redaction 先于 component telemetry |
| P6 M-054 | P5 M-064 | decision trace 先于 AST shadow evaluation |
| P3 M-019 | P4 M-070 | 复用现有 tool plane 后才能定义 pairing validator |

因此后续 Phase 设计文档可以按责任域分别编写，但冻结顺序必须服从 Wave/DAG，而不能机械采用 P1 → P2 → … → P6。

## 20. T2 约束结论

1. 71 项全部具有且只具有一个 Owner Phase；Consumer 不产生第二实现。
2. 31 项进入 P0/P1 D-闭包，其中 M-019/M-057 是 Required Reuse，不得重写 Provider tool plane 或 adapter。
3. M-045 从 P3 提升为 Conditional，只因为它是 M-013 的必要前置；原始分档仍为 P3。
4. Deferred 机制只保留边界和评测触发条件，不进入当前设计承诺。
5. Hold 机制只归属 owner，不进入 Design Wave。
6. Phase 6 负责观测数据面和评测契约；Phase 5 仍负责生产安全决策，不能由 telemetry 代替 enforcement。
7. 成熟 Prompt 库的实际条目选择仍未发生；M-018 仅建立未来 Registry/governance 的主责入口。

## 21. 冻结结论

G1/G2 评分、T1 全局依赖图与 T2 Phase 输入映射均已冻结，Gap / Value Matrix 整体冻结。下一阶段开始 Phase 1～6 的具体设计规格，并按 Wave/DAG 选择先冻结哪些跨 Phase 基础契约。
