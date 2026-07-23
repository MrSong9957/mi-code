# AUTO-0025 AskUserQuestion UI/UX 重构设计

日期：2026-07-22
状态：设计已批准，待实施计划
增量补丁：2026-07-24 新增 Phase 1a 细节修正与 Phase B 数据闭环（见第 15 节）；原设计已批准状态不变，补丁为增量扩展，不推翻既有章节

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

## 15. 增量补丁（2026-07-24）

> **补丁性质**：本次为增量扩展，不推翻第 1–14 节的已批准设计。
> 原设计的 Phase 1a/1b/2 计划保持有效；本节新增 Phase B 作为第四条独立交付链路，并对 Phase 1a 补充两项容器与符号细节。
> 后续 Agent 执行时，Phase 1a/1b/2 遵照原文，Phase B 遵照本节。

### 15.0 补丁动机

原设计第 3 节「非目标」明确「不修改公开 JSON Schema、Provider、tool-result 或持久化协议」，因此原设计的 tool_result 渲染走 Bash 风格折叠（`rawOutput` 摘要 + `+N 行 ctrl+o to expand`）。

实际验收确认：`ask_user_question` 的回答字符串在历史回看时被折叠，用户需要展开才能看到自己选了什么，体验不佳。本次补丁在不破坏「协议零变化」前提下，通过 UI 通道旁路携带结构化 outcome，让固化结果结构化渲染。同时补齐原设计 Phase 1a 未明确的容器边框与单选/多选符号区分。

### 15.1 Phase 1a 细节修正（容器与符号）

#### 新增决策 A1：圆角边框容器

原设计 Phase 1a 只规定颜色层级，未规定容器边框。补充：

通用问卷 `AskQuestionOverlayV2` 采用与 `ExitPlanModeOverlayV2` 相同的容器模式：

```tsx
<Box flexDirection="column"
     borderStyle="round"
     borderColor={theme.suggestion}
     paddingX={1}>
```

- **变更原因**：mi-code 的通用问卷是独占活动区的 overlay（替换 spinner+footer），与 `ExitPlanModeOverlayV2` 同语义，而非 Claude Code 那种嵌入消息流的 inline 组件。CC 的「不加边框」结论基于 inline 语义，不适用于 overlay 语义。圆角边框让两个 overlay 视觉统一。
- **色槽选择**：`theme.suggestion`（靛蓝），与计划审批的 `theme.planMode`（暗青）区分用途。不新增 theme 槽。
- **宽度计算**：`contentWidth = Math.max(1, cols - 4)`（减左右边框各 1 + paddingX 各 1），与 `ExitPlanModeOverlayV2:82` 一致。
- **影响范围**：仅 `AskQuestionOverlayV2` 渲染层；不改 store、input handler。
- **验收标准**：24/40/80 列下 overlay 带圆角边框且不超宽；与计划审批 overlay 视觉风格统一。边框 + tabs + 符号最容易在 24 列崩溃（边框占 2 列 + padding 2 列 + 符号前缀），必须覆盖 24 列快照验证不超宽。

#### 新增决策 A2：单选/多选符号区分

原设计 Phase 1a 用 `theme.success` 高亮选中项，但未区分单选/多选符号。补充：

```ts
// 单选（multiSelect === false）：radio 符号
const checkSymbol = selected.includes(option.label) ? '◉' : '◯';

// 多选（multiSelect === true）：保留复选框
const checkSymbol = selected.includes(option.label) ? '[x]' : '[ ]';
```

- **变更原因**：当前单选多选都用 `[x]`/`[ ]`，用户无法一眼判断能选几个。
- **影响范围**：仅 `AskQuestionOverlayV2` 渲染层。
- **验收标准**：单选题显示 `◉/◯`，多选题显示 `[x]/[ ]`；聚焦项前缀 `❯`（原设计 Phase 1a 第 5.2 节已规定用 `❯`，此处强调 AskQuestionOverlayV2 需对齐，不再用 `>`）。

#### 新增决策 A3：tabs 布局纯函数 computeTabLayout

原设计第 7 节已系统设计导航栏宽度模式。本补丁明确把布局推导抽为可独立 TDD 的纯函数 `computeTabLayout`，归入原设计第 6 节规划的 `ask-question-layout.ts` 模块（原设计已命名该模块为布局纯函数的家）：

