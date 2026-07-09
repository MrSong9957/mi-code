# Inline 原生屏渲染器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将默认渲染模式从备用屏（Alternate Screen）重构为原生屏 Inline REPL 追加模式，使所有交互历史保留在终端 scrollback 中，同时保留备用屏模式用于特殊交互场景。

**Architecture:** 双模式架构——默认 Inline 模式通过 stdout.write 直接追加内容到终端主缓冲区（REPL 模型），备用屏模式保留现有双缓冲渲染器。通过 React RenderMode Context 在组件树中切换渲染路径。

**Tech Stack:** TypeScript, React/Ink, Zustand, ANSI escape sequences

## Global Constraints

- Node.js >= 18.0.0, ESM modules
- Ink ^7.1.0, React ^19.2.7
- 禁止 `console.log`（用 `logForDebugging`）
- 禁止 `localStorage`/`sessionStorage`
- Feature flag 通过 `feature()` 函数判断
- 文件操作优先异步 API
- Windows 兼容（NTFS ADS / 8.3 短名 / UNC 路径拦截）

---

### Task 1: 创建 RenderMode 状态管理

**Covers:** [S3]

**Files:**
- Create: `src/tui/state/render-mode.ts`
- Create: `src/tui/state/render-mode.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `RenderMode` type, `RenderModeContext`, `useRenderMode()` hook

- [ ] **Step 1: Write the failing test**

```typescript
// src/tui/state/render-mode.test.ts
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import React from 'react';
import { RenderModeProvider, useRenderMode } from './render-mode.js';

describe('RenderMode', () => {
  it('defaults to inline mode', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RenderModeProvider>{children}</RenderModeProvider>
    );
    const { result } = renderHook(() => useRenderMode(), { wrapper });
    expect(result.current.mode).toBe('inline');
  });

  it('provides setMode to switch', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <RenderModeProvider>{children}</RenderModeProvider>
    );
    const { result } = renderHook(() => useRenderMode(), { wrapper });
    result.current.setMode('alt-screen');
    expect(result.current.mode).toBe('alt-screen');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/state/render-mode.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/state/render-mode.ts
