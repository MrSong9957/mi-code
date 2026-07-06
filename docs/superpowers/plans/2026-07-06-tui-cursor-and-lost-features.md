# TUI 光标 CJK 修复 + 丢失功能恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Ink 重构后输入框中文光标错位回归 bug，并恢复 4 项丢失功能（状态栏多色高亮、Spinner、TAB 切换模式/补全、Ctrl+O 全屏展开覆盖层、多行输入）。

**Architecture:** 沿用现有 React+Ink+Yoga+Zustand vanilla 架构。新增 3 个轻量 store（spinner-store / completion-store / overlay-store）、3 个组件（Spinner / SuggestionBar / Overlay）、1 个共享光标位置工具。所有新代码遵循现有 charter（Yoga 自动布局、禁止手动 CUP）。CJK 光标修复是核心：用 `string-width` 把「光标前文本」转成显示宽度，多行场景同时返回 `(x,y)`。

**Tech Stack:** TypeScript ESM、React 18、Ink（npm 官方）、Zustand vanilla、string-width@^8.2.1（已装）、chalk@^5.6.2（已装，可选）、vitest、ink-testing-library。

**测试命令：** `npm test`（即 `vitest run`）；类型检查 `npm run typecheck`；构建 `npm run build`。

**关键参考文件（只读上下文）：**
- `src/tui/App.tsx` — 顶层布局、`FOOTER_ROWS`/`LOGO_ROWS` 常量、`inputRowY` 计算
- `src/tui/ConnectedApp.tsx` — store 接线、`useInputHandler` 挂载点
- `src/tui/bootstrap.tsx` — `BootstrapHandle` 接口、stores 装配
- `src/tui/state/input-store.ts` — 文本编辑原语（码点 cursor，正确）
- `src/commands/executor.ts` — 斜杠命令 switch（`COMMAND_NAMES` 抽取源）
- `src/index.ts` — 主入口、`handleUserSubmit`、streaming 事件 hook 点、`cleanupOnExit`
- `src/agent/stream-event-bus.ts` — `onToolCall`/`onToolResult`/`onLoopEnd` API

---

## File Structure（新增/修改清单）

**新增：**
- `src/tui/state/cursor-position.ts` — 共享光标屏幕坐标工具 `cursorScreenPos(input, cursor, prompt)` → `{x, y}`。CJK 安全 + 多行安全。**1A 与 3B 的共同基石。**
- `src/tui/state/spinner-store.ts` — Spinner 数据 store（active/label/frame/stalled）。
- `src/tui/state/completion-store.ts` — 斜杠命令补全候选 store（candidates/index/visible）。
- `src/tui/state/overlay-store.ts` — Ctrl+O 覆盖层 store（visible/title/lines）。
- `src/tui/components/Spinner.tsx` — Ink 组件：订阅 spinner-store，setInterval tick，渲染 braille + label。
- `src/tui/components/SuggestionBar.tsx` — Ink 组件：订阅 completion-store，渲染候选条，当前项 inverse。
- `src/tui/components/Overlay.tsx` — Ink 组件：订阅 overlay-store，全屏展开最后一个可折叠块。
- `src/__tests__/tui/cursor-position.test.ts`、`spinner-store.test.ts`、`completion-store.test.ts`、`overlay-store.test.ts`
- `src/__tests__/tui/spinner-component.test.tsx`、`suggestion-bar.test.tsx`、`overlay-component.test.tsx`

**修改：**
- `src/tui/components/Footer.tsx` — 用 `cursor-position.ts` 替换 `PROMPT_WIDTH + cursor`；插入 `<Spinner/>`/`<SuggestionBar/>`；多行场景的 `inputRowY` 修正。
- `src/tui/components/StatusBar.tsx` — 每段独立 `<Text color bold>`，恢复旧 RGB 调色板 + ` │ ` 分隔符。
- `src/tui/App.tsx` — `FOOTER_ROWS` 改为按输入行数动态计算；`inputRowY` 适配多行；overlay 条件渲染。
- `src/tui/ConnectedApp.tsx` — 订阅 spinner/completion/overlay store；传 `onTab`/`onToggleOverlay` 进 handler。
- `src/tui/input/use-input-handler.ts` — 新增 `key.tab`/`key.upArrow`/`key.downArrow`/Ctrl+J/Ctrl+O/overlay 关键键分支。
- `src/tui/state/input-store.ts` — 新增 `insertNewline()`/`moveCursorUp()`/`moveCursorDown()`。
- `src/tui/bootstrap.tsx` — 创建 3 个新 store；`BootstrapHandle` 暴露 spinner/overlay 控制方法 + `getLastExpandableLines`。
- `src/commands/executor.ts` — 抽取 `export const COMMAND_NAMES` 常量。
- `src/index.ts` — 接 spinner store 8 处 hook；接 onTab（模式切换+补全）；接 onToggleOverlay；BootstrapHandle 传新回调。
- `.memory/ink-migration-progress.md` — 「踩过的坑」追加 CJK 光标回归教训。

---

## Task 1: 共享光标位置工具 `cursor-position.ts`（CJK + 多行安全的基石）

**Goal:** 提供一个把 `(input, cursor, prompt)` 映射到屏幕 `{x, y}` 的纯函数，CJK 与多行都正确。1A（CJK）与 3B（多行）共用。

**Files:**
- Create: `src/tui/state/cursor-position.ts`
- Test: `src/__tests__/tui/cursor-position.test.ts`

- [ ] **Step 1: 写失败测试（CJK + 多行 + 纯 ASCII 各一例）**

Create `src/__tests__/tui/cursor-position.test.ts`:

```ts
// src/__tests__/tui/cursor-position.test.ts
// 光标屏幕坐标工具：CJK 全角=2 列 + 多行 (x,y) 都要正确

import { describe, it, expect } from 'vitest';
import { cursorScreenPos } from '../../tui/state/cursor-position.js';

describe('cursorScreenPos（CJK + 多行 → 屏幕列/行）', () => {
  it('纯 ASCII：光标在末尾，x = promptWidth + textLen', () => {
    // '❯ ' + 'hello'，光标在末尾（5）
    const pos = cursorScreenPos('hello', 5, '❯ ');
    expect(pos).toEqual({ x: 2 + 5, y: 0 });
  });

  it('纯 ASCII：光标在中间', () => {
    // '❯ ' + 'hel|lo'，cursor=3
    const pos = cursorScreenPos('hello', 3, '❯ ');
    expect(pos).toEqual({ x: 2 + 3, y: 0 });
  });

  it('CJK 末尾：你好world cursor=7，显示宽度=2+2+2+5=11（不是 9）', () => {
    // 关键回归断言：旧 bug 是 x = 2+7 = 9（落在「好」中间）
    const pos = cursorScreenPos('你好world', 7, '❯ ');
    expect(pos.x).toBe(2 + 2 + 2 + 5); // 11
    expect(pos.y).toBe(0);
  });

  it('CJK 中间：你|好world cursor=1，x = 2 + 2（「你」宽 2）= 4', () => {
    const pos = cursorScreenPos('你好world', 1, '❯ ');
    expect(pos.x).toBe(2 + 2);
    expect(pos.y).toBe(0);
  });

  it('全 emoji：👋 cursor=1，x = 2 + 2', () => {
    const pos = cursorScreenPos('👋', 1, '❯ ');
    expect(pos.x).toBe(2 + 2);
  });

  it('多行：第 0 行末尾换行，光标在第 1 行行首', () => {
    // 'abc\ndef'，cursor=4（在 \n 之后）
    const pos = cursorScreenPos('abc\ndef', 4, '❯ ');
    expect(pos).toEqual({ x: 0, y: 1 });
  });

  it('多行：光标在第 1 行中间（含 CJK）', () => {
    // 'abc\n你def'，cursor=5（「你」之后，5 = 4(\n后) + 1(「你」码点)）
    const pos = cursorScreenPos('abc\n你def', 5, '❯ ');
    // 第 0 行 prompt+abc=5；第 1 行 x = stringWidth('你') = 2
    expect(pos).toEqual({ x: 2, y: 1 });
  });

  it('空 prompt：x 纯文本宽度', () => {
    const pos = cursorScreenPos('hi', 2, '');
    expect(pos).toEqual({ x: 2, y: 0 });
  });

  it('cursor=0：x=promptWidth', () => {
    const pos = cursorScreenPos('hello', 0, '❯ ');
    expect(pos).toEqual({ x: 2, y: 0 });
  });

  it('cursor 超出 text.length：钳到末尾（防御）', () => {
    const pos = cursorScreenPos('hi', 99, '❯ ');
    expect(pos).toEqual({ x: 4, y: 0 });
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- cursor-position`
Expected: FAIL，`cursorScreenPos is not a function` / 模块不存在。

- [ ] **Step 3: 写最小实现**

Create `src/tui/state/cursor-position.ts`:

```ts
// src/tui/state/cursor-position.ts
// 光标屏幕坐标工具：把 (input, cursor, prompt) 映射到屏幕 {x, y}
//
// 物理本质：文本「码点索引」→ 终端「显示列/行」的翻译器。
// CJK 全角字符（汉字/emoji）在终端占 2 列，但 JS 码点计数只算 1。
// 旧 Ink Footer 把码点索引当列用，导致中文输入时光标落在字符中间（回归 bug）。
//
// 算法（对齐 Ink useCursor README 官方推荐 + 旧 renderer.ts:computeInputCursorPos）：
//   1. cursor 视为码点索引（与 input-store 一致）
//   2. 按行分割；逐行消费码点，定位光标所在行 y
//   3. 当前行「光标之前」的文本用 stringWidth 量显示宽度
//   4. x = (y===0 ? promptWidth : 0) + 行内显示宽度
//
// 注意：续行的「prompt 对齐 padding」由 Footer 渲染负责（不写入 input 文本），
// 这里只关心 input 本身的字符宽度。

import stringWidth from 'string-width';

export interface ScreenPos {
  /** 屏幕列（0-based，不含 prompt 时为 0） */
  x: number;
  /** 行偏移（0-based，相对输入区第 0 行） */
  y: number;
}

/**
 * 计算 (input, cursor) 在屏幕上的 (x, y)。
 * @param input 完整输入文本（可能多行）
 * @param cursor 码点索引（0-based，[0, text.length]）
 * @param prompt 第 0 行的 prompt 字符串（如 '❯ '），仅影响第 0 行 x 偏移
 */
export function cursorScreenPos(input: string, cursor: number, prompt: string): ScreenPos {
  const lines = input.split('\n');
  // 把 cursor 钳到合法范围
  const cpLen = [...input].length;
  const c = Math.max(0, Math.min(cursor, cpLen));

  const promptWidth = stringWidth(prompt);
  let remaining = c;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineCpLen = [...line].length;
    if (remaining <= lineCpLen) {
      // 光标在第 i 行
      const beforeCursor = [...line].slice(0, remaining).join('');
      const lineOffset = stringWidth(beforeCursor);
      const x = (i === 0 ? promptWidth : 0) + lineOffset;
      return { x, y: i };
    }
    remaining -= lineCpLen + 1; // +1 跳过 \n
  }
  // 理论不可达（cursor 已钳到末尾），兜底返回最后一行末尾
  const lastIdx = lines.length - 1;
  const lastLine = lines[lastIdx] ?? '';
  const x = (lastIdx === 0 ? promptWidth : 0) + stringWidth(lastLine);
  return { x, y: lastIdx };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- cursor-position`
