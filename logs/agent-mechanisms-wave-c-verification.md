# Wave C Verification

> 验证时间: 2026-07-26
> 分支: feature/agent-mechanisms-wave-a (Wave A + B + C 全部未提交, 待 review)
> 规格: docs/superpowers/specs/2026-07-26-agent-policy-contracts-wave-c-design.md
> 计划: docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-c-implementation.md

## changed (新增文件)

### Wave C-1 (7 并行子代理, 文件零冲突)

**CRC-1 Prompt Resolution Policy (T1-3, M-002/M-003/M-004)**
- src/agent/prompt/resolution.ts (新建, 973 行)
- src/__tests__/agent/prompt-condition-scope.test.ts (18 tests)
- src/__tests__/agent/prompt-resolution.test.ts (22 tests)
- src/__tests__/agent/prompt-resolution-compiler.test.ts (8 tests)

**CRC-2 Trusted Capability Override (T4, M-059)**
- src/config/capability-override.ts (新建, 242 行)
- src/config/schema.ts (修改: 添加可选 capability_overrides 字段)
- src/config/store.ts (修改: 添加 getCapabilityOverrides trusted loader)
- src/__tests__/config/capability-override.test.ts (20 tests)

**CRC-3 Context Routing & Memory Typing (T5-6-7, M-009/M-012/M-043)**
- src/agent/context/routing.ts (新建, 469 行)
- src/memory/candidates.ts (新建, 311 行)
- src/__tests__/agent/environment-context-block.test.ts (15 tests)
- src/__tests__/agent/markdown-routing.test.ts (28 tests)
- src/__tests__/memory/memory-candidate.test.ts (39 tests)

**CRC-4 Tool Policy & No-Tool Contract (T8-9, M-026/M-031)**
- src/agent/tools/policy-projection.ts (新建, 278 行)
- src/agent/tools/no-tool-contract.ts (新建, 196 行)
- src/__tests__/agent/tool-policy-projection.test.ts (19 tests)
- src/__tests__/agent/no-tool-contract.test.ts (14 tests)
- src/__tests__/agent/no-tool-contract-streaming.test.ts (3 tests, 集成)

**CRC-5 Delegation & Injection Boundary (T10-11-12, M-067/M-069)**
- src/permission/delegation.ts (新建, 432 行)
- src/agent/context/injection-signal.ts (新建, 245 行)
- src/__tests__/permission/delegation-gate.test.ts (12 tests)
- src/__tests__/permission/delegation-handoff.test.ts (8 tests)
- src/__tests__/agent/injection-signal.test.ts (21 tests)

**CRC-6 Observability Safety Policy (T13-14, M-054/M-056)**
- src/agent/observability/decision-trace.ts (新建, 169 行)
- src/agent/observability/redaction.ts (新建, 344 行)
- src/agent/observability/envelopes.ts (修改: 仅注释更新, 零行为变更)
- src/__tests__/agent/decision-trace.test.ts (22 tests)
- src/__tests__/agent/telemetry-redaction.test.ts (28 tests)

### Wave C-2~C-4 (主代理串行)

**T9 No-Tool Contract 接入 streaming-query.ts**
- src/agent/streaming-query.ts (修改: 加 noToolContract 选项 + 四重 enforcement)
  - provider gate: noToolActive 时 tools=[]
  - runtime gate: tool_use block → protocol rejection, executor 调用次数为 0
  - toolResults 提前声明 (per-turn 累积器)

**T10 Delegation Gate 接入 spawn-agent-tool.ts**
- src/agent/tools/spawn-agent-tool.ts (修改: 加 delegationGateHook 可选参数)
  - executor 在派发前调用 hook
  - denied → 返回错误文本, 不派发
  - 不传 hook 时 LEGACY 行为 (向后兼容)

**T11 Handoff Envelope (纯函数, 在 delegation.ts 内)**

### Wave C-5 (公共出口 + INV 验收)

**公共导出 (4 个 index.ts)**
- src/agent/index.ts (添加 CRC-1~CRC-6 公共导出)
- src/memory/index.ts (添加 TypedMemoryCandidate)
- src/permission/index.ts (添加 DelegationGate + HandoffEnvelope)
- src/config/index.ts (添加 applyCapabilityOverride)

**INV-C1~C15 验收**
- src/__tests__/agent/wave-c-contracts.test.ts (新建, 19 tests 覆盖 15 条不变量)

