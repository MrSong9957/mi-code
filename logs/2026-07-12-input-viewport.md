# 输入框视口窗口（多行输入 + 固定 footer 高度）

## 底层逻辑
- 物理本质：多行文本上的「取景器」。输入可任意长，footer 固定显示 `MAX_VISIBLE_INPUT_LINES`(=5) 行；光标是相机焦点，视口跟着光标走，光标始终在窗口中央偏上。
- 复用至上：不造 Cursor/MeasuredText 类，直接组合 `computeScrollState` + `clampScrollTop`（与历史消息列表、下拉菜单同源钳位逻辑）。
- 三决策：① 只做显式多行+视口（不做 word wrap）② footer 固定高度 ③ 函数式复用。

## TDD 测试点
- `input-viewport.test.ts`：8 用例（含 2 组防作弊随机化，断言光标恒在窗口内、viewportTop 不越界）。
- `input-store.test.ts`：解除 3 行硬上限，新增"可超过 3 行"用例。
- `input-viewport-scroll-regression.test.ts`：5 用例（切片只含视口内行 + 光标落点 + 随机化 ×10）。
- `cursor-row-regression.test.ts`：新增视口滚动用例（8 行输入，cursorUp=4）。
- `logo-regression.test.ts`：修正 offsetToTop 期望（旧公式用末行假设有缺陷，新公式用 cursorViewportLine 更正确，期望 2→1）。

## 失败原因
- logo-regression 旧测试期望 offsetToTop=2 基于 `inputLines.length-1`（末行假设），但 cursorPos=0 时光标在第 0 行，新公式 `1+cursorViewportLine=1` 才正确——原代码此处是潜在 bug，逐行覆写凑巧掩盖。
- 视口随机化测试首版用 `line${i}` 行名，`line1` 是 `line10` 子串导致 `not.toContain` 误判；改用定宽 `lnNN` + 真实 join 算 cursorPos 修复。

## 验证结果
- tsc --noEmit：干净通过。
- lint（本次改动文件）：干净（历史遗留错误未触碰）。
- L2 inline 目录：25 文件 164 测试全 GREEN。
- L2 tui 全域：67 文件 493 测试全 GREEN。
- L3 全量：126 文件 1297 测试全 GREEN（2 skipped 历史跳过）。
- E2E（input-viewport-e2e.test.tsx）：4 契约全 GREEN。关键证据：8 行输入时 stdout 实际输出 `l3l4l5l6l7`（视口切片生效，l0/l1/l2 被裁），1 行 vs 8 行输入历史区行数一致（footer 固定）。

## 三轮用户实测 Bug 修复（2026-07-12）

### Bug 3（回归·P0）：删除时上边框重复绘制
- 根因：`InlineRenderer.renderFooter` 覆写模式的 `offsetToTop` 用本帧 `cursorViewportLine` 推导，与上一帧光标实际落点不同步，输入增删导致行数变化时覆写起点错位 → border 残影。
- 修复：改用上一帧记录的 `this.cursorToTop`（精确反映本帧开始时光标到块顶距离），杜绝重新推导。
- TDD：`input-viewport-delete-regression.test.ts` 3 契约（逐字删除/跳跃删除/行数剧变，每帧 border 数恒为 2）。

### Bug 1：续行不对齐
- 根因：续行渲染时无前缀，顶格显示；`cursorScreenPos` 续行 x 也不含 promptWidth，光标列偏左。
- 修复：inline + alt-screen 两路径续行加 `CONTINUATION_INDENT`（=promptWidth=2 空格）；`cursorScreenPos` 续行 x 改为 `promptWidth + lineOffset`（所有行统一加 promptWidth）。
- 影响：同步更新 `cursor-position.test.ts`（2 多行用例）、`cursor-position-regression.test.ts`（1 用例）期望值。

### Bug 2：不支持 Ctrl+U
- 新增 `input-store.deleteToLineStart`（删光标到当前行行首，不跨行不删 \n），算法用 `lastIndexOf('\n')+1` 找行首。
- 键绑定：`use-input-handler.ts` 加 `Ctrl+U → s.deleteToLineStart()`。
- TDD：`input-store.test.ts` 新增 4 用例（中间/行首 no-op/多行不跨行/CJK 码点安全）。

### 最终验证
- tsc --noEmit：干净。
- lint（本次改动文件）：干净（历史遗留 no-control-regex 未触碰）。
- L2 tui 全域：69 文件 504 测试全 GREEN。

## Bug 4 修复：超宽输入 border 堆叠 + 光标错位（物理行折算）

### 根因
`footerHeight` 按逻辑行数（`\n` 分割）记账，但终端原生按列宽折行（CJK 占 2 列）。单行 200 字符在 80 列终端实际占 3 物理行，但旧代码只记 1 行——覆写时 `cursorUp` 上移不够，旧 border 残留堆叠。光标定位也按逻辑行算，折行后光标跑错位。

### 修复策略
1. **物理行折算**：`physicalLineCount`（CJK 感知，按 stringWidth 折算逻辑行→物理行），footerHeight/cursorToTop/upFromBottom 全部改用物理行。
2. **DL 整块删除覆写**：旧"逐行擦除 + 补擦折行"在真实终端行为不可预测。改为覆写时先 `\x1b[<footerHeight>M`（DL 物理删除整块，下方上移）再从头追加——DL 是物理删除，不依赖终端折行模拟，比逐行擦除可靠。
3. **光标定位 0-based 统一**：cursorPhysLine0 用 0-based，upFromBottom = newHeight - cursorPhysLine0。

### 验证
- tsc + lint 干净。
- L2 tui 全域：71 文件 527 测试全 GREEN。
- 物理行折算测试 18 个（含连续增长单调性、CJK 折行、光标定位契约）。

## 加固：回归测试沉淀（防退化）

针对用户验证通过的修复，补齐 5 个覆盖缺口：

1. **键绑定层**（`use-input-handler.test.tsx` +7）：Ctrl+J 换行（含连续无上限）、上下方向键跨行、Ctrl+U 删行 + 连续逐行删到空（核心契约）、Home/End 多行。补齐桥接层零覆盖。
2. **CJK×视口×折行组合**（`input-viewport-scroll-regression.test.ts` +4）：8 行中文每行折行 + 视口滚动、footerHeight 物理行记账、光标在中间行 CHA 与 simulateTerminalWrap 自洽、15 组随机化 border 不堆叠不变量。
3. **续行缩进渲染**（`continuation-indent.test.ts` 新建 +6）：inline + alt-screen 两路径的 prompt/CONTINUATION_INDENT 验证、视口滚动后窗口首行缩进、对齐宽度契约、Footer 补空行撑高。
4. **commitFooter 折行清理**（`commit-footer-erase.test.ts` +2）：200 字符折行后 commit（footerHeight>4）+ CJK 折行 commit 无残留。

### 最终验证
- L2 inline + tui 全域：**73 文件 559 测试全 GREEN**（原 527 + 新增 32）。
- tsc 干净。lint 历史遗留（Terminal 模拟器正则的 no-control-regex）未触碰。
- 新增测试含防作弊随机化 3 处（键绑定逐行删、CJK 组合 border 不堆叠、续行缩进对齐）。
