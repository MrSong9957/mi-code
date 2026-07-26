# Wave D Verification

> 验证时间: 2026-07-27
> 分支: feature/agent-mechanisms-wave-a (Wave A + B + C + D 全部未提交, 待 review)
> 规格: docs/superpowers/specs/2026-07-26-agent-integrated-capabilities-wave-d-design.md
> 计划: docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-d-implementation.md

## changed (新增/修改文件)

### Wave D-1 (6 并行子代理, 文件零冲突)

**DRC-1 Mode Profile (T1, M-048)**
- src/agent/prompt/profiles.ts (追加 selectModeProfile + 类型, 254-547 行)
- src/__tests__/agent/mode-profile-selection.test.ts (16 tests)

**DRC-2 Project Instruction (T3, M-008)**
- src/agent/context/activation.ts (新建, 254 行)
- src/__tests__/agent/project-instruction-activation.test.ts (25 tests)

**DRC-2 Memory Admission (T5, M-044)**
- src/memory/admission.ts (新建 decideMemoryAdmission, 350 行)
- src/__tests__/memory/memory-admission.test.ts (38 tests)

**DRC-3 Tool Reference Manifest (T8, M-028)**
- src/agent/tools/reference-validator.ts (新建 buildToolReferenceManifest, 280 行)
- src/__tests__/agent/tool-reference-manifest.test.ts (17 tests)

**DRC-4 Component Telemetry (T10, M-055)**
- src/agent/observability/telemetry.ts (新建 measureTelemetryComponent, 291 行)
- src/__tests__/agent/component-telemetry.test.ts (27 tests)

**DRC-5 Command Structural Parse (T12, M-064)**
- src/permission/command-policy.ts (新建 parseCommandStructure, 758 行)
- src/__tests__/permission/fixtures/command-structural-corpus.ts (fixture)
- src/__tests__/permission/command-structural-parse.test.ts (42 tests)

### Wave D-2 (5 并行子代理, 依赖 D-1)

**DRC-1 Profiled Compiler (T2)**
- src/agent/prompt/profiles.ts (追加 compileProfiledPrompt, 559-743 行)
- src/__tests__/agent/profiled-prompt-compilation.test.ts (14 tests)

**DRC-2 Meta Context Request (T4)**
- src/agent/context/activation.ts (追加 attachMetaContext)
- src/agent/contracts/request-snapshot.ts (评估后未改, 现有 meta_context 字段已满足)
- src/agent/anthropic-stream-client.ts (追加 encodeMetaContextAsMessages)
- src/agent/openai-stream-client.ts (追加 encodeMetaContextAsMessages)
- src/agent/google-stream-client.ts (追加 encodeMetaContextAsMessages)
- src/__tests__/agent/meta-context-request.test.ts (7 tests)
- src/__tests__/agent/provider-meta-context-conformance.test.ts (16 tests)

**DRC-2 Memory Use (T6)**
- src/memory/admission.ts (追加 decideMemoryUse, 353-549 行)
- src/__tests__/memory/memory-use-decision.test.ts (16 tests)

**DRC-4 Telemetry Batch (T11)**
- src/agent/observability/telemetry.ts (追加 buildComponentTelemetryBatch)
- src/agent/observability/envelopes.ts (仅注释追加, 零行为变更)
- src/agent/stream-event-bus.ts (追加 telemetry hook, 不改现有签名)
- src/__tests__/agent/component-telemetry-batch.test.ts (25 tests)

**DRC-5 Shadow Comparison (T13)**
- src/permission/command-policy.ts (追加 compareCommandPolicyShadow, 760+ 行)
- src/__tests__/permission/command-policy-shadow.test.ts (24 tests)

### Wave D-3 (T7 串行)

**DRC-2 Trusted Context Anchor (T7)**
- src/agent/context/activation.ts (追加 activateTrustedContext, 372→572 行)
- src/__tests__/agent/trusted-context-activation.test.ts (22 tests)

### Wave D-4 (T9+T14 子代理 + 主代理接入)

**DRC-3 Reference Validator (T9)**
- src/agent/tools/reference-validator.ts (追加 validateToolReferences, 282-571 行)
- src/__tests__/agent/tool-reference-validation.test.ts (24 tests)
- src/__tests__/agent/request-reference-gate.test.ts (7 tests)

