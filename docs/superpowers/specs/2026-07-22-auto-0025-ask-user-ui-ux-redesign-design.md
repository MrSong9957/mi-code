# AUTO-0025 AskUserQuestion UI/UX 重构设计

日期：2026-07-22
状态：设计已批准，待实施计划

## 1. 背景

AUTO-0025 已完成通用 `ask_user_question` 问卷、`AskUserManager`、`AskQuestionStore`、Inline V2 overlay、Chat、Submit 页和计划审批迁移。真实终端验收显示，当前通用问卷虽然功能可用，但仍有以下用户体验缺口：

- Tab 只是被截断的纯文本，当前题与已回答状态不够醒目。
- 普通选项、焦点、已选择项、description 和帮助文字缺少稳定的视觉层级。
- 焦点首尾循环，与 Claude Code 的边界停止行为不一致。
- Other 使用字符串 `|` 模拟光标；Esc 会直接取消整份问卷，且草稿不能按题可靠恢复。
- Submit 页没有 Claude Code 风格的答案摘要和警告层级。
- 终端高度不足时没有按焦点派生的可见控件窗口。

本设计以 Claude Code 的关键交互和视觉层级为参照，但保留 mi-code 现有主题、Zustand vanilla store、Inline V2 和自研 double-buffer renderer。

本文修订并覆盖 `2026-07-21-auto-0025-ask-user-questionnaire-design.md` 中与通用问卷视觉、焦点、Other 多选答案组合及输入行为相关的章节；公开 schema、manager、outcome 和序列化外壳仍以原设计为准。

## 2. 目标

- 让用户一眼识别当前题、已回答题、当前焦点和已选择内容。
- 对齐 Claude Code 的单选、多选、Other、Chat、Submit 和题间导航语义。
- 保持普通问卷的数据主链路、manager 结算和 tool-result 协议不变。
- 把视觉改造、状态机改造和真实光标改造拆成可独立 TDD、可独立验收的阶段。
- 在 40 列及以上终端提供完整可用体验；更窄终端 fail-soft，不崩溃、不输出超宽行。
- 保持计划审批专用 UI 的视觉和现有交互不变。

## 3. 非目标

- 不修改公开 JSON Schema、Provider、tool-result 或持久化协议。
- 不修改 `AskUserManager` 的单 pending、request ID、覆盖和 settle 语义。
- 不引入完整的 Select/ListItem 设计系统。
- 不实现 preview、annotations、图片答案、外部编辑器或 Skip interview。
- 不把普通问卷和 `ExitPlanModeOverlayV2` 合并为同一个视觉组件。
- 不增加题间网络验证或虚假的 loading 状态。
- 不引入新的 TextInput 依赖。

## 4. 保持不变的数据主链路

```text
ask_user_question
  -> validateAskUserInput
  -> AskUserManager
  -> AskQuestionStore
  -> useInputHandler
  -> AskQuestionOverlayV2
  -> submitted | cancelled | chat
```

多问题的切换完全发生在本地 `AskQuestionStore`。只有整份问卷最终结算后，manager 中等待的工具调用才继续执行。因此题间切换必须同步完成，不显示 loading；最终结算后沿用现有机制恢复 spinner、footer 和原输入草稿。

## 5. 方案选择与阶段边界

### 5.1 未采用方案

只修改 `AskQuestionOverlayV2` 虽然见效快，但会继续把视觉、布局推导和状态翻译堆在同一个组件里，无法可靠修复 Other 和滚动。

重建完整 Select/ListItem 设计系统会为单一消费者提前建立抽象，回归面大，违反 YAGNI。

### 5.2 采用方案：三个可交付阶段

#### Phase 1a：纯视觉层

只改变 React 渲染，不修改 store、键盘路由、outcome 或焦点行为：