- **核心算法**：Submit 固定预留可见；按权重分配剩余宽度（当前 tab weight=2，其他 tab weight=1，避免当前页固定霸占 50% 导致其他标题被挤压不可读）；每个 tab 最少 6 字符保底，超出加 `…`；极窄降级只显示当前 tab 前 3 字符。
- **权重分配理由**：固定 50% 上限在"当前页长标题 + 其他多个重要标题"场景下会过度挤压其他 tab。weight 比例分配（当前 2 : 其他 1）既突出当前页，又保证其他 tab 有稳定可读预算。
- **变更原因**：原设计第 7 节描述了宽度模式，但未指定实现入口；`computeTabLayout` 作为纯函数是天然 TDD 锚点。
- **影响范围**：`AskQuestionOverlayV2` 内 tabs 行渲染。
- **验收标准**：`computeTabLayout` 单测覆盖 1/4 question × 24/40/80 列 × 各 pageIndex 组合，输出行不超宽。

#### 新增决策 A4：Other/Chat 文案

- Other：走 `request.otherLabel`（数据驱动，默认 `"其他"`，禁止空白）。
- Chat：固定中文 `"与 Agent 讨论此问题"`（系统行为入口）。
- **影响范围**：`AskQuestionOverlayV2` 渲染层。
- **验收标准**：Other 空白时回退 `"其他"`；文案不是核心验收项。

### 15.2 新增 Phase B：固化结果结构化（meta 旁路）

原设计排除 tool-result 协议变化。Phase B 在不破坏该约束的前提下，通过 **UI 通道旁路** 携带结构化 outcome，让固化结果结构化渲染。

#### 目标产出

```text
当前：                              目标（Phase B）：
⎿ User has answered your questions  ⎿ Answered 2 questions
  "Q1"="A","Q2"="B". You can...       Q1 → A
  +2 行 (ctrl+o to expand)            Q2 → [B, C]

                                    cancelled: ⎿ Declined to answer
                                    chat:      ⎿ Feedback: ...
```

#### 架构基础：API/UI 双通道隔离

```
executor(input) ──返回 string──┬── API 通道: ToolResultBlock.content (发给 Anthropic)
                                │   convertMessages 白名单构造，零污染
                                └── UI 通道: StreamMessage.output + structuredOutcome
                                    (不发给 API)
```

事实核查结论（代码证据）：API 通道与 UI 通道在 `streaming-query.ts:313-345` 物理分离，是两个独立对象，`structuredOutcome` 字段不进入 `ToolResultBlock.content`，因此不会进入发给 Anthropic 的 API content。

但本次改造触及 API 请求生成链路附近的代码（`ToolExecutor` ctx 扩展、`registry.execute` 签名、`streaming-query` 调用点），存在调用顺序/await 时序/error handling 变化的潜在风险。**不宣称"100% 不影响 API"**，而是通过 Phase B 验收里的「API diff 验证」确保请求语义不变（见 15.2 Phase B 验收）。

#### 数据流全景图（供实施参照）

```
Anthropic 返回 tool_use (含 tool_use_id)
    │
    ▼
streaming-query 阶段1: 收到 tool_use → streamingExecutor.addTool
    │
    ▼
StreamingToolExecutor.executeTool (streaming-executor.ts:132)
    │  registry.execute(name, input, { toolUseId: tool.block.id })   ← 点2/点3
    ▼
registry.execute (tool-registry.ts:41)
    │  tool.executor(input, ctx)                                     ← 点1
    ▼
ask-user-tool executor
    │  outcome = await mgr.ask(input)
    │  askOutcomeStore.set(ctx.toolUseId, { version:1, outcome })    ← 点4/点5
    │  return serialize(outcome)            // string，不变
    ▼
registry.execute 返回 string
    │
    ▼
streaming-query 阶段3 (streaming-query.ts:313-345)
    │  structuredResult = askOutcomeStore.take(id)   // 一次性消费 ← 点6
    │  ├─ API 分叉: ToolResultBlock.content = output (string)  // 不变
    │  └─ UI 分叉:  emitToolResult / yield { ..., structuredOutcome }
    ▼
index.ts onToolResult handler
    │  pipeline.emit({ kind:'tool_result', ..., structuredOutcome })
    ▼
block-pipeline.ts:245 case 'tool_result'
    │  if (name==='ask_user_question' && structuredOutcome)          ← 点7
    │      buildAskUserPresentation(structuredOutcome)
    │  else 原逻辑
    ▼
MessageFormatter 渲染: ⎿ Answered N questions (折叠) / Q→A (展开)
```

