# ESC 中断 LLM 流 + 双击撤回消息 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 ESC 中断正在进行的 LLM 流式请求 + 双击 ESC 撤回末条 user 消息(连内容一起删,回填输入框可重发)。

**Architecture:** 沿用 mi-code 既有"命令式 index.ts + zustand vanilla store + BootstrapOptions 回调注入"架构。AbortController 通过 module-level 句柄暴露给中断回调;撤回逻辑在 index.ts 编排(操作 messagesStore + sessionMessages + inputStore),保持 store 的单一职责。ESC 时序采用"方案 X":第一次 ESC 立即中断,双击窗口(400ms)内第二次 ESC 触发撤回。

**Tech Stack:** Node.js 18+ ESM, TypeScript(strict), Ink + React, zustand vanilla store, vitest, ink-testing-library

---

## 关键设计决策(已验证)

### 决策 1:AbortController 暴露方案 — module-level 句柄 + 回调注入

- `src/index.ts` 顶部新增 `let currentAbortController: AbortController | null = null;`
- `handleUserSubmit` 内 `:536` 创建 ac 后赋值;`finally` 块清空
- `BootstrapOptions` 新增 `onAbortStream?: () => void` 和 `onRewindLastTurn?: () => void`
- index.ts 在 `bootstrap({...})` 调用处(`:691`)注入回调
- 走 `BootstrapOptions → ConnectedApp → useInputHandler` 三层透传(与现有 onSubmit/onExit/onTab 同款路径)

**不采用 spinnerStore 加字段的方案**:tuiHandle 已经是 spinner 的控制面板,回调注入更契合 mi-code 既有数据流方向(React → index.ts)。

### 决策 2:撤回数据流

- `messagesStore` 新增 `rewindLastUserTurn()`(硬撤回:删末条 user 及其后全部)和 `finalizeStreamingAsInterrupted()`(软中断:末条流式 assistant finalize 成 `[interrupted]`)
- "有意义的 assistant 内容" = `role==='assistant'` 且(finalized 的 lines 有非空 content,或流式的 streamingText trim 后非空)。`thinking`/`system`/`tool` 不算有意义
- **关键时序**:先读当前 messages 判断 hasMeaningful,**再** abort。abort 后流式块可能被清理,先读才准
- `sessionMessages`(`index.ts:158`)同步:只在硬撤回分支执行 `slice(0, lastUserIdx)`,放 index.ts 做(关注点分离,store 不知道 sessionMessages 存在)
- sessionStore 持久化:硬撤回分支换新 `sessionId`(randomUUID),旧 jsonl 保留。软中断不动 sessionId

### 决策 3:可中断感知 — `spinnerStore.active` 代理

- 已验证:`startSpinner('thinking')` 全项目只有 `index.ts:547` 一处调用,`spinnerStore.active === true` 等价于 agent loop 运行中
- ESC 优先级:overlay > selectStore > completion > 中断/撤回 > 普通编辑。在 completion 拦截块**之后**插入

### 决策 4(实测验证):catch 块必须用 `ac.signal.aborted` 判断

**实测事实**:`ac.abort('user-cancel')` 抛出的 err 是字符串 `'user-cancel'`(不是 Error 对象,`err.name` 是 undefined)。`ac.abort()` 无参才抛 `DOMException`(name='AbortError')。

**结论**:catch 块**必须用 `if (ac.signal.aborted)`**,不能用 `err.name === 'AbortError'` 或 `err instanceof Error`。三种 abort 形态下 `ac.signal.aborted` 都为 true,是唯一可靠信号。

### 决策 5:软中断不回填输入框

- 硬撤回(无有意义内容):删消息 + `inputStore.setText(lastSubmittedAgentText)`
- 软中断(有有意义内容):只 finalize 流式为 `[interrupted]`,不删 user、不回填、不换 sessionId
- 理由(用户意图分析 + Claude Code 同款行为):软中断用户意图是"够了停",注意力在输出上;回填会与屏幕上的部分输出视觉重复

---

## 防御边界(高频异常操作防护)

1. **abort 幂等**:`handleAbortStream` 必须对"无任务运行"(ac 为 null)和"已 aborted"都安全(空操作)。用 `currentAbortController?.abort()` 的可选链
2. **撤回等流停止的轮询**:`handleRewindLastTurn` 用 `for (i<100 && isProcessing) await sleep(20)` 等 finally 完成,2s 超时兜底防止死锁
3. **rewind 幂等**:连续两次撤回,第二次找不到 user 消息时空操作返回,不撤回更早的消息
4. **双击窗口竞态**:第一次 ESC abort 后,spinnerStore.active 变 false 可能延迟(finally 异步)——双击窗口内第二次 ESC 到来时,active 可能还是 true。需在 `useInputHandler` 内用 `lastEscAtRef` 时间戳判定,不能只看 active
5. **catch 块覆盖所有 abort 形态**:见决策 4

