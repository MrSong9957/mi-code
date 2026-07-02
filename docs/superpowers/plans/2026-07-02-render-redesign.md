# 渲染引擎重设计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重写 Renderer 的 commit/renderFull 核心，废弃画布 diff 三段，改用"消息顺序追加 + 流式退格重写 + 底部区 CUP 绝对定位"三子系统，根治满屏乱码。

**Architecture:** 双区解耦——消息区只追加（封口即不可变），流式块局部 CUU+eraseLine 回溯重写，底部固定区（边框+输入框+状态栏）每帧用 CUP 绝对定位刷新。三者不共享画布，互不干扰。

**Tech Stack:** TypeScript 6.0.3 / Node.js ESM / Vitest / 纯 ANSI（cup/cursorUp/eraseLine/SGR）

**设计文档：** `docs/superpowers/specs/2026-07-02-render-redesign-design.md`

---

## 文件结构

| 文件 | 改动 | 职责 |
|------|------|------|
| `src/renderer/renderer.ts` | 重写 commit/renderFull，删画布字段/Segment/inspectFrame/writeCellsRow，新增 writeMsgLine/rewriteStreamingBlock/refreshFooter | 唯一核心改动 |
| `src/__tests__/renderer-redesign.test.ts` | 新建 | 新架构的 TDD 测试 |

**保留不动**：MessageFormatter、block-format、MessageBuffer、VirtualScreen、Screen、cell/highlight/markdown、ansi、BlockPipeline、UILayout、index.ts。

**重要约束**：Renderer 的公开 API（enter/exit/printMessage/appendStreamingMarkdown/sealStreaming/finalizeStreaming/clearMessages/setInput/setToolStatus/setHint/clearToolStatus/getPrompt/flushNow/resize）签名**完全不变**——UILayout/BlockPipeline 无需改动。

---

## Task 1: 底部区刷新器 refreshFooter（CUP 绝对定位）

这是最独立、最易测试的子系统，先做。

**Files:**
- Modify: `src/renderer/renderer.ts`（新增 private refreshFooter 方法）
- Test: `src/__tests__/renderer-redesign.test.ts`（新建）

- [ ] **Step 1: 写失败测试——refreshFooter 用 CUP 定位最后 footerHeight 行**

新建 `src/__tests__/renderer-redesign.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';

describe('底部区刷新器 refreshFooter（CUP 绝对定位）', () => {
  it('底部区内容总在屏幕最后 footerHeight 行（用 CUP 定位，不依赖光标位置）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    // enter 后取最后一帧（含底部区渲染）
    const lastFrame = frames[frames.length - 1]!;
    // 底部区应在 CUP 到第 (rows - footerHeight + 1) 行起（1-based）
    // footerHeight = 2(边框) + 1(inputLineCount) + 1(状态栏) = 4
    // 上边框应在 CUP 第 5 行（rows=8, 8-4+1=5）
    expect(lastFrame).toContain('\x1b[5;');  // CUP 到第 5 行
    expect(lastFrame).toContain('─');        // 边框
    expect(lastFrame).toContain('MDL');      // 状态栏 model
    expect(lastFrame).toContain('❯');        // 输入框 prompt
  });

  it('底部区用 CUP 绝对定位，不含相对移动 CUB/CUU（避开光标脱钩）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.setInput('hello', 5);
    r.flushNow();
    const all = frames.join('');
    // 底部区刷新帧不应含大数值 CUB（旧画布 diff 的标志）
    const bigCub = [...all.matchAll(/\x1b\[(\d+)D/g)].map(m => +m[1]!).filter(n => n > 10);
    expect(bigCub, '底部区不应有大数值 CUB（应用 CUP 绝对定位）').toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts`
Expected: FAIL（refreshFooter 还不存在 / 现有 commit 用画布 diff 不用 CUP）

- [ ] **Step 3: 实现 refreshFooter**

