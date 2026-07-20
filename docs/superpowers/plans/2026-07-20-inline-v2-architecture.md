# Inline V2 架构改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 inline 模式从手动 `InlineRenderer.commit()` 迁移到 stock Ink reconciler + `<Static>` + `createIncremental`,消除流式输出累积重复帧 bug。

**Architecture:** 加 `MICODE_INLINE_V2` flag 控制 V0/V2 路径切换。V2 路径用独立入口组件 `<InlineAppV2>`(不复用现有 `<App>`,避免污染 alt-screen),内部用 `<Static>` 包已固化消息、`<Spinner>`/`<Footer>`/`<StreamingText>` 各自 memo + 局部订阅 store。stock Ink 内置的 `createIncremental` 做行级 diff,spinner tick 只重写 spinner 行。

**Tech Stack:** TypeScript 5 + Node.js 18 + ESM(NodeNext)+ React 19 + Ink 7.1.0 + Zustand 5 + Vitest 3

**Spec:** `docs/superpowers/specs/2026-07-20-inline-v2-architecture-design.md`

**关键参考文档**:
- `docs/流式输出无限循环问题.md`(原始问题)
- `docs/流式输出无限循环问题-CC讨论记录.md`(5 轮 Claude Code review)
- `scripts/ink-poc/poc-inline-diff.tsx`(POC 基线:spinner tick 写 44-46B vs 完整 412B)

---

## 文件结构

### 新建文件

| 路径 | 责任 |
|---|---|
| `src/tui/inline-v2/InlineAppV2.tsx` | V2 路径根组件:`<Static>` + `<ActiveAreaV2>` |
| `src/tui/inline-v2/MessageLine.tsx` | 单条已固化消息渲染(用 `renderFinalizedLine` + `<Text>`) |
| `src/tui/inline-v2/StreamingText.tsx` | 流式草稿渲染(用 `wrapStreamingTextTrimmed`) |
| `src/tui/inline-v2/FooterV2.tsx` | V2 footer(不含 spinner,spinner 是兄弟) |
| `src/tui/inline-v2/spinner-memo.tsx` | Spinner 的 memo 包装(自己订阅 store) |
| `src/__tests__/tui/inline-v2/incremental-rendering.test.tsx` | POC 回归测试(每 CI 跑) |
| `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx` | `<InlineAppV2>` 组件测试 |
| `src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx` | `<FooterV2>` memo 隔离测试 |
| `src/__tests__/tui/inline-v2/streaming-text.test.tsx` | `<StreamingText>` 测试 |
| `src/__tests__/tui/inline-v2/message-line.test.tsx` | `<MessageLine>` 测试 |
| `src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx` | `MICODE_INLINE_V2` flag 分支测试 |

### 修改文件

| 路径 | 改动 |
|---|---|
| `src/tui/bootstrap.tsx:179-184` | 加 `MICODE_INLINE_V2` flag + V2 路径 `incrementalRendering: true` |
| `src/tui/ConnectedApp.tsx:305-326` | 加 V2 分支(返回 `<InlineAppV2>`) |
| `src/tui/state/messages-store.ts` | 加 `finalizeStreaming` 原子性测试(不改实现) |

### 不动文件(红线)

- `src/tui/App.tsx`(alt-screen 入口)
- `src/tui/components/Footer.tsx`(alt-screen footer)
- `src/tui/components/Spinner.tsx`(alt-screen spinner)
- `src/tui/components/ScrollBox.tsx`
- `src/tui/inline/*`(V0 路径全部保留作 fallback)
- `patches/ink+7.1.0.patch`(现有 patch 已支持,V2 只是不注入 renderer)

### 删除文件(仅阶段 5b,V2 稳定后)

- `src/tui/inline/InlineRenderer.ts` / `InlineApp.tsx` / `InlineRenderState.ts`
- `src/tui/inline/layout.ts` / `diff.ts`
- `src/tui/inline/SpinnerLine.tsx`(buildSpinnerLines 部分)
- `src/tui/inline/use-throttled-streaming-text.ts`(仅当 5a 实测确认 Ink 节流够)
- V0 专属测试

---

## 实施前置(每个 stage 之前必须完成)

- 当前分支:`codex/spinner-completion-composition`
- 工作树状态:有未提交改动(`InlineRenderer.ts` `prevFrameSnapshot` / `use-throttled-streaming-text.ts` 250ms / `use-input-handler.ts` SGR 过滤等)——**保留作为 V0 fallback,不还原**
- 每个 stage 完成后必须:
  1. 跑 `npm test` 全绿(尤其 alt-screen 测试)
  2. 跑 POC 回归测试 `npx vitest run src/__tests__/tui/inline-v2/incremental-rendering.test.tsx`
  3. Commit
- 阶段间有严格依赖,不可跳跃

---

# 阶段 0:准备(worktree + 基线)

**目标**:隔离工作区,固化 V0 基线测试,把 POC 转为可重复回归测试。

**估算**:0.5 天

---

### Task 0.1:创建 worktree

**Files:** 无(仅 git 操作)

- [ ] **Step 1:确认当前分支干净(允许未提交改动)**

```bash
cd D:/Files/Projects/mi-code
git status
git log --oneline -5
```

Expected: 当前分支 `codex/spinner-completion-composition`,有未提交改动(`M src/__tests__/tui/use-input-handler.test.tsx` 等)。

- [ ] **Step 2:把未提交改动先 stash 或 commit 到当前分支**

```bash
# 把 V0 fallback 改动 commit 到当前分支(它们是 V0 路径的改进,本身有价值)
git add -A
git commit -m "fix(inline-v0): preserve as fallback (prevFrameSnapshot + 250ms throttle + SGR filter)"
```

- [ ] **Step 3:创建 V2 工作分支**

```bash
git checkout -b codex/inline-v2-architecture
git log --oneline -3
```

Expected: 新分支 `codex/inline-v2-architecture`,HEAD 与原分支一致。

---

### Task 0.2:扩展 POC 为可重复回归测试

**Files:**
- Create: `src/__tests__/tui/inline-v2/incremental-rendering.test.tsx`

**参考**:`scripts/ink-poc/poc-inline-diff.tsx`(已有 POC,把它转成 vitest 测试)

- [ ] **Step 1:写失败测试 — `<Static>` 一次性写入**

创建 `src/__tests__/tui/inline-v2/incremental-rendering.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, Box, Text, Static } from 'ink';
import React, { memo, useState, useEffect } from 'react';

// 复用 POC 的 MockStdout(从 scripts/ink-poc/poc-inline-diff.tsx 复制 MockStdout 类)
// ↑ 实现时把 MockStdout 抽到 src/__tests__/tui/inline-v2/helpers/mock-stdout.ts

describe('InlineV2 incrementalRendering', () => {
  it('<Static> 已固化消息只写一次进 stdout', async () => {
    const stdout = createMockStdout();
    const finalized = [
      { id: 1, text: 'message 1' },
      { id: 2, text: 'message 2' },
    ];

    const instance = render(
      <Static items={finalized}>
        {(msg) => <Text key={msg.id}>[F] {msg.text}</Text>}
      </Static>,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
        incrementalRendering: true,
      },
    );

    await new Promise((r) => setTimeout(r, 100));
    instance.unmount();

    const staticWrites = stdout.writes.filter((w) => w.data.includes('[F]'));
    expect(staticWrites.length).toBe(1);
  });
});
```

- [ ] **Step 2:运行测试验证它通过(基础场景)**

```bash
npx vitest run src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
```

Expected: PASS(`<Static>` 确实只写一次)。如果 FAIL,检查 MockStdout 的 `isTTY = true` 设置。

- [ ] **Step 3:加 spinner tick 测试 — 未变行不被重写**

在同一个 describe 块里加:

