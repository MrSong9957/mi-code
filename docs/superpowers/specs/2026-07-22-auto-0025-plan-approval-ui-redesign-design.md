# AUTO-0025 计划审批界面视觉修订设计

日期：2026-07-22  
状态：设计已批准

## 背景

AUTO-0025 已完成通用 `AskUserQuestion` 问卷和 `exit_plan_mode` 迁移，但真实终端验证发现计划审批仍使用通用问卷外观：显示无意义的 `Plan · Submit` tabs，只展示审批问题和选项，不展示模型刚写入的计划正文，视觉层级也与 Claude Code 的专用计划审批界面差异明显。

Claude Code 源码确认：`ExitPlanMode` 不进入终端备用屏，而是在主屏使用独立权限请求组件展示计划正文和审批选项。它与通用 `AskUserQuestion` 不复用同一个视觉组件。

本设计只修订 `exit_plan_mode` 的展示层。通用问卷协议、manager/store 状态机、outcome、tool result 和普通 `AskUserQuestion` 外观均保持不变。

## 目标

- 在主终端屏幕中同时展示计划正文和审批操作。
- 使用独立 `ExitPlanModeOverlayV2`，不把 plan 特例写进通用问卷组件。
- 复用现有终端 Markdown renderer 展示标题、粗体、列表和代码等内容。
- 使用中文标题、提示和现有三个审批选项。
- 保留 Other、Chat、Esc 和三种批准模式的既有行为。
- 窄终端中折行展示决策内容，不截断正文或选项文案。
- 零新依赖。

## 非目标

- 不进入 alternate screen。
- 本轮不实现 `FullscreenLayout`、sticky footer 或计划正文独立滚动；长计划沿主终端正常滚动。
- 不实现或显示 `Ctrl+G` 外部编辑器入口。
- 不修改公开 JSON schema、manager 结算语义、outcome 或 provider tool-result 协议。
- 不改变普通 `AskUserQuestion` 的 tabs、多题、多选或 Submit 页面。
- 不增加 bypass permissions、Ultraplan 等 mi-code 当前没有的模式。

## 方案选择

采用“内部展示变体”：继续复用现有 `AskUserManager`、`AskQuestionStore`、键盘路由和 outcome，只为内部 normalized request 增加可选 presentation 元数据，并由 `InlineAppV2` 路由到独立视觉组件。

未采用以下方案：

- 独立 `PlanApprovalStore`：会重复实现单选、Other、Esc、Chat 和 callback 生命周期。
- 在 `AskQuestionOverlayV2` 内增加 plan 条件分支：会让通用问卷组件长期携带无关特例。
- 新建共享 presentation store：manager 覆盖旧请求时，presentation 可能与新 request 短暂错配。

## 内部数据契约

公开 JSON schema 仍只包含 `questions`、`question`、`header`、`options` 和 `multiSelect`。presentation 不对模型公开，也不由运行时 validator 接收。

内部 request 可携带：

```ts
interface PlanApprovalPresentation {
  kind: 'plan-approval';
  content: string;
  filePath: string;
}

interface AskQuestionRequest {
  questions: AskQuestion[];
  otherLabel?: string;
  presentation?: PlanApprovalPresentation;
}
```

`AskUserManager` 只透明传输完整 request，不读取或判断 `presentation`。传输不等于消费：manager 的 pending、覆盖、request ID 和 settle 行为完全不变。

presentation 与 request 绑定并存储在 `AskQuestionStore.request` 中。store reset 时整个 request 被清除，因此不会残留上一轮计划内容。

## 数据流

1. `write_plan_file` 将带 frontmatter 的 Markdown 写入 `PlanStore`。
2. `exit_plan_mode` 调用 `planStore.getCurrent()`；不存在计划时沿用当前错误返回，不打开 UI。
3. 展示层从计划快照中剥离文件开头的 frontmatter，磁盘文件不修改。
4. `plan-tools.ts` 构造现有单题单选 request，并附加 `presentation: { kind, content, filePath }`。
5. `AskUserManager` 原样转交 request，`AskQuestionStore` 原样持有。
6. `InlineAppV2` 在问卷可见时检查 `store.request.presentation?.kind`：
   - `plan-approval`：渲染 `ExitPlanModeOverlayV2`；
   - 缺失或未知：安全回退 `AskQuestionOverlayV2`。
7. 专用 overlay 只负责展示；所有按键仍由现有 `useInputHandler` 路由到 `AskQuestionStore`。
8. submit、Other、Chat、Esc 产生既有 outcome；`plan-tools.ts` 继续执行既有模式映射和序列化。

计划内容是打开审批时的快照。本轮没有外部编辑器能力，因此审批期间无需重新读取磁盘。

## Frontmatter 与 Markdown

frontmatter 剥离是纯展示转换：仅匹配文件开头由两行 `---` 包围的完整块，返回其后的正文。正文中后续出现的 `---` 不应被删除。

计划正文复用现有 `renderMarkdown()`，不新增 Markdown 解析器。渲染调用置于错误边界中；解析或渲染失败时记录错误，并在同一位置降级显示剥离 frontmatter 后的纯文本。

若剥离后正文为空，显示“未找到计划正文”，审批操作仍可使用，避免用户卡在无法响应工具调用的状态。

## 视觉布局