在 renderer.ts 新增 private 方法（复用 getInputLineCount/buildStatusBar/BORDER_CHAR/DEFAULT_PROMPT/cup/eraseLine）：
```ts
private refreshFooter(): void {
  const inputLineCount = getInputLineCount(this.input);
  const footerHeight = 2 + inputLineCount + 1;
  const inputStartScreenRow = this.rows - footerHeight + 1; // 1-based CUP
  const borderTopRow = inputStartScreenRow;
  const borderBottomRow = inputStartScreenRow + inputLineCount;
  const statusRow = borderBottomRow + 1;
  // 上边框
  this.writer('\x1b[' + borderTopRow + ';1H\x1b[2K');
  this.writer('─'.repeat(Math.ceil(this.cols / 1))); // BORDER_CHAR 宽度 1
  // 输入框（每行）
  const inputLines = this.input.split('\n');
  for (let li = 0; li < inputLineCount; li++) {
    const row = inputStartScreenRow + li;
    const line = inputLines[li] ?? '';
    const prefix = li === 0 ? this.prompt : '';
    this.writer('\x1b[' + row + ';1H\x1b[2K');
    if (prefix) this.writer('\x1b[32m\x1b[1m'); // PROMPT_STYLE green bold
    this.writer(prefix);
    this.writer('\x1b[0m');
    this.writer(line);
  }
  // 下边框
  this.writer('\x1b[' + borderBottomRow + ';1H\x1b[2K');
  this.writer('─'.repeat(Math.ceil(this.cols / 1)));
  // 状态栏
  const statusCells = buildStatusBar({
    mode: this.statusInfo.mode, model: this.statusInfo.model,
    branch: this.statusInfo.branch, dir: this.statusInfo.dir,
    contextUsage: this.statusInfo.contextUsage,
    cols: this.cols, tool: this.tool ?? undefined, hint: this.hint,
  });
  this.writer('\x1b[' + statusRow + ';1H\x1b[2K');
  for (const cell of statusCells) this.writer(cell.char);
}
```
注：样式（SGR）先用简化版（prompt green/bold），后续 Task 5 精修样式。先保证结构和 CUP 定位正确。

- [ ] **Step 4: 在 commit()/renderFull() 末尾调用 refreshFooter（临时，建立接线）**

暂时在现有 renderFull 末尾（showCursor 之前）加一行 `this.refreshFooter();`，让测试能走到。完整 commit 重写在后续 Task。

- [ ] **Step 5: 运行测试验证通过**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: 提交**
```bash
git add src/renderer/renderer.ts src/__tests__/renderer-redesign.test.ts
git commit -m "feat(renderer): 底部区刷新器 refreshFooter（CUP 绝对定位）"
```

---

## Task 2: 消息追加器 writeMsgLine + lastFlushedLine

**Files:**
- Modify: `src/renderer/renderer.ts`
- Test: `src/__tests__/renderer-redesign.test.ts`

- [ ] **Step 1: 写失败测试——消息追加器只增不减，封口行进 scrollback**

在 renderer-redesign.test.ts 追加：
```ts
describe('消息追加器 writeMsgLine（顺序追加）', () => {
  it('连续 printMessage 多条：每条作为新行追加，旧行不重复', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('msg-1', 'system');
    r.flushNow();
    r.printMessage('msg-2', 'system');
    r.flushNow();
    const all = frames.join('');
    // 每条消息只出现一次（不重复）
    expect((all.match(/msg-1/g) || []).length).toBe(1);
    expect((all.match(/msg-2/g) || []).length).toBe(1);
  });

  it('满屏后（消息超过 rows-footerHeight）：最新消息在可视区，不内容重复', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    for (let i = 1; i <= 10; i++) {
      r.printMessage('msg-' + i, 'system');
      r.flushNow();
    }
    const all = frames.join('');
    // 每条消息最多出现 1 次（满屏后旧行进 scrollback，不重复堆积）
    for (let i = 1; i <= 10; i++) {
      const count = (all.match(new RegExp('msg-' + i, 'g')) || []).length;
      expect(count, 'msg-' + i + ' 出现 ' + count + ' 次（应 ≤1）').toBeLessThanOrEqual(1);
    }
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts -t "消息追加器"`
Expected: FAIL（现有画布 diff 会重复，或 lastFlushedLine 不存在）

- [ ] **Step 3: 新增 lastFlushedLine 字段 + writeMsgLine 方法**

在 Renderer 类字段区新增：
```ts
private lastFlushedLine = 0;
```
新增方法：
```ts
private writeMsgLine(line: { cells: Cell[]; role: MessageRole }): void {
  // eraseLine + 写该行内容 + LF 下移
  this.writer('\x1b[2K'); // 擦当前行
  for (const cell of line.cells) {
    if (cell.char === '\u0000') continue; // 跳过宽字符占位
    this.writer(cell.char);
  }
  this.writer('\r\n'); // CR+LF（满屏时触发终端原生滚动）
}
```