---

## 文件结构

| 文件 | 类型 | 职责 |
|---|---|---|
| `src/tui/state/messages-store.ts` | 改 | 新增 `rewindLastUserTurn` + `finalizeStreamingAsInterrupted` |
| `src/tui/bootstrap.tsx` | 改 | `BootstrapOptions` 加 2 回调字段;透传到 ConnectedApp |
| `src/tui/ConnectedApp.tsx` | 改 | props 接收 2 回调;透传 spinnerStore + 2 回调给 useInputHandler |
| `src/tui/input/use-input-handler.ts` | 改 | 签名扩展;新增 ESC 双击时序逻辑 |
| `src/index.ts` | 改 | module-level 句柄 + `handleAbortStream` + `handleRewindLastTurn` + catch 加 signal.aborted 判断 + bootstrap 注入 |
| `src/__tests__/tui/messages-store.test.ts` | 改 | 新增 rewind/finalizeInterrupted 测试 |
| `src/__tests__/tui/use-input-handler.test.tsx` | 改 | 新增 ESC 双击/中断测试 |

---

## 开发顺序

从底向上,每层独立可验证:

1. **Task 1-2**:`messagesStore` 两个新方法(纯数据,TDD 最容易)
2. **Task 3**:`useInputHandler` 签名扩展 + ESC 时序(用 mock spinnerStore)
3. **Task 4**:`BootstrapOptions` + `ConnectedApp` 透传(胶水,无逻辑)
4. **Task 5-6**:`index.ts` 的 `handleAbortStream` + `handleRewindLastTurn` + catch 修正
5. **Task 7**:bootstrap 注入回调,集成测试
6. **Task 8**:手动验证 + 边界 case

---

## Task 1: messagesStore.rewindLastUserTurn(硬撤回)

**Files:**
- Modify: `src/tui/state/messages-store.ts`(接口 + 实现)
- Test: `src/__tests__/tui/messages-store.test.ts`

- [ ] **Step 1.1: 写失败测试(基础硬撤回)**

在 `src/__tests__/tui/messages-store.test.ts` 末尾(`describe` 块内)追加:

```typescript
  it('rewindLastUserTurn:无 assistant 时,删末条 user 及其后全部', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ 你好'));
    store.getState().appendLine('system', LINE('thinking...'));
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages).toEqual([]);
  });

  it('rewindLastUserTurn:保留 user 之前的消息', () => {
    const store = createMessagesStore();
    store.getState().appendLine('assistant', LINE('● 上次回复'));
    store.getState().appendLine('user', LINE('❯ 第二次提问'));
    store.getState().appendLine('system', LINE('banner'));
    store.getState().rewindLastUserTurn();
    const msgs = store.getState().messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[0]!.lines[0]!.content).toBe('● 上次回复');
  });

  it('rewindLastUserTurn:无 user 时幂等(空操作)', () => {
    const store = createMessagesStore();
    store.getState().appendLine('system', LINE('banner'));
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages.length).toBe(1);
  });

  it('rewindLastUserTurn:连续两次第二次幂等', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ q1'));
    store.getState().appendLine('user', LINE('❯ q2'));
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages.length).toBe(1);
    store.getState().rewindLastUserTurn();
    expect(store.getState().messages).toEqual([]);
    store.getState().rewindLastUserTurn(); // 第三次:已空
    expect(store.getState().messages).toEqual([]);
  });
```

- [ ] **Step 1.2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/messages-store.test.ts -t "rewindLastUserTurn"`
Expected: FAIL with "store.getState().rewindLastUserTurn is not a function"

- [ ] **Step 1.3: 实现方法**

在 `src/tui/state/messages-store.ts` 的 `MessagesState` 接口里(`clear` 之后)加:

```typescript
  /** 硬撤回:删除末条 user 消息及其后所有消息(幂等:无 user 时空操作)。 */
  rewindLastUserTurn: () => void;
```

在 `createMessagesStore` 返回的 store 对象里(`clear` 之后)加实现:

```typescript
    rewindLastUserTurn: () => set((s) => {
      const msgs = s.messages;
      // 从末尾向前找最后一条 user
      let userIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]!.role === 'user') { userIdx = i; break; }
      }
      if (userIdx === -1) return s; // 幂等:无 user
      return { messages: msgs.slice(0, userIdx) };
    }),