```tsx
it('spinner tick 时未变行(footer/statusbar)不被重写', async () => {
  const stdout = createMockStdout();
  const instance = render(<AppWithSpinnerTick />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
  });

  await new Promise((r) => setTimeout(r, 600));  // 12 个 50ms tick
  instance.unmount();

  // 完整活动区首次写入(应该只有 1 次)
  const fullFrames = stdout.writes.filter(
    (w) => w.data.includes('border-') && w.data.includes('status-')
  );
  expect(fullFrames.length).toBe(1);

  // spinner tick 后的帧字节应 < 80B(只有 spinner 行)
  const spinnerFrames = stdout.writes.filter(
    (w) => w.data.includes('Working') && w.bytes > 0 && w.bytes < 80
  );
  expect(spinnerFrames.length).toBeGreaterThan(5);  // 至少 5 个 tick
});
```

(其中 `<AppWithSpinnerTick />` 是测试专用 fixture,含 `<Static>` + 活动 spinner + 未变 footer + 未变 statusbar)

- [ ] **Step 4:运行测试验证**

```bash
npx vitest run src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
```

Expected: PASS。如果 FAIL(spinner tick 帧 > 80B),说明 memo 或 incrementalRendering 没生效。

- [ ] **Step 5:Commit**

```bash
git add src/__tests__/tui/inline-v2/
git commit -m "test(inline-v2): establish POC regression baseline (Static + incremental)"
```

---

### Task 0.3:把 MockStdout 抽成共用 helper

**Files:**
- Create: `src/__tests__/tui/inline-v2/helpers/mock-stdout.ts`

- [ ] **Step 1:抽 MockStdout 类**

把 `scripts/ink-poc/poc-inline-diff.tsx` 里的 `MockStdout` 类移到 `src/__tests__/tui/inline-v2/helpers/mock-stdout.ts`,导出 `createMockStdout()` 工厂函数。

- [ ] **Step 2:更新 POC 测试用新 helper**

把 `incremental-rendering.test.tsx` 里的内联 MockStdout 替换为 `import { createMockStdout } from './helpers/mock-stdout.js'`。

- [ ] **Step 3:跑测试验证**

```bash
npx vitest run src/__tests__/tui/inline-v2/
```

Expected: 全绿。

- [ ] **Step 4:Commit**

```bash
git add src/__tests__/tui/inline-v2/helpers/
git commit -m "refactor(inline-v2-test): extract MockStdout helper"
```

---

# 阶段 1:flag + bootstrap 分支(无组件树改动)

**目标**:`MICODE_INLINE_V2` flag 接通,但 V2 分支暂时返回与 V0 相同的 `<InlineApp>`(占位)。

**估算**:0.5 天

---

### Task 1.1:加 flag 判断逻辑(bootstrap)

**Files:**
- Modify: `src/tui/bootstrap.tsx:179-184`
- Test: `src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx`

- [ ] **Step 1:写失败测试**

创建 `src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('bootstrap MICODE_INLINE_V2 flag', () => {
  const origEnv = process.env.MICODE_INLINE_V2;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MICODE_INLINE_V2;
    else process.env.MICODE_INLINE_V2 = origEnv;
  });

  it('MICODE_INLINE_V2=0 时创建 InlineRenderer', async () => {
    process.env.MICODE_INLINE_V2 = '0';
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    // V0 路径会创建 InlineRenderer → unmount 时 destroy 会发 \x1b[?25h\x1b[?7h
    // 通过检查 handle 是否有 inlineV2 标志判断
    expect((handle as any).inlineV2).toBe(false);
    handle.cleanup();
  });

  it('MICODE_INLINE_V2=1 时不创建 InlineRenderer,标记为 V2', async () => {
    process.env.MICODE_INLINE_V2 = '1';
    const { bootstrap } = await import('../../../tui/bootstrap.js');
    const handle = bootstrap({
      logo: { version: '0', dir: '/tmp' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 },
      onSubmit: () => {},
      onExit: () => {},
      renderMode: 'inline',
    });
    expect((handle as any).inlineV2).toBe(true);
    handle.cleanup();
  });
});
```

- [ ] **Step 2:运行测试验证失败**

```bash
npx vitest run src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
```

Expected: FAIL,`handle.inlineV2` 是 `undefined`。

- [ ] **Step 3:修改 bootstrap.tsx 加 flag 判断**

在 `src/tui/bootstrap.tsx:122` 附近的 `bootstrap()` 函数开头加:

```tsx
// V2 flag: inline 模式下,V2 走 Ink 原生 + incrementalRendering;V0 走 InlineRenderer
const useInlineV2 = isInline && process.env.MICODE_INLINE_V2 !== '0';
```

修改 `bootstrap.tsx:179-184` 块:

```tsx
// alt-screen:自研双缓冲 renderer(不变)
if (!isInline && USE_DOUBLE_BUFFER) {
  renderOptions.renderer = createCustomRenderer({ stdout: process.stdout });
  renderOptions.onSetCursorPosition = (pos) => { setCursorPos(pos as { x: number; y: number } | undefined); };
}
// inline V2:不注入 renderer,走 Ink 原生 + incrementalRendering
if (useInlineV2) {
  renderOptions.incrementalRendering = true;
}
// inline V0(fallback):保留 InlineRenderer
const inlineRenderer = (isInline && !useInlineV2) ? new InlineRenderer(process.stdout) : null;
```

修改 `BootstrapHandle` interface(在 `src/tui/bootstrap.tsx:78`)加字段:

```tsx
/** 当前 inline 路径:V0(InlineRenderer)或 V2(Ink reconciler) */
readonly inlineV2: boolean;
```

修改返回对象(`bootstrap.tsx:215` 附近):

```tsx
return {
  pipeline, messagesStore, /* ...其他不变 */
  inlineV2: useInlineV2,  // ← 新增
  /* ...其他不变 */
};
```

- [ ] **Step 4:运行测试验证通过**

```bash
npx vitest run src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
```

Expected: PASS。

- [ ] **Step 5:跑全量测试确保没破坏**

```bash
npm test
```

Expected: 全绿(尤其 alt-screen 测试)。

- [ ] **Step 6:Commit**

```bash
git add src/tui/bootstrap.tsx src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
git commit -m "feat(inline): add MICODE_INLINE_V2 flag (no behavior change yet)"
```

---

### Task 1.2:ConnectedApp 加 V2 分支(占位返回 InlineApp)

**Files:**
- Modify: `src/tui/ConnectedApp.tsx:305-326`

- [ ] **Step 1:在 ConnectedApp 加 V2 分支**

修改 `src/tui/ConnectedApp.tsx:305` 附近的 early return 块:

```tsx
if (isInline && _inlineRenderer) {
  // V0 路径(原代码不变)
  return (
    <DropdownProvider>
      <InlineApp
        messages={messages}
        /* ...其他 props 不变 */
      />
    </DropdownProvider>
  );
}

if (isInline && !_inlineRenderer) {
  // V2 路径(占位:暂时返回与 V0 相同的 InlineApp,但 inlineRenderer 为 undefined)
  // ↑ 阶段 2 会替换为真正的 <InlineAppV2>
  // 当前不可能进入此分支(阶段 1 还没接 V2),先抛错占位
  throw new Error('InlineAppV2 not implemented yet (MICODE_INLINE_V2=1)');
}

return (
  <DropdownProvider>
    <App /* ...alt-screen props 不变 */ />
  </DropdownProvider>
);
```

- [ ] **Step 2:跑全量测试**

```bash
npm test
```

Expected: 全绿(V2 分支抛错不影响任何测试,因为没人开 V2 flag)。

- [ ] **Step 3:手工冒烟测试**

```bash
# 默认 V0
npx tsx src/index.ts --version

# 开 V2(应该报错"not implemented")
MICODE_INLINE_V2=1 npx tsx src/index.ts --version 2>&1 | head -5
```

Expected: 第二条命令输出 "InlineAppV2 not implemented yet" 错误。

- [ ] **Step 4:Commit**

```bash
git add src/tui/ConnectedApp.tsx
git commit -m "feat(inline-v2): add ConnectedApp V2 branch (placeholder throws)"
```

---

# 阶段 2:V2 组件树(`<Static>` + `<MessageLine>`,无 spinner/streaming)

**目标**:V2 路径能渲染 logo + 已固化消息(`<Static>`)+ 空 footer。