- [ ] **Step 4: 重写 commit()——三段式骨架（此 Task 先实现段1+段3）**

把 commit()（renderer.ts:232-371）替换为：
```ts
private commit(): void {
  if (!this.entered) return;
  this.writer(hideCursor());

  // 段 1：消息追加器（只增不减）
  const allLines = this.messages.allLines();
  while (this.lastFlushedLine < allLines.length) {
    this.writeMsgLine(allLines[this.lastFlushedLine]!);
    this.lastFlushedLine++;
  }

  // 段 2：流式重写器（Task 3 实现，此处暂留空）
  // if (this.streamingBlockStartRow !== null) this.rewriteStreamingBlock();

  // 段 3：底部区刷新器
  this.refreshFooter();

  // 光标定位
  const cursor = this.computeInputCursorPos();
  const footerHeight = 2 + getInputLineCount(this.input) + 1;
  const inputScreenRow = this.rows - footerHeight + 1 + cursor.row; // 1-based
  this.writer('\x1b[' + inputScreenRow + ';' + (cursor.col + 1) + 'H');
  this.writer(showCursor());
}
```
**注意**：此时 renderFull 也需简化（首帧时 lastFlushedLine=0，commit 段1 会画所有消息）。把 renderFull 改为只清屏（resize/首帧时）：
```ts
private renderFull(): void {
  this.writer(hideCursor());
  this.writer('\x1b[2J\x1b[H'); // 全清屏（首帧/resize）
  this.lastFlushedLine = 0;       // 重置，让 commit 段1 重画所有消息
  this.streamingBlockStartRow = null;
  this.commit(); // 委托给 commit 走三段式
}
```

- [ ] **Step 5: 删除画布 diff 字段 + Segment 逻辑**

删除字段：`prevScreen`、`prevHeight`、`prevCursorY`、`prevCursorX`（renderer.ts:78-82）。
删除方法体内的 Segment 1/1.5/2/3 代码（已在 Step 4 替换 commit）。
删除 `inspectFrame`（:452-488）、`writeCellsRow`（:425-438）——不再被引用。
删除 `import { Screen }`（如果 commit 不再用 Screen）。
新增字段 `private streamingBlockStartRow: number | null = null;`（Task 3 用）。

- [ ] **Step 6: 修复编译错误**

Run: `npm run typecheck`
逐一修复因删除字段/方法导致的未使用引用。保留 `mergeBaseStyle`（printMessage 用）。

- [ ] **Step 7: 运行测试验证通过**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 8: 跑全套回归**

Run: `npm test`
Expected: 现有 main-screen*.test.ts 可能失败（它们测旧画布 diff 行为）——记录失败列表，Task 6 处理。renderer-redesign.test.ts 应全过。

- [ ] **Step 9: 提交**
```bash
git add src/renderer/renderer.ts src/__tests__/renderer-redesign.test.ts
git commit -m "feat(renderer): 消息追加器 writeMsgLine + commit 三段式骨架（删除画布diff）"
```

---

## Task 3: 流式重写器 rewriteStreamingBlock（退格重写当前块）

**Files:**
- Modify: `src/renderer/renderer.ts`
- Test: `src/__tests__/renderer-redesign.test.ts`

- [ ] **Step 1: 写失败测试——流式 assistant 逐字增长，退格重写当前块**

在 renderer-redesign.test.ts 追加：
```ts
describe('流式重写器 rewriteStreamingBlock（退格重写）', () => {
  it('assistant delta 逐字增长：当前块被退格重写，封口后不可变', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 20, cols: 60,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.appendStreamingMarkdown('hello', false);
    r.flushNow();
    r.appendStreamingMarkdown('hello world', false);
    r.flushNow();
    // 封口
    r.appendStreamingMarkdown('hello world final', true);
    r.flushNow();
    frames.length = 0;
    // 封口后再画一条消息，确认 hello world final 不被改动
    r.printMessage('next-msg', 'system');
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('hello world final');
    expect(all).toContain('next-msg');
  });

  it('流式重写用 CUU（退格）回到块起点，范围=块行数（不超过屏幕）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 20, cols: 60,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.appendStreamingMarkdown('first version', false);
    r.flushNow();
    frames.length = 0;
    r.appendStreamingMarkdown('first version extended', false);
    r.flushNow();
    const delta = frames.join('');
    // 应含 CUU（退格重写）
    const cuu = [...delta.matchAll(/\x1b\[(\d+)A/g)].map(m => +m[1]!);
    expect(cuu.length, '流式重写应含 CUU 退格').toBeGreaterThan(0);
    // CUU 数值不超过 rows（不跨屏回溯）
    expect(Math.max(0, ...cuu)).toBeLessThan(20);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts -t "流式重写器"`