```

- [ ] **Step 1.4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/messages-store.test.ts -t "rewindLastUserTurn"`
Expected: PASS(4 个测试)

- [ ] **Step 1.5: 提交**

```bash
git add src/tui/state/messages-store.ts src/__tests__/tui/messages-store.test.ts
git commit -m "feat(messages-store): add rewindLastUserTurn for hard rewind"
```

---

## Task 2: messagesStore.finalizeStreamingAsInterrupted(软中断)

**Files:**
- Modify: `src/tui/state/messages-store.ts`
- Test: `src/__tests__/tui/messages-store.test.ts`

- [ ] **Step 2.1: 写失败测试**

在 `src/__tests__/tui/messages-store.test.ts` 追加:

```typescript
  it('finalizeStreamingAsInterrupted:末条流式固化为 [interrupted]', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ q'));
    store.getState().startStreaming('');
    store.getState().updateStreaming('部分内容');
    store.getState().finalizeStreamingAsInterrupted();
    const msgs = store.getState().messages;
    // user 还在,assistant 末条已固化
    expect(msgs.length).toBe(2);
    expect(msgs[1]!.role).toBe('assistant');
    expect(msgs[1]!.finalized).toBe(true);
    expect(msgs[1]!.streamingText).toBeUndefined();
    // streamingText 内容被保留为 line
    const contents = msgs[1]!.lines.map((l) => l.content);
    expect(contents).toContain('部分内容');
    expect(contents).toContain('[interrupted]');
  });

  it('finalizeStreamingAsInterrupted:无流式消息时空操作', () => {
    const store = createMessagesStore();
    store.getState().appendLine('user', LINE('❯ q'));
    store.getState().finalizeStreamingAsInterrupted();
    // 没崩,也没新增
    expect(store.getState().messages.length).toBe(1);
  });

  it('finalizeStreamingAsInterrupted:无 streamingText 时只加 [interrupted]', () => {
    const store = createMessagesStore();
    store.getState().startStreaming(''); // 空流式
    store.getState().finalizeStreamingAsInterrupted();
    const m = store.getState().messages[0]!;
    expect(m.finalized).toBe(true);
    expect(m.lines.some((l) => l.content === '[interrupted]')).toBe(true);
  });
```

- [ ] **Step 2.2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/messages-store.test.ts -t "finalizeStreamingAsInterrupted"`
Expected: FAIL with "is not a function"

- [ ] **Step 2.3: 实现方法**

在 `MessagesState` 接口加:

```typescript
  /** 软中断:末条流式 assistant 固化(保留 streamingText 为 line + 追加 [interrupted] 标记)。
   *  无流式消息时空操作。 */
  finalizeStreamingAsInterrupted: () => void;
```

在 store 实现加(注意:`fg: 'error'` 是 `UIMessageStyle.fg` 的合法值,`styleToInkProps` 兜底用原值渲染):

```typescript
    finalizeStreamingAsInterrupted: () => set((s) => {
      const last = s.messages[s.messages.length - 1];
      // 只处理流式中的 assistant(finalized=false, role='assistant')
      if (!last || last.finalized || last.role !== 'assistant') return s;
      const text = (last.streamingText ?? '').trim();
      const { streamingText: _drop, ...rest } = last;
      void _drop;
      const newLines = text
        ? [
            ...last.lines,
            { content: text, style: {}, indent: 0 },
            { content: '[interrupted]', style: { fg: 'error' }, indent: 0 },
          ]
        : [
            ...last.lines,
            { content: '[interrupted]', style: { fg: 'error' }, indent: 0 },
          ];
      const updated: TuiMessage = { ...rest, lines: newLines, finalized: true };
      return { messages: [...s.messages.slice(0, -1), updated] };
    }),
```

- [ ] **Step 2.4: 运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/messages-store.test.ts -t "finalizeStreamingAsInterrupted"`
Expected: PASS(3 个测试)

- [ ] **Step 2.5: 全量测试确认无回归**

Run: `npx vitest run src/__tests__/tui/messages-store.test.ts`
Expected: PASS(原有测试 + 新测试全部通过)

- [ ] **Step 2.6: 提交**

```bash
git add src/tui/state/messages-store.ts src/__tests__/tui/messages-store.test.ts
git commit -m "feat(messages-store): add finalizeStreamingAsInterrupted for soft interrupt"
```

---

## Task 3: useInputHandler 签名扩展 + ESC 时序

**Files:**
- Modify: `src/tui/input/use-input-handler.ts`(签名 + ESC 逻辑)
- Test: `src/__tests__/tui/use-input-handler.test.tsx`