**估算**:1 天

---

### Task 2.1:写 `<MessageLine>` 组件

**Files:**
- Create: `src/tui/inline-v2/MessageLine.tsx`
- Test: `src/__tests__/tui/inline-v2/message-line.test.tsx`

**参考实现**:`renderFinalizedLine`(`src/tui/inline/text-layout.ts:193`)返回 ANSI string[],Ink `<Text>` 能透传 ANSI(POC 已验证)。

- [ ] **Step 1:写失败测试**

创建 `src/__tests__/tui/inline-v2/message-line.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { MessageLine } from '../../../tui/inline-v2/MessageLine.js';

describe('<MessageLine>', () => {
  it('渲染 assistant 普通行', () => {
    const msg = {
      uuid: 'msg-1',
      role: 'assistant' as const,
      lines: [{ content: 'hello world', style: {}, indent: 0 }],
      finalized: true,
    };
    const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
    expect(lastFrame()).toContain('hello world');
  });

  it('多行消息渲染所有行', () => {
    const msg = {
      uuid: 'msg-2',
      role: 'user' as const,
      lines: [
        { content: 'line 1', style: {}, indent: 0 },
        { content: 'line 2', style: {}, indent: 0 },
      ],
      finalized: true,
    };
    const { lastFrame } = render(<MessageLine msg={msg} cols={80} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line 1');
    expect(frame).toContain('line 2');
  });
});
```

- [ ] **Step 2:运行测试验证失败**

```bash
npx vitest run src/__tests__/tui/inline-v2/message-line.test.tsx
```

Expected: FAIL,`MessageLine` 不存在。

- [ ] **Step 3:实现 MessageLine**

创建 `src/tui/inline-v2/MessageLine.tsx`:

```tsx
// V2 路径下单条已固化消息渲染
// 物理本质:<Static> items 的 children render prop 返回的组件。
// 用 renderFinalizedLine(已有纯函数)转 ANSI,Ink <Text> 透传 ANSI(POC 已验证)。

import React from 'react';
import { Text } from 'ink';
import { renderFinalizedLine } from '../inline/text-layout.js';
import type { TuiMessage } from '../types.js';

export interface MessageLineProps {
  msg: TuiMessage;
  cols: number;
}

export function MessageLine({ msg, cols }: MessageLineProps): React.ReactElement {
  return (
    <Text>
      {msg.lines.flatMap((line, lineIdx) =>
        renderFinalizedLine(msg.role, line, cols).map((ansiLine, i) => (
          <Text key={`${lineIdx}-${i}`}>{ansiLine + '\n'}</Text>
        ))
      )}
    </Text>
  );
}
```

- [ ] **Step 4:运行测试验证通过**

```bash
npx vitest run src/__tests__/tui/inline-v2/message-line.test.tsx
```

Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/tui/inline-v2/MessageLine.tsx src/__tests__/tui/inline-v2/message-line.test.tsx
git commit -m "feat(inline-v2): add <MessageLine> component"
```

---

### Task 2.2:写 `<InlineAppV2>` 组件骨架(只渲染 `<Static>` + 占位 footer)

**Files:**
- Create: `src/tui/inline-v2/InlineAppV2.tsx`
- Test: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`

- [ ] **Step 1:写失败测试**

创建 `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { InlineAppV2 } from '../../../tui/inline-v2/InlineAppV2.js';
import { createMessagesStore } from '../../../tui/state/messages-store.js';
import { createInputStore } from '../../../tui/state/input-store.js';
import { createStatusStore } from '../../../tui/state/status-store.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectStore } from '../../../tui/state/select-store.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';

function createStores() {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main' }),
    spinnerStore: createSpinnerStore(),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    overlayStore: createOverlayStore(),
    selectionStore: createSelectionStore(),
  };
}

describe('<InlineAppV2>', () => {
  it('渲染已固化消息', () => {
    const stores = createStores();
    stores.messagesStore.getState().appendMessage('assistant', [
      { content: 'hello', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(
      <InlineAppV2
        messages={stores.messagesStore.getState().messages}
        status={stores.statusStore.getState() as any}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    expect(lastFrame()).toContain('hello');
  });

  it('不渲染 <ScrollBox>(V2 用 <Static>)', () => {
    // V2 组件树里没有 <ScrollBox> 节点
    // 通过检查渲染输出不含 ScrollBox 特征文本判断
    const stores = createStores();
    const { lastFrame } = render(
      <InlineAppV2
        messages={[]}
        status={stores.statusStore.getState() as any}
        logo={{ version: '0', dir: '/tmp' }}
        stores={stores}
        cols={80}
        rows={24}
      />
    );
    // V2 不应该有 alt-screen 的 logo 3 行 ASCII art(那个是 <LogoBox>)
    // ↑ 这个断言较弱,阶段 3 加更强的"无 ScrollBox"断言
    expect(lastFrame()).toBeDefined();
  });
});
```

- [ ] **Step 2:运行测试验证失败**

```bash
npx vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
```

Expected: FAIL,`InlineAppV2` 不存在。

- [ ] **Step 3:实现 InlineAppV2 骨架**

创建 `src/tui/inline-v2/InlineAppV2.tsx`:

```tsx
// V2 inline 模式根组件
// 物理本质:走 Ink reconciler + <Static> + 活动区(<Spinner>/<StreamingText>/<Footer>)
// 与 V0 的 <InlineApp> 区别:返回真正的 React 元素,而非 <></> + 副作用。
//
// 阶段 2:只渲染 <Static> + 占位 footer,无 spinner/streaming

import React from 'react';
import { Box, Static, Text } from 'ink';
import { MessageLine } from './MessageLine.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectStore } from '../state/select-store.js';
import type { SelectionStore } from '../state/selection-store.js';
import type { OverlayStore } from '../state/overlay-store.js';

export interface InlineAppV2Stores {
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  selectStore: SelectStore;
  selectionStore: SelectionStore;
  overlayStore: OverlayStore;
}

export interface InlineAppV2Props {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  stores: InlineAppV2Stores;
  cols: number;
  rows: number;
}

export function InlineAppV2({ messages, status, logo, stores, cols }: InlineAppV2Props): React.ReactElement {
  const finalized = messages.filter((m) => m.finalized);
  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(msg) => <MessageLine key={msg.uuid} msg={msg} cols={cols} />}
      </Static>
      {/* 阶段 3 加 <Spinner>,阶段 4 加 <StreamingText> */}
      <Text>{'─'.repeat(cols)}</Text>
      <Text>{'❯ '}</Text>
    </Box>
  );
}
```

- [ ] **Step 4:运行测试验证通过**

```bash
npx vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
```

Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/tui/inline-v2/InlineAppV2.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx
git commit -m "feat(inline-v2): scaffold <InlineAppV2> with <Static> + placeholder footer"
```

---

### Task 2.3:把 `<InlineAppV2>` 接入 ConnectedApp

**Files:**
- Modify: `src/tui/ConnectedApp.tsx`

- [ ] **Step 1:替换 ConnectedApp 的 V2 分支占位**

修改 `src/tui/ConnectedApp.tsx`,把 Task 1.2 的 `throw new Error` 分支替换为真正的 `<InlineAppV2>`:

```tsx
// 在 import 区加
import { InlineAppV2 } from './inline-v2/InlineAppV2.js';

