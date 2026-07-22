# 子代理启动可见性与计划隔离设计

日期：2026-07-22  
状态：基于场景 1 实测与当前源码调查，供修复实施使用

## 问题边界

本设计处理两个相互独立、但在同一用户流程中暴露的问题：

1. `spawn_agent` 已开始执行时，消息区没有立即出现调用状态，用户无法区分“尚未启动”和“正在运行”。
2. 用户在 `ask_user_question` 中选择“没有其他任务”后，系统仍展示与当前输入无关的旧计划审批。

不在本轮处理：降低模型供应商的真实首 token 延迟、调整子代理执行质量策略、重做整个计划文件持久化格式。

## 调查结论

### 1. 当前主要是显示延迟，而非已证实的启动延迟

`src/index.ts` 在收到工具调用事件时已经把 `tool_call` 交给 `BlockPipeline`，说明执行开始边界在结果返回前存在。`BlockPipeline` 收到 `tool_call` 后却只把调用文本放进 `toolBuffer`；只有收到匹配的 `tool_result` 后，才把调用和结果一起写入消息区。

因此，用户看到 `spawn_agent` 的时间约等于“子代理完整执行时间”，而不是“子代理启动时间”。现有代码没有独立的启动耗时指标，不能据此断言模型客户端本身启动慢。

缓冲的原意是保持并行工具的调用顺序和调用—结果配对，修复不能简单改成“先打印调用、结果到达时再任意追加”，否则并行结果乱序时会破坏现有显示语义。

### 2. 无关计划由两个缺陷叠加产生

`planner.md` 当前要求计划模式中的每一轮必须以 `ask_user_question` 或 `exit_plan_mode` 结束。即使当前请求只是“列出技能”，模型也会受到继续询问或提交计划的压力；“没有其他任务”返回后，它仍可能继续调用 `exit_plan_mode`。

与此同时，`PlanStore.getCurrent()` 在内存中没有当前路径时，会扫描整个计划目录并恢复修改时间最新的计划，不校验 session、用户轮次或 pending 状态。`exit_plan_mode` 只检查 `getCurrent()` 是否非空。因此，当前轮没有创建计划时，也能把别的会话或旧任务留下的最新文件送入审批。

`AskUserManager` 能正确返回用户选择，不是这次旧计划泄漏的根因。子代理工具隔离也不是根因：实测中的询问来自主 agent。

## 方案比较

### 方案 A：只修改提示词

增加“用户说没有其他任务就结束”的约束，改动最小，但模型仍可能误调用 `exit_plan_mode`，旧计划仍然可以穿过工具边界。只能降低概率，不能保证隔离。

### 方案 B：立即显示待定工具消息 + 本轮计划能力边界（推荐）

工具调用到达时立即创建一条由 `toolUseId` 标识的待定消息；结果到达时原地补全同一条消息。这样既立即反馈“已启动”，又保留并行调用的稳定顺序。

计划侧把“历史计划恢复”和“当前轮可提交计划”分开：每个用户轮次建立独立上下文，`write_plan_file` 只激活本轮写入的计划，`exit_plan_mode` 只读取同一 session、同一 turn 的 active plan。提示词再负责避免无意义的收尾询问。

这是最小的可靠闭环：UI 层修复可见性，工具层建立硬边界，提示词层改善正常控制流。

### 方案 C：让 `exit_plan_mode` 接收计划文件路径或 plan token

隔离最强，但会扩大工具 schema，让模型负责转抄标识，并影响现有调用协议。本轮可以用内部 turn context 达到同等安全目标，不采用该复杂度。

## 推荐设计

### 1. 待定工具消息原地完成

在 TUI message/store/renderer 边界增加最小能力：

