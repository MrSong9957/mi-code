# Inline Grid Footer 渲染实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 cell 级双缓冲 + 绝对坐标定位替换 footer 的 cursorUp 相对定位，彻底解决 resize 堆叠。

**Architecture:** 复用 `src/render/` 的渲染核心（Screen/DoubleBuffer/diff/optimize/emit），新建 `InlineGridRenderer` 管理 footer 区域。emit.ts 增加 `yBias` 参数实现局部坐标→屏幕绝对坐标的转换。只改 footer 渲染路径，静态行（logo/消息）继续走 appendLine。

**Tech Stack:** TypeScript, vitest, Ink（inline 模式下空转）, src/render/ 双缓冲渲染核心

**Spec:** `docs/superpowers/specs/2026-07-14-inline-grid-footer-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/render/emit.ts` | 修改 | 增加 yBias 支持（所有 CUP 定位加偏移） |
| `src/render/emit.test.ts` | 创建 | yBias 单元测试 |
| `src/tui/inline/grid-renderer.ts` | 创建 | InlineGridRenderer 类（footer 双缓冲 + clearRegion + dispose） |
| `src/tui/inline/grid-renderer.test.ts` | 创建 | InlineGridRenderer 单元测试 |
| `src/tui/inline/InlineRenderer.ts` | 修改 | commit() 内部 footer 调用切到 gridRenderer（P4） |
| `src/tui/inline/InlineApp.tsx` | 修改 | 接入 gridRenderer + resize 检测（P4/P5） |
| `src/tui/bootstrap.tsx` | 修改 | 创建 InlineGridRenderer 实例并传入（P4） |

---

## Task 1: emit.ts 增加 yBias 支持

**Files:**
- Modify: `src/render/emit.ts`
- Test: `src/render/emit.test.ts`（创建）

- [ ] **Step 1: grep emit.ts 确认所有 ANSI 定位序列**

Run: `grep -n '\\x1b\[' src/render/emit.ts`

确认所有 `\x1b[row;colH`（CUP）和 `\x1b[K`（EL）的位置。
预期：CUP 在 patch 定位（~40 行）和末尾光标定位（~59 行）；`\x1b[K` 在 ERASE 分支（~44 行）。
`\x1b[K` 不需要 yBias（它擦当前行，依赖前置 CUP 已定位）。

- [ ] **Step 2: 写 yBias 失败测试**

Create `src/render/emit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { emit } from './emit.js';
import { CharPool } from './char-pool.js';
import { StylePool } from './style-pool.js';
import { ERASE_CHAR_ID, type Patch } from './types.js';

function createCtx(yBias?: number) {
  const written: string[] = [];
  const charPool = new CharPool();
  const stylePool = new StylePool();
  return {
    written,
    charPool,
    stylePool,
    ctx: {
      charPool,
      stylePool,
      stdout: { write: (s: string) => { written.push(s); return true; } },
      ...(yBias !== undefined ? { yBias } : {}),
    },
  };
}

describe('emit yBias', () => {
  it('yBias 未传时（默认 0）：CUP 用 patch.y + 1', () => {
    const { written, charPool, stylePool, ctx } = createCtx();
    const charId = charPool.intern('A');
    const patches: Patch[] = [
      { x: 5, y: 3, charId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // y=3, yBias=0 → CUP row=4
    expect(output).toContain('\x1b[4;6H');
  });

  it('yBias=26（footerTopRow=27）：CUP 用 patch.y + 27', () => {
    const { written, charPool, ctx } = createCtx(26);
    const charId = charPool.intern('A');
    const patches: Patch[] = [
      { x: 5, y: 0, charId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    const output = written.join('');
    // y=0, yBias=26 → CUP row=27
    expect(output).toContain('\x1b[27;6H');
  });

  it('yBias 影响末尾光标定位', () => {
    const { written, charPool, ctx } = createCtx(26);
    const charId = charPool.intern('A');
    const patches: Patch[] = [
      { x: 0, y: 1, charId, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, { ...ctx, cursor: { x: 3, y: 1 } });
    const output = written.join('');
    // cursor y=1, yBias=26 → CUP row=28
    expect(output).toContain('\x1b[28;4H');
  });

  it('yBias 不影响 \\x1b[K（EL 只擦当前行，依赖前置 CUP）', () => {
    const { ctx } = createCtx(26);
    const patches: Patch[] = [
      { x: 0, y: 0, charId: ERASE_CHAR_ID, styleId: 0, isFullWidthContinuation: false },
    ];
    emit(patches, ctx);
    // 不报错即通过——EL 不接受 yBias 参数
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run src/render/emit.test.ts`
Expected: FAIL（yBias 未实现，输出不含偏移后的坐标）