**设计**:ESC 逻辑插在 completion 拦截块**之后**、非补全状态处理(`key.tab` 之前)**之前**。用 `useRef` 存上次 ESC 时间戳,400ms 窗口判定双击。

- [ ] **Step 3.1: 写失败测试(中断触发)**

在 `src/__tests__/tui/use-input-handler.test.tsx` 顶部 `InputProbe` 定义改为支持新参数(保留向后兼容):

```typescript
import { useInputHandler } from '../../tui/input/use-input-handler.js';
import { createSpinnerStore, type SpinnerStore } from '../../tui/state/spinner-store.js';
import { resetPasteState } from '../../tui/input/paste-handler.js';

function InputProbe({
  store,
  onExit,
  onTab,
  onToggleOverlay,
  overlayVisible,
  spinnerStore,
  onAbortStream,
  onRewindLastTurn,
}: {
  store: InputStore;
  onExit?: () => void;
  onTab?: (text: string) => void;
  onToggleOverlay?: () => void;
  overlayVisible?: () => boolean;
  spinnerStore?: SpinnerStore;
  onAbortStream?: () => void;
  onRewindLastTurn?: () => void;
}): React.ReactElement {
  useInputHandler(
    store, onExit, onTab, onToggleOverlay, overlayVisible,
    undefined, undefined, undefined,
    spinnerStore, onAbortStream, onRewindLastTurn,
  );
  const text = store.getState().text;
  return React.createElement(Text, {}, `text="${text}"`);
}
```

在 describe 块末尾追加测试:

```typescript
  it('ESC + spinner active → 调 onAbortStream', () => {
    const spinnerStore = createSpinnerStore();
    spinnerStore.getState().start('thinking');
    const onAbortStream = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream,
    }));
    stdin.write('\x1b'); // ESC
    expect(onAbortStream).toHaveBeenCalledTimes(1);
  });

  it('ESC + spinner inactive → 不调 onAbortStream', () => {
    const spinnerStore = createSpinnerStore();
    const onAbortStream = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream,
    }));
    stdin.write('\x1b');
    expect(onAbortStream).not.toHaveBeenCalled();
  });

  it('双击 ESC(400ms 内)→ 调 onRewindLastTurn', async () => {
    const spinnerStore = createSpinnerStore();
    const onAbortStream = vi.fn();
    const onRewindLastTurn = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream, onRewindLastTurn,
    }));
    stdin.write('\x1b'); // 第一次 ESC
    // 立即第二次(在 400ms 窗口内)
    stdin.write('\x1b');
    expect(onAbortStream).toHaveBeenCalledTimes(1);
    expect(onRewindLastTurn).toHaveBeenCalledTimes(1);
  });

  it('两次 ESC 超出 400ms → 只中断不撤回', async () => {
    const spinnerStore = createSpinnerStore();
    const onAbortStream = vi.fn();
    const onRewindLastTurn = vi.fn();
    const store = createInputStore();
    const { stdin } = render(React.createElement(InputProbe, {
      store, spinnerStore, onAbortStream, onRewindLastTurn,
    }));
    stdin.write('\x1b');
    // 等 450ms 超出窗口
    await new Promise((r) => setTimeout(r, 450));
    stdin.write('\x1b');
    expect(onAbortStream).toHaveBeenCalledTimes(2); // 两次都触发中断
    expect(onRewindLastTurn).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3.2: 运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/use-input-handler.test.tsx -t "ESC"`
Expected: FAIL(类型错误或测试不通过)

- [ ] **Step 3.3: 扩展 useInputHandler 签名 + 实现 ESC 逻辑**

在 `src/tui/input/use-input-handler.ts`:

1. 顶部 import 加:
```typescript
import { useRef } from 'react';
import type { SpinnerStore } from '../state/spinner-store.js';
```

2. 函数签名扩展(在 `selectStore?: SelectStore,` 之后加 3 个参数):
```typescript
export function useInputHandler(
  store: InputStore,
  onExit?: () => void,
  onTab?: (text: string) => void,
  onToggleOverlay?: () => void,
  overlayVisible?: () => boolean,
  onPageScroll?: (direction: 'up' | 'down') => void,
  completionStore?: CompletionStore,
  selectStore?: SelectStore,
  spinnerStore?: SpinnerStore,
  onAbortStream?: () => void,
  onRewindLastTurn?: () => void,
): void {
  const DOUBLE_ESC_WINDOW_MS = 400;
  const lastEscAtRef = useRef(0);

  useInput((input: string, key: Key) => {
    // ... 现有 overlay / Ctrl+C / Ctrl+O / PageUp/Down / selectStore / completion 块完全不变
```

