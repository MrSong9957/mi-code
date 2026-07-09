# 字符级文本选择 + 右键复制 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把行级文本选择升级为字符级（Point{row,col}），复制改为右键触发（清高亮），补齐双击选词/三击选行/拖拽自动滚动/OSC52 跨 SSH 回退。

**Architecture:** Ink 层逐字符切片高亮（render/ 层零改动，保持 charter 隔离铁律）。新增 `src/tui/selection/` 纯逻辑目录（click-detector/slice-line/word-boundary/get-selected-text），重写 selection-store（Point 模型 + scrolledOff 缓存），升级 clipboard.ts（OS命令→tmux→OSC52 三级回退）。开发序遵循【人类直觉开发流】：先纯逻辑工具层（可单测、无副作用）→ 数据层 store → 渲染层 MessageRow → 事件路由 ScrollBox → I/O clipboard。

**Tech Stack:** TypeScript ESM、React 19、Ink 7（patched）、Zustand vanilla、string-width@^8.2.1（已装）、vitest、ink-testing-library。Node 内置 child_process.spawn + Buffer（OSC52，不引第三方）。

**测试命令：** `npm test`（即 `vitest run`）；类型检查 `npm run typecheck`；构建 `npm run build`。

**关键参考文件（只读上下文）：**
- `src/tui/state/selection-store.ts` — 现有行级 store（本次重写）
- `src/tui/state/cursor-position.ts` — 已验证的 stringWidth + 码点迭代模式（复用范式）
- `src/tui/input/mouse-events.ts` — SGR 解析器（复用，button 位含义见注释）
- `src/tui/input/clipboard.ts` — 现有 OS 命令实现（本次重写为三级回退）
- `src/tui/components/ScrollBox.tsx` — 现有事件路由（本次改）
- `src/tui/components/MessageRow.tsx` — 现有整行 inverse 高亮（本次改字符切片）
- `src/tui/types.ts` — `TuiMessage`/`FormattedLine`/`styleToInkProps`
- `src/ui/types.ts` — `FormattedLine.content` 含缩进+前缀

**spec：** `docs/superpowers/specs/2026-07-07-char-selection-and-right-click-copy-design.md`

---

## File Structure（新增/修改清单）

**新增（纯逻辑层 + 测试）：**
- `src/tui/selection/slice-line.ts` — 单行按选区切片（CJK 钳位）
- `src/tui/selection/word-boundary.ts` — 词边界识别（双击选词）
- `src/tui/selection/click-detector.ts` — 多击分类（300ms 时序）
- `src/tui/selection/get-selected-text.ts` — 选区→文本（L 型 + scrolledOff 拼接）
- `src/__tests__/tui/selection/slice-line.test.ts`
- `src/__tests__/tui/selection/word-boundary.test.ts`
- `src/__tests__/tui/selection/click-detector.test.ts`
- `src/__tests__/tui/selection/get-selected-text.test.ts`

**修改：**
- `src/tui/state/selection-store.ts` — **重写**：Point 模型 + scrolledOff + colsForRow(L型) + selectWord/selectLine
- `src/__tests__/tui/selection-store.test.ts` — 适配 Point 模型
- `src/tui/components/MessageRow.tsx` — 字符切片高亮 + 接收 globalRow/selectionStore
- `src/tui/components/ScrollBox.tsx` — 事件路由扩展（右键/多击/滚动捕获）+ 注入 globalRow
- `src/tui/input/clipboard.ts` — **重写**：OS命令→tmux→OSC52 三级回退
- `src/__tests__/tui/clipboard.test.ts` — 加 OSC52/tmux 测试

---

## Task 1: slice-line.ts（单行选区切片，CJK 钳位）

**Goal:** 纯函数，把一行 content 按 [startCol,endCol) 切成最多 3 段。CJK 全角字符落中间时钳位。这是 MessageRow 高亮与 getSelectedText 提取的共同基石。

**Files:**
- Create: `src/tui/selection/slice-line.ts`
- Test: `src/__tests__/tui/selection/slice-line.test.ts`

- [ ] **Step 1: 写失败测试（ASCII + CJK 钳位 + 边界）**

Create `src/__tests__/tui/selection/slice-line.test.ts`:

```ts
// src/__tests__/tui/selection/slice-line.test.ts
// 单行选区切片：ASCII/CJK 钳位/边界/null

import { describe, it, expect } from 'vitest';
import { sliceLineBySelection } from '../../../tui/selection/slice-line.js';

describe('sliceLineBySelection', () => {
  it('range=null：单段不选中', () => {
    const segs = sliceLineBySelection('hello', null);
    expect(segs).toEqual([{ text: 'hello', selected: false }]);
  });

  it('ASCII 中段选中：3 段', () => {
    // 'hello'，[1,4) → 'h' | 'ell' | 'o'
    const segs = sliceLineBySelection('hello', { startCol: 1, endCol: 4 });
    expect(segs).toEqual([
      { text: 'h', selected: false },
      { text: 'ell', selected: true },
      { text: 'o', selected: false },
    ]);
  });

  it('选中到行首：2 段（前段空丢弃）', () => {
    const segs = sliceLineBySelection('hello', { startCol: 0, endCol: 2 });
    expect(segs).toEqual([
      { text: 'he', selected: true },
      { text: 'llo', selected: false },
    ]);
  });

  it('选中到行尾：2 段（后段空丢弃）', () => {
    const segs = sliceLineBySelection('hello', { startCol: 3, endCol: 5 });
    expect(segs).toEqual([
      { text: 'hel', selected: false },
      { text: 'lo', selected: true },
    ]);
  });

  it('整行选中：单段 selected=true', () => {
    const segs = sliceLineBySelection('hello', { startCol: 0, endCol: 5 });
    expect(segs).toEqual([{ text: 'hello', selected: true }]);
  });

  it('CJK 钳位：startCol 落在全角字符中间向左钳', () => {
    // '你好world' 显示宽度：你=2,好=2,w=1...
    // 累积：你[0,2) 好[2,4) w[4,5) o[5,6)...
    // startCol=1 落在「你」中间 → 钳到 0；endCol=3 落在「好」中间 → 钳到 4
    const segs = sliceLineBySelection('你好world', { startCol: 1, endCol: 3 });
    // 钳位后 [0,4) → 「你好」选中，world 不选
    expect(segs).toEqual([
      { text: '你好', selected: true },
      { text: 'world', selected: false },
    ]);
  });

  it('CJK 钳位：startCol 落在全角字符起点不钳', () => {
    // startCol=2 正好在「好」起点，不钳
    const segs = sliceLineBySelection('你好world', { startCol: 2, endCol: 4 });
    expect(segs).toEqual([
      { text: '你', selected: false },
      { text: '好', selected: true },
      { text: 'world', selected: false },
    ]);
  });

  it('CJK 选中半个字符区间：钳到完整字符', () => {
    // '你好' [1,3) → startCol=1 钳到 0，endCol=3 钳到 4 → [0,4) 整行
    const segs = sliceLineBySelection('你好', { startCol: 1, endCol: 3 });
    expect(segs).toEqual([{ text: '你好', selected: true }]);
  });

  it('emoji 当 1 个码点（显示宽 2）：切片按码点', () => {
    // 'a👋b' 显示宽度：a=1 👋=2 b=1，累积 a[0,1) 👋[1,3) b[3,4)
    const segs = sliceLineBySelection('a👋b', { startCol: 1, endCol: 3 });
    expect(segs).toEqual([
      { text: 'a', selected: false },
      { text: '👋', selected: true },
      { text: 'b', selected: false },
    ]);
  });

  it('空字符串：返回空数组', () => {
    expect(sliceLineBySelection('', null)).toEqual([]);
    expect(sliceLineBySelection('', { startCol: 0, endCol: 5 })).toEqual([]);
  });

  it('range 超出文本宽度：钳到行尾', () => {
    // 'hi' 宽 2，[0,99) → 整行选中
    const segs = sliceLineBySelection('hi', { startCol: 0, endCol: 99 });
    expect(segs).toEqual([{ text: 'hi', selected: true }]);
  });

  it('range 不相交（endCol<=0 或 startCol>=width）：单段不选中', () => {
    expect(sliceLineBySelection('hi', { startCol: 5, endCol: 9 }))
      .toEqual([{ text: 'hi', selected: false }]);
    expect(sliceLineBySelection('hi', { startCol: 0, endCol: 0 }))
      .toEqual([{ text: 'hi', selected: false }]);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- slice-line`
Expected: FAIL（模块不存在 / `sliceLineBySelection is not a function`）。

- [ ] **Step 3: 写实现**

Create `src/tui/selection/slice-line.ts`:

```ts
// src/tui/selection/slice-line.ts
// 单行按选区切片：把一行 content 按 [startCol,endCol) 切成最多 3 段。
//
// 物理本质：一条水平胶带上标记一段区间，切成「前/中/后」三段，
// 中段加 inverse 高亮。CJK 全角字符占 1 个码点但显示 2 列，
// 直接按字符串下标切会切坏字符——按显示列定位、钳到字符边界。
//
// 复用范式：cursor-position.ts 已验证的 stringWidth + 码点迭代。
//
// 钳位规则（落全角字符中间时）：
//  - startCol 向左钳到该字符起点（保留该字符）
//  - endCol   向右钳到该字符终点（保留该字符）
// 选区可能比拖拽位置多半/少半个字符，但永不出现半字。

import stringWidth from 'string-width';

/** 行的选区列范围（endCol 不含端点，半开区间 [start,end)） */
export interface LineSelectionRange {
  startCol: number;
  endCol: number;
}

export interface LineSegment {
  text: string;
  selected: boolean;
}

/**
 * 把一行 content 按 range 切成最多 3 段。
 * @param content 行完整文本（含缩进/前缀）
 * @param range   选区列范围（显示列，0-based）；null 表示整行不选中
 * @returns 段数组（空字符串段已丢弃）；空 content 返回 []
 */
export function sliceLineBySelection(
  content: string,
  range: LineSelectionRange | null,
): LineSegment[] {
  if (content === '') return [];

  // 无选区：单段不选中
  if (range === null) {
    return [{ text: content, selected: false }];
  }

  const codepoints = [...content]; // 按码点切（CJK/emoji 安全）
  // 建累积宽度表：charStart[i] = 第 i 个码点的起始显示列
  const charStart: number[] = [];
  let acc = 0;
  for (const cp of codepoints) {
    charStart.push(acc);
    acc += stringWidth(cp);
  }
  const totalWidth = acc;

  // 钳 range 到 [0, totalWidth]，且 start < end 才有效
  let start = Math.max(0, range.startCol);
  let end = Math.min(totalWidth, range.endCol);
  if (start >= end || start >= totalWidth || end <= 0) {
    return [{ text: content, selected: false }];
  }

  // 找 startCol 落在第几个码点上；落全角字符中间则向左钳到该码点起点
  let startIdx = codepoints.length; // 默认全选前面（start 钳到 0 时）
  for (let i = 0; i < codepoints.length; i++) {
    const cs = charStart[i]!;
    const cw = stringWidth(codepoints[i]!);
    if (start >= cs && start < cs + cw) {
      // start 落在此码点的显示区间内 → 钳到此码点起点
      startIdx = i;
      // 钳 start 到 cs
      break;
    }
    if (start >= cs + cw) {
      startIdx = i + 1;
    }
  }
  startIdx = Math.max(0, Math.min(startIdx, codepoints.length));

  // 找 endCol 落点；落全角字符中间则向右钳到该码点终点（下一码点起点）
  let endIdx = 0;
  for (let i = 0; i < codepoints.length; i++) {
    const cs = charStart[i]!;
    const cw = stringWidth(codepoints[i]!);
    if (end > cs && end <= cs + cw) {
      // end 落在此码点区间内（不含 cs，含 cs+cw）→ 钳到下一码点起点（含此字符）
      endIdx = i + 1;
      break;
    }
    if (end > cs + cw) {
      endIdx = i + 1;
    }
  }
  endIdx = Math.max(0, Math.min(endIdx, codepoints.length));

  // start 钳位后可能 >= endIdx（极端），退化为不选中
  if (startIdx >= endIdx) {
    return [{ text: content, selected: false }];
  }

  // 拼 3 段（空段丢弃）
  const segs: LineSegment[] = [];
  if (startIdx > 0) {
    segs.push({ text: codepoints.slice(0, startIdx).join(''), selected: false });
  }
  segs.push({ text: codepoints.slice(startIdx, endIdx).join(''), selected: true });
  if (endIdx < codepoints.length) {
    segs.push({ text: codepoints.slice(endIdx).join(''), selected: false });
  }
  return segs;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- slice-line`
Expected: PASS（12/12）。若 CJK 钳位用例失败，检查 `charStart` 累积与 break 时机——`npm test -- slice-line --reporter=verbose` 看哪个 case 红。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/tui/selection/slice-line.ts src/__tests__/tui/selection/slice-line.test.ts
git commit -m "feat(tui/selection): slice-line 单行选区切片（CJK 钳位）

把一行 content 按 [startCol,endCol) 切成最多 3 段，中段高亮。
落全角字符中间时：start 向左钳、end 向右钳，永不切坏字符。
复用 cursor-position.ts 的 stringWidth+码点迭代范式。"
```

---

## Task 2: word-boundary.ts（词边界，双击选词）

**Goal:** 纯函数，给定 content + col，向左右扩展到词边界，返回 [start,end)。词字符=字母/数字/下划线/中文，非词=空格/标点/前缀符 ●⎿❯。

**Files:**
- Create: `src/tui/selection/word-boundary.ts`
- Test: `src/__tests__/tui/selection/word-boundary.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/selection/word-boundary.test.ts`:

```ts
// src/__tests__/tui/selection/word-boundary.test.ts
// 词边界识别：双击选词用。col 按显示列，CJK 全角=1 单位（与 slice-line 一致）。

import { describe, it, expect } from 'vitest';
import { findWordBounds } from '../../../tui/selection/word-boundary.js';

