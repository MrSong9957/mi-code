# mi-code Agent / Prompt Mechanisms Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：冻结

**Goal:** 按冻结 DAG 将 49 个 designed/actionable 机制落实为可验证的运行时契约，同时保持 14 个 Deferred 和 8 个 Hold 不进入实现范围。

**Architecture:** 实施采用 Wave A→G 的依赖顺序和“契约模块 → 兼容适配 → 主链路切换 → 旧语义退役”迁移法。现有 Provider clients、ToolRegistry、PermissionChecker、MemoryManager、streaming loop 和 compression 作为复用锚点；新增模块只承载冻结 Contract 的单一职责，不建立中央 Agent FSM。

**Tech Stack:** Node.js >=18、TypeScript ES2022/NodeNext strict、Vitest 3、ESLint 9、现有 Anthropic/OpenAI/Google SDK、现有 pino 日志栈。

## Global Constraints

- 唯一设计输入是已冻结的 Baseline、Mechanism Index、Gap / Value Matrix、Wave A～G 规格和 71 项覆盖审计。
- 当前实施范围严格为 49 个 Designed / Actionable 机制。
- 14 个 Deferred 只保留触发条件；不得创建实现文件、feature flag 或预留分支。
- 8 个 Hold 只保留 Evidence gate；不得通过配置默认值绕过重新评审。
- 实施顺序服从 Wave A→G 和冻结 D-edge，不服从 Phase 编号或 ValueScore 排名。
- Required Reuse 的 M-019/M-057 只补契约和一致性测试，不重写 Provider tool plane 或 adapter。
- Required Dependency 的 M-018/M-020/M-043 作为下游稳定输入，不包装成独立用户功能。
- Snapshot 创建后不可变；Authority、Trust、Placement、Retention、Freshness 不得从字符串位置或 ID 推断。
- Prompt 文本、模型输出和工具结果不得代替 runtime enforcement。
- `ask` 必须是可持久化且不可绕过的阻塞状态；无通道时 fail closed。
- `selected ≠ use`、`admitted ≠ persisted ≠ selected ≠ use`。
- Tool use/result 必须按 `tool_call_id` 完整配对；不得生成占位结果掩盖协议错误。
- 默认 telemetry 只记录 metadata/hash；正文和 credential 不进入生产观测面。
- 每项行为修改执行 RED→GREEN→REFACTOR；先看到目标测试因正确原因失败。
- 开发期按 L1/L2 验证，Wave 冻结前执行 L3：`npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
- 本计划不授权生产部署、远程写入、依赖升级、数据库迁移或 Git 历史写操作。

---

## 1. 冻结输入

执行者开始任何任务前必须读取：

1. `docs/superpowers/specs/2026-07-26-agent-prompt-baseline.md`
2. `docs/superpowers/specs/2026-07-26-claude-mechanism-index.md`
3. `docs/superpowers/specs/2026-07-26-gap-value-matrix.md`
4. `docs/superpowers/specs/2026-07-26-agent-foundation-wave-a-design.md`
5. `docs/superpowers/specs/2026-07-26-agent-primary-anchors-wave-b-design.md`
6. `docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md`
7. `docs/superpowers/specs/2026-07-26-agent-integrated-capabilities-wave-d-design.md`
8. `docs/superpowers/specs/2026-07-26-agent-lifecycle-selection-wave-e-design.md`
9. `docs/superpowers/specs/2026-07-26-agent-bounded-memory-entrypoint-wave-f-design.md`
10. `docs/superpowers/specs/2026-07-26-agent-post-compact-reconstruction-wave-g-design.md`
11. `docs/superpowers/specs/2026-07-26-agent-mechanism-coverage-audit.md`

Claude Prompt Library 快照是独立候选资产源。它不属于本计划的运行时启用输入，除非对应资产已按 RC-1 获得 `approved` 状态。

## 2. Wheel Reuse Check

| 现有轮子 | 位置 | 复用方式 | 禁止事项 |
|---|---|---|---|
| Tool 类型与调用 ID | `src/agent/types.ts` | 保留 `ToolUseBlock.id` / `ToolResultBlock.tool_use_id`，增加统一快照适配 | 不建立第二套 Provider tool protocol |
| Tool Registry | `src/agent/tool-registry.ts` | 增加确定性 descriptor snapshot 和 overlay 消费接口 | 不重写 executor 注册/调用 |
| Provider adapters | `src/agent/*-stream-client.ts` | 增加 semantic snapshot conformance adapter/test | 不把策略选择下放给 adapter |
| Streaming loop | `src/agent/streaming-query.ts` | 作为请求、权限、pairing、compaction 的最终接线点 | 不引入中央 FSM |
| PermissionChecker | `src/permission/checker.ts` | 迁移到结构化 SecurityDecision，保留规则匹配入口 | 不允许 `ask` 继续执行 |
| Bash/path 分析 | `src/permission/bash-*.ts`、`patterns.ts` | 作为 AST policy 与 executable/env policy 的现状输入 | 不以 denylist 冒充 Plan allowlist |
| Subagent runtime | `src/agent/subagent.ts`、`roles.ts` | 保留执行与角色注册，替换结果和权限传播语义 | 不保留 `incomplete/unverified` 顶层 Outcome |
| MemoryManager | `src/memory/memory-manager.ts` | 作为 legacy storage adapter | 存量条目不得自动获得 admission |
| Compression | `src/agent/compression.ts` | 复用现有压缩算法，外加事务式 pre/postflight | summary 不得伪造执行事实 |
| Event bus | `src/agent/stream-event-bus.ts` | 作为结构化观测事件出口 | 不记录隐藏思维或未清洗正文 |
| pino | 现有依赖 | 用于清洗后的本地 debug sink | 不新增日志框架 |
| Session store | `src/session/store.ts` | 持久化 pending ask、snapshot/publish acknowledgement | 不把文本 summary 当控制状态 |

## 3. Core Anchor Functions

每个 Wave 必须先打通一个输入明确、输出明确的核心函数。未完成依赖使用测试内 fake，不在生产路径创建猜测性 stub。

| Wave | Core Anchor Function | 输入 | 输出 |
|---|---|---|---|
| A | `buildSemanticRequestSnapshot()` | 已治理资产之外的语义 section/message/tool 快照 | Provider-neutral immutable request |
| B | `compilePromptSnapshot()` | registry + typed context + capability/tool view | immutable compiled prompt |
| C | `resolvePromptPolicy()` | base/profile/condition/override snapshots | deterministic resolution |
| D | `activateTrustedContext()` | routed candidate + admission/use evidence | trusted context projection |
| E | `persistAndSelectMemory()` | admitted candidate + search query | durable catalog + selected refs |
| F | `buildBoundedMemoryEntrypoint()` | catalog selection + current use decisions + budgets | bounded two-layer section |
| G | `reconstructPostCompactWorkingSet()` | preflight-valid transcript + compact output + rebuild inputs | atomically publishable candidate |

## 4. 文件结构

以下结构是计划级文件责任边界。执行者必须先复核当前分支是否已经存在同名等价模块；存在时复用，不重复创建。

```text
src/
├── agent/
│   ├── contracts/
│   │   ├── identities.ts
│   │   ├── request-snapshot.ts
│   │   └── completion-report.ts
│   ├── prompt/
│   │   ├── compiler.ts
│   │   ├── resolution.ts
│   │   ├── profiles.ts
│   │   └── registry.ts
│   ├── context/
│   │   ├── discovery.ts
│   │   ├── intake.ts
│   │   ├── routing.ts
│   │   ├── activation.ts
│   │   ├── retention.ts
│   │   ├── bounded-memory.ts
│   │   └── reconstruction.ts
│   ├── tools/
│   │   ├── descriptor-snapshot.ts
│   │   ├── overlay.ts
│   │   ├── transcript-validator.ts
│   │   └── reference-validator.ts
│   └── observability/
│       ├── envelopes.ts
│       ├── redaction.ts
│       ├── telemetry.ts
│       └── local-buffer.ts
├── memory/
│   ├── admission.ts
│   ├── catalog.ts
│   ├── persistence.ts
│   ├── selection.ts
│   └── legacy-adapter.ts
└── permission/
    ├── decisions.ts
    ├── runtime-gate.ts
    ├── command-policy.ts
    └── executable-environment.ts
```

测试与生产模块同域放入 `src/__tests__/agent/...`、`src/__tests__/memory/...`、`src/__tests__/permission/...`；现有回归测试保留原路径。

## 5. Wave 计划分卷

| 顺序 | 详细计划 | Contract | 机制数 | 进入条件 |
|---|---|---:|---:|---|
| A | `2026-07-26-agent-mechanisms-wave-a-implementation.md` | RC-1～RC-5 | 8 | 本主计划冻结 |
| B | `2026-07-26-agent-mechanisms-wave-b-implementation.md` | BRC-1～BRC-7 | 15 | Wave A 验收通过 |
| C | `2026-07-26-agent-mechanisms-wave-c-implementation.md` | CRC-1～CRC-6 | 13 | Wave B 验收通过 |
| D | `2026-07-26-agent-mechanisms-wave-d-implementation.md` | DRC-1～DRC-5 | 6 | Wave C 验收通过 |
| E | `2026-07-26-agent-mechanisms-wave-e-implementation.md` | ERC-1～ERC-4 | 5 | Wave D 验收通过 |
| F | `2026-07-26-agent-mechanisms-wave-f-implementation.md` | FRC-1 | 1 | Wave E 验收通过 |
| G | `2026-07-26-agent-mechanisms-wave-g-implementation.md` | GRC-1 | 1 | Wave F 验收通过 |

不得并行实施相邻 Wave。一个 Wave 内只有在详细计划明确声明没有共享生产文件和状态时才可并行。

## 6. Wave A — Root Contracts

**机制：** M-006、M-010、M-018、M-019、M-023、M-037、M-057、M-062。

**主要交付：**

- immutable Prompt Asset Registry；
- Provider-neutral SemanticRequestSnapshot；
- Tool plane identity/canonical order contract；
- deterministic Project Rule Discovery；
- CompletionReport/DispatchReceipt；
- SecurityDecision/UserDecision vocabulary。

**迁移策略：**

1. 先增加纯类型、构建器和验证器。
2. 用 conformance tests 锁定现有 Provider adapter 与 tool ID 行为。
3. 以兼容 adapter 迁移 PermissionDecision 和 SubagentResult。
4. 不在 Wave A 启用 Prompt compiler、阻塞 ask 或 context trust。

**Wave 验证：**

```powershell
npx vitest run src/__tests__/agent/contracts/ src/__tests__/agent/project-rule-discovery.test.ts src/__tests__/permission/security-decision.test.ts src/__tests__/subagent-result-integrity.test.ts
npm run typecheck
npm run lint
npm run build
```

## 7. Wave B — Primary Anchors

**机制：** M-001、M-011、M-014、M-020、M-024、M-035、M-039、M-040、M-042、M-050、M-051、M-058、M-063、M-066、M-070。

**主要交付：**

- section-array Prompt compiler；
- capability-aware immutable tool view；
- typed/untrusted context intake；
- role/task prompt profiles；
- tool transcript pairing validator；
- child-process env scrub + blocking ask runtime gate；
- layered observability envelopes。

**核心切换点：**

- `AgentConfig.system: string` 迁移为 compiled snapshot 的兼容读取；
- `ToolRegistry.getDefinitions()` 不再是请求构建的直接来源；
- streaming/serial 两条工具执行路径统一经过 pairing 与 security gate；
- Provider capability 来自 registry，不从 model name 猜测。

**Activation gate：**

- M-066 必须证明 ask 可持久化/恢复；
- M-070 必须提供 deterministic failure recovery；
- BRC-7 production plane 在 M-056 前保持禁用。

## 8. Wave C — Policy Contracts

**机制：** M-002、M-003、M-004、M-009、M-012、M-026、M-031、M-043、M-054、M-056、M-059、M-067、M-069。

**主要交付：**

- Prompt precedence/static-dynamic/condition resolver；
- trusted capability override；
- context routing + typed auto memory；
- tool-local policy 与 no-tools compaction contract；
- delegation hard gate 与 injection soft signal；
- decision trace 和 telemetry redaction。

**硬边界：**

- Markdown、schema、路径和文件存在都不建立信任；
- no-tools 需同时满足 profile、empty view、Provider omission、runtime rejection；
- injection signal 永远不能产生 SecurityDecision；
- credential/sensitive auth 默认 drop event。

## 9. Wave D — Integrated Capabilities

**机制：** M-008、M-028、M-044、M-048、M-055、M-064。

**主要交付：**

- mode-specific Prompt projection；
- project instruction 与 auto memory 的跨通道 activation；
- final request tool-reference integrity；
- component telemetry attribution；
- AST command policy shadow/enforced protocol。

**硬边界：**

- mode 来自结构化 snapshot；
- admission 与 use 分离；
- tool reference 校验最终 request，不校验静态 registry；
- Provider aggregate usage 不伪分配到 section；
- shadow 没有执行权，Plan allowlist 与 AST policy 为 AND。

## 10. Wave E — Lifecycle & Selection

**机制：** M-038、M-045、M-046、M-052、M-065。

**主要交付：**

- meta context retention lifecycle；
- memory four-stage persistence 与 catalog-only selection；
- sanitized-before-buffer 本地 debug logging；
- inherited/inline env 与 executable identity/TOCTOU defense。

**硬边界：**

- serializer/compressor 不支持 meta metadata 时不得启用 retention；
- detail 在 index commit 前不可发现；
- selected candidate 仍必须经过 MemoryUseDecision；
- dropped telemetry payload 不得暂存旁路副本；
- spawn 前重新验证 executable identity，旧批准不跨新 action snapshot。

## 11. Wave F — Bounded Memory Entrypoint

**机制：** M-013。

**主要交付：**

- Navigation Layer：selected catalog metadata；
- Verified Detail Layer：current-context `MemoryUseDecision(status='use')` claims；
- navigation/detail/total 三层硬预算；
- entry/claim 边界截断和 explicit overflow manifest。

**硬边界：**

- System Placement 不提升 Memory Authority；
- cache 只优化性能；
- 失败不得回退为加载全部 Memory。

## 12. Wave G — Post-Compact Reconstruction

**机制：** M-049。

**主要交付：**

- preflight-valid compaction candidate；
- project instruction preserve/reload_required/invalidated；
- current-context memory rebuild request；
- postflight validation；
- candidate → postflight → atomic publish transaction。

**硬边界：**

- completed tool 永不重执行；
- old system prompt string 不进入 Pinned Working Set；
-旧 MemoryUseDecision 不跨 target context；
- durable publish acknowledgement 前旧 snapshot 保持可恢复。

## 13. 迁移批次

每个 Wave 使用相同的四批迁移法：

| 批次 | 内容 | 允许状态 |
|---|---|---|
| 1. Contract | 类型、纯函数、validator、snapshot builder | 新旧路径并存，生产路径不切换 |
| 2. Adapter | 从旧对象映射到新契约 | 兼容读，新写结构化 |
| 3. Cutover | 主请求/工具/压缩路径消费新契约 | feature gate 或单次原子切换 |
| 4. Retirement | 删除旧状态和值域 | 仅在回归/恢复测试通过后 |

禁止在同一个测试循环中同时新增契约、切换主路径并删除旧路径。

## 14. 防御边界

| 高频失败 | 计划级防护 |
|---|---|
| Provider adapter 偷做策略决定 | adapter conformance suite：只编码，不改变语义 |
| 工具可见性与 executor 权限漂移 | 同一个 immutable policy snapshot 驱动 view、permission、executor |
| ask 被当 warning | pending decision integration test；UserDecision 前 executor 调用次数必须为 0 |
| tool result 缺失被补占位 | transcript validator 返回 protocol failure，禁止 synthetic result |
| 文件存在即 trusted | discovery/intake/routing/activation 四阶段分别测试 |
| Memory selected 即注入 | use-decision negative test |
| telemetry 先缓存后清洗 | buffer spy 断言 raw credential 从未进入内存容器 |
| compaction 后重复工具 | execution spy + idempotency/pairing test |
| snapshot 构建中混入新 registry | capture-then-mutate test |
| cache 改变语义 | cache hit/miss 输出深比较 |

## 15. 测试策略

### 15.1 测试层级

- 单元：纯 resolver、validator、policy、budget、state transition。
- 集成：compiler→request snapshot→Provider adapter；permission→executor；memory→FRC；compaction→GRC。
- E2E：Normal/Plan 请求、阻塞 ask 恢复、子 Agent result、post-compact continue。

### 15.2 必须保留的失败证据

每个任务的 RED 输出至少包含：

- 失败测试名；
- 失败原因确实来自缺失行为，而非 import/fixture 错误；
- 最小实现后的 GREEN 输出；
- 受影响模块回归输出。

### 15.3 验证等级

| 变更 | 最低等级 |
|---|---|
| 类型/纯 validator | V1：typecheck + targeted unit |
| Prompt/Context/Tool 行为 | V2：unit + integration + snapshot |
| Permission/Security/Memory/Compression | V2，主路径切换时 V3 |
| CLI/TUI ask/resume/compaction 用户路径 | V3：真实 CLI/TTY 或等价 E2E harness |

## 16. Wave Gate

每个 Wave 只有同时满足下列条件才能进入下一 Wave：

1. 该 Wave 详细计划中的 task 全部有 RED/GREEN 证据。
2. 所有 Contract 验收条件逐条映射到测试。
3. 该 Wave 的不变量有 machine-checkable test 或明确的 runtime assertion。
4. 兼容迁移表中的旧语义已按计划保留或退役。
5. 未激活任何 Deferred/Hold。
6. targeted tests、typecheck、lint、build 全部通过。
7. 涉及跨模块主链路时，全量 `npm test` 通过。
8. 输出完成报告包含 changed、verification level、evidence、remaining uncertainty。

## 17. Deferred 与 Hold 防误入清单

实施者遇到下列 ID 必须停止并回到设计评审：

```text
Deferred:
M-005 M-007 M-015 M-016 M-017 M-021 M-022
M-025 M-030 M-032 M-033 M-034 M-053 M-061

Hold:
M-027 M-029 M-036 M-041 M-047 M-060 M-068 M-071
```

不得以“顺手补齐”“已有接口”“只加 flag”作为进入当前实现的理由。

## 18. 计划交付顺序

- [ ] 冻结本主计划。
- [ ] 编写并冻结 Wave A 详细计划。
- [ ] 编写并冻结 Wave B 详细计划。
- [ ] 按相同方式依次编写并冻结 Wave C～G 详细计划。
- [ ] 对 7 份详细计划执行跨计划接口、文件所有权和 49 项覆盖审计。
- [ ] 由执行者按 Wave A→G 顺序逐 Wave 实施和验收。
- [ ] 执行 49 项实施覆盖审计。
- [ ] 独立复核 Deferred/Hold 未被激活。
- [ ] 生成最终 V3 完成报告。

本主计划只规定全局边界和分卷顺序。具体文件行、接口签名、测试代码、RED/GREEN 命令和迁移检查点由各 Wave 详细计划给出。
