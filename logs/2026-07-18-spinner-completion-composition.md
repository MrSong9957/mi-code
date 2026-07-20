# Spinner completion/composition verification — 2026-07-18

## TDD evidence

### Turn duration message RED

Task 1（commit `5e5a2c3`）已在前序会话完成：`turn-duration-message.test.ts` 首跑 FAIL（缺 `turn-duration-message.js`），实现纯工厂 + `SystemTurnDurationMessage` 后 GREEN。

### SpinnerView RED

Task 4（commit `119cb1d`、`abef062`）已在前序会话完成：`spinner-view.test.ts`、`spinner-store.test.ts` 首跑 FAIL（缺 `setContext`、缺 `spinner-view.js`），实现原子快照、`selectSpinnerView()`、Tip 决策后 GREEN。

### Inline spinnerLines RED

Task 8 Step 1 在本次会话执行：

```
npx vitest run src/tui/inline/footer-regression.test.ts \
  src/tui/inline/physical-line-footer-regression.test.ts \
  src/tui/inline/cursor-drift-regression.test.ts \
  src/tui/inline/cursor-row-regression.test.ts \
  src/tui/inline/input-viewport-scroll-regression.test.ts \
  src/tui/inline/logo-regression.test.ts \
  src/tui/inline/layout.test.ts --reporter=verbose
```

exit 1：`Test Files 3 failed | 4 passed (7)`、`Tests 11 failed | 46 passed (57)`。

11 个失败全部呈「expected N+1 / received N」的差 1 模式（光标行、cursorToTop、footerHeight），分布在 cursor-drift / logo / physical-line-footer 三个文件。检查代码确认：旧测试假设「无 spinner 固定 2 行预留位」，而 Task 6（commit `d28002b`）已把 layout 契约改为动态 `spinnerLines` —— 无 spinner 时 `reserveRows = 1`（仅一个间隔空行），有 spinner 时 `reserveRows = 1 + spinnerLines.length`。

随后跑全 inline 目录基线确认共 31 个失败，分布 9 个文件（commit-footer-erase / cursor-drift / decawm-wordwrap / dropdown-shrink / input-wrap / logo / overwrite-wrap / physical-line / truncate-status），全部由「2 预留位 → 1 间隔位」的契约演进而触发，无内容丢失或 ANSI 崩坏。

### Footer 修复 GREEN

按 Task 8 Step 2 的统一公式（`reserveRows = 1 + spinnerLines.length`）更新直接相关断言与注释，分 3 批次 GREEN：

- Task 8.1（cursor-drift / logo）：10 tests passed。
- Task 8.2（physical-line-footer / commit-footer-erase）：23 tests passed。
- Task 8.3（dropdown-shrink / input-wrap / overwrite-wrap / decawm-wordwrap / truncate-status）：31 tests passed。

## Verification

### Focused tests

L1/L2 重点集合（计划 Step 1 列出的 10 个测试文件 + 整个 inline 目录）：

```
npx vitest run src/__tests__/tui/turn-duration-message.test.ts \
  src/__tests__/tui/messages-store.test.ts \
  src/__tests__/tui/spinner-store.test.ts \
  src/__tests__/tui/spinner-view.test.ts \
  src/__tests__/tui/use-spinner-clock.test.tsx \
  src/__tests__/tui/spinner-component.test.tsx \
  src/__tests__/tui/spinner-integration.test.tsx \
  src/__tests__/tui/SpinnerLine.test.tsx \
  src/__tests__/tui/bootstrap-spinner-completion.test.ts \
  src/__tests__/tui/pipeline-integration.test.ts \
  src/tui/inline/ --reporter=dot
```

exit 0：`Test Files 49 passed (49)`、`Tests 430 passed (430)`。

Task 8 Step 5 集合：

```
npx vitest run src/tui/inline/ \
  src/__tests__/tui/selection/flatten-messages.test.ts \
  src/__tests__/tui/bootstrap-spinner-completion.test.ts --reporter=dot
```

exit 0：`Test Files 41 passed (41)`、`Tests 339 passed (339)`。

### TypeScript

`npm run typecheck`（`tsc --noEmit`）exit 0。

### ESLint

`npm run lint` exit 1：`160 problems (111 errors, 49 warnings)`，与本次修改前的基线完全一致（Task 7 报告亦记录 111 errors + 49 warnings）。

对 Task 8 修改的 11 个文件单独跑 ESLint：26 errors 全部是既有类别（`no-control-regex` 测试 ANSI 序列、`wrapLine` 等未使用导入），`git diff HEAD~1 HEAD` 比对确认本次改动**未新增**任何 lint 触发点（新增代码用 `stripAnsi` 而非直接 ANSI 正则）。

### Full suite

`npm test -- --reporter=dot`（85.69s）：

```
Test Files  1 failed | 177 passed (178)
Tests       2 failed | 1813 passed | 2 skipped (1817)
```

## Failure classification

- `src/__tests__/tui/layout.test.tsx > StatusBar 格式：mode | model | dir | branch | [进度条] pct%`
- `src/__tests__/tui/layout.test.tsx > StatusBar 进度条随 contextPct 变化`

两条均与本次 Spinner 改造无关。`git log` 显示 StatusBar 的多色高亮改造（commit `4058193`，2026-07 早期）引入 ANSI RGB 包裹的进度条字符；这两个测试期望纯文本 `█████░░░░░ 50%`，但实际输出是 `\x1b[38;2;100;200;240m█████\x1b[38;2;100;100;112m░░░░░ 50%`。

设计文档第 250 行与计划 Task 8 Step 5 均明确豁免：「两个与状态栏 ANSI 文本匹配有关的既有失败不纳入功能修改，除非最终验证证明本次改动直接影响它们」。

本次 Task 8 改动只触及 inline footer layout 契约与完成消息回归测试，未触碰 `StatusBar.tsx` 或 `layout.test.tsx`，已用独立命令复现并确认是 StatusBar 多色高亮导致的既有失败。