3. 在 completion 拦截块**闭合之后**(`}` 之后,即 `// ─────────── 非补全状态 ───────────` 注释**之前**)插入 ESC 中断/撤回逻辑:

```typescript
    // ─────────── ESC 中断/撤回(在 completion 之后,普通编辑之前)───────────
    if (key.escape) {
      const now = Date.now();
      const isRunning = spinnerStore?.getState().active ?? false;
      // 窗口内第二次 ESC → 撤回(无论此时 isRunning 与否:第一次已触发 abort,
      // spinnerStore.active 可能还在过渡中,用时间戳判定更可靠)
      if (now - lastEscAtRef.current <= DOUBLE_ESC_WINDOW_MS && lastEscAtRef.current !== 0) {
        onRewindLastTurn?.();
        lastEscAtRef.current = 0;
        return;
      }
      // 第一次 ESC(或窗口外的单次):若有任务运行 → 中断
      if (isRunning) {
        onAbortStream?.();
      }
      lastEscAtRef.current = now;
      return;
    }

    // ─────────── 非补全状态 ───────────
```

注意:**保留**最末尾可打印字符判断里的 `!key.escape`(`:188`)。虽然 ESC 在这里已经 return,但作为防御保持原样。

- [ ] **Step 3.4: 运行新测试确认通过**

Run: `npx vitest run src/__tests__/tui/use-input-handler.test.tsx -t "ESC"`
Expected: PASS(4 个新测试)

- [ ] **Step 3.5: 全量 input-handler 测试确认无回归**

Run: `npx vitest run src/__tests__/tui/use-input-handler.test.tsx`
Expected: PASS(所有测试,包括原有 completion/Tab/字符等)

- [ ] **Step 3.6: 提交**

```bash
git add src/tui/input/use-input-handler.ts src/__tests__/tui/use-input-handler.test.tsx
git commit -m "feat(input-handler): ESC abort + double-ESC rewind timing"
```

---

## Task 4: BootstrapOptions + ConnectedApp 透传

**Files:**
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/ConnectedApp.tsx`

**设计**:纯胶水代码,无业务逻辑。`BootstrapOptions` 加 2 字段,透传到 `ConnectedApp` props,再透传给 `useInputHandler`。

- [ ] **Step 4.1: 改 BootstrapOptions 接口**

在 `src/tui/bootstrap.tsx:42-59` 的 `BootstrapOptions` 接口里,在 `onToggleOverlay?: () => void;` 之后追加:

```typescript
  /** ESC 中断当前 LLM 流(单击 ESC 触发,无任务时空操作) */
  onAbortStream?: () => void;
  /** ESC 双击撤回末条 user turn(中断流 + 删消息 + 回填输入框) */
  onRewindLastTurn?: () => void;
```

- [ ] **Step 4.2: 透传到 ConnectedApp createElement**

在 `src/tui/bootstrap.tsx:153-161` 的 `React.createElement(ConnectedApp, {...})` 里,在 `onToggleOverlay: opts.onToggleOverlay,` 之后追加:

```typescript
          onAbortStream: opts.onAbortStream,
          onRewindLastTurn: opts.onRewindLastTurn,
```

- [ ] **Step 4.3: ConnectedApp props 接收**

在 `src/tui/ConnectedApp.tsx` 找到 `ConnectedAppProps` 接口定义(约 `:55-75`),在 `onToggleOverlay?: () => void;` 之后追加:

```typescript
  onAbortStream?: () => void;
  onRewindLastTurn?: () => void;
```

- [ ] **Step 4.4: 解构 props**

在 `ConnectedApp` 函数签名解构(约 `:73`)的参数列表里,在 `onToggleOverlay,` 之后追加:

```typescript
  onAbortStream, onRewindLastTurn,
```

- [ ] **Step 4.5: 透传给 useInputHandler**

找到 `useInputHandler(...)` 调用(约 `:165`),在末尾 `selectStore)` 之前替换为:

```typescript
  useInputHandler(
    inputStore, onExit, onTab, onToggleOverlay, () => overlayStore.getState().visible,
    handlePageScroll, completionStore, selectStore,
    spinnerStore, onAbortStream, onRewindLastTurn,
  );