- 当前 Tab 使用 `theme.suggestion` 背景和 `theme.selectionFg` 前景。
- Tab 以 `☑/☐` 表示已答/未答。
- 当前焦点使用 `❯` 和 `theme.suggestion`。
- 已选择内容使用 `theme.success`。
- description、分隔线和帮助栏使用 `theme.textMuted`。
- 问题标题粗体。
- Submit 页增加答案摘要和 warning 层级。
- 普通问卷帮助栏明确显示 `Esc: Cancel interview`。

Phase 1a 完成后是可交付中间态。现有状态机和 E2E 行为测试必须保持原断言通过。

#### Phase 1b：状态机与可见窗口

- 焦点边界停止，不再首尾循环。
- Other 草稿与已提交答案分离，并按题保存。
- 普通问卷 Other 编辑中的 Esc 只退出编辑；其他问卷状态下 Esc 取消整份问卷。
- 多选题增加题内 `Next` 或 `Submit` 控件。
- 选项区按终端高度显示派生窗口和 `↑/↓` 提示。
- 增加动态帮助栏、数字快捷键和精确的题间导航。
- 计划审批沿用原有 store 交互策略，避免共享 store 造成回归。

#### Phase 2：Other 原生输入与光标

- 移除 `|` 假光标。
- 使用终端原生光标，支持 IME、CJK、emoji、左右移动、Backspace、Delete 和 bracketed paste。
- 长文本使用单行水平视口，不撑坏问卷布局。
- resize 时重新计算屏幕位置，逻辑光标和草稿不变。

Phase 2 只能在第 11 节 renderer spike 通过或其失败分支完成后启动。

## 6. 组件与职责

### `AskQuestionOverlayV2`

作为普通问卷组合器，只选择并组合当前问题视图或 Submit 视图，不再内联全部 Tab、选项和宽度算法。

### `QuestionNavigationBarV2`

纯展示组件，接收问题状态、当前页和列宽，输出正常或压缩导航栏。它不处理按键。

### `QuestionOptionViewportV2`

纯展示组件，接收已经计算好的可见 control blocks、焦点状态和上下滚动提示。它不持有 scroll offset 或 React local state。

### `ask-question-layout.ts`

纯函数模块，负责：

- CJK/emoji/ANSI 感知的截断和折行。
- 导航栏正常/压缩模式选择。
- control block 的精确行高。
- 可见窗口推导。
- Phase 2 的 Other 单行水平视口推导。

### `AskQuestionStore`

继续作为唯一交互状态源，保存问题页、焦点、选项、Other 草稿、Other 已提交值和 outcome callback。它不知道终端尺寸，也不保存 scroll offset。

### `useInputHandler`

只把按键翻译为 store action。是否提交、前进、退出 Other 或取消问卷由 store 根据当前状态和 interaction policy 决定。

## 7. 导航栏与终端宽度

### 7.1 键盘语义

导航栏中的 `←/→` 是键盘能力的视觉提示，不是鼠标控件：

- 非 Other 输入模式下，左箭头和 Shift+Tab进入上一题。
- 非 Other 输入模式下，右箭头和 Tab 进入下一题或 Submit 页。
- Other 输入模式下，左右箭头只移动文本光标，Tab 被问卷吞掉。
- 上下箭头始终只移动当前页的 control 焦点。

### 7.2 宽度模式

- 正式支持下限为 40 列。
- 导航模式由“内容是否放得下”决定，而不是只看固定阈值。40 列、四题场景会进入压缩模式；80 列、短标题场景通常显示完整 Tab。
- 24–39 列进入紧急紧凑模式，只显示当前题、题号和左右未答聚合状态。
- 小于 24 列时隐藏 description 和非必要帮助文字，只保证问题、当前 control 和关键动作存在；每一行宽度不得超过 `cols`。
- 导航栏永不折成多行。

压缩模式不只保留当前标题。当前题左侧若仍有未答题，显示 `☐`；右侧若仍有未答题，也显示 `☐`。例如当前位于第 2/4 题且两端各有未答题：

```text
← ☐ [☑ 2/4 Runtime] ☐ →
```