// 替换 V2 分支
if (isInline && !_inlineRenderer) {
  // V2 路径
  return (
    <DropdownProvider>
      <InlineAppV2
        messages={messages}
        status={status}
        logo={logo}
        stores={{
          messagesStore,
          inputStore,
          statusStore,
          spinnerStore,
          completionStore,
          selectStore,
          selectionStore,
          overlayStore,
        }}
        cols={cols}
        rows={rows}
      />
    </DropdownProvider>
  );
}
```

- [ ] **Step 2:跑全量测试**

```bash
npm test
```

Expected: 全绿(V2 路径不再抛错)。

- [ ] **Step 3:手工冒烟测试**

```bash
# 开 V2 启动(需要 mock LLM 或快速 ESC)
MICODE_INLINE_V2=1 npx tsx src/index.ts
```

Expected: 能看到 logo + 输入框 + border(无 spinner,无 messages)。

- [ ] **Step 4:Commit**

```bash
git add src/tui/ConnectedApp.tsx
git commit -m "feat(inline-v2): wire <InlineAppV2> into ConnectedApp (static render only)"
```

---

# 阶段 3:Spinner + Footer 接入(memo + 局部订阅)

**目标**:V2 路径渲染完整 footer(spinner + 输入 + statusbar),且 spinner tick 不拖动 footer 重渲染。

**估算**:2 天

**这是最大风险阶段**。每个 memo 都要逐个验证 props 引用稳定性。

---

### Task 3.1:写 V2 Footer(无 spinner,加 memo)

**Files:**
- Create: `src/tui/inline-v2/FooterV2.tsx`
- Test: `src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx`

**注意**:V2 footer 与 alt-screen `<Footer>`(在 `src/tui/components/Footer.tsx`)**是两个独立组件**(不共享代码,因为 alt-screen footer 含 spinner 子组件,V2 不含)。

- [ ] **Step 1:写失败测试 — 渲染基本结构**

创建 `src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { FooterV2 } from '../../../tui/inline-v2/FooterV2.js';
import { createCompletionStore } from '../../../tui/state/completion-store.js';
import { createSelectionStore } from '../../../tui/state/selection-store.js';

describe('<FooterV2>', () => {
  it('渲染 border + 输入 + statusbar', () => {
    const completionStore = createCompletionStore();
    const selectionStore = createSelectionStore();
    const { lastFrame } = render(
      <FooterV2
        input="hello"
        cursor={5}
        status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0.5 }}
        cols={80}
        inputRowY={10}
        viewportTop={0}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('─');
    expect(frame).toContain('❯');
    expect(frame).toContain('sonnet');
  });
});
```

- [ ] **Step 2:运行测试验证失败**

```bash
npx vitest run src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx
```

Expected: FAIL,`FooterV2` 不存在。

- [ ] **Step 3:实现 FooterV2**

创建 `src/tui/inline-v2/FooterV2.tsx`:

```tsx
// V2 inline 模式的 Footer(独立于 alt-screen 的 <Footer>)
// 物理本质:flex 列:border + 输入框 + border + statusbar。
// 与 alt-screen <Footer> 区别:**不含 spinner**(spinner 是兄弟)。
//
// 加 memo:所有 props 在 spinner tick 时不变化 → spinner tick 不触发本组件重渲染。