```

- [ ] **Step 4.6: 类型检查通过**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4.7: 提交**

```bash
git add src/tui/bootstrap.tsx src/tui/ConnectedApp.tsx
git commit -m "feat(tui): thread onAbortStream/onRewindLastTurn through ConnectedApp"
```

---

## Task 5: index.ts 的 handleAbortStream + catch 修正

**Files:**
- Modify: `src/index.ts`

**设计**:加 module-level 句柄,ac 创建/清理时同步,catch 块用 `ac.signal.aborted` 判断(实测验证)。

- [ ] **Step 5.1: 加 module-level 句柄**

在 `src/index.ts:252`(`let isProcessing = false;`)之后追加:

```typescript
// ESC 中断句柄:handleUserSubmit 内创建 ac 时写入,abort/rewind 回调读它。
// 模块级是因为 onAbortStream/onRewindLastTurn 在 bootstrap 时注册,
// 远早于 handleUserSubmit 执行——闭包必须能拿到最新值。
let currentAbortController: AbortController | null = null;
// 撤回时回填的原文(用户实际发送的 agentText 展开版,不是占位符 historyText)
let lastSubmittedAgentText: string | null = null;
```

- [ ] **Step 5.2: ac 创建后写入句柄**

在 `src/index.ts:536`(`const ac = new AbortController();`)之后追加:

```typescript
  currentAbortController = ac;
  lastSubmittedAgentText = userInput;