若某一侧所有题均已答，该侧显示 `☑`；不存在该侧题目时省略聚合符号。这样即使相邻 Tab 标题被压缩，用户仍能发现远端未答题。

Phase 1a 快照至少包含：

- 80 列、两题、完整 Tab。
- 40 列、四题、内容驱动压缩 Tab。

## 8. 焦点状态机

当前公开协议始终自动提供 Other，因此“不带 Other”不是可达状态，不为该分支增加代码。

### 8.1 普通单选题

```text
option 0 <-> option 1 <-> ... <-> option N <-> Other <-> Chat
```

- 第一个 option 上按上键：停留。
- Chat 上按下键：停留。
- option 上 Enter：单题立即提交；多题保存并前进。
- Other 上 Enter：进入编辑。
- Chat 上 Enter：产生 chat outcome。
- Space：无操作。

### 8.2 普通多选题

```text
option 0 <-> ... <-> option N <-> Other <-> Next/Submit <-> Chat
```

- option 上 Enter 或 Space：切换选中。
- Other 上按上键：回到最后一个 option。
- Other 上 Enter：进入编辑。
- `Next`：完成当前题并进入下一题。
- 最后一题的 `Submit`：完成当前题并进入整份问卷 Submit 页。
- Chat 上 Enter：产生 chat outcome。
- 两端边界停止。

### 8.3 Submit 页

```text
Submit answers <-> Cancel
```

- 上下键在两个 action 之间移动，边界停止。
- Enter 执行当前 action。
- Esc 取消整份问卷。
- Shift+Tab 或左箭头返回最后一题，保留全部答案与草稿。
- Tab 或右箭头位于末端时无操作。
- 帮助栏必须展示返回提示，避免形成隐藏操作。

### 8.4 编码前的硬检查点

Phase 1b 的第一批 RED 测试必须把以下表作为 `it.each` 输入，而不是只在文档中描述：

| profile | page | control | key | expected |
|---|---|---|---|---|
| questionnaire | single | first option | Up | focus unchanged |
| questionnaire | single | Chat | Down | focus unchanged |
| questionnaire | single | Other | Up | last option |
| questionnaire | multi | Other | Down | Next/Submit |
| questionnaire | multi | Next/Submit | Down | Chat |
| questionnaire | submit | Submit answers | Down | Cancel |
| questionnaire | submit | Cancel | Down | focus unchanged |
| questionnaire | submit | any | Left/Shift+Tab | last question |
| plan-approval | question | first control | Up | legacy wrap behavior |

## 9. Esc 与 Other 语义

### 9.1 Esc 行为表

Phase 1b 还必须先建立第二张 `it.each` RED 测试表：

| profile | state | existing answers | Esc result |
|---|---|---|---|
| questionnaire | normal option | none | cancel questionnaire |
| questionnaire | normal option | previous questions answered | cancel questionnaire |
| questionnaire | multi option | selected values | cancel without clearing first |
| questionnaire | Other editing | draft | exit input, preserve draft, no outcome |
| questionnaire | Other focused, not editing | draft | cancel questionnaire |
| questionnaire | Submit page | any | cancel questionnaire |
| plan-approval | Other editing | draft | preserve existing legacy cancel behavior |

多题问卷中一次 Esc 会丢弃本轮尚未提交的全部答案。这是有意对齐 Claude Code 的行为；Phase 1a 起，帮助栏必须使用明确文案 `Esc: Cancel interview`，不能只写含糊的 `Esc cancel`。

### 9.2 草稿与答案分离

store 增加按问题 key 保存的 `otherDrafts`。现有 `others` 只保存已提交的 Other 值：

- 输入字符时更新当前 `otherDraft`；退出或切题时同步到 `otherDrafts[question]`。
- 再次进入 Other 时从 `otherDrafts` 恢复。
- Esc 退出编辑不写入 `others`，因此草稿不算已回答。
- 空白 Other 按 Enter 只退出编辑，不形成答案、不自动前进。

### 9.3 单选 Other