import React from 'react';
import { Box, Text, useCursor } from 'ink';
import { cursorScreenPos } from '../state/cursor-position.js';
import { MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { StatusBar } from '../components/StatusBar.js';  // 复用 alt-screen 的 StatusBar(它自己已经订阅 selectionStore)
import type { StatusBarData } from '../types.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

const PROMPT = '❯ ';
const CONTINUATION_INDENT = '  ';

export interface FooterV2Props {
  input: string;
  cursor: number;
  status: StatusBarData;
  cols: number;
  inputRowY: number;
  viewportTop: number;
  completionStore: CompletionStore;
  selectionStore: SelectionStore;
}

export const FooterV2 = React.memo(function FooterV2({
  input, cursor, status, cols, inputRowY, viewportTop, completionStore, selectionStore,
}: FooterV2Props): React.ReactElement {
  const { setCursorPosition } = useCursor();
  const pos = cursorScreenPos(input, cursor, PROMPT);
  setCursorPosition({ x: pos.x, y: inputRowY + (pos.y - viewportTop) });

  const border = '─'.repeat(Math.max(0, cols));
  const allInputLines = input.split('\n');
  const visibleInputLines = allInputLines.slice(viewportTop, viewportTop + MAX_VISIBLE_INPUT_LINES);
  while (visibleInputLines.length < MAX_VISIBLE_INPUT_LINES) {
    visibleInputLines.push('');
  }
  const lowerBorderRow = inputRowY + MAX_VISIBLE_INPUT_LINES;
  const statusBarRow = lowerBorderRow + 1;

  return (
    <Box flexShrink={0} flexDirection="column">
      <Text color="gray">{border}</Text>
      <Box {...{ internal_cursorTarget: true } as Record<string, unknown>}>
        {visibleInputLines.map((line, i) => {
          const absLine = viewportTop + i;
          const prefix = absLine === 0 ? PROMPT : CONTINUATION_INDENT;
          const isFirstLine = absLine === 0;
          return (
            <Text
              key={i}
              color={isFirstLine ? 'green' : undefined}
              bold={isFirstLine}
            >
              {prefix + line + '\n'}
            </Text>
          );
        })}
      </Box>
      <Text color="gray">{border}</Text>
      <StatusBar status={status} selectionStore={selectionStore} globalRow={statusBarRow} />
    </Box>
  );
});
```

- [ ] **Step 4:运行测试验证通过**

```bash
npx vitest run src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx
```

Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/tui/inline-v2/FooterV2.tsx src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx
git commit -m "feat(inline-v2): add <FooterV2> with memo (no spinner)"
```

---

### Task 3.2:写 V2 Spinner(memo + 内部订阅 store)

**Files:**
- Create: `src/tui/inline-v2/spinner-memo.tsx`
- Test: `src/__tests__/tui/inline-v2/spinner-memo.test.tsx`

- [ ] **Step 1:写失败测试 — spinner 不接收 view,自己订阅 store**

创建 `src/__tests__/tui/inline-v2/spinner-memo.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SpinnerMemo } from '../../../tui/inline-v2/spinner-memo.js';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';

describe('<SpinnerMemo>', () => {
  it('订阅 spinnerStore,spinner active 时渲染', () => {
    const store = createSpinnerStore();
    store.getState().start('responding');
    const { lastFrame } = render(<SpinnerMemo store={store} />);
    // active spinner 应该有 glyph(· ✢ ✳ 等)
    const frame = lastFrame() ?? '';
    expect(frame.length).toBeGreaterThan(0);
  });

  it('spinner 未 active 时不渲染', () => {
    const store = createSpinnerStore();
    const { lastFrame } = render(<SpinnerMemo store={store} />);
    expect(lastFrame() ?? '').toBe('');
  });
});
```

- [ ] **Step 2:运行测试验证失败**

```bash
npx vitest run src/__tests__/tui/inline-v2/spinner-memo.test.tsx
```

Expected: FAIL。

- [ ] **Step 3:实现 SpinnerMemo**

创建 `src/tui/inline-v2/spinner-memo.tsx`:

```tsx
// V2 inline 模式的 Spinner(memo + 内部订阅 store)
// 物理本质:自己订阅 spinnerStore,父组件传 store 引用(store 本身不变)。
// spinner tick 只触发本组件重渲染,不冒泡到 <InlineAppV2>。
//
// 与 alt-screen <Spinner> 的区别:alt-screen 版本在 <Footer> 内部,
// 接收 spinnerView prop。V2 版本是 <InlineAppV2> 的子组件,自己订阅。

import React from 'react';
import { useStore } from 'zustand/react';
import { Box, Text } from 'ink';
import { selectSpinnerView } from '../state/spinner-view.js';
import { SpinnerWithVerb } from '../components/Spinner.js';
import type { SpinnerStore } from '../state/spinner-store.js';

export interface SpinnerMemoProps {
  store: SpinnerStore;
}

export const SpinnerMemo = React.memo(function SpinnerMemo({ store }: SpinnerMemoProps): React.ReactElement | null {
  // 自己订阅 store → tick 只触发本组件
  const spinnerState = useStore(store);
  const view = React.useMemo(() => selectSpinnerView(spinnerState), [spinnerState]);
  if (!view.active) return null;
  return <SpinnerWithVerb view={view} />;
});
```

- [ ] **Step 4:运行测试验证通过**

```bash
npx vitest run src/__tests__/tui/inline-v2/spinner-memo.test.tsx
```

Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/tui/inline-v2/spinner-memo.tsx src/__tests__/tui/inline-v2/spinner-memo.test.tsx
git commit -m "feat(inline-v2): add <SpinnerMemo> with self-subscription"
```

---

### Task 3.3:把 Spinner + Footer 接入 InlineAppV2

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`

- [ ] **Step 1:修改 InlineAppV2 接入 Spinner + FooterV2**

替换阶段 2 的占位 footer:

```tsx
import { SpinnerMemo } from './spinner-memo.js';
import { FooterV2 } from './FooterV2.js';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { computeInputViewport, MAX_VISIBLE_INPUT_LINES } from '../state/input-viewport.js';
import { cursorScreenPos } from '../state/cursor-position.js';

export function InlineAppV2({ messages, cols, rows, stores }: InlineAppV2Props): React.ReactElement {
  const finalized = messages.filter((m) => m.finalized);

  // 订阅 input/status(不订阅 spinnerStore → spinner tick 不触发本组件)
  const inputText = useStore(stores.inputStore, (s) => s.text);
  const cursor = useStore(stores.inputStore, (s) => s.cursor);
  const statusData = useStore(stores.statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));

  // inputRowY 计算:inline 模式下 inputRowY = finalized.length + spinner 高度 + border
  // ↑ 简化版,实际可能需要更精确(看实测)
  const totalInputLines = inputText.split('\n').length;
  const cursorLine = cursorScreenPos(inputText, cursor, '❯ ').y;
  const vp = computeInputViewport(totalInputLines, cursorLine, MAX_VISIBLE_INPUT_LINES);
  const inputRowY = finalized.length + 1;  // 临时:Static 行数 + 1(spinner 占位 1 行)

  return (
    <Box flexDirection="column">
      <Static items={finalized}>
        {(msg) => <MessageLine key={msg.uuid} msg={msg} cols={cols} />}
      </Static>
      <SpinnerMemo store={stores.spinnerStore} />
      <FooterV2
        input={inputText}
        cursor={cursor}
        status={statusData}
        cols={cols}
        inputRowY={inputRowY}
        viewportTop={vp.viewportTop}
        completionStore={stores.completionStore}
        selectionStore={stores.selectionStore}
      />
    </Box>
  );
}
```

- [ ] **Step 2:跑测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/
```

Expected: 全绿。

- [ ] **Step 3:手工冒烟测试 — spinner 隔离**

```bash
# 开 V2,启动对话,观察 spinner 滚动时 footer/statusbar 不闪烁
MICODE_INLINE_V2=1 npx tsx src/index.ts
```

观察:输入消息回车,看 spinner 滚动期间 footer 内容(输入框、border、statusbar)是否稳定不闪烁。

- [ ] **Step 4:跑 POC 回归测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
```

Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/tui/inline-v2/InlineAppV2.tsx
git commit -m "feat(inline-v2): wire <SpinnerMemo> + <FooterV2> into <InlineAppV2>"
```

---

### Task 3.4:加 memo 隔离核心回归测试

**Files:**
- Modify: `src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx`

- [ ] **Step 1:加 spinner tick 不触发 FooterV2 重渲染的测试**

在 `footer-v2-memo.test.tsx` 加:

```tsx
import React from 'react';
import { createSpinnerStore } from '../../../tui/state/spinner-store.js';
import TestRenderer from 'react-test-renderer';

it('spinner tick 不触发 <FooterV2> 重渲染', () => {
  const completionStore = createCompletionStore();
  const selectionStore = createSelectionStore();
  const spinnerStore = createSpinnerStore();
  spinnerStore.getState().start('responding');

  let renderCount = 0;
  const FooterV2WithCounter = React.memo(function FooterV2WithCounter(props: React.ComponentProps<typeof FooterV2>) {
    renderCount++;
    return <FooterV2 {...props} />;
  });

  const renderer = TestRenderer.create(
    <FooterV2WithCounter
      input=""
      cursor={0}
      status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
      cols={80}
      inputRowY={10}
      viewportTop={0}
      completionStore={completionStore}
      selectionStore={selectionStore}
    />
  );

  const initialCount = renderCount;
  // 模拟 10 个 spinner tick
  for (let i = 0; i < 10; i++) {
    spinnerStore.getState().tick();
  }
  // FooterV2 的 props 没变化 → renderCount 不应该增加
  expect(renderCount).toBe(initialCount);

  renderer.unmount();
});
```

- [ ] **Step 2:运行测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx
```

Expected: PASS。如果 FAIL(renderCount 增加),说明 `<FooterV2>` 的某个 prop 引用不稳定 → 排查并修复。

- [ ] **Step 3:Commit**

```bash
git add src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx
git commit -m "test(inline-v2): verify spinner tick doesn't re-render <FooterV2>"
```

---

# 阶段 4:Streaming 文本接入 + finalize 原子性验证

**目标**:V2 路径支持流式正文,验证 finalize 原子性,跑原始 bug 复现测试。

**估算**:1.5 天

---

### Task 4.1:写 `<StreamingText>` 组件

**Files:**
- Create: `src/tui/inline-v2/StreamingText.tsx`
- Test: `src/__tests__/tui/inline-v2/streaming-text.test.tsx`

- [ ] **Step 1:写失败测试**

创建 `src/__tests__/tui/inline-v2/streaming-text.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { StreamingText } from '../../../tui/inline-v2/StreamingText.js';

describe('<StreamingText>', () => {
  it('text=undefined 时不渲染', () => {
    const { lastFrame } = render(<StreamingText text={undefined} role="assistant" cols={80} />);
    expect(lastFrame() ?? '').toBe('');
  });

  it('渲染 assistant 流式文本', () => {
    const { lastFrame } = render(<StreamingText text="hello world" role="assistant" cols={80} />);
    expect(lastFrame()).toContain('hello');
  });

  it('text 不变时不重渲染(memo)', () => {
    let renderCount = 0;
    const Inner = StreamingText as unknown as React.MemoExoticComponent<React.FC<any>>;
    const CountingWrapper = (props: any) => {
      renderCount++;
      return <Inner {...props} />;
    };
    const { rerender } = render(<CountingWrapper text="hello" role="assistant" cols={80} />);
    const initial = renderCount;
    // 用相同 text 重渲染
    rerender(<CountingWrapper text="hello" role="assistant" cols={80} />);
    // memo 应该拦住
    // 注:这个测试有点 fragile(memo 内部行为),主要看功能正确性
    expect(renderCount).toBeGreaterThanOrEqual(initial);
  });
});
```

- [ ] **Step 2:运行测试验证失败**

```bash
npx vitest run src/__tests__/tui/inline-v2/streaming-text.test.tsx
```

Expected: FAIL。

- [ ] **Step 3:实现 StreamingText**

创建 `src/tui/inline-v2/StreamingText.tsx`:

```tsx
// V2 inline 流式文本渲染
// 物理本质:活动区里的"草稿",每帧被 Ink createIncremental 行级 diff 覆写。
// 用 wrapStreamingTextTrimmed / wrapThinkingTextTrimmed(已有纯函数)转 ANSI。

import React from 'react';
import { Text } from 'ink';
import { wrapStreamingTextTrimmed, wrapThinkingTextTrimmed } from '../inline/text-layout.js';

export interface StreamingTextProps {
  text: string | undefined;
  role: 'assistant' | 'thinking';
  cols: number;
}

export const StreamingText = React.memo(function StreamingText({
  text, role, cols,
}: StreamingTextProps): React.ReactElement | null {
  if (text === undefined || text === '') return null;
  const lines = role === 'thinking'
    ? wrapThinkingTextTrimmed(text, cols)
    : wrapStreamingTextTrimmed(text, cols);
  return (
    <Text>
      {lines.map((line, i) => (
        <Text key={i}>{line + '\n'}</Text>
      ))}
    </Text>
  );
});
```

- [ ] **Step 4:运行测试验证通过**

```bash
npx vitest run src/__tests__/tui/inline-v2/streaming-text.test.tsx
```

Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/tui/inline-v2/StreamingText.tsx src/__tests__/tui/inline-v2/streaming-text.test.tsx
git commit -m "feat(inline-v2): add <StreamingText> with memo"
```

---

### Task 4.2:把 StreamingText 接入 InlineAppV2

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`

- [ ] **Step 1:修改 InlineAppV2 接入 StreamingText**

在 Task 3.3 的基础上,加 StreamingText(在 `<Static>` 之后、`<SpinnerMemo>` 之前):

```tsx
import { StreamingText } from './StreamingText.js';

// 在组件函数里加
const lastMsg = messages[messages.length - 1];
const streamingMsg = lastMsg && !lastMsg.finalized ? lastMsg : null;

// 在 JSX 里 <Static> 之后加
{streamingMsg && (
  <StreamingText
    text={streamingMsg.streamingText}
    role={streamingMsg.role === 'thinking' ? 'thinking' : 'assistant'}
    cols={cols}
  />
)}
```

- [ ] **Step 2:跑全量测试**

```bash
npm test
```

Expected: 全绿。

- [ ] **Step 3:手工冒烟测试 — 真实流式**

```bash
# 开 V2 启动对话(需要真实 LLM key)
MICODE_INLINE_V2=1 npx tsx src/index.ts
# 输入一个问题,观察流式输出:
# - 没有"几十份累积副本"(核心 bug 修复)
# - spinner 流畅滚动
# - footer 不闪烁
```

- [ ] **Step 4:Commit**

```bash
git add src/tui/inline-v2/InlineAppV2.tsx
git commit -m "feat(inline-v2): wire <StreamingText> into <InlineAppV2>"
```

---

### Task 4.3:加 finalizeStreaming 原子性防回归测试

**Files:**
- Test: `src/__tests__/tui/inline-v2/finalize-atomic.test.ts`

**参考**:`src/tui/state/messages-store.ts:165-181`(已实现)

- [ ] **Step 1:写测试**

创建 `src/__tests__/tui/inline-v2/finalize-atomic.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createMessagesStore } from '../../../tui/state/messages-store.js';

describe('messagesStore.finalizeStreaming 原子性', () => {
  it('在单个 set() 内完成"标记 finalized + 清空 streamingText + 写 lines"', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('partial text');

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finalizeStreaming([{ content: 'final line', style: {}, indent: 0 }]);
    unsubscribe();

    // 只应该触发 1 次 subscribe(原子性)
    expect(subscribeCount).toBe(1);

    const last = store.getState().messages[store.getState().messages.length - 1]!;
    expect(last.finalized).toBe(true);
    expect(last.streamingText).toBeUndefined();
    expect(last.lines).toEqual([{ content: 'final line', style: {}, indent: 0 }]);
  });

  it('finalizeStreamingAsInterrupted 也是原子的', () => {
    const store = createMessagesStore();
    store.getState().startStreaming('interrupted text');

    let subscribeCount = 0;
    const unsubscribe = store.subscribe(() => { subscribeCount++; });

    store.getState().finalizeStreamingAsInterrupted();
    unsubscribe();

    expect(subscribeCount).toBe(1);
    const last = store.getState().messages[store.getState().messages.length - 1]!;
    expect(last.finalized).toBe(true);
    expect(last.streamingText).toBeUndefined();
    expect(last.lines.some((l) => l.content.includes('interrupted'))).toBe(true);
  });
});
```

- [ ] **Step 2:运行测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/finalize-atomic.test.ts
```

Expected: PASS(实现已存在,这是防回归测试)。

- [ ] **Step 3:Commit**

```bash
git add src/__tests__/tui/inline-v2/finalize-atomic.test.ts
git commit -m "test(inline-v2): guard finalizeStreaming atomicity (regression)"
```

---

### Task 4.4:原始 bug 复现回归测试(核心)

**Files:**
- Modify: `src/__tests__/tui/inline-v2/incremental-rendering.test.tsx`

**目标**:模拟原始 bug 场景(流式 + spinner tick 并发),验证 V2 不累积。

- [ ] **Step 1:加并发场景测试**

在 `incremental-rendering.test.tsx` 加:

```tsx
it('流式 + spinner tick 并发时不累积重复帧(原始 bug 回归)', async () => {
  const stdout = createMockStdout();

  // 模拟场景:<Static> 包固化消息 + 活动区有 spinner(tick) + streaming(text 变化)
  function ConcurrentApp() {
    const [streamingText, setStreamingText] = React.useState('');
    const [spinnerTime, setSpinnerTime] = React.useState(0);
    React.useEffect(() => {
      // 模拟流式 token 每 30ms 到达
      const streamId = setInterval(() => {
        setStreamingText((t) => t + 'a');
      }, 30);
      // 模拟 spinner tick 每 50ms
      const tickId = setInterval(() => {
        setSpinnerTime((t) => t + 50);
      }, 50);
      return () => { clearInterval(streamId); clearInterval(tickId); };
    }, []);
    return (
      <Static items={[{ id: 1, text: 'finalized' }]}>
        {(m) => <Text key={m.id}>[F] {m.text}</Text>}
      </Static>
      <Text>{'spinner ' + spinnerTime}</Text>
      <Text>{'─'.repeat(60)}</Text>
      <Text>{'❯ '}</Text>
      <Text>{'streaming: ' + streamingText}</Text>
    );
  }

  const instance = render(<ConcurrentApp />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
    incrementalRendering: true,
  });

  await new Promise((r) => setTimeout(r, 600));
  instance.unmount();

  // <Static> 只应该写 1 次
  const staticWrites = stdout.writes.filter((w) => w.data.includes('[F]'));
  expect(staticWrites.length).toBe(1);

  // 总字节数应该远小于"每帧都重写全部"的场景
  // V0 的对比基线:600ms 内如果每帧重写全部,大概 ~50 帧 × ~400B = ~20000B
  // V2 应该 << 这个数
  const totalBytes = stdout.writes.reduce((s, w) => s + w.bytes, 0);
  console.log('Total bytes:', totalBytes);
  expect(totalBytes).toBeLessThan(5000);  // 阈值,根据实际调整
});
```

- [ ] **Step 2:运行测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
```

