# SDD Ledger — Build 模式权限分层(origin + session allowlist)

> 计划:`docs/superpowers/plans/2026-08-01-build-mode-permission-origin-session-allowlist.md`
> 分支:`feat/subagent-journal-final-feedback`
> 起始 HEAD:`e60950d`

## 执行规则
- Task 1→2→3→4→5→6→7 顺序,不并行写代码
- 每个 Task:RED → GREEN → task review → commit
- reviewer 发现问题先验证再修,不盲从
- 生产行为严格 RED 先行

## Task 状态

| Task | 状态 | Commit | Review | 备注 |
|---|---|---|---|---|
| 1 | ✅ 完成 | 2f1f7ff | ✅ 主代理验证 103 passed | checker reason_code + unresolvable_var |
| 2 | ✅ 完成 | df62a40 | ✅ 主代理验证 8 passed | subagent-silent-policy + rewriteToAllow |
| 3 | ✅ 完成 | 901f301 | ✅ 主代理验证 6 passed | session-allowlist exact-match |
| 4 | ✅ 完成 | c1acc9c | ✅ 主代理验证 29 passed | gate non-interfering observer |
| 5 | ✅ 完成 | f6b1df3 | ✅ 主代理验证 24 passed | origin 路由端到端(唯一 gate.execute 入口) |
| 6 | ✅ 完成 | 193352d | ✅ 主代理验证 21 passed | index 装配 + UI + permission-answer-mapping |
| 7 | ✅ 完成 | — | ✅ review 6项全过 | 回归 + 验收(全量4478 passed,3 flaky env 无关) |

## Review 记录

### Task 1 (commit 2f1f7ff)
- mapLegacyReason 直读 legacy.reason_code,无子串匹配(验证 L261)
- unresolvable_var 新码 L151 + META L313
- auto/只读/plan-readonly 保持 permission.default(硬约束遵守)
- 独立回归:103 passed(security-decision-integration 14 + 新 10 + 回归 79)
- 无 BLOCKED

### Task 2 (commit df62a40)
- applySubagentSilentPolicy + rewriteToAllow 都导出(L39/L60)
- rewriteToAllow 唯一归属 subagent-silent-policy.ts(无 decision-rewrite.ts)
- 共享 helper rewriteDecision,provenance fallback 分离语义
- 独立验证:8 passed
- 无 BLOCKED

### Task 3 (commit 901f301)
- sessionAllowlistKey + SessionAllowlist 导出
- NUL 分隔 exact-match,无 snapshot_id 截断
- 独立验证:6 passed
- 无 BLOCKED

### Task 4 (commit c1acc9c)
- execute() 加 options.onAuthorized(L248),try/catch 吞异常(L257-259)
- denied 早返回(L252)绝不触发 observer
- AuthorizedAction.remember 透传(L216 ← UserDecision)
- RED 体现运行时(vitest esbuild 不做编译期检查),typecheck Step7 守护签名
- 独立验证:29 passed(runtime-gate-remember 4 + streaming-passthrough 11 + security-decision-integration 14)
- 九大不变量保持(authorize 控制流未改)
- 无 BLOCKED

### Task 5 (commit f6b1df3)
- 唯一执行入口:registered.executor 仅在 gate.execute 闭包内(L432→L426)
- allowlist hit 用 rewriteToAllow 改写后仍走 gate(S5 executeSpy 锁定)
- 三层正交过滤:behavior=ask ∧ reason_code=user_confirmation_required ∧ origin=main
- onAuthorized 回调写 allowlist(仅 main+remember)
- 子代理用 applySubagentSilentPolicy 改写后仍走 gate
- subagent-permission-passthrough 2 测试更新:旧行为(子代理 ask 阻塞)→ 新行为(子代理 build_write 静默放行)。这是本 Task 要废除的语义,合理更新非妥协。安全拦截(origin-routing S2/S3)保留。
- 独立验证:24 passed(origin-routing 8 + subagent-passthrough 5 + streaming-passthrough 11)
- 无 BLOCKED

### Task 6 (commit 193352d)
- Reject 映射精确:L25/31/42 三处 rejected 兜底,仅 L36/39 匹配常量 approved_once
- ALLOW_ONCE_LABEL/ALLOW_EXACT_LABEL 导出,index.ts L350/351 复用(不再硬编码)
- 三处 sessionAllowlist.clear:L455(rotate)/L619(rewind)/L1049(resume)
- getDecisionChannel L360 用 mapPermissionAnswerToUserDecision 纯函数
- 独立验证:21 passed(answer-mapping 8 + decision-channel-remember 1 + origin-routing 8 + gate-remember 4)
- 无 BLOCKED