- 非空 Other 提交后清除该题 preset selection，并成为唯一答案。
- 随后选择 preset option 时清除已提交 Other，但保留草稿，便于用户返回修改。
- 单题立即结算；多题保存并进入下一题。

### 9.4 多选 Other

多选 Other 采用附加语义，不再覆盖 preset selections：

- A、B 已选后提交 `custom`，最终答案为 `A, B, custom`。
- 返回 preset 区增删选择不会删除 Other 草稿或已提交 Other。
- 再次进入 Other 可以修改或清空 custom。
- 最终顺序固定为 schema 中已选 option 的原始顺序，Other 位于末尾。
- 按最终显示文本精确去重；若 Other 与某个已选 label 完全相同，只保留 preset label。
- 仍序列化为现有单个字符串，不改变公开协议。

这避免用户在 preset 和 Other 之间往返时丢失已经选择的组合。

## 10. 动态高度与可见窗口

不使用 scroll offset 状态，也不依赖 Ink 不提供的 ResizeObserver/公开 measure callback。

渲染和行数计算共享同一份显式 render model：

1. 用 `string-width` 和项目折行函数预先生成导航、标题、description、Footer 和帮助栏的实际文本行。
2. 这些预生成行就是组件最终渲染的字符串，因此 `chromeRows` 是数组长度的精确加和，不是对 Yoga 自动折行的猜测。
3. `availableRows = max(1, rows - fixedRenderedRows)`。
4. 每个选项生成一个 control block，block height 等于 label 与 description 的预折行行数。
5. 可见窗口纯函数接收 block heights、focused control 和 availableRows：

```ts
interface VisibleWindow {
  start: number;
  end: number;
  showAbove: boolean;
  showBelow: boolean;
}

function computeVisibleWindow(
  blockHeights: readonly number[],
  focusedControl: number,
  availableRows: number,
): VisibleWindow
```

函数选择包含焦点的连续 control 区间，并尽量填满剩余空间。若单个焦点 block 本身超过 availableRows，必须至少保留 label，再截取能放下的 description 行，并显示下方提示；不得把焦点 control 完全裁掉。

`InlineAppV2` 已接收 `rows`，Phase 1b 将其传给普通问卷。resize 触发重新构建 render model；store 中的焦点、答案和草稿不变。

测试覆盖：

- 英文、CJK、emoji description 折行。
- 焦点上移和下移跨越窗口。
- 4 个模型 option（当前 schema 上限）+ Other + Next/Submit。
- 终端 resize 后焦点仍可见。
- 24、40、60、80 列下所有输出行不超宽。

## 11. Phase 2 前双 Renderer Spike

### 11.1 通过标准

对原生 Ink renderer 和自研 double-buffer renderer 分别验证：

- Other 输入 host 的 `internal_cursorTarget` 在首次渲染和重复更新后存在。
- 问题折行、滚动窗口变化和 resize 后，光标 Y 始终等于 Other 输入文本所在行。
- 光标 X 使用 `string-width`，CJK 和 emoji 后不落在字符中间。
- 问卷中多个焦点 `❯` 不会让 renderer 的结构兜底误认目标。
- 退出 Other、切题、关闭问卷后光标隐藏或恢复到主输入框。

任一 renderer 在任一上述场景出现错误 Y、标记丢失、光标残留或错误目标，即判定直接复用失败。

### 11.2 路径 A：直接复用通过

- Other host 使用 `internal_cursorTarget`。
- `useCursor` 提供文本内部 X；普通 Ink 路径使用共享 render model 计算 output-relative Y。
- double-buffer renderer 继续用 Yoga `cursorTargetY` 覆盖 Y。
- Phase 2 只实现水平视口和输入行为，不修改 renderer。

### 11.3 路径 B：marker 或坐标不可靠

不降级为“只支持原生 renderer”，也不保留假光标作为最终实现。采用最小 renderer 接缝：

