# AUTO-0025 AskUserQuestion 多问题交互设计

日期：2026-07-21
状态：设计已批准

## 目标

把现有单题纯文本 `ask_user_question` 升级为 Claude Code 风格的交互式问卷：一次支持 1–4 个问题、单选/多选、自动 Other 自由输入、多题导航、Submit、取消和 Chat about this。

本任务直接迁移内部工具协议，不保留旧 `{ question, header?, options?: string[] }` 兼容层。项目是单仓库单版本，没有外部消费者或灰度窗口，双协议只会制造长期分叉。

## 范围

### 包含

- 1–4 个问题，每题 2–4 个选项。
- option 包含 `label` 与 `description`。
- `multiSelect`，缺省为 `false`。
- `header`，运行时限制不超过 12 个字符。
- 每题自动追加 Other 自由输入。
- 单题单选即时提交。
- 多题 Tab 导航与 Submit 页面。
- 多选、未答提交警告、Esc 取消。
- Chat about this，返回当前答案与未答问题。
- `exit_plan_mode` 迁移到同一问卷协议。

### 排除

- preview 渲染。
- annotations、用户 notes。
- 图片回答。
- Plan Mode 的 Skip interview。
- alt-screen 问卷 UI；生产入口当前固定使用 inline V2。
- Provider 或全局 tool-result 协议变更。
- 新依赖。

`preview`、`annotations` 不出现在对模型公开的 schema 中。mi-code 的 `ToolRegistry` 不做 Zod strict-object 校验，executor 会自然忽略未知字段，因此意外携带这些字段不会导致 tool call reject。未来实现对应能力时再正式加入 schema 与类型。

## 已有系统与复用边界

现有 `AskUserManager` 负责单 pending Promise，现有 `SelectStore` 负责 `/model` 等单层单选。问卷所需的多题、多选、Other、Submit 和 Chat 不应塞进通用 `SelectStore`。

本设计保留：

- `SelectStore`、`SelectOverlayV2` 与 `/model` 行为不变。
- Provider 现有工具 schema 转换与普通字符串 tool result。
- streaming executor 对非只读工具的独占串行化。
- vanilla Zustand store 由 bootstrap 创建、React 组件订阅的现有模式。

## 数据契约

### 模型输入

```ts
interface AskQuestionOption {
  label: string;
  description: string;
}

interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect?: boolean;
}

interface AskUserInput {
  questions: AskQuestion[];
}
```

公开 JSON Schema 只描述上述字段。`multiSelect` 未提供时由 validator 规范化为 `false`。
schema description 引导模型把 label 控制在 1–5 个词，但不做依赖语言分词的运行时拒绝；运行时只要求 label 非空且题内唯一。

### 交互结果

```ts
type AskQuestionOutcome =
  | { kind: 'submitted'; answers: Record<string, string> }
  | { kind: 'cancelled' }
  | { kind: 'chat'; feedback: string };
```

问题原文是 answers 的 key：单选值为 label，多选值为以 `, ` 连接的 label。若用户填写 Other，Other 的非空文本覆盖已选 label 集合；空白 Other 不构成答案。

## 运行时验证

`validateAskUserInput()` 是纯函数和 executor 的输入边界，返回结果对象，不抛异常：

```ts
type ValidationResult =
  | { ok: true; value: AskQuestionRequest }
  | { ok: false; error: string };
```

验证规则：

- questions 数量为 1–4。
- 每题 options 数量为 2–4。
- question、header、label、description 去除首尾空白后非空。
- header 按 Unicode code point 计数，不超过 12 个字符。
- question 在一次调用内唯一。
- option label 在同一题内唯一。
- `multiSelect` 缺省为 false；存在时必须是 boolean。

失败时 executor 直接返回 `Error: <原因>`，不打开问卷 UI。mi-code 当前没有 `isError` tool-result 枚举，也不依赖 throw/catch 传递验证失败。

## 架构与所有权

### `ask-user-types.ts`

集中定义模型输入、规范化 request、question state 与 outcome，避免 Agent 层和 TUI 层重复声明协议。

### `ask-user-validation.ts`

只负责不可信模型输入到规范化 request 的转换，不依赖 UI、manager 或 Provider。

### `AskUserManager`