Expected: FAIL（段2未实现）

- [ ] **Step 3: 实现 rewriteStreamingBlock**

新增方法：
```ts
private rewriteStreamingBlock(): void {
  if (this.streamingBlockStartRow === null) return;
  const allLines = this.messages.allLines();
  const currentLineCount = allLines.length - this.streamingBlockStartRow;
  // 降级：块已超可视区，封口已写部分，转为纯追加
  const footerHeight = 2 + getInputLineCount(this.input) + 1;
  if (currentLineCount >= this.rows - footerHeight) {
    this.streamingBlockStartRow = allLines.length;
    return; // 不退格，段1 已追加新行
  }
  // 退格回块起点：CUU currentLineCount
  this.writer('\x1b[' + currentLineCount + 'A');
  // 逐行 eraseLine + 重写
  for (let i = 0; i < currentLineCount; i++) {
    this.writer('\x1b[2K');
    const line = allLines[this.streamingBlockStartRow + i]!;
    for (const cell of line.cells) {
      if (cell.char === '\u0000') continue;
      this.writer(cell.char);
    }
    if (i < currentLineCount - 1) this.writer('\r\n');
  }
  // 更新 lastFlushedLine（块已重写到当前位置）
  this.lastFlushedLine = allLines.length;
}
```

- [ ] **Step 4: 在 commit 段2 启用流式重写**

把 commit 段2 的注释取消：
```ts
// 段 2：流式重写器
if (this.streamingBlockStartRow !== null) {
  this.rewriteStreamingBlock();
}
```

- [ ] **Step 5: 在 appendStreamingMarkdown 中维护 streamingBlockStartRow**

修改 appendStreamingMarkdown（renderer.ts:142-151），在 setStreamingRows 之前：
```ts
appendStreamingMarkdown(text: string, isFinal: boolean, opts = {...}): void {
  // 首次 delta 记录块起点
  if (this.streamingBlockStartRow === null) {
    this.streamingBlockStartRow = this.messages.allLines().length;
  }
  const rows = renderMarkdown(text, this.cols, !isFinal);
  this.messages.setStreamingRows(rows, opts);
  if (isFinal) {
    this.streamingBlockStartRow = null; // 封口
  }
  this.scheduleRender();
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts`
Expected: PASS（6 tests）

- [ ] **Step 7: 提交**
```bash
git add src/renderer/renderer.ts src/__tests__/renderer-redesign.test.ts
git commit -m "feat(renderer): 流式重写器 rewriteStreamingBlock（退格重写当前块）"
```

---

## Task 4: clearMessages / resize / enter 适配新架构

**Files:**
- Modify: `src/renderer/renderer.ts`

- [ ] **Step 1: 写失败测试——clearMessages 清屏，resize 重画保留历史**

在 renderer-redesign.test.ts 追加：
```ts
describe('边界：clearMessages / resize / enter', () => {
  it('clearMessages 全清屏，lastFlushedLine 归零', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('to-clear', 'system');
    r.flushNow();
    frames.length = 0;
    r.clearMessages();
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('\x1b[2J'); // 全清屏
  });

  it('resize 后 lastFlushedLine 归零，消息从 MessageBuffer 重画', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('resize-test', 'system');
    r.flushNow();
    frames.length = 0;
    r.resize(10, 50);
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('\x1b[2J'); // 清屏
    expect(all).toContain('resize-test'); // 从 MessageBuffer 重画
  });
});
```

