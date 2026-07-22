# Subagent Result Integrity

## 根因

explore 子代理可能返回未经工具验证的虚构正文（如"我看到 src 有 X, Y, Z"但实际没读文件）。
主 agent 无法区分真实结果和模型幻觉。

## RED/GREEN 证据

### Task 1: 拒绝无工具证据的 explore 事实输出

- RED: `result.status === undefined`（SubagentResult 没有 status 字段）
- GREEN: explore 零工具证据返回 `status: 'unverified'`，正文被替换为明确提示
- GREEN: explore 有工具证据正常返回 `status: 'completed'`

### 受影响测试

- `subagent-result-integrity.test.ts`: 2 tests PASS
- `role-agents.test.ts`: 25 tests PASS
- `regression/subagent-permission-passthrough.test.ts`: 5 tests PASS
- `task-tool.test.ts`: 1 PASS, 2 pre-existing failures (clientProvider is not a function)