Expected: PASS。如果 FAIL(totalBytes > 5000),检查 `incrementalRendering` 是否生效、memo 是否拦截。

- [ ] **Step 3:Commit**

```bash
git add src/__tests__/tui/inline-v2/incremental-rendering.test.tsx
git commit -m "test(inline-v2): regression test for original streaming+spinner concurrent bug"
```

---

### Task 4.5:阶段 4 集成测试 + 真实流式验证

**Files:** 无新文件(手工验证)

- [ ] **Step 1:跑全量测试**

```bash
npm test
```

Expected: 全绿。

- [ ] **Step 2:真实 LLM 流式对话验证(手工)**

```bash
MICODE_INLINE_V2=1 npx tsx src/index.ts
```

测试场景:
1. 输入"写一首关于秋天的诗",观察流式输出
2. 验证:
   - 没有"几十份累积副本"(原始 bug 修复)
   - spinner 流畅滚动
   - footer(border/输入框/statusbar)不闪烁
   - 固化后消息进入 scrollback
3. ESC 中断流式 → 验证半成品消息固化
4. 连续 3 轮对话 → 验证每轮的已固化消息都在 scrollback

- [ ] **Step 3:跑原始 bug 复现路径**

按 `docs/流式输出无限循环问题.md` 第 1-12 行描述的复现步骤,在 V2 模式下复现。

Expected: 不复现(无累积副本)。

- [ ] **Step 4:Commit(如果有调整)**

```bash
git diff  # 检查是否有意外修改
# 如果有合理的调整:
git add -A && git commit -m "fix(inline-v2): address issues from real streaming validation"
```

---

# 阶段 5a:边界场景 + 默认开启 V2

**目标**:覆盖 Select / Overlay / Resize 等边界,验证通过后默认切换 V2。

**估算**:2 天

---

### Task 5a.1:Select 选择器接入

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`

- [ ] **Step 1:在 InlineAppV2 加 Select 条件渲染**

```tsx
// import { SelectOverlay } from '../components/...';  // 复用或新建 Select 组件
// import { useStore } from 'zustand/react';