```

- [ ] **Step 5.3: catch 块用 signal.aborted 判断**

把 `src/index.ts:643-646` 的 catch 块改为:

```typescript
  } catch (err) {
    // 中断判断:用 ac.signal.aborted,不用 err.name/instanceof Error。
    // 实测:ac.abort('user-cancel') 抛出的 err 是字符串(不是 Error),err.name 是 undefined。
    // 只有 ac.signal.aborted 在三种 abort 形态下都为 true。
    if (ac.signal.aborted) {
      // 用户主动中断:静默退出,不打印 [Error]
    } else {
      tuiHandle?.printStyled(`[Error] ${formatErrorForDisplay(err)}`, 'error');
    }
  } finally {
```

- [ ] **Step 5.4: finally 清理句柄**

在 `src/index.ts:647` 的 finally 块内,在 `isProcessing = false;` 之后追加:

```typescript
    currentAbortController = null;
```

- [ ] **Step 5.5: 实现 handleAbortStream**

在 `src/index.ts` 的 `handleUserSubmit` 函数定义**之前**(`async function handleUserSubmit` 之前)新增:

```typescript
/**
 * ESC 中断当前 LLM 流。幂等:无任务运行(ac 为 null)或已 aborted 时空操作。
 * 由 React 层的 useInputHandler 通过 BootstrapOptions.onAbortStream 调用。
 */
function handleAbortStream(): void {
  currentAbortController?.abort();
}
```

注意:用无参 `abort()`,不传 reason。原因:实测 `ac.abort('user-cancel')` 抛字符串 err,虽然我们用 signal.aborted 判断不看 err,但保持 abort 形态简单(无参抛标准 DOMException 'AbortError',更符合规范)。

- [ ] **Step 5.6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5.7: 提交**

```bash
git add src/index.ts
git commit -m "feat(index): expose AbortController via module handle + signal.aborted catch check"
```

---

## Task 6: index.ts 的 handleRewindLastTurn

**Files:**
- Modify: `src/index.ts`

**设计**:核心时序——**先读状态判断 hasMeaningful,再 abort,再操作 store**。软中断不回填,硬撤回回填。sessionMessages 同步放 index.ts(关注点分离)。

- [ ] **Step 6.1: 实现 handleRewindLastTurn**

在 `src/index.ts` 的 `handleAbortStream` 之后新增:

```typescript
/**
 * ESC 双击撤回末条 user turn。
 * 时序:先读当前 messages 判断 hasMeaningful(abort 前流式块还在),
 *       再中断流并等 finally 完成,最后操作 store + 同步 sessionMessages + 回填输入框。
 *
 * 语义:
 *  - 硬撤回(无有意义 assistant 内容):删末条 user 及其后 + 同步 sessionMessages + 换 sessionId + 回填
 *  - 软中断(有有意义内容):仅 finalize 流式为 [interrupted],不删、不回填、不换 sessionId
 */
async function handleRewindLastTurn(): Promise<void> {
  const handle = tuiHandle;
  if (!handle) return;

  // 1. 先读当前 messages(必须在 abort 之前)
  const msgs = handle.messagesStore.getState().messages;
  let userIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user') { userIdx = i; break; }
  }
  if (userIdx === -1) return; // 幂等:无 user 可撤回

  // 判断 user 之后是否有"有意义的 assistant 内容"
  // (finalized 的 lines 有非空 content,或流式的 streamingText trim 后非空)
  const hasMeaningful = msgs.slice(userIdx + 1).some((m) => {
    if (m.role !== 'assistant') return false;
    if (!m.finalized) return (m.streamingText ?? '').trim().length > 0;
    return m.lines.some((l) => (l.content ?? '').trim().length > 0);
  });

  // 2. 若仍在跑,先中断并等流真正停止(isProcessing 翻 false)
  if (currentAbortController && !currentAbortController.signal.aborted) {
    currentAbortController.abort();
    // 轮询等 finally 完成,2s 超时兜底
    for (let i = 0; i < 100 && isProcessing; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  // 3. 操作 store
  if (hasMeaningful) {
    // 软中断:仅 finalize 流式为 [interrupted]
    handle.messagesStore.getState().finalizeStreamingAsInterrupted();
    return; // 不删 user、不回填、不换 sessionId
  }

  // 硬撤回:删末条 user 及其后
  handle.messagesStore.getState().rewindLastUserTurn();

  // 4. 同步 sessionMessages(关注点分离:store 外做)
  let uIdx = -1;
  for (let i = sessionMessages.length - 1; i >= 0; i--) {
    if (sessionMessages[i]!.role === 'user') { uIdx = i; break; }
  }
  if (uIdx !== -1) {
    sessionMessages = sessionMessages.slice(0, uIdx);
  }

  // 5. 换 sessionId(旧 jsonl 保留,resume 时新会话不带撤回的消息)
  sessionId = makeNewSessionId(); // 见 Step 6.2

  // 6. 回填输入框
  if (lastSubmittedAgentText !== null) {
    handle.inputStore.getState().setText(lastSubmittedAgentText);
    lastSubmittedAgentText = null;
  }
}
```

- [ ] **Step 6.2: 检查 sessionId 生成方式**

Run: `grep -n "sessionId = " src/index.ts | head -5`
查看 sessionId 当前的赋值方式。如果有现成的生成函数(如 `randomUUID()` 直接赋值),在 handleRewindLastTurn 里用相同方式。

如果当前是 `sessionId = randomUUID()` 直接调用,则 `makeNewSessionId()` 内联替换为 `randomUUID()`。

如果当前是通过某个 `createSession()` 或类似函数,复用之。在 plan 执行时按实际代码调整 Step 6.1 里的 `makeNewSessionId()` 调用。

- [ ] **Step 6.3: 检查 sessionId 是否需要重新初始化持久化**

Run: `grep -n "sessionStore\b" src/index.ts | head -10`

确认换 sessionId 后是否需要重新打开/初始化 sessionStore(可能 sessionStore 内部缓存了当前 sessionId 的文件句柄)。如果是,在 Step 6.1 的"换 sessionId"之后加相应调用。

(若 sessionStore 是无状态 append(每次调用传 sessionId),则无需额外处理。)

- [ ] **Step 6.4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6.5: 提交**

```bash
git add src/index.ts
git commit -m "feat(index): handleRewindLastTurn with read-before-abort timing"
```

---

## Task 7: bootstrap 注入回调 + 集成

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 7.1: 在 bootstrap 调用处注入回调**

在 `src/index.ts:691-704` 的 `bootstrap({...})` 调用里,在 `onToggleOverlay: () => handleToggleOverlay(tuiHandle),` 之后追加:

```typescript
    onAbortStream: () => { void handleAbortStream(); },
    onRewindLastTurn: () => { void handleRewindLastTurn(); },
```

- [ ] **Step 7.2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 7.3: 全量 tui 测试**

Run: `npx vitest run src/__tests__/tui/`
Expected: PASS(无回归)

- [ ] **Step 7.4: 全量 agent 测试**

Run: `npx vitest run src/__tests__/agent/ src/__tests__/index.test.ts`
Expected: PASS(无回归)

- [ ] **Step 7.5: 提交**

```bash
git add src/index.ts
git commit -m "feat(index): wire onAbortStream/onRewindLastTurn to bootstrap"
```

---

## Task 8: 手动验证(实机测试)

**Files:** 无(运行时验证)

这个任务无法自动化(LLM 流式响应 + 真实键盘输入),必须手动跑。按 superpowers:verification-before-completion 技能要求保留终端证据。

- [ ] **Step 8.1: 构建项目**

Run: `npm run build`(或项目的实际构建命令,见 package.json scripts)
Expected: 构建成功无错误

- [ ] **Step 8.2: 启动 TUI,发送一个会触发长响应的消息**

启动程序,输入"请详细介绍一下 TypeScript 的类型系统(写 2000 字)"并回车。
Expected: spinner 启动,assistant 开始流式输出。

- [ ] **Step 8.3: 验证单击 ESC 中断**

流式输出过程中按一次 ESC。
Expected:
- 流式输出立即停止
- spinner 消失
- 没有 `[Error]` 红色提示(catch 块的 signal.aborted 判断生效)
- 已输出的部分内容保留在屏幕上
- 输入框为空(没有自动回填,因为是软中断)

**终端证据**:截图或复制屏幕内容到验证记录。

- [ ] **Step 8.4: 验证双击 ESC 硬撤回**

再次发送一个消息,在 assistant 开始流式输出前(或刚开始时)快速按两次 ESC(400ms 内)。
Expected:
- 流停止
- user 消息(❯ ...)被删除
- assistant 内容(如果有少量)也被删除
- 输入框回填了刚发送的原文
- 光标在输入框末尾

**终端证据**:截图。

- [ ] **Step 8.5: 验证双击 ESC 软中断(有内容时不回填)**

发送一个消息,等 assistant 输出一段有意义的内容(超过几个字)后,快速按两次 ESC。
Expected:
- 流停止
- user 消息保留
- assistant 部分内容保留,末尾有 `[interrupted]` 标记
- 输入框为空(不回填)

**终端证据**:截图。

- [ ] **Step 8.6: 验证空闲 ESC 无副作用**

不发送消息(spinner 未启动),按 ESC。
Expected: 无任何反应(不崩溃、不清空输入框、不退出)。

- [ ] **Step 8.7: 验证撤回后再发送**

执行 Step 8.4 后(输入框已回填),修改文本后回车再次发送。
Expected: 正常进入新的 agent loop,新消息正常追加。历史 jsonl 的旧 session 文件还在(可用 `--list` 确认),新消息写入新 session 文件。

- [ ] **Step 8.8: 验证 completion 下拉框的 ESC 不冲突**

输入 `/` 触发下拉框,按 ESC。
Expected: 下拉框关闭,不触发中断/撤回(completion 拦截块优先级更高)。

- [ ] **Step 8.9: 验证最终无回归**

Run: `npm test`
Expected: 所有测试通过。

- [ ] **Step 8.10: 最终提交(如有手动验证中发现的小修复)**

```bash
git add -A
git commit -m "test: manual verification passed for ESC interrupt/rewind"
```

---

## Self-Review

### Spec coverage

| 需求 | 覆盖任务 |
|---|---|
| ESC 中断 LLM 流 | Task 3(时序)+ Task 5(handleAbortStream + catch)+ Task 7(注入) |
| 双击 ESC 撤回 | Task 3(双击窗口)+ Task 6(handleRewindLastTurn) |
| 撤回内容存入输入框 | Task 6(硬撤回分支 setText) |
| 用户可再次发送或修改后再发送 | Task 8.7 手动验证 |
| spinner 中断 | 依赖现有 `streaming-query.ts:142` 的 abort 检查 + `index.ts:648` finally 的 stopSpinner(无需改动) |

### 已识别的潜在风险(plan 执行时关注)

1. **工具执行中 abort**:`streaming-query.ts:142` 的 abort 检查在 while 循环开头,工具执行中途 abort 需等当前工具返回。若工具是长时间运行的 `run_bash`(如 `sleep 100`),中断会延迟。Task 8 手动验证时若发现此问题,需另开任务查 `run_bash` 是否把 signal 传给 child_process。
2. **sessionId 生成方式**:Task 6.2/6.3 需按实际代码调整,plan 里给了占位符 `makeNewSessionId()`。
3. **OpenAI/Google SDK 的 abort 行为**:实测只验证了原生 fetch + Anthropic SDK 结构。OpenAI/Google client 的 abort 行为若与 Anthropic 不同,catch 块的 `ac.signal.aborted` 判断依然有效(与 err 形态无关)。

### Placeholder scan

✅ 无 TBD/TODO/"implement later"
✅ 所有代码块都是完整可执行的
✅ Step 6.2/6.3 是显式的"按实际代码调整"指引,不是占位符——给了具体的 grep 命令和判断逻辑

### Type consistency

- `rewindLastUserTurn(): void` — Task 1 定义,Task 6 调用 ✅
- `finalizeStreamingAsInterrupted(): void` — Task 2 定义,Task 6 调用 ✅
- `useInputHandler` 参数顺序 — Task 3 定义,Task 4 Step 4.5 调用一致 ✅
- `BootstrapOptions.onAbortStream/onRewindLastTurn` — Task 4 定义,Task 7 调用 ✅
- `currentAbortController` / `lastSubmittedAgentText` — Task 5 定义,Task 6 调用 ✅