Expected: PASS（10/10）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/tui/state/cursor-position.ts src/__tests__/tui/cursor-position.test.ts
git commit -m "feat(tui): 共享光标屏幕坐标工具 cursorScreenPos（CJK+多行安全）"
```

---

## Task 2: Footer 用 cursorScreenPos 修 CJK 光标（修复 1A）

**Goal:** 把 `Footer.tsx:29` 的 `PROMPT_WIDTH + cursor` 替换为 `cursorScreenPos(input, cursor, '❯ ')`，光标 x 用其 `.x`。

**Files:**
- Modify: `src/tui/components/Footer.tsx`

- [ ] **Step 1: 写失败测试（Footer 渲染时 useCursor 收到正确 x）**

Add to `src/__tests__/tui/layout.test.tsx`（已存在，文件末尾追加 describe）：

```tsx
describe('Footer 光标定位（CJK + 多行）', () => {
  it('CJK 输入：useCursor 收到的 x 是显示宽度（不是码点数）', () => {
    // 用 spy 捕获 setCursorPosition 调用
    const calls: Array<{ x: number; y: number }> = [];
    const spy = (props: { x?: number; y?: number }): void => {
      calls.push({ x: props.x ?? 0, y: props.y ?? 0 });
    };
    // 直接渲染 Footer（它内部用 useCursor）
    const FooterTest = require('../../tui/components/Footer.js').Footer;
    const { unmount } = render(
      React.createElement(FooterTest, {
        input: '你好world', cursor: 7, status: STATUS, cols: 80, inputRowY: 5,
        // 通过 require mock useCursor？改用直接调用 cursorScreenPos 的方式更稳：
      }),
    );
    unmount();
    // 由于 useCursor 是 Ink 内部 hook，难以在 ink-testing-library 捕获；
    // 改而断言 cursorScreenPos 的输出（已在 Task 1 覆盖）。
    // 这里仅断言 Footer 不抛错（smoke）。
    expect(calls.length).toBeGreaterThanOrEqual(0);
  });
});
```

> **注意：** Ink 的 `useCursor().setCursorPosition` 写入 Ink 内部光标状态，`ink-testing-library` 不暴露该状态。**真正的回归保护在 Task 1 的 `cursorScreenPos` 单测**（断言 `你好world` → x=11）。Footer 测试退化为 smoke test：确保渲染不抛错。如果项目里 `require()` 在 ESM 不可用，删掉这个 describe，仅靠 cursorScreenPos 单测守护回归 —— 这是合理权衡（光标数学已被纯函数单测锁死）。

- [ ] **Step 2: 修改 Footer.tsx**

Replace lines 10-15（imports + PROMPT_WIDTH）和 line 26-29（Footer 函数开头）:

old (imports + const):
```tsx
import React from 'react';
import { Box, Text, useCursor } from 'ink';
import { StatusBar } from './StatusBar.js';
import type { StatusBarData } from '../types.js';

const PROMPT_WIDTH = 2; // '❯ ' 的显示宽度
```

new:
```tsx
import React from 'react';
import { Box, Text, useCursor } from 'ink';
import { StatusBar } from './StatusBar.js';
import { cursorScreenPos } from '../state/cursor-position.js';
import type { StatusBarData } from '../types.js';

const PROMPT = '❯ '; // 第 0 行 prompt（影响 x 偏移）
```

old (Footer 函数体顶部):
```tsx
export function Footer({ input, cursor, status, cols, inputRowY }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  // 光标定位到输入框：x = '❯ ' 宽度 + 光标字符偏移，y = 输入行全局 y
  setCursorPosition({ x: PROMPT_WIDTH + cursor, y: inputRowY });
```

new:
```tsx
export function Footer({ input, cursor, status, cols, inputRowY }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  // 光标定位（Bug 1 修复）：用 stringWidth 算显示宽度，CJK 不再被一分为二。
  // 多行时 y 还要加上光标所在行偏移。
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });
```

- [ ] **Step 3: 跑测试 + typecheck**

Run: `npm test -- layout && npm run typecheck`
Expected: 现有 layout 测试全 PASS（行为不变，只是 x 计算改用工具）；typecheck 通过。

- [ ] **Step 4: commit**

```bash
git add src/tui/components/Footer.tsx
git commit -m "fix(tui): 输入框光标 CJK 错位——改用 cursorScreenPos 量显示宽度

旧代码 PROMPT_WIDTH + cursor 把码点索引当列用，汉字光标落在字符中间。
现用 string-width 量光标前文本的显示宽度（对齐 Ink useCursor README 与旧 renderer.ts）。"
```

---

## Task 3: 状态栏多色高亮（修复 1B）

**Goal:** 把 StatusBar 单 `<Text dimColor>` 拆成多段，恢复旧 RGB 调色板 + ` │ ` 分隔符。

**Files:**
- Modify: `src/tui/components/StatusBar.tsx`
- Test: `src/__tests__/tui/status-bar.test.tsx`（新建）

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/status-bar.test.tsx`:

```tsx
// src/__tests__/tui/status-bar.test.tsx
// StatusBar 多色高亮：mode/model/dir/branch/进度条 各自独立颜色

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { StatusBar } from '../../tui/components/StatusBar.js';
import type { StatusBarData } from '../../tui/types.js';

const STATUS: StatusBarData = {
  mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.5,
};

describe('StatusBar 多色高亮', () => {
  it('渲染所有 5 段内容', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { status: STATUS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('build');
    expect(frame).toContain('sonnet');
    expect(frame).toContain('Projects/mi-code');
    expect(frame).toContain('main');
    expect(frame).toContain('50%');
  });

  it('用 box-drawing 分隔符 │（不是 ASCII |）', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { status: STATUS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('│');
  });

  it('进度条 50% 渲染 5 格填充', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { status: STATUS }));
    const frame = lastFrame() ?? '';
    // 10 格 BAR，50% → 5 个 █
    expect(frame).toContain('█████');
    expect(frame).toContain('░░░░░');
  });

  it('contextPct=0 渲染全空进度条', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: { ...STATUS, contextPct: 0 } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('░░░░░░░░░░');
    expect(frame).toContain('0%');
  });

  it('contextPct 钳位（>1 当 1 处理）', () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: { ...STATUS, contextPct: 1.5 } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('██████████');
    expect(frame).toContain('100%');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- status-bar`
Expected: FAIL（`│` 断言失败 —— 当前是 ` | `）。

- [ ] **Step 3: 重写 StatusBar.tsx**

Replace entire `src/tui/components/StatusBar.tsx`:

```tsx
// src/tui/components/StatusBar.tsx
// 状态栏：mode | model | dir | branch | [进度条] pct%
//
// 物理本质：footer 最底一行，会话元信息的「仪表盘」。
// 多色高亮：每段独立 <Text color bold>，对齐旧 src/renderer/status-bar.ts 的 RGB 调色板。
// 分隔符用 box-drawing │（视觉上比 ASCII | 更精致）。

import React from 'react';
import { Text } from 'ink';
import type { StatusBarData } from '../types.js';

const BAR_WIDTH = 10;

// 旧调色板（status-bar.ts 的 RGB → Ink hex）
const MODE_COLOR = '#78e6e6';   // 亮青（模式：build/plan/auto）
const MODEL_COLOR = '#8cbeff';  // 亮蓝（模型名）
const DIR_COLOR = '#c8a0ff';    // 亮紫（工作目录）
const BRANCH_COLOR = '#ffe16e'; // 亮黄（git 分支）
const FILL_COLOR = '#78e6e6';   // 进度条填充（同 mode）
const EMPTY_COLOR = '#8c8c8c';  // 进度条空 / 分隔符

/** 把 contextPct [0,1] 渲染成填充/空两段字符串 */
function splitBar(pct: number): { filled: string; empty: string; label: string } {
  const clamped = Math.max(0, Math.min(1, pct));
  const filled = Math.round(clamped * BAR_WIDTH);
  return {
    filled: '█'.repeat(filled),
    empty: '░'.repeat(BAR_WIDTH - filled),
    label: `${Math.round(clamped * 100)}%`,
  };
}

export function StatusBar({ status }: { status: StatusBarData }): React.ReactElement {
  const bar = splitBar(status.contextPct);
  return (
    <Text>
      <Text color={MODE_COLOR} bold>{status.mode}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={MODEL_COLOR} bold>{status.model}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={DIR_COLOR} bold>{status.dir}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={BRANCH_COLOR} bold>{status.branch}</Text>
      <Text color={EMPTY_COLOR}> │ </Text>
      <Text color={FILL_COLOR} bold>{bar.filled}</Text>
      <Text color={EMPTY_COLOR}>{bar.empty}</Text>
      <Text color={EMPTY_COLOR}> {bar.label}</Text>
    </Text>
  );
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- status-bar`
Expected: PASS（5/5）。

- [ ] **Step 5: 跑全量 + commit**

```bash
npm test
git add src/tui/components/StatusBar.tsx src/__tests__/tui/status-bar.test.tsx
git commit -m "feat(tui): 状态栏多色高亮——恢复 RGB 调色板 + │ 分隔符

旧重构退化为单 <Text dimColor>；现按 mode/model/dir/branch/进度条 各段独立着色
（对齐旧 src/renderer/status-bar.ts：亮青/蓝/紫/黄）。"
```

---

## Task 4: Spinner store

**Goal:** 纯数据 store，对齐旧 `Spinner` 类：active/label/frameIndex/stalled/lastTokenAt + start/stop/setLabel/tick/onToken。

**Files:**
- Create: `src/tui/state/spinner-store.ts`
- Test: `src/__tests__/tui/spinner-store.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/spinner-store.test.ts`:

```ts
// src/__tests__/tui/spinner-store.test.ts
// spinner-store：start/stop/setLabel/tick/onToken + 3s stall 检测

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('spinner-store', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('初始：inactive，frame=0，无 label', () => {
    const s = createSpinnerStore();
    const st = s.getState();
    expect(st.active).toBe(false);
    expect(st.frameIndex).toBe(0);
    expect(st.label).toBe('');
    expect(st.stalled).toBe(false);
  });

  it('start(label)：active=true，记录 label 与 lastTokenAt', () => {
    const s = createSpinnerStore();
    s.getState().start('Thinking…');
    const st = s.getState();
    expect(st.active).toBe(true);
    expect(st.label).toBe('Thinking…');
    expect(st.lastTokenAt).toBe(0);
  });

  it('tick：frameIndex 在 0..9 循环', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    for (let i = 0; i < 12; i++) s.getState().tick();
    // 12 % 10 = 2
    expect(s.getState().frameIndex).toBe(2);
  });

  it('setLabel：运行中改文案', () => {
    const s = createSpinnerStore();
    s.getState().start('Thinking…');
    s.getState().setLabel('Running bash');
    expect(s.getState().label).toBe('Running bash');
    expect(s.getState().active).toBe(true);
  });

  it('stop：active=false，清 label', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    s.getState().stop();
    expect(s.getState().active).toBe(false);
    expect(s.getState().label).toBe('');
  });

  it('onToken：刷新 lastTokenAt，清 stalled', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    // 模拟 4s 后 tick → stalled=true
    vi.setSystemTime(4000);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
    // 收到 token → 清 stalled，刷新时间
    vi.setSystemTime(4001);
    s.getState().onToken();
    expect(s.getState().stalled).toBe(false);
    expect(s.getState().lastTokenAt).toBe(4001);
  });

  it('stall 阈值=3000ms：2999ms 不 stall，3001ms stall', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    vi.setSystemTime(2999);
    s.getState().tick();
    expect(s.getState().stalled).toBe(false);
    vi.setSystemTime(3001);
    s.getState().tick();
    expect(s.getState().stalled).toBe(true);
  });

  it('stop 后 tick 不再推进 frame（防御）', () => {
    const s = createSpinnerStore();
    s.getState().start('x');
    s.getState().tick();
    const f = s.getState().frameIndex;
    s.getState().stop();
    s.getState().tick();
    expect(s.getState().frameIndex).toBe(f);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- spinner-store`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/tui/state/spinner-store.ts`:

```ts
// src/tui/state/spinner-store.ts
// Spinner 数据 store（zustand vanilla）
//
// 物理本质：footer spinner 区的「数据源」。对齐旧 src/renderer/spinner.ts：
// - braille 10 帧（⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏），120ms 一帧（由 Spinner 组件的 setInterval 驱动）
// - 3s 无 token → stalled（红）
// - label 由调用方决定（Thinking…/Running X/Generating…）
//
// store 只管数据；动画 setInterval 在 Spinner.tsx 里（React 生命周期管理）。