#### 改造链路（7 个点）

**点 1：ToolExecutor 类型扩展（types.ts）**

```ts
export interface ToolExecutionContext {
  toolUseId: string;
  // 未来扩展（当前不实现，仅预留）：
  // signal?: AbortSignal;   // 用户取消 / turn 中断 / timeout
}

export type ToolExecutor = (
  input: Record<string, unknown>,
  ctx?: ToolExecutionContext,   // 可选，旧 executor 零改动
) => Promise<string>;
```

- 返回类型仍是 `Promise<string>`，不违反原约束。
- **`ToolExecutionContext` 是通用执行上下文扩展点，不是 ask_user_question 专用 hack**。当前仅含 `toolUseId`（Phase B 唯一需要），但设计为开放接口：未来可扩展 `signal`（取消信号）、`traceId`（链路追踪）、`agentId`（多 agent 标识）等字段。命名保持 `ToolExecutionContext`（非 `AskUserContext`），所有工具的 executor 均可消费。Phase B 只是第一个使用者。

**点 2：registry.execute 透传 ctx（tool-registry.ts:41）**

```ts
async execute(name: string, input: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<string> {
  ...
  return await tool.executor(input, ctx);
}
```

**点 3：4 个调用点补 ctx 实参（均有现成 toolUseId）**

| 文件 | 行号 | 实参 |
|------|------|------|
| `streaming-executor.ts` | 132 | `{ toolUseId: tool.block.id }` |
| `streaming-query.ts` | 364 | `{ toolUseId: block.id }` |
| `loop.ts` | 265 | `{ toolUseId: call.id }`（legacy 并行） |
| `loop.ts` | 293 | `{ toolUseId: call.id }`（legacy 串行） |

事实核查：4 个调用点上下文均已持有 toolUseId。

**点 4：ask-user-tool executor 写入 outcomeStore**

```ts
executor: async (input, ctx) => {
  const validated = validateAskUserInput(input);
  if (!validated.ok) return `Error: ${validated.error}`;
  const outcome = await mgr.ask(validated.value);
  if (ctx) {
    askOutcomeStore.set(ctx.toolUseId, {
      version: 1,
      request: validated.value,   // 含 questions（header/options/multiSelect）
      outcome,
    });
  } else {
    // 开发错误检测：调用点忘记传 ctx 时发出警告，避免静默退回 rawOutput
    // 不改类型、不抛错，仅 debug 级别日志（当前 4 个调用点已核实都传 ctx）
    debug.warn('ask_user_question executed without toolUseId ctx');
  }
  return serializeAskQuestionOutcome(outcome);                            // 返回类型不变：string
},
```

**点 5：askOutcomeStore（新建 `src/agent/ask-outcome-store.ts`）**

store value 带 `createdAt`，支持 TTL 兜底；清理有三级防线：

```ts
interface StoredOutcome {
  result: StructuredAskResult;   // 含 version + outcome
  createdAt: number;
}
const TTL_MS = 5 * 60 * 1000;  // 5 min 兜底上限
const store = new Map<string, StoredOutcome>();

export const askOutcomeStore = {
  set: (id: string, r: StructuredAskResult) => store.set(id, { result: r, createdAt: Date.now() }),
  take: (id: string): StructuredAskResult | undefined => {
    const s = store.get(id); store.delete(id); return s?.result;  // 一次性消费
  },
  sweep: () => {
    const now = Date.now();
    for (const [id, s] of store) if (now - s.createdAt > TTL_MS) store.delete(id);
  },
  clear: () => store.clear(),
};
```

**orphan 清理三级防线（均有确定落点，非模糊"挂接 hook"）**：

| 防线 | 机制 | 落点 | 覆盖场景 |
|------|------|------|----------|
| 1. 正常消费 | `take()` 后立即 `delete` | 点 6 streaming-query 调用 take | 正常 flow，无残留 |
| 2. turn 结束 sweep | `sweep()` 删超 TTL 的 entry | `streaming-query.ts:460-463` 现有 `finally` 块，紧挨 `onMessages` 调用 | generator normal return / consumer break / throw 三路径(JS generator 语义保证 finally 全执行) |
| 3. TTL 兜底 | `clear()` 全清 / 或按 TTL 增量清 | 新 agent turn 开始前 + `sweep` 增量清 | 极端情况(进程长跑、多 turn 残留累积) |

