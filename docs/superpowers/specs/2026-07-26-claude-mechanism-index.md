# Claude Mechanism Index

> 状态：冻结
> 日期：2026-07-26
> 用途：Claude 机制事实索引；Gap / Value Matrix 的 Claude 侧输入
> 当前覆盖：Prompt 组装、Context Placement、规则发现、子 Agent Prompt、Prompt 变更治理、Tool Definitions、Prompt Optimization
> 当前不做：迁移决策、优先级评分、目标架构、Prompt 原文嵌入、实施计划

## 1. 语料清单

### 1.1 机制分析资料

| 项 | 值 |
|---|---|
| 路径 | `D:\Files\Obsidian\sources\claude-code\Claude-Code-提示词机制.md` |
| 行数 | 4,526 |
| 字符数 | 141,754 |
| 一级问题域 | 10 |
| H2 / H3 标题 | 15 / 81 |
| 代码围栏标记 | 402 |
| 性质 | 用户基于 Claude Code 编译源码整理的二次分析 |

该资料提供函数名、调用链和 Claude 源码位置，但本次没有 Anthropic 官方源码用于独立复核。因此索引把它记为“分析资料证据”，不把其中每个源码位置升级为当前 Claude Code 的官方保证。

### 1.2 成熟 Prompt 资料库

| 项 | 值 |
|---|---|
| 路径 | `D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts` |
| 文件数 | 255 |
| 总大小 | 881,274 bytes |
| Prompt 文件 | `system-prompts/` 下 250 个 |
| 分类 | 101 system、75 tool、34 agent、27 data、13 skill |
| 其他 | README、CHANGELOG、LICENSE、提取脚本 |
| README 标注版本 | Claude Code v2.1.85，2026-03-26 |
| 来源性质 | Piebald 从 Claude Code 编译包提取；非 Anthropic 官方源码 |
| 许可证 | MIT，Copyright 2025 Piebald LLC |

README 说明 Prompt 中存在运行时模板变量，静态 token 数与真实会话会有差异。Prompt Registry 后续必须保存版本、文件 hash、模板变量和许可证；本索引只建立来源关系。

## 2. 证据等级

| 等级 | 定义 |
|---|---|
| P | Prompt 库中存在对应的提取文本，可检查真实措辞和 frontmatter |
| A | 4,526 行分析资料给出调用链、函数名和源码位置 |
| B | P 与 A 互相印证，或由多个本地证据共同支持 |
| I | 基于上述资料的解释，尚不能视为 Claude 实现事实 |

“mi-code 现状”引用已冻结的 `2026-07-26-agent-prompt-baseline.md`，不在本文件重复证明。

## 3. 索引字段

每个机制使用以下字段：

- **机制**：可独立讨论和迁移的最小机制。
- **来源**：资料行号与成熟 Prompt 样本。
- **作用**：输入、处理、输出。
- **解决问题**：该机制存在的工程原因。
- **依赖**：成立所需的运行时能力。
- **mi-code 现状**：已有、部分已有或缺失。
- **迁移价值**：定性记录潜在收益，不代表 Gap Matrix 优先级。`中到高` 等范围值表示仅凭 Claude 侧证据无法收敛为单值；Gap Matrix 不得直接用范围排序，必须结合 mi-code 差距、收益、频率、风险降低与成本重新评分。
- **边界**：不可从当前证据推出的结论。

## 4. Batch A 覆盖表

| 域 | 范围 | 状态 | 机制 |
|---|---|---|---:|
| D01 | System Prompt 动态组装 | Batch A 已冻结，待跨域去重 | M-001～M-005 |
| D02 | Context 分层与 Placement | Batch A 已冻结，待结合 D05 | M-006～M-013 |
| D03 | Tool Definitions | Batch B 已冻结 | M-019～M-029 |
| D04 | Prompt 优化策略 | Batch B 已冻结 | M-030～M-037 |
| D05 | Context Injection | Batch C 已冻结 | M-038～M-041 + 既有归并 |
| D06 | Memory | Batch C 已冻结 | M-042～M-047 + M-012/M-013 |
| D07 | Compression / Caching | Batch C 已冻结 | M-048～M-050 + 既有归并 |
| D08 | Observability | Batch D-1 已冻结 | M-051～M-056 |
| D09 | Model Adaptation | Batch D-1 已冻结 | M-057～M-061 + M-018/M-039 |
| D10 | Security | Batch D-2 已冻结 | M-062～M-071 + 既有归并 |
| Cross | 子 Agent 与版本治理 | Batch A 已冻结 | M-014～M-018 |

## 5. D01 — System Prompt 动态组装

### M-001 Section Array Assembly

- **机制**：system prompt 先构造成 `string[]`，每个元素是独立 section，最后才进入 Provider 适配。
- **来源**：分析资料 L19-L50，`getSystemPrompt()`；L143-L199 的静态/动态 section 清单。Prompt 样本包括 `system-prompt-system-section.md`、`system-prompt-doing-tasks-*.md`、`system-prompt-output-efficiency.md`。
- **证据等级**：B。
- **作用**：配置与运行态输入 → 多个具名或可识别 section → system prompt blocks。
- **解决问题**：避免所有规则成为不可治理的大字符串，为条件注入、缓存和观测提供最小单元。
- **依赖**：section identity、稳定顺序、Provider block builder。
- **mi-code 现状**：主入口用字符串数组直接 `join`，有物理片段但没有 section 对象、ID、元数据和 compiler。
- **迁移价值**：高；它是预算、去重、Placement、provenance 和 snapshot 的共同基础。
- **边界**：`string[]` 本身不等于已冻结的 PromptState；Claude 的数组结构不能直接作为 mi-code 类型设计。

### M-002 Effective Prompt Precedence

- **机制**：在进入组装前按 `override > coordinator > agent > custom > default` 选择有效基础 Prompt，并允许 append。
- **来源**：分析资料 L53-L89，`buildEffectiveSystemPrompt()`。
- **证据等级**：A。
- **作用**：多个候选 Prompt 来源 + mode/agent 状态 → 唯一基础 Prompt 与追加片段。
- **解决问题**：防止 override、角色、用户自定义和默认 Prompt 同时生效而产生冲突。
- **依赖**：来源类型、控制模式、显式优先级、append 与 replace 语义。
- **mi-code 现状**：固定顺序拼接；角色 Prompt 在独立子 Agent 路径选择，没有统一 precedence model。
- **迁移价值**：高；直接对应 frozen Context Model 的 Authority 与 Placement。
- **边界**：Claude 的五级顺序不是 mi-code 的必然顺序；需由 Gap Matrix 和 Phase 1 设计映射。

### M-003 Static / Dynamic Boundary

- **机制**：用 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 把跨组织稳定内容与用户/session 动态内容分开。
- **来源**：分析资料 L331-L386；D07 重复证据位于 L3000-L3091。
- **证据等级**：A。
- **作用**：section 数组 → 静态 prefix 与动态 suffix → 不同 cache scope。
- **解决问题**：动态环境、Memory、MCP 指令不应破坏稳定 Prompt 前缀的缓存。
- **依赖**：稳定排序、Provider prompt caching、cache-scope block builder。
- **mi-code 现状**：没有边界标记和显式 cache scope；主 prompt 每轮重新拼接。
- **迁移价值**：中到高；价值取决于 Provider 缓存能力和实测成本。
- **边界**：Baseline 尚无真实 cache hit 数据，不能把潜在节省写成已确认收益。该 boundary 可作为 prompt sizing 时优先处理动态后缀的策略锚点，但资料没有证明 Claude 实际用它执行裁剪；此用途必须由 Gap Matrix 评估。

### M-004 Conditional Section Resolution

- **机制**：动态 section 根据 Memory、语言、output style、MCP、scratchpad、模型能力和 feature flag 条件出现。
- **来源**：分析资料 L159-L199。
- **证据等级**：A。
- **作用**：运行时状态 → 条件谓词 → 仅包含适用 section。
- **解决问题**：不让所有能力说明永久占用上下文，也避免向不具备能力的模型下发无效规则。
- **依赖**：能力检测、配置读取、nullable section、确定性顺序。
- **mi-code 现状**：Plan 与 reminder 有少量条件拼接；没有通用 section condition model。
- **迁移价值**：高；可减少无关 Prompt 并降低模式漂移。
- **边界**：条件越多，组合测试成本越高；不能无约束复制 Claude 的全部 feature branches。

### M-005 Section Cache and Invalidation

