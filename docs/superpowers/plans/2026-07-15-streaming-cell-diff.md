# 流式草稿 Cell Diff 渲染实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 cell diff 替换流式草稿的行级覆写（cursorUp + \r\x1b[2K），消除流式闪烁。

**Architecture:** 新建 StreamingGridRenderer，复用 src/render/ 的 DoubleBuffer/diff/optimize/emit/blitAnsi，用 cell 级 diff 只输出变化的格子。和 footer 的 gridRenderer 平行——两个独立 grid。

**Tech Stack:** TypeScript, vitest, src/render/ 双缓冲渲染核心

**Spec:** `docs/superpowers/specs/2026-07-15-streaming-cell-diff-design.md`

---

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/tui/inline/streaming-grid-renderer.ts` | 创建 | StreamingGridRenderer（草稿 cell diff） |
| `src/tui/inline/streaming-grid-renderer.test.ts` | 创建 | 单元测试 |
| `src/tui/bootstrap.tsx` | 修改 | 创建 StreamingGridRenderer 实例 |
| `src/tui/ConnectedApp.tsx` | 修改 | 透传 streamingGrid |
| `src/tui/inline/InlineApp.tsx` | 修改 | 流式分支切到 streamingGrid |

---

## Task 1: StreamingGridRenderer 骨架 + commitStream

**Files:**
- Create: `src/tui/inline/streaming-grid-renderer.ts`
- Create: `src/tui/inline/streaming-grid-renderer.test.ts`

- [ ] **Step 1: 写 commitStream 失败测试**

Create `src/tui/inline/streaming-grid-renderer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { StreamingGridRenderer } from './streaming-grid-renderer.js';

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