- **防线 2 的可靠性依据**（代码事实核查）：`streamingQuery` 是 `async function*`，其顶层 try/finally（`streaming-query.ts:156` try / `:460-463` finally）受 JS generator 语义保护。三个消费方（`index.ts:722` 主 agent、`subagent.ts:176` 子代理、`self-organizing.ts:160` 自组织）即使 break 或 throw，generator 的 finally 必然执行。`self-organizing.ts:160` 无消费方 try/finally，正是把 sweep 放在 generator 自身 finally 而非消费方的决定性理由。
- **store 注入方式**：仿 `onMessages` 模式，通过 `StreamingQueryOptions`（`streaming-query.ts:63-105`）注入 store 引用，finally 里调用 `askOutcomeStore.sweep()`。
- **legacy 路径**：`loop.ts` 的 `agentLoop` 无 finally，需在调用 `agentLoop` 的上层 await 处包 try/finally 调用 `sweep`；或在 `agentLoop` 函数体加顶层 try/finally。两条路径无法用同一钩子统一，实施时分别处理。
- **executor 抛异常**：若 `mgr.ask()` resolve 后 serialize 抛异常，entry 已 set。在 executor 外层（registry.execute 的 try/catch，`tool-registry.ts:48-51`）补一次 `askOutcomeStore.take(id)` 兜底删除（此时 take 出的 outcome 丢弃即可，因为 output 已是错误字符串）。
- **长期运行 CLI 不得出现内存泄漏**：三级防线联合保证。

**点 6：streaming-query 阶段 3 取出并挂载（两个分支都改）**

```ts
const output = await registry.execute(name, input, { toolUseId: id });
const structuredResult = askOutcomeStore.take(id);  // 一次性消费，含 version + outcome
emitToolResult({ ..., structuredOutcome: structuredResult });
yield { ..., structuredOutcome: structuredResult };
```

**点 7：block-pipeline 结构化渲染分支**

`case 'tool_result'`（block-pipeline.ts:245）里，仿 `spawn_agent` 先例（同文件 277 行）加特判：

```ts
if (item.name === 'ask_user_question' && item.structuredOutcome) {
  try {
    return buildAskUserPresentation(item.structuredOutcome);  // 内部检查 version
  } catch {
    // 降级：structuredOutcome 异常时回退原 rawOutput 路径
  }
}
// 原逻辑兜底
return buildToolResultBlock(item.name, input, item.output);
```

新建 `src/ui/ask-user-presentation.ts`（仿 `subagent-presentation.ts`）。

#### buildAskUserPresentation 展示形态

```text
折叠：⎿ Answered N questions       （N = Object.keys(answers).length）
展开：⎿ Q1 → A
        Q2 → [B, C]
```

- summary 走中文（项目无 i18n 体系，与 ExitPlanMode 硬编码中文一致）。
- N 按实际回答数（`Object.keys(answers).length`），不按 option 数量。
- cancelled → `⎿ Declined to answer`；chat → `⎿ Feedback: ${feedback}`。

#### UI 通道类型扩展（3 处）

```ts
// stream-event-bus.ts ToolResultEvent
structuredOutcome?: StructuredAskResult;
// streaming-query.ts StreamMessage tool_result 分支
structuredOutcome?: StructuredAskResult;
// ui/types.ts Block tool_result 分支
structuredOutcome?: StructuredAskResult;
```

**版本化与 fallback（硬约束）**：

`structuredOutcome` 不是裸 `AskQuestionOutcome`，而是带版本号的包装，renderer 不识别版本时回退 `rawOutput`：

```ts
interface StructuredAskResult {
  version: 1;          // 结构化结果版本，当前固定 1
  request: AskQuestionRequest;   // 含 questions（header/options/multiSelect），供展示配对
  outcome: AskQuestionOutcome;   // submitted/cancelled/chat
}
```