### Task 7 (无 commit,验收)
- 权限层全量:387 passed
- 子代理+执行回归:106 passed
- typecheck:exit 0
- 全量:4478 passed,4 skipped,3 failed(child-process-env-scrub flaky,Windows env 隔离预存问题,与权限改动无关——单独跑通过,git diff 不涉及 background/env 文件)
- diff 范围:21 文件全在计划 File Map 内
- 最终 code review:6 项全通过(唯一执行入口/Reject安全/observer non-interfering/reason_code兼容/安全不变量/架构一致),0 阻断 0 注意
- 无 BLOCKED

## BLOCKED / 偏离

无 BLOCKED。一处偏离:Task 5 更新了 subagent-permission-passthrough.test.ts 的 2 个测试(旧行为"子代理 ask 阻塞"→ 新行为"子代理 build_write 静默放行"),这是本计划要废除的语义,主代理 review 确认合理。

## 后续独立阻断(真实 TTY 验收发现,待单独处理)

### 阻断 A — 场景 7:成功 turn 错误携带上一轮 "The user rejected this action."
- 状态:✅ 已修复(commits 9bcf2c0/d14ab79/7acaf30)
- 根因:final-feedback 状态块落盘进 sessionMessages → 下 turn initialMessages 喂模型 → LLM 从历史模仿状态块(含 rejected 文本)
- 修复:TextBlock.uiOnly 标记 + sanitizeMessagesForModel 在 streamingQuery model-context 边界剔除
  - appendFeedback 状态块始终独立 block 且 uiOnly=true(string content 规范化为两 block)
  - sanitizer 删 uiOnly block、空 message 删除、不 mutation、输出无 uiOnly 字段
  - 唯一过滤边界:streamingQuery L444(provider 收 sanitizer 后标准消息)
  - 落盘保留:sessionMessages/jsonl/UI 含 uiOnly 块(完整 transcript);仅 model context 剔除
- 测试:sanitizer 8 + appendFeedback uiOnly 3 + 集成边界 3 = 14 新用例;既有全 GREEN

### 阻断 B — 场景 9:session 切换后 exact write_file 未重新询问
- 状态:✅ 已处理(无生产改动,补回归测试)
- 调查结论:原场景 9 没有实际发生 session 切换(证据:c626788a 内 write_file #3-#7 全在同 sessionId 内,#4/#7 与 #3 完全相同命中 allowlist 是预期行为)。当前无证据证明存在 bug。session remember 语义保持(同 sessionId 跨 turn 有效)。
- 处理:补生命周期契约测试(session-allowlist-lifecycle.test.ts,6 用例,commit e298f09),全 GREEN 确认实现正确
- 覆盖:rotateSessionId(clearContext=true)→ clear;clearContext=false → 保留;clear 后重新 ask(hard rewind/resume 契约);soft interrupt 不 clear;同 session 跨 turn 记住;clear 清空所有 entry

---

## 追加修复:spawn_agent/task build 模式静默 allow

### 背景
真实 TTY 验收发现:子代理内部工具已静默,但主 Agent 调 spawn_agent/task 时仍弹 Permission(因两者在 build 模式落闸门4 默认 ask)。用户验收标准是整个子代理 workflow 后台静默,派代理这一步也必须静默。

### 根因
- 'task' 在 WRITE_TOOLS(types.ts:79)→ plan 模式 deny,build 模式落闸门4 ask
- 'spawn_agent' 不在 WRITE_TOOLS 也不在 READ_ONLY_TOOLS(types.ts:64 注释)→ build 模式落闸门4 默认 ask
- checker.ts L219-224:READ_ONLY_TOOLS 检查后直接 ask,无 delegation 白名单

### 修复 (commit a4a77e9) ✅
- types.ts: 新增 DELEGATION_TOOLS = [spawn_agent, task]
- checker.ts: 闸门4 在 READ_ONLY_TOOLS 前检查 DELEGATION_TOOLS → build 模式 allow
- plan 模式仍按 WRITE_TOOLS 拦截 task(闸门3 先于闸门4)
- TDD: RED(spawn_agent/task 得 ask)→ GREEN(allow);plan task 仍 deny;write_file 仍 ask
- 端到端: main+spawn_agent channel 0 次;main+write_file 仍 ask
- 回归: 497 passed(权限层 + 子代理 + 执行链路);typecheck exit 0
- build-mode-permission.test.ts: spawn_agent 从 writeSamples 移除(语义变更,非妥协)

## BLOCKED / 偏离

(出现时记录)