- [ ] **Step 2: 运行测试验证失败/通过**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts -t "边界"`

- [ ] **Step 3: 适配 clearMessages**

```ts
clearMessages(): void {
  this.messages.clear();
  this.lastFlushedLine = 0;
  this.streamingBlockStartRow = null;
  this.writer('\x1b[2J\x1b[H');
  this.scheduleRender();
}
```

- [ ] **Step 4: 适配 resize**

```ts
resize(rows: number, cols: number): void {
  this.rows = rows;
  this.cols = cols;
  this.messages.setWrapCols(cols);
  this.lastFlushedLine = 0;
  this.streamingBlockStartRow = null;
  this.writer('\x1b[2J\x1b[H');
  this.scheduleRender();
}
```

- [ ] **Step 5: 适配 enter（首帧只画底部区）**

```ts
enter(): void {
  if (this.entered) return;
  this.entered = true;
  this.writer(hideCursor());
  this.refreshFooter();
  const cursor = this.computeInputCursorPos();
  const footerHeight = 2 + getInputLineCount(this.input) + 1;
  const inputScreenRow = this.rows - footerHeight + 1 + cursor.row;
  this.writer('\x1b[' + inputScreenRow + ';' + (cursor.col + 1) + 'H');
  this.writer(showCursor());
}
```

- [ ] **Step 6: 运行测试验证通过**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts`
Expected: PASS（8 tests）

- [ ] **Step 7: 提交**
```bash
git add src/renderer/renderer.ts src/__tests__/renderer-redesign.test.ts
git commit -m "feat(renderer): clearMessages/resize/enter 适配新架构"
```

---

## Task 5: 样式精修（SGR 颜色）

前几个 Task 用了简化样式（prompt green/bold，消息无色）。本 Task 精修，让 markdown 代码高亮、块前缀颜色（● magenta、⎿ dim）、边框 dim 都正确。

**Files:**
- Modify: `src/renderer/renderer.ts`

- [ ] **Step 1: 写失败测试——消息行带正确样式（cells 的 style 转 SGR）**

在 renderer-redesign.test.ts 追加：
```ts
describe('样式精修（SGR 颜色）', () => {
  it('消息行 cells 的 style 被转为 SGR 指令（如 magenta → 35m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('● magenta test', 'system', { fg: 'magenta' });
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('\x1b[35m'); // magenta SGR
  });

  it('边框行带 dim 样式（2m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    const all = frames.join('');
    // 边框 ─ 应带 dim（refreshFooter 里 BORDER_STYLE = { dim: true }）
    expect(all).toContain('\x1b[2m'); // dim SGR
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts -t "样式精修"`

- [ ] **Step 3: 引入 styleToAnsi 辅助 + 改 writeMsgLine/refreshFooter 发 SGR**

在 renderer.ts 顶部加辅助（或复用 cell.ts 的 styleKey 机制）：
```ts
function styleToAnsi(style: Style): string {
  let s = '';
  if (style.fg === 'magenta') s += '\x1b[35m';
  else if (style.fg === 'green') s += '\x1b[32m';
  else if (style.fg === 'cyan') s += '\x1b[36m';
  else if (style.fg === 'red') s += '\x1b[31m';
  else if (style.fg === 'yellow') s += '\x1b[33m';
  if (style.bg) s += ''; // bg 简化
  if (style.bold) s += '\x1b[1m';
  if (style.dim) s += '\x1b[2m';
  if (style.italic) s += '\x1b[3m';
  if (style.underline) s += '\x1b[4m';
  return s;
}
```
改 writeMsgLine 逐 cell 发 SGR（只在 style 变化时发）：
```ts
private writeMsgLine(line: { cells: Cell[]; role: MessageRole }): void {
  this.writer('\x1b[2K');
  let lastStyleKey = '';
  for (const cell of line.cells) {
    if (cell.char === '\u0000') continue;
    const key = styleKey(cell.style);
    if (key !== lastStyleKey) {
      this.writer('\x1b[0m' + styleToAnsi(cell.style));
      lastStyleKey = key;
    }
    this.writer(cell.char);
  }
  this.writer('\x1b[0m'); // 行末重置
  this.writer('\r\n');
}
```
refreshFooter 的边框/状态栏也加相应 SGR（边框 dim、状态栏 buildStatusBar 已含 style，需遍历发 SGR）。

- [ ] **Step 4: 运行测试验证通过**

Run: `npx vitest run src/__tests__/renderer-redesign.test.ts`
Expected: PASS（10 tests）

- [ ] **Step 5: 提交**
```bash
git add src/renderer/renderer.ts src/__tests__/renderer-redesign.test.ts
git commit -m "feat(renderer): 样式精修（SGR 颜色，复用 cell styleKey）"
```

---

## Task 6: 修复/更新旧测试（main-screen*.test.ts）