- **机制**：`systemPromptSection()` 按 section name 缓存计算结果，`/clear` 或 `/compact` 清除；少数 section 显式绕过缓存。
- **来源**：分析资料 L227-L275。
- **证据等级**：A。
- **作用**：section compute function + cache policy → 命中复用或重算。
- **解决问题**：每条用户消息都构造 Prompt 时，避免重复读取和计算稳定上下文。
- **依赖**：唯一 section name、session cache、失效事件、不可缓存标记。
- **mi-code 现状**：无 section cache；`lastSystemPrompt` 只供 fork 继承，不是通用失效缓存。
- **迁移价值**：中；计算节省可能有限，但确定性和可观测性价值较高。
- **边界**：缓存内容与 Provider prompt cache 是两层机制，不能混为一谈。

## 6. D02 — Context 分层与 Placement

### M-006 Five-Plane Placement

- **机制**：把上下文分为 System Prompt、System Context、User Context、Tool Definitions、Conversation Messages 五个 API/语义平面。
- **来源**：分析资料 L301-L326。
- **证据等级**：A。
- **作用**：不同来源内容 → 按作用域和 API 语义分流 → 最终请求。
- **解决问题**：规则、环境、项目说明、工具契约和历史消息具有不同的权威性、缓存性和生命周期。
- **依赖**：Provider 适配、Placement policy、消息构造器。
- **mi-code 现状**：system、tools、messages 三个物理平面已存在；System Context 与 User Context 没有独立模型。
- **迁移价值**：高；与 frozen Context Model 的 Placement 维度直接对应。
- **边界**：五层是 Claude 当前实现描述，不代表 mi-code 必须暴露五个公共类型。

### M-007 Late System Context Append

- **机制**：基础 system prompt 选定后，再把 git status 等 session snapshot 以 `key: value` 追加到末尾。
- **来源**：分析资料 L93-L111、L393-L435；Prompt 样本 `system-prompt-git-status.md`。
- **证据等级**：B。
- **作用**：Git 分支、状态、最近提交、用户 → 截断的 system context snapshot。
- **解决问题**：让 Agent 在首次行动前理解仓库状态，同时不污染稳定基础 Prompt 的定义。
- **依赖**：Git 探测、截断、snapshot freshness 标签、session memoize。
- **mi-code 现状**：主请求不自动注入 Git snapshot；Agent 必须主动调用工具。
- **迁移价值**：中；可减少首轮探测，但有过时和 token 成本。
- **关系**：与 M-008 互补；两者都注入任务外部上下文，但 M-007 选择 late system append，M-008 选择 meta user prepend。
- **边界**：资料明确该状态是会话开始快照且截断至 2,000 字符；不能当作实时状态。

### M-008 User Context Prepend

- **机制**：CLAUDE.md 和日期不放入 system 参数，而包装成 `<system-reminder>`，作为首条 user context prepend 到消息列表。
- **来源**：分析资料 L113-L139、L532-L559。
- **证据等级**：A。
- **作用**：结构化 user context map → 带标题的 meta user message → 原始 conversation messages。
- **解决问题**：把项目/用户上下文与基础 system identity 分离，并保留独立更新与缓存路径。
- **依赖**：meta message 标记、消息 prepend、Provider message conversion。
- **mi-code 现状**：没有独立 user-context prepend；项目规则没有进入请求。
- **迁移价值**：高；项目规则注入是已确认缺口。
- **关系**：与 M-007 互补；两者解决外部上下文注入，但使用不同 Placement、缓存和更新语义。
- **边界**：放在 user message 不等于低 Authority；Authority 必须由运行时规则显式定义，不能从 Placement 位置隐式推断。

### M-009 Environment Snapshot Section

- **机制**：在动态 system section 中注入 CWD、平台、shell、OS、模型、知识截止时间等环境摘要。
- **来源**：分析资料 L190、L202-L226；子 Agent 对应 L709-L733。
- **证据等级**：A。
- **作用**：运行环境 + 模型元数据 → 格式化 environment section。
- **解决问题**：减少 Agent 对基础环境的猜测，并为跨平台命令与模型行为提供条件。
- **依赖**：确定性环境采集、敏感信息过滤、freshness policy。
- **mi-code 现状**：主 Agent 无统一环境 section；子 Agent 会追加 CWD、platform、shell、Git repo flag。
- **迁移价值**：中到高；主/子 Agent 语义统一价值大于单纯增加信息。
- **边界**：D05/D10 尚需检查 Undercover 与 secret filtering 后才能确定可注入字段。

### M-010 Hierarchical Rule Discovery

- **机制**：按 Managed、User、Project、Local、Auto Memory 分层发现规则；Project/Local 从根目录向 CWD 逐级遍历。
- **来源**：分析资料 L443-L495。
- **证据等级**：A。
- **作用**：CWD + setting sources → 有序规则文件列表。
- **解决问题**：同时支持组织政策、个人偏好、仓库规则、子目录规则和本地私有覆盖。
- **依赖**：filesystem discovery、路径去重、source type、稳定遍历顺序。
- **mi-code 现状**：根目录文件存在，但运行时没有 CLAUDE.md/AGENTS.md/rules discovery。
- **迁移价值**：高；是 Context Sources 阶段的核心输入。
- **边界**：Claude 的目录与文件名约定不能直接决定 mi-code 的兼容范围。

### M-011 Rule Provenance Formatting

- **机制**：每个规则文件连同绝对路径和来源说明格式化，并附加“覆盖默认行为”的总指令。
- **来源**：分析资料 L499-L529。
- **证据等级**：A。
- **作用**：有序 MemoryFileInfo → 带 source/path 的文本块。
- **解决问题**：让模型知道规则来自何处、是否入库，并增强项目规则遵循。
- **依赖**：source metadata、path labeling、Authority policy。
- **mi-code 现状**：无项目规则格式化；当前 skill catalog 也缺少 provenance。
- **迁移价值**：高；provenance 同时服务冲突诊断和安全审计。
- **边界**：一句“OVERRIDE default behavior”不足以处理多源冲突，mi-code 必须遵守 frozen Authority 模型。

### M-012 Markdown Prompt Source Routing

- **机制**：不同 `.md` 来源进入不同通道：CLAUDE.md → User Context，MEMORY.md → System section，Agent 定义 → Agent system，rules → CLAUDE.md 层级。
- **来源**：分析资料 L621-L683。
- **证据等级**：A。
- **作用**：文件路径和 source type → 对应 loader、Placement 与生命周期。
- **解决问题**：避免所有 Markdown 被当成同权威、同用途的 Prompt 文本。
- **依赖**：受信 source policy、schema/frontmatter parser、deterministic loader。
- **mi-code 现状**：skills 和 planner 可从 Markdown 生成/加载；项目规则与 Memory 没有统一路由。
- **迁移价值**：高；与 frozen Trusted Extraction 和 Prompt Governance 直接相关。
- **成熟 Prompt 对照**：`data-session-memory-template.md`、agent/skill/system 类文件可用于研究格式，不代表可互换 Placement。
- **边界**：文件扩展名不建立信任；必须由受信来源策略和加载器建立。

### M-013 Bounded Memory Entrypoint

- **机制**：MEMORY.md 作为 system section 的入口，只加载前 200 行或 25KB，并通过 section cache 管理。
- **来源**：分析资料 L627-L660。
- **证据等级**：A。
- **作用**：memory directory → bounded entrypoint content → memory system section。
- **解决问题**：让长期记忆可发现，同时限制无界 token 增长。
- **依赖**：memory directory、截断策略、索引/分文件约定、section cache。
- **mi-code 现状**：Memory 工具与索引存在，但不自动注入；没有 200 行/25KB 同类 contract。
- **迁移价值**：中到高；具体价值需 D06 完整索引后判断。
- **边界**：截断阈值是 Claude 的实现参数，不是通用最佳值。

## 7. Cross — 子 Agent Prompt

### M-014 Role-Specific Agent Prompt

- **机制**：Explore、Plan、General、Verification 等 Agent 各有独立角色 Prompt 和工具集合。
- **来源**：分析资料 L687-L733、L763-L772。Prompt 样本 `agent-prompt-explore.md`、`agent-prompt-plan-mode-enhanced.md`、`agent-prompt-general-purpose.md`、`agent-prompt-verification-specialist.md`。
- **证据等级**：B。
- **作用**：agent definition + model + tools → 角色 system prompt。
- **解决问题**：缩小职责、工具和输出格式，使子 Agent 行为可预测。
- **依赖**：role registry、tool visibility policy、独立 context、result contract。
- **mi-code 现状**：已有 explore/plan/general 角色与工具过滤；没有完整 Verification role lifecycle contract。
- **迁移价值**：中到高；已有轮子优先复用，重点是补语义与评测而非重建。
- **边界**：成熟 Prompt 只能作为 Registry 候选，必须做许可证、能力、工具名和行为评测适配。