- **为什么含 request**：`AskQuestionOutcome.answers` 的 key 是 question 全文（长），而 UI 展示想用 `header`（短）。若只存 outcome，presentation 函数只能显示长问题文本。含 request 让 `buildAskUserPresentation` 能做 `request.questions[i].header` ↔ `outcome.answers[question]` 配对。
- **存的是展示所需字段**：request 保存 `AskQuestionRequest`（含 questions 的 header/options/multiSelect），不是原始 input。未来 schema 变化时 UI 不重新解析。
- **变更原因**：未来 `AskQuestionOutcome` schema 变化（如 v2）时，renderer 能按版本降级，不靠 try/catch 兜底逻辑错误。
- **fallback 规则**：`buildAskUserPresentation` 检查 `version`，非支持的版本（或字段缺失/损坏）时回退原 `rawOutput` Bash 风格折叠，与 Rollback 条件（15.2 Phase B Rollback）共用降级路径。
- **version 由谁写入**：executor 在 `askOutcomeStore.set` 时包装为 `{ version: 1, outcome }`；`streaming-query` take 后原样透传。
- **不是 feature flag**：当前不引入 `enableStructuredAskResult` 运行时开关（YAGNI）；版本号是 schema 演进的防御性设计，不是动态启停机制。
- **失败行为（避免静默失败）**：version 不支持 / 字段缺失 / 渲染抛错时：
  1. 记录 debug log（含 toolUseId、实际 version、错误原因），便于排查；
  2. 回退 `rawOutput` Bash 风格折叠；
  3. **不中断 tool_result pipeline**，不抛错到上层。
  即用户最坏看到旧版折叠形态，不会看到崩溃或空白。
- **catch 实现规范**：禁止裸 `catch {}`（吞掉程序 bug）。降级 catch 必须区分：
  - **可降级**（version 不支持、字段缺失）：log + fallback，正常路径。
  - **程序 bug**（TypeError、未预期异常）：log（含完整 stack）+ fallback，但 debug log 级别提升为 error，确保不静默隐藏代码缺陷。
  - 实现示例：`catch (err) { logError('ask_user presentation failed', { toolUseId, err }); return fallback; }`，而非 `catch {}`。

#### Phase B 硬约束（写入验收）

| 约束 | 说明 |
|------|------|
| ✅ API content 零污染 | `structuredOutcome` 不进 `ToolResultBlock.content`；convertMessages 白名单构造。但改造触及 API 生成链路附近代码，通过 API diff 验证确保语义不变，不宣称"100%" |
| ✅ 返回类型不变 | `ToolExecutor` 仍 `Promise<string>` |
| ✅ 旧 executor 零改动 | `ctx` 可选 |
| ✅ 一次性消费无残留 | `take` 后立即 delete |
| ✅ orphan 清理 | 三级防线：take 删 + finally sweep + TTL 兜底 |
| ✅ ctx 是通用扩展点 | `ToolExecutionContext` 非 ask 专用，未来可扩 signal/traceId |
| ✅ 版本化 + fallback | `structuredOutcome` 带 `version`，renderer 不识别时回退 `rawOutput` |
| ❌ 禁止改 ToolExecutor 返回类型 | |
| ❌ 禁止 block-format 解析自然语言字符串 | |
| ❌ 禁止把结构化字段塞进 API content | |

#### toolUseId 唯一性约束（硬要求）

`askOutcomeStore` 用 `toolUseId` 做 key，前提是它在 store 生命周期内唯一。

- **单 agent turn 内唯一**：当前依赖 Anthropic 返回的 `ToolUseBlock.id` 在单 turn 内唯一（streaming 路径 `tool.block.id` 与 legacy 路径 `loop.ts:252` 的 `b.id` 同源）。工程设计不依赖外部系统"永久保证"，但当前事实如此。
- **跨 turn 不保证**：store 是短生命周期（take 即删 + TTL 5min 兜底），不依赖跨 turn 唯一性。
- **硬约束**：store 的 key 语义是"单 turn 内唯一"，不是全局唯一。实现和测试均以此为前提。

#### Phase B 关键测试（数据一致性）

Phase B 唯一真正的数据一致性风险是 Map key 隔离。必须覆盖：

```text
并发隔离测试：
  set(idA, outcomeA)
  set(idB, outcomeB)
  take(idA) => outcomeA    // 不被 B 污染
  take(idB) => outcomeB    // 不被 A 污染
  take(idA) => undefined   // 已消费
```

- 虽然当前 `ask_user_question` 是非并发工具（executor 串行），但 store 本身是通用 Map，未来若子代理解禁 ask 或并发场景出现，key 隔离必须成立。
- 此测试是 store 单测的必选项，不是可选。

#### Phase B 单测顺序（按数据流方向，定位更快）