**DRC-5 Enforced Composition (T14)**
- src/permission/command-policy.ts (追加 composeCommandStructuralDecision + assertActivationGate)
- src/__tests__/permission/command-policy-enforced.test.ts (25 tests)
- src/__tests__/permission/command-policy-cutover.test.ts (16 tests)

**主代理接入 (D-4b)**
- src/agent/streaming-query.ts (加 referenceValidationHook 可选参数, before_provider_send 后 gate)
- src/permission/checker.ts (加 commandPolicyHook 可选参数, run_bash 闸门 0)

### Wave D-5 (公共出口 + INV 验收)

**公共导出 (3 个 index.ts)**
- src/agent/index.ts (DRC-1~DRC-4 公共导出)
- src/memory/index.ts (decideMemoryAdmission/decideMemoryUse)
- src/permission/index.ts (DRC-5 command policy 全部)

**INV-D1~D18 验收**
- src/__tests__/agent/wave-d-contracts.test.ts (19 tests 覆盖 18 条不变量)

## mechanisms

M-008, M-028, M-044, M-048, M-055, M-064 (6 个机制, 5 个 DRC, 全覆盖)

## verification_level

V3 (targeted + regression + typecheck + lint + build + full test)

## red_evidence

每个 Task 严格按 TDD。代表性 RED:
- mode-profile-selection: "selectModeProfile is not a function" 16/16 failed
- tool-reference-validation: "validateToolReferences is not a function" 24/24 failed
- command-policy-enforced: "composeCommandStructuralDecision is not a function" 25/25 failed

## green_evidence

### Targeted suite (15 文件 / 341 用例全绿)
```
npx vitest run <Wave D 15 个测试文件>
→ Test Files 15 passed (15), Tests 341 passed (341)
```

### typecheck
```
npm run typecheck → tsc --noEmit (零输出零错误)
```

### lint (Wave D 源文件零 error)
```
npm run lint → Wave D 源文件零 error
(剩余 error 全部是 pre-existing TUI/UI 文件)
```

### build
```
npm run build → generated: planner.generated.ts + tsc 成功
(build 副产物 planner.generated.ts LF→CRLF 已还原)
```

### full test
```
npm test → Test Files 241 passed | 3 failed (244), Tests 3233 passed | 5 failed | 4 skipped (3242)
```

**5 个 failed 全部是 pre-existing**(Wave C 已确认, git stash 验证):
- src/__tests__/task-tool.test.ts (2): clientProvider is not a function — master 上也失败
- src/tui/inline/thinking-gap-regression.test.ts (1): TUI 渲染 flaky
- src/__tests__/tui/layout.test.tsx (2): StatusBar 进度条渲染

**Wave D 改动触及范围: 0 个失败**。

## invariant_evidence

INV-D1 through INV-D18 全部有机器可判定测试 (src/__tests__/agent/wave-d-contracts.test.ts, 19 tests):

- INV-D1 Snapshot 一致: reference validation 绑定一致 snapshot (1 test)
- INV-D2 Profile 不删除 Mandatory: mandatory 缺失 invalid (1 test)
- INV-D3 Mode 是结构化状态: 空 control_mode_snapshot_id throw (1 test)
- INV-D4 Placement 不等于 Authority: meta 不提升为 system (1 test)
- INV-D5 Project Instruction 与 Auto Memory 分权: channel 分发验证 (1 test)
- INV-D6 Admission 与 Use 分离: use 绑定当前 context (1 test)
- INV-D7 Confidence 不等于事实: confidence=1 仍需 evidence (1 test)
- INV-D8 Meta 不等于 Retained: retention_state=unassigned (1 test)
- INV-D9 Reference 校验最终视图: excluded tool → orphan (1 test)
- INV-D10 Name 不等于 Manual: manifest 无 manual_complete 字段 (1 test)
- INV-D11 Telemetry 只观察: 无 permission/execution/outcome (1 test)
- INV-D12 Measurement 来源显式: estimator vs provider 分离 (1 test)
- INV-D13 先最小化和清洗: batch drop 空 redaction (1 test)
- INV-D14 Shadow 无执行权: 无 effective_security_decision_ref (1 test)
- INV-D15 AST AND composition: 任一 deny → deny (1 test)
- INV-D16 Failures never upgrade: plan mode parse failure → deny (1 test)
- INV-D17 Protocol versions orthogonal: 各 DRC 独立常量 (1 test)
- INV-D18 No frozen dependency edge: DRC-1/DRC-3 无 Wave E hook (2 tests)