1. Phase 1b 在 Other 行预留稳定的 cursor anchor Box，但不启用真实光标，因此 Phase 1b 组件结构不需要返工。
2. 修正现有 Ink patch 的 `commitUpdate`，保证 `internal_cursorTarget` 在节点复用和 prop 不变时仍保留。
3. double-buffer renderer 只接受显式 anchor；问卷激活时不使用“最后一个含 `❯` 的行”作为输入目标。
4. 原生 Ink renderer 的 Y 继续来自同一 render model；若 output-relative offset 仍不可靠，则在 `InlineAppV2` 增加一个明确的 active-region row offset prop，不把坐标逻辑塞进 store。
5. 为节点复用、resize、选项窗口滚动和 renderer fallback 添加回归测试后，Phase 2 才能开始。

该路径只影响 cursor anchor、Ink patch 和 renderer 光标桥，不改变 Phase 1b 的问卷状态机、协议或布局模型。

### 11.4 启动硬检查点

Phase 2 启动前，实施记录必须明确写出 spike 采用路径 A 或路径 B，并附两种 renderer 的测试证据；不得留下未决分支。

## 12. 计划审批隔离与回归

`presentation.kind === 'plan-approval'` 继续路由到 `ExitPlanModeOverlayV2`。普通问卷的新视觉组件不在计划审批中渲染。

由于两者共享 `AskQuestionStore`，Phase 1b 的 store action 必须通过当前 request 派生 interaction policy：

- `questionnaire` 使用新的边界停止和 Other Esc 语义。
- `plan-approval` 保持现有焦点循环、Esc 和 outcome 行为。

每阶段必须验证：

- 三个批准选项及各自模式切换。
- Other 修改意见。
- Chat。
- Esc。
- Plan Markdown、边框、颜色和窄终端折行。
- presentation 专用路由。
- spinner/footer 和输入草稿恢复。
- 通用问卷的 Tab、摘要和帮助栏不出现在计划审批组件中。

## 13. TDD 与验收顺序

### Phase 1a

1. 为 40/80 列终端帧写失败的视觉断言。
2. 最小拆出导航栏和视觉组件。
3. 验证现有 store、输入和 E2E 行为测试不变。
4. 真实终端检查 dark/light 主题。

### Phase 1b

1. 先添加第 8.4 和第 9.1 节的 `it.each` 失败测试表。
2. 添加 Other 单选/多选答案组合测试。
3. 添加纯 `computeVisibleWindow` 测试。
4. 最小修改 store 和 input handler。
5. 添加 24/40/60/80 列、折行和 resize 组件测试。
6. 跑普通问卷 E2E 和计划审批完整回归。
7. 执行双 renderer spike，记录路径 A/B 结果。

### Phase 2

1. 根据 spike 已确定的路径写光标失败测试。
2. 实现原生光标和水平视口。
3. 验证字符输入、左右移动、Backspace、Delete、CJK、emoji 和 paste。
4. 验证关闭、切题、resize 和 renderer fallback 后无光标残留。
5. 跑普通问卷、计划审批、主输入框和 renderer 回归。

每个阶段完成前运行聚焦测试、影响模块测试、类型检查和 lint；最终再运行全量测试。真实终端验收是完成条件，不能只依赖快照。

## 14. 完成标准

- Phase 1a、1b、2 均形成独立验证证据，任何阶段失败不掩盖前一阶段结果。
- 普通问卷在 40 列及以上具有清晰的 Tab、标题、焦点、选择、Footer 和帮助层级。
- 单选、多选、Other、Chat、Submit 和 Esc 行为符合本文状态表。
- 多选 Other 与 preset selections 可组合且顺序稳定。
- 选项窗口始终包含焦点，CJK/emoji 折行与实际渲染一致。
- Other 使用真实终端光标，两个 renderer 均通过定位与清理测试。
- 计划审批视觉、交互和 outcome 无回归。
- 工具 schema、manager、provider、tool-result 和持久化协议零变化。
- 无新增运行时依赖。
- 聚焦测试、影响模块测试、全量测试、typecheck、lint 和真实终端验收通过。
