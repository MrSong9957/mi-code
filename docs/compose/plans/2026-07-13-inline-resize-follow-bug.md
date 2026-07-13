# Bug B：Inline 模式输入框不跟随终端 resize

> **状态**：pre-existing issue，未在本任务修复
> **发现时间**：2026-07-13 实测粘贴占位符功能时暴露
> **与本次任务关系**：无关（本次只改 `index.ts:311-353` 提交侧，不碰渲染层）

## 症状

终端窗口 resize 后，输入框不实时跟随变化，wordWrap 不重算。

## 根因（已调查，未修复）

**核心问题：Inline 模式渲染不监听终端 resize 事件。**

证据链：
- `src/tui/inline/InlineApp.tsx:264` 和 `:295` 在渲染 effect 内读取 `const cols = process.stdout.columns ?? 80`
- 但 effect 依赖数组（`InlineApp.tsx:421`）**不含 cols，也不含终端尺寸信号**
- 所以 resize 时 effect 不重跑，wordWrap 不重算

对比：
- `src/tui/ConnectedApp.tsx:78` 用了 `useTerminalSize()` 监听 resize
- 但 inline 模式走 `InlineApp`（`bootstrap.tsx:142` `new InlineRenderer` + `InlineApp.tsx:291`），**完全绕过 `useTerminalSize`**

## 现有测试的盲区

- `src/tui/inline/decawm-wordwrap-regression.test.ts` 验证 DECAWM OFF + wordWrap 在**固定 cols=80** 下光标稳定（L83 `const cols = 80`）
- **全程用固定列宽，从不模拟 resize**——所以这个回归测试发现不了 resize 退化
- 全目录无任何名为 `resize` 或 `follow` 的测试

## 修复方向（未来任务参考）

1. 在 `InlineApp` 里接入 `useTerminalSize()`（或直接 `useEffect` 监听 `process.stdout.on('resize')` → 触发强制重渲染）
2. 把 cols 作为渲染 effect 的依赖
3. 参考 commit `58361c8`（"DECAWM OFF + 应用层 wordWrap"）的设计意图——resize 后需重跑 `renderFooter` + `wrapStreamingText` 重算 wordWrap
4. 补 resize 回归测试（模拟 cols 变化，断言重渲染）

## 相关文件

- `src/tui/inline/InlineApp.tsx:264,295,421`
- `src/tui/inline/InlineRenderer.ts:22-28`
- `src/tui/bootstrap.tsx:142`
- `src/tui/hooks/useTerminalSize.ts`（已存在，inline 没用它）
- `src/tui/inline/decawm-wordwrap-regression.test.ts`（现有测试，缺 resize 场景）