### M-015 Agent Context Trimming

- **机制**：只读 Explore/Plan Agent 可选择剥离 CLAUDE.md 与初始 git status，减少无关上下文。
- **来源**：分析资料 L736-L761。
- **证据等级**：A。
- **作用**：agent type + override state → 精简 user/system context。
- **解决问题**：子 Agent 只承担窄任务时，不必复制全部父上下文。
- **依赖**：agent capability、任务输入完整性、可选择 omit policy。
- **mi-code 现状**：角色工具集会过滤，但 context trimming 没有统一策略；普通角色使用自身 Prompt，fork 则继承完整父 Prompt。
- **迁移价值**：中；可能节省 token，也可能丢失必要项目规则。
- **边界**：资料中的周级 token 节省数字没有 mi-code 对应基线，不能移用。

### M-016 Byte-Exact Fork Inheritance

- **机制**：fork 不重建 system prompt，而继承父 Agent 已渲染的字节，防止实验分支变化导致 cache miss。
- **来源**：分析资料 L774-L786；Prompt 样本 `agent-prompt-worker-fork-execution.md` 只覆盖 worker 行为，不等于继承机制本身。
- **证据等级**：B。
- **作用**：parent rendered prompt bytes → child base system prompt。
- **解决问题**：保持父子规则完全一致并稳定 Provider prompt cache。
- **依赖**：rendered prompt snapshot、fork lifecycle、相容工具上下文。
- **mi-code 现状**：`lastSystemPrompt` 供 fork 使用，方向相近；子 Agent 仍追加环境与 skill catalog，因此不是字节级完整继承。
- **迁移价值**：中；需先决定父子环境差异与缓存目标。
- **边界**：字节相同与语义正确是两个问题；不能为缓存牺牲必要的子 Agent 安全边界。

### M-017 Teammate Prompt Addendum

- **机制**：Teammate 使用完整主 Prompt，再追加团队通信规则和可选自定义 Agent 指令。
- **来源**：分析资料 L788-L801；Prompt 样本 `system-prompt-teammate-communication.md`、`system-reminder-team-coordination.md`。
- **证据等级**：B。
- **作用**：main prompt + team addendum + optional custom prompt → teammate system prompt。
- **解决问题**：团队成员共享主规则，同时获得消息、任务和退出协议。
- **依赖**：team runtime、message bus、task ownership、shutdown contract。
- **mi-code 现状**：已有 teammate/inbox/message 类工具和 self-organizing 路径，但没有统一 Prompt Registry 与 lifecycle state mapping。
- **迁移价值**：中；需要在 Tools & Agent Intelligence 阶段结合真实团队能力评估。
- **边界**：通信 Prompt 不能替代运行时任务所有权和权限隔离。

## 8. Cross — Prompt 变更治理

### M-018 Feature-Gated Prompt Evolution

- **机制**：通过 feature flag、A/B 实验和 `@[MODEL LAUNCH]` 维护标记控制 Prompt 变化，而不是依赖单一显式 Prompt 版本号。
- **来源**：分析资料 L806-L852；Prompt 库 `CHANGELOG.md` 记录 134 个版本的 Prompt 变化。
- **证据等级**：B。
- **作用**：feature/user/model cohort → Prompt variant；发布事件 → 维护检查点。
- **解决问题**：控制高风险 Prompt 变更的发布范围，并用成本与负反馈等 guardrail 评估。
- **依赖**：variant registry、cohort assignment、metrics、changelog、model catalog。
- **mi-code 现状**：没有 Prompt Registry、variant、evaluation result 或运行时版本记录。
- **迁移价值**：中到高；治理必要，但完整 GrowthBook 类平台可能过度设计。
- **成熟 Prompt 对照**：Prompt 库 README、CHANGELOG 和各文件 frontmatter 可作为版本元数据来源。
- **边界**：Phase 0 已冻结“构建时源文件 → 运行时不可变 Registry”；是否需要在线 A/B 必须留给 Gap/Value Matrix，不能预设。

## 9. Batch A 初步事实

以下是索引事实，不是设计结论：

1. Claude 的关键能力不是 Prompt 文本数量，而是来源选择、Placement、条件解析、缓存和失效组成的编译链。
2. CLAUDE.md、MEMORY.md、Agent `.md` 和 rules 虽都是 Markdown，但进入不同信任与 Placement 通道。
3. 子 Agent 存在“角色化重建”“精简上下文”“字节级 fork”“完整主 Prompt + teammate addendum”多种策略，不能统一理解为继承父 Prompt。
4. Tool Definitions 已被识别为独立平面，但其生命周期将在 D03 单独索引。
5. Prompt 库提供成熟措辞样本和版本记录，不能单凭文件存在就判定适合嵌入 mi-code。

## 10. D03 — Tool Definitions

### M-019 Independent Tool API Plane

- **机制**：system prompt 与 tool definitions 作为并列 API 参数发送，工具说明不复制进 system prompt。
- **来源**：分析资料 L882-L907；Prompt 样本为全部 `tool-description-*.md`。
- **证据等级**：B。
- **作用**：system blocks + tool schemas → 两个独立请求平面。
- **解决问题**：工具契约可独立演进，避免主 Prompt 因工具说明变化而整体漂移。
- **依赖**：Provider 原生 tool API、统一 ToolDefinition。
- **mi-code 现状**：已采用独立 tool plane，是可直接复用的现有边界。
- **迁移价值**：低；不是缺失能力，后续重点是治理其内容和生命周期。
- **边界**：独立传输不等于独立预算；两者仍共同占用输入上下文。

### M-020 Per-Tool Prompt Source

- **机制**：每个工具拥有独立 Prompt 源，而不是在中央 system prompt 中维护全部用法。
- **来源**：分析资料 L911-L924；Prompt 库包含 75 个 tool 类文件。
- **证据等级**：B。
- **作用**：tool module → 独立 description source → API schema。
- **解决问题**：使工具说明与 executor、参数和安全约束同域维护。
- **依赖**：工具注册表、Prompt source metadata、构建校验。
- **mi-code 现状**：description 与 schema 位于各工具定义中，但没有独立版本、来源和评测元数据。
- **迁移价值**：中；现有代码可复用，主要补 Prompt Governance。
- **边界**：拆成文件不是目标本身；小型稳定描述不必机械拆分。

### M-021 Context-Aware Schema Generation

- **机制**：`tool.prompt()` 是 async 生成函数，可根据可用 Agent、工具和当前配置构造 description。
- **来源**：分析资料 L926-L953。
- **证据等级**：A。
- **作用**：tool + runtime context → 当前有效 description/schema。
- **解决问题**：让说明只引用真实可用能力，避免模型看到失效 Agent 或选项。
- **依赖**：确定性上下文输入、异步 schema builder、缓存 key。
- **mi-code 现状**：工具定义基本静态；少数工厂会根据注册信息构造。
- **迁移价值**：中；对 Agent/Tool Search 类工具价值高，对简单文件工具价值低。
- **边界**：动态生成会破坏缓存稳定性，必须与 M-022、M-023 联合设计。

### M-022 Session Tool Schema Cache

- **机制**：`TOOL_SCHEMA_CACHE` 在 session 内复用已序列化工具 schema。
- **来源**：分析资料 L955-L976。
- **证据等级**：A。
- **作用**：tool schema inputs + session key → 稳定序列化结果。
- **解决问题**：避免中途配置或实验变化导致 schema 字节漂移和 Provider cache miss。
- **依赖**：稳定 key、session 生命周期、显式失效。
- **mi-code 现状**：每轮从 registry 映射定义，没有独立 schema cache/hash。
- **迁移价值**：中到高；需用真实构造成本和 cache hit 数据收敛。
- **边界**：本地对象缓存与 Provider prompt cache 是不同层。

### M-023 Deterministic Tool Ordering

- **机制**：内置工具按字母序形成稳定前缀，MCP 工具排序后追加。
- **来源**：分析资料 L978-L993。
- **证据等级**：A。
- **作用**：无序工具集合 → 确定性序列 → 稳定 schema prefix。
- **解决问题**：避免注册顺序变化破坏请求字节和缓存；动态 MCP 只影响后缀。
- **依赖**：工具分类、稳定排序、名称唯一。
- **mi-code 现状**：依赖注册顺序，Baseline 未发现显式稳定排序。
- **迁移价值**：中；实现简单，但收益需缓存证据。
- **边界**：排序可能改变既有 Provider cache 和测试快照，实施时需版本化。

### M-024 Per-Request Tool Overlay