describe('StreamingGridRenderer.commitStream', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let grid: StreamingGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    grid = new StreamingGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('首次写入：全量 diff（front 全 0 → 所有 cell 都变）', () => {
    grid.commitStream(['● hello', '  world'], 5, 80);
    const output = mock.output;
    // topRow=5, yBias=4 → CUP row=5+
    expect(output).toContain('\x1b[5;');
    expect(output).toContain('hello');
    expect(output).toContain('world');
  });

  it('增量更新（微调内容）：只输出变化的 cell，不擦整行', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello!'], 5, 80);
    const output = mock.output;
    // 只加了一个 '!'，不应含 \r\x1b[2K（整行擦除）
    expect(output).not.toContain('\x1b[2K');
    // 应含 '!' 字符
    expect(output).toContain('!');
  });

  it('行数增加（1→3）：旧行增量 + 新行追加', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello', '  world', '  foo'], 5, 80);
    const output = mock.output;
    expect(output).toContain('world');
    expect(output).toContain('foo');
  });

  it('行数减少（3→1）：多余行清除（不留残留）', () => {
    grid.commitStream(['● hello', '  world', '  foo'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello'], 5, 80);
    const output = mock.output;
    // world 和 foo 应被清除——diff 输出空格覆盖
    // 关键：buffer 高度取 max(3,1)=3，第 2-3 行 front 有旧内容，back 为空 → 清除 patch
    // 不应残留 world/foo 的字符
    expect(output).not.toMatch(/world/);
    expect(output).not.toMatch(/foo/);
  });

  it('连续两次相同内容：第二次 diff 为空', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello'], 5, 80);
    const output = mock.output;
    // diff 为空 → emit 只输出 BSU + reset + ESU（不含 hello）
    expect(output).not.toContain('hello');
  });

  it('topRow 变化（草稿位置移动）：新位置全量重画', () => {
    grid.commitStream(['● hello'], 5, 80);
    mock.written.length = 0;

    grid.commitStream(['● hello'], 7, 80);
    const output = mock.output;
    // topRow 从 5 变 7 → CUP row=7
    expect(output).toContain('\x1b[7;');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tui/inline/streaming-grid-renderer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 StreamingGridRenderer**

Create `src/tui/inline/streaming-grid-renderer.ts`:

```ts
// src/tui/inline/streaming-grid-renderer.ts
// 流式草稿的 cell diff 渲染器。
// 用 cell 级 diff 替换行级覆写（cursorUp + \r\x1b[2K），消除闪烁。
// 复用 src/render/ 的 DoubleBuffer/diff/optimize/emit/blitAnsi。

import { DoubleBuffer } from '../../render/screen.js';
import { diff } from '../../render/diff.js';
import { optimize } from '../../render/optimizer.js';
import { emit } from '../../render/emit.js';
import { blitAnsi } from '../../render/output-ops.js';

export class StreamingGridRenderer {
  private db: DoubleBuffer | null = null;
  private lastHeight = 0;
  private lastCols = 0;
  private lastTopRow = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 写入草稿（流式增量核心接口）。
   *
   * buffer 高度取 max(lastHeight, newHeight)——行数缩减时不缩小 buffer，
   * 否则 diff 看不见被裁掉的旧行 → 屏幕残留。
   */
  commitStream(lines: string[], topRow: number, cols: number): void {
    const newHeight = lines.length;
    const topRowChanged = (this.lastTopRow > 0 && this.lastTopRow !== topRow);
    this.lastTopRow = topRow;
    const sizeChanged = (this.lastHeight !== newHeight || this.lastCols !== cols);

    // buffer 高度取 max——行数缩减时保留旧行高度，diff 能输出清除 patch
    const bufferHeight = Math.max(this.lastHeight, newHeight);

    if (!this.db || sizeChanged) {
      const oldFront = this.db?.front ?? null;
      this.db = new DoubleBuffer(bufferHeight, cols);
      // 旧 front 内容拷贝到新 front（保留旧行）
      if (oldFront) {
        const copyRows = Math.min(oldFront.rows, bufferHeight);
        for (let y = 0; y < copyRows; y++) {
          for (let x = 0; x < Math.min(oldFront.cols, cols); x++) {
            const oldIdx = (y * oldFront.cols + x) * 2;
            const newIdx = (y * cols + x) * 2;
            this.db.front.chars[newIdx] = oldFront.chars[oldIdx]!;
            this.db.front.chars[newIdx + 1] = oldFront.chars[oldIdx + 1]!;
          }
        }
      }
    }

    // 位置变化 → front 全失效（强制在新位置全量重画）
    if (topRowChanged) {
      this.db.front.clear();
    }

    // back.clear() → blitAnsi 写入新草稿行（只写 newHeight 行，多出行保持空）
    this.db.back.clear();
    for (let y = 0; y < newHeight; y++) {
      blitAnsi(this.db.back, 0, y, lines[y]!);
    }

    // diff → optimize → emit
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: topRow - 1,
    });

    this.db.swap();
    this.lastHeight = newHeight;
    this.lastCols = cols;
  }

  /**
   * 固化时清空草稿区。
   * front 保持（有上一帧内容），back 全空 → diff 输出全部清除 patch。
   * 用内部 lastTopRow 定位（不依赖外部传值）。
   */
  clear(): void {
    if (!this.db || this.lastHeight === 0 || this.lastTopRow === 0) return;
    this.db.back.clear();
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: this.lastTopRow - 1,
    });
    this.db = null;
    this.lastHeight = 0;
    this.lastCols = 0;
    this.lastTopRow = 0;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tui/inline/streaming-grid-renderer.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 5: tsc 检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add src/tui/inline/streaming-grid-renderer.ts src/tui/inline/streaming-grid-renderer.test.ts
git commit -m "feat(inline): StreamingGridRenderer——流式草稿 cell diff 渲染器"
```

---

## Task 2: clear 方法测试

**Files:**
- Modify: `src/tui/inline/streaming-grid-renderer.test.ts`（追加测试）

- [ ] **Step 1: 追加 clear 测试**

在 `streaming-grid-renderer.test.ts` 末尾追加:

```ts
describe('StreamingGridRenderer.clear', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let grid: StreamingGridRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    grid = new StreamingGridRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('clear 后草稿区内容被擦除', () => {
    grid.commitStream(['● hello', '  world'], 5, 80);
    mock.written.length = 0;

    grid.clear();
    const output = mock.output;
    // front 有内容，back 全空 → diff 输出清除 patch
    // 应含 CUP 定位到 topRow=5
    expect(output).toContain('\x1b[5;');
    // 不应残留 hello/world（它们被空格覆盖）
    // 注意：ERASE_CHAR_ID → \x1b[K，不是字符
    expect(output).not.toContain('hello');
  });

  it('clear 在 db=null 时是 no-op', () => {
    grid.clear();
    expect(mock.written.length).toBe(0);
  });

  it('clear 用内部 lastTopRow（不依赖外部传值）', () => {
    grid.commitStream(['● hello'], 7, 80);
    mock.written.length = 0;

    grid.clear();  // 不传 topRow
    const output = mock.output;
    // 应定位到 topRow=7（内部存储的）
    expect(output).toContain('\x1b[7;');
  });

  it('clear 后 commitStream 走全量重建', () => {
    grid.commitStream(['● hello'], 5, 80);
    grid.clear();
    mock.written.length = 0;

    grid.commitStream(['● world'], 5, 80);
    const output = mock.output;
    // db=null → 全量 diff → 含 world
    expect(output).toContain('world');
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run src/tui/inline/streaming-grid-renderer.test.ts`
Expected: PASS（10 tests: 6 commitStream + 4 clear）

- [ ] **Step 3: 提交**

```bash
git add src/tui/inline/streaming-grid-renderer.test.ts
git commit -m "test(inline): StreamingGridRenderer clear 方法测试"
```

---

## Task 3: bootstrap + ConnectedApp 接入

**Files:**
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/ConnectedApp.tsx`

- [ ] **Step 1: bootstrap 创建实例**

Modify `src/tui/bootstrap.tsx`:

加 import:
```ts
import { StreamingGridRenderer } from './inline/streaming-grid-renderer.js';
```

在 `const inlineGridRenderer = ...` 之后加:
```ts
const inlineStreamingGrid = isInline ? new StreamingGridRenderer(process.stdout) : null;
```

在 `<ConnectedApp>` 调用处加 prop:
```tsx
inlineStreamingGrid={inlineStreamingGrid}
```

cleanup 不加 dispose（streamingGrid 没有持久状态需要清理）。

- [ ] **Step 2: ConnectedApp 透传**

Modify `src/tui/ConnectedApp.tsx`:

在 props 接口加:
```ts
inlineStreamingGrid?: import('./inline/streaming-grid-renderer.js').StreamingGridRenderer | null;
```

函数参数解构加 `inlineStreamingGrid: _inlineStreamingGrid`。

在 `<InlineApp>` 调用处加 prop:
```tsx
streamingGrid={_inlineStreamingGrid!}
```

- [ ] **Step 3: build 确认编译**

Run: `npm run build`
Expected: 无错误（InlineApp 还没接收 streamingGrid prop，先确保 ConnectedApp 编译）

- [ ] **Step 4: 提交**

```bash
git add src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx
git commit -m "feat(inline): bootstrap + ConnectedApp 透传 StreamingGridRenderer"
```

---

## Task 4: InlineApp 接入 streamingGrid（流式分支切换）

**这是高风险阶段——改动主渲染路径。**

**Files:**
- Modify: `src/tui/inline/InlineApp.tsx`
- Modify: `src/tui/inline/streaming-delta-rewrite-regression.test.ts`（适配）
- Modify: `src/tui/inline/thinking-summary-gap-regression.test.ts`（适配）
- Modify: `src/__tests__/tui/inline-resize-follow.test.ts`（适配）

- [ ] **Step 1: InlineApp 接收 streamingGrid + 流式分支切换**

Modify `src/tui/inline/InlineApp.tsx`:

加 import:
```ts
import { StreamingGridRenderer } from './streaming-grid-renderer.js';
```

InlineAppProps 加:
```ts
streamingGrid: StreamingGridRenderer;
```

函数参数解构加 `streamingGrid`。

主 effect 的流式分支改为:
```ts
    // ── 4. 流式/固化处理 ──
    if (streamingLines !== null) {
      // 流式：草稿用 cell diff，footer 用 gridRenderer（diff 为空，零闪烁）
      const streamTopRow = totalContentRowsRef.current + 1;
      streamingGrid.commitStream(streamingLines, streamTopRow, cols);
      // footer 位置随草稿行数变化 → gridRenderer 的 posChanged 处理
      const footerTopRow = streamTopRow + streamingLines.length;
      const rows = process.stdout.rows ?? 24;
      gridRenderer.commitFooter(footerLayout, Math.min(footerTopRow, rows - footerLayout.height + 1), cols);
    } else if (justFinalized || needEraseDraft) {
      // 固化：先清草稿区，再 appendLine 固化行（在 commit 内部）
      // 顺序关键：clear 先把草稿区清空，appendLine 紧接着写固化内容
      streamingGrid.clear();
      // commit 内部 eraseStreamingLines 会跳过（lastStreamingHeight 由 commitStream 管理，
      // 但 InlineRenderer 的 lastStreamingHeight 不再更新——需要在 commit 前清零）
      renderer.state.lastStreamingHeight = 0;
    } else if (hasNewFinalized) {
      gridRenderer.clearForResize();
    }
```

主 effect 的 commit 调用和 footer 渲染改为:
```ts
    renderer.commit({
      newLines,
      streamingLines: null,  // 草稿由 streamingGrid 管，commit 不再处理
      footer: footerLayout,
      hasNewFinalized,
      transitions: { justFinalized, needEraseDraft },
    });

    // footer 渲染（非流式时）
    totalContentRowsRef.current += newLines.length;
    if (streamingLines === null) {
      const rows = process.stdout.rows ?? 24;
      const contentLines = totalContentRowsRef.current;
      const footerTopRow = Math.min(contentLines + 1, rows - footerLayout.height + 1);
      gridRenderer.commitFooter(footerLayout, footerTopRow, cols);
    }
```

**注意关键改动**：
1. `streamingLines: null` 传给 commit——commit 不再调 rewriteStreamingLines
2. 流式时 footer 由 gridRenderer.commitFooter 处理（不再用旧版 writeFooter）
3. 固化时 streamingGrid.clear() 替代 eraseStreamingLines
4. `renderer.state.lastStreamingHeight = 0` 在固化前清零（防止 commit 内部 eraseStreamingLines 误操作）

依赖数组加 `streamingGrid`。

- [ ] **Step 2: 适配挂载 InlineApp 的测试**

每个挂载 InlineApp 的测试需要补 `streamingGrid` prop 并 spy `commitStream`。

对 `src/__tests__/tui/inline-resize-follow.test.ts`:
- 加 import: `import { StreamingGridRenderer } from '../../tui/inline/streaming-grid-renderer.js';`
- setup 里加: `const streamingGrid = new StreamingGridRenderer(mock as unknown as NodeJS.WriteStream);`
- 加 spy: `vi.spyOn(streamingGrid, 'commitStream').mockImplementation(() => {});`
- baseProps 加: `streamingGrid,`

对 `src/tui/inline/thinking-summary-gap-regression.test.ts` 和 `src/tui/inline/streaming-delta-rewrite-regression.test.ts`:
- 同样加 streamingGrid prop + spy commitStream + spy clear

- [ ] **Step 3: 运行 inline 测试**

Run: `npx vitest run src/tui/inline/ src/__tests__/tui/`
Expected: PASS（可能需要调整断言）

- [ ] **Step 4: build + tsc**

Run: `npm run build && npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add src/tui/inline/InlineApp.tsx src/__tests__/tui/inline-resize-follow.test.ts src/tui/inline/thinking-summary-gap-regression.test.ts src/tui/inline/streaming-delta-rewrite-regression.test.ts
git commit -m "feat(inline): 流式草稿切到 StreamingGridRenderer（cell diff 替代行级覆写）"
```

---

## Task 5: 真实终端验证

**Files:** 无（纯验证）

- [ ] **Step 1: build**

Run: `npm run build`
Expected: 无错误

- [ ] **Step 2: 真实终端验证**

Run: `node dist\index.js`

测试矩阵：
1. **启动**：logo + hook + footer 正常
2. **流式输出**：输入 `你是谁？`，观察流式过程——**不闪？输入框可见？**
3. **固化后**：消息完整不截断？
4. **流式 + 缩放**：流式过程中缩放窗口——草稿和 footer 表现？
5. **多轮对话**：连续两轮 AI 回复——第二轮流式正常？
6. **thinking + assistant 流式**：thinking 后跟 assistant 流式——衔接正常？

- [ ] **Step 3: 如果闪烁消除——更新文档**

更新 `docs/compose/plans/2026-07-13-inline-resize-follow-bug.md` 记录流式闪烁已修复。

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "docs: 流式闪烁已修复——cell diff 替代行级覆写"
```