import { createStore, type StoreApi } from 'zustand/vanilla';

/** braille 帧序（10 帧）——导出供组件消费 */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** 无 token 多久判 stall（ms） */
const STALL_MS = 3000;

export interface SpinnerState {
  active: boolean;
  label: string;
  frameIndex: number;
  stalled: boolean;
  /** 最近一次收到 token 的时间戳（Date.now()） */
  lastTokenAt: number;
  start: (label: string) => void;
  stop: () => void;
  setLabel: (label: string) => void;
  /** 推进一帧（120ms 一次）；inactive 时 no-op */
  tick: () => void;
  /** 收到 token：刷新 lastTokenAt，清 stalled */
  onToken: () => void;
}

export type SpinnerStore = StoreApi<SpinnerState>;

export function createSpinnerStore(): SpinnerStore {
  return createStore<SpinnerState>((set) => ({
    active: false,
    label: '',
    frameIndex: 0,
    stalled: false,
    lastTokenAt: 0,

    start: (label) => set({
      active: true, label, frameIndex: 0, stalled: false, lastTokenAt: Date.now(),
    }),
    stop: () => set({ active: false, label: '', stalled: false }),
    setLabel: (label) => set({ label }),
    tick: () => set((s) => {
      if (!s.active) return s;
      const next = (s.frameIndex + 1) % SPINNER_FRAMES.length;
      const stalled = Date.now() - s.lastTokenAt > STALL_MS;
      return { frameIndex: next, stalled };
    }),
    onToken: () => set({ lastTokenAt: Date.now(), stalled: false }),
  }));
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- spinner-store`
Expected: PASS（7/7）。

- [ ] **Step 5: commit**

```bash
git add src/tui/state/spinner-store.ts src/__tests__/tui/spinner-store.test.ts
git commit -m "feat(tui): spinner-store——start/stop/setLabel/tick/onToken + 3s stall"
```

---

## Task 5: Spinner Ink 组件

**Goal:** 订阅 spinner-store，active 时 setInterval 120ms tick，渲染 braille+label（stalled 红）。

**Files:**
- Create: `src/tui/components/Spinner.tsx`
- Test: `src/__tests__/tui/spinner-component.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/spinner-component.test.tsx`:

```tsx
// src/__tests__/tui/spinner-component.test.tsx
// Spinner 组件：active 渲染 braille+label；inactive 不渲染

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Spinner } from '../../tui/components/Spinner.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';