核心锚点仍为 `ask()`：

- 持有唯一 pending request 与 resolver。
- 调用 UI adapter 打开问卷。
- 等待 `AskQuestionOutcome`。
- 新请求到达时先用 `cancelled` settle 旧 Promise，防止 resolver 泄漏。
- callback 带 request ID；过期 callback 不能完成新请求。

`ask_user_question` 不在 `READ_ONLY_TOOLS`，同一 `StreamingToolExecutor` 内天然独占串行。覆盖逻辑主要防御共享 manager 的跨 executor 竞争，例如主 Agent 与子 Agent 同时提问。

### `AskQuestionStore`

由 `bootstrap` 创建单个 vanilla Zustand 实例，并注入：

- `ConnectedApp` / `useInputHandler`：全局键盘路由。
- `AskQuestionOverlayV2`：渲染订阅。
- `BootstrapHandle`：供 `index.ts` 的 UI adapter 打开问卷。

store 管理：

- visible、request ID。
- 当前题或 Submit 页。
- 焦点位置与 Other 文本输入模式。
- 每题选中的 label、Other 文本和是否已回答。
- open、导航、选择、编辑 Other、submit、cancel、chat、close/reset 动作。

callback 不进入可序列化 Zustand state，使用与现有 `SelectStore` 相同的闭包保存；所有提交、取消、覆盖和关闭路径都必须清空 callback 与本次状态。

### `AskQuestionOverlayV2`

只负责问卷展示。问卷可见时，在 `InlineAppV2` 活动区替换 spinner 与 footer；原 `inputStore` 不清空、不修改，问卷关闭后草稿原样恢复。spinner 状态继续存在但不渲染，恢复后继续正常显示。

### `ask-user-tool.ts`

职责严格限定为：公开 schema → validate → `manager.ask()` → outcome 序列化。它不直接操作 React 或 TUI store。

## 数据流

1. 模型调用 `ask_user_question({ questions })`。
2. executor 用 `validateAskUserInput()` 验证并规范化输入。
3. executor `await askManager.ask(request)`。
4. manager 分配 request ID，必要时取消旧 pending，并通过 UI adapter 打开 store。
5. overlay 订阅 store；键盘事件由 `useInputHandler` 路由到 store。
6. store 产生 submitted、cancelled 或 chat outcome，随后关闭并清空。
7. manager 只接受当前 request ID 的 callback，settle Promise。
8. executor 把 outcome 序列化为字符串。
9. 现有 streaming loop 把字符串生成普通 tool result；Provider、消息类型与 JSONL 格式不变。

## 交互状态机

### 按键优先级

1. `Ctrl+C` 全局退出。
2. 活跃 AskUserQuestion 问卷。
3. 普通 overlay、`/model` 选择器、补全和输入框。

问卷可见时，除 `Ctrl+C` 外的相关键都由问卷消费，不污染普通 `inputStore`。

### 导航

- `↑/↓` 或 `Ctrl+P/Ctrl+N`：移动选项和 footer action 焦点。
- `Tab/→`：下一题；最后进入 Submit 页面。
- `Shift+Tab/←`：上一题。
- `Esc`：从任何问卷状态取消整次提问。

### 单选

- Enter 选择当前项。
- 单题单选立即提交，不显示 Submit 页。
- 多题单选保存后自动进入下一题；最后进入 Submit 页。

### 多选

- Space 或 Enter 切换当前项。
- 不自动前进，由用户 Tab 导航或进入 Submit。
- 最终答案以 `, ` 连接选中 label。

### Other

- 每题始终在模型选项后追加 Other。
- 聚焦 Other 后按 Enter 进入自由输入。
- 字符、Backspace、Delete 编辑；Enter 保存。
- 单题单选的 Other 保存后立即提交，其他情况保存后前进。
- Other 非空文本优先于预设选项；多选已勾选 label 不进入最终答案。

### Chat about this

Chat 位于选项列表后的 footer action，可由上下键聚焦。Enter 产生 chat outcome，包含每个问题及当前答案/未答标记。

### Submit 页面

提供 `Submit answers` 与 `Cancel`。未回答所有问题时显示警告但不阻止提交；未回答问题不进入 answers record。

## 渲染