- **机制**：稳定基础 schema 发送前叠加每请求属性，而不修改缓存源对象。
- **来源**：分析资料 L995-L1017。
- **证据等级**：A。
- **作用**：cached base schema + request policy → final request schema。
- **解决问题**：把稳定契约与临时可见性、defer loading 等请求状态分离。
- **依赖**：不可变 base schema、M-023 的确定性排序、overlay 类型、最终快照。
- **mi-code 现状**：Plan Mode 在发送前过滤工具，但没有显式 immutable overlay model。
- **迁移价值**：高；可统一 mode、role 和动态发现的工具可见性。
- **边界**：overlay 只能收窄或标注能力，不应绕过 PermissionChecker。

### M-025 Tool-Local Few-Shot Examples

- **机制**：在复杂工具 description 内加入输入、思考场景、调用参数和后续事件示例。
- **来源**：分析资料 L1019-L1092、L1486-L1563；Prompt 样本 `tool-description-agent-*.md`、Bash 系列说明。
- **证据等级**：B。
- **作用**：抽象工具契约 + 代表性场景 → 自包含使用手册。
- **解决问题**：schema 只能表达结构，不能充分表达何时调用、如何组合和异步结果语义。
- **依赖**：高价值场景、可评测 example、token budget。
- **mi-code 现状**：工具说明以参数为主，缺少系统化 few-shot。
- **迁移价值**：中；只适用于高误用率复杂工具。
- **边界**：不能把 75 个工具全部扩写成长手册；必须由误用证据驱动。

### M-026 Tool-Local Policy and Sandbox Context

- **机制**：工具偏好、安全、并行规则和 sandbox 限制放入相关工具 description。
- **来源**：分析资料 L1094-L1163、L1245-L1250；Prompt 样本 `tool-description-bash-*`。
- **证据等级**：B。
- **作用**：tool capability + runtime sandbox policy → 就地行为约束。
- **解决问题**：让约束紧邻决策点，减少模型在主 Prompt 与工具契约间跳转。
- **依赖**：运行时真实策略、动态路径/网络信息、硬权限兜底。
- **mi-code 现状**：schema 有基本说明；Permission 与 Plan 约束主要分散在 runtime 和主 Prompt。
- **迁移价值**：高；可改善可理解性，但不能代替硬权限。
- **关系**：与 M-030 互补；M-026 处理单工具本地约束，M-030 处理同类行为约束在多个 Prompt 层的 Placement。
- **边界**：敏感路径与网络信息注入需等 D10 安全索引后决定。

### M-027 Deferred Tool Discovery

- **机制**：工具描述超过上下文窗口约 10% 时，部分工具 `defer_loading`，模型通过 Tool Search 按需取得引用。
- **来源**：分析资料 L1166-L1184；Prompt 样本 `tool-description-toolsearch-second-part.md`。
- **证据等级**：A。
- **证据说明**：Prompt 样本只证明 ToolSearch 工具存在，不证明 10% 阈值、`defer_loading` 触发和引用展开协议。
- **作用**：大工具集合 → 核心工具 + 延迟工具索引 → 按需完整 schema。
- **解决问题**：控制工具 schema 在大规模 MCP/插件环境中的上下文占比。
- **依赖**：token measurement、ToolSearch、tool reference protocol、发现权限。
- **mi-code 现状**：33 个工具全量发送；Normal tool schema 约 3,491 粗略 tokens。
- **迁移价值**：中到高；是否达到阈值需按模型真实 tokenizer 测量。
- **边界**：当前 10% 是 Claude 参数，不是 mi-code 的既定阈值。

### M-028 Name-to-Manual Indirection

- **机制**：system prompt 只引用工具名称，完整用法由 tool description 承载。
- **来源**：分析资料 L1187-L1213。
- **证据等级**：A。
- **作用**：全局行为规则 → tool name；具体调用决策 → tool-local manual。
- **解决问题**：减少主 Prompt 重复并允许工具独立演进。
- **依赖**：名称稳定、工具必定随请求提供、引用一致性检查。
- **mi-code 现状**：基本采用相同方式，但主 Prompt 中的工具名与模式可见性可能漂移。
- **迁移价值**：中；重点是建立引用完整性测试。
- **边界**：只写名称不保证模型理解工具，复杂工具仍需要 M-025/M-026。

### M-029 Cache-Preserving Dynamic Attachments

- **机制**：易变 Agent 列表可从工具 description 移到 `<system-reminder>` attachment，保持工具 schema 静态。
- **来源**：分析资料 L1218-L1232。
- **证据等级**：A。
- **作用**：动态 capability list → attachment message；稳定 tool description 保持不变。
- **解决问题**：频繁变化的列表不应破坏大块工具 schema 缓存。
- **依赖**：attachment protocol、Placement policy、列表 freshness。
- **mi-code 现状**：Agent 列表直接体现在工具 schema/注册状态，没有独立 attachment。
- **迁移价值**：中；只有列表频繁变化且缓存收益明确时成立。
- **边界**：attachment 仍占 token，也必须标记来源与信任。

## 11. D04 — Prompt Optimization

### M-030 Layer-Local Negative Constraints

- **机制**：Do NOT、Never、CRITICAL 等约束分布在 system、tool、compaction、fork、plan 和 security review 层。
- **来源**：分析资料 L1276-L1424；对应 `system-prompt-doing-tasks-*`、tool、agent Prompt。
- **证据等级**：B。
- **作用**：已知失败模式 → 最接近行为发生点的禁止规则。
- **解决问题**：阻止多余改动、危险命令、工具误用和错误输出格式。
- **依赖**：失败证据、Placement、重复检测、回归评测。
- **mi-code 现状**：有少量负面指令，但分散且没有来源/评测记录。
- **迁移价值**：中；规则质量高于数量。
- **关系**：与 M-026 互补；M-030 是跨 system/tool/任务 Prompt 的总体 Placement 策略，M-026 是工具层的局部实例。
- **边界**：高密度负面指令可能冲突或污染上下文，不能按数量移植。

### M-031 No-Tool Compaction Sandwich

- **机制**：Compaction Prompt 首尾都声明禁止工具调用，形成 preamble + trailer 双重边界。
- **来源**：分析资料 L1324-L1348；Prompt 样本 `system-prompt-context-compaction-summary.md`、`agent-prompt-conversation-summarization.md`。
- **证据等级**：B。
- **作用**：自动摘要任务 → no-tools envelope → 纯文本摘要。
- **解决问题**：模型在摘要阶段调用工具会破坏压缩协议。
- **依赖**：专用 summary call、工具不可见或 runtime deny、输出 parser。
- **mi-code 现状**：L4 summary 使用简单 Prompt，没有同等级运行时 no-tool contract。
- **迁移价值**：高；应优先由工具可见性硬约束，而非只复制两句 Prompt。
- **边界**：双重措辞是软防线，不能替代 API 层不提供 tools。

### M-032 Structured Few-Shot Contract

- **机制**：用带标签的完整示例教授 Compaction、Agent、Bash、Security Review 的输入输出协议。
- **来源**：分析资料 L1426-L1577。
- **证据等级**：A。
- **作用**：复杂格式要求 + representative examples → 更稳定的结构化行为。
- **解决问题**：抽象说明难以覆盖多阶段、异步通知和严格报告格式。
- **依赖**：稳定协议、样本代表性、snapshot/eval。
- **mi-code 现状**：没有统一 few-shot 资产与评测。
- **迁移价值**：中；仅用于格式失败频繁且 schema 不足的路径。
- **边界**：示例中的工具名、标签和工作流必须适配 mi-code，不能原文复制。

### M-033 Draft / Deliverable Separation

- **机制**：Compaction 要求先按时序检查材料，再输出独立 `<summary>`；草稿区由 formatter 剥离。
- **来源**：分析资料 L1580-L1607。
- **证据等级**：A。
- **作用**：conversation → completeness pass → public structured summary。
- **解决问题**：减少摘要遗漏，并保持最终上下文只有可复用结论。
- **依赖**：输出 parser、summary schema、失败处理。
- **mi-code 现状**：summary prompt 简单，未区分检查过程与最终摘要。
- **迁移价值**：中到高；需以摘要保真度评测确认。
- **边界**：mi-code 不应要求或持久化模型隐藏思维链；可迁移的是显式检查清单与交付物 schema。

### M-034 Quantified Conciseness Anchors

