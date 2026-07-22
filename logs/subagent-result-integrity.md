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

### 受影响测试

- `subagent-result-integrity.test.ts`: 3 tests PASS
- `role-agents.test.ts`: 25 tests PASS
- `streaming-query.test.ts`: 7 tests PASS
- `regression/subagent-permission-passthrough.test.ts`: 5 tests PASS
- `task-tool.test.ts`: 1 PASS, 2 pre-existing failures (clientProvider is not a function)