## mechanisms

M-002, M-003, M-004, M-009, M-012, M-026, M-031, M-043, M-054, M-056, M-059, M-067, M-069 (13 个机制, 6 个 CRC, 全覆盖)

## verification_level

V3 (targeted + regression + typecheck + lint + build + full test)

## red_evidence

每个 Task 严格按 TDD: 先写 RED 测试, 确认失败原因正确(模块不存在/import 错误), 再写实现。

代表性 RED 证据:
- no-tool-contract: "Failed to load url ../../agent/tools/no-tool-contract.js ... Does the file exist?"
- delegation-gate: 同上 (delegation.js 不存在)
- delegation-handoff: 8 failed (createDelegationHandoffEnvelope is not a function)

## green_evidence

### Targeted suite (16 文件 / 296 用例全绿)
```
npx vitest run src/__tests__/agent/prompt-condition-scope.test.ts \
  src/__tests__/agent/prompt-resolution.test.ts \
  src/__tests__/agent/prompt-resolution-compiler.test.ts \
  src/__tests__/config/capability-override.test.ts \
  src/__tests__/agent/environment-context-block.test.ts \
  src/__tests__/agent/markdown-routing.test.ts \
  src/__tests__/memory/memory-candidate.test.ts \
  src/__tests__/agent/tool-policy-projection.test.ts \
  src/__tests__/agent/no-tool-contract.test.ts \
  src/__tests__/agent/no-tool-contract-streaming.test.ts \
  src/__tests__/permission/delegation-gate.test.ts \
  src/__tests__/permission/delegation-handoff.test.ts \
  src/__tests__/agent/injection-signal.test.ts \
  src/__tests__/agent/decision-trace.test.ts \
  src/__tests__/agent/telemetry-redaction.test.ts \
  src/__tests__/agent/wave-c-contracts.test.ts
→ Test Files 16 passed (16), Tests 296 passed (296)
```

### Regression suite (18 文件 / 287 用例全绿, 2 skipped)
```
npx vitest run src/__tests__/streaming-query.test.ts src/__tests__/compression.test.ts \
  src/__tests__/role-agents.test.ts src/__tests__/subagent-result-integrity.test.ts \
  src/__tests__/permission.test.ts src/__tests__/config.test.ts src/__tests__/memory.test.ts \
  src/__tests__/regression/
→ Test Files 18 passed (18), Tests 287 passed | 2 skipped (289)
```
(2 skipped 是 Windows 符号链接环境限制, pre-existing)

### typecheck
```
npm run typecheck → tsc --noEmit (零输出零错误)
```

### lint (Wave C 源文件零 error)
```
npm run lint → Wave C 新增/修改文件零 error
(剩余 error 全部是 pre-existing TUI/UI 文件: text-layout.ts, block-format.ts 等)
(wave-c-contracts.test.ts 有 3 个 any warning, 是测试封闭性 DSL 拒绝未知 kind 的合理用法)
```

### build
```
npm run build → generated: planner.generated.ts (3785 chars) + tsc 成功
(build 副产物 planner.generated.ts LF→CRLF 已用 git checkout 还原, 与 Wave A/B 一致)
```

### full test
```
npm test → Test Files 222 passed | 4 failed (226), Tests 2850 passed | 8 failed | 4 skipped (2862)
```

**8 个 failed 全部是 pre-existing** (已通过 git stash 验证):
- src/__tests__/task-tool.test.ts (2): clientProvider is not a function — master 上也失败
- src/tui/inline/thinking-gap-regression.test.ts (1): TUI 渲染 flaky — master 上也失败
- src/__tests__/tui/layout.test.tsx (2): StatusBar 进度条渲染 — master 上也失败
- 其余 3 个: TUI bootstrap flaky (与 Wave A 的 6 failed / Wave B 的 12 failed 同源)

**Wave C 改动触及范围: 0 个失败**。

## invariant_evidence

INV-C1 through INV-C15 全部有机器可判定测试 (src/__tests__/agent/wave-c-contracts.test.ts, 19 tests):