```text
╭──────────────────────────────────────────────╮
  准备开始编码？

  以下是 Agent 拟定的计划：
  ┄────────────────────────────────────────────

  # MiCode 项目改造计划

  1. 第一步……
  2. 第二步……

  ┄────────────────────────────────────────────

  Agent 已完成计划，是否继续执行？

  ❯ ☐ 确认执行，清空上下文并使用自动模式
      重置对话（已占用 5%），Agent 自动执行所有修改
    ☐ 确认执行，使用自动模式
      保留当前上下文，Agent 自动执行所有修改
    ☐ 确认执行，手动审核修改
      保留当前上下文，每步修改需你确认
      提出修改意见
    与 Agent 讨论此计划

  ↑↓ 导航 · Enter 选择 · Esc 取消
```

### 容器与颜色

- 外层为主屏 Ink `Box`，`borderStyle="round"`，只显示顶部边框。
- 顶部边框和“准备开始编码？”使用现有 `theme.brand`。
- 计划区域只显示上下虚线分隔，颜色使用 `theme.borderMuted`。
- 当前焦点使用 `❯` 和 `theme.suggestion`。
- 问题提示、选项 description、Other、Chat 和快捷键使用 `theme.textMuted` 降低视觉权重。
- 不新增 `planMode` 主题字段；复用现有语义色，保持深浅主题兼容。

### 内容层级

- 不显示通用问卷的 `○ Plan · Submit` tabs。
- 不重复显示内部 `header: Plan` 或原始 question 文本。
- 三个批准选项显示 `❯` 焦点标记和空方框；不复用多选 `[ ]/[x]` 文案。
- option description 在 label 下一行缩进显示。
- Other 显示为“提出修改意见”；进入输入模式后原位替换为 `提出修改意见：文本▌`。
- Chat 显示为低强调的“与 Agent 讨论此计划”。它保留既有 chat outcome，不与 Other 合并。
- 底部帮助为 `↑↓ 导航 · Enter 选择 · Esc 取消`；Other 输入模式使用对应的保存提示。

### 宽度行为

计划正文、option label 和 description 均按终端显示宽度折行，不做截断。CJK 全角字符按显示宽度计算。缩进后的续行保持与正文对齐，确保窄终端下仍能读到完整决策信息。

## 交互行为

本设计不改变状态机：

- `↑/↓` 或既有等价键在三个批准选项、Other 和 Chat 间移动焦点。
- Enter 选择前三项时立即提交，并由 `plan-tools.ts` 执行既有 `auto+clear`、`auto+keep` 或 `build+keep` 映射。
- Enter 聚焦 Other 时进入原位文本输入；提交非空文本后产生现有 submitted outcome，但不批准计划。
- Enter 聚焦 Chat 时产生现有 chat outcome，不批准计划。
- Esc 从任何状态产生 cancelled outcome，不批准计划。
- 所有终止路径继续 reset store，presentation 随 request 一起清除。

## 错误与降级

- 无计划：返回现有工具错误，不显示审批界面。
- 空计划正文：显示占位文本，保留全部审批操作。
- Markdown 渲染失败：记录错误并降级纯文本。
- presentation 缺失或 kind 未识别：回退通用问卷 overlay。
- manager 新请求覆盖旧请求：沿用单 pending 和 request ID 防线；旧 request 的 presentation 随旧 request reset。
- 窄终端：完整折行，不通过截断隐藏决策内容。

## 测试策略

### 单元测试

- frontmatter 仅从文件开头的完整块剥离。
- 正文中的 `---` 不被误删。
- 无 frontmatter、空正文和 Windows/Unix 换行输入。

### 工具测试

- `exit_plan_mode` 从 `PlanStore` 创建正确的 presentation 快照。
- presentation 包含剥离后的正文和计划路径。
- 公开 JSON schema 不出现 `presentation`。
- 无计划错误路径不打开 UI。

### 组件测试

- 中文标题、顶部圆角边框、虚线、Markdown 正文和主题色。
- 三个审批选项及 description、Other、Chat 和帮助文字。
- 不出现通用 tabs、重复 `Plan` header 或 `[ ]/[x]` 文案。
- 焦点样式和 Other 原位输入。
- Markdown 失败时纯文本降级；空正文显示占位文本。
- 窄终端折行后关键文案仍完整存在。

### 集成与回归测试

- `presentation.kind === 'plan-approval'` 路由到专用 overlay。
- 无 presentation 的普通问卷继续使用 `AskQuestionOverlayV2`。
- 三个批准选项、Other、Chat 和 Esc 的 outcome 与状态副作用不变。
- manager 覆盖旧请求后不显示旧计划。
- `/model`、spinner/footer 恢复、输入草稿保持不变。

### 真实终端验收

- 计划正文与审批选项同时可见，Markdown 层级清晰。
- 主屏 scrollback 行为正常，没有进入备用屏。
- 三个批准路径、Other、Chat 和 Esc 均产生预期结果。
- 窄终端与长计划中信息不被截断。

## 完成标准

- `exit_plan_mode` 使用专用计划审批视觉组件；普通问卷视觉无变化。
- 计划正文从 `PlanStore` 读取、剥离 frontmatter 并用现有 Markdown renderer 展示。
- 公开工具 schema、manager 行为、outcome 和 tool result 零协议变化。
- 聚焦、影响模块、类型检查和既有回归测试通过。
- 真实终端验收通过。
- 零新依赖。