- `tool_call`：按 `toolUseId` 立即追加待定工具消息，内容至少包含 `● spawn_agent(...)`。
- `tool_result`：查找同一 `toolUseId` 的待定消息，原地替换为调用加结果的完整内容，并标记 finalized。
- 并行调用：消息位置由调用到达顺序决定；结果倒序到达时只更新对应位置，不移动消息。
- 无 `toolUseId` 的旧调用：保留当前 FIFO 兼容路径。
- 流程结束仍无结果：把待定项作为孤儿调用安全落盘，不能永久处于 streaming 状态。

`MessagesStore` 应提供按工具 ID 更新的窄接口，不把通用消息数组暴露给 `BlockPipeline`。现有折叠结果、hook 与块间空行规则继续复用。

`ToolCallEvent.startTime` 已提供真实调用开始时间。测试以“单独发出 `tool_call` 后消息立即存在”区分显示延迟；若后续还要量化供应商启动耗时，可用该时间与首个子代理事件/结果时间做诊断，不把诊断日志作为本轮 UI 修复的前置条件。

### 2. 当前轮计划上下文

引入 `PlanContext { sessionId, turnId }`。主循环在每次新用户提交开始时创建新的 `turnId` 并调用 `planStore.beginTurn(context)`。

- `write(context, content)`：计划 frontmatter 记录 session、turn、status，并把它登记为本轮 active plan。
- `getActive(context)`：只返回 session、turn 均匹配且状态为 pending 的 active plan；绝不扫描目录回退。
- `recoverLatestForSession(sessionId)`：保留显式恢复能力，只扫描同一 session；恢复结果不自动成为任意新轮次可提交的计划。
- `exit_plan_mode`：只调用 `getActive(currentContext)`；不存在时返回明确错误，且不得打开审批 UI。
- 审批完成：沿用现有状态更新，但清除 active 能力，避免重复提交。

只增加 `clearCurrent()` 不够，因为当前 `getCurrent()` 会再次扫描全局目录；必须拆开“active”与“archive/recovery”两个 API。

### 3. 主 agent 计划模式控制流

修改 `planner.md`：

- 信息查询、解释或无需改动的请求可以直接回答并 `end_turn`。
- 只有阻塞当前规划的歧义才调用 `ask_user_question`；任务完成后禁止用它询问“是否还有其他任务”。
- 只有本轮 `write_plan_file` 成功后才能调用 `exit_plan_mode`。
- 用户明确表示没有其他任务时，直接结束当前轮。

提示词是行为引导，PlanStore/工具校验是安全边界，两者缺一不可。

## 数据流

### 子代理可见性

`tool_call event` → 创建待定消息并立即渲染 → 子代理执行 → `tool_result event` → 按 `toolUseId` 原地补全 → finalized

### 计划审批

`new user turn` → `beginTurn(sessionId, turnId)` → 可选 `write_plan_file(context)` → `getActive(context)` → `exit_plan_mode` 审批

若本轮未写计划，链路在 `getActive` 处终止，历史文件只存在于归档/显式恢复路径。

## 验证策略

- UI 单元/集成测试：只发 `tool_call` 就可见；结果倒序返回仍保持调用顺序；孤儿调用能收尾。
- PlanStore 单元测试：旧轮次、其他 session、已审批计划均不能成为当前 active plan；显式同 session 恢复仍可用。
- 工具集成测试：本轮未写计划时 `exit_plan_mode` 不打开 UI；本轮写入后才允许审批。
- 提示词测试：不存在“每轮必须 Ask/Exit”的无条件规则，包含信息请求可直接结束与 Ask 使用边界。
- 最终执行当前模块测试、类型检查、lint 和完整 `npm test`，再手工复测用户给出的流程。

## 成功标准

- `spawn_agent` 调用事件到达后立即出现在消息区，不再等待子代理完成。
- 用户可从待定状态确认工具已启动；并行工具的显示顺序与配对不回归。
- 当前轮没有成功写入计划时，`exit_plan_mode` 无法打开任何历史计划。
- 其他 session、上一用户轮次及非 pending 计划均不能被当前轮提交。
- 用户选择“没有其他任务”后正常结束，不出现无关计划文档。