- 顶部 question tabs：已回答 `✓`、未回答 `○`，末尾为 Submit。
- 当前题显示 header、question、option label 与 description。
- 多选显示 `[ ]/[x]`；单选显示高亮游标。
- Other 输入模式显示可编辑文本。
- 底部显示当前上下文有效的快捷键帮助。
- 窄终端按显示宽度截断 label 与 description，不引入 preview 布局。

## 序列化

### submitted

```text
User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user's answers in mind.
```

### cancelled

```text
User declined to answer questions
```

### chat

逐字保持 Claude Code 的结构：

```text
The user wants to clarify these questions.
This means they may have additional information, context or questions for you.
Take their response into account and then reformulate the questions if appropriate.
Start by asking them what they would like to clarify.

Questions asked:
- "Q1"
  Answer: A1
- "Q2"
  (No answer provided)
```

测试中用一个独立 fixture 常量保存完整预期字符串，不把换行、缩进和标点散落在多个测试函数中，也不从生产 serializer 导入期望值。

## `exit_plan_mode` 必要迁移

`exit_plan_mode` 是旧版 `AskUserManager.ask()` 的另一个调用方。新 overlay 接管键盘后，原 `handleUserSubmit()` 中的 pending question 与 `/approve`、`/reject` 特判不会再执行，必须在本任务内原子迁移。

迁移方案：

- `exit_plan_mode` 使用新问卷协议打开单题单选。
- 选项为 `Approve`（开始实现）与 `Reject`（要求修改），自动 Other 用于具体拒绝原因。
- `createExitPlanModeTool` 注入 `onApprove` 回调。
- Approve 时回调同时：
  - `permissionChecker.setMode('build')`；
  - `configStore.setPermissionMode('build')`；
  - `statusStore.setMode('build')`；
  - 输出批准提示。
- Reject、Other、Esc、Chat 都保持 plan 未批准，并返回对应原因或反馈。
- 删除 `handleUserSubmit()` 中旧 pending answer、`/approve`、`/reject` 特判。

这属于 manager 协议直接迁移，不拆成独立任务，避免仓库出现一段 AskUserQuestion 已升级但 plan approval 已损坏的中间态。

## 错误处理与防御边界

- validator 前置，脏输入不进入 UI。
- manager 单 pending 防止两个问卷同时占有界面。
- request ID 防止过期 callback settle 新请求。
- store 所有终止路径 reset，防止旧答案和 callback 泄漏。
- 同 executor 的独占串行保持不变。
- submitted、cancelled、chat 都是普通字符串 tool result，不扩展全局执行协议。

## 测试策略

### 单元测试

- validator：有效输入、1/4 题边界、2/4 选项边界及全部失败规则。
- store：单选、多选、Other、前后导航、未答提交、Chat、cancel、reset。
- manager：挂起、完成、覆盖旧请求、request ID 拒绝过期 callback。
- serializer：submitted、cancelled、chat 精确字符串。
- 多选 + Other：Other 文本覆盖 label 集合。

### 组件测试

- tabs、header/question、description、多选标记、Other 输入与 Submit 警告。
- 窄终端按显示宽度截断。
- 问卷替换 spinner/footer，关闭后恢复。

### 输入集成测试

- 问卷期间按键不污染 `inputStore`。
- 全部快捷键、单题单选即时提交。
- 原输入草稿在问卷结束后保持不变。

### 工具链集成测试

- 真实 `createAskUserTool → AskUserManager → AskQuestionStore adapter → outcome → tool result`。
- validation 失败不打开 UI。
- Chat fixture 逐字匹配。
- `exit_plan_mode` Approve 后同时断言 permission mode、配置与状态栏切到 build。
- Reject/Other/Esc 不切换 build，plan 状态与反馈正确。

### 回归保护

- `/model` 的 `SelectStore` 与键盘行为不变。
- streaming executor 中连续 AskUserQuestion 不并发执行。
- 现有 plan approval 测试迁移后不死锁。

## 完成标准

- 聚焦测试、影响模块测试、全量测试通过。
- `tsc --noEmit` 与 lint 通过。
- 手动实测单题单选、多题、多选、Other、Chat、Esc 和 plan approval。
- 零新依赖。
- Provider、tool-result 与持久化协议零修改。
