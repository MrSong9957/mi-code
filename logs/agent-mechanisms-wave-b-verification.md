# Wave B Verification

执行日期: 2026-07-26
分支: `feature/agent-mechanisms-wave-a`(在 Wave A 之上继续)
规格: `docs/superpowers/specs/2026-07-26-agent-primary-anchors-wave-b-design.md`(冻结)
计划: `docs/superpowers/plans/2026-07-26-agent-mechanisms-wave-b-implementation.md`(冻结)

## changed

### 新建模块(14 个,Wave B 公共契约)
- `src/agent/prompt/compiler.ts` — T1 / BRC-1:Prompt 编译(确定性 section 顺序 + aggregate hash)
- `src/agent/tools/capability-snapshot.ts` — T2 / M-058:Provider capability 三态快照
- `src/agent/tools/prompt-metadata.ts` + `src/agent/tools/overlay.ts` — T3 / M-020/M-024:工具元数据 + 只能收窄的 overlay
- `src/agent/context/intake.ts` — T5/T8 / BRC-3:ContextSourceEnvelope + writer 分权 + intake pipeline
- `src/agent/context/intake/environment.ts` — T6 / M-039:环境规范化 + allowlist + formatter
- `src/agent/context/intake/sanitizer.ts` — T7 / M-040:确定性清洗 + 三门 trusted extraction
- `src/agent/context/intake/source-budget.ts` + `provenance.ts` — T8 / M-050/M-011:source budget + provenance
- `src/agent/prompt/profiles.ts` — T9 / M-014/M-035:Agent role/task profile
- `src/agent/tools/transcript-validator.ts` — T10 / M-070:tool transcript pairing validator
- `src/permission/child-environment.ts` — T12 / M-063:子进程环境 scrub
- `src/permission/runtime-gate.ts` — T13 / M-066:persisted blocking ask gate
- `src/agent/observability/envelopes.ts` — T14 / M-051:observability plane envelopes

### 修改现有文件(关键切换点)
- `src/agent/query-engine.ts` — T4:`QueryEngineOptions` 迁移为 discriminated union(toolView 新路径 + legacy 兼容)
- `src/agent/streaming-query.ts` — T4/T11/T13 串行:tool view 接线 + 4 checkpoint + blocking ask
- `src/agent/tool-registry.ts` — T4/T12:materializer + bash spawn env scrub
- `src/agent/streaming-executor.ts` — T13:`executeTool()` 接入 RuntimeSecurityGate(ask 不再放行)
- `src/agent/compression.ts` — T11:`runCompaction` 加 preflight checkpoint hook
- `src/session/store.ts` — T11/T13:`appendValidatedTranscript` + pending-decision sidecar
- `src/agent/roles.ts` — T9:加 `roleToAgentRoleProfile`(保留旧 ROLE_REGISTRY)
- `src/agent/subagent.ts` — T9:`enhanceSubagentSystemPrompt` 消费 NormalizedEnvironmentSnapshot
- `src/background/background-manager.ts` — T12:spawn 传入 sanitized env
- `src/agent/stream-event-bus.ts` — T14:加 observability event channel
- 三家 stream-client — T2:加 `getDefaultCapabilities()`(纯新增方法)
- `src/index.ts` — T13:resume 加载 pending + UserDecisionChannel adapter + 接入 runtimeGate
- `src/agent/index.ts` / `src/permission/index.ts` — T15:导出 Wave B 公共契约

## mechanisms

M-001、M-011、M-014、M-020、M-024、M-035、M-039、M-040、M-042、M-050、M-051、M-058、M-063、M-066、M-070 — 全部映射到 Task 1~14,无遗漏、无重复主责。

## verification_level

**V3**(unit + integration + 主路径切换验证)。每个机制都有失败-原因-正确-通过的 RED→GREEN 证据链。

## red_evidence

每个 Task 在实现前都观察到因正确原因的失败(模块/函数不存在,或现有违规行为暴露):

| Task | RED 失败模式 |
|---|---|
| T1 | `Cannot find module '../../agent/prompt/compiler.js'` |
| T2 | `Cannot find module '../../agent/tools/capability-snapshot.js'` |
| T3 | `Cannot find module '../../agent/tools/overlay.js'` + `'../../agent/tools/prompt-metadata.js'` |
| T4 | `materializeIncludedToolDefinitions is not a function` + QueryEngine NEW 变量 tools=undefined |
| T5 | `Cannot find module '../../agent/context/intake.js'` |
| T6 | `Cannot find module '../../agent/context/intake/environment.js'` |
| T7 | `Cannot find module '../../agent/context/intake/sanitizer.js'` |
| T8 | `Cannot find module '../../agent/context/intake/source-budget.js'` |
| T9 | `Cannot find module '../../agent/prompt/profiles.js'` + `roleToAgentRoleProfile is not a function` |
| T10 | `Cannot find module '../../agent/tools/transcript-validator.js'` |
| T11 | `store.appendValidatedTranscript is not a function` + runCompaction preflight 缺失 + streamingQuery 不在 before_provider_send 抛错 |
| T12 | 真实 spawn 泄漏:`TEST_API_KEY=leaked-secret` 出现在子进程 stdout(RED 阶段实测证据) |
| T13 | `Cannot find module '../../../src/permission/runtime-gate.js'` + 现有 ask-passthrough 测试编码违规行为 |
| T14 | `Cannot find module '../../agent/observability/envelopes.js'` |
| T15 | `compilePromptSnapshot` 为 undefined(公共导出缺失) |