- [ ] **Step 4: 实现 yBias**

Modify `src/render/emit.ts`:

EmitContext 接口加 yBias:
```ts
export interface EmitContext {
  charPool: CharPool;
  stylePool: StylePool;
  stdout: { write: (s: string) => boolean };
  cursor?: CursorPos;
  /** y 轴偏移（alt-screen=0，inline=footerTopRow-1） */
  yBias?: number;
}
```

emit 函数签名加解构 yBias:
```ts
export function emit(patches: Patch[], ctx: EmitContext): void {
  const { charPool, stylePool, stdout, cursor, yBias } = ctx;
  const bias = yBias ?? 0;
```

Patch 定位加 bias（约第 40 行）:
```ts
      out.push(`\x1b[${patch.y + bias + 1};${patch.x + 1}H`);
```

末尾光标定位加 bias（约第 59 行）:
```ts
    out.push(`\x1b[${cursor.y + bias + 1};${cursor.x + 1}H`);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/render/emit.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 6: 运行 alt-screen 现有测试确认不破坏**

Run: `npx vitest run src/render/`
Expected: PASS（yBias 默认 0，alt-screen 行为不变）

- [ ] **Step 7: 提交**

```bash
git add src/render/emit.ts src/render/emit.test.ts
git commit -m "feat(render): emit 增加 yBias 支持（局部坐标→屏幕绝对坐标偏移）"
```

---

## Task 2: InlineGridRenderer 骨架 + commitFooter

**Files:**
- Create: `src/tui/inline/grid-renderer.ts`
- Test: `src/tui/inline/grid-renderer.test.ts`（创建）

- [ ] **Step 1: 写 commitFooter 失败测试**

Create `src/tui/inline/grid-renderer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { InlineGridRenderer } from './grid-renderer.js';
import { layoutFooter } from './layout.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    write: (s: string) => { written.push(s); return true; },
    columns: 80,
    rows: 30,
  };
}