- **机制**：用 ≤25 words、≤100 words 等数字锚点替代模糊“简洁”，并通过实验变体控制。
- **来源**：分析资料 L1630-L1683；Prompt 样本 `system-prompt-tone-and-style-concise-output-short.md`、`system-prompt-output-efficiency.md`。
- **证据等级**：B。
- **作用**：用户类型/实验组 → 具体输出预算提示。
- **解决问题**：模型对“简洁”的解释不稳定。
- **依赖**：输出 token metric、任务类型、variant evaluation。
- **mi-code 现状**：只有定性简洁指令。
- **迁移价值**：低；Baseline 没有发现 mi-code 的输出长度行为问题。
- **边界**：资料中的约 1.2% 节省不能外推到 mi-code；没有 mi-code 行为证据时不得加入量化长度锚点。

### M-035 Task-Specific Prompt Templates

- **机制**：Security Review、Compaction、Plan、Fork 使用独立阶段和输出结构，而非依赖通用 Agent Prompt。
- **来源**：分析资料 L1687-L1788；Prompt 样本 `agent-prompt-security-review-slash-command.md`、`agent-prompt-plan-mode-enhanced.md`、`agent-prompt-worker-fork-execution.md`。
- **证据等级**：B。
- **作用**：task type → 专用 workflow、排除项、输出 contract。
- **解决问题**：高风险或高结构任务需要比通用指令更确定的行为。
- **依赖**：任务识别、专用 capability、Prompt Registry、验证器。
- **mi-code 现状**：已有 planner 与角色 Prompt，但缺少治理元数据和统一结果验证。
- **迁移价值**：高；优先复用现有角色与 planner，不扩大模板数量。
- **边界**：模板必须对应真实运行时能力；不能先导入 Prompt 再补工具。

### M-036 Problem-Driven Counterweights

- **机制**：针对 false claims、验证不足、过度顺从等已观测模型偏差加入反向约束。
- **来源**：分析资料 L1791-L1824。
- **证据等级**：A。
- **作用**：行为指标异常 → 局部 counterweight → 再评测。
- **解决问题**：通用“简单可靠”原则可能在特定模型上导致新的系统性偏差。
- **依赖**：行为数据、模型/版本维度、回归集。
- **mi-code 现状**：没有规则违反率和 false-claim 指标，现有规则多为预防性。
- **迁移价值**：高；价值在迭代方法，不在复制 Claude 的具体句子。
- **边界**：没有 mi-code 证据时不得预先加入同类 counterweight。

### M-037 Strict Result Schema for Delegated Work

- **机制**：fork 等受委派任务强制 Scope、Result、Key files、Files changed、Issues 等结果字段。
- **来源**：分析资料 L1350-L1378、L1776-L1788；Prompt 样本 `agent-prompt-worker-fork-execution.md`。
- **证据等级**：B。
- **作用**：delegate execution → fixed result schema → parent synthesis。
- **解决问题**：防止子 Agent 只返回过程叙述、遗漏变更或隐瞒失败。
- **依赖**：subagent outcome、parser 或结构化协议、parent validation。
- **mi-code 现状**：已有 status/termination/evidence 前缀，但结果正文没有完整统一 schema。
- **迁移价值**：高；与 frozen Completion Contract 一致。
- **边界**：Prompt 格式不能代替可信工具证据和 parent 独立验证。

## 12. Batch B 初步事实

1. Tool plane 的核心差距不在“是否独立传输”，而在 description 的生成、稳定性、约束 Placement 和按需发现。
2. 工具 Prompt 越动态，越需要 immutable base、overlay、排序和失效共同约束。
3. Claude 的 Prompt 优化是失败模式驱动；负面指令、few-shot 和 counterweight 都不是默认必需品。
4. 成熟 Prompt 原文最有价值的候选集中在复杂工具、Compaction、Plan、Verification 和 delegated result contract。
5. Prompt 不能代替 runtime enforcement：sandbox、no-tools、Permission 和验证证据仍必须由运行时保证。

## 13. Batch C 取证边界

Batch C 按以下范围完成取证：

- D05 Context Injection：git、CLAUDE.md、环境、敏感信息与 attachment budget；
- D06 Memory：指令型/自动/Agent/Team Memory、写入与验证；
- D07 Compression：静态动态缓存、条件裁剪、post-compact 恢复与大小控制；
- 对 M-003～M-005、M-007～M-013、M-031、M-033 做跨域归并检查，不提前评分。

## 14. Batch C 跨域归并

| 既有机制 | Batch C 新证据 | 处理 |
|---|---|---|
| M-003 | D07 L3028-L3090 | 保留原编号；确认 boundary 同时服务 cache scope |
| M-004 | D07 L3147-L3173 | 保留原编号；确认 feature/runtime conditional inclusion |
| M-005 | D05 L1970-L1982、D07 L3092-L3145 | 保留原编号；补强 session memoize 与 section cache 的区别 |
| M-007 | D05 L1887-L1982 | 保留原编号；补强 Git 采集、格式、注入和缓存证据 |
| M-008 | D05 L1984-L2149 | 保留原编号；新增 M-038 表达 meta retention，不重复注入机制 |
| M-009 | D05 L2152-L2281 | 保留原编号；新增 M-039 表达平台规范化与敏感模式 |
| M-010 | D05 L1986-L2060、D06 L2512-L2525 | 保留原编号；补强 CLAUDE.md 作为指令型记忆的层级发现证据 |
| M-011 | D05 L2061-L2095、D06 L2527-L2557 | 保留原编号；补强不同来源说明与路径 provenance 的格式化证据 |
| M-012 | D05 L2097-L2139、D06 L2559-L2617 | 保留原编号；确认 CLAUDE.md 作为指令型记忆仍路由到 meta user context |
| M-013 | D06 L2707-L2812、D07 L3272-L3283 | 保留原编号；新增 M-050 表达通用 source guard |
| M-031/M-033 | D07 L3000-L3305 | 保留原编号；D07 讨论的是 Prompt 保留与恢复，不重复摘要协议 |

## 15. D05 — Context Injection 新机制

### M-038 Meta Context Retention

- **机制**：注入型 user context 标记 `isMeta: true`，不计作用户轮次，也不被普通历史裁剪或 compaction。
- **来源**：分析资料 L2142-L2149。
- **证据等级**：A。
- **作用**：system-generated user context → meta message → 独立 retention policy。
- **解决问题**：项目规则不能因对话压缩而悄然消失，也不能被误认为用户本轮输入。
- **依赖**：message metadata、compressor awareness、session serializer。
- **mi-code 现状**：消息模型没有等价 meta context retention。
- **迁移价值**：高；直接关联规则持续性和 frozen Pinned Working Set。
- **关系**：建立在 M-008 的 meta user message Placement 之上；M-008 决定注入位置，M-038 决定该消息的 retention 生命周期。
- **边界**：meta 标记不提升 Trust 或 Authority，只改变生命周期。

### M-039 Cross-Platform Environment Normalization

- **机制**：Shell、OS version、worktree 等环境字段先按平台规范化，再由 Undercover 模式选择性隐藏。
- **来源**：分析资料 L2152-L2250。
- **证据等级**：A。
- **作用**：raw process/platform data + privacy mode → normalized environment section。
- **解决问题**：避免跨平台字段含义漂移，并限制敏感部署信息暴露。
- **依赖**：platform adapter、field allowlist、privacy mode。
- **mi-code 现状**：子 Agent 直接拼接 CWD/platform/shell，没有统一字段策略或敏感模式。
- **迁移价值**：中到高；需由 D10 决定允许字段。
- **边界**：环境信息越多不等于 Agent 越强，必须按任务必要性注入。

### M-040 Context Ingress Sanitization

- **机制**：环境、feedback、team memory 和 image path 在进入 Prompt/外部通道前分别经过清洗、secret scan 或路径防御。
- **来源**：分析资料 L2314-L2413。
- **证据等级**：A。
- **作用**：untrusted/sensitive ingress → deterministic filters → bounded context。
- **解决问题**：阻止凭据泄漏、跨机器内容污染和路径型 Prompt injection。
- **依赖**：env scrubber、secret scanner、path validator、source-specific policy。
- **mi-code 现状**：Baseline 未发现统一请求出口清洗和 ToolResultEnvelope。
- **迁移价值**：高。
- **边界**：这里只登记 Context 入口；具体攻击模型与 enforcement 留给 D10。

### M-041 Attachment Budget

- **机制**：attachment 注入拥有独立数量/体积预算，超限内容不能无界进入请求。
- **来源**：分析资料 L2427-L2447。
- **证据等级**：A。
- **作用**：attachments + budget → accepted/truncated/deferred set。
- **解决问题**：动态附件可能绕过主 Prompt 和 history 的预算控制。
- **依赖**：attachment metadata、size estimator、overflow policy。
- **mi-code 现状**：没有独立 attachment plane 与预算。
- **迁移价值**：中；当前实际 attachment 使用量未知。
- **边界**：预算不是安全扫描，必须与 M-040 分开。Claude 的每 turn 20KB、每 session 60KB 只作为交叉证据，不代表 mi-code 应采用相同阈值；mi-code 阈值必须由 Gap Matrix 中的 token 预算和 attachment 使用频率基线决定。