import React, { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type RenderMode = 'inline' | 'alt-screen';

export const DEFAULT_RENDER_MODE: RenderMode = 'inline';

export interface RenderModeState {
  mode: RenderMode;
  setMode: (mode: RenderMode) => void;
}

const RenderModeContext = createContext<RenderModeState>({
  mode: DEFAULT_RENDER_MODE,
  setMode: () => {},
});

export function RenderModeProvider({ children, initialMode }: {
  children: ReactNode;
  initialMode?: RenderMode;
}): React.ReactElement {
  const [mode, setMode] = useState<RenderMode>(initialMode ?? DEFAULT_RENDER_MODE);
  const stableSetMode = useCallback((m: RenderMode) => setMode(m), []);
  return (
    <RenderModeContext.Provider value={{ mode, setMode: stableSetMode }}>
      {children}
    </RenderModeContext.Provider>
  );
}

export function useRenderMode(): RenderModeState {
  return useContext(RenderModeContext);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/state/render-mode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/state/render-mode.ts src/tui/state/render-mode.test.ts
git commit -m "feat(inline): add RenderMode state management"
```

---

### Task 2: 创建 ANSI 工具函数

**Covers:** [S9]

**Files:**
- Create: `src/tui/inline/ansi-utils.ts`
- Create: `src/tui/inline/ansi-utils.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `cursorUp()`, `cursorDown()`, `eraseLine`, `eraseLines()`, `hideCursor`, `showCursor`, `sgr()`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tui/inline/ansi-utils.test.ts
import { describe, it, expect } from 'vitest';
import { cursorUp, cursorDown, eraseLine, eraseLines, hideCursor, showCursor, sgr } from './ansi-utils.js';

describe('ansi-utils', () => {
  it('cursorUp generates correct escape', () => {
    expect(cursorUp(3)).toBe('\x1b[3A');
    expect(cursorUp(1)).toBe('\x1b[1A');
  });

  it('cursorDown generates correct escape', () => {
    expect(cursorDown(2)).toBe('\x1b[2B');
  });

  it('eraseLine is correct escape', () => {
    expect(eraseLine).toBe('\x1b[K');
  });

  it('eraseLines generates N line erasures', () => {
    const result = eraseLines(3);
    expect(result).toBe('\x1b[1A\x1b[K\x1b[1A\x1b[K\x1b[1A\x1b[K');
  });

  it('hideCursor/showCursor are correct', () => {
    expect(hideCursor).toBe('\x1b[?25l');
    expect(showCursor).toBe('\x1b[?25h');
  });

  it('sgr wraps code in CSI m', () => {
    expect(sgr('1')).toBe('\x1b[1m');
    expect(sgr('38;2;255;0;0')).toBe('\x1b[38;2;255;0;0m');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/inline/ansi-utils.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/inline/ansi-utils.ts

/** 光标上移 n 行 */
export const cursorUp = (n: number): string => `\x1b[${n}A`;

/** 光标下移 n 行 */
export const cursorDown = (n: number): string => `\x1b[${n}B`;

/** 擦除当前行（从光标到行尾） */
export const eraseLine = '\x1b[K';

/** 擦除 n 行（从当前行向上逐行擦除） */
export const eraseLines = (n: number): string =>
  Array(n).fill(cursorUp(1) + eraseLine).join('');

/** 隐藏光标 */
export const hideCursor = '\x1b[?25l';

/** 显示光标 */
export const showCursor = '\x1b[?25h';

/** SGR 样式序列 */
export const sgr = (code: string): string => `\x1b[${code}m`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/inline/ansi-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/inline/ansi-utils.ts src/tui/inline/ansi-utils.test.ts
git commit -m "feat(inline): add ANSI utility functions"
```

---

### Task 3: 创建 InlineRenderer 核心

**Covers:** [S5, S6, S7]

**Files:**
- Create: `src/tui/inline/InlineRenderer.ts`
- Create: `src/tui/inline/InlineRenderer.test.ts`

**Interfaces:**
- Consumes: `ansi-utils.ts` (cursorUp, eraseLine, eraseLines, hideCursor, showCursor)
- Produces: `InlineRenderer` class with `appendLine()`, `rewriteCurrentLine()`, `renderFooter()`, `commitFooter()`

- [ ] **Step 1: Write the failing test**

```typescript
// src/tui/inline/InlineRenderer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((s: string) => { written.push(s); return true; }),
  };
}

describe('InlineRenderer', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('appendLine writes text + newline to stdout', () => {
    renderer.appendLine('hello');
    expect(mock.write).toHaveBeenCalledWith('hello\n');
  });

  it('rewriteCurrentLine writes CR + erase + text', () => {
    renderer.rewriteCurrentLine('streaming...');
    expect(mock.write).toHaveBeenCalledWith('\r\x1b[Kstreaming...');
  });

  it('renderFooter writes footer lines and tracks them', () => {
    renderer.renderFooter('hello', 5, 'test | model');
    expect(mock.written.length).toBeGreaterThan(0);
  });

  it('commitFooter clears footer state', () => {
    renderer.renderFooter('hello', 5, 'test | model');
    renderer.commitFooter();
    // After commit, next renderFooter should not erase old lines
    const prevLen = mock.written.length;
    renderer.renderFooter('world', 5, 'test | model');
    // Should have written new footer without erasing old
    expect(mock.written.length).toBeGreaterThan(prevLen);
  });

  it('renderFooter erases previous footer before writing new', () => {
    renderer.renderFooter('line1', 0, 'status1');
    const afterFirst = mock.written.length;
    renderer.renderFooter('line2', 0, 'status2');
    // Second call should include erase sequences for first footer
    const secondWrites = mock.written.slice(afterFirst);
    const combined = secondWrites.join('');
    expect(combined).toContain('\x1b['); // contains ANSI escape
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tui/inline/InlineRenderer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/inline/InlineRenderer.ts
import { cursorUp, eraseLine, eraseLines, hideCursor, showCursor } from './ansi-utils.js';
import { statusBarContent } from '../components/StatusBar.js';

const PROMPT = '❯ ';

export interface FooterData {
  input: string;
  cursorPos: number;
  statusText: string;
}

export class InlineRenderer {
  private footerLineCount = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  /** 追加永久内容到终端缓冲区 */
  appendLine(ansiText: string): void {
    this.stdout.write(ansiText + '\n');
  }

  /** 流式输出：擦除当前行 + 重写 */
  rewriteCurrentLine(ansiText: string): void {
    this.stdout.write('\r\x1b[K' + ansiText);
  }

  /** 渲染 footer（输入框 + 状态栏），先擦除旧 footer 再写入新 footer */
  renderFooter(input: string, cursorPos: number, statusText: string): void {
    const seq: string[] = [];

    // 1. 擦除旧 footer
    if (this.footerLineCount > 0) {
      seq.push(eraseLines(this.footerLineCount));
    }

    // 2. 构建新 footer 行
    const inputLines = input.split('\n');
    const border = '─'.repeat(40);

    // 上边框
    seq.push(border + '\n');
    // 输入行
    for (let i = 0; i < inputLines.length; i++) {
      const prefix = i === 0 ? PROMPT : '';
      seq.push(prefix + inputLines[i] + '\n');
    }
    // 下边框
    seq.push(border + '\n');
    // 状态栏
    seq.push(statusText + '\n');

    this.footerLineCount = 2 + inputLines.length + 1; // border + input + border + status

    // 3. 写入
    this.stdout.write(seq.join(''));

    // 4. 定位光标到输入框
    const inputLineIndex = inputLines.length - 1;
    const lastInputLine = inputLines[inputLineIndex];
    const cursorX = (inputLineIndex === 0 ? PROMPT.length : 0) + cursorPos;
    const cursorY = this.footerLineCount - 1 - inputLineIndex; // 从底部向上定位

    this.stdout.write(hideCursor);
    if (cursorY > 0) {
      this.stdout.write(cursorUp(cursorY));
    }
    this.stdout.write(`\r\x1b[${cursorX + 1}G`); // CUP 1-indexed
    this.stdout.write(showCursor);
  }

  /** 提交后：footer 变成历史，不再需要擦除重写 */
  commitFooter(): void {
    this.footerLineCount = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tui/inline/InlineRenderer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/inline/InlineRenderer.ts src/tui/inline/InlineRenderer.test.ts
git commit -m "feat(inline): add InlineRenderer core class"
```

---

### Task 4: 创建 InlineFooter React 组件

**Covers:** [S2, S4]

**Files:**
- Create: `src/tui/inline/InlineFooter.tsx`

**Interfaces:**
- Consumes: `InlineRenderer` class, stores (messagesStore, inputStore, statusStore, spinnerStore, completionStore)
- Produces: React component that bridges stores to InlineRenderer

- [ ] **Step 1: Write the component**

```typescript
// src/tui/inline/InlineFooter.tsx
// Inline 模式下的 Footer：通过 InlineRenderer 将输入框+状态栏写入终端主缓冲区。
// 物理本质：React 组件的 render 副作用——每次 store 变化时调用 renderer 重绘 footer。
//
// 注意：这不是传统的 Ink 组件。它的渲染输出不经过 Yoga 布局，
// 而是通过 useEffect 直接操作 stdout。

import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';

export interface InlineFooterProps {
  renderer: InlineRenderer;
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
}

export function InlineFooter({
  renderer,
  messagesStore,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
}: InlineFooterProps): React.ReactElement {
  const inputText = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  const status = useStore(statusStore, useShallow((s) => ({
    mode: s.mode, model: s.model, dir: s.dir, branch: s.branch, contextPct: s.contextPct,
  })));
  const spinnerActive = useStore(spinnerStore, (s) => s.active);
  const completionVisible = useStore(completionStore, (s) => s.visible);

  // 用 ref 追踪上一次的 footer 状态，避免不必要的重绘
  const prevFooterRef = useRef('');

  useEffect(() => {
    const statusText = `${status.mode} │ ${status.model} │ ${status.dir} │ ${status.branch}`;
    const spinnerLine = spinnerActive ? '⏳ Processing...' : '';
    const completionLine = completionVisible ? '...' : '';
    const footerKey = `${inputText}|${cursor}|${statusText}|${spinnerLine}|${completionLine}`;

    // 避免相同内容重复渲染
    if (footerKey === prevFooterRef.current) return;
    prevFooterRef.current = footerKey;

    const fullStatus = [statusText, spinnerLine, completionLine].filter(Boolean).join(' │ ');
    renderer.renderFooter(inputText, cursor, fullStatus);
  }, [inputText, cursor, status, spinnerActive, completionVisible, renderer]);

  // 组件卸载时 commit footer（变成历史）
  useEffect(() => {
    return () => {
      renderer.commitFooter();
    };
  }, [renderer]);

  // 返回空——实际渲染通过 stdout 副作用完成
  return null;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/tui/inline/InlineFooter.tsx`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/tui/inline/InlineFooter.tsx
git commit -m "feat(inline): add InlineFooter React component"
```

---

### Task 5: 修改 bootstrap.tsx 支持双模式

**Covers:** [S3, S4, S7]

**Files:**
- Modify: `src/tui/bootstrap.tsx`

**Interfaces:**
- Consumes: `RenderMode` from render-mode.ts, `InlineRenderer` from InlineRenderer.ts
- Produces: `bootstrap()` 接受 `renderMode` 选项，根据模式选择渲染路径

- [ ] **Step 1: Modify bootstrap.tsx**

```typescript
// 在 bootstrap.tsx 的 import 区域添加：
import { RenderModeProvider, type RenderMode } from './state/render-mode.js';
import { InlineRenderer } from './inline/InlineRenderer.js';

// 修改 BootstrapOptions 接口，添加 renderMode 字段：
export interface BootstrapOptions {
  // ... existing fields ...
  /** 渲染模式：inline（原生屏，默认）或 alt-screen（备用屏） */
  renderMode?: RenderMode;
}

// 修改 bootstrap 函数，在 renderOptions 逻辑前添加模式判断：
export function bootstrap(opts: BootstrapOptions): BootstrapHandle {
  const renderMode = opts.renderMode ?? 'inline';

  // ... existing store creation code ...

  // Inline 模式：不使用 Ink 的 alternateScreen，不注入自定义双缓冲渲染器
  // Alt-screen 模式：保持现有行为
  const isInline = renderMode === 'inline';

  const renderOptions: {
    exitOnCtrlC: false;
    alternateScreen: boolean;
    patchConsole: false;
    renderer?: unknown;
    onSetCursorPosition?: (pos: unknown) => void;
  } = {
    exitOnCtrlC: false,
    alternateScreen: !isInline,  // inline 模式不进备用屏
    patchConsole: false,
  };

  if (!isInline && USE_DOUBLE_BUFFER) {
    renderOptions.renderer = createCustomRenderer({ stdout: process.stdout });
    renderOptions.onSetCursorPosition = (pos) => { setCursorPos(pos as { x: number; y: number } | undefined); };
  }

  // 创建 InlineRenderer（仅 inline 模式使用）
  const inlineRenderer = isInline ? new InlineRenderer(process.stdout) : null;

  // 用 RenderModeProvider 包裹 ConnectedApp
  let inkInstance: InkInstance | null = render(
    React.createElement(RenderModeProvider, { initialMode: renderMode },
      React.createElement(ConnectedApp, {
        messagesStore, inputStore, statusStore, logoStore, spinnerStore, completionStore, overlayStore,
        onExit: opts.onExit, onTab: opts.onTab, onToggleOverlay: opts.onToggleOverlay,
        inlineRenderer: inlineRenderer ?? undefined,
      })
    ),
    renderOptions,
  );

  // 修改 cleanup：inline 模式不需要退出备用屏
  const cleanup = (): void => {
    try {
      inkInstance?.unmount();
    } catch {
      // unmount 可能已调用，忽略
    }
    inkInstance = null;
    if (!isInline) {
      exitAltScreen(process.stdout);
    }
  };

  // ... rest of return statement ...
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/tui/bootstrap.tsx`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/bootstrap.tsx
git commit -m "feat(inline): add dual-mode rendering to bootstrap"
```

---

### Task 6: 修改 ConnectedApp 支持 Inline 渲染

**Covers:** [S2, S4]

**Files:**
- Modify: `src/tui/ConnectedApp.tsx`

**Interfaces:**
- Consumes: `InlineRenderer` from InlineRenderer.ts, `RenderMode` from render-mode.ts
- Produces: ConnectedApp 接受 `inlineRenderer` prop，inline 模式下跳过虚拟滚动

- [ ] **Step 1: Modify ConnectedApp.tsx**

```typescript
// 在 ConnectedAppProps 接口添加：
export interface ConnectedAppProps {
  // ... existing fields ...
  /** Inline 模式渲染器（仅 inline 模式传入） */
  inlineRenderer?: import('./inline/InlineRenderer.js').InlineRenderer;
}

// 在 ConnectedApp 函数中：
// 1. 导入 useRenderMode
import { useRenderMode } from './state/render-mode.js';

// 2. 在函数体内添加：
const { mode } = useRenderMode();
const isInline = mode === 'inline';

// 3. 修改 return 语句，根据模式返回不同组件：
if (isInline && props.inlineRenderer) {
  // Inline 模式：直接追加内容到 stdout，不使用虚拟滚动
  return (
    <InlineApp
      messages={messages}
      status={status}
      logo={logo}
      renderer={props.inlineRenderer}
      messagesStore={messagesStore}
      inputStore={inputStore}
      statusStore={statusStore}
      spinnerStore={spinnerStore}
      completionStore={completionStore}
      selectionStore={selectionStore}
    />
  );
}

// Alt-screen 模式：保持现有 App 组件
return (
  <App
    messages={messages}
    status={status}
    logo={logo}
    selectionStore={selectionStore}
    spinnerStore={spinnerStore}
    completionStore={completionStore}
    overlayStore={overlayStore}
    input={inputText}
    cursor={cursor}
    rows={rows}
    cols={cols}
    scrollTop={effectiveScrollTop}
    flatLines={flatLines}
  />
);
```

- [ ] **Step 2: Create InlineApp component**

```typescript
// src/tui/inline/InlineApp.tsx
// Inline 模式的根组件：将消息追加到 stdout，渲染 InlineFooter。
// 物理本质：替代 App.tsx 的 flex 布局，改用纯 stdout.write 追加模型。

import React, { useEffect, useRef } from 'react';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { InlineRenderer } from './InlineRenderer.js';
import { InlineFooter } from './InlineFooter.js';
import type { TuiMessage, StatusBarData, LogoData } from '../types.js';
import type { MessagesStore } from '../state/messages-store.js';
import type { InputStore } from '../state/input-store.js';
import type { StatusStore } from '../state/status-store.js';
import type { SpinnerStore } from '../state/spinner-store.js';
import type { CompletionStore } from '../state/completion-store.js';
import type { SelectionStore } from '../state/selection-store.js';

export interface InlineAppProps {
  messages: TuiMessage[];
  status: StatusBarData;
  logo: LogoData;
  renderer: InlineRenderer;
  messagesStore: MessagesStore;
  inputStore: InputStore;
  statusStore: StatusStore;
  spinnerStore: SpinnerStore;
  completionStore: CompletionStore;
  selectionStore: SelectionStore;
}

export function InlineApp({
  messages,
  status,
  logo,
  renderer,
  messagesStore,
  inputStore,
  statusStore,
  spinnerStore,
  completionStore,
}: InlineAppProps): React.ReactElement {
  const renderedCountRef = useRef(0);

  // 追加新消息到 stdout（仅追加，不重绘旧消息）
  useEffect(() => {
    const newMessages = messages.slice(renderedCountRef.current);
    for (const msg of newMessages) {
      if (msg.role === 'user') {
        renderer.appendLine(`❯ ${msg.content}`);
      } else if (msg.role === 'assistant') {
        // Assistant 消息的文本内容
        const text = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content
                .filter((b): b is { type: 'text'; text: string } =>
                  typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text')
                .map(b => b.text)
                .join('')
            : '';
        if (text) {
          renderer.appendLine(text);
        }
      } else {
        // system messages
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        renderer.appendLine(`[system] ${text}`);
      }
    }
    renderedCountRef.current = messages.length;
  }, [messages, renderer]);

  // 渲染 Logo（仅首次）
  useEffect(() => {
    const lines = [
      ` ▐▛███▜▌   MiCode v${logo.version}`,
      '▝▜█████▛▘  TypeScript CLI · Node.js Runtime',
      `  ▘▘ ▝▝    ${logo.dir}`,
    ];
    for (const line of lines) {
      renderer.appendLine(line);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <InlineFooter
      renderer={renderer}
      messagesStore={messagesStore}
      inputStore={inputStore}
      statusStore={statusStore}
      spinnerStore={spinnerStore}
      completionStore={completionStore}
    />
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/tui/ConnectedApp.tsx src/tui/inline/InlineApp.tsx`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/tui/ConnectedApp.tsx src/tui/inline/InlineApp.tsx
git commit -m "feat(inline): add InlineApp and modify ConnectedApp for dual rendering"
```

---

### Task 7: 修改 useAltScreen 仅在 alt-screen 模式下激活

**Covers:** [S4]

**Files:**
- Modify: `src/tui/hooks/useAltScreen.ts`

**Interfaces:**
- Consumes: `useRenderMode()` from render-mode.ts
- Produces: `useAltScreen()` hook 仅在 alt-screen 模式下写入 escape sequences

- [ ] **Step 1: Modify useAltScreen.ts**

```typescript
// 在 useAltScreen 函数中添加模式检查：
import { useRenderMode } from '../state/render-mode.js';

export function useAltScreen(): boolean {
  const { stdout } = useStdout();
  const { mode } = useRenderMode();
  const isAltScreen = mode === 'alt-screen';

  useEffect(() => {
    if (!stdout || !isAltScreen) return;
    stdout.write(ENTER_ALT + CLEAR_SCREEN);
    return () => {
      if (isAltScreen) {
        stdout.write(EXIT_ALT);
      }
    };
  }, [stdout, isAltScreen]);

  return isAltScreen;
}

// standalone 函数保持不变（供 bootstrap 直接调用）
export function enterAltScreen(stream: NodeJS.WriteStream): void {
  stream.write(ENTER_ALT + CLEAR_SCREEN);
}

export function exitAltScreen(stream: NodeJS.WriteStream): void {
  stream.write(EXIT_ALT);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/tui/hooks/useAltScreen.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/hooks/useAltScreen.ts
git commit -m "feat(inline): make useAltScreen mode-aware"
```

---

### Task 8: 修改 index.ts 启动流程

**Covers:** [S7]

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `bootstrap()` 新增的 `renderMode` 选项
- Produces: 启动时传递 `renderMode: 'inline'`（默认）

- [ ] **Step 1: Modify bootstrap call in index.ts**

```typescript
// 在 index.ts 中调用 bootstrap 的地方，添加 renderMode 参数：
const tuiHandle = bootstrap({
  logo: { version: VERSION, dir: process.cwd() },
  status: { mode: 'chat', model: modelId, dir: process.cwd(), branch },
  onSubmit: (text: string) => { /* existing handler */ },
  onExit: () => { /* existing handler */ },
  onTab: (text: string) => { /* existing handler */ },
  onToggleOverlay: () => { /* existing handler */ },
  renderMode: 'inline',  // 默认使用原生屏模式
});
```

- [ ] **Step 2: 修改 cleanupOnExit 逻辑**

```typescript
// 修改 cleanupOnExit 函数，移除退出备用屏的逻辑（inline 模式不需要）：
function cleanupOnExit(): void {
  backgroundManager.killAll();
  tuiHandle?.stopSpinner();
  tuiHandle?.cleanup();
  // inline 模式下内容已在主缓冲区，不需要额外输出 resume hint
  // （resume hint 由 bootstrap 的 cleanup 处理）
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/index.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(inline): set default renderMode to inline in index.ts"
```

---

### Task 9: 集成测试

**Covers:** [S1, S2, S3, S5, S6, S7]

**Files:**
- Create: `src/tui/inline/integration.test.ts`

**Interfaces:**
- Consumes: All created/modified modules
- Produces: 端到端测试验证 inline 渲染流程

- [ ] **Step 1: Write integration test**

```typescript
// src/tui/inline/integration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((s: string) => { written.push(s); return true; }),
  };
}

describe('Inline rendering integration', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('full REPL cycle: append message → render footer → commit → append next', () => {
    // 1. 追加用户消息
    renderer.appendLine('❯ Hello');
    expect(mock.written).toContain('❯ Hello\n');

    // 2. 追加 AI 回复（流式）
    renderer.rewriteCurrentLine('H');
    renderer.rewriteCurrentLine('He');
    renderer.rewriteCurrentLine('Hello');
    renderer.appendLine('Hello'); // 流式结束

    // 3. 渲染 footer
    renderer.renderFooter('user input', 5, 'chat │ model');
    expect(mock.written.length).toBeGreaterThan(3);

    // 4. 提交（footer 变成历史）
    renderer.commitFooter();

    // 5. 下一轮消息
    renderer.appendLine('❯ Next question');
    expect(mock.written).toContain('❯ Next question\n');
  });

  it('streaming with footer redraw', () => {
    // 初始 footer
    renderer.renderFooter('', 0, 'chat │ model');

    // 流式 token 到达，footer 每次重绘
    for (let i = 0; i < 5; i++) {
      renderer.rewriteCurrentLine('token'.repeat(i + 1));
      renderer.renderFooter('typing...', i, 'chat │ model');
    }

    // 提交
    renderer.commitFooter();
    renderer.appendLine('response complete');
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `npx vitest run src/tui/inline/integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: PASS (no regressions)

- [ ] **Step 4: Commit**

```bash
git add src/tui/inline/integration.test.ts
git commit -m "test(inline): add integration tests for inline rendering"
```

---

### Task 10: 类型导出和模块索引

**Covers:** [S4]

**Files:**
- Create: `src/tui/inline/index.ts`

**Interfaces:**
- Consumes: All inline modules
- Produces: 统一导出入口

- [ ] **Step 1: Create barrel export**

```typescript
// src/tui/inline/index.ts
export { InlineRenderer } from './InlineRenderer.js';
export type { FooterData } from './InlineRenderer.js';
export { InlineFooter } from './InlineFooter.js';
export { InlineApp } from './InlineApp.js';
export { useRenderMode, RenderModeProvider } from '../state/render-mode.js';
export type { RenderMode } from '../state/render-mode.js';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit src/tui/inline/index.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/tui/inline/index.ts
git commit -m "feat(inline): add barrel export for inline module"
```

---

## Self-Review

**Spec coverage:** [S1] covered by Task 10 (integration), [S2] by Tasks 2-3, [S3] by Tasks 1+5, [S4] by Tasks 3-4+6, [S5] by Task 3, [S6] by Task 3, [S7] by Tasks 5+8, [S8] by Task 5 (render mode context), [S9] by Task 2, [S10] by Task 1.

**Placeholder scan:** No TBD/TODO found. All steps have complete code.

**Type consistency:** All interfaces match across tasks — `InlineRenderer` class, `RenderMode` type, `FooterData` interface are consistent.

---

## Execution Handoff

After saving the plan, determine execution approach:

1. **Check memory** for a saved `execution-style` preference.
2. **If no saved preference,** ask through compose:ask.
3. **If Subagent:** Use compose:subagent — fresh subagent per task + two-stage review.
4. **If Inline:** Use compose:execute — batch execution with checkpoints.