Task 2-5 重写了 commit/renderFull，旧的 main-screen.test.ts / main-screen-pipeline.test.ts 测的是画布 diff 行为，会失败。本 Task 决定每个旧测试的去留。

**Files:**
- Modify: `src/__tests__/main-screen.test.ts`, `src/__tests__/main-screen-pipeline.test.ts`

- [ ] **Step 1: 跑全套测试，记录失败列表**

Run: `npm test 2>&1 | grep -E "FAIL|×"`
记录每个失败测试的名称和原因。

- [ ] **Step 2: 逐个评估旧测试**

对每个失败测试判断：
- **仍验证有价值的属性**（如"满屏后可视区有最新消息"、"footer 在底部"、"无横向拉伸"）→ 适配新架构的断言（可能从"含 \x1b[2J"改成"含 CUP"等）
- **验证旧画布 diff 的实现细节**（如 Segment 走哪条路径、prevScreen 行为）→ 删除（已废弃）

- [ ] **Step 3: 修复保留的测试**

针对每个保留的测试，调整断言以匹配新架构输出。常见调整：
- 旧断言"含 \x1b[2J" → 新架构满屏后不再 fullReset，改为"含 CUP 定位底部区"
- 旧断言基于 FakeTerminal 的 grid（模拟 scrollback）→ 新架构 grid 语义变化，重新校准

- [ ] **Step 4: 运行全套测试验证通过**

Run: `npm test`
Expected: 全绿（renderer-redesign + 适配后的 main-screen* + 其他不变）

- [ ] **Step 5: 提交**
```bash
git add src/__tests__/main-screen.test.ts src/__tests__/main-screen-pipeline.test.ts
git commit -m "test(renderer): 适配新架构，更新/删除测旧画布diff的测试"
```

---

## Task 7: 真实终端验证 + 收尾

**Files:**
- 无代码改动（验证为主）

- [ ] **Step 1: typecheck + lint + test 全绿**

Run: `npm run typecheck && npm run lint && npm test`
Expected: 全绿

- [ ] **Step 2: 真实终端验证（用户手动）**

启动：`npx tsx src/index.ts`
验证场景：
1. 普通问答（未满屏）：banner + 单轮回复，无乱码
2. 满屏工具调用：多轮 thinking + tool_call + tool_result，**无内容重复、无边框串入**
3. 流式长回复：单块超过一屏，降级为追加正常
4. resize：拖拽窗口，重画无崩溃
5. 满屏后打字：输入框响应正常

- [ ] **Step 3: 删除废弃代码（Screen.diffCells / renderDiff / inspectFrame 如仍残留）**

确认这些不再被任何引用后删除：
- `src/renderer/screen.ts` 的 `static diffCells`（如 commit 不再用）
- `src/renderer/diff.ts` 的 `renderDiff`（仅测试用）
- `src/__tests__/diff.test.ts`（如果删了 renderDiff）

Run: `npm run typecheck && npm test` 确认无回归。

- [ ] **Step 4: 最终提交**
```bash
git add -A
git commit -m "chore(renderer): 清理废弃的画布diff代码（Screen.diffCells/renderDiff）"
```

---

## 自审清单

### Spec 覆盖（对照设计文档各节）
- [x] 第3节双区解耦 → Task 1（底部区）+ Task 2（消息区）
- [x] 第4节三子系统 → Task 1/2/3
- [x] 第5.1消息追加器 → Task 2
- [x] 第5.2流式重写器（含降级）→ Task 3
- [x] 第5.3底部区刷新器 → Task 1
- [x] 第6节新commit → Task 2 Step 4
- [x] 第7节代码映射（删画布字段/Segment/inspectFrame）→ Task 2 Step 5
- [x] 第8.1 resize → Task 4
- [x] 第8.2 clearMessages → Task 4
- [x] 第8.3长回复降级 → Task 3（rewriteStreamingBlock 内）
- [x] 第8.4打字光标 → Task 2（commit 末尾 CUP）
- [x] 第8.6首帧enter → Task 4
- [x] 第9节验证 → Task 7

### 类型一致性
- `lastFlushedLine`、`streamingBlockStartRow` 在所有 Task 中拼写一致 ✓
- `writeMsgLine(line: { cells; role })` 签名一致 ✓
- `refreshFooter()` 无参 ✓
- `rewriteStreamingBlock()` 无参 ✓

### 占位符扫描
- 无 TBD/TODO ✓
- 每个代码步骤含完整代码 ✓