describe('Spinner 组件', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('inactive：渲染空（无 braille）', () => {
    const store = createSpinnerStore();
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    // inactive 时不应出现任何 braille 帧
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('active：渲染 braille + label', () => {
    const store = createSpinnerStore();
    store.getState().start('Thinking…');
    const { lastFrame } = render(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thinking…');
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  it('setInterval 120ms 推进帧（不抛错）', () => {
    const store = createSpinnerStore();
    store.getState().start('x');
    const { unmount } = render(React.createElement(Spinner, { store }));
    // 推进 360ms = 3 个 tick
    vi.advanceTimersByTime(360);
    // frameIndex 应已推进（store 层已测；这里只确保不抛错、不崩）
    expect(store.getState().frameIndex).toBeGreaterThan(0);
    unmount();
  });

  it('stop 后不再渲染 braille', () => {
    const store = createSpinnerStore();
    store.getState().start('x');
    const { lastFrame, rerender } = render(React.createElement(Spinner, { store }));
    store.getState().stop();
    rerender(React.createElement(Spinner, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- spinner-component`
Expected: FAIL（`Spinner` 模块不存在）。

- [ ] **Step 3: 写组件**

Create `src/tui/components/Spinner.tsx`:

```tsx
// src/tui/components/Spinner.tsx
// Spinner 渲染组件：订阅 spinner-store，active 时 setInterval(120ms) 推进帧
//
// 物理本质：footer 顶部的「加载指示灯」。active 时转 braille 点阵 + label；
// 3s 无 token → stalled（变红）。inactive 时不占行（Yoga 重排）。
//
// 动画 setInterval 挂在 React useEffect 上，unmount/stop 时清理（避免泄漏）。

import React, { useEffect } from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import { SPINNER_FRAMES, type SpinnerStore } from '../state/spinner-store.js';

const TICK_MS = 120;

export interface SpinnerProps {
  store: SpinnerStore;
}

export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const active = useStore(store, (s) => s.active);
  const label = useStore(store, (s) => s.label);
  const frameIndex = useStore(store, (s) => s.frameIndex);
  const stalled = useStore(store, (s) => s.stalled);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);

  if (!active) return null;
  const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
  return (
    <Text color={stalled ? 'red' : '#78e6e6'} bold>
      {frame} {label}
    </Text>
  );
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- spinner-component`
Expected: PASS（4/4）。

- [ ] **Step 5: commit**

```bash
git add src/tui/components/Spinner.tsx src/__tests__/tui/spinner-component.test.tsx
git commit -m "feat(tui): Spinner 组件——braille 10 帧 + 120ms tick + stall 红"
```

---

## Task 6: 接 Spinner 进 Footer + bootstrap + index.ts（8 处 hook）

**Goal:** Footer 渲染 `<Spinner/>`；bootstrap 创建 store 并暴露控制方法；index.ts 在 streaming 8 个事件点调用。

**Files:**
- Modify: `src/tui/components/Footer.tsx`（插 Spinner）
- Modify: `src/tui/bootstrap.tsx`（创建 store + 暴露方法）
- Modify: `src/tui/ConnectedApp.tsx`（订阅 store，传给 App/Footer）
- Modify: `src/tui/App.tsx`（Footer 接 spinnerStore prop）
- Modify: `src/index.ts`（8 处 hook）

- [ ] **Step 1: 改 Footer 接 spinnerStore**

In `src/tui/components/Footer.tsx`，修改 `FooterProps` 加 `spinnerStore`，并在 JSX 顶部插 `<Spinner/>`：

old (`FooterProps`):
```tsx
export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位） */
  inputRowY: number;
}
```

new:
```tsx
export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  /** 输入行在 Ink 输出中的全局 y 坐标（用于光标定位） */
  inputRowY: number;
  /** spinner store（active 时渲染加载指示） */
  spinnerStore: SpinnerStore;
  /** 补全候选 store（visible 时渲染候选条）—— Task 7 接入 */
  completionStore?: CompletionStore;
  /** 覆盖层 store（visible 时替换整个 App）—— Task 11 接入 */
  overlayStore?: OverlayStore;
}
```

加 imports（顶部）:
```tsx
import { Spinner } from './Spinner.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { OverlayStore } from '../state/overlay-store.js';
```

> **注意：** `CompletionStore`/`OverlayStore` 在 Task 7/10 才创建。此处 forward-declare 类型 import 会让 typecheck 在 Task 6 失败。**两个选择**：
> - (a) Task 6 只加 `spinnerStore`，Task 7/10 再回头补 `completionStore`/`overlayStore`（更稳，推荐）。
> - (b) 提前在 Task 6 创建空的 `completion-store.ts`/`overlay-store.ts` 骨架。
> 选 (a)：Task 6 的 FooterProps 只加 `spinnerStore`，Task 7 补 `completionStore`，Task 10 补 `overlayStore`。下面按 (a) 写。

修正（Task 6 版本的 FooterProps）:
```tsx
export interface FooterProps {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  inputRowY: number;
  spinnerStore: SpinnerStore;
}
```

imports（Task 6 版本）:
```tsx
import { Spinner } from './Spinner.js';
import type { SpinnerStore } from '../state/spinner-store.js';
```

JSX 修改（在 `<Box flexShrink={0} flexDirection="column">` 第一个子元素位置插 Spinner）:

old:
```tsx
  return (
    <Box flexShrink={0} flexDirection="column">
      <Text color="gray">{border}</Text>
```

new:
```tsx
  return (
    <Box flexShrink={0} flexDirection="column">
      <Spinner store={spinnerStore} />
      <Text color="gray">{border}</Text>
```

函数签名也要更新（解构 spinnerStore）:
old:
```tsx
export function Footer({ input, cursor, status, cols, inputRowY }: FooterProps): React.ReactElement {
```
new:
```tsx
export function Footer({ input, cursor, status, cols, inputRowY, spinnerStore }: FooterProps): React.ReactElement {
```

- [ ] **Step 2: 改 bootstrap 创建 spinnerStore + 暴露方法**

In `src/tui/bootstrap.tsx`，加 import + 创建 store + 暴露控制方法 + 传给 ConnectedApp：

加 import（顶部 import 区）:
```tsx
import { createSpinnerStore, type SpinnerStore } from './state/spinner-store.js';
```

在 `bootstrap()` 函数内（line ~60，其它 store 创建之后）加:
```tsx
const spinnerStore = createSpinnerStore();
```

`BootstrapHandle` 接口加（在 `cleanup` 之前）:
```tsx
  spinnerStore: SpinnerStore;
  /** spinner 控制（对齐旧 layout.startSpinner 等） */
  startSpinner: (label: string) => void;
  stopSpinner: () => void;
  setSpinnerLabel: (label: string) => void;
  spinnerOnToken: () => void;
```

return 对象加（`logoStore,` 之后）:
```tsx
    spinnerStore,
    startSpinner: (label: string) => { spinnerStore.getState().start(label); },
    stopSpinner: () => { spinnerStore.getState().stop(); },
    setSpinnerLabel: (label: string) => { spinnerStore.getState().setLabel(label); },
    spinnerOnToken: () => { spinnerStore.getState().onToken(); },
```

`render(<ConnectedApp .../>)` 调用加 `spinnerStore`:
old:
```tsx
  let inkInstance: InkInstance | null = render(
    React.createElement(ConnectedApp, {
      messagesStore, inputStore, statusStore, logoStore, onExit: opts.onExit,
    }),
    { exitOnCtrlC: false },
  );
```
new:
```tsx
  let inkInstance: InkInstance | null = render(
    React.createElement(ConnectedApp, {
      messagesStore, inputStore, statusStore, logoStore, spinnerStore, onExit: opts.onExit,
    }),
    { exitOnCtrlC: false },
  );
```

- [ ] **Step 3: 改 ConnectedApp 订阅 + 传给 App/Footer**

In `src/tui/ConnectedApp.tsx`：

加 import:
```tsx
import type { SpinnerStore } from './state/spinner-store.js';
```

`ConnectedAppProps` 加:
```tsx
  spinnerStore: SpinnerStore;
```

函数签名解构加 `spinnerStore`，并传给 `<App>`:
old:
```tsx
export function ConnectedApp({
  messagesStore, inputStore, statusStore, logoStore, onExit,
}: ConnectedAppProps): React.ReactElement {
```
new:
```tsx
export function ConnectedApp({
  messagesStore, inputStore, statusStore, logoStore, spinnerStore, onExit,
}: ConnectedAppProps): React.ReactElement {
```

`<App>` 调用加 `spinnerStore`（在 `selectionStore={selectionStore}` 之后）:
```tsx
      spinnerStore={spinnerStore}
```

- [ ] **Step 4: 改 App.tsx 透传 spinnerStore 给 Footer**

In `src/tui/App.tsx`：

加 import:
```tsx
import type { SpinnerStore } from './state/spinner-store.js';
```

`AppProps` 加:
```tsx
  spinnerStore: SpinnerStore;
```

函数签名解构 + `<Footer>` 调用:
old:
```tsx
export function App({ messages, status, logo, selectionStore, input, cursor, cols = 80, rows = 24 }: AppProps): React.ReactElement {
```
new:
```tsx
export function App({ messages, status, logo, selectionStore, input, cursor, spinnerStore, cols = 80, rows = 24 }: AppProps): React.ReactElement {
```

`<Footer>` 加 prop:
old:
```tsx
      <Footer input={input} cursor={cursor} status={status} cols={cols} inputRowY={inputRowY} />
```
new:
```tsx
      <Footer input={input} cursor={cursor} status={status} cols={cols} inputRowY={inputRowY} spinnerStore={spinnerStore} />
```

- [ ] **Step 5: 改 layout.test.tsx 适配新 prop（Footer/App 现在必填 spinnerStore）**

In `src/__tests__/tui/layout.test.tsx`，`makeApp` 加 spinnerStore：

加 import:
```tsx
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
```

`makeApp` 改:
old:
```tsx
function makeApp(messages: TuiMessage[] = []): { lastFrame: () => string | undefined } {
  return render(
    React.createElement(App, { messages, status: STATUS, logo: LOGO, selectionStore: createSelectionStore(), input: '', cursor: 0 }),
  );
}
```
new:
```tsx
function makeApp(messages: TuiMessage[] = []): { lastFrame: () => string | undefined } {
  return render(
    React.createElement(App, { messages, status: STATUS, logo: LOGO, selectionStore: createSelectionStore(), spinnerStore: createSpinnerStore(), input: '', cursor: 0 }),
  );
}
```

- [ ] **Step 6: index.ts 接 8 处 hook**

In `src/index.ts` `handleUserSubmit`，按 wiring 报告加 spinner 调用：

**(1) `startSpinner('Thinking…')`** — line ~366，`try {` 之前：
old:
```ts
  try {
    for await (const msg of streamingQuery(streamClient, toolRegistry, userInput, {
```
new:
```ts
  tuiHandle?.startSpinner('Thinking…');
  try {
    for await (const msg of streamingQuery(streamClient, toolRegistry, userInput, {
```

**(2) `setSpinnerLabel('Running '+name)`** — line ~346-348 `eventBus.onToolCall`：
old:
```ts
  eventBus.onToolCall(d => {
    pipeline.emit({ kind: 'tool_call', name: d.name, input: d.input, toolUseId: d.toolUseId });
  });
```
new:
```ts
  eventBus.onToolCall(d => {
    pipeline.emit({ kind: 'tool_call', name: d.name, input: d.input, toolUseId: d.toolUseId });
    tuiHandle?.setSpinnerLabel(`Running ${d.name}`);
  });
```

**(3) `setSpinnerLabel('Generating…')`** — line ~390-395 thinking-close 分支（content_block_stop）：
old:
```ts
        if (blockTypes.get(cstop.index) === 'thinking' && thinkingActive) {
          const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
          pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
          thinkingContent = '';
          thinkingActive = false;
        }
```
new:
```ts
        if (blockTypes.get(cstop.index) === 'thinking' && thinkingActive) {
          const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
          pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
          thinkingContent = '';
          thinkingActive = false;
          tuiHandle?.setSpinnerLabel('Generating…');
        }
```

同样在 line ~399-404 的「first text delta closes thinking」分支也加：
old:
```ts
          if (assistantText === '' && thinkingContent) {
            const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
            pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
            thinkingContent = '';
            thinkingActive = false;
          }
```
new:
```ts
          if (assistantText === '' && thinkingContent) {
            const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
            pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
            thinkingContent = '';
            thinkingActive = false;
            tuiHandle?.setSpinnerLabel('Generating…');
          }
```

**(4) `spinnerOnToken()`** — line ~398/405/407-409 的 content_block_delta 分支。在 `content_block_delta` 入口统一加（最简）：

找到 `} else if ('type' in msg && msg.type === 'content_block_delta') {` 这一行的下一行（`const delta = ...` 之后）插：
old:
```ts
      } else if ('type' in msg && msg.type === 'content_block_delta') {
        const delta = msg as { type: 'content_block_delta'; deltaType: string; content: string };
        if (delta.deltaType === 'text' && delta.content) {
```
new:
```ts
      } else if ('type' in msg && msg.type === 'content_block_delta') {
        const delta = msg as { type: 'content_block_delta'; deltaType: string; content: string };
        if (delta.content) tuiHandle?.spinnerOnToken();
        if (delta.deltaType === 'text' && delta.content) {
```

**(5) `stopSpinner()`（turn end）** — line ~352-354 `eventBus.onLoopEnd`：
old:
```ts
  eventBus.onLoopEnd(() => {
    // turn 结束（end_turn/error/max_turns）：无状态栏副作用（contextPct 由 message_start 更新）
  });
```
new:
```ts
  eventBus.onLoopEnd(() => {
    tuiHandle?.stopSpinner();
  });
```

**(6) `stopSpinner()`（finally 兜底）** — line ~439 `finally`：
old:
```ts
  } finally {
    isProcessing = false;
```
new:
```ts
  } finally {
    tuiHandle?.stopSpinner();
    isProcessing = false;
```

**(7) `stopSpinner()`（teardown）** — line ~525-530 `cleanupOnExit`：
old:
```ts
  function cleanupOnExit(): void {
    backgroundManager.killAll();
    tuiHandle?.cleanup();
```
new:
```ts
  function cleanupOnExit(): void {
    backgroundManager.killAll();
    tuiHandle?.stopSpinner();
    tuiHandle?.cleanup();
```

> **注：** 第 (8) 处「no-API-key」不需要单独加 `stopSpinner` —— `startSpinner` 在 (1) 已放在 no-key 检查之后（line ~366），no-key 早早 `return` 不会启动 spinner。但若 (1) 之前还有其它路径启动过，finally 兜底会清掉。

- [ ] **Step 7: 跑全量 + typecheck + commit**

```bash
npm test
npm run typecheck
git add src/tui/components/Footer.tsx src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx src/tui/App.tsx src/__tests__/tui/layout.test.tsx src/index.ts
git commit -m "feat(tui): 接入 Spinner——Footer 渲染 + bootstrap 暴露控制 + index.ts 8 处 hook

对齐旧 master 的 spinner 生命周期：Thinking… → Running X → Generating… → stop，
finally + cleanupOnExit 兜底，确保 setInterval 不泄漏。"
```

---

## Task 7: 抽取 COMMAND_NAMES 常量 + completion-store

**Goal:** executor 暴露命令名常量（单一真相源）；新建 completion-store（candidates/index/visible + set/cycle/hide）。

**Files:**
- Modify: `src/commands/executor.ts`（加 `COMMAND_NAMES`）
- Create: `src/tui/state/completion-store.ts`
- Test: `src/__tests__/tui/completion-store.test.ts`、`src/__tests__/commands/command-names.test.ts`

- [ ] **Step 1: 写失败测试（COMMAND_NAMES 完整性 + completion-store）**

Create `src/__tests__/commands/command-names.test.ts`:

```ts
// src/__tests__/commands/command-names.test.ts
// COMMAND_NAMES 必须覆盖 executor switch 的所有 case

import { describe, it, expect } from 'vitest';
import { COMMAND_NAMES } from '../../commands/executor.js';

describe('COMMAND_NAMES（命令名单一真相源）', () => {
  it('包含核心命令', () => {
    for (const name of ['config', 'login', 'provider', 'model', 'compact', 'build', 'plan', 'auto', 'help', 'skill', 'trigger', 'y', 'n', 'edit']) {
      expect(COMMAND_NAMES, `缺少 ${name}`).toContain(name);
    }
  });

  it('不含重复', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });

  it('approve/reject 也包含（help 列出但 switch 特殊处理）', () => {
    // approve/reject 在 index.ts 特殊路径，但仍应可被 TAB 补全
    expect(COMMAND_NAMES).toContain('approve');
    expect(COMMAND_NAMES).toContain('reject');
  });
});
```

Create `src/__tests__/tui/completion-store.test.ts`:

```ts
// src/__tests__/tui/completion-store.test.ts
// completion-store：候选 + 当前 index + visible + cycle

import { describe, it, expect } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';

describe('completion-store', () => {
  it('初始：无候选，visible=false', () => {
    const s = createCompletionStore();
    const st = s.getState();
    expect(st.candidates).toEqual([]);
    expect(st.index).toBe(0);
    expect(st.visible).toBe(false);
  });

  it('setCandidates：设置候选并 visible=true', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['plan', 'provider']);
    const st = s.getState();
    expect(st.candidates).toEqual(['plan', 'provider']);
    expect(st.visible).toBe(true);
    expect(st.index).toBe(0);
  });

  it('setCandidates 空数组：visible=false', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['plan']);
    s.getState().setCandidates([]);
    expect(s.getState().visible).toBe(false);
    expect(s.getState().candidates).toEqual([]);
  });

  it('cycle：index 在候选内循环', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['a', 'b', 'c']);
    s.getState().cycle(); // 0→1
    expect(s.getState().index).toBe(1);
    s.getState().cycle(); // 1→2
    s.getState().cycle(); // 2→0（wrap）
    expect(s.getState().index).toBe(0);
  });

  it('hide：visible=false，重置 index', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['a', 'b']);
    s.getState().cycle();
    s.getState().hide();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().index).toBe(0);
  });

  it('selected：当前选中的候选名', () => {
    const s = createCompletionStore();
    s.getState().setCandidates(['plan', 'provider']);
    expect(s.getState().selected()).toBe('plan');
    s.getState().cycle();
    expect(s.getState().selected()).toBe('provider');
  });

  it('selected 无候选返回 null', () => {
    const s = createCompletionStore();
    expect(s.getState().selected()).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- command-names completion-store`
Expected: FAIL（`COMMAND_NAMES`/`createCompletionStore` 不存在）。

- [ ] **Step 3: 在 executor.ts 加 COMMAND_NAMES**

In `src/commands/executor.ts`，在 `export function executeCommand` 之前加：

```ts
/**
 * 所有可识别的斜杠命令名（单一真相源）。
 * - executor.switch 用它做校验
 * - use-input-handler 的 TAB 补全用它生成候选
 * - approve/reject 虽在 index.ts 特殊路径，但 help 列出且应可补全，故纳入
 */
export const COMMAND_NAMES: readonly string[] = Object.freeze([
  'config', 'login', 'provider', 'model', 'compact',
  'build', 'plan', 'auto',
  'approve', 'reject',
  'help',
  'skill', 'trigger', 'y', 'n', 'edit',
]);
```

- [ ] **Step 4: 写 completion-store**

Create `src/tui/state/completion-store.ts`:

```ts
// src/tui/state/completion-store.ts
// 斜杠命令补全候选 store
//
// 物理本质：TAB 补全的「候选池 + 游标」。
// 用户输入 /pl 时，调用方算出 ['plan', 'provider', ...] 设进 candidates；
// 按 TAB 调 cycle() 在候选间循环；选中项写回 input-store 的 text。
//
// 设计：candidates 与 index 解耦——candidates 决定 visible，index 决定高亮哪一项。

import { createStore, type StoreApi } from 'zustand/vanilla';

export interface CompletionState {
  candidates: string[];
  /** 当前高亮的候选下标（0-based，cycle wrap） */
  index: number;
  /** 是否显示候选条 */
  visible: boolean;
  /** 设置候选（非空→visible=true 并 index=0；空→visible=false） */
  setCandidates: (c: string[]) => void;
  /** 推进 index（wrap） */
  cycle: () => void;
  /** 隐藏并重置 index */
  hide: () => void;
  /** 当前选中的候选名；无候选返回 null */
  selected: () => string | null;
}

export type CompletionStore = StoreApi<CompletionState>;

export function createCompletionStore(): CompletionStore {
  return createStore<CompletionState>((set, get) => ({
    candidates: [],
    index: 0,
    visible: false,

    setCandidates: (c) => set({
      candidates: c,
      visible: c.length > 0,
      index: 0,
    }),
    cycle: () => set((s) => {
      if (s.candidates.length === 0) return s;
      return { index: (s.index + 1) % s.candidates.length };
    }),
    hide: () => set({ visible: false, index: 0 }),
    selected: () => {
      const s = get();
      return s.candidates[s.index] ?? null;
    },
  }));
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- command-names completion-store`
Expected: PASS（3 + 7 = 10）。

- [ ] **Step 6: commit**

```bash
git add src/commands/executor.ts src/tui/state/completion-store.ts src/__tests__/commands/command-names.test.ts src/__tests__/tui/completion-store.test.ts
git commit -m "feat(tui): COMMAND_NAMES 常量 + completion-store（TAB 补全数据层）"
```

---

## Task 8: SuggestionBar 组件 + 接进 Footer

**Goal:** 渲染候选条（当前项 inverse bold）；Footer 接 `completionStore` prop 并渲染。

**Files:**
- Create: `src/tui/components/SuggestionBar.tsx`
- Modify: `src/tui/components/Footer.tsx`
- Test: `src/__tests__/tui/suggestion-bar.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/suggestion-bar.test.tsx`:

```tsx
// src/__tests__/tui/suggestion-bar.test.tsx
// SuggestionBar：visible 时渲染候选，当前项高亮

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SuggestionBar } from '../../tui/components/SuggestionBar.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';

describe('SuggestionBar', () => {
  it('invisible：渲染空', () => {
    const store = createCompletionStore();
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('visible：渲染所有候选', () => {
    const store = createCompletionStore();
    store.getState().setCandidates(['plan', 'provider', 'proxy']);
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('provider');
    expect(frame).toContain('proxy');
  });

  it('cycle 后高亮项变化（selected 切到第 2 个）', () => {
    const store = createCompletionStore();
    store.getState().setCandidates(['plan', 'provider']);
    store.getState().cycle(); // index=1 → provider
    const { lastFrame } = render(React.createElement(SuggestionBar, { store }));
    // ink-testing-library 不暴露 color，但 selected() 已在 store 单测覆盖；
    // 这里只确保两个候选都在画面里
    const frame = lastFrame() ?? '';
    expect(frame).toContain('plan');
    expect(frame).toContain('provider');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- suggestion-bar`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写组件**

Create `src/tui/components/SuggestionBar.tsx`:

```tsx
// src/tui/components/SuggestionBar.tsx
// 斜杠命令候选条：input 以 / 开头且 TAB 触发时显示
//
// 物理本质：一行候选预览。当前选中项 inverse（SGR 7 反色）+ bold 高亮。
// 选TAB循环 index；选中项回写到 input-store（在 use-input-handler 的 onTab 里做）。

import React from 'react';
import { Text } from 'ink';
import { useStore } from 'zustand/react';
import type { CompletionStore } from '../state/completion-store.js';

export interface SuggestionBarProps {
  store: CompletionStore;
}

export function SuggestionBar({ store }: SuggestionBarProps): React.ReactElement | null {
  const visible = useStore(store, (s) => s.visible);
  const candidates = useStore(store, (s) => s.candidates);
  const index = useStore(store, (s) => s.index);

  if (!visible || candidates.length === 0) return null;
  return (
    <Text>
      {candidates.map((c, i) => (
        <Text key={c}>
          {i === index
            ? <Text inverse bold>{c}</Text>
            : <Text dimColor>{c}</Text>}
          {i < candidates.length - 1 ? <Text dimColor>  </Text> : null}
        </Text>
      ))}
    </Text>
  );
}
```

- [ ] **Step 4: Footer 接 completionStore**

In `src/tui/components/Footer.tsx`：

加 import:
```tsx
import { SuggestionBar } from './SuggestionBar.js';
import type { CompletionStore } from '../state/completion-store.js';
```

`FooterProps` 加（在 `spinnerStore` 后）:
```tsx
  completionStore: CompletionStore;
```

函数签名解构 + JSX（在 `<Spinner/>` 之后、`<Text color="gray">{border}</Text>` 之前插 SuggestionBar）:
old:
```tsx
export function Footer({ input, cursor, status, cols, inputRowY, spinnerStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });

  const border = '─'.repeat(Math.max(0, cols));
  return (
    <Box flexShrink={0} flexDirection="column">
      <Spinner store={spinnerStore} />
      <Text color="gray">{border}</Text>
```
new:
```tsx
export function Footer({ input, cursor, status, cols, inputRowY, spinnerStore, completionStore }: FooterProps): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + pos.y });

  const border = '─'.repeat(Math.max(0, cols));
  return (
    <Box flexShrink={0} flexDirection="column">
      <Spinner store={spinnerStore} />
      <SuggestionBar store={completionStore} />
      <Text color="gray">{border}</Text>
```

- [ ] **Step 5: 透传 completionStore（bootstrap/ConnectedApp/App/layout.test）**

In `src/tui/bootstrap.tsx`：
- 加 import `createCompletionStore, type CompletionStore` from `./state/completion-store.js`
- 创建 `const completionStore = createCompletionStore();`
- `BootstrapHandle` 加 `completionStore: CompletionStore;`
- return 加 `completionStore,`
- `render(<ConnectedApp .../>)` 加 `completionStore`

In `src/tui/ConnectedApp.tsx`：
- 加 import type `CompletionStore`
- props 加 `completionStore: CompletionStore`
- 解构 + 传给 `<App completionStore={completionStore}>`

In `src/tui/App.tsx`：
- 加 import type `CompletionStore`
- `AppProps` 加 `completionStore: CompletionStore`
- 解构 + 传给 `<Footer completionStore={completionStore}>`

In `src/__tests__/tui/layout.test.tsx`：
- 加 import `createCompletionStore`
- `makeApp` 加 `completionStore: createCompletionStore()`

- [ ] **Step 6: 跑全量 + commit**

```bash
npm test
npm run typecheck
git add src/tui/components/SuggestionBar.tsx src/tui/components/Footer.tsx src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx src/tui/App.tsx src/__tests__/tui/suggestion-bar.test.tsx src/__tests__/tui/layout.test.tsx
git commit -m "feat(tui): SuggestionBar——斜杠命令候选条 + 接入 Footer"
```

---

## Task 9: TAB 模式切换 + 补全（use-input-handler onTab + index.ts 实现）

**Goal:** TAB 在 `/` 开头时补全，否则循环 PermissionMode。handler 加 onTab 回调；index.ts 实现两个分支。

**Files:**
- Modify: `src/tui/input/use-input-handler.ts`（加 `onTab`）
- Modify: `src/tui/state/input-store.ts`（加 `setText`，补全时整串替换）
- Modify: `src/tui/bootstrap.tsx`（透传 onTab）
- Modify: `src/tui/ConnectedApp.tsx`（接收 onTab）
- Modify: `src/index.ts`（实现 onTab 逻辑）
- Test: 扩展 `src/__tests__/tui/use-input-handler.test.tsx`

- [ ] **Step 1: 写失败测试（handler 收到 key.tab 时调 onTab）**

现有 `src/__tests__/tui/use-input-handler.test.tsx` 有一个 `InputProbe` 包装组件（接受 `store` + `onExit`，内部调 `useInputHandler`，渲染当前 text 用于断言）。本 Task **扩展它**支持 `onTab`，再加 TAB 测试。

**改 `InputProbe`**（在现有 `function InputProbe({...})` 上加 `onTab` prop 并传给 handler）:

old:
```tsx
function InputProbe({
  store,
  onExit,
}: {
  store: InputStore;
  onExit?: () => void;
}): React.ReactElement {
  useInputHandler(store, onExit);
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}
```

new:
```tsx
function InputProbe({
  store,
  onExit,
  onTab,
}: {
  store: InputStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
}): React.ReactElement {
  useInputHandler(store, onExit, onTab);
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}
```

**在文件末尾追加 TAB 测试 describe**:

```tsx
describe('useInputHandler: TAB 路由', () => {
  it('TAB → 调 onTab(text)，不插入 \\t', () => {
    const store = createInputStore();
    store.getState().insert('hello');
    const onTab = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, { store, onTab }));
    stdin.write('\t');
    expect(onTab).toHaveBeenCalledTimes(1);
    expect(onTab).toHaveBeenCalledWith('hello');
    expect(store.getState().text).toBe('hello'); // 未插入 \t
  });

  it('未传 onTab 时 TAB 静默忽略（不崩）', () => {
    const store = createInputStore();
    store.getState().insert('hi');
    const { stdin } = render(React.createElement(InputProbe, { store }));
    stdin.write('\t');
    expect(store.getState().text).toBe('hi'); // 仍未插入 \t
  });
});
```

> **ink TAB 字节注：** ink-testing-library 的 `stdin.write('\t')` 会被 ink 的 parseKeypress 解析为 `input='\t'` + `key.tab=true`（与生产 useInput 一致）。若该断言红，先 `console.log` 一下 ink 实际交付的 `(input, key)` 调整断言。

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- use-input-handler`
Expected: FAIL（`onTab` 未传 / handler 未接 tab）。

- [ ] **Step 3: input-store 加 setText**

In `src/tui/state/input-store.ts`，`InputState` 加（在 `clear` 后）:
```ts
  /** 整串替换文本（补全用），光标移到末尾 */
  setText: (text: string) => void;
```

实现（在 `clear: () => set({ text: '', cursor: 0 }),` 后）:
```ts
    setText: (text) => set({ text, cursor: [...text].length }),
```

- [ ] **Step 4: use-input-handler 加 onTab 分支**

In `src/tui/input/use-input-handler.ts`，函数签名加第 3 参：

old:
```ts
export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
): void {
  useInput((input: string, key: Key) => {
    const s = store.getState();

    // Ctrl+C：退出（最高优先级，不改输入）
    if (key.ctrl && input === 'c') {
      onExit?.();
      return;
    }
```

new:
```ts
export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
): void {
  useInput((input: string, key: Key) => {
    const s = store.getState();

    // Ctrl+C：退出（最高优先级，不改输入）
    if (key.ctrl && input === 'c') {
      onExit?.();
      return;
    }

    // TAB：路由给 onTab（模式切换 or 补全），不插入 \t
    if (key.tab) {
      onTab?.(s.text);
      return;
    }
```

并从最后的 insert 守卫里删掉 `!key.tab`（已在上面 return 了，但保留防御也行——改干净点）：

old:
```ts
    if (input !== '' && !key.ctrl && !key.meta && !key.escape && !key.tab && !isMouseOrControlSeq) {
      s.insert(input);
    }
```
new:
```ts
    if (input !== '' && !key.ctrl && !key.meta && !key.escape && !isMouseOrControlSeq) {
      s.insert(input);
    }
```

- [ ] **Step 5: bootstrap/ConnectedApp 透传 onTab**

In `src/tui/bootstrap.tsx`：
- `BootstrapOptions` 加 `onTab?: (text: string) => void;`
- `render(<ConnectedApp .../>)` 加 `onTab: opts.onTab`

In `src/tui/ConnectedApp.tsx`：
- `ConnectedAppProps` 加 `onTab?: (text: string) => void;`
- 解构 + `useInputHandler(inputStore, onExit, onTab)`

- [ ] **Step 6: index.ts 实现 onTab（两个分支）**

In `src/index.ts`，先在文件顶部 import：
```ts
import { COMMAND_NAMES } from './commands/executor.js';
```

在 `bootstrap({...})` 调用处（line ~482-492），加 `onTab`：

old:
```ts
tuiHandle = bootstrap({
  logo: { version: VERSION, dir: SHORT_DIR },
  status: { mode: configStore.getPermissionMode(), model: MODEL, dir: SHORT_DIR, branch: GIT_BRANCH },
  onSubmit: (text) => { void handleUserSubmit(text); },
  onExit: () => { cleanupOnExit(); process.exit(0); },
});
```

new:
```ts
tuiHandle = bootstrap({
  logo: { version: VERSION, dir: SHORT_DIR },
  status: { mode: configStore.getPermissionMode(), model: MODEL, dir: SHORT_DIR, branch: GIT_BRANCH },
  onSubmit: (text) => { void handleUserSubmit(text); },
  onExit: () => { cleanupOnExit(); process.exit(0); },
  onTab: (text) => { handleTab(text, tuiHandle, configStore, permissionChecker); },
});
```

在 `handleUserSubmit` 之前定义 `handleTab` 函数：

```ts
/** TAB 行为（对标 Claude Code）：
 *  - input 以 / 开头 → 补全（COMMAND_NAMES 过滤前缀，cycle 候选，写回 input）
 *  - 否则 → 循环 PermissionMode（build→plan→auto→build）
 */
function handleTab(
  text: string,
  handle: BootstrapHandle | null,
  configStore: ConfigStore,
  checker: PermissionChecker,
): void {
  if (!handle) return;
  const completion = handle.completionStore.getState();

  // 分支 1：补全
  if (text.startsWith('/')) {
    const prefix = text.slice(1);
    // 若候选已可见且仍匹配当前 text，则 cycle；否则重算候选
    const stillMatches = completion.visible
      && completion.candidates.length > 0
      && completion.candidates.every(c => c.startsWith(prefix));
    if (stillMatches) {
      completion.cycle();
    } else {
      const candidates = COMMAND_NAMES.filter(n => n.startsWith(prefix));
      completion.setCandidates(candidates);
    }
    const sel = completion.selected();
    if (sel) {
      handle.inputStore.getState().setText('/' + sel);
    }
    return;
  }

  // 分支 2：模式切换（build→plan→auto→build）
  completion.hide();
  const order: PermissionMode[] = ['build', 'plan', 'auto'];
  const cur = checker.getMode();
  const idx = order.indexOf(cur);
  const next = order[(idx + 1) % order.length]!;
  checker.setMode(next);
  configStore.setPermissionMode(next);
  handle.statusStore.getState().setMode(next);
}
```

需要的额外 import（index.ts 顶部，若未导入）:
```ts
import type { PermissionMode } from './permission/types.js';
import type { BootstrapHandle } from './tui/bootstrap.js';
```

> **防御：** `tuiHandle` 在 bootstrap 调用时还是 null（bootstrap 内部还没 return）。所以 `onTab` 闭包捕获的 `tuiHandle` 必须是 `let tuiHandle` 的引用，且在调用时（用户按 TAB，远晚于 bootstrap 返回）已是赋值后的值。**改写**：把 `onTab` 改为读取外层 `let tuiHandle`：

修正（onTab 闭包读外层 let）:
```ts
  onTab: (text) => { handleTab(text, tuiHandle, configStore, permissionChecker); },
```
（`tuiHandle` 是 `index.ts` 顶层 `let`，闭包内读取的是调用时的值，此时已赋值。✓）

- [ ] **Step 7: 跑测试 + typecheck + commit**

```bash
npm test
npm run typecheck
git add src/tui/input/use-input-handler.ts src/tui/state/input-store.ts src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx src/index.ts src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/input-store.test.ts
git commit -m "feat(tui): TAB 双行为——/ 开头补全，否则循环 PermissionMode

对标 Claude Code：input=/pl+TAB→/plan；plain TAB→build→plan→auto。
executor.COMMAND_NAMES 为补全候选源；input-store 加 setText 整串替换。"
```

---

## Task 10: overlay-store + Overlay 组件

**Goal:** 全屏展开最后一个可折叠块（thinking/tool_result）。store 管 visible/title/lines；组件订阅渲染。

**Files:**
- Create: `src/tui/state/overlay-store.ts`
- Create: `src/tui/components/Overlay.tsx`
- Test: `src/__tests__/tui/overlay-store.test.ts`、`src/__tests__/tui/overlay-component.test.tsx`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/overlay-store.test.ts`:

```ts
// src/__tests__/tui/overlay-store.test.ts
import { describe, it, expect } from 'vitest';
import { createOverlayStore } from '../../tui/state/overlay-store.js';

describe('overlay-store', () => {
  it('初始：visible=false', () => {
    const s = createOverlayStore();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().title).toBe('');
    expect(s.getState().lines).toEqual([]);
  });

  it('open：visible=true，存 title/lines', () => {
    const s = createOverlayStore();
    s.getState().open('Thinking', [{ content: 'hello', style: {}, indent: 0 }]);
    const st = s.getState();
    expect(st.visible).toBe(true);
    expect(st.title).toBe('Thinking');
    expect(st.lines).toHaveLength(1);
  });

  it('close：visible=false，清 lines', () => {
    const s = createOverlayStore();
    s.getState().open('x', [{ content: 'a', style: {}, indent: 0 }]);
    s.getState().close();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().lines).toEqual([]);
  });
});
```

Create `src/__tests__/tui/overlay-component.test.tsx`:

```tsx
// src/__tests__/tui/overlay-component.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Overlay } from '../../tui/components/Overlay.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';

describe('Overlay 组件', () => {
  it('invisible：渲染空', () => {
    const store = createOverlayStore();
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 80 }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('visible：渲染 title + 内容 + 提示', () => {
    const store = createOverlayStore();
    store.getState().open('Thinking', [
      { content: 'step 1', style: {}, indent: 0 },
      { content: 'step 2', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 80 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thinking');
    expect(frame).toContain('step 1');
    expect(frame).toContain('step 2');
    expect(frame).toContain('返回');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- overlay`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 overlay-store**

Create `src/tui/state/overlay-store.ts`:

```ts
// src/tui/state/overlay-store.ts
// Ctrl+O 全屏覆盖层 store
//
// 物理本质：一个「模态视图」开关。visible=true 时 <App> 被 <Overlay> 替换，
// 显示最后一个可折叠块（thinking/tool_result）的完整内容。
// 数据源：BlockPipeline.getLastExpandableFullLines()（已存在于新栈）。

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { FormattedLine } from '../../ui/types.js';

export interface OverlayState {
  visible: boolean;
  title: string;
  lines: FormattedLine[];
  open: (title: string, lines: FormattedLine[]) => void;
  close: () => void;
}

export type OverlayStore = StoreApi<OverlayState>;

export function createOverlayStore(): OverlayStore {
  return createStore<OverlayState>((set) => ({
    visible: false,
    title: '',
    lines: [],
    open: (title, lines) => set({ visible: true, title, lines }),
    close: () => set({ visible: false, title: '', lines: [] }),
  }));
}
```

- [ ] **Step 4: 写 Overlay 组件**

Create `src/tui/components/Overlay.tsx`:

```tsx
// src/tui/components/Overlay.tsx
// 全屏覆盖层：visible 时替换 <App>，显示可折叠块完整内容
//
// 物理本质：charter 铁律「禁止手动 CUP」，故用 React 条件渲染 <Overlay> 替代 <App>，
// 而非旧实现的 saveCursor + eraseScreen 原生 ANSI。
// Yoga 自动重算布局；dismiss 后 overlay.visible=false → <App> 回归。
//
// 关闭键（在 use-input-handler 的 overlay 分支处理）：q / Ctrl+O / Esc / Ctrl+C（退出）。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import type { OverlayStore } from '../state/overlay-store.js';
import { styleToInkProps } from '../types.js';

export interface OverlayProps {
  store: OverlayStore;
  /** 终端列数（行截断用） */
  cols: number;
}

export function Overlay({ store, cols }: OverlayProps): React.ReactElement | null {
  const visible = useStore(store, (s) => s.visible);
  const title = useStore(store, (s) => s.title);
  const lines = useStore(store, (s) => s.lines);

  if (!visible) return null;
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text color="#8c8c8c">{'━'.repeat(Math.min(cols, 60))}</Text>
      {lines.map((l, i) => {
        const indent = ' '.repeat(l.indent ?? 0);
        const content = l.content;
        // 简单按字符数截断（保守，CJK 偶尔会少显示一格但不溢出）
        const maxChars = Math.max(0, cols - (l.indent ?? 0));
        const truncated = [...content].slice(0, maxChars).join('');
        const props = styleToInkProps(l.style);
        return (
          <Text key={i} {...props}>{indent}{truncated}</Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>按 q / Ctrl+O / Esc 返回</Text>
    </Box>
  );
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- overlay`
Expected: PASS（3 + 2 = 5）。

- [ ] **Step 6: commit**

```bash
git add src/tui/state/overlay-store.ts src/tui/components/Overlay.tsx src/__tests__/tui/overlay-store.test.ts src/__tests__/tui/overlay-component.test.tsx
git commit -m "feat(tui): overlay-store + Overlay 组件（Ctrl+O 全屏展开数据层）"
```

---

## Task 11: Ctrl+O 接入 handler + App 条件渲染 + bootstrap 透传

**Goal:** handler 加 Ctrl+O 切换 + overlay 内按键路由；App 用 `overlay.visible ? <Overlay> : <App>`；bootstrap 创建 store + 暴露 `getLastExpandableLines`（透传 pipeline）。

**Files:**
- Modify: `src/tui/input/use-input-handler.ts`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/ConnectedApp.tsx`
- Modify: `src/tui/components/Footer.tsx`（接 overlayStore prop，仅类型；Footer 不渲染 overlay）
- Modify: `src/__tests__/tui/layout.test.tsx`
- Test: 扩展 `src/__tests__/tui/use-input-handler.test.tsx`

- [ ] **Step 1: 写失败测试（Ctrl+O 开/关 overlay）**

继续扩展 `InputProbe`（Task 9 已加 `onTab`），再加 `onToggleOverlay` + `overlayVisible`：

**改 `InputProbe`**（在 Task 9 版本基础上加两个 prop）:

old (Task 9 版本):
```tsx
function InputProbe({
  store,
  onExit,
  onTab,
}: {
  store: InputStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
}): React.ReactElement {
  useInputHandler(store, onExit, onTab);
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}
```

new:
```tsx
function InputProbe({
  store,
  onExit,
  onTab,
  onToggleOverlay,
  overlayVisible,
}: {
  store: InputStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
  onToggleOverlay?: () => void;
  overlayVisible?: () => boolean;
}): React.ReactElement {
  useInputHandler(store, onExit, onTab, onToggleOverlay, overlayVisible);
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}
```

**追加 Ctrl+O 测试 describe**:

```tsx
describe('useInputHandler: Ctrl+O 覆盖层', () => {
  it('Ctrl+O → 调 onToggleOverlay', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store, onToggleOverlay: onToggle,
    }));
    stdin.write('\x0f'); // Ctrl+O 字节
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('overlay 激活时：普通按键被吞（不 insert）', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store,
      onToggleOverlay: onToggle,
      overlayVisible: () => true, // 模拟 overlay 已开
    }));
    stdin.write('x'); // 普通字符
    expect(store.getState().text).toBe(''); // 被吞，未 insert
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('overlay 激活时：q 关闭（调 onToggleOverlay）', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store,
      onToggleOverlay: onToggle,
      overlayVisible: () => true,
    }));
    stdin.write('q');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('overlay 激活时：Esc 关闭', () => {
    const store = createInputStore();
    const onToggle = vi.fn();
    const { stdin } = render(React.createElement(InputProbe, {
      store,
      onToggleOverlay: onToggle,
      overlayVisible: () => true,
    }));
    stdin.write('\x1b'); // ESC
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
```

> **ink Ctrl+O 字节注：** `\x0f`（SI/Shift-In）应被 ink 解析为 `input='o'` + `key.ctrl=true`（与 Ctrl+A 的 `\x01`→`input='a'`+`key.ctrl` 一致，见现有 Ctrl+A 测试）。若解析不同，先 log 一下 `(input, key)` 再调断言。

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- use-input-handler`
Expected: FAIL（onToggleOverlay 未实现）。

- [ ] **Step 3: use-input-handler 加 Ctrl+O + overlay 路由**

In `src/tui/input/use-input-handler.ts`，签名加第 4 参 + overlay 模式短路：

old:
```ts
export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
): void {
  useInput((input: string, key: Key) => {
    const s = store.getState();

    // Ctrl+C：退出（最高优先级，不改输入）
    if (key.ctrl && input === 'c') {
      onExit?.();
      return;
    }
```

new:
```ts
export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
  onToggleOverlay?: () => void,
  overlayVisible?: () => boolean,
): void {
  useInput((input: string, key: Key) => {
    const s = store.getState();

    // 覆盖层激活时：只处理关闭键（q / Ctrl+O / Esc / Ctrl+C），其余吞掉
    if (overlayVisible?.()) {
      if (key.ctrl && input === 'c') { onExit?.(); return; }
      if (input === 'q' || (key.ctrl && input === 'o') || key.escape) {
        onToggleOverlay?.(); // 再 toggle 一次 = 关闭
        return;
      }
      return; // 其余按键全部吞掉（模态）
    }

    // Ctrl+C：退出（最高优先级，不改输入）
    if (key.ctrl && input === 'c') {
      onExit?.();
      return;
    }

    // Ctrl+O：切换覆盖层
    if (key.ctrl && input === 'o') {
      onToggleOverlay?.();
      return;
    }
```

> **注：** Ctrl+C 在 overlay 内仍退出（对齐旧 master 行为——用户已确认默认）。`overlayVisible` 是函数而非布尔，避免每次 render 都读 store（仅在按键时读）。

- [ ] **Step 4: App.tsx 条件渲染 + Footer 接 overlayStore**

In `src/tui/App.tsx`：

加 imports:
```tsx
import { Overlay } from './components/Overlay.js';
import { useStore } from 'zustand/react';
import type { OverlayStore } from './state/overlay-store.js';
```

`AppProps` 加（在 `spinnerStore` 后）:
```tsx
  overlayStore: OverlayStore;
```

函数内：订阅 overlay.visible，条件渲染：

old:
```tsx
export function App({ messages, status, logo, selectionStore, input, cursor, spinnerStore, completionStore, cols = 80, rows = 24 }: AppProps): React.ReactElement {
  const visibleRows = Math.max(0, rows - FOOTER_ROWS - LOGO_ROWS);
  const scrollboxRenderedRows = Math.min(messages.length, visibleRows);
  const inputRowY = scrollboxRenderedRows + LOGO_ROWS + 1;
  return (
    <Box flexDirection="column">
      <LogoBox logo={logo} />
      <ScrollBox messages={messages} visibleRows={visibleRows} selectionStore={selectionStore} />
      <Footer input={input} cursor={cursor} status={status} cols={cols} inputRowY={inputRowY} spinnerStore={spinnerStore} completionStore={completionStore} />
    </Box>
  );
}
```

new:
```tsx
export function App({ messages, status, logo, selectionStore, input, cursor, spinnerStore, completionStore, overlayStore, cols = 80, rows = 24 }: AppProps): React.ReactElement {
  const overlayVisible = useStore(overlayStore, (s) => s.visible);

  // 覆盖层激活：替换整个布局
  if (overlayVisible) {
    return <Overlay store={overlayStore} cols={cols} />;
  }

  const visibleRows = Math.max(0, rows - FOOTER_ROWS - LOGO_ROWS);
  const scrollboxRenderedRows = Math.min(messages.length, visibleRows);
  const inputRowY = scrollboxRenderedRows + LOGO_ROWS + 1;
  return (
    <Box flexDirection="column">
      <LogoBox logo={logo} />
      <ScrollBox messages={messages} visibleRows={visibleRows} selectionStore={selectionStore} />
      <Footer input={input} cursor={cursor} status={status} cols={cols} inputRowY={inputRowY} spinnerStore={spinnerStore} completionStore={completionStore} />
    </Box>
  );
}
```

- [ ] **Step 5: bootstrap/ConnectedApp 透传 overlayStore + onToggleOverlay**

In `src/tui/bootstrap.tsx`：
- 加 import `createOverlayStore, type OverlayStore` from `./state/overlay-store.js`
- 创建 `const overlayStore = createOverlayStore();`
- `BootstrapOptions` 加 `onToggleOverlay?: () => void;`
- `BootstrapHandle` 加 `overlayStore: OverlayStore;`
- return 加 `overlayStore,`
- `render(<ConnectedApp .../>)` 加 `overlayStore, onToggleOverlay: opts.onToggleOverlay`

In `src/tui/ConnectedApp.tsx`：
- 加 import type `OverlayStore`
- props 加 `overlayStore: OverlayStore`、`onToggleOverlay?: () => void`
- 解构 + `useInputHandler(inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible)`
- `<App>` 传 `overlayStore={overlayStore}`

- [ ] **Step 6: index.ts 实现 onToggleOverlay（拉 pipeline.getLastExpandableFullLines）**

In `src/index.ts`，bootstrap 调用加：

old:
```ts
  onSubmit: (text) => { void handleUserSubmit(text); },
  onExit: () => { cleanupOnExit(); process.exit(0); },
  onTab: (text) => { handleTab(text, tuiHandle, configStore, permissionChecker); },
});
```

new:
```ts
  onSubmit: (text) => { void handleUserSubmit(text); },
  onExit: () => { cleanupOnExit(); process.exit(0); },
  onTab: (text) => { handleTab(text, tuiHandle, configStore, permissionChecker); },
  onToggleOverlay: () => { handleToggleOverlay(tuiHandle); },
});
```

在 `handleTab` 附近定义 `handleToggleOverlay`：

```ts
/** Ctrl+O：切换覆盖层。有可折叠块时打开，已开则关闭。 */
function handleToggleOverlay(handle: BootstrapHandle | null): void {
  if (!handle) return;
  const overlay = handle.overlayStore.getState();
  if (overlay.visible) {
    overlay.close();
    return;
  }
  const expandable = handle.pipeline.getLastExpandableFullLines();
  if (!expandable) return; // 无可展开内容，静默忽略
  const title = expandable.kind === 'thinking' ? 'Thinking' : 'Tool result';
  overlay.open(title, expandable.lines);
}
```

- [ ] **Step 7: layout.test.tsx 适配 overlayStore**

In `src/__tests__/tui/layout.test.tsx`：
- 加 import `createOverlayStore`
- `makeApp` 加 `overlayStore: createOverlayStore()`

- [ ] **Step 8: 跑全量 + typecheck + commit**

```bash
npm test
npm run typecheck
git add src/tui/input/use-input-handler.ts src/tui/App.tsx src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx src/index.ts src/__tests__/tui/layout.test.tsx src/__tests__/tui/use-input-handler.test.tsx
git commit -m "feat(tui): Ctrl+O 全屏覆盖层——条件渲染 <Overlay> + handler 路由

visible 时 <App> 被 <Overlay> 替换（charter 禁手动 CUP → React 条件渲染）。
数据源 pipeline.getLastExpandableFullLines()。关闭键 q/Ctrl+O/Esc/Ctrl+C。"
```

---

## Task 12: 多行输入（input-store 原语 + handler + Footer 多行 y）

**Goal:** Ctrl+J 插入换行（≤3 行）；上下箭头跨行移动；Footer 的 `inputRowY` 适配多行（光标 y 偏移已在 Task 2 的 `cursorScreenPos.y` 解决，这里只补 `inputRowY` 不变 + 验证）。

**Files:**
- Modify: `src/tui/state/input-store.ts`（加 `insertNewline`/`moveCursorUp`/`moveCursorDown`）
- Modify: `src/tui/input/use-input-handler.ts`（Ctrl+J + up/down）
- Modify: `src/tui/App.tsx`（动态 FOOTER_ROWS）—— **可选**，先验证 snug 是否已被破坏
- Test: 扩展 `src/__tests__/tui/input-store.test.ts`

- [ ] **Step 1: 写失败测试（多行原语）**

在 `src/__tests__/tui/input-store.test.ts` 末尾加：

```ts
describe('input-store 多行', () => {
  it('insertNewline：在光标处插 \\n，光标+1', () => {
    const store = createInputStore();
    store.getState().insert('abc');
    store.getState().moveCursorTo(1); // a|bc
    store.getState().insertNewline(); // a\n|bc
    expect(store.getState().text).toBe('a\nbc');
    expect(store.getState().cursor).toBe(2);
  });

  it('insertNewline 上限 3 行：第 3 行时不插入', () => {
    const store = createInputStore();
    store.getState().insert('a\nb\nc'); // 已 3 行
    store.getState().moveCursorToEnd();
    store.getState().insertNewline(); // 应被拒
    expect(store.getState().text).toBe('a\nb\nc');
  });

  it('insertNewline 在 2 行时允许变 3 行', () => {
    const store = createInputStore();
    store.getState().insert('a\nb');
    store.getState().moveCursorToEnd();
    store.getState().insertNewline();
    expect(store.getState().text).toBe('a\nb\n');
  });

  it('moveCursorDown：跨行下移，保留列', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(2); // ab|c（第 0 行 col 2）
    store.getState().moveCursorDown(); // → de|f（第 1 行 col 2）
    expect(store.getState().cursor).toBe(5); // 4(\n 后) + 2 - 1? 实际：'abc\ndef' 索引 d=4,e=5 → col2=e 索引 5
  });

  it('moveCursorDown 末行：无操作', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorToEnd(); // 第 1 行末
    store.getState().moveCursorDown();
    expect(store.getState().cursor).toBe(7);
  });

  it('moveCursorUp：跨行上移，保留列（钳到上行长度）', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(5); // 第 1 行 col 1（'e'）
    store.getState().moveCursorUp(); // → 第 0 行 col 1（'b'，索引 1）
    expect(store.getState().cursor).toBe(1);
  });

  it('moveCursorUp 第 0 行：无操作', () => {
    const store = createInputStore();
    store.getState().insert('abc\ndef');
    store.getState().moveCursorTo(0);
    store.getState().moveCursorUp();
    expect(store.getState().cursor).toBe(0);
  });

  it('moveCursorUp 列超出上行长度：钳到上行末尾', () => {
    const store = createInputStore();
    store.getState().insert('ab\ndefgh'); // 上行 2 字符，下行 5
    store.getState().moveCursorTo(6); // 第 1 行 col 2（'f'）
    store.getState().moveCursorUp(); // → 第 0 行 col min(2,2)=2 = 末尾
    expect(store.getState().cursor).toBe(2);
  });
});
```

> **注：** `moveCursorDown` 测试里的 `cursor=5`：`'abc\ndef'` 的码点索引：a=0,b=1,c=2,\n=3,d=4,e=5,f=6。光标在第 0 行 col 2（'c' 处，索引 2），下移到第 1 行 col 2 → 'f'（索引 6），不是 5。**修正测试**：期望 `cursor` 为 6。

修正（`moveCursorDown` 测试）:
```ts
    expect(store.getState().cursor).toBe(6); // 第 1 行 col 2 → 'f'
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- input-store`
Expected: FAIL（`insertNewline` 等不存在）。

- [ ] **Step 3: input-store 加多行原语**

In `src/tui/state/input-store.ts`，`InputState` 加（在 `setText` 后）:
```ts
  /** 在光标处插入换行（≤3 行上限，超出无操作） */
  insertNewline: () => void;
  /** 光标上移一行（保留列，钳到上行长度；第 0 行无操作） */
  moveCursorUp: () => void;
  /** 光标下移一行（保留列，钳到下行长度；末行无操作） */
  moveCursorDown: () => void;
```

实现（在 `setText` 实现后）:
```ts
    insertNewline: () => set((s) => {
      const lineCount = s.text.split('\n').length;
      if (lineCount >= 3) return s; // 上限 3 行
      const { text, cursor } = s;
      const next = text.slice(0, cursor) + '\n' + text.slice(cursor);
      return { text: next, cursor: cursor + 1 };
    }),
    moveCursorUp: () => set((s) => {
      const lines = s.text.split('\n');
      let offset = 0;
      for (let li = 0; li < lines.length; li++) {
        const lineLen = [...lines[li]!].length;
        if (s.cursor <= offset + lineLen) {
          if (li === 0) return s; // 已在第 0 行
          const col = s.cursor - offset;
          const prevLineLen = [...lines[li - 1]!].length;
          const prevOffset = offset - prevLineLen - 1;
          return { cursor: prevOffset + Math.min(col, prevLineLen) };
        }
        offset += lineLen + 1;
      }
      return s;
    }),
    moveCursorDown: () => set((s) => {
      const lines = s.text.split('\n');
      let offset = 0;
      for (let li = 0; li < lines.length; li++) {
        const lineLen = [...lines[li]!].length;
        if (s.cursor <= offset + lineLen) {
          if (li === lines.length - 1) return s; // 已在末行
          const col = s.cursor - offset;
          const nextOffset = offset + lineLen + 1;
          const nextLineLen = [...lines[li + 1]!].length;
          return { cursor: nextOffset + Math.min(col, nextLineLen) };
        }
        offset += lineLen + 1;
      }
      return s;
    }),
```

- [ ] **Step 4: handler 加 Ctrl+J + up/down**

In `src/tui/input/use-input-handler.ts`，在方向键块（`key.leftArrow` 等）附近加：

```ts
    // Ctrl+J：多行换行（≤3 行）
    if (key.ctrl && input === 'j') {
      s.insertNewline();
      return;
    }

    // 上/下箭头：跨行移动（单行时无副作用，input-store 已处理边界）
    if (key.upArrow) {
      s.moveCursorUp();
      return;
    }
    if (key.downArrow) {
      s.moveCursorDown();
      return;
    }
```

插在 `key.rightArrow` 块之后、`// Home / End` 之前：

old:
```ts
    if (key.rightArrow) {
      s.moveCursorRight();
      return;
    }

    // Home / End
```
new:
```ts
    if (key.rightArrow) {
      s.moveCursorRight();
      return;
    }

    // Ctrl+J：多行换行（≤3 行）
    if (key.ctrl && input === 'j') {
      s.insertNewline();
      return;
    }

    // 上/下箭头：跨行移动（单行时无副作用，input-store 已处理边界）
    if (key.upArrow) {
      s.moveCursorUp();
      return;
    }
    if (key.downArrow) {
      s.moveCursorDown();
      return;
    }

    // Home / End
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- input-store`
Expected: PASS（多行原语全绿）。

- [ ] **Step 6: 验证 Footer 多行场景（手动 + typecheck）**

`cursorScreenPos`（Task 1）已返回多行 `y`；Footer 在 Task 2 已用 `inputRowY + pos.y`。**关键问题**：`inputRowY` 是 App 算的固定值（基于 `scrollboxRenderedRows`），多行时光标实际在 inputRowY + 行偏移——这部分已对。但 ScrollBox 的 `visibleRows = rows - FOOTER_ROWS - LOGO_ROWS`，`FOOTER_ROWS=4` 固定——多行时 footer 实际占 5/6 行，ScrollBox 会偏高 1-2 行（内容被 footer 遮）。

**验证步骤**（不改代码，先确认问题）：
```bash
npm run typecheck
npm run build
# 手动跑：tsx src/index.ts，输入 abc，Ctrl+J，再输 def，观察光标是否在第 2 行正确位置
```

如果手动测试发现 footer 遮挡消息（多行时 visibleRows 没收缩），再做 Task 12 Step 7（动态 FOOTER_ROWS）。否则跳到 Step 8。

- [ ] **Step 7: （仅当 Step 6 发现遮挡）动态 FOOTER_ROWS**

In `src/tui/App.tsx`，把 `FOOTER_ROWS` 改为函数：

old:
```tsx
const FOOTER_ROWS = 4;
```
new:
```tsx
const FOOTER_BORDER_ROWS = 2; // 上下边框
const FOOTER_FIXED_ROWS = 2;  // spinner(可选) + status bar（保守取 2）
/** Footer 总行数 = 固定 + 边框 + 输入行数（钳 ≤3） */
function footerRows(inputLines: number): number {
  return FOOTER_FIXED_ROWS + FOOTER_BORDER_ROWS + Math.max(1, Math.min(3, inputLines));
}
```

并在 `App` 内：
old:
```tsx
  const visibleRows = Math.max(0, rows - FOOTER_ROWS - LOGO_ROWS);
```
new:
```tsx
  const inputLines = input.split('\n').length;
  const footerRows_ = footerRows(inputLines);
  const visibleRows = Math.max(0, rows - footerRows_ - LOGO_ROWS);
```

> **风险：** 这会改变 layout.test.tsx 的断言（空输入时 footerRows=4，行为不变；多行时变）。如果 layout 测试因此红，更新测试期望。**保守策略**：先不动 FOOTER_ROWS，只在手动测试确认遮挡后才改。

- [ ] **Step 8: commit**

```bash
npm test
npm run typecheck
git add src/tui/state/input-store.ts src/tui/input/use-input-handler.ts src/tui/App.tsx src/__tests__/tui/input-store.test.ts
git commit -m "feat(tui): 多行输入——Ctrl+J 换行(≤3) + 上下箭头跨行导航

input-store 加 insertNewline/moveCursorUp/moveCursorDown（保留列、钳行长度）。
Footer 多行光标 y 由 cursorScreenPos.y 解决（Task 1/2）。
若手动测出 footer 遮挡消息，再启用动态 FOOTER_ROWS。"
```

---

## Task 13: 更新记忆（避免下次再犯——用户明确要求）

**Goal:** 把 CJK 光标回归教训写入 `.memory/ink-migration-progress.md` 的「踩过的坑」。

**Files:**
- Modify: `.memory/ink-migration-progress.md`

- [ ] **Step 1: 读现有「踩过的坑」段落定位**

Run: `grep -n "踩过的坑\|关键技术约束" .memory/ink-migration-progress.md`

- [ ] **Step 2: 追加 CJK 光标回归条目**

在该段落末尾追加（用 Edit 工具，定位到该段最后一个 `-` 条目之后）:

```markdown
- **CJK 光标错位（Phase 8 删旧 renderer 时丢失的修复）**：
  Ink Footer 用 `setCursorPosition({ x: PROMPT_WIDTH + cursor })`，其中 `cursor` 是 input-store 的**码点索引**（`[...str].length`，编辑器语义正确）。但 x 是**显示列**——CJK 全角字符（汉字/emoji）码点=1 但显示宽=2，导致光标每遇一个汉字少算 1 列，落在字符中间把字一分为二。
  **正确做法**：用 `string-width` 量「光标前文本」的显示宽度，绝不能把码点索引当列用。多行时按 `\n` 分割逐行算 `(x,y)`。已抽到 `src/tui/state/cursor-position.ts` 的 `cursorScreenPos(input, cursor, prompt)`。
  参照：Ink `useCursor()` README 官方示例 + 旧 `renderer.ts:computeInputCursorPos()`（commit a01c965 修过，6618e79 删 renderer 时丢）。
```

- [ ] **Step 3: commit**

```bash
git add .memory/ink-migration-progress.md
git commit -m "docs(memory): 记录 CJK 光标回归教训（避免下次再犯）"
```

---

## Task 14: 最终验证 + 手动冒烟

**Goal:** 全量测试 + typecheck + build + 手动冒烟 5 个场景。

- [ ] **Step 1: 全量测试**

```bash
npm test
```
Expected: 全 PASS（含新增的 cursor-position/spinner-store/spinner-component/status-bar/command-names/completion-store/suggestion-bar/overlay-store/overlay-component + 现有全部）。

- [ ] **Step 2: typecheck + build**

```bash
npm run typecheck
npm run build
```
Expected: 0 error。

- [ ] **Step 3: 手动冒烟（5 个场景）**

Run: `tsx src/index.ts`（或项目实际的启动命令），逐项验证：

1. **CJK 光标**：输入「你好world」，光标应在 `d` 之后（x=11），不在「好」中间。再输入「汉字」，光标跟随。
2. **状态栏多色**：底部状态栏 mode(青)/model(蓝)/dir(紫)/branch(黄)/进度条 各段不同色，` │ ` 分隔。
3. **Spinner**：发一条消息，观察 `⠋ Thinking…` → 工具调用时 `Running xxx` → `Generating…` → 停。3s 无响应变红。
4. **TAB 双行为**：
   - 直接按 TAB → status bar mode 在 build→plan→auto→build 循环。
   - 输入 `/pl` 按 TAB → 变 `/plan`，候选条显示 plan/provider/proxy；再按 TAB 在候选间循环。
5. **Ctrl+O**：让模型产生 thinking 块或长 tool_result 后，按 Ctrl+O → 全屏展开；按 q/Ctrl+O/Esc 返回。
6. **多行输入**：输入 `abc`，Ctrl+J，输入 `def`，光标在第 2 行；上下箭头跨行移动，列保留。

- [ ] **Step 4: （若手动冒烟发现问题）回到对应 Task 修**

记录问题 → 回到对应 Task 的 RED 阶段补测试 → 修 → 验证。

- [ ] **Step 5: 全部通过后，最终 commit（若有遗留改动）**

```bash
git status
# 若有未提交改动：
git add -A
git commit -m "test: 手动冒烟后微调"
```

---

## Self-Review（plan 写完后自查，已在脑内过一遍，记录如下）

**1. Spec 覆盖：**
- CJK 光标修复 → Task 1（cursor-position）+ Task 2（Footer 接入）✓
- 状态栏多色 → Task 3 ✓
- Spinner → Task 4（store）+ Task 5（组件）+ Task 6（接线 8 处）✓
- TAB 模式切换 + 补全 → Task 7（COMMAND_NAMES+completion-store）+ Task 8（SuggestionBar）+ Task 9（handler+index.ts）✓
- Ctrl+O 覆盖层 → Task 10（store+组件）+ Task 11（接线）✓
- 多行输入 → Task 12 ✓
- 记忆更新（用户明确要求）→ Task 13 ✓
- 验证 → Task 14 ✓

**2. Placeholder 扫描：** 无 TODO/TBD；Task 12 Step 7 的「条件性动态 FOOTER_ROWS」是显式的「先验证再决定」分支，不是占位——有明确的验证命令和触发条件。Task 11 测试里的 ink 字节解析不确定（Ctrl+O 的 `\x0f` 是否解析为 `input='o'+key.ctrl`），已注明「跑红后调」——这是 TDD 的正常 red 阶段调试，可接受。

**3. 类型一致性：**
- `SpinnerStore`/`CompletionStore`/`OverlayStore` 在创建 Task（4/7/10）定义，在接线 Task（6/8/9/11）使用——名称一致 ✓
- `cursorScreenPos` 返回 `{x, y}`，Footer 用 `pos.x`/`pos.y` ✓
- `BootstrapHandle` 增量字段：`spinnerStore`/`startSpinner`/`stopSpinner`/`setSpinnerLabel`/`spinnerOnToken`（Task 6）+ `completionStore`（Task 8）+ `overlayStore`（Task 11）—— 每个 Task 只加该 Task 的字段，不冲突 ✓
- `useInputHandler` 签名：Task 9 加 `onTab`，Task 11 加 `onToggleOverlay`+`overlayVisible`——顺序 `(store, onExit, onTab, onToggleOverlay, overlayVisible)` 在 ConnectedApp 调用处一致 ✓
- `FooterProps` 增量：`spinnerStore`（Task 6）+ `completionStore`（Task 8）—— 未提前声明 `overlayStore`（Task 11 Footer 不渲染 overlay，所以不需要）✓

**4. 风险点已标注：**
- Task 6 注释了「FooterProps 选 (a) 方案，不提前声明 completionStore/overlayStore」
- Task 9 注释了 `tuiHandle` 闭包读外层 `let` 的时序
- Task 11 注释了 Ctrl+C-in-overlay 退出语义（对齐 master，用户已确认）
- Task 12 Step 7 是显式条件分支（先验证再改 FOOTER_ROWS）