- INV-C1 Policy 可重放: condition evaluation + redaction 确定性 (2 tests)
- INV-C2 Precedence 不等于 Authority: scope decision 无 authority 字段 (1 test)
- INV-C3 Condition 封闭三态: 未知 kind throw + unknown 不乐观 (2 tests)
- INV-C4 Cache eligibility 不等于收益: 无 cache_hit/saved_tokens 字段 (1 test)
- INV-C5 Capability override 受信配置权: gate 失败不应用 (1 test)
- INV-C6 文件与 schema 不建立信任: 四重 gate 任一失败 reject (1 test)
- INV-C7 Memory candidate 不等于 admitted: 无 store/merge/delete 方法 (1 test)
- INV-C8 Runtime policy 是工具事实来源: projection 无 behavior 字段 (1 test)
- INV-C9 No-tools 是硬协议: 四重 gate + literal 0 (2 tests)
- INV-C10 Delegation 不扩大权限: handoff trust 永不 trusted (1 test)
- INV-C11 Injection suspicion 是软信号: 无 behavior/security_decision_ref (1 test)
- INV-C12 Observability 先最小化再清洗: unlisted field drop (1 test)
- INV-C13 冻结 DAG 不反向修改: 无 Wave D hook (1 test)
- INV-C14 Failure 不升级权限: invalid no-tool + invalid handoff (2 tests)
- INV-C15 版本正交: 各 protocol version 独立常量 (1 test)

## no_direct_wave_d_edge

- CRC-2 (capability override): applyCapabilityOverride 是纯函数, 无 Wave D hook/consumer (INV-C13 测试验证)
- CRC-5 (delegation + injection): evaluateDelegationGate + createDelegationHandoffEnvelope + createInjectionSuspicionSignal 均为纯函数, delegationGateHook 是可选接入点 (LEGACY 时不启用)

## remaining_uncertainty

1. **delegation gate 完整运行时接线**: 当前 delegationGateHook 是可选参数, 主 agent (index.ts) 尚未传入。这意味着生产路径下 delegation gate 实际未启用 (LEGACY 行为)。完整启用需要 Wave D 在 parent-side 集成时构造 DelegationRequest 并传入 hook。这是设计意图 (CRC-5 无 Wave D 直接 D-edge), 不是缺陷。

2. **handoff envelope 运行时接线**: createDelegationHandoffEnvelope 是纯函数, subagent.ts 的 runSubagentContracted 尚未在返回前构造 envelope。这也是设计意图 (parent-side 验证属于 Wave D)。

3. **compaction no-tool 接入**: compactHistoryWithLLM 已天然传 [] (摘要任务不需要工具), 但未显式接入 NoToolRequestContract。这是既有行为, 不需要为 no-tool 特别改动 (规格 §10.4 主要约束 streamingQuery 主路径)。

4. **wave-c-contracts.test.ts 的 3 个 any warning**: 测试封闭 DSL 拒绝未知 kind 时用 `as any` 构造非法输入, 是合理测试用法。可后续用 `as unknown as` 替换, 但不阻塞。

## deferred_hold_check

no Deferred or Hold implementation activated. 本 Wave 未实现:
- Wave D 能力 (M-048/M-008/M-044/M-028/M-064/M-055)
- Prompt 原文适配
- 部署 / 依赖升级 / 数据库迁移
- Git 写操作 (commit/push/PR)

## 关键设计决策记录

### 偏差裁决 (T1-3 子代理报告, 已接受)

| 偏差 | 裁决 | 理由 |
|---|---|---|
| A. PromptResolutionInput 加 conditions + section_scope_inputs | 接受 | 规格 §7.5/§7.6 数据流的逻辑必然载体 |
| B. PromptResolutionPlan 加 included_section_assets | 接受 | Task 3 drift 检测的必要真相来源 |
| C. compileResolvedPrompt deps 加 BRC-1 identity 字段 | 接受 | BRC-1 compilePromptSnapshot 必需输入 |
| D. 手写 requireNonEmpty 而非复用 requireIdentity | 已修复 | 删除本地实现, 统一用 requireIdentity (禁止重复造轮子) |

### T9 no-tool runtime gate 设计

收到 tool_use block 时不立即 throw, 而是产生 protocol rejection 作为 tool_result 写回 provider, 让 provider 在下一轮自我修正。这符合 LLM 对话的 turn-taking 语义, 也满足 "executor 调用次数为 0" 的硬约束。

### T10 delegationGateHook 可选接入

不强制改变现有 spawn-agent-tool 调用方。生产主路径 (index.ts) 传入 hook 时启用 CRC-5 gate; 不传时 LEGACY 行为。这避免了破坏现有测试, 同时为 Wave D parent-side 集成留出干净入口。