```
1. askOutcomeStore 单测          — set/take/sweep/clear + 并发隔离 + TTL
2. registry.execute ctx 透传测试 — 验证 ctx 从 registry 传到 executor
3. executor 写入测试             — ask-user-tool executor set { version, outcome }
4. streaming-query 集成测试       — take + 挂载 structuredOutcome 到 UI 通道
5. block-pipeline 渲染测试       — buildAskUserPresentation 折叠/展开 + fallback
6. API diff                      — 对比改造前后发给 Anthropic 的 tool_result content
```

- 按数据流方向（store → registry → executor → streaming-query → pipeline → API）逐层测试，任一层失败能快速定位。
- 每层 RED → GREEN，不跳层。

#### Phase B 实施顺序

在 Phase 1a 完成后（用户痛点先解决），再启动 Phase B：

```
Phase 1a（交互期 UI）
  ↓ 交付价值：交互期体验达标
Phase B（固化结果结构化）
  ↓ 交付价值：历史回看结构化
```

理由（用户确认）：
- 用户主要痛点是交互期 UI。
- Phase B 改数据链路（4 文件透传），风险面大于 Phase 1a（纯渲染）。
- Phase B 即使失败，也不影响核心问答流程。

#### Phase B 验收

- 主路径（streaming-query 流式分支）：TTY 验证 + 集成测试。
- legacy 路径（loop.ts）：编译通过 + 单测覆盖，不要求 TTY 验证。
- API 请求不变：对比改造前后发给 Anthropic 的 tool_result content。
- orphan 清理：长跑测试或单测验证无残留 entry。

#### Phase B Rollback 条件（失败降级，不回滚 UI）

Phase B 与 Phase 1a 已正确隔离（见 15.3），因此 Phase B 出问题时**只关闭结构化渲染分支，不回滚交互期 UI**。

触发 Rollback 的条件（任一命中即降级）：

| 条件 | 检测方式 | 降级动作 |
|------|----------|----------|
| API 请求 content 变化 | 改造前后 diff 发给 Anthropic 的 tool_result content | 立即修复 executor 返回，API 不变是硬底线 |
| streaming-query 回归 | 流式分支集成测试失败 | 关闭 `structuredOutcome` 字段透传 |
| tool_result 丢失/渲染异常 | `buildAskUserPresentation` 抛错或产出空 | 回退到原 `rawOutput` Bash 风格折叠 |

**降级实现机制**：在 `block-pipeline.ts` 的 `ask_user_question` 特判分支外加防御：

```ts
if (item.name === 'ask_user_question' && item.structuredOutcome) {
  try {
    return buildAskUserPresentation(item.structuredOutcome);
  } catch {
    // 降级：structuredOutcome 异常时回退原 rawOutput 路径
  }
}
// 原逻辑兜底
return buildToolResultBlock(item.name, input, item.output);
```

- **不回滚 Phase 1a**：Phase B 的失败只影响固化结果展示形态，交互期 overlay（边框、符号、tabs）不受影响。
- **Rollback 是运行时降级，不是代码回滚**：特判分支始终保留 try/catch，保证任何异常都不阻塞主流程。

### 15.3 Phase B 与原设计的边界

| 原 Phase 1a/1b/2 | Phase B |
|------------------|---------|
| 交互期 UI（overlay 渲染、状态机、光标） | 固化后结果（tool_result 渲染） |
| 不碰数据链路 | 改数据链路（UI 通道透传） |
| 在 `AskQuestionOverlayV2` 内 | 跨 `ask-user-tool` → `streaming-query` → `block-pipeline` |

两者**完全解耦**：Phase B 的 `structuredOutcome` 只在 `tool_result` 渲染时读取，与 overlay 内的交互状态机无交集。可独立开发、独立验收。

### 15.4 关于原设计 Phase 1b / Phase 2 的实施拆分提醒

> **本节不修改原设计内容，仅为实施阶段的任务拆分提供警示，文档命名保持原样。**

原设计的 Phase 划分在**设计层面**是清晰的，但在**实施工作量**层面，Phase 1b 实际包含多个独立子系统（状态机改造、Other 草稿分离、visible window、多选 Next、Esc policy），已接近"第二个大功能"的体量。

**实施建议（不改文档命名，改任务拆分）**：