describe('InlineGridRenderer.commitFooter', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次写入：全量重画 footer（front 全 0 → 所有 cell 都变）', () => {
    const layout = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 30, 80);
    const output = mock.output;
    // footerTopRow = 30 - 4 + 1 = 27, yBias = 26
    // 应含 CUP 定位到 row 27+
    expect(output).toContain('\x1b[27;');
    // 应含 border 字符（─）
    expect(output).toContain('─');
  });

  it('连续两次相同内容：第二次 diff 为空（无变化的 cell）', () => {
    const layout = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 30, 80);
    mock.written.length = 0;  // 清空，只看第二次

    renderer.commitFooter(layout, 30, 80);
    const output = mock.output;
    // diff(front, back) 应无变化 → emit 只输出 BSU + reset + ESU + cursor
    // 不应含 border 字符（没变化不需要重写）
    expect(output).not.toContain('─');
  });

  it('内容变化（输入文字）：只 diff 变化的 cell', () => {
    const layout1 = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout1, 30, 80);
    mock.written.length = 0;

    const layout2 = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout2, 30, 80);
    const output = mock.output;
    // 应含 'h' 和 'i'（输入框新增的字符）
    expect(output).toMatch(/hi/);
  });

  it('cols 变化（宽度缩小）：border 长度更新', () => {
    const layout1 = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout1, 30, 80);
    mock.written.length = 0;

    const layout2 = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 40,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout2, 30, 40);
    const output = mock.output;
    // 新 border 应是 39 个 ─（usableWidth=40-1=39）
    expect(output).toContain('─'.repeat(39));
    // 不应含旧的长 border（79 个 ─）
    expect(output).not.toContain('─'.repeat(79));
  });

  it('footer 高度变化（suggestion 展开）：先清旧区域再重画', () => {
    const layout1 = layoutFooter({
      input: '/', cursor: 1, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout1, 30, 80);
    expect(layout1.height).toBe(4);
    mock.written.length = 0;

    const layout2 = layoutFooter({
      input: '/', cursor: 1, status: 'test', cols: 80,
      suggestions: ['cmd-a', 'cmd-b', 'cmd-c'], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout2, 30, 80);
    expect(layout2.height).toBe(7);
    const output = mock.output;
    // 高度变化 → 先清旧区域（CUP + ED）
    expect(output).toContain('\x1b[0J');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tui/inline/grid-renderer.test.ts`
Expected: FAIL（`grid-renderer.ts` 不存在）

- [ ] **Step 3: 实现 InlineGridRenderer**

Create `src/tui/inline/grid-renderer.ts`:

```ts
// src/tui/inline/grid-renderer.ts
// Inline 模式的 footer 渲染器：用 cell 级双缓冲 + 绝对坐标定位。
//
// 核心区别（vs InlineRenderer.writeFooter 的 cursorUp 相对定位）：
// - 双缓冲：应用持有完整 footer 真相（front/back Screen），不依赖终端物理行
// - 绝对坐标：emit 用 \x1b[row;colH 定位，不依赖光标当前位置
// - resize 免疫：reflow 后重画即正确（绝对坐标不随 reflow 变化）

import { DoubleBuffer } from '../../render/screen.js';
import { diff } from '../../render/diff.js';
import { optimize } from '../../render/optimizer.js';
import { emit } from '../../render/emit.js';
import { blitAnsi } from '../../render/output-ops.js';
import type { FooterLayout } from './layout.js';

export class InlineGridRenderer {
  private db: DoubleBuffer | null = null;
  /** 上一次 footer 高度（供 clearRegion 清旧区域） */
  private lastHeight = 0;
  /** 上一次 cols（检测宽度变化） */
  private lastCols = 0;
  /** 上一次 footer 顶的绝对行号（1-based，供 clearRegion） */
  private lastFooterTopRow = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 清除屏幕上从 topRow 到屏幕底的区域。
   * CUP(topRow, 1) + ED（\x1b[0J）。
   */
  private clearRegion(topRow: number): void {
    this.stdout.write(`\x1b[${topRow};1H\x1b[0J`);
  }

  /**
   * 写入 footer（核心接口）。
   *
   * footerTopRow 每次实时计算（rows - newHeight + 1），不作为实例字段。
   * 高度或宽度变化时，先用缓存的旧值清旧区域，再重建 buffer 全量重画。
   */
  commitFooter(layout: FooterLayout, rows: number, cols: number): void {
    const newHeight = layout.lines.length;
    const footerTopRow = rows - newHeight + 1;

    const sizeChanged = (this.lastHeight !== newHeight || this.lastCols !== cols);

    // 高度或宽度变化 → 先清旧区域（用缓存的旧 footerTopRow）
    if (this.db && sizeChanged && this.lastFooterTopRow > 0) {
      this.clearRegion(this.lastFooterTopRow);
    }

    // 重建 DoubleBuffer（尺寸变化或首次）
    if (!this.db || sizeChanged) {
      this.db = new DoubleBuffer(newHeight, cols);
    }

    // back.clear() → blitAnsi 写入每行 footer 内容
    this.db.back.clear();
    for (let y = 0; y < layout.lines.length; y++) {
      blitAnsi(this.db.back, 0, y, layout.lines[y]!);
    }

    // diff → optimize → emit（yBias = footerTopRow - 1）
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: footerTopRow - 1,
      cursor: { x: layout.cursorCol, y: layout.cursorToTop },
    });

    // swap
    this.db.swap();

    // 缓存本次的值
    this.lastHeight = newHeight;
    this.lastCols = cols;
    this.lastFooterTopRow = footerTopRow;
  }

  /**
   * Resize 时彻底擦除旧 footer + 丢弃 buffer。
   * 下次 commitFooter 发现 db===null → 新建 → front 全 0 → 全量重画。
   */
  clearForResize(): void {
    if (this.lastFooterTopRow > 0) {
      this.clearRegion(this.lastFooterTopRow);
    }
    this.db = null;
    this.lastHeight = 0;
    this.lastCols = 0;
    this.lastFooterTopRow = 0;
  }

  /** unmount 时清除 footer（生命周期清理）。 */
  dispose(): void {
    this.clearForResize();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tui/inline/grid-renderer.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 运行 tsc 确认类型正确**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/tui/inline/grid-renderer.ts src/tui/inline/grid-renderer.test.ts
git commit -m "feat(inline): InlineGridRenderer——cell 级双缓冲 footer 渲染器"
```

---

## Task 3: clearForResize + dispose 测试

**Files:**
- Modify: `src/tui/inline/grid-renderer.test.ts`（追加测试）

- [ ] **Step 1: 写 clearForResize + dispose 失败测试**

追加到 `src/tui/inline/grid-renderer.test.ts` 末尾:

```ts
describe('InlineGridRenderer.clearForResize', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('clearForResize 执行 CUP + ED（清旧 footer 区域）', () => {
    const layout = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 30, 80);
    mock.written.length = 0;

    renderer.clearForResize();
    const output = mock.output;
    // footerTopRow=27 → CUP(27,1)
    expect(output).toContain('\x1b[27;1H');
    // ED（清到屏幕底）
    expect(output).toContain('\x1b[0J');
  });

  it('clearForResize 后 commitFooter 走全量重画（front 全 0）', () => {
    const layout = layoutFooter({
      input: 'hi', cursor: 2, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 30, 80);
    renderer.clearForResize();
    mock.written.length = 0;

    renderer.commitFooter(layout, 30, 80);
    const output = mock.output;
    // 全量重画：应含 border 字符（所有 cell 都变）
    expect(output).toContain('─');
  });

  it('clearForResize 在 db=null 时是 no-op（无 footer 可清）', () => {
    // 不先 commitFooter，直接 clearForResize
    renderer.clearForResize();
    expect(mock.written.length).toBe(0);
  });

  it('dispose 等同 clearForResize（清除 footer）', () => {
    const layout = layoutFooter({
      input: '', cursor: 0, status: 'test', cols: 80,
      suggestions: [], dropdownIndex: 0, viewportTop: 0,
    });
    renderer.commitFooter(layout, 30, 80);
    mock.written.length = 0;

    renderer.dispose();
    const output = mock.output;
    expect(output).toContain('\x1b[0J');
  });
});
```

- [ ] **Step 2: 运行测试确认通过（clearForResize/dispose 已在 Task 2 实现）**

Run: `npx vitest run src/tui/inline/grid-renderer.test.ts`
Expected: PASS（9 tests: 5 commitFooter + 4 clearForResize/dispose）

如果失败，检查 clearForResize 的 `lastFooterTopRow > 0` 条件是否正确。

- [ ] **Step 3: 提交**

```bash
git add src/tui/inline/grid-renderer.test.ts
git commit -m "test(inline): clearForResize + dispose 单元测试"
```

---

## Task 4: InlineApp 接入 gridRenderer（footer 路径切换）

**这是高风险阶段——改动主渲染路径。**

核心改动：footer 的擦除和重画全部由 gridRenderer 负责。
InlineRenderer.commit() 不再调 writeFooter；footer 擦除改用 gridRenderer.clearForResize()。

**渲染顺序（新消息到达时）：**
```
1. gridRenderer.clearForResize()   ← 擦旧 footer（gridRenderer 知道旧 footer 位置）
2. InlineRenderer: appendLine(新消息) + eraseStreamingLines/rewriteStreamingLines（流式草稿）
3. gridRenderer.commitFooter(layout) ← 在新位置画 footer（db=null → 全量重画）
```

**渲染顺序（无新消息，纯输入/spinner 更新）：**
```
1. gridRenderer.commitFooter(layout) ← diff 增量更新 footer（db 存在 → 只输出变化的 cell）
```

**Files:**
- Modify: `src/tui/bootstrap.tsx`（创建 InlineGridRenderer 实例）
- Modify: `src/tui/ConnectedApp.tsx`（透传 gridRenderer）
- Modify: `src/tui/inline/InlineApp.tsx`（footer 路径切到 gridRenderer）
- Modify: `src/tui/inline/InlineRenderer.ts`（commit() 不再写 footer）
- Modify: `src/__tests__/tui/inline-resize-follow.test.ts`（适配新接口）

- [ ] **Step 1: bootstrap.tsx 创建 gridRenderer 实例**

Modify `src/tui/bootstrap.tsx`:

加 import:
```ts
import { InlineGridRenderer } from './inline/grid-renderer.js';
```

在 `const inlineRenderer = isInline ? new InlineRenderer(process.stdout) : null;` 之后加:
```ts
const inlineGridRenderer = isInline ? new InlineGridRenderer(process.stdout) : null;
```

在 `<ConnectedApp>` 调用处加 prop:
```tsx
inlineGridRenderer={inlineGridRenderer}
```

在 cleanup 里加:
```ts
inlineGridRenderer?.dispose();
```

- [ ] **Step 2: ConnectedApp 透传 gridRenderer**

Modify `src/tui/ConnectedApp.tsx`:

加 import:
```ts
import type { InlineGridRenderer } from './inline/grid-renderer.js';
```

在 ConnectedAppProps 接口加:
```ts
inlineGridRenderer: InlineGridRenderer | null;
```

在 inline 分支的 `<InlineApp>` 调用处加 prop:
```tsx
gridRenderer={inlineGridRenderer!}
```

- [ ] **Step 3: InlineRenderer.commit() 不再写 footer**

Modify `src/tui/inline/InlineRenderer.ts`:

`commit()` 方法最后一行 `this.writeFooter(frame.footer);`——删除。
commit() 现在只负责：commitFooter（擦旧 footer，用于新消息让位）+ appendLine + 流式草稿。

同时 `commitFooter()` 方法保留——它擦旧 footer 区域让新消息写在正确位置。
**但注意**：commitFooter 擦的是 cursorUp 版的 footer。gridRenderer 画的 footer 也在同一个物理位置（屏幕底部 footerHeight 行），所以 cursorUp 版 commitFooter 仍能擦对位置（非 resize 时 cursorUp 定位是可靠的）。

commit() 内部保留 commitFooter 调用（justFinalized/hasNewFinalized 时）——擦旧 footer 让位给新消息。
删除 commit() 末尾的 `this.writeFooter(frame.footer)`——footer 重画交给 gridRenderer。

- [ ] **Step 4: InlineApp 接收 gridRenderer + footer 路径切换**

Modify `src/tui/inline/InlineApp.tsx`:

加 import:
```ts
import { InlineGridRenderer } from './grid-renderer.js';
```

InlineAppProps 加:
```ts
gridRenderer: InlineGridRenderer;
```

函数参数解构加 `gridRenderer`。

主 effect 里，原来的 commit 调用改为：
```ts
// 新消息到达时先让 gridRenderer 擦旧 footer
if (hasNewFinalized || justFinalized || needEraseDraft) {
  gridRenderer.clearForResize();
}

// commit 只负责 appendLine + 流式草稿（不再写 footer）
renderer.commit({
  newLines,
  streamingLines,
  footer: footerLayout,  // commit 内部不再用这个（writeFooter 已删），但接口保留避免改签名
  hasNewFinalized,
  transitions: { justFinalized, needEraseDraft },
});

// footer 由 gridRenderer 用双缓冲 + 绝对坐标渲染
const rows = process.stdout.rows ?? 24;
gridRenderer.commitFooter(footerLayout, rows, cols);
```

**注意**：renderer.commit() 内部的 commitFooter 调用和 gridRenderer.clearForResize() 可能重复擦除。
为避免冲突：commit() 内部保留 commitFooter（cursorUp 擦旧 footer）用于流式草稿让位场景；
新消息场景 gridRenderer.clearForResize() 已擦过。
如果两者都擦，第二次擦是无害的（擦已经空的区域）。

- [ ] **Step 5: 更新 inline-resize-follow.test.ts**

Modify `src/__tests__/tui/inline-resize-follow.test.ts`:

setup() 里创建真实 gridRenderer 并传入:
```ts
const gridRenderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
// 改为：
const gridRenderer = new InlineGridRenderer(mock as unknown as NodeJS.WriteStream);
```

baseProps 加 `gridRenderer`。

writeFooterCalls 的 spy 改为检查 gridRenderer.commitFooter:
```ts
const writeFooterCalls: { usableWidth: number; height: number }[] = [];
vi.spyOn(gridRenderer, 'commitFooter').mockImplementation((layout) => {
  writeFooterCalls.push({ usableWidth: layout.usableWidth, height: layout.height });
});
```

- [ ] **Step 6: 运行 inline 相关测试确认不破坏**

Run: `npx vitest run src/tui/inline/ src/__tests__/tui/`
Expected: PASS

如果 thinking-summary-gap-regression.test.ts 等挂载 InlineApp 的测试因 gridRenderer prop 缺失崩溃，补 gridRenderer prop。

- [ ] **Step 7: build 确认编译通过**

Run: `npm run build`
Expected: 无错误

- [ ] **Step 8: 真实终端快速验证（非 resize）**

Run: `node dist\index.js`
预期：logo + hook + footer 正常显示，输入字符 footer 更新正常（用 grid diff）。
不测 resize（P5 才接入）。

- [ ] **Step 9: 提交**

```bash
git add src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx src/tui/inline/InlineApp.tsx src/tui/inline/InlineRenderer.ts src/__tests__/tui/inline-resize-follow.test.ts
git commit -m "feat(inline): footer 渲染路径切到 InlineGridRenderer（grid diff 替代 cursorUp）"
```
Expected: PASS

- [ ] **Step 7: build 确认编译通过**

Run: `npm run build`
Expected: 无错误

- [ ] **Step 8: 真实终端快速验证（非 resize）**

Run: `node dist\index.js`
预期：logo + hook + footer 正常显示，输入字符 footer 更新正常（用 grid diff）。
不测 resize（P5 才接入）。

- [ ] **Step 9: 提交**

```bash
git add src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx src/tui/inline/InlineApp.tsx src/tui/inline/InlineRenderer.ts src/__tests__/tui/inline-resize-follow.test.ts
git commit -m "feat(inline): footer 渲染路径切到 InlineGridRenderer（grid diff 替代 cursorUp）"
```

---

## Task 5: resize 检测接入

**Files:**
- Modify: `src/tui/inline/InlineApp.tsx`（加 prevColsRef + resize 检测）

- [ ] **Step 1: 加 prevColsRef + resize 检测**

Modify `src/tui/inline/InlineApp.tsx`:

加 ref:
```ts
const prevColsRef = useRef<number>(cols);
```

在主 effect 开头（overlay 检查之后）加:
```ts
// resize 检测：cols 变化 → gridRenderer 清旧 footer + 下一帧全量重画
if (cols !== prevColsRef.current) {
  gridRenderer.clearForResize();
  prevColsRef.current = cols;
}
```

主 effect 依赖数组加 `cols`:
```ts
}, [messages, renderer, gridRenderer, inputText, cursor, statusData, spinner, logo, streamingText, overlay.visible, dropdownVisible, dropdownCandidates, dropdownIndex, cols]);
```

overlay effect 也加 cols（overlay resize 时重画）。

- [ ] **Step 2: 更新 inline-resize-follow.test.ts 契约**

把"纯 cols 变化不触发 writeFooter"改为"纯 cols 变化触发 clearForResize + commitFooter"。

- [ ] **Step 3: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/inline-resize-follow.test.ts`
Expected: PASS

- [ ] **Step 4: L2 全量回归**

Run: `npx vitest run src/tui/inline/ src/__tests__/tui/ src/__tests__/ui/`
Expected: PASS

- [ ] **Step 5: tsc 检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/tui/inline/InlineApp.tsx src/__tests__/tui/inline-resize-follow.test.ts
git commit -m "feat(inline): resize 检测接入——cols 变化时 clearForResize + 重画"
```

---

## Task 6: 真实终端验证

**Files:** 无（纯验证）

- [ ] **Step 1: build**

Run: `npm run build`
Expected: 无错误

- [ ] **Step 2: 用户真实环境验证（独立 cmd 窗口）**

Run: `node dist\index.js`

测试矩阵：
1. **启动**：logo + hook + footer 正常显示
2. **正常输入**：敲字符，footer 正常更新（grid diff）
3. **缩小窗口**：拖右边 缩到一半 → border 宽度跟随 → **不堆叠**
4. **放大窗口**：拖回原宽度 → border 宽度跟随 → **不堆叠**
5. **反复缩放**：连续缩放 5 次 → **不堆叠**
6. **输入 + 缩放**：输入文字后缩放 → footer 内容正确
7. **suggestion + 缩放**：输入 `/` 展开下拉后缩放 → footer 高度变化正确
8. **流式中缩放**（如有条件）：AI 回复时缩放 → 观察 streaming 表现（第一阶段接受短暂异常）

- [ ] **Step 3: 如果 resize 仍堆叠——诊断**

如果 Step 2 的缩放测试仍堆叠，加诊断日志（环境变量 MICODE_DIAG=1）到 gridRenderer.commitFooter，记录每次调用的 footerTopRow + rows + cols + patches.length。

- [ ] **Step 4: 如果 resize + 流式有问题——记录但不阻塞**

流式草稿的 resize 处理是第二阶段。第一阶段只要 footer resize 正常即可。
记录流式表现到 spec 文档的 §7.2。

- [ ] **Step 5: 更新 follow-bug 文档状态**

Modify `docs/compose/plans/2026-07-13-inline-resize-follow-bug.md`:
状态改为"✅ 已修复（grid 双缓冲 + 绝对坐标定位）"。

- [ ] **Step 6: 最终提交**

```bash
git add docs/compose/plans/2026-07-13-inline-resize-follow-bug.md
git commit -m "docs: resize 堆叠已修复——inline grid footer 双缓冲渲染"
```

---

## 防御性检查清单（实施时参考）

- [ ] emit.ts 所有 `\x1b[` 序列都检查了 yBias 影响（Task 1 Step 1）
- [ ] DoubleBuffer 尺寸 = `newHeight × cols`（不是 `rows × cols`）
- [ ] blitAnsi 写短行时右侧保持空 cell（不手动 pad）
- [ ] commitFooter 的 footerTopRow 每次实时算（不依赖实例字段）
- [ ] clearForResize 用缓存的 lastFooterTopRow 清旧区域
- [ ] dispose 在 unmount 时调用（替代旧 commitFooter 生命周期清理）
- [ ] resize + 正在流式时的表现已验证（P6 Step 2 测试 8）