// 在组件函数顶部加
const selectVisible = useStore(stores.selectStore, (s) => s.visible);
const selectTitle = useStore(stores.selectStore, (s) => s.title);
const selectOptions = useStore(stores.selectStore, (s) => s.options);
const selectIndex = useStore(stores.selectStore, (s) => s.index);

// 在 JSX 里(活动区位置):
{selectVisible ? (
  <SelectOverlay title={selectTitle} options={selectOptions} index={selectIndex} cols={cols} />
) : (
  <>
    <SpinnerMemo store={stores.spinnerStore} />
    <FooterV2 ... />
  </>
)}
```

注:如果 alt-screen 的 `<SelectOverlay>` 不存在或不能直接复用,需要新建(参考 `src/tui/inline/InlineApp.tsx:buildSelectView` 的 ANSI 拼装逻辑,转成 React 元素)。

- [ ] **Step 2:跑测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/
npm test
```

- [ ] **Step 3:手工冒烟测试**

```bash
MICODE_INLINE_V2=1 npx tsx src/index.ts
# 输入 /model(触发 select)
# 验证:Select 选择器正确渲染、键盘上下键移动、Enter 确认、ESC 取消
```

- [ ] **Step 4:Commit**

```bash
git add -A
git commit -m "feat(inline-v2): wire Select selector with conditional render"
```

---

### Task 5a.2:Overlay(Ctrl+O)接入

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`

- [ ] **Step 1:加 Overlay 顶层条件渲染**

```tsx
import { Overlay } from '../components/Overlay.js';
import { useStore } from 'zustand/react';

// 在组件函数顶部加
const overlayVisible = useStore(stores.overlayStore, (s) => s.visible);

// 在 JSX 最顶层(替代 return 的内容):
if (overlayVisible) {
  return <Overlay store={stores.overlayStore} cols={cols} />;
}
return (
  // ... 原有 <Static> + 活动区
);
```

- [ ] **Step 2:跑测试**

```bash
npx vitest run src/__tests__/tui/inline-v2/
npm test
```

- [ ] **Step 3:手工冒烟测试(高风险)**

```bash
MICODE_INLINE_V2=1 npx tsx src/index.ts
# 触发 thinking(让 LLM 思考一段)
# 按 Ctrl+O 进 overlay
# 几秒后按 Ctrl+O 退出
# 验证:主屏内容完整 + cursor 位置正确 + 后续 spinner tick 正常
```

如果退出 overlay 后画面错乱,启用回滚方案:

```tsx
// 在 Overlay unmount 时强制 clear + 重渲染
// ↑ 这个改动放在 <Overlay> 组件的 useEffect cleanup 里
```

- [ ] **Step 4:Commit**

```bash
git add -A
git commit -m "feat(inline-v2): wire Overlay (Ctrl+O) with alt-screen fallback"
```

---

### Task 5a.3:Resize 验证

**Files:** 无新文件(主要验证)

- [ ] **Step 1:手工 resize 测试**

```bash
MICODE_INLINE_V2=1 npx tsx src/index.ts
# 跑流式输出,期间:
# 1. 缩小终端窗口到 40x10
# 2. 放大到 120x30
# 3. 再缩小
# 验证:
# - 活动区正确重布局(footer border 重新计算宽度)
# - scrollback 完整(已固化消息不丢失)
# - cursor 定位正确
```

如果 resize 时画面错乱,加 resize 处理(参考 `src/tui/inline/InlineApp.tsx:208-221` 的 cols 变化处理逻辑,可能需要在 `<InlineAppV2>` 加 useEffect)。

- [ ] **Step 2:跑全量测试**

```bash
npm test
```

- [ ] **Step 3:Commit(如果加了 resize 处理)**

```bash
git add -A
git commit -m "fix(inline-v2): handle resize edge case"
```

---

### Task 5a.4:鼠标选区跳过(V2 不支持)

**Files:**
- Modify: `src/tui/ConnectedApp.tsx`

- [ ] **Step 1:确认 ConnectedApp 已经在 inline 模式跳过 SGR 鼠标路由**

检查 `src/tui/ConnectedApp.tsx:275`(现有的 `if (!isInline)` 守卫),V2 路径(`isInline=true`)自然不进入 SGR 鼠标路由,**不需要额外改动**。

- [ ] **Step 2:加注释明确 V2 不支持鼠标选区**

```tsx
// 在 ConnectedApp 的鼠标处理块顶部加注释
// V2 模式(isInline=true)跳过 SGR 鼠标选区:终端原生选区即可。
// 后续若要支持,需要重新设计 rowTextMap(inline 模式下已固化内容行号会随新消息滚动变化)。
if (!isInline) {
  // ... 现有 SGR 鼠标路由代码
}
```

- [ ] **Step 3:Commit**

```bash
git add src/tui/ConnectedApp.tsx
git commit -m "docs(inline-v2): clarify mouse selection not supported in V2"
```

---

### Task 5a.5:ESC 中断 + 长输入验证

**Files:** 无新文件(验证为主)

- [ ] **Step 1:手工 ESC 中断测试**

```bash
MICODE_INLINE_V2=1 npx tsx src/index.ts
# 输入问题,流式输出开始后按 ESC
# 验证:
# - 流式立即停止
# - <Static> 增加半成品消息(含 [interrupted] 标记)
# - <StreamingText> 消失(同一帧)
# - spinner 隐藏
```

- [ ] **Step 2:手工长输入测试**

```bash
MICODE_INLINE_V2=1 npx tsx src/index.ts
# 粘贴 100 行文本
# 用上下键移动光标
# 验证:
# - 视口正确滚动
# - footer 不闪烁
# - cursor 定位正确
```

- [ ] **Step 3:如果发现问题,修复**

如果 ESC 或长输入有问题,定位根因,按 TDD 修复。

- [ ] **Step 4:Commit(如有修复)**

```bash
git add -A
git commit -m "fix(inline-v2): ESC interrupt + long input edge cases"
```

---

### Task 5a.6:默认开启 V2

**Files:**
- Modify: `src/tui/bootstrap.tsx`

- [ ] **Step 1:把默认改为 V2**

修改 `src/tui/bootstrap.tsx`(Task 1.1 的 `useInlineV2` 行):

```tsx
// 默认 V2:阶段 5a 完成后,V2 是默认路径
// 用户遇问题可 MICODE_INLINE_V2=0 回滚
const useInlineV2 = isInline && process.env.MICODE_INLINE_V2 !== '0';
```

(语义改变:之前是 `!== '0'` 但 V2 没真正接通;现在是 V2 默认开启)

- [ ] **Step 2:更新测试**

修改 `src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx`:

```tsx
it('默认(未设置 env)走 V2', async () => {
  delete process.env.MICODE_INLINE_V2;
  const { bootstrap } = await import('../../../tui/bootstrap.js');
  const handle = bootstrap({/* ...inline 模式... */});
  expect((handle as any).inlineV2).toBe(true);
  handle.cleanup();
});

