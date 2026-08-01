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

## BLOCKED / 偏离

(出现时记录)