- writing-plans 阶段把 Phase 1b 拆成独立子任务，每个子系统单独 TDD + 验收，**不要作为一个大 PR**。
- 建议拆分粒度（每个独立成 PR，互不阻塞）：
  - **1b-1 焦点边界**：首尾停止替代循环（状态机问题，参考第 8 节表）
  - **1b-3 visible window**：可见控件窗口推导（布局算法问题，参考第 10 节，`computeVisibleWindow` 纯函数可独立 TDD）
  - **1b-2 Other 草稿模型**：草稿与已提交答案分离，按题恢复（状态机问题，参考第 9 节）
  - **1b-4 多选 submit flow**：多选 Next/Submit 控件与 Esc policy（交互流问题，参考第 8.2、9.1 节）。**TTY 验收重点**：多选题 control 顺序是 options → Other → Next/Submit → Chat，需真实验证"最后一题按 ↓ 是否自然到达 Chat"，避免用户误以为 Chat 是全局退出入口。
- **实施顺序调整（审查建议）**：`1b-1 → 1b-3 → 1b-2 → 1b-4`。原因：visible window 依赖 focus index 和 control model，而 Other draft 不依赖布局。先稳定 focus model + render model，再处理状态扩展。
- 拆分原则：visible window 是布局算法，Other draft 是状态机，两者不要混合；任何一个失败不阻塞其他。
- 心智模型对照：Phase 1a = UI 基础；Phase 1b = 交互状态机（大功能）；Phase 2 = 真实光标（大功能，含 renderer spike）。
- 实施时不要因 Phase 编号连续而低估 1b/2 的工作量。

本提醒不改变原设计第 5、13 节的 Phase 定义和验收顺序，仅作为 writing-plans 的输入。

### 15.6 PR 边界与实施顺序总表（写入执行计划）

> **硬约束**：Agent 执行时必须按下表边界分 PR，禁止合并。Phase 1b 禁止作为一个任务执行；Phase B 必须保持独立链路。

| 顺序 | PR | 范围 | 依赖 | 风险 |
|------|-----|------|------|------|
| 1 | **Phase 1a** | `AskQuestionOverlayV2` 渲染层：圆角边框 + suggestion 色 + radio/checkbox 符号 + `computeTabLayout` | 无 | 局部（纯渲染） |
| 2 | **Phase B** | `structuredOutcome` pipeline：ToolExecutor ctx → registry → streaming-query → block-pipeline → `buildAskUserPresentation` | 无（与 1a 解耦） | 跨链路（数据透传） |
| 3 | **Phase 1b-1** | 焦点边界停止 | Phase 1a | 状态机 |
| 4 | **Phase 1b-3** | visible window（`computeVisibleWindow`） | 1b-1 | 布局算法 |
| 5 | **Phase 1b-2** | Other 草稿模型 | 1b-1 | 状态机 |
| 6 | **Phase 1b-4** | 多选 submit flow + Esc policy | 1b-1/2/3 | 交互流 |
| 7 | **Phase 2 spike** | 双 renderer spike（gate） | Phase 1b 全部完成 | 探索性 |
| 8 | **Phase 2** | 原生光标 | spike 通过（路径 A/B 决策记录） | 大功能 |

- **PR1（Phase 1a）与 PR2（Phase B）互不依赖**，可并行开发，但建议先合并 PR1（交互期痛点优先）。
- **Phase 1b 的四个子 PR 之间有依赖**（见"依赖"列），但 1b-2 和 1b-3 在 1b-1 之后可并行。
- 每个 PR 独立 TDD + 独立验收，失败不阻塞其他已合并的 PR。

### 15.5 Renderer Spike 是 Phase 2 的 Gate，非子任务

原设计第 11 节已设计双 renderer spike（路径 A/B）。此处强调其**性质**：

- **Spike 是 gate（准入门槛），不是 Phase 2 的子任务**。Phase 2 的最大风险不在实现，而在探索 double-buffer renderer 当前 `cursorTarget` / `internal_cursorTarget` 机制是否可靠——这是未知点。
- **实施顺序必须是**：Renderer Spike → 输出决策记录（路径 A 或 B + 两种 renderer 测试证据）→ **才**进入 Phase 2 实现。
- 第 13 节把 spike 列在 Phase 1b 步骤 7，这只是"最早可执行的时机"，不改变 spike 作为 Phase 2 前置 gate 的性质。
- **Phase 2 启动硬检查点**（原设计第 11.4 节）必须先满足：实施记录写出 spike 采用路径 A 或 B 并附证据，不得留下未决分支。