it('MICODE_INLINE_V2=0 走 V0(fallback)', async () => {
  process.env.MICODE_INLINE_V2 = '0';
  // ... 同 Task 1.1
});
```

- [ ] **Step 3:跑全量测试**

```bash
npm test
```

- [ ] **Step 4:Commit**

```bash
git add src/tui/bootstrap.tsx src/__tests__/tui/inline-v2/bootstrap-flag.test.tsx
git commit -m "feat(inline-v2): default to V2 (MICODE_INLINE_V2 defaults to enabled)"
```

---

### Task 5a.7:真实用户场景批量验证

**Files:** 无新文件

- [ ] **Step 1:跑 10 个典型场景**

按以下清单手工验证(都默认走 V2):

1. 启动 → 看到 logo + 空 footer
2. 输入简单问候 → 流式回复 → 固化
3. 输入复杂问题(多段落回复) → 验证流式流畅
4. 流式中 ESC → 验证中断
5. /model 切换 → Select 选择器
6. 流式中 Ctrl+O → Overlay
7. Resize 终端 3 次
8. 粘贴长文本 → 视口滚动
9. 连续 5 轮对话 → scrollback 完整
10. 退出 → 终端恢复正常

- [ ] **Step 2:如有问题,逐个修复**

每个问题用 TDD:写复现测试 → 修复 → 验证。

- [ ] **Step 3:Commit(如有修复)**

```bash
git add -A
git commit -m "fix(inline-v2): edge cases from real user scenario validation"
```

---

# 阶段 5b:V0 删除(V2 稳定 1-2 周后)

**前提**:V2 默认开启已满 1-2 周,无重大回归报告。

**估算**:0.5 天

**注**:这是独立决策。若 V2 稳定则执行;若发现新问题,5b 可无限期延后。

---

### Task 5b.1:删除 V0 代码

**Files:**
- Delete: 多个文件

- [ ] **Step 1:删除 V0 inline 目录的核心文件**

```bash
# 确认 V2 稳定后执行
rm src/tui/inline/InlineRenderer.ts
rm src/tui/inline/InlineApp.tsx
rm src/tui/inline/InlineRenderState.ts
rm src/tui/inline/layout.ts
rm src/tui/inline/diff.ts
```

- [ ] **Step 2:清理 SpinnerLine.tsx(保留非 buildSpinnerLines 部分)**

检查 `src/tui/inline/SpinnerLine.tsx`,如果只有 `buildSpinnerLines` 用于 V0,则整个文件删;否则保留其他导出。

```bash
grep -n "from.*SpinnerLine" src/ -r  # 检查还有谁引用
```

- [ ] **Step 3:删除 useThrottledStreamingText(仅当 5a 实测确认 Ink 节流够)**

```bash
# 先确认 V2 没用 useThrottledStreamingText(阶段 4 保留,但如果 5a 实测确认不用了):
grep -rn "useThrottledStreamingText" src/
# 如果只剩测试引用,删除:
rm src/tui/inline/use-throttled-streaming-text.ts
rm src/__tests__/tui/use-throttled-streaming-text.test.ts
```

- [ ] **Step 4:删除 V0 专属测试**

```bash
rm src/__tests__/tui/inline-renderer-footer-dedup.test.ts
# 检查 use-input-handler.test.tsx 是否有 V0 专属用例,逐个评估
```

- [ ] **Step 5:跑全量测试 + TypeScript 编译**

```bash
npm test
npm run typecheck
npm run lint
```

Expected: 全绿,无 unused import,无 TS 错误。

- [ ] **Step 6:Commit**

```bash
git add -A
git commit -m "refactor(inline): remove legacy InlineRenderer (V0)"
```

---

### Task 5b.2:清理 bootstrap 和 ConnectedApp 的 V0 分支

**Files:**
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/ConnectedApp.tsx`

- [ ] **Step 1:删除 bootstrap 的 inlineRenderer 创建**

```tsx
// src/tui/bootstrap.tsx
// 删除:
// - InlineRenderer 的 import
// - const inlineRenderer = (isInline && !useInlineV2) ? new InlineRenderer(...) : null;
// - renderOptions 传递 inlineRenderer 的逻辑
// - BootstrapHandle 里的 inlineV2 字段(不再需要,因为 V0 已删)
```

- [ ] **Step 2:删除 ConnectedApp 的 V0 early return**

```tsx
// src/tui/ConnectedApp.tsx
// 删除:
// - InlineApp 的 import
// - 整个 if (isInline && _inlineRenderer) { ... return <InlineApp/> } 分支
// - inlineRenderer prop
```

- [ ] **Step 3:删除 MICODE_INLINE_V2 flag(不再需要)**

```tsx
// bootstrap.tsx
// 删除 useInlineV2 判断,inline 模式恒走 V2
// 删除 incrementalRendering 条件(改为 inline 模式恒 true)
```

- [ ] **Step 4:跑全量测试**

```bash
npm test
npm run typecheck
```

- [ ] **Step 5:Commit**

```bash
git add src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx
git commit -m "refactor(inline): remove V0 fallback path + MICODE_INLINE_V2 flag"
```

---

### Task 5b.3:最终清理 + PR 准备

**Files:** 无

- [ ] **Step 1:确认代码库无 V0 残留**

```bash
grep -rn "InlineRenderer\|InlineApp\b\|CommitFrame\|layoutFooter\|buildSpinnerLines\|prevFrameSnapshot" src/
```

Expected: 无匹配(除了历史 doc/ 注释)。

- [ ] **Step 2:更新 AGENTS.md / 文档**

```bash
# 如果 AGENTS.md 里有 inline V0 相关描述,更新为 V2
# 删除 docs/流式输出无限循环问题.md 里 V0 特有的描述?保留作为历史记录?
```

- [ ] **Step 3:写 PR 描述**

PR 标题:`feat(inline): migrate to Ink reconciler + <Static> (V2)`

PR 描述模板:
```
## 改动
- inline 模式从手动 InlineRenderer.commit() 迁移到 stock Ink reconciler + <Static> + createIncremental
- 消除"流式输出累积重复帧"原始 bug
- 删除 ~1000 行 V0 手动渲染代码(InlineRenderer/InlineApp/layout/diff/SpinnerLine.buildSpinnerLines)

## 验证
- POC 回归测试:spinner tick stdout 字节从 412B 降到 44-46B(减少 89%)
- 原始 bug 复现路径在 V2 不复现
- alt-screen 模式 100% 不变
- 真实用户场景验证(10 个典型场景)

## 回滚
MICODE_INLINE_V2=0(在 5b 之前)

## 关联
- Spec: docs/superpowers/specs/2026-07-20-inline-v2-architecture-design.md
- 调研记录: docs/流式输出无限循环问题-CC讨论记录.md
```

- [ ] **Step 4:推送 + 创建 PR**

```bash
git push origin codex/inline-v2-architecture
gh pr create --title "feat(inline): migrate to Ink reconciler + <Static> (V2)" --body "..."
```

---

# 完成条件

每个 stage 完成的验证标准:

| Stage | 完成条件 |
|---|---|
| 0 | worktree 干净 + POC 回归测试在 CI 跑 |
| 1 | MICODE_INLINE_V2 flag 工作,V0 路径不受影响 |
| 2 | V2 能渲染 logo + 已固化消息(无 spinner/streaming) |
| 3 | V2 完整 footer + spinner tick 不拖动 footer 重渲染 |
| 4 | V2 流式 + finalize 原子性 + 原始 bug 不复现 |
| 5a | 所有边界场景 + 默认 V2 + 10 个真实场景通过 |
| 5b | V0 删除 + 代码库干净 + PR 创建 |

**原始 bug 修复验收**:`docs/流式输出无限循环问题.md` 描述的累积副本不复现,spinner tick 字节数与 POC 基线一致(44-46B)。

---

# 自检 Checklist

实施过程中,每个 stage 完成后检查:

- [ ] `npm test` 全绿(尤其 alt-screen 测试)
- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] POC 回归测试通过
- [ ] Commit 粒度合理(每 task 一个 commit)
- [ ] alt-screen 模式行为 100% 不变
- [ ] `MICODE_INLINE_V2=0` 可回滚(阶段 5b 之前)

---

# 风险与缓解

| 风险 | 缓解 |
|---|---|
| 阶段 3 memo 失效(props 引用不稳定) | Task 3.4 强制验证 render count 不增加 |
| 阶段 5a Overlay 退出后画面错乱 | Task 5a.2 回滚方案(clear + 重渲染) |
| 阶段 5a Resize 时 eraseLines 擦错 | Task 5a.3 强制 resize 测试 |
| Ink 33ms throttle 不够流畅 | 保留 `useThrottledStreamingText`(阶段 4 决策) |
| `<Static>` 在长会话内存增长 | 阶段 5a 真实场景验证 100+ 消息 |

---

# 下一步

实施时按 stage 顺序执行,每 stage 内按 task 顺序,每 task 内按 step 顺序。完成每 stage 后建议跑 `verification-before-completion` 技能做最终验证。

推荐用 **subagent-driven-development**:每个 task 派独立 subagent,主代理 review 后合并。
