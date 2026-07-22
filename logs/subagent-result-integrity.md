# Subagent Result Integrity

## 根因

explore 子代理可能返回未经工具验证的虚构正文（如"我看到 src 有 X, Y, Z"但实际没读文件）。
主 agent 无法区分真实结果和模型幻觉。

## RED/GREEN 证据

### Task 1: 拒绝无工具证据的 explore 事实输出

- RED: `result.status === undefined`（SubagentResult 没有 status 字段）
- GREEN: explore 零工具证据返回 `status: 'unverified'`，正文被替换为明确提示
- GREEN: explore 有工具证据正常返回 `status: 'completed'`

### Task 2: 把 max-turn 退出标记为不完整

- RED: `result.status === 'completed'`（没有监听 `loop_end`，无法区分 `end_turn` 与 `max_turns`）
- GREEN: max_turns 时返回 `status: 'incomplete'`，文本前缀 `[Subagent incomplete: reached max turns]`
- GREEN: 通过 StreamEventBus 捕获真实终止原因

### Task 3: 子代理不能调用用户交互工具

- RED: `plan`/`general`/`fork` 角色仍暴露 `ask_user_question`/`exit_plan_mode`/`spawn_agent`
- GREEN: `SUBAGENT_DISALLOWED_TOOLS` 扩展为 6 个工具，`filterToolsByRole` 对所有角色（含 undefined）统一应用黑名单
- GREEN: plan 子代理使用专用 prompt（`cannot interact`），不再引用主 agent 的 plannerPrompt
- GREEN: childToolRegistry 不再注册 exit_plan_mode 和 ask_user_question executor

### 受影响测试

- `subagent-result-integrity.test.ts`: 3 tests PASS
- `role-agents.test.ts`: 29 tests PASS
- `ask-user.test.ts`: 8 tests PASS
- `plan-mode-filter.test.ts`: 14 tests PASS
- `plan-mode-streaming.test.ts`: 4 tests PASS
- `streaming-query.test.ts`: 7 tests PASS
- `regression/subagent-permission-passthrough.test.ts`: 5 tests PASS
- `task-tool.test.ts`: 1 PASS, 2 pre-existing failures (clientProvider is not a function)