## 16. D06 — Memory 新机制

### M-042 Instruction Memory / Auto Memory Separation

- **机制**：CLAUDE.md 保存显式规则，Auto Memory 保存模型提取的偏好、反馈和项目经验，二者使用不同 Placement 与更新主体。
- **来源**：分析资料 L2474-L2496、L2962-L2975。
- **证据等级**：A。
- **作用**：manual instructions / learned observations → separate stores and channels。
- **解决问题**：防止模型学习内容自动升级为用户指令。
- **依赖**：source type、Authority、separate writer、separate loader。
- **mi-code 现状**：Memory 工具存在，但没有规则与经验的强制类型边界。
- **迁移价值**：高。
- **边界**：这与 frozen “失败记忆不能成为高权威规则”一致，不代表照搬文件布局。

### M-043 Typed Auto Memory

- **机制**：Auto Memory 使用四类分类法组织内容，而不是无结构追加文本。
- **来源**：分析资料 L2619-L2653。
- **证据等级**：A。
- **作用**：memory candidate → type classification → scoped storage。
- **解决问题**：不同记忆需要不同检索、更新和失效方式。
- **依赖**：type schema、validator、index。
- **mi-code 现状**：Memory 条目没有强制 type/confidence/evidence schema。
- **迁移价值**：中到高；类型应由 mi-code 需求重新定义。
- **边界**：Claude 的四类不是既定目标枚举。

### M-044 Memory Admission and Verification Policy

- **机制**：明确禁止保存的内容、访问时机，并要求使用前验证可能过时的记忆。
- **来源**：分析资料 L2655-L2705。
- **证据等级**：A。
- **作用**：candidate + policy → reject/store；retrieved memory + current context → verify/use。
- **解决问题**：降低敏感、短期或错误信息成为长期行为依据的风险。
- **依赖**：M-043 提供的 type/schema 与 metadata 基础、admission rules、freshness/context metadata、verification path。
- **mi-code 现状**：没有强制 confidence/context/invalidation 字段。
- **迁移价值**：高。
- **边界**：Agent 不能自行提升记忆 Authority；与 frozen Trusted Extraction 相同。

### M-045 Two-Step Memory Persistence

- **机制**：先写具体 topic 文件，再更新受大小限制的 MEMORY.md 索引。
- **来源**：分析资料 L2784-L2846。
- **证据等级**：A。
- **作用**：validated memory → durable detail + bounded entrypoint index。
- **解决问题**：避免入口文件无限增长，同时保留可检索细节。
- **依赖**：topic files、index updater、atomicity/error handling。
- **mi-code 现状**：已有 index 和条目文件能力，但未接入 completion/memory policy。
- **迁移价值**：中；优先复用现有 MemoryManager。
- **边界**：Memory 写入失败不得改变 TurnOutcome。

### M-046 Memory Search Guidance

- **机制**：入口索引只负责导航，Agent 按主题和关键词读取详细文件。
- **来源**：分析资料 L2848-L2871。
- **证据等级**：A。
- **作用**：task query + bounded index → selected memory files。
- **解决问题**：长期记忆总量不能全部注入每轮请求。
- **依赖**：search/index、selection budget、provenance。
- **mi-code 现状**：存在 keyword selection 辅助方法，但未接入主请求链路。
- **迁移价值**：高。
- **边界**：选择器结果仍是 untrusted context，不能直接成为规则。

### M-047 Scoped Memory Backends

- **机制**：日志追加、Agent memory、Team memory 使用不同 scope、writer 和同步路径。
- **来源**：分析资料 L2873-L2960。
- **证据等级**：A。
- **作用**：event/agent/team observation → scope-specific store。
- **解决问题**：个人 Agent 经验、团队共享事实和审计日志具有不同传播范围。
- **依赖**：scope identity、sync policy、secret scan、retention。
- **mi-code 现状**：有主 Memory 与团队工具，但没有统一 scoped memory contract。
- **迁移价值**：中。
- **边界**：团队同步属于高风险信任扩散，需 D10 后再判断。

## 17. D07 — Compression / Prompt Sizing 新机制

### M-048 Mode-Specific Prompt Profiles

- **机制**：Output Style、SIMPLE、Proactive 等模式选择不同 Prompt profile，可省略不适用编码规则。
- **来源**：分析资料 L3175-L3249。
- **证据等级**：A。
- **作用**：mode/output style → selected section set。
- **解决问题**：非编码或轻量任务不应支付完整 Agent Prompt 成本。
- **依赖**：mode contract、section capability tags、regression matrix。
- **mi-code 现状**：只有 Normal/Plan 差异，没有通用 profile。
- **迁移价值**：中。
- **边界**：profile 不能通过省略安全和 completion contract 来节省 token。

### M-049 Post-Compact Selective Reinjection

- **机制**：compact 后只重新注入必须持续存在的规则和上下文，而不是恢复全部旧消息。
- **来源**：分析资料 L3251-L3270。
- **证据等级**：A。
- **作用**：compact summary + retained sources → restored working set。
- **解决问题**：摘要会丢失高权威规则或关键运行状态。
- **依赖**：Pinned Working Set、source reload、tool pair invariant。
- **mi-code 现状**：压缩消息但没有显式 post-compact reinjection contract。
- **迁移价值**：高。
- **边界**：不得重新执行已完成工具调用；易变上下文必须重新验证。

### M-050 Source Size Guard

- **机制**：对 CLAUDE.md、MEMORY.md 等来源设置独立大小/行数上限和溢出提示。
- **来源**：分析资料 L2784-L2812、L3272-L3283；M-013 已记录 MEMORY.md 200 行/25KB。
- **证据等级**：A。
- **作用**：context source → bounded content + overflow metadata。
- **解决问题**：单个规则或记忆文件不能吞噬整个上下文预算。
- **依赖**：per-source budget、deterministic truncation、overflow recovery。
- **mi-code 现状**：仅工具结果有压缩阈值，项目规则源尚不存在。
- **迁移价值**：高。
- **关系**：M-013 是 MEMORY.md bounded entrypoint 的特例实现；M-050 将同一 guard 语义泛化到所有 Context Source。
- **边界**：截断不得静默发生；当前用户消息和 pinned rules 不能按普通历史淘汰。

## 18. Batch C 初步事实

1. Context Injection 的新增重点不是再造 M-007/M-008，而是 meta retention、入口清洗和 attachment budget。
2. 指令型记忆与自动记忆必须分权；存储位置相同也不能合并 Authority。
3. Memory 的核心闭环是 admission → typed storage → bounded index → selection → verification，而不是单次 `memory_read`。
4. Claude 不压缩 system prompt；它通过 profile、cache、source guard 和 post-compact reinjection 控制成本。
5. D05 的安全入口只完成机制登记，攻击模型与运行时 enforcement 必须在 Batch D 冻结。

## 19. Batch D 边界

Batch D 将索引 D08 Observability、D09 Model Adaptation、D10 Security，并回收 M-018、M-039～M-041、M-044、M-047 的交叉证据。

## 20. D08 — Observability

### M-051 Layered Observability Planes

- **机制**：本地 debug log、完整 Prompt dump、分类器 dump、生产 telemetry 四层分离。
- **来源**：分析资料 L3308-L3332。
- **证据等级**：A。
- **作用**：runtime events/request snapshots → 不同敏感度与用途的观测通道。
- **解决问题**：开发诊断、请求复现和生产指标不能共用同一数据面。
- **依赖**：事件模型、访问控制、retention、redaction。
- **mi-code 现状**：有日志和 token 总量，没有 Prompt 专用观测分层。
- **迁移价值**：高。
- **边界**：不得默认记录完整用户内容。

### M-052 Buffered Local Debug Logging

- **机制**：分级日志先缓冲再写本地文件，并有明确启用方式和位置。
- **来源**：分析资料 L3334-L3450。
- **证据等级**：A。
- **作用**：debug events → buffered records → local diagnostic file。
- **解决问题**：避免同步日志阻塞流式循环，同时保留时序证据。
- **依赖**：level、buffer flush、session correlation、rotation。
- **mi-code 现状**：已有 debug/task logs，但没有 Prompt section 级事件。
- **迁移价值**：中。
- **边界**：日志存在不等于可复现最终请求。

### M-053 Bounded Prompt Request Dump