T12 / M-063 和 T13 / M-066 的 RED 是真实运行时违规证据:
- T12:子进程继承完整 parent env,secret 泄漏到 stdout
- T13:streaming-executor/streaming-query 的 ask 决策放行(注释明文 "ask 决策保持旧行为(放行)")

## green_evidence

### Wave B targeted suite(Task 15 Step 5)
```
npx vitest run <15 个 Wave B 测试文件>
→ Test Files 15 passed (15) | Tests 378 passed (378)
```

### 受影响模块回归(Task 15 Step 6)
```
npx vitest run <streaming-query + streaming-executor + compression + session-store + role-agents +
  subagent-result-integrity + permission + plan-mode-streaming + background + regression/>
→ Test Files 20 passed (20) | Tests 287 passed | 2 skipped (289)
```

### Wave B 触及范围完整回归(控制器独立验证)
```
npx vitest run <agent/ + permission/ + session/ + streaming-* + compression + role-agents +
  subagent-* + permission + plan-mode-streaming + background + ask-user + tools + idle-break + regression/>
→ Test Files 60 passed (60) | Tests 983 passed | 4 skipped (987)
```
**关键:Wave B 触及的 60 个文件零失败。**

### 静态检查(Task 15 Step 7)
- `npm run typecheck` → exit 0
- `npm run build`(`gen-prompts.mjs && tsc`)→ exit 0

### Wave Gate 全量测试(Task 15 Step 8)
```
npm test → Test Files 6 failed | 204 passed (210) | Tests 12 failed | 2550 passed | 4 skipped (2566)
```
**12 个失败全部是 pre-existing 的 TUI/高负载 flaky timeout,与 Wave B 无关。** 证据:
- Wave B 触及的 60 个文件零失败(983 测试全绿)
- tui 目录单独跑:770 中 2 failed(高负载 timeout;Wave A 时同目录 5 failed,是已知 flaky)
- cli/commands/render/ui/utils/skills:177 通过,0 失败
- 12 个失败分布在 Wave B 未触及的 tui 文件,全部是 Ink bootstrap/reconciler 的 5000ms 超时
- Wave B 自身的 378 targeted + 983 回归测试 100% 通过,零失败

## invariant_evidence

INV-B1 ~ INV-B13 全部有机器可判定测试,位于 `src/__tests__/agent/wave-b-contracts.test.ts`:

| 不变量 | 测试名 | 判定方式 |
|---|---|---|
| INV-B1 | `INV-B1 snapshots do not absorb mutable state` | 捕获后 push 新 section,snapshot 不变 + frozen |
| INV-B2 | `INV-B2 identities remain in distinct fields` | capability/decision 各 ID 字段独立,不互相替代 |
| INV-B3 | `INV-B3 provider adapters only encode semantics` | model_id 含 'claude' 但 capability 仍为调用方声明的 unknown |
| INV-B4 | `INV-B4 trust never rises from agent text` | tool_result 强制 untrusted,调用方传 trusted 被降级 |
| INV-B5 | `INV-B5 runtime decisions override prompt text` | human_reason 谎称 allow,behavior 仍为 deny |
| INV-B6 | `INV-B6 unknown uses safe defaults` | unknown capability 保持 + production telemetry 硬 drop |
| INV-B7 | `INV-B7 ask blocks before execution` | ask + null channel → denied,executor 调用次数 0 |
| INV-B8 | `INV-B8 pairing precedes lifecycle checkpoints` | unpaired transcript → before_provider_send 返回 rejected/blocked |
| INV-B9 | `INV-B9 source budget overflow is explicit` | 截断 → truncated=true + overflow_ref 非空 |
| INV-B10 | `INV-B10 profile requests but does not grant tools` | profile 是只读消费者,capability frozen 不可改 |
| INV-B11 | `INV-B11 observability plane is not collection permission` | full_dump 即使 policy 启用也 drop,不创建 payload |
| INV-B12 | `INV-B12 protocol versions are orthogonal` | compiler_protocol_version=7 与 security protocol_version=3 独立 |
| INV-B13 | `INV-B13 failures never become successful states` | env required 缺失 → sanitized_environment=null,不伪装成功 |

## activation_evidence

Wave B 的三个关键 activation gate 都有运行时证据:

### blocking ask(M-066 / INV-B7)
- `RuntimeSecurityGate`:ask + channel → 等待 UserDecision;ask + null channel → DeniedAction `'ask.no_channel'`
- **executor 零调用证据**:`runtime-gate.test.ts` 断言 approved_once 到位前 `executor.calls === 0`;`streaming-permission-passthrough.test.ts` 集成测试同样断言底层 `registry.execute` 调用次数为 0
- 旧 `executeTool()`/`checkPermissionOrBlock()` 的 "ask 放行" 行为已切断(NEW 路径);LEGACY 路径(无 runtimeGate)保留向后兼容,生产路径(`index.ts`)始终接入 gate

### four transcript checkpoints(M-070 / INV-B8)
- `before_provider_send`:每次 `engine.submit()` 前校验,blocked/rejected → 抛错,provider 不被调用
- `before_persistence`:`SessionStore.appendValidatedTranscript()` 要求 accepted 才写入
- `before_compaction`:`runCompaction(messages, { preflightValidation })` 要求 accepted
- `before_finalization`:end_turn/idle/max_turns 出口前校验

### child environment scrub(M-063 / INV-B13)
- `decideChildProcessEnvironment`:parent env 不整包传入,只允许 required+optional 集合,secret 模式匹配移除
- `createBashTool()` + `BackgroundManager.run()` 的 spawn 都显式传 `env: sanitizedEnv`
- 真实 spawn 回归测试证明 `TEST_API_KEY=leaked-secret` 不再泄漏到子进程 stdout

## remaining_uncertainty

1. **T4 `tool_view_snapshot_id` 设计决策**:子代理选择"内容派生的确定性 id 覆盖调用方传入 id"(保证确定性,但丢弃调用方 id)。规格未明文要求原样回显,此决策可接受但已记录。
2. **T4 `description_asset_ref: null` 处理**:经用户裁决,`materializeIncludedToolDefinitions` 对 included entry 的 null `description_asset_ref` 不 throw(与 T3 overlay 的 "metadata 缺失 = approved-by-default" 一致)。
3. **T11 error-recovery compaction 路径**:`handleError` 回调里的 `runCompaction` 保持 legacy(无 preflight),因为修改 `recovery.ts` 超出 Task 11 范围。该路径在错误恢复时触发,transcript 应已稳定。
4. **T11 `before_finalization` 跳过 user_abort/error**:设计决策 —— abort/error 时 transcript 可能合法地 mid-execution,强制 finalization 会掩盖原始错误。文档化为 Wave B 简化。
5. **T13 LEGACY ask-passthrough 路径保留**:`StreamingToolExecutor`/`checkPermissionOrBlock` 在无 `runtimeGate` 时保留旧 ask 放行行为(向后兼容)。生产路径(`index.ts`)始终接入 gate。subagent/self-organizing 路径目前未传 gate,后续 Wave 应迁移。
6. **T13 resume pending decisions**:Wave B 最简正确行为 —— `awaiting_user` pendings 在 resume 时记录并丢弃(因为原始 SecurityDecision/action snapshot 未持久化)。重新 ask 需持久化完整 decision+snapshot,留给后续 Wave。
7. **全量测试 12 个 TUI flaky 失败**:pre-existing,非 Wave B 引入(Wave B 触及范围零失败)。修复属于 TUI bootstrap 测试稳定性问题。
8. **T9 `requested_tool_ids` 对 general 角色的表示**:`tools: '*'` 映射为空数组(表示"无特定请求,defer to view"),文档化。

## deferred_hold_check

**no Deferred or Hold implementation activated.** Wave B 严格遵守规格 §3 排除清单:
- 未实现 Prompt precedence/conditions/cache(M-002/M-003/M-004,Wave C)
- 未实现第三方 capability override(M-059,Wave C)
- 未实现 trusted routing / final Placement(M-012,Wave C)
- 未实现 tool-local policy 文本(M-026,Wave C)
- 未实现 no-tools compaction(M-031,Wave C)
- 未实现 delegation handoff classifier(M-067,Wave C)
- 未实现 injection soft signal(M-069,Wave C)
- 未实现 telemetry redaction / PII taxonomy(M-056,Wave C)
- 未实现 decision trace payload schema(M-054,Wave C)
- 未实现 inline env assignment 解析(M-065,Wave E)
- 未实现 lifecycle metadata(M-061,Deferred)
- 未读取或批准 Claude Prompt Library 资产(仅消费 mi-code 自有 role prompts)
- attachment plane 保持 Hold(未实现 M-029/M-041)

## 执行方式

按"每波后验证 + 默认模型"策略,采用 subagent-driven-development 五波次并行:
- **Wave B-1**(5 并行):T1/T2/T5/T10/T14(纯新建模块)
- **Wave B-2**(3 并行):T3/T6/T7(依赖 B-1)
- **Wave B-3**(3 并行):T4/T8/T9(核心切换点,依赖 B-2)
- **Wave B-4**(2 并行):T11/T12(依赖 B-3 的 T4)
- **Wave B-5**(串行):T13(最关键,依赖前面全部)
- **收尾**:T15(控制器自做,全局整合)

每波完成后跑跨模块 typecheck + 该波全部测试,确认绿盘再进下一波。每个子代理独立 TDD(RED→GREEN→自查)。无 git commit/push/PR(遵计划 Global Constraints)。