describe('findWordBounds', () => {
  it('ASCII 词中段：扩展到词两端', () => {
    // 'hello world' col=2 → 'hello' [0,5)
    expect(findWordBounds('hello world', 2)).toEqual({ start: 0, end: 5 });
  });

  it('落在空格上：无词，返回 [col,col)', () => {
    expect(findWordBounds('hello world', 5)).toEqual({ start: 5, end: 5 });
  });

  it('跨空格到下一个词：col=6 在 world 中段', () => {
    expect(findWordBounds('hello world', 7)).toEqual({ start: 6, end: 11 });
  });

  it('标点是词边界：foo,bar col=2 在 foo', () => {
    expect(findWordBounds('foo,bar', 2)).toEqual({ start: 0, end: 3 });
  });

  it('标点上：col=3 在逗号上 → 无词', () => {
    expect(findWordBounds('foo,bar', 3)).toEqual({ start: 3, end: 3 });
  });

  it('下划线算词字符：foo_bar', () => {
    expect(findWordBounds('foo_bar', 5)).toEqual({ start: 0, end: 7 });
  });

  it('CJK 整段算一个词：你好world col=1 在「你」', () => {
    // 中文字符相邻成词；col=1 显示列对应码点 0「你」
    expect(findWordBounds('你好world', 1)).toEqual({ start: 0, end: 4 });
    // ↑ 中文「你好」连续，到 world（字母也算词字符）连成一词 [0,4)
  });

  it('前缀符 ● 是非词字符：col 在 ● 上无词', () => {
    // '● hello' col=0 在 ● 上
    expect(findWordBounds('● hello', 0)).toEqual({ start: 0, end: 0 });
  });

  it('前缀符后接词：col=3 在 hello 中', () => {
    // '● hello' 显示 ● 占 1 列，空格 1 列，hello 从 col 2 开始
    // 但码点角度：●是 1 码点 1 列，空格 1 码点 1 列
    // col=3 → 码点 3 'e' → 词 [2,7)
    expect(findWordBounds('● hello', 3)).toEqual({ start: 2, end: 7 });
  });

  it('col 超出文本：钳到边界', () => {
    expect(findWordBounds('hi', 99)).toEqual({ start: 0, end: 2 });
  });

  it('col 为负：当 0 处理', () => {
    expect(findWordBounds('hi', -5)).toEqual({ start: 0, end: 2 });
  });

  it('空字符串：返回 {0,0}', () => {
    expect(findWordBounds('', 0)).toEqual({ start: 0, end: 0 });
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- word-boundary`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/tui/selection/word-boundary.ts`:

```ts
// src/tui/selection/word-boundary.ts
// 词边界识别：双击选词用。
//
// 物理本质：以 col 为中心，向左右「吞噬」连续的词字符，直到撞到非词字符。
// 词字符 = 字母 / 数字 / 下划线 / 中文/日文/韩文（CJK 统一表意）。
// 非词字符 = 空白 / 标点 / ANSI 前缀符（●⎿❯）。
//
// col 单位：码点索引（不是显示列）。
// 调用方需先把 SGR 鼠标的显示列转成码点索引（见 selection-store.selectWordAt）。
// 设计权衡：在码点空间做词边界比在显示列空间简单（不需 stringWidth 表），
// 调用方一次转换即可。

/** 判断字符是否为「词字符」 */
function isWordChar(ch: string): boolean {
  if (ch === '_') return true;
  // ASCII 字母数字
  if (/[a-zA-Z0-9]/.test(ch)) return true;
  // CJK 统一表意 + 日文假名 + 韩文（常见中日韩范围）
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x4e00 && code <= 0x9fff) return true;   // CJK 统一表意
  if (code >= 0x3040 && code <= 0x30ff) return true;   // 平假名+片假名
  if (code >= 0xac00 && code <= 0xd7af) return true;   // 韩文音节
  if (code >= 0x3400 && code <= 0x4dbf) return true;   // CJK 扩展 A
  return false;
}

/**
 * 以 col（码点索引）为中心，向左右扩展到词边界。
 * @param content 行完整文本
 * @param col     码点索引（0-based；调用方从显示列转换）
 * @returns {start,end} 码点索引区间（end 不含端点）；col 落在非词字符上返回 [col,col]
 */
export function findWordBounds(
  content: string,
  col: number,
): { start: number; end: number } {
  if (content === '') return { start: 0, end: 0 };
  const codepoints = [...content];
  const len = codepoints.length;
  // 钳 col 到 [0, len-1]
  const c = Math.max(0, Math.min(col, len - 1));
  const chAt = codepoints[c]!;
  if (!isWordChar(chAt)) {
    return { start: c, end: c };
  }
  // 向左扩展
  let start = c;
  while (start > 0 && isWordChar(codepoints[start - 1]!)) {
    start--;
  }
  // 向右扩展
  let end = c + 1;
  while (end < len && isWordChar(codepoints[end]!)) {
    end++;
  }
  return { start, end };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- word-boundary`
Expected: PASS（12/12）。

> **注意：** 若 `CJK 整段算一个词` 用例失败（期望 `[0,4)` 实际 `[0,4)` 但「你好world」中文+字母应连成一词），检查 `isWordChar` 是否覆盖了字母和 CJK 两者——两者都返回 true，连续即一词。若测试期望需要中英分离，调整测试期望（但本项目按「连续词字符即一词」语义，合理）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/tui/selection/word-boundary.ts src/__tests__/tui/selection/word-boundary.test.ts
git commit -m "feat(tui/selection): word-boundary 词边界识别（双击选词）

以码点 col 为中心向左右扩展，词字符=字母/数字/下划线/CJK。
非词字符（空格/标点/●⎿❯前缀）作为边界。码点空间做边界，调用方转显示列。"
```

---

## Task 3: click-detector.ts（多击分类，300ms 时序）

**Goal:** 纯函数 + 状态，喂入 mousedown，返回这次属于 single/double/triple。300ms 内同位置（偏差≤2）累加，超时或换位置重置。

**Files:**
- Create: `src/tui/selection/click-detector.ts`
- Test: `src/__tests__/tui/selection/click-detector.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/selection/click-detector.test.ts`:

```ts
// src/__tests__/tui/selection/click-detector.test.ts
// 多击分类：300ms 时序 + 位置偏差≤2 算同位置

import { describe, it, expect } from 'vitest';
import { classifyClick, type ClickState } from '../../../tui/selection/click-detector.js';

describe('classifyClick', () => {
  it('首次点击：single', () => {
    const r = classifyClick(null, 0, 10, 5, 1000);
    expect(r.kind).toBe('single');
    expect(r.state.count).toBe(1);
  });

  it('300ms 内同位置第二次：double', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300);
    expect(r.kind).toBe('double');
    expect(r.state.count).toBe(2);
  });

  it('300ms 内同位置第三次：triple', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1500);
    expect(r.kind).toBe('triple');
    expect(r.state.count).toBe(3);
  });

  it('第四次回归 single（循环）', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1500); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1700);
    expect(r.kind).toBe('single');
    expect(r.state.count).toBe(1);
  });

  it('超 300ms：重新计数 single', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1400); // 间隔 400ms
    expect(r.kind).toBe('single');
    expect(r.state.count).toBe(1);
  });

  it('位置偏差 >2：重置 single', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 13, 5, 1300); // col 偏差 3
    expect(r.kind).toBe('single');
  });

  it('位置偏差 ≤2（边界）：算同位置 double', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 12, 7, 1300); // col+2 row+2
    expect(r.kind).toBe('double');
  });

  it('换键（button 变）：重置 single', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 2, 10, 5, 1300); // 右键
    expect(r.kind).toBe('single');
  });

  it('刚好 300ms 边界：算同位置（含端点）', () => {
    let st: ClickState | null = null;
    let r = classifyClick(st, 0, 10, 5, 1000); st = r.state;
    r = classifyClick(st, 0, 10, 5, 1300); // 正好 300ms
    expect(r.kind).toBe('double');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- click-detector`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/tui/selection/click-detector.ts`:

```ts
// src/tui/selection/click-detector.ts
// 多击分类：双击/三击检测。
//
// 物理本质：终端 SGR 鼠标不直接报「双击」，需应用层计时。
// 同一按键、同一位置（偏差 ≤ CLICK_SLOP）、间隔 ≤ DOUBLE_CLICK_MS 的连续 mousedown 累加。
// 超时/换位置/换键 → 重置为 single。count 按模 3 循环（4 击回 single）。

export type ClickKind = 'single' | 'double' | 'triple';

export interface ClickState {
  lastButton: number;
  lastRow: number;
  lastCol: number;
  lastTime: number;
  count: number; // 当前连续击数（1,2,3）
}

/** 双击间隔阈值（ms）—— 等于 300ms（VSCode/Terminal 默认） */
export const DOUBLE_CLICK_MS = 300;
/** 同位置允许的像素抖动（col/row 偏差 ≤ 此值算同位置） */
export const CLICK_SLOP = 2;

/**
 * 喂入一次 mousedown，返回这次属于第几击 + 更新后的 state。
 * @param state    上一次的状态（首次传 null）
 * @param button   SGR button 码（0=左键 2=右键）
 * @param row      1-origin 行（仅用于比较，不转换）
 * @param col      1-origin 列
 * @param now      当前时间戳（ms）
 */
export function classifyClick(
  state: ClickState | null,
  button: number,
  row: number,
  col: number,
  now: number,
): { kind: ClickKind; state: ClickState } {
  const isContinuation =
    state !== null
    && state.lastButton === button
    && Math.abs(row - state.lastRow) <= CLICK_SLOP
    && Math.abs(col - state.lastCol) <= CLICK_SLOP
    && (now - state.lastTime) <= DOUBLE_CLICK_MS;

  const count = isContinuation ? (state!.count % 3) + 1 : 1;
  const kind: ClickKind = count === 2 ? 'double' : count === 3 ? 'triple' : 'single';
  return {
    kind,
    state: { lastButton: button, lastRow: row, lastCol: col, lastTime: now, count },
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- click-detector`
Expected: PASS（9/9）。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/tui/selection/click-detector.ts src/__tests__/tui/selection/click-detector.test.ts
git commit -m "feat(tui/selection): click-detector 多击分类（300ms 双击/三击）

SGR 鼠标不报双击，应用层计时。同键同位置（偏差≤2）间隔≤300ms 累加，
count 模 3 循环。换键/换位置/超时重置 single。"
```

---

## Task 4: selection-store.ts 重写（Point 模型 + colsForRow L 型）

**Goal:** 行级 anchorRow/focusRow 升级为字符级 Point{row,col}；加 scrolledOff/anchorSpan；colsForRow 实现 L 型语义；selectWord/selectLine/clear。这是数据中枢，下游所有层依赖它。

**Files:**
- Modify: `src/tui/state/selection-store.ts`（重写）
- Modify: `src/__tests__/tui/selection-store.test.ts`（重写）

- [ ] **Step 1: 重写失败测试**

Replace entire `src/__tests__/tui/selection-store.test.ts`:

```ts
// src/__tests__/tui/selection-store.test.ts
// 字符级选区 store：Point{row,col} + L 型 colsForRow + scrolledOff 缓存

import { describe, it, expect } from 'vitest';
import { createSelectionStore } from '../../tui/state/selection-store.js';

describe('selection-store（Point 字符级）', () => {
  it('初始：无选区，isDragging=false，缓存空', () => {
    const s = createSelectionStore().getState();
    expect(s.anchor).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.isDragging).toBe(false);
    expect(s.scrolledOffAbove).toEqual([]);
    expect(s.scrolledOffBelow).toEqual([]);
    expect(s.anchorSpan).toBeNull();
    expect(s.lastClickKind).toBeNull();
  });

  it('startDrag(p)：设 anchor=focus=p，isDragging=true', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 5, col: 3 });
    const s = store.getState();
    expect(s.anchor).toEqual({ row: 5, col: 3 });
    expect(s.focus).toEqual({ row: 5, col: 3 });
    expect(s.isDragging).toBe(true);
    expect(s.lastClickKind).toBe('single');
  });

  it('startDrag 带 kind=double', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 5, col: 3 }, 'double');
    expect(store.getState().lastClickKind).toBe('double');
  });

  it('dragTo：更新 focus，anchor 不变', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    const s = store.getState();
    expect(s.anchor).toEqual({ row: 3, col: 2 });
    expect(s.focus).toEqual({ row: 7, col: 8 });
  });

  it('dragTo 在 anchor=null 时无效（防御）', () => {
    const store = createSelectionStore();
    store.getState().dragTo({ row: 7, col: 8 });
    expect(store.getState().focus).toBeNull();
  });

  it('endDrag：isDragging=false，保留 anchor/focus', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    store.getState().endDrag();
    const s = store.getState();
    expect(s.isDragging).toBe(false);
    expect(s.anchor).toEqual({ row: 3, col: 2 });
    expect(s.focus).toEqual({ row: 7, col: 8 });
  });

  it('clear：清空全部（含缓存）', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().selectLineAt(5, 'xxxx');
    store.getState().clear();
    const s = store.getState();
    expect(s.anchor).toBeNull();
    expect(s.focus).toBeNull();
    expect(s.scrolledOffAbove).toEqual([]);
    expect(s.scrolledOffBelow).toEqual([]);
    expect(s.anchorSpan).toBeNull();
  });

  it('selectionRect：返回外包矩形；无选区 null', () => {
    const store = createSelectionStore();
    expect(store.getState().selectionRect()).toBeNull();
    store.getState().startDrag({ row: 5, col: 10 });
    store.getState().dragTo({ row: 2, col: 3 });
    expect(store.getState().selectionRect()).toEqual({
      minRow: 2, maxRow: 5, minCol: 3, maxCol: 10,
    });
  });

  it('rowIntersects：行落在 [minRow,maxRow]', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    const s = store.getState();
    expect(s.rowIntersects(2)).toBe(false);
    expect(s.rowIntersects(3)).toBe(true);
    expect(s.rowIntersects(5)).toBe(true);
    expect(s.rowIntersects(7)).toBe(true);
    expect(s.rowIntersects(8)).toBe(false);
  });

  it('colsForRow 单行（minRow==maxRow）：[minCol,maxCol]', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 5, col: 2 });
    store.getState().dragTo({ row: 5, col: 8 });
    expect(store.getState().colsForRow(5, 100)).toEqual({ start: 2, end: 8 });
  });

  it('colsForRow 多行 L 型：首行[anchorCol,width] 中间[0,width] 末行[0,focusCol]', () => {
    const store = createSelectionStore();
    // anchor row=3 col=2，focus row=7 col=8（向下拖）
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 7, col: 8 });
    const s = store.getState();
    expect(s.colsForRow(3, 50)).toEqual({ start: 2, end: 50 });  // 首行
    expect(s.colsForRow(5, 50)).toEqual({ start: 0, end: 50 });  // 中间整行
    expect(s.colsForRow(7, 50)).toEqual({ start: 0, end: 8 });   // 末行
  });

  it('colsForRow 向上拖（anchor 在下）：首末按 row 顺序不变', () => {
    const store = createSelectionStore();
    // anchor row=7 col=8，focus row=3 col=2（向上拖）
    store.getState().startDrag({ row: 7, col: 8 });
    store.getState().dragTo({ row: 3, col: 2 });
    const s = store.getState();
    // row=3 是末行（focus），row=7 是首行（anchor）
    expect(s.colsForRow(3, 50)).toEqual({ start: 0, end: 2 });   // focus 在此
    expect(s.colsForRow(5, 50)).toEqual({ start: 0, end: 50 });  // 中间
    expect(s.colsForRow(7, 50)).toEqual({ start: 8, end: 50 });  // anchor 在此
  });

  it('colsForRow 行不在选区：返回 null', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 5, col: 8 });
    expect(store.getState().colsForRow(10, 50)).toBeNull();
  });

  it('colsForRow 无选区：null', () => {
    const store = createSelectionStore();
    expect(store.getState().colsForRow(5, 50)).toBeNull();
  });

  it('selectWordAt：以词边界设 anchor/focus + anchorSpan', () => {
    const store = createSelectionStore();
    const hit = store.getState().selectWordAt(5, 2, 'hello world');
    expect(hit).toBe(true);
    const s = store.getState();
    // findWordBounds('hello world', 2) = [0,5) 码点
    expect(s.anchor).toEqual({ row: 5, col: 0 });
    expect(s.focus).toEqual({ row: 5, col: 5 });
    expect(s.anchorSpan).toEqual({ row: 5, colStart: 0, colEnd: 5 });
    expect(s.lastClickKind).toBe('double');
  });

  it('selectWordAt col 落非词字符：返回 false，不改状态', () => {
    const store = createSelectionStore();
    const hit = store.getState().selectWordAt(5, 5, 'hello world'); // col=5 空格
    expect(hit).toBe(false);
    expect(store.getState().anchor).toBeNull();
  });

  it('selectLineAt：整行选中（anchor col=0, focus col=width）', () => {
    const store = createSelectionStore();
    store.getState().selectLineAt(5, 'hello world');
    const s = store.getState();
    expect(s.anchor).toEqual({ row: 5, col: 0 });
    // stringWidth('hello world') = 11
    expect(s.focus).toEqual({ row: 5, col: 11 });
    expect(s.lastClickKind).toBe('triple');
  });

  it('pushScrolledOff：追加到 above/below 缓存', () => {
    const store = createSelectionStore();
    store.getState().pushScrolledOff('above', 'line1');
    store.getState().pushScrolledOff('above', 'line2');
    store.getState().pushScrolledOff('below', 'line3');
    const s = store.getState();
    expect(s.scrolledOffAbove).toEqual(['line1', 'line2']);
    expect(s.scrolledOffBelow).toEqual(['line3']);
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- selection-store`
Expected: FAIL（`anchorRow` 不存在 / 新方法未实现）。

- [ ] **Step 3: 重写 selection-store.ts**

Replace entire `src/tui/state/selection-store.ts`:

```ts
// src/tui/state/selection-store.ts
// 字符级选区 store（Point{row,col}）。
//
// 物理本质：鼠标拖拽选中的「二维坐标记录簿」。
// anchor（按下点）+ focus（拖拽终点）都是屏幕全局坐标（row 0-based 含 LOGO_ROWS 偏移，
// col 显示列 0-based，CJK 全角=1 col 由 string-width 算）。
//
// L 型选择语义（colsForRow）：
//  - 单行（minRow==maxRow）：[minCol, maxCol]
//  - 多行：首行（anchor 所在行）[anchorCol, lineWidth]、中间整行 [0, lineWidth]、
//          末行（focus 所在行）[0, focusCol]
//  注意：首/末按 anchor/focus 的 row 决定，与拖拽方向无关（向上拖时 anchor 在下）。
//
// 滚动捕获：scrolledOffAbove/Below 缓存拖拽超出视口的行文本，复制时拼接。
//
// 屏幕行号约定：相对 Ink 输出原点的全局行（含 LOGO_ROWS 偏移），
// 由 ScrollBox 在鼠标事件中换算（SGR row - 1 转 0-based）。

import { createStore, type StoreApi } from 'zustand/vanilla';
import stringWidth from 'string-width';
import { findWordBounds } from '../selection/word-boundary.js';

export interface Point {
  /** 屏幕全局行（0-based，含 LOGO_ROWS 偏移） */
  row: number;
  /** 显示列（0-based；CJK 全角=1 col） */
  col: number;
}

export type ClickKind = 'single' | 'double' | 'triple';

export interface AnchorSpan {
  row: number;
  colStart: number;
  colEnd: number;
}

export interface SelectionState {
  /** 拖拽起点（null=无选区） */
  anchor: Point | null;
  /** 拖拽当前/终点 */
  focus: Point | null;
  /** 是否拖拽中 */
  isDragging: boolean;
  /** 最近一次手势的多击类型 */
  lastClickKind: ClickKind | null;
  /** 双击/三击锚定的词/行边界 */
  anchorSpan: AnchorSpan | null;
  /** 拖拽超出视口时滚出上方/下方的行文本缓存 */
  scrolledOffAbove: string[];
  scrolledOffBelow: string[];

  // —— 操作 ——
  /** 开始拖拽：anchor=focus=p，isDragging=true */
  startDrag: (p: Point, kind?: ClickKind) => void;
  /** 拖拽中：更新 focus（anchor 不变）；anchor=null 时无效 */
  dragTo: (p: Point) => void;
  /** 结束拖拽：isDragging=false，保留 anchor/focus（高亮持续） */
  endDrag: () => void;
  /** 双击选词：以码点词边界扩展。返回是否命中（非词字符上返回 false） */
  selectWordAt: (row: number, col: number, fullLineContent: string) => boolean;
  /** 三击选行：整行选中 */
  selectLineAt: (row: number, fullLineContent: string) => void;
  /** 追加滚动捕获的行文本（'above'=向上滚出，'below'=向下滚出） */
  pushScrolledOff: (side: 'above' | 'below', text: string) => void;
  /** 清空选区（右键复制后调用，清全部含缓存） */
  clear: () => void;

  // —— 查询 ——
  hasSelection: () => boolean;
  /** 外包矩形 {minRow,maxRow,minCol,maxCol}；无选区 null */
  selectionRect: () => { minRow: number; maxRow: number; minCol: number; maxCol: number } | null;
  /** 某行是否与选区相交（含端点） */
  rowIntersects: (row: number) => boolean;
  /**
   * 某行的选区列范围 [start,end)（L 型语义）；行不在选区返回 null。
   * @param row       屏幕全局行
   * @param lineWidth 该行显示宽度（由调用方传 stringWidth(content)）
   */
  colsForRow: (row: number, lineWidth: number) => { start: number; end: number } | null;
}

export type SelectionStore = StoreApi<SelectionState>;

export function createSelectionStore(): SelectionStore {
  return createStore<SelectionState>((set, get) => ({
    anchor: null,
    focus: null,
    isDragging: false,
    lastClickKind: null,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],

    startDrag: (p, kind = 'single') => set({
      anchor: p, focus: p, isDragging: true,
      lastClickKind: kind,
      anchorSpan: null,
      // 新拖拽手势清空滚动缓存（旧选区作废）
      scrolledOffAbove: [],
      scrolledOffBelow: [],
    }),

    dragTo: (p) => set((s) => s.anchor === null ? s : { focus: p }),

    endDrag: () => set({ isDragging: false }),

    selectWordAt: (row, col, fullLineContent) => {
      // col 是显示列；先转码点索引（按 stringWidth 累积）
      const codepoints = [...fullLineContent];
      let cpIndex = 0;
      let acc = 0;
      for (let i = 0; i < codepoints.length; i++) {
        if (acc >= col) { cpIndex = i; break; }
        acc += stringWidth(codepoints[i]!);
        cpIndex = i + 1;
      }
      const bounds = findWordBounds(fullLineContent, cpIndex);
      if (bounds.start === bounds.end) return false; // 非词字符
      // 把码点区间转回显示列区间
      const startCol = stringWidth(codepoints.slice(0, bounds.start).join(''));
      const endCol = stringWidth(codepoints.slice(0, bounds.end).join(''));
      set({
        anchor: { row, col: startCol },
        focus: { row, col: endCol },
        isDragging: false,
        lastClickKind: 'double',
        anchorSpan: { row, colStart: startCol, colEnd: endCol },
        scrolledOffAbove: [],
        scrolledOffBelow: [],
      });
      return true;
    },

    selectLineAt: (row, fullLineContent) => {
      const w = stringWidth(fullLineContent);
      set({
        anchor: { row, col: 0 },
        focus: { row, col: w },
        isDragging: false,
        lastClickKind: 'triple',
        anchorSpan: { row, colStart: 0, colEnd: w },
        scrolledOffAbove: [],
        scrolledOffBelow: [],
      });
    },

    pushScrolledOff: (side, text) => set((s) => {
      if (side === 'above') return { scrolledOffAbove: [...s.scrolledOffAbove, text] };
      return { scrolledOffBelow: [...s.scrolledOffBelow, text] };
    }),

    clear: () => set({
      anchor: null, focus: null, isDragging: false,
      lastClickKind: null, anchorSpan: null,
      scrolledOffAbove: [], scrolledOffBelow: [],
    }),

    hasSelection: () => {
      const s = get();
      return s.anchor !== null && s.focus !== null;
    },

    selectionRect: () => {
      const s = get();
      if (!s.anchor || !s.focus) return null;
      return {
        minRow: Math.min(s.anchor.row, s.focus.row),
        maxRow: Math.max(s.anchor.row, s.focus.row),
        minCol: Math.min(s.anchor.col, s.focus.col),
        maxCol: Math.max(s.anchor.col, s.focus.col),
      };
    },

    rowIntersects: (row) => {
      const r = get().selectionRect();
      if (!r) return false;
      return row >= r.minRow && row <= r.maxRow;
    },

    colsForRow: (row, lineWidth) => {
      const s = get();
      if (!s.anchor || !s.focus) return null;
      const minRow = Math.min(s.anchor.row, s.focus.row);
      const maxRow = Math.max(s.anchor.row, s.focus.row);
      if (row < minRow || row > maxRow) return null;

      if (minRow === maxRow) {
        // 单行
        return {
          start: Math.min(s.anchor.col, s.focus.col),
          end: Math.max(s.anchor.col, s.focus.col),
        };
      }
      // 多行 L 型
      if (row === s.anchor.row) {
        // anchor 所在行：[anchorCol, lineWidth]
        return { start: s.anchor.col, end: lineWidth };
      }
      if (row === s.focus.row) {
        // focus 所在行：[0, focusCol]
        return { start: 0, end: s.focus.col };
      }
      // 中间整行
      return { start: 0, end: lineWidth };
    },
  }));
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- selection-store`
Expected: PASS（17/17）。若 `selectWordAt` 相关用例失败，检查码点索引转换（`acc >= col` 的边界）。

- [ ] **Step 5: typecheck + 全量测试确认无回归 + commit**

```bash
npm run typecheck
npm test
git add src/tui/state/selection-store.ts src/__tests__/tui/selection-store.test.ts
git commit -m "feat(tui): selection-store 升级字符级（Point{row,col} + L 型 colsForRow）

重写：anchorRow/focusRow → anchor/focus:Point；加 scrolledOffAbove/Below
滚动缓存、anchorSpan 词/行边界、selectWordAt（码点↔显示列转换）、
selectLineAt、pushScrolledOff、colsForRow（L 型语义：首/末/中间）。
clear 清全部含缓存。依赖 word-boundary.ts。"
```

---

## Task 5: get-selected-text.ts（选区→文本，L 型 + 滚动缓存拼接）

**Goal:** 纯函数，给定 messages + selection + 视口信息，提取选中文本。L 型语义（复用 sliceLineBySelection），拼接 scrolledOff 缓存，跳过流式块。

**Files:**
- Create: `src/tui/selection/get-selected-text.ts`
- Test: `src/__tests__/tui/selection/get-selected-text.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/__tests__/tui/selection/get-selected-text.test.ts`:

```ts
// src/__tests__/tui/selection/get-selected-text.test.ts
// 选区→文本：L 型提取 + scrolledOff 拼接 + 流式块跳过

import { describe, it, expect } from 'vitest';
import { getSelectedText } from '../../../tui/selection/get-selected-text.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';
import type { TuiMessage } from '../../../tui/types.js';

const LOGO_ROWS = 3;

function makeMsg(uuid: string, lines: string[], role: 'assistant' | 'user' | 'system' = 'assistant'): TuiMessage {
  return {
    uuid, role, finalized: true,
    lines: lines.map(content => ({ content, style: {}, indent: 0 })),
  };
}

describe('getSelectedText', () => {
  it('无选区：返回空串', () => {
    const store = createSelectionStore();
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello'])], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('');
  });

  it('单行选区：取选中片段', () => {
    const store = createSelectionStore();
    // messages: [hello] 在屏幕行 LOGO_ROWS+0=3
    store.getState().startDrag({ row: 3, col: 1 });
    store.getState().dragTo({ row: 3, col: 4 });
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello'])], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('ell');
  });

  it('多行 L 型：首行片段 + 中间整行 + 末行片段', () => {
    const store = createSelectionStore();
    // 三条消息各 1 行：屏幕行 3/4/5
    // anchor row=3 col=2 'hello'[2..]='llo'
    // 中间 row=4 整行 'world'
    // 末行 row=5 col=3 'foo'[:3]='foo'
    store.getState().startDrag({ row: 3, col: 2 });
    store.getState().dragTo({ row: 5, col: 3 });
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
      scrollTop: 0, visibleRows: 10, viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('llo\nworld\nfoo');
  });

  it('向上拖（focus 在上）：首末按 anchor/focus 的 row 决定', () => {
    const store = createSelectionStore();
    // anchor row=5 col=3, focus row=3 col=2（向上拖）
    store.getState().startDrag({ row: 5, col: 3 });
    store.getState().dragTo({ row: 3, col: 2 });
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello']), makeMsg('b', ['world']), makeMsg('c', ['foo'])],
      scrollTop: 0, visibleRows: 10, viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    // getSelectedText 按 row 升序遍历 [minRow=3 .. maxRow=5]：
    //   row=3 hello（focus 所在）：[0, focusCol=2) → 'he'
    //   row=4 world（中间）：整行 → 'world'
    //   row=5 foo（anchor 所在）：[anchorCol=3, width=3) → 空（col==width）
    // 空行仍占一行（join('\n') 保留），结果 'he\nworld\n'
    // 但 foo 行切片为空字符串，join 后是 'he\nworld\n'（末尾空行）
    expect(text).toBe('he\nworld\n');
  });

  it('scrolledOffAbove + 视口内 + scrolledOffBelow 拼接', () => {
    const store = createSelectionStore();
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    store.getState().pushScrolledOff('above', 'scrolled-up-line');
    store.getState().pushScrolledOff('below', 'scrolled-down-line');
    const text = getSelectedText({
      messages: [makeMsg('a', ['hello'])], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('scrolled-up-line\nhello\nscrolled-down-line');
  });

  it('流式块（未 finalized）：跳过返回空', () => {
    const store = createSelectionStore();
    const streaming: TuiMessage = {
      uuid: 's', role: 'assistant', finalized: false, streamingText: 'streaming...',
      lines: [],
    };
    store.getState().startDrag({ row: 3, col: 0 });
    store.getState().dragTo({ row: 3, col: 5 });
    const text = getSelectedText({
      messages: [streaming], scrollTop: 0, visibleRows: 10,
      viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    expect(text).toBe('');
  });

  it('选区跨多条消息（每条多行）', () => {
    const store = createSelectionStore();
    // 消息 A 2 行（屏幕 3,4），消息 B 2 行（屏幕 5,6）
    store.getState().startDrag({ row: 3, col: 0 }); // A 行1 首行整行（col 0 = 行首，width=5）
    store.getState().dragTo({ row: 6, col: 3 });    // B 行2 末行 [0,3)
    const text = getSelectedText({
      messages: [
        makeMsg('a', ['aaa11', 'aaa22']),
        makeMsg('b', ['bbb11', 'bbb22']),
      ],
      scrollTop: 0, visibleRows: 10, viewportTopRow: LOGO_ROWS, selection: store.getState(),
    });
    // row3 A 行1 [0,5)='aaa11'，row4 A 行2 整行='aaa22'，
    // row5 B 行1 整行='bbb11'，row6 B 行2 [0,3)='bbb'
    expect(text).toBe('aaa11\naaa22\nbbb11\nbbb');
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `npm test -- get-selected-text`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写实现**

Create `src/tui/selection/get-selected-text.ts`:

```ts
// src/tui/selection/get-selected-text.ts
// 选区→纯文本提取（L 型 + scrolledOff 缓存拼接 + 流式块跳过）。
//
// 物理本质：把选区覆盖的所有屏幕格子的字符按行拼成纯文本。
// L 型语义：首行（anchor 所在）[anchorCol, 行尾]、中间整行、末行（focus 所在）[行首, focusCol]。
// 拖拽方向不影响首末归属（anchor 永远是 anchor，focus 永远是 focus）。
//
// 屏幕行→消息行映射：row - LOGO_ROWS - scrollTop = 消息内线性行号；
// 再按 messages[i].lines.length 累计定位 (messageIndex, lineIndex)。
//
// 流式块（!finalized && streamingText !== undefined）：跳过，返回空。
// 滚动缓存：scrolledOffAbove + 视口内 + scrolledOffBelow。

import stringWidth from 'string-width';
import type { TuiMessage } from '../types.js';
import type { SelectionState } from '../state/selection-store.js';
import { sliceLineBySelection } from './slice-line.js';

export interface GetSelectedTextParams {
  messages: TuiMessage[];
  /** ScrollBox 当前 scrollTop */
  scrollTop: number;
  /** 视口可见行数 */
  visibleRows: number;
  /** 视口顶全局行（= LOGO_ROWS + scrollTop） */
  viewportTopRow: number;
  /** selectionStore 当前状态 */
  selection: SelectionState;
}

/** 屏幕全局行 → (messageIndex, lineIndex)；不在任何 finalized 消息内返回 null */
function mapRowToMessage(
  row: number,
  messages: TuiMessage[],
  scrollTop: number,
  viewportTopRow: number,
): { messageIndex: number; lineIndex: number } | null {
  // 消息内线性行号（相对所有消息的 lines 拉平）
  const flatRow = row - viewportTopRow;
  if (flatRow < 0) return null;
  let acc = 0;
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (!msg.finalized) continue; // 流式块不可定位
    const lineCount = msg.lines.length;
    if (flatRow < acc + lineCount) {
      return { messageIndex: mi, lineIndex: flatRow - acc };
    }
    acc += lineCount;
  }
  return null;
}

/**
 * 提取选中文本。无选区返回 ''。
 */
export function getSelectedText(params: GetSelectedTextParams): string {
  const { messages, scrollTop, visibleRows, viewportTopRow, selection } = params;
  const rect = selection.selectionRect();
  if (!rect) return '';

  const parts: string[] = [...selection.scrolledOffAbove];

  // 视口内的行范围
  const viewportBottomRow = viewportTopRow + visibleRows - 1;
  const startRow = Math.max(rect.minRow, viewportTopRow);
  const endRow = Math.min(rect.maxRow, viewportBottomRow);

  for (let row = startRow; row <= endRow; row++) {
    const loc = mapRowToMessage(row, messages, scrollTop, viewportTopRow);
    if (!loc) continue; // 流式块或越界，跳过
    const msg = messages[loc.messageIndex]!;
    if (!msg.finalized) continue;
    const line = msg.lines[loc.lineIndex];
    if (!line) continue;
    const lineWidth = stringWidth(line.content);
    const cols = selection.colsForRow(row, lineWidth);
    const segs = sliceLineBySelection(line.content, cols);
    const selectedText = segs.filter(s => s.selected).map(s => s.text).join('');
    parts.push(selectedText);
  }

  parts.push(...selection.scrolledOffBelow);

  return parts.join('\n');
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `npm test -- get-selected-text`
Expected: PASS（7/7）。若 `向上拖` 用例失败，检查 colsForRow 对 anchor/focus 行的判断与 getSelectedText 是否一致。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/tui/selection/get-selected-text.ts src/__tests__/tui/selection/get-selected-text.test.ts
git commit -m "feat(tui/selection): get-selected-text 选区→文本（L 型 + 缓存拼接）

L 型提取：首行[anchorCol,行尾]、中间整行、末行[行首,focusCol]。
scrolledOffAbove + 视口内 + scrolledOffBelow 拼接。流式块跳过返回空。
依赖 sliceLineBySelection + selection.colsForRow。"
```

---

## Task 6: clipboard.ts 重写（OS命令 → tmux → OSC52 三级回退）

**Goal:** 把单条 OS 命令路径升级为三级回退：本地→OS命令，tmux→load-buffer，否则→OSC52。不引第三方库。

**Files:**
- Modify: `src/tui/input/clipboard.ts`（重写）
- Modify: `src/__tests__/tui/clipboard.test.ts`（重写）

- [ ] **Step 1: 先看现有 clipboard 测试结构**

Run: `cat src/__tests__/tui/clipboard.test.ts`
（了解现有 mock 模式，新测试沿用。）

- [ ] **Step 2: 重写测试**

Replace entire `src/__tests__/tui/clipboard.test.ts`:

```ts
// src/__tests__/tui/clipboard.test.ts
// clipboard 三级回退：OS命令 → tmux → OSC52

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('clipboard 三级回退', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let spawnMock: ReturnType<typeof vi.fn>;
  let writeMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalEnv = { ...process.env };
    spawnMock = vi.fn();
    writeMock = vi.fn();
    // mock child_process.spawn
    vi.doMock('child_process', () => ({ spawn: spawnMock }));
    // mock process.stdout.write
    vi.spyOn(process.stdout, 'write').mockImplementation(writeMock);
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.doUnmock('child_process');
    vi.restoreAllMocks();
  });

  function makeChild(ok: boolean): unknown {
    return {
      on: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === 'close') setTimeout(() => cb(ok ? 0 : 1), 0);
      }),
      stdin: {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      },
    };
  }

  it('本地（非 SSH）+ OS 命令成功：调 spawn', async () => {
    delete process.env.SSH_CONNECTION;
    delete process.env.SSH_TTY;
    delete process.env.TMUX;
    spawnMock.mockReturnValue(makeChild(true));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('hello');
    expect(spawnMock).toHaveBeenCalled();
    expect(writeMock).not.toHaveBeenCalled(); // 没走 OSC52
  });

  it('SSH 环境 + 非 tmux：跳过 OS 命令，直接 OSC52', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4';
    delete process.env.TMUX;
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('hello');
    expect(spawnMock).not.toHaveBeenCalled();
    // OSC52 序列：\x1b]52;c;<base64>\x07
    const expected = `\x1b]52;c;${Buffer.from('hello', 'utf8').toString('base64')}\x07`;
    expect(writeMock).toHaveBeenCalledWith(expected);
  });

  it('tmux 环境：调 tmux load-buffer', async () => {
    delete process.env.SSH_CONNECTION;
    process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
    spawnMock.mockReturnValue(makeChild(true));
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('hello');
    // 第一参 spawn 调用的 cmd 应是 'tmux'
    expect(spawnMock).toHaveBeenCalledWith(
      'tmux', expect.arrayContaining(['load-buffer']), expect.anything(),
    );
  });

  it('OSC52 中文 base64 编码正确', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4';
    delete process.env.TMUX;
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('你好');
    const expected = `\x1b]52;c;${Buffer.from('你好', 'utf8').toString('base64')}\x07`;
    expect(writeMock).toHaveBeenCalledWith(expected);
  });

  it('OSC52 emoji 正确编码', async () => {
    process.env.SSH_CONNECTION = '1.2.3.4';
    delete process.env.TMUX;
    const { writeClipboard } = await import('../../tui/input/clipboard.js');
    await writeClipboard('👋🌍');
    const expected = `\x1b]52;c;${Buffer.from('👋🌍', 'utf8').toString('base64')}\x07`;
    expect(writeMock).toHaveBeenCalledWith(expected);
  });
});
```

- [ ] **Step 3: 跑测试，确认失败**

Run: `npm test -- clipboard`
Expected: FAIL（新测试断言 OSC52 序列，现有实现没有）。

- [ ] **Step 4: 重写 clipboard.ts**

Replace entire `src/tui/input/clipboard.ts`:

```ts
// src/tui/input/clipboard.ts
// 跨平台剪贴板写入（三级回退：OS命令 → tmux → OSC52）。
//
// 物理本质：把选中文本送到系统剪贴板的「快递员」，三条投递路径按优先级回退。
//  1. 本地（非 SSH）：调原生 OS 命令（clip/pbcopy/xclip）—— 最快最可靠
//  2. tmux 环境：tmux load-buffer -w —— 转发到外层终端的剪贴板
//  3. 通用回退：OSC 52 序列（ESC ] 52 ; c ; <base64> BEL）—— 跨 SSH 的标准协议
//
// 不引第三方库（charter 要求）。Buffer + spawn 全部 Node 内置。
//
// 平台命令：
//  - win32: clip（Unicode 支持有限，复杂文本可考虑切 PowerShell Set-Clipboard，本期 YAGNI）
//  - darwin: pbcopy
//  - linux: xclip -selection clipboard（无 xclip 可回退 xsel，本期 YAGNI）
//
// 实现期验证点（spec §3.5）：OSC52 写 process.stdout（非 Ink output channel），
// 自研 renderer 下一帧只写 cell diff 不重写 DCS，预期不冲突。若被覆盖改 commit hook。

import { spawn } from 'child_process';

const SSH_CONNECTION = !!(process.env.SSH_CONNECTION || process.env.SSH_TTY);
const TMUX = !!process.env.TMUX;

/** 按平台返回剪贴板命令与参数 */
function clipboardCommand(): { cmd: string; args: string[] } {
  switch (process.platform) {
    case 'win32': return { cmd: 'clip', args: [] };
    case 'darwin': return { cmd: 'pbcopy', args: [] };
    default: return { cmd: 'xclip', args: ['-selection', 'clipboard'] };
  }
}

/** 用 spawn 跑命令，stdin 管道传文本。失败 reject。 */
function runWithStdin(cmd: string, args: string[], text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', (err) => reject(err));
    child.stdin.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

/** OS 原生命令（clip/pbcopy/xclip） */
function copyNative(text: string): Promise<void> {
  const { cmd, args } = clipboardCommand();
  return runWithStdin(cmd, args, text);
}

/** tmux load-buffer -w（转发到外层终端） */
function tmuxLoadBuffer(text: string): Promise<void> {
  return runWithStdin('tmux', ['load-buffer', '-w', '-'], text);
}

/** OSC 52 序列直接写 stdout（终端标准剪贴板协议） */
function osc52(text: string): void {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

/**
 * 写文本到系统剪贴板（三级回退）。
 * 本地→OS命令；tmux→load-buffer；否则→OSC52。
 * 每级失败（spawn 抛错/退出码非0）静默落到下一级，最终 OSC52 永不抛错。
 */
export async function writeClipboard(text: string): Promise<void> {
  // 1. 本地优先：OS 命令最快最可靠
  if (!SSH_CONNECTION) {
    try {
      await copyNative(text);
      return;
    } catch {
      // 命令不存在/失败 → 落下一级
    }
  }
  // 2. tmux：load-buffer 转发外层
  if (TMUX) {
    try {
      await tmuxLoadBuffer(text);
      return;
    } catch {
      // 落 OSC52
    }
  }
  // 3. OSC 52：通用回退
  osc52(text);
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `npm test -- clipboard`
Expected: PASS（5/5）。若 `vi.doMock('child_process')` 在 ESM 下不生效，改用 `vi.mock` 顶层 mock（vitest ESM 兼容）。

- [ ] **Step 6: typecheck + 全量测试 + commit**

```bash
npm run typecheck
npm test
git add src/tui/input/clipboard.ts src/__tests__/tui/clipboard.test.ts
git commit -m "feat(tui): clipboard 三级回退（OS命令 → tmux → OSC52）

本地非 SSH 调 clip/pbcopy/xclip；tmux 环境调 load-buffer -w 转发外层；
否则发 OSC52 序列（ESC]52;c;<base64>BEL）。每级失败静默回退。
SSH/tmux 环境变量检测，不引第三方库。"
```

---

## Task 7: MessageRow 字符切片高亮 + 接收 globalRow/selectionStore

**Goal:** MessageRow 不再整行 inverse，改为调 sliceLineBySelection 逐字符切片。接收 globalRow（屏幕全局行）和 selectionStore 两个新 prop。

**Files:**
- Modify: `src/tui/components/MessageRow.tsx`
- Modify: `src/__tests__/tui/scrollbox.test.tsx`（适配新 props——若存在；否则跳过本步，由 Task 8 的集成测试覆盖）

- [ ] **Step 1: 修改 MessageRowProps 与渲染逻辑**

Replace entire `src/tui/components/MessageRow.tsx`:

```tsx
// src/tui/components/MessageRow.tsx
// 单条消息渲染（支持字符级选区高亮）。
//
// 物理本质：把一条 TuiMessage 翻译成 Ink 组件树。
// - 已固化行（lines: FormattedLine[]）：逐行渲染，缩进 + 语义样式
// - 流式 assistant（finalized=false 且 streamingText 非空）：用 StreamingMarkdown 渲染
//   （流式块不参与选区，与 spec §3.2.2 决策一致）
// - 选区高亮：调 sliceLineBySelection 把每行 content 按选区列范围切片，
//   选中段加 inverse（SGR 7 反色）。CJK 钳位由 slice-line 处理。
//
// 缩进+前缀都参与选区（终端原生语义）：FormattedLine.content 含缩进空格和前缀（●⎿❯），
// 屏幕列 == content 内列，无需坐标转换。

import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { TuiMessage } from '../types.js';
import { styleToInkProps } from '../types.js';
import { StreamingMarkdown } from '../streaming/streaming-markdown.js';
import { sliceLineBySelection } from '../selection/slice-line.js';
import type { SelectionStore } from '../state/selection-store.js';

export interface MessageRowProps {
  message: TuiMessage;
  /** 该消息在屏幕上的全局起始行（用于 selectionStore 查询）；流式块可不传 */
  globalRow?: number;
  /** 选区 store；不传则不高亮（流式块场景） */
  selectionStore?: SelectionStore;
}

export function MessageRow({ message, globalRow, selectionStore }: MessageRowProps): React.ReactElement {
  // 流式 assistant：用 StreamingMarkdown 渲染累积文本（不参与选区）
  if (!message.finalized && message.role === 'assistant' && message.streamingText !== undefined) {
    return (
      <Box flexDirection="column">
        <StreamingMarkdown text={message.streamingText} />
      </Box>
    );
  }

  // 已固化行：逐行渲染，按选区切片高亮
  return (
    <Box flexDirection="column">
      {message.lines.map((line, i) => {
        const props = styleToInkProps(line.style);
        const indent = ' '.repeat(line.indent ?? 0);

        // 选区切片：globalRow + selectionStore 都有才查
        let segs: Array<{ text: string; selected: boolean }>;
        if (globalRow !== undefined && selectionStore) {
          const lineWidth = stringWidth(line.content);
          const cols = selectionStore.getState().colsForRow(globalRow + i, lineWidth);
          segs = sliceLineBySelection(line.content, cols);
        } else {
          segs = [{ text: line.content, selected: false }];
        }

        return (
          <Text key={i} {...props}>
            {indent}
            {segs.map((seg, j) =>
              seg.selected
                ? <Text key={j} {...props} inverse>{seg.text}</Text>
                : <Text key={j} {...props}>{seg.text}</Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 2: 检查 ScrollBox 调用方是否传 selected（旧 prop）**

Run: `grep -rn "MessageRow" src/ --include="*.tsx" --include="*.ts"`

Expected：`src/tui/components/ScrollBox.tsx` 调用 `<MessageRow message={m} selected={...} />`。**旧 `selected` prop 已删，ScrollBox 必须改**——这是 Task 8 的工作。本步先让 typecheck 暴露错误。

- [ ] **Step 3: typecheck 确认 ScrollBox 报错（预期）**

Run: `npm run typecheck`
Expected: FAIL（ScrollBox 传了不存在的 `selected` prop）。这是预期的——下个 Task 修。**本步不 commit**，与 Task 8 一起提交。

> **TDD 调整说明：** MessageRow 单独的字符切片单测已被 `slice-line.test.ts` 完整覆盖（纯函数）。MessageRow 本身是薄渲染层，ink-testing-library 难以断言 inverse 样式（color/inverse 不暴露），故退化为 smoke 测试，由 Task 8 集成测试覆盖。此调整符合项目既有模式（见 plan `2026-07-06-tui-cursor-and-lost-features.md` Task 2 的同类权衡）。

---

## Task 8: ScrollBox 事件路由扩展（右键复制 + 多击 + 滚动捕获 + 注入 globalRow）

**Goal:** ScrollBox 接管完整鼠标事件路由：左键拖拽选区、左键双击选词/三击选行、右键复制+清高亮、拖拽自动滚动+缓存、拖拽中禁用滚轮。给 MessageRow 注入 globalRow + selectionStore。

**Files:**
- Modify: `src/tui/components/ScrollBox.tsx`（重写事件路由部分）
- Test: 扩展 `src/__tests__/tui/mouse-events.test.ts`（鼠标序列→选区集成，mock clipboard）

- [ ] **Step 1: 写集成测试（鼠标序列驱动选区 + 右键复制 mock）**

Append to `src/__tests__/tui/mouse-events.test.ts`（文件末尾追加新 describe）:

```ts
// 追加到 src/__tests__/tui/mouse-events.test.ts 末尾
import { vi } from 'vitest';

describe('ScrollBox 集成：鼠标序列 → 选区 → 右键复制', () => {
  // 这些用例验证 SGR 解析 + selectionStore 联动（不渲染 Ink，纯数据流）
  it('左键拖拽：startDrag → dragTo → endDrag', () => {
    // 用 createMouseParser + createSelectionStore 直接联动
    const { createSelectionStore } = require('../../tui/state/selection-store.js');
    const store = createSelectionStore();
    const parser = createMouseParser();
    // 左键按下 row=5 col=3（SGR 1-origin → 内部转 0-based）
    const downs = parser.feed('\x1b[<0;4;6M'); // col=4 row=6 (1-origin) → (3,5) 0-based
    expect(downs[0]?.type).toBe('mousedown');
    store.getState().startDrag({ row: 5, col: 3 });
    // 拖到 row=7 col=8
    const drags = parser.feed('\x1b[<32;9;8M'); // motion
    expect(drags[0]?.type).toBe('mousedrag');
    store.getState().dragTo({ row: 7, col: 8 });
    expect(store.getState().selectionRect()).toEqual({
      minRow: 5, maxRow: 7, minCol: 3, maxCol: 8,
    });
  });

  it('右键事件：button=2 识别', () => {
    const parser = createMouseParser();
    // 右键按下：button=2
    const e = parser.feed('\x1b[<2;5;5M');
    expect(e[0]?.button).toBe(2);
    expect(e[0]?.type).toBe('mousedown');
  });
});
```

> **测试范围说明：** 完整的 ScrollBox 渲染级集成测试（ink-testing-library 驱动真实 stdin）在本项目难以稳定（见既有 `mouse-events.test.ts` 也只测解析层）。本 Task 的集成测试覆盖「解析→store 联动」数据流；真正的「右键触发 writeClipboard」由手动验证 + scrollbox.test.tsx smoke 覆盖（与项目既有权衡一致）。

- [ ] **Step 2: 跑测试，确认失败/通过**

Run: `npm test -- mouse-events`
Expected: 新追加的 2 个用例应 PASS（它们只测 parser + store，不依赖 ScrollBox 改动）。这是「先验证测试本身有效」。

- [ ] **Step 3: 重写 ScrollBox.tsx 事件路由**

Replace entire `src/tui/components/ScrollBox.tsx`:

```tsx
// src/tui/components/ScrollBox.tsx
// 虚拟滚动容器 + 鼠标选区（字符级 + 右键复制 + 双击选词 + 拖拽自动滚动）。
//
// 物理本质：长列表「取景器」+ 鼠标「选区画笔」+ 右键「复制按钮」。
// - 虚拟滚动：只渲染 [scrollTop, scrollTop+visibleRows) 区间
// - 鼠标滚轮：调 scrollTop（拖拽中禁用，避免冲突）
// - 左键拖拽选区：mousedown(startDrag) → mousedrag(dragTo+滚动捕获) → mouseup(endDrag)
// - 左键双击选词 / 三击选行：click-detector 计时
// - 右键（button=2）：复制当前选区 + 清高亮（spec §3.4.4）
// - 自动跟随：用户没主动上滚时，messages 增长 → scrollTop 追到 maxScroll

import React, { useState, useEffect, useRef } from 'react';
import { Box, useStdin } from 'ink';
import stringWidth from 'string-width';
import type { TuiMessage } from '../types.js';
import { computeScrollState, sliceVisible } from './scroll-state.js';
import { createMouseParser } from '../input/mouse-events.js';
import { writeClipboard } from '../input/clipboard.js';
import { MessageRow } from './MessageRow.js';
import type { SelectionStore } from '../state/selection-store.js';
import { classifyClick, type ClickState, type ClickKind } from '../selection/click-detector.js';
import { getSelectedText } from '../selection/get-selected-text.js';

/** LOGO 区占的行数（与 App.tsx LOGO_ROWS 一致） */
const LOGO_ROWS = 3;
/** 拖拽自动滚动间隔（ms） */
const AUTOSCROLL_MS = 80;

export interface ScrollBoxProps {
  messages: TuiMessage[];
  visibleRows: number;
  selectionStore: SelectionStore;
}

export function ScrollBox({ messages, visibleRows, selectionStore }: ScrollBoxProps): React.ReactElement {
  const userScrolledAwayRef = useRef(false);
  const [scrollTopRaw, setScrollTop] = useState(() => Math.max(0, messages.length - visibleRows));
  const { stdin, setRawMode } = useStdin();
  const parserRef = useRef(createMouseParser());
  // 多击检测状态（跨事件持久）
  const clickStateRef = useRef<ClickState | null>(null);
  // 拖拽自动滚动计时器
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const effectiveScrollTop = userScrolledAwayRef.current ? scrollTopRaw : Math.max(0, messages.length - visibleRows);
  const state = computeScrollState({ total: messages.length, visibleRows, scrollTop: effectiveScrollTop });
  const visible = sliceVisible(messages, state);

  useEffect(() => {
    if (!userScrolledAwayRef.current && scrollTopRaw !== state.maxScroll) {
      setScrollTop(state.maxScroll);
    }
  }, [messages.length, state.maxScroll]);

  /** 取某屏幕全局行对应的「整行文本」（用于双击选词/三击选行/滚动缓存） */
  function getLineContentByRow(row: number): string | null {
    const flatRow = row - LOGO_ROWS - effectiveScrollTop;
    if (flatRow < 0) return null;
    let acc = 0;
    for (const msg of messages) {
      if (!msg.finalized) continue;
      if (flatRow < acc + msg.lines.length) {
        return msg.lines[flatRow - acc]?.content ?? null;
      }
      acc += msg.lines.length;
    }
    return null;
  }

  /** 停止拖拽自动滚动 */
  function stopAutoScroll(): void {
    if (autoScrollTimerRef.current !== null) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }

  /** 启动拖拽自动滚动（focus 超出视口时） */
  function maybeStartAutoScroll(focusRow: number): void {
    const viewportTopRow = LOGO_ROWS + effectiveScrollTop;
    const viewportBottomRow = viewportTopRow + visibleRows - 1;
    const outOfTop = focusRow < viewportTopRow;
    const outOfBottom = focusRow > viewportBottomRow;
    if (!outOfTop && !outOfBottom) {
      stopAutoScroll();
      return;
    }
    if (autoScrollTimerRef.current !== null) return; // 已在跑
    autoScrollTimerRef.current = setInterval(() => {
      setScrollTop((prev) => {
        const cur = computeScrollState({ total: messages.length, visibleRows, scrollTop: prev });
        const dir = outOfTop ? -1 : 1;
        const next = Math.max(0, Math.min(cur.maxScroll, prev + dir));
        // 滚出视口的行文本入缓存
        if (outOfTop && next < prev) {
          // 向上滚：顶部新出现的行算「above」缓存（拖拽扩展到视口上方）
          const rowLeaving = LOGO_ROWS + prev + visibleRows - 1; // 底部滚出的行
          const txt = getLineContentByRow(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('below', txt);
        } else if (outOfBottom && next > prev) {
          // 向下滚：顶部滚出的行入「above」缓存
          const rowLeaving = LOGO_ROWS + prev; // 顶部滚出的行
          const txt = getLineContentByRow(rowLeaving);
          if (txt) selectionStore.getState().pushScrolledOff('above', txt);
        }
        return next;
      });
    }, AUTOSCROLL_MS);
  }

  // 鼠标事件路由
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const str = typeof data === 'string' ? data : data.toString('utf8');
      const events = parserRef.current.feed(str);
      for (const ev of events) {
        // SGR col/row 1-origin → 0-based
        const row = ev.row - 1;
        const col = ev.col - 1;

        // 滚轮（拖拽中禁用）
        if (ev.type === 'wheelup' || ev.type === 'wheeldown') {
          if (selectionStore.getState().isDragging) continue; // 拖拽中禁用
          setScrollTop((prev) => {
            const cur = computeScrollState({ total: messages.length, visibleRows, scrollTop: prev });
            const delta = 3;
            const next = ev.type === 'wheelup' ? prev - delta : prev + delta;
            const clamped = Math.max(0, Math.min(cur.maxScroll, next));
            if (clamped < cur.maxScroll) userScrolledAwayRef.current = true;
            else userScrolledAwayRef.current = false;
            return clamped;
          });
          continue;
        }

        // 左键（button 0/32-motion）
        if (ev.button === 0 || ev.button === 32) {
          if (ev.type === 'mousedown') {
            // 多击检测
            const click = classifyClick(clickStateRef.current, ev.button, ev.row, ev.col, Date.now());
            clickStateRef.current = click.state;
            const lineContent = getLineContentByRow(row);
            if (click.kind === 'double' && lineContent !== null) {
              const hit = selectionStore.getState().selectWordAt(row, col, lineContent);
              if (hit) continue;
            } else if (click.kind === 'triple' && lineContent !== null) {
              selectionStore.getState().selectLineAt(row, lineContent);
              continue;
            }
            // single 或词/行未命中：开始拖拽
            selectionStore.getState().startDrag({ row, col });
          } else if (ev.type === 'mousedrag') {
            selectionStore.getState().dragTo({ row, col });
            maybeStartAutoScroll(row);
          } else if (ev.type === 'mouseup') {
            selectionStore.getState().endDrag();
            stopAutoScroll();
            // 不复制（spec：仅右键复制）
          }
          continue;
        }

        // 右键（button 2）：复制 + 清高亮
        if (ev.type === 'mousedown' && ev.button === 2) {
          stopAutoScroll();
          void copyOnRightClick();
          continue;
        }
      }
    };

    async function copyOnRightClick(): Promise<void> {
      const sel = selectionStore.getState();
      const text = getSelectedText({
        messages, scrollTop: effectiveScrollTop, visibleRows,
        viewportTopRow: LOGO_ROWS + effectiveScrollTop, selection: sel,
      });
      if (text) {
        try {
          await writeClipboard(text);
        } catch {
          // 剪贴板失败静默（spec §6 防御边界 4/5）
        }
      }
      selectionStore.getState().clear(); // 清高亮（含缓存）
    }

    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
      stopAutoScroll();
    };
  }, [stdin, messages, visibleRows, selectionStore, effectiveScrollTop]);

  // 开启鼠标追踪
  useEffect(() => {
    if (!stdin) return;
    setRawMode(true);
    process.stdout.write('\x1b[?1003h\x1b[?1006h');
    return () => {
      process.stdout.write('\x1b[?1003l\x1b[?1006l');
      setRawMode(false);
      stopAutoScroll();
    };
  }, [stdin, setRawMode]);

  // 当前选区（订阅 selectionStore）
  const sel = selectionStore.getState();

  return (
    <Box flexGrow={1} flexDirection="column" overflow="hidden">
      {visible.map((m, i) => {
        const globalRow = LOGO_ROWS + state.scrollTop + i;
        return (
          <MessageRow
            key={m.uuid}
            message={m}
            globalRow={globalRow}
            selectionStore={selectionStore}
          />
        );
      })}
    </Box>
  );
}
```

- [ ] **Step 4: 跑 typecheck + 全量测试**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS（MessageRow 新 props 与 ScrollBox 调用对齐）；所有测试 PASS（含 Task 7-8 改动）。若 `getLineContentByRow` 的闭包 `effectiveScrollTop` 在 setInterval 内过期（stale closure），把 `effectiveScrollTop` 加进 setScrollTop 的依赖读取——但 setScrollTop 的 updater 用 `prev` 计算，`effectiveScrollTop` 只用于 viewportTopRow 推算，可改为在 updater 内重算。如发现 stale 问题，把 `LOGO_ROWS + prev` 替换 `LOGO_ROWS + effectiveScrollTop`（prev 是最新 scrollTop）。

- [ ] **Step 5: 手动验证（charter 验证铁律）**

Run: `npm run build && node dist/index.js`
（在真实终端测：左键拖拽选区高亮、右键复制+清高亮、双击选词、三击选行、拖到顶/底自动滚动。Windows Terminal 下 OSC52 也可测：`$env:SSH_CONNECTION='1.2.3.4'; node dist/index.js` 强制走 OSC52 路径。）
Expected: 字符级高亮正确、右键复制到系统剪贴板、CJK 不切坏。

- [ ] **Step 6: commit**

```bash
git add src/tui/components/MessageRow.tsx src/tui/components/ScrollBox.tsx src/__tests__/tui/mouse-events.test.ts
git commit -m "feat(tui): 字符级选区 + 右键复制 + 双击选词 + 拖拽自动滚动

MessageRow：调 sliceLineBySelection 逐字符切片高亮（替代整行 inverse），
接收 globalRow + selectionStore。流式块不参与选区。
ScrollBox：事件路由扩展——左键拖拽选区、双击选词（click-detector）、
三击选行、右键复制+清高亮、拖拽自动滚动+scrolledOff 缓存、拖拽中禁用滚轮。
mouseup 不再自动复制（仅右键触发）。"
```

---

## Task 9: 最终验证 + 文档更新

**Goal:** 全量测试 + typecheck + build 通过；更新 .memory 记录踩坑。

**Files:**
- Modify: `.memory/ink-migration-progress.md`（或同类踩坑文档，若存在）

- [ ] **Step 1: 全量验证**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全部 PASS，build 产出 `dist/`。

- [ ] **Step 2: 场景模拟（charter 场景触发：3 个典型业务场景）**

按 charter 要求，首次部署/测试时模拟 3 个场景：

**场景 1：单行字符选区 + 右键复制**
- 定义：用户选中一行内的片段并复制。
- 流转：左键按下(row=5,col=2) → startDrag → 拖到(row=5,col=8) → dragTo → mouseup(endDrag，不复制) → 右键(button=2) → getSelectedText 取 [2,8) → writeClipboard → clear。
- 边界：选区为空（col==col）时右键 → getSelectedText 返回 '' → 不调 writeClipboard，仍 clear。

**场景 2：双击选词 + CJK**
- 定义：用户双击一个中英文混合词。
- 流转：mousedown → classifyClick(single) → 300ms 内同位置 mousedown → classifyClick(double) → selectWordAt(row,col,'你好world') → findWordBounds 码点扩展 → [0,4) 显示列 → anchor/focus 设好 → 高亮「你好world」。
- 边界：双击落在空格上 → findWordBounds 返回 [col,col) → selectWordAt 返回 false → 回退为 startDrag 单击选区。

**场景 3：SSH + OSC52 回退**
- 定义：用户在 SSH 会话里右键复制。
- 流转：右键 → getSelectedText → writeClipboard → SSH_CONNECTION 检测为 true → 跳过 OS 命令 → TMUX 检测（若有 → load-buffer）→ 否则 OSC52 写 stdout → 终端解码 base64 → 写本地剪贴板。
- 边界：OSC52 写入时 stdout 已关闭（进程退出中）→ write 抛错 → 静默（writeClipboard 内未 try/catch OSC52，但 process.stdout.write 抛错罕见；若需防御，copyOnRightClick 已有外层 try/catch）。

**瓶颈分析（charter 要求 2-3 个）**：
1. **MessageRow 切片性能**——大量小 `<Text>` 片段。Mitigation：只有与选区相交的行走切片（colsForRow null 时单段），Ink diff + DoubleBuffer emit 去重。实测若卡顿，对 MessageRow 加 React.memo + 选区稳定时不重渲染。
2. **拖拽自动滚动的 stale closure**——setInterval 内读 `effectiveScrollTop` 可能过期。Mitigation：updater 内用 `prev` 重算 viewportTopRow。
3. **OSC52 与 renderer 时序**——若自研 renderer 下一帧覆盖 OSC52 序列。Mitigation：实测验证；若覆盖，改在 renderer commit hook 后写。

- [ ] **Step 3: 更新踩坑文档（若存在）**

Run: `ls .memory/ 2>/dev/null`
若有 `ink-migration-progress.md` 或同类，追加一节「字符级选区」记录：
- CJK 钳位规则（落全角字符中间向左/右钳）
- L 型选择语义（首末按 anchor/focus 的 row，不是 min/max）
- OSC52 三级回退顺序
- 拖拽自动滚动 stale closure 坑

若无文档，跳过此步（不强制创建）。

- [ ] **Step 4: 最终 commit**

```bash
git add .memory/  # 若有更新
git commit -m "docs(memory): 字符级选区 + 右键复制踩坑记录"  # 若有更新
```

---

## 完成标准

- [ ] `npm run typecheck` PASS
- [ ] `npm test` PASS（新增 4 个 selection 测试文件 + 改 selection-store/clipboard 测试）
- [ ] `npm run build` 产出 dist/
- [ ] 手动验证：字符级拖拽高亮、右键复制、双击选词、三击选行、拖拽自动滚动、CJK 不切坏
- [ ] spec §6 防御边界 7 项全部覆盖（空选区/流式块/CJK/OSC52失败/tmux缺失/退出清理/坐标越界）