## activation_state

DRC-5 shadow by default; enforced only when every gate passes:
- composeCommandStructuralDecision 在 mode='shadow' 时 candidate_behavior=null, effective_security_decision_ref=null
- mode='enforced' 需 assertActivationGate 9 项全通过
- checker.ts 的 commandPolicyHook 是可选参数, 不传时 LEGACY(4 步管道不变)
- 生产路径(index.ts)尚未传入 hook, DRC-5 实际未启用(LEGACY), 待 Wave E 或运维显式 activation

## no_direct_wave_e_edge

- DRC-1 (mode profile): selectModeProfile / compileProfiledPrompt 是纯函数, 无 Wave E hook (INV-D18 测试验证)
- DRC-3 (tool reference): buildToolReferenceManifest / validateToolReferences 是纯函数, 无 Wave E hook (INV-D18 测试验证)

## remaining_uncertainty

1. **DRC-5 完整运行时接线**: commandPolicyHook 是可选参数, 主 agent (index.ts) 尚未传入。生产路径下 DRC-5 实际未启用 (LEGACY)。完整启用需要 DRC-5 Activation Gate 通过 + index.ts 构造 CommandPolicyState 并传入 hook。这是设计意图 (enforced 只在受信配置激活后启用), 不是缺陷。

2. **DRC-3 pre-send gate 接线**: referenceValidationHook 是可选参数, 主 agent 尚未传入。生产路径下 reference validation 未启用。完整启用需要 index.ts 构造 ToolReferenceManifest + final tool view 并传入 hook。

3. **request-snapshot.ts 未修改**: T4 子代理评估后认为现有 meta_context 必填字段已满足需求, 降级为可选反而降低安全性。这是合理工程判断, 不影响功能。

4. **三家 stream-client 的 meta 编码**: 通过 encodeMetaContextAsMessages 导出 helper 实现, stream() 签名零改动。Provider SDK 不支持独立 meta metadata 时, meta 通过前置 user 消息表达(语义保留)。真实 Provider 接入由 Wave E 处理。

## deferred_hold_check

no Deferred or Hold implementation activated. 本 Wave 未实现:
- Wave E 能力 (M-038/M-045/M-046/M-052/M-065)
- Prompt 原文适配
- 部署 / 依赖升级 / 数据库迁移 / Prompt Library 激活
- Git 写操作 (commit/push/PR)

## 关键设计决策记录

### D-4b 主代理接入策略

T9 和 T14 都需要接入共享文件(streaming-query.ts / checker.ts)。采用**可选 hook 模式**:
- streaming-query.ts 加 `referenceValidationHook?: () => { status, diagnostics, validation_id }`
- checker.ts 加 `commandPolicyHook?: (command, controlMode) => 'allow'|'ask'|'deny'|null`

不传时 LEGACY 行为(向后兼容), 生产路径由 Wave E 或运维显式 activation 后传入。这与 Wave C T10 的 delegationGateHook 模式一致。

### T12 shell-quote sentinel resolver

shell-quote 1.9 默认会执行 expansion(违反规格 §11.7 rule 3)。T12 子代理用 sentinel resolver `(key) => ({__var: key})` 规避:利用 parse.js 的 object 透传语义,把变量名包成对象回填,parser 据此识别"这是 expansion/substitution"而不解析真实值。同库同版本,无新依赖。

### T4 request-snapshot 评估

T4 子代理评估后认为现有 SemanticRequestSnapshot.meta_context(必填)已满足需求,降级为可选反而降低安全性(TS strict 下漏传成为静默错误)。attachMetaContext 接收 `Omit<BuildSemanticRequestSnapshotInput, 'meta_context'>`,由 activations 派生 meta_context。

### INV-D13 测试修正

初版 INV-D13 测试用 measureTelemetryComponent 构造空 redaction_result_ref 的 event,但 measureTelemetryComponent 会直接 drop 这种 event(不进入 events 数组),导致 batch 认为"无失败 event"→ready。修正:直接构造 ComponentTelemetryEvent 对象(绕过 measure),测试 batch 对空 redaction 的 drop 行为。