- **机制**：受限用户可异步转储完整 API 请求，并只缓存最近 5 个请求。
- **来源**：分析资料 L3452-L3529。
- **证据等级**：A。
- **作用**：final request → bounded asynchronous dump。
- **解决问题**：诊断 Prompt、tool schema 和 messages 的最终组合。
- **依赖**：权限门、ring buffer、redaction、non-blocking writer。
- **mi-code 现状**：没有 final prompt dump、request hash 或最近请求环。
- **迁移价值**：高。
- **关系**：属于 M-051 四层中的完整请求转储层；默认关闭是该高敏感层的准入策略。
- **边界**：完整 dump 是高敏感能力，默认必须关闭。

### M-054 Decision-Subsystem Dump

- **机制**：非主模型决策子系统独立记录输入、输出和错误诊断，而非只记录主 Agent 请求。
- **来源**：分析资料 L3531-L3591。
- **证据等级**：A。
- **作用**：classifier/permission/policy/router input、decision、error → subsystem-specific dump。
- **解决问题**：模式分类、PermissionChecker、bash policy 和未来 Tool Search 路由错误不能从主模型日志中可靠定位。
- **依赖**：decision ID、input snapshot、error taxonomy。
- **mi-code 现状**：PermissionChecker 与 bash parser 已存在，但没有结构化 decision trace；ControlMode classifier 尚不存在。
- **迁移价值**：中；先覆盖已存在的 Permission/command policy，不预建未使用 classifier。
- **边界**：只观测确定性决策的输入与结果，不记录或推断模型隐藏思维。

### M-055 Prompt and Tool Schema Telemetry

- **机制**：记录 system prompt、tool schema、Prompt block 和事件类型的结构化指标。
- **来源**：分析资料 L3593-L3674。
- **证据等级**：A。
- **作用**：compiled request components → size/hash/variant/event metrics。
- **解决问题**：把 token 增长、variant 漂移和工具成本定位到具体组件。
- **依赖**：Prompt Registry、compiler snapshot、stable IDs。
- **mi-code 现状**：只有 Provider 总 token，无法按 section/tool 归因。
- **迁移价值**：高。
- **边界**：优先记录 metadata/hash，正文只在受控 dump 中出现。

### M-056 Telemetry Redaction and PII Labels

- **机制**：遥测发送前执行敏感信息过滤，并对字段进行 PII 分类标记。
- **来源**：分析资料 L3676-L3706。
- **证据等级**：A。
- **作用**：telemetry payload + field policy → redacted/labeled event。
- **解决问题**：生产观测不能成为代码、路径和凭据泄漏通道。
- **依赖**：field schema、redactor、PII taxonomy、drop policy。
- **mi-code 现状**：Baseline 未发现统一 telemetry redaction。
- **迁移价值**：高。
- **边界**：先定义最小必要事件，再谈采集；redaction 不是扩大采集范围的理由。

## 21. D09 — Model Adaptation

### M-057 Provider Adapter Branches

- **机制**：共享核心 Prompt，通过 Provider adapter 处理 API、beta header、model ID 和推理配置差异。
- **来源**：分析资料 L3731-L3847。
- **证据等级**：A。
- **作用**：semantic request + provider → provider-specific payload。
- **解决问题**：避免把传输差异散落进 Prompt 文本。
- **依赖**：provider detection、model mapping、capability descriptor。
- **mi-code 现状**：已有 Anthropic/OpenAI/Google 适配，是可复用基础。
- **迁移价值**：中。
- **边界**：共享语义不意味着三个 Provider 使用字节相同 Prompt。

### M-058 Runtime Model Capability Detection

- **机制**：按模型能力决定 thinking、auto mode、structured output 和 context management。
- **来源**：分析资料 L3849-L3935。
- **证据等级**：A。
- **作用**：model ID/capabilities → enabled request features and Prompt sections。
- **解决问题**：不能向不支持能力的模型发送无效参数或指令。
- **依赖**：capability registry、fallback、版本更新。
- **mi-code 现状**：Provider 分发存在，但缺少统一能力表。
- **迁移价值**：高。
- **边界**：能力应驱动配置，不应依赖模型名称字符串猜测。

### M-059 Third-Party Capability Override

- **机制**：允许第三方兼容模型显式覆盖默认能力判断。
- **来源**：分析资料 L3937-L3964。
- **证据等级**：A。
- **作用**：default capability + trusted override → effective capability。
- **解决问题**：OpenAI-compatible endpoint 的真实能力不能仅由 Provider 类型推断。
- **依赖**：受信配置、schema validation、safe default。
- **mi-code 现状**：支持自定义 base URL/model，但能力语义不完整。
- **迁移价值**：中到高。
- **关系**：override 的对象是 M-057 Provider adapter 给出的默认能力判断；只能经受信配置收窄或修正。
- **边界**：override 是配置权，不是 Agent 自行提升能力。

### M-060 Model-Aware Prompt Caching

- **机制**：按模型/Provider 是否支持 caching 选择 cache control 与 scope。
- **来源**：分析资料 L3966-L3996。
- **证据等级**：A。
- **作用**：model capability + prompt blocks → cache annotations or none。
- **解决问题**：缓存协议和收益因模型而异。
- **依赖**：M-058、stable blocks、M-055 提供的 cache hit/miss、token 与 variant telemetry。
- **mi-code 现状**：没有显式 cache controls 和命中统计。
- **迁移价值**：中到高。
- **边界**：没有命中数据时不得宣称成本收益。

### M-061 Model Lifecycle Metadata

- **机制**：集中维护 marketing name、知识截止时间和 model deprecation 信息，并注入或提示迁移。
- **来源**：分析资料 L3998-L4091；与 M-018 的 `@[MODEL LAUNCH]` 标记互相补强。
- **证据等级**：A。
- **作用**：model ID → display/cutoff/deprecation metadata。
- **解决问题**：Prompt 中的模型自我描述和退役提示会随发布变化。
- **依赖**：model registry、release update、deprecation policy。
- **mi-code 现状**：模型名来自配置，没有集中生命周期治理。
- **迁移价值**：中。
- **关系**：M-018 管理 Prompt variant 演进，M-061 管理其依赖的模型生命周期元数据；M-039 的 Undercover 规则决定哪些模型/环境名称可暴露。
- **边界**：不得把营销名称当作 capability 判断依据。

## 22. Batch D-1 初步事实

1. 可观测性必须把 metadata telemetry 与高敏感 full dump 分开。
2. Prompt 成本归因依赖稳定 section/tool IDs，因此 D08 依赖 Phase 1 Prompt Kernel。
3. mi-code 已有 Provider adapter，但缺少跨 Provider 的 capability registry。
4. Model adaptation 应由 capability 驱动，不能靠 Prompt 内条件猜测。
5. Batch D-2 将完成 D10，并回收 M-040/M-041/M-044/M-047；在此之前 Batch D 不冻结。

## 23. Batch D-2 交叉证据回收

| 既有机制 | D10 新证据 | 处理 |
|---|---|---|
| M-039 | L4473-L4490 | Undercover 不只是环境字段裁剪，也是模型与部署身份的信息泄露边界；保留原编号 |
| M-040 | L4147-L4217、L4402-L4424 | Context ingress 清洗是总入口；新增 M-063 表达子进程执行边界，M-069 表达 Prompt 软检测 |
| M-041 | L4492-L4505 | 补强 attachment budget 的安全目的；Claude 参数为每 turn 20KB、每 session 60KB，不作为 mi-code 目标值 |
| M-044 | L4402-L4439 | 记忆验证属于更广义 untrusted-content 边界；保留“不可自行提升 Authority”，不重复创建 Memory 安全机制 |
| M-047 | L4299-L4355 | Team/Agent scope 的信任扩散受跨机器审批和 handoff 检查约束；新增 M-066/M-067 表达 enforcement |

## 24. D10 — Security

### M-062 Layered Security Enforcement

- **机制**：把环境、命令、二进制、跨机器、委派、路径和 Prompt 防御拆为七层独立控制。
- **来源**：分析资料 L4116-L4145。
- **证据等级**：A。
- **作用**：不同攻击面 → 对应的 pre-execution、post-result 或 Prompt 层控制。
- **解决问题**：单一 Prompt 指令无法覆盖数据窃取、权限绕过和内容注入。
- **依赖**：统一风险模型、层间事件、deny/ask/allow 结果。
- **mi-code 现状**：存在 PermissionChecker、路径检查和 Prompt 约束，但防线未形成统一链路。
- **迁移价值**：高。
- **边界**：分层数量不是目标；每层必须有独立攻击模型和测试证据。

### M-063 Child-Process Environment Scrubbing

