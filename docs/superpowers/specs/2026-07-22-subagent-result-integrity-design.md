# 子代理结果完整性与交互边界设计

日期：2026-07-22
状态：基于用户给出的 5 场景测试结论，供修复计划使用

## 问题边界

本设计只处理三个已观察到的失败模式：

1. 子代理达到轮次上限后，把最后一句过程性文本当成完整结果返回。
2. explore 子代理没有成功读取真实数据，却返回未经验证的项目结构。
3. 子代理调用需要用户输入的工具，导致内部任务等待主 UI 的用户回答。

不在本轮处理：对子代理所有自然语言事实做语义级真实性验证、自动重试、动态扩容轮次、修改主 agent 的正常 AskUserQuestion/ExitPlanMode 流程。

## 现状与复用

目标基线是现有 worktree `codex/auto-0025`（HEAD `bd2488d`）。该分支已经包含：

- `9fae925`：explore 最大轮次提高为 25，只保留最后一轮 assistant 文本，并禁止过程叙述。
- `329c68c` / `911570c`：角色配置与全局子代理工具过滤。
- `66e546f`：子代理复用 `streamingQuery`，工具结果会在下一轮前写回消息历史。
- `c6549ac`：子代理环境和技能描述注入。

这些能力应直接复用，不重新实现。仍缺少的是：真实终止原因没有进入 `SubagentResult`；工具调用是否成功没有成为结果可信度门槛；plan 子代理仍能调用共享 UI 的交互工具。

## 方案比较

### 方案 A：只改提示词和提高轮次

改动最小，但轮次上限仍可能耗尽，模型也仍可能忽略“必须用工具”的文字约束。只能降低概率，不能把错误结果与完成结果区分开。

### 方案 B：结果契约 + 运行时证据门槛 + 工具隔离（推荐）

在 `runSubagentWithClient` 内复用 `StreamEventBus` 收集 `loop_end` 与 `tool_result`，生成结构化执行结果。达到 `max_turns` 时返回 `incomplete`；explore 没有成功的证据型工具结果时返回 `unverified` 并丢弃原始事实正文。子代理工具集统一移除所有会等待用户的工具。

这能直接覆盖三个已观察问题，修改集中在现有边界内，也不需要解析自然语言或改动主循环协议。

### 方案 C：校验输出中每个路径和数据

理论上更强，但需要解析任意自然语言、命令输出和行号引用，误报率高，容易演变成第二套事实验证系统。本轮不采用。

## 推荐架构

### 1. 执行结果契约

`runSubagentWithClient` 不再只返回字符串，而是返回：最终文本、终止原因、工具调用数、成功证据结果数。`SubagentResult` 对主调用方暴露 `status` 和统计信息：

- `completed`：以 `end_turn` 正常结束；explore 至少有一个成功证据结果。
- `incomplete`：以 `max_turns`、`user_abort` 或错误终止；返回文本带明确前缀。
- `unverified`：explore 正常产出文本但没有成功证据结果；不返回模型声称的项目事实。
- `background`：仅表示后台任务已启动。

### 2. 证据门槛

仅对 `explore` 强制证据门槛，避免 general 的纯推理任务被误判。证据型工具限于能读取真实状态的工具，例如 `read_file`、`run_bash`、`memory_read`、`memory_list`、`read_plan_file`。`load_skill` 不算项目事实证据。以 `[Tool Error]`、`Error:`、`[Blocked` 开头的结果不计成功。

这个门槛保证“零成功工具调用却报告目录结构”的结果不会被当作成功；它不宣称能消除已经读取部分数据后仍发生的所有模型幻觉。

### 3. 无用户交互边界

所有子代理都不能直接控制主 UI：

- `SUBAGENT_DISALLOWED_TOOLS` 加入 `ask_user_question`、`exit_plan_mode`、`enter_plan_mode`。
- plan 角色白名单只保留读取工具和 `read_plan_file` / `write_plan_file`。
- `childToolRegistry` 不再注册 AskUserQuestion 和 ExitPlanMode。
- plan 子代理使用独立的简短 system prompt：有歧义时把问题写进最终摘要，写完计划后把路径和摘要返回主 agent，由主 agent 决定是否询问用户或提交审批。

过滤层和注册层同时收紧，避免 general/fork 的 `*` 工具集或未来白名单漂移重新暴露交互工具。

## 验证策略

- 单元/集成测试使用脚本化 `StreamingLLMClient`，真实走 `streamingQuery` 和工具回注链路。
- 首先观察三类测试失败，再逐项最小实现：零工具事实输出、max-turn 中间文本、子代理交互工具可见性。
- 最后运行子代理、角色过滤、AskUserQuestion、streamingQuery、权限透传相关测试，以及 `typecheck`、`lint`、完整 `npm test`。

## 成功标准

- 达到轮次上限的结果包含稳定的“不完整”标记，主 agent 不会把它当完整答案。
- explore 没有成功读取真实数据时返回 `unverified`，原始虚构正文不向上传递。
- 任意子代理角色和 fork 模式都看不到 AskUserQuestion/ExitPlanMode；遇到能力边界时以最终文本返回主 agent。
- 场景 1 和场景 5 的正常同步/并行结果整合行为不回归。