- **机制**：为 Bash、MCP stdio、LSP、hooks 创建清洗后的子进程环境，父进程保留 API 所需变量。
- **来源**：分析资料 L4147-L4217。
- **证据等级**：A。
- **作用**：parent env + scrub policy → least-secret child env。
- **解决问题**：Prompt injection 可能借 shell expansion 窃取 API key 和 CI input。
- **依赖**：变量 allow/deny policy、子进程统一入口、CI 前缀处理。
- **mi-code 现状**：Baseline 未发现统一 subprocess env scrubber。
- **迁移价值**：高。
- **关系**：是 M-040 Context Ingress Sanitization 在执行出口的硬边界；M-040 管内容进入，M-063 管秘密进入子进程。
- **边界**：变量例外必须按真实 wrapper 依赖审计，不能照搬 Claude 列表。

### M-064 AST Command Policy with Shadow Evaluation

- **机制**：用 shell AST 解析 substitution、expansion 和 control flow；shadow 模式对比旧判定，too-complex 有确定性处理。
- **来源**：分析资料 L4219-L4270。
- **证据等级**：A。
- **作用**：command string → AST/risk classification → allow、ask 或 deny。
- **解决问题**：字符串 denylist 容易被 shell 语法组合绕过。
- **依赖**：平台 shell grammar、complexity limit、decision trace、fallback policy。
- **mi-code 现状**：Plan bash 主要是 parser/denylist，frozen 目标为 allowlist + 参数 + 路径三重门。
- **迁移价值**：中到高。
- **关系**：属于 M-062 分层安全中的命令策略层；与 M-065 互补——M-064 处理命令内容与控制结构，M-065 处理执行环境和内联变量。
- **边界**：AST 检测不能替代 Plan Mode allowlist；两者解决不同层次问题。

### M-065 Binary Hijack and Env-Assignment Defense

- **机制**：检测命令前导环境赋值，对 loader/PATH 等变量按 allow/deny 规则剥离。
- **来源**：分析资料 L4272-L4297。
- **证据等级**：A。
- **作用**：command env assignments + policy → sanitized executable invocation。
- **解决问题**：允许的二进制可能被 `LD_PRELOAD`、`DYLD_*` 或 PATH 劫持。
- **依赖**：assignment parser、safe variable list、executable resolution；与 M-063 共享变量风险策略。
- **mi-code 现状**：Baseline 未发现统一 binary hijack 防御。
- **迁移价值**：中到高。
- **关系**：与 M-063 互补；M-063 清洗继承给子进程的环境，M-065 处理命令文本中的前导环境赋值。
- **边界**：不得把所有环境赋值一律删除；需要兼容性与攻击面测试。

### M-066 Non-Auto-Approvable Cross-Machine Actions

- **机制**：跨机器消息/动作标记为 classifier 不可自动批准，必须进入用户 `ask`。
- **来源**：分析资料 L4299-L4323。
- **证据等级**：A。
- **作用**：cross-machine action → non-auto-approvable decision → explicit user consent。
- **解决问题**：远端不可信内容可能串联成本地高权限动作。
- **依赖**：action provenance、NeedUserDecision、不可绕过的 ask 通道。
- **mi-code 现状**：Permission `ask` 当前主路径未接通，无法提供此保证。
- **迁移价值**：高。
- **关系**：为 M-047 Team Memory/communication 的跨边界传播提供审批 enforcement。
- **边界**：用户确认不能变成“一次允许后永久自动批准”。

### M-067 Delegation Permission and Handoff Validation

- **机制**：Agent 委派本身标记危险、不可自动批准；子 Agent 输出再经 handoff 安全检查并附警告。
- **来源**：分析资料 L4326-L4355。
- **证据等级**：A。
- **作用**：delegation request + child result → permission gate + validated handoff。
- **解决问题**：攻击者可能通过子 Agent prompt 或输出绕过主 Agent 权限。
- **依赖**：permission propagation、child provenance、result classifier、parent verification。
- **mi-code 现状**：部分子 Agent 透传权限，但 `task` 路径存在 expected failure；没有 handoff security classifier。
- **迁移价值**：高。
- **关系**：补强 M-014/M-016/M-017 的子 Agent Prompt 机制和 M-047 的 scope 传播。
- **边界**：警告前缀不能把恶意输出提升为可信内容。

### M-068 Cross-Platform Windows Path Bypass Detection

- **机制**：在所有平台检测 NTFS ADS、8.3 短名和长路径前缀等 Windows 绕过模式，选择检测而非规范化。
- **来源**：分析资料 L4359-L4400。
- **证据等级**：A。
- **作用**：raw path → bypass-pattern detector → reject/ask。
- **解决问题**：路径字符串可绕过目录边界或扩展名检查，且 NTFS 可能挂载在非 Windows 平台。
- **依赖**：pattern set、filesystem permission layer、TOCTOU-aware policy。
- **mi-code 现状**：已有路径 sandbox 测试，但 Baseline 未确认这些 NTFS 模式完整覆盖。
- **迁移价值**：中到高。
- **边界**：具体差距必须用 mi-code 当前 path checker 和回归用例确认。

### M-069 Prompt-Injection Suspicion Signaling

- **机制**：System Prompt 提醒模型发现可疑注入时报告，同时 image path 等入口做确定性占位符防御。
- **来源**：分析资料 L4402-L4424。
- **证据等级**：A。
- **作用**：untrusted content → model suspicion signal + deterministic ingress checks。
- **解决问题**：内容级攻击不一定能在命令执行前完全识别。
- **依赖**：untrusted provenance、M-040 ingress filters、user reporting path。
- **mi-code 现状**：Tool result 没有 trust metadata，也没有统一 injection envelope。
- **迁移价值**：高。
- **关系**：与 M-064 位于同一攻击链的不同阶段；M-069 处理命令形成前的注入内容与怀疑信号，M-064 处理已经形成的命令语法和执行风险。
- **边界**：模型“怀疑”只是软信号，不能直接判定内容恶意或提升/降低权限。

### M-070 Strict Tool-Use / Result Pair Integrity

- **机制**：严格模式下拒绝自动合成缺失的 tool result，要求 `tool_use` 与 `tool_result` 完整配对。
- **来源**：分析资料 L4426-L4439。
- **证据等级**：A。
- **作用**：message sequence → pairing validator → accept or reject repair。
- **解决问题**：自动补占位符可能把攻击内容或错误状态伪装成真实工具结果。
- **依赖**：tool call ID、message validator、compression/session awareness。
- **mi-code 现状**：Phase 0 已冻结 INV-8，但当前压缩和持久化没有显式 pairing contract。
- **迁移价值**：高。
- **关系**：是 frozen INV-8 的 Claude 侧证据，并约束 M-049 Post-Compact Reinjection。
- **边界**：拒绝修复后必须产生明确失败/恢复路径，不能静默丢消息。

### M-071 Information-Disclosure Policy Layers

- **机制**：Anti-Distillation、Cyber Risk Instruction 与 Undercover 分别限制模型能力提取、攻击性协助和部署身份泄露。
- **来源**：分析资料 L4441-L4490。
- **证据等级**：A。
- **作用**：request/model/deployment context → policy section or response restriction。
- **解决问题**：安全边界不仅是文件和命令权限，也包括模型与系统信息泄露。
- **依赖**：policy ownership、model/deployment metadata、review gate。
- **mi-code 现状**：有少量安全措辞，没有独立 policy ownership 与版本治理。
- **迁移价值**：低到中；取决于 mi-code 产品边界和分发方式。
- **关系**：Undercover 部分回收 M-039；治理方式依赖 M-018 Prompt Evolution。
- **边界**：不得把 Claude 的产品政策原文当作 mi-code 的默认政策。

## 25. Batch D-2 初步事实

1. D10 的主要价值来自 runtime enforcement，不来自增加更多安全措辞。
2. `ask` 必须成为真实阻塞通道，否则跨机器和委派边界无法成立。
3. ToolResultEnvelope、pairing invariant、permission propagation 是安全与 lifecycle 的共同基础。
4. Prompt injection detection 必须区分确定性入口检查与模型软告警。
5. 成熟 Security Prompt 只能提供措辞与报告格式参考，不能替代 mi-code 威胁模型。

## 26. Mechanism Index 覆盖结论

10 个机制域均已完成首轮索引：

```text
D01-D02 + Cross  M-001～M-018
D03-D04          M-019～M-037
D05-D07          M-038～M-050
D08-D09          M-051～M-061
D10              M-062～M-071
```

Mechanism Index 已整体冻结。下一产物是 Gap / Value Matrix，不直接进入 Phase 1-6 设计。
