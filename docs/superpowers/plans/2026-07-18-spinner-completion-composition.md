# Spinner Completion and Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将运行中的 Spinner 统一为 normal/brief 共享视图，并在 turn 结束时按 `Thinking 摘要 → 空行 → 暗灰色完成消息` 的顺序写入普通消息与终端滚动区。

**Architecture:** `spinner-store` 持有动画状态和原子上下文快照，纯函数 `selectSpinnerView(state)` 统一决定主动画行、活动区、Tip、Budget、NextTask、normal/brief 和 `rowCount`。Ink 与 inline 只负责各自的颜色和终端编码；`ConnectedApp` 通过一个时钟 hook 成为唯一 tick 所有者。完成消息由 `createTurnDurationMessage()` 固化随机动词和行样式，再由 `messages-store` 作为独立消息追加。

**Tech Stack:** Node.js >= 18、TypeScript 6 strict/ES2022/NodeNext、React 19、Ink 7、Zustand 5、Vitest 3、ANSI TrueColor、`slice-ansi`。

## Global Constraints

- 不新增运行时依赖；复用现有 React、Ink、Zustand、Vitest、主题和 ANSI 工具。
- 完成行文本固定为 `✻ <verb> for <duration>`，符号固定为 `✻`，整行 `dim: true`。
- 完成动词只在创建消息时抽样一次，重渲染不得改变。
- 完成消息必须是独立 `SystemTurnDurationMessage`，不能与 Thinking 或其他 `system` 消息合并。
- normal/brief 是显式展示密度，默认 `normal`，不与 inline/alt-screen、verbose 或终端宽度绑定。
- brief 只显示 `SpinnerAnimationRow`；normal 的辅助区顺序固定为活动区、Tip、Budget、NextTask。
- Teammate 只展示非 `shutdown` 的一级成员；没有成员时才回退到未完成 TaskListV2。
- 没有权威 Budget/NextTask 数据时隐藏，不使用 `contextPct`、TaskBoard 或占位文本伪造。
- 不新增 manager 轮询；上下文只在初始化、turn 开始和工具结果返回后刷新。
- `spinnerRowCount` 必须同时驱动 Footer 高度、ScrollBox 高度和输入光标坐标。
- overlay/select 替换布局时维持现有优先级，不叠加 Spinner 辅助行。
- 所有行为修改严格执行 RED → GREEN → REFACTOR；每个新增关键测试必须先观察到正确失败。
- 当前工作区已有连续 Spinner 改动；禁止 reset、checkout 或覆盖，提交前只暂存当前任务明确列出的文件并检查 staged diff。

---

## Wheel Reuse Check

| 能力 | 复用位置 | 本计划只补的最小缺口 |
|---|---|---|
| 有效时长、暂停、token、thinking、stalled | `src/tui/state/spinner-store.ts` | stop 只返回 duration；增加上下文快照 |
| 动词配置和主行动画 | `spinner-verbs.ts`、`SpinnerGlyph.tsx`、`GlimmerMessage.tsx`、`ThinkingIndicator.tsx` | 不重写动画，只抽出组合边界 |
| 消息账本与固化滚动 | `messages-store.ts`、`flatten-messages.ts`、inline rendered-lines 账本 | 增加独立完成消息追加 API |
| 语义样式到 Ink/ANSI | `FormattedLine`、`styleToInkProps()`、`renderFinalizedLine()` | 完成行只写 `{ dim: true }` |
| Teammate 与 Task 数据 | `TeammateManager.list()`、`TodoManager.getItems()` | turn 边界转换成只读快照 |
| Footer 物理布局 | `layoutFooter()`、`InlineRenderer.commit()` | `spinnerLine` 扩展为 `spinnerLines` |
| ANSI 安全截断 | `slice-ansi`、`getUsableWidth()` | 对多行 Spinner 输出统一截断 |
| 主题暗灰色 | `theme.textMuted`、`resolveSGR()` | 辅助行统一 dim/muted，不新增色值 |

## Defense Boundaries

- `spinnerStore.stop()` 在 inactive 时返回 `null`，重复 stop 不能重复入队。
- 判断前导空行时查找最后一个可渲染行；末行已经为空时不再插入第二个空行。
- `appendLine()` 遇到带 `kind` 的专用消息不得续接，防止 turn 后续空行污染完成消息。
- `setContext()` 复制数组和成员对象；调用方之后修改原数组不能改变 Store。
- 可选文本先 `trim()`，空白转换为 `null`；inactive、brief 和空辅助数据均为零辅助行。
- Tip 用暂停感知的有效 `time` 计算整秒快照，30 分钟规则优先于 30 秒 `/btw` 规则。
- inline 行数由 `1 + spinnerLines.length` 推导；禁止在高度、`cursorToTop` 和光标物理行中重复写条件分支。
- Spinner 主行隐藏窗口继续复用 `computeSpinnerVisible()`，避免正文 finalize 后残影。
- manager 数据读取失败时保持上一个完整快照或使用空快照，不产生半更新对象。

## Core Anchor Function

主锚点是：

```ts
export function selectSpinnerView(state: SpinnerState): SpinnerView;
```

它是 normal/brief、活动区优先级、Tip、辅助行顺序和 `rowCount` 的唯一决策入口。完成消息支链的锚点是：

```ts
export function createTurnDurationMessage(
  input: CreateTurnDurationMessageInput,
): SystemTurnDurationMessage;
```

所有生命周期和渲染测试都从这两个纯函数向外扩展，避免先深入 Ink/ANSI 细节。

## File Map

**Create**

- `src/tui/state/turn-duration-message.ts`：完成动词、专用消息类型、纯行渲染器和消息工厂。
- `src/tui/state/spinner-view.ts`：共享 `SpinnerView`、Tip 决策、活动区和行数选择器。
- `src/tui/hooks/useSpinnerClock.ts`：active 期间唯一 50ms tick 生命周期。
- `src/__tests__/tui/turn-duration-message.test.ts`：完成消息纯函数测试。
- `src/__tests__/tui/spinner-view.test.ts`：normal/brief、活动区、Tip 和行数测试。
- `src/__tests__/tui/use-spinner-clock.test.tsx`：统一时钟所有权测试。
- `logs/2026-07-18-spinner-completion-composition.md`：只记录 TDD 失败证据和最终验证结果。

**Modify**

- `src/tui/types.ts`：给普通消息增加可选 `kind`。
- `src/tui/state/messages-store.ts`：独立追加 `SystemTurnDurationMessage`。
- `src/tui/state/spinner-store.ts`：stop 契约、原子上下文和默认值。
- `src/tui/bootstrap.tsx`：初始化/更新上下文，stop 后调用消息账本 API。
- `src/index.ts`：Thinking 先固化、finally 唯一 stop、turn/tool-result 刷新上下文。
- `src/tui/components/Spinner.tsx`：拆出 `SpinnerAnimationRow`、`BriefSpinner`、`SpinnerWithVerbInner`、`SpinnerWithVerb`。
- `src/tui/components/Footer.tsx`：渲染共享 SpinnerView。
- `src/tui/App.tsx`、`src/tui/ConnectedApp.tsx`：使用共享 `rowCount` 和统一时钟。
- `src/tui/inline/SpinnerLine.tsx`：从共享 View 构建 ANSI 多行。
- `src/tui/inline/InlineApp.tsx`：删除重复主行构建和本地 interval。
- `src/tui/inline/layout.ts`：`spinnerLine` 改为 `spinnerLines`，动态计算 reserve rows。
- 直接相关测试：`messages-store.test.ts`、`spinner-store.test.ts`、`bootstrap-spinner-completion.test.ts`、`spinner-component.test.tsx`、`spinner-integration.test.tsx`、`SpinnerLine.test.tsx`、`layout.test.ts`、Footer/光标回归测试。
- `to-do-list.md`：仅在验证门通过后更新 AUTO-0020～AUTO-0024 和总任务状态。

---

### Task 1: 固化完成消息模型和随机动词

**Files:**
- Create: `src/tui/state/turn-duration-message.ts`
- Modify: `src/tui/types.ts:19-33`
- Modify: `src/tui/state/spinner-store.ts:13-18`
- Modify: `src/__tests__/tui/spinner-store.test.ts:9-24,348-353`
- Test: `src/__tests__/tui/turn-duration-message.test.ts`

**Interfaces:**
- Consumes: `formatSpinnerDuration(durationMs: number): string`、`FormattedLine`、`TuiMessage`。
- Produces: `TURN_COMPLETION_VERBS`、`TurnCompletionVerb`、`SystemTurnDurationMessage`、`TurnDurationMessage()`、`createTurnDurationMessage()`。

- [ ] **Step 1: 写完成消息工厂的失败测试**

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  TURN_COMPLETION_VERBS,
  TurnDurationMessage,
  createTurnDurationMessage,
} from '../../tui/state/turn-duration-message.js';

describe('turn duration message', () => {
  it('创建时固定一次完成动词、时长、前导空行和 dim 样式', () => {
    const random = vi.fn(() => 0.5);

    const message = createTurnDurationMessage({
      uuid: 'msg-7', durationMs: 9_000, prependBlankLine: true, random,
    });

    expect(TURN_COMPLETION_VERBS).toHaveLength(8);
    expect(random).toHaveBeenCalledTimes(1);
    expect(message).toMatchObject({
      uuid: 'msg-7', role: 'system', kind: 'turn-duration',
      verb: 'Cooked', durationMs: 9_000, finalized: true,
    });
    expect(message.lines).toEqual([
      { content: '', style: {}, indent: 0 },
      { content: '✻ Cooked for 9s', style: { dim: true }, indent: 0 },
    ]);
    expect(TurnDurationMessage(message.verb, message.durationMs))
      .toEqual(message.lines[1]);
    expect(random).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/turn-duration-message.test.ts --reporter=verbose`

Expected: FAIL，原因是 `turn-duration-message.js` 或对应导出尚不存在；不能是语法错误。

- [ ] **Step 3: 增加专用消息判别字段和最小消息工厂**

在 `TuiMessage` 增加：

```ts
/** 专用固化消息类型；普通消息省略。 */
kind?: 'turn-duration';
```

创建 `turn-duration-message.ts`：

```ts
import type { FormattedLine } from '../../ui/types.js';
import type { TuiMessage } from '../types.js';
import { formatSpinnerDuration } from './spinner-store.js';

export const TURN_COMPLETION_VERBS = [
  'Baked', 'Brewed', 'Churned', 'Cogitated',
  'Cooked', 'Crunched', 'Sautéed', 'Worked',
] as const;

export type TurnCompletionVerb = typeof TURN_COMPLETION_VERBS[number];

export interface SystemTurnDurationMessage extends TuiMessage {
  kind: 'turn-duration';
  verb: TurnCompletionVerb;
  durationMs: number;
}

export interface CreateTurnDurationMessageInput {
  uuid: string;
  durationMs: number;
  prependBlankLine: boolean;
  random?: () => number;
}

export function TurnDurationMessage(
  verb: TurnCompletionVerb,
  durationMs: number,
): FormattedLine {
  return {
    content: `✻ ${verb} for ${formatSpinnerDuration(durationMs)}`,
    style: { dim: true },
    indent: 0,
  };
}

export function createTurnDurationMessage({
  uuid, durationMs, prependBlankLine, random = Math.random,
}: CreateTurnDurationMessageInput): SystemTurnDurationMessage {
  const verb = TURN_COMPLETION_VERBS[
    Math.floor(random() * TURN_COMPLETION_VERBS.length)
  ]!;
  return {
    uuid,
    role: 'system',
    kind: 'turn-duration',
    verb,
    durationMs,
    finalized: true,
    lines: [
      ...(prependBlankLine ? [{ content: '', style: {}, indent: 0 }] : []),
      TurnDurationMessage(verb, durationMs),
    ],
  };
}
```

从 `spinner-store.ts` 移除完成动词常量和带 verb 的旧 `SpinnerCompletion`；在旧测试中把完成动词导入改到新模块。

- [ ] **Step 4: 运行纯函数测试并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/turn-duration-message.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose`

Expected: 两个测试文件全部 PASS。

- [ ] **Step 5: 提交完成消息模型**

```powershell
git add src/tui/types.ts src/tui/state/turn-duration-message.ts src/tui/state/spinner-store.ts src/__tests__/tui/turn-duration-message.test.ts src/__tests__/tui/spinner-store.test.ts
git diff --cached --check
git commit -m "feat: add turn duration message model"
```

---

### Task 2: 独立入队完成消息并保持 stop 幂等

**Files:**
- Modify: `src/tui/state/messages-store.ts:20-82`
- Modify: `src/tui/state/spinner-store.ts:108-188`
- Test: `src/__tests__/tui/messages-store.test.ts`
- Test: `src/__tests__/tui/spinner-store.test.ts`

**Interfaces:**
- Consumes: `createTurnDurationMessage({ uuid, durationMs, prependBlankLine })`。
- Produces: `MessagesState.appendTurnDurationMessage(durationMs)`；`SpinnerState.stop(): { durationMs: number } | null`。

- [ ] **Step 1: 写独立消息、空行去重和禁止续接的失败测试**

```ts
it('appendTurnDurationMessage 始终创建独立消息且只补一个前导空行', () => {
  const store = createMessagesStore();
  store.getState().appendLine('system', LINE('thought for 1s (ctrl+o to expand)'));
  vi.spyOn(Math, 'random').mockReturnValue(0.5);

  store.getState().appendTurnDurationMessage(9_000);

  const messages = store.getState().messages;
  expect(messages).toHaveLength(2);
  expect(messages[1]).toMatchObject({ kind: 'turn-duration', verb: 'Cooked' });
  expect(messages[1]!.lines.map(line => line.content)).toEqual([
    '', '✻ Cooked for 9s',
  ]);

  store.getState().appendLine('system', LINE('next'));
  expect(store.getState().messages).toHaveLength(3);
  expect(store.getState().messages[1]!.lines).toHaveLength(2);
});

it('末行已经为空时不重复添加完成消息前导空行', () => {
  const store = createMessagesStore();
  store.getState().appendMessage('assistant', [LINE('● answer'), LINE('')]);
  store.getState().appendTurnDurationMessage(1_000);
  expect(store.getState().messages.at(-1)!.lines[0]!.content).toBe('✻ Baked for 1s');
});
```

第二个测试在 `beforeEach` 中固定 `Math.random()` 为 `0`，并在 `afterEach` 恢复 mock。

- [ ] **Step 2: 写 stop 不抽动词且重复 stop 返回 null 的失败测试**

```ts
it('stop 只返回有效时长，完成动词由消息工厂负责且重复 stop 幂等', () => {
  const random = vi.spyOn(Math, 'random');
  const store = createSpinnerStore();
  store.getState().start('responding');
  const callsAfterStart = random.mock.calls.length;
  vi.advanceTimersByTime(2_000);

  expect(store.getState().stop()).toEqual({ durationMs: 2_000 });
  expect(store.getState().stop()).toBeNull();
  expect(random).toHaveBeenCalledTimes(callsAfterStart);
});
```

- [ ] **Step 3: 运行两个测试文件并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/messages-store.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose`

Expected: FAIL，分别缺少 `appendTurnDurationMessage`，且 stop 仍返回 `verb`/调用随机源。

- [ ] **Step 4: 在消息 Store 中实现独立追加**

接口增加：

```ts
appendTurnDurationMessage: (durationMs: number) => void;
```

Store 实现：

```ts
appendTurnDurationMessage: (durationMs) => set((s) => {
  const lastLine = [...s.messages].reverse()
    .find(message => message.lines.length > 0)?.lines.at(-1);
  const id = s._idCounter + 1;
  const message = createTurnDurationMessage({
    uuid: `msg-${id}`,
    durationMs,
    prependBlankLine: Boolean(lastLine && lastLine.content !== ''),
  });
  return { _idCounter: id, messages: [...s.messages, message] };
}),
```

同时把 `appendLine` 的续接条件收紧为：

```ts
if (last && last.role === role && last.finalized && last.kind === undefined) {
```

- [ ] **Step 5: 收窄 Spinner stop 结果**

```ts
export interface SpinnerCompletion { durationMs: number; }

stop: () => {
  const current = get();
  if (!current.active) return null;
  const durationMs = spinnerElapsedTime(
    Date.now(), current.loadingStartTime,
    current.totalPausedMs, current.pauseStartTime,
  );
  set({
    active: false, time: 0, verb: '', label: '', thinkStartTime: null,
    thinkingSummary: null, stalled: false, stalledIntensity: 0,
    hasActiveTools: false, responseLength: 0, displayedTokens: 0,
    teammateTokens: 0, totalPausedMs: 0, pauseStartTime: null,
  });
  return { durationMs };
},
```

- [ ] **Step 6: 运行测试并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/messages-store.test.ts src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/turn-duration-message.test.ts --reporter=verbose`

Expected: 全部 PASS，且无 warning。

- [ ] **Step 7: 提交消息账本和 stop 契约**

```powershell
git add src/tui/state/messages-store.ts src/tui/state/spinner-store.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/spinner-store.test.ts
git diff --cached --check
git commit -m "feat: append spinner completion as a distinct message"
```

---

### Task 3: 集中 turn 结束顺序

**Files:**
- Modify: `src/tui/bootstrap.tsx:73-122,217-250`
- Modify: `src/index.ts:623-639,769-786`
- Test: `src/__tests__/tui/bootstrap-spinner-completion.test.ts`
- Test: `src/__tests__/tui/pipeline-integration.test.ts`

**Interfaces:**
- Consumes: `spinnerStore.stop()`、`messagesStore.appendTurnDurationMessage()`、`BlockPipeline.emit(thinking_end)`。
- Produces: `stopSpinnerAndAppendCompletion(spinnerStore, messagesStore): void`；BootstrapHandle 的 `stopSpinner()` 保持外部签名不变。

- [ ] **Step 1: 写 Thinking 摘要先于独立完成消息的失败测试**

```ts
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { stopSpinnerAndAppendCompletion } from '../../tui/bootstrap.js';

it('按 Thinking 摘要、空行、dim 完成消息顺序固化且重复 stop 不追加', () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  const messagesStore = createMessagesStore();
  const pipeline = new BlockPipeline(new PipelineToStoreAdapter(messagesStore));
  const spinnerStore = createSpinnerStore();

  spinnerStore.getState().start('thinking');
  pipeline.emit({ kind: 'thinking_start' });
  pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
  vi.setSystemTime(9_000);
  stopSpinnerAndAppendCompletion(spinnerStore, messagesStore);
  stopSpinnerAndAppendCompletion(spinnerStore, messagesStore);

  const messages = messagesStore.getState().messages;
  const completion = messages.filter(m => m.kind === 'turn-duration');
  expect(completion).toHaveLength(1);
  expect(completion[0]!.lines.map(line => line.content)).toEqual([
    '', '✻ Cooked for 9s',
  ]);
  const allLines = messages.flatMap(message => message.lines);
  expect(allLines.findIndex(line => line.content.includes('thought for 1s')))
    .toBeLessThan(allLines.findIndex(line => line.content === '✻ Cooked for 9s'));
  expect(completion[0]!.lines[1]!.style).toMatchObject({ dim: true });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/bootstrap-spinner-completion.test.ts --reporter=verbose`

Expected: FAIL，原因是新 helper 尚不存在，或旧路径仍通过 `appendLine('system')` 合并消息。

- [ ] **Step 3: 实现唯一 stop helper 并接回 BootstrapHandle**

```ts
export function stopSpinnerAndAppendCompletion(
  spinnerStore: SpinnerStore,
  messagesStore: ReturnType<typeof createMessagesStore>,
): void {
  const completion = spinnerStore.getState().stop();
  if (completion) {
    messagesStore.getState().appendTurnDurationMessage(completion.durationMs);
  }
}
```

删除旧 `appendSpinnerCompletionMessage()` 和 `formatSpinnerDuration` 导入；handle 改为：

```ts
stopSpinner: () => {
  stopSpinnerAndAppendCompletion(spinnerStore, messagesStore);
},
```

- [ ] **Step 4: 把 index 生命周期改为 finally 唯一 stop**

`eventBus.onLoopEnd` 只清工具状态：

```ts
eventBus.onLoopEnd(() => {
  activeToolIds.clear();
  tuiHandle?.setSpinnerHasActiveTools(false);
});
```

`finally` 先固化 Thinking，再 stop：

```ts
} finally {
  activeToolIds.clear();
  tuiHandle?.setSpinnerHasActiveTools(false);
  if (thinkingActive || thinkingContent) {
    const elapsed = Math.floor((Date.now() - thinkingStart) / 1000);
    pipeline.emit({ kind: 'thinking_end', durationSec: elapsed, filesRead: 0 });
    thinkingContent = '';
    thinkingActive = false;
  }
  tuiHandle?.stopSpinner();
  isProcessing = false;
  currentAbortController = null;
  lastSubmittedAgentText = null;
  printLine('');
}
```

- [ ] **Step 5: 运行生命周期和消息集成测试并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/bootstrap-spinner-completion.test.ts src/__tests__/tui/pipeline-integration.test.ts src/__tests__/ui/thinking-stream.test.ts --reporter=verbose`

Expected: 全部 PASS；专用完成消息数量为 1，Thinking 摘要索引更小。

- [ ] **Step 6: 提交结束生命周期**

```powershell
git add src/tui/bootstrap.tsx src/index.ts src/__tests__/tui/bootstrap-spinner-completion.test.ts src/__tests__/tui/pipeline-integration.test.ts
git diff --cached --check
git commit -m "fix: finalize thinking before spinner completion"
```

---

### Task 4: 建立原子上下文和共享 SpinnerView

**Files:**
- Create: `src/tui/state/spinner-view.ts`
- Modify: `src/tui/state/spinner-store.ts:108-285`
- Test: `src/__tests__/tui/spinner-view.test.ts`
- Test: `src/__tests__/tui/spinner-store.test.ts`

**Interfaces:**
- Consumes: `SpinnerState` 的现有动画字段和统一有效 `time`。
- Produces: `SpinnerVariant`、`SpinnerContextSnapshot`、`SpinnerView`、`selectSpinnerTip()`、`selectSpinnerView()`、`SpinnerState.setContext()`。

- [ ] **Step 1: 写上下文复制与文本规范化的失败测试**

```ts
it('setContext 原子复制数组并把空白可选文本规范化为 null', () => {
  const teammates = [{ name: 'alice', role: 'coder', status: 'working' as const }];
  const tasks = [{
    id: '1', content: 'Ship', status: 'pending' as const,
    owner: null, activeForm: null, blockedBy: [] as string[],
  }];
  const store = createSpinnerStore();

  store.getState().setContext({
    variant: 'normal', teammates, tasks, spinnerTip: '  custom tip  ',
    hasUsedBtw: false, budgetText: '   ', nextTaskText: null,
  });
  teammates[0]!.name = 'mutated';
  tasks[0]!.blockedBy.push('x');

  expect(store.getState().context).toEqual({
    variant: 'normal',
    teammates: [{ name: 'alice', role: 'coder', status: 'working' }],
    tasks: [{
      id: '1', content: 'Ship', status: 'pending',
      owner: null, activeForm: null, blockedBy: [],
    }],
    spinnerTip: 'custom tip', hasUsedBtw: false,
    budgetText: null, nextTaskText: null,
  });
});
```

- [ ] **Step 2: 写 normal/brief、活动区优先级和 Tip 阈值的失败测试**

```ts
const baseContext: SpinnerContextSnapshot = {
  variant: 'normal',
  teammates: [],
  tasks: [],
  spinnerTip: 'custom tip',
  hasUsedBtw: false,
  budgetText: null,
  nextTaskText: null,
};

it('inactive 为零行，brief 只有主行', () => {
  const store = createSpinnerStore();
  expect(selectSpinnerView(store.getState()).rowCount).toBe(0);
  store.getState().setContext({ ...baseContext, variant: 'brief' });
  store.getState().start('responding');
  const view = selectSpinnerView(store.getState());
  expect(view.rowCount).toBe(1);
  expect(view.auxiliaryLines).toEqual([]);
});

it('normal 优先展示非 shutdown teammate，否则回退未完成 task', () => {
  const store = createSpinnerStore();
  store.getState().setContext({
    ...baseContext,
    teammates: [
      { name: 'alice', role: 'coder', status: 'working' },
      { name: 'gone', role: 'coder', status: 'shutdown' },
    ],
    tasks: [{
      id: '1', content: 'Ship', status: 'pending', owner: null,
      activeForm: null, blockedBy: [],
    }],
  });
  store.getState().start('responding');
  expect(selectSpinnerView(store.getState()).auxiliaryLines
    .filter(line => line.kind === 'teammate').map(line => line.content))
    .toEqual(['  └─ alice (coder) · working']);

  store.getState().setContext({
    ...baseContext,
    tasks: [
      { id: '1', content: 'Ship', status: 'in_progress', owner: 'alice', activeForm: 'Shipping', blockedBy: [] },
      { id: '2', content: 'Done', status: 'completed', owner: null, activeForm: null, blockedBy: [] },
    ],
  });
  expect(selectSpinnerView(store.getState()).auxiliaryLines[0]!.content)
    .toBe('  [>] Ship · Shipping @alice');
});

it('Tip 按 30m、30s、自定义文本优先级决策', () => {
  expect(selectSpinnerTip(29_000, baseContext)).toBe('custom tip');
  expect(selectSpinnerTip(30_000, baseContext))
    .toBe('Tip: Use /btw to ask a quick side question...');
  expect(selectSpinnerTip(30_000, { ...baseContext, hasUsedBtw: true }))
    .toBe('custom tip');
  expect(selectSpinnerTip(1_800_000, { ...baseContext, hasUsedBtw: true }))
    .toBe('Use /clear to start fresh when switching topics...');
});
```

- [ ] **Step 3: 运行 View 和 Store 测试并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose`

Expected: FAIL，缺少上下文类型、`setContext()` 和 `spinner-view.js`。

- [ ] **Step 4: 在 Store 中增加精确上下文契约**

```ts
export type SpinnerVariant = 'normal' | 'brief';

export interface SpinnerTeammate {
  name: string;
  role: string;
  status: 'idle' | 'working' | 'shutdown';
}

export interface SpinnerTask {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  owner: string | null;
  activeForm: string | null;
  blockedBy: readonly string[];
}

export interface SpinnerContextSnapshot {
  variant: SpinnerVariant;
  teammates: readonly SpinnerTeammate[];
  tasks: readonly SpinnerTask[];
  spinnerTip: string | null;
  hasUsedBtw: boolean;
  budgetText: string | null;
  nextTaskText: string | null;
}

export const EMPTY_SPINNER_CONTEXT: SpinnerContextSnapshot = Object.freeze({
  variant: 'normal',
  teammates: Object.freeze([]),
  tasks: Object.freeze([]),
  spinnerTip: null,
  hasUsedBtw: false,
  budgetText: null,
  nextTaskText: null,
});
```

`SpinnerState` 增加 `context` 和 `setContext`，默认值为 normal/空数组/null/false。抽出规范化函数，初始化和 setter 共用同一条路径：

```ts
export function normalizeSpinnerContext(
  context: SpinnerContextSnapshot,
): SpinnerContextSnapshot {
  return {
    variant: context.variant,
    teammates: context.teammates.map(member => ({ ...member })),
    tasks: context.tasks.map(task => ({
      ...task,
      blockedBy: [...task.blockedBy],
    })),
    spinnerTip: context.spinnerTip?.trim() || null,
    hasUsedBtw: context.hasUsedBtw,
    budgetText: context.budgetText?.trim() || null,
    nextTaskText: context.nextTaskText?.trim() || null,
  };
}

setContext: (context) => set({ context: normalizeSpinnerContext(context) }),
```

共享 View 的计时显示数量改由 `context.teammates` 中 `status === 'working'` 的成员推导。旧 `activeTeammateCount`/`setActiveTeammateCount` 暂时只为尚未迁移的 Ink、inline 与 Bootstrap 消费者保留，Task 7 完成全部接线后再统一删除，确保每个中间提交都能通过 TypeScript 检查。

- [ ] **Step 5: 实现共享 View 选择器**

```ts
import type { SpinnerState, SpinnerContextSnapshot } from './spinner-store.js';

export type SpinnerAuxiliaryKind =
  | 'teammate'
  | 'task'
  | 'tip'
  | 'budget'
  | 'next-task';

export interface SpinnerAuxiliaryLine {
  kind: SpinnerAuxiliaryKind;
  content: string;
}

export interface SpinnerAnimationView {
  time: number;
  mode: SpinnerState['mode'];
  verb: string;
  label: string;
  thinkStartTime: number | null;
  thinkingEffort: string | null;
  thinkingSummaryDurationMs: number | null;
  stalled: boolean;
  stalledIntensity: number;
  reducedMotion: boolean;
  verbose: boolean;
  activeTeammateCount: number;
  displayedTokens: number;
  teammateTokens: number;
}

export interface SpinnerView {
  active: boolean;
  variant: SpinnerContextSnapshot['variant'];
  animation: SpinnerAnimationView | null;
  auxiliaryLines: readonly SpinnerAuxiliaryLine[];
  rowCount: number;
}

export function selectSpinnerTip(
  time: number,
  context: SpinnerContextSnapshot,
): string | null {
  const elapsedSnapshot = Math.floor(Math.max(0, time) / 1000) * 1000;
  if (elapsedSnapshot >= 1_800_000) {
    return 'Use /clear to start fresh when switching topics...';
  }
  if (elapsedSnapshot >= 30_000 && !context.hasUsedBtw) {
    return 'Tip: Use /btw to ask a quick side question...';
  }
  return context.spinnerTip;
}

export function selectSpinnerView(state: SpinnerState): SpinnerView {
  const { context } = state;
  if (!state.active) {
    return {
      active: false,
      variant: context.variant,
      animation: null,
      auxiliaryLines: [],
      rowCount: 0,
    };
  }

  const workingTeammates = context.teammates.filter(
    member => member.status === 'working',
  ).length;
  const animation: SpinnerAnimationView = {
    time: state.time,
    mode: state.mode,
    verb: state.verb,
    label: state.label,
    thinkStartTime: state.thinkStartTime,
    thinkingEffort: state.thinkingEffort,
    thinkingSummaryDurationMs: state.thinkingSummary?.durationMs ?? null,
    stalled: state.stalled,
    stalledIntensity: state.stalledIntensity,
    reducedMotion: state.reducedMotion,
    verbose: state.verbose,
    activeTeammateCount: workingTeammates,
    displayedTokens: state.displayedTokens,
    teammateTokens: state.teammateTokens,
  };

  if (context.variant === 'brief') {
    return {
      active: true,
      variant: 'brief',
      animation,
      auxiliaryLines: [],
      rowCount: 1,
    };
  }

  const auxiliaryLines: SpinnerAuxiliaryLine[] = [];
  const teammates = context.teammates.filter(
    member => member.status !== 'shutdown',
  );
  if (teammates.length > 0) {
    teammates.forEach((member, index) => {
      const branch = index === teammates.length - 1 ? '└─' : '├─';
      auxiliaryLines.push({
        kind: 'teammate',
        content: `  ${branch} ${member.name} (${member.role}) · ${member.status}`,
      });
    });
  } else {
    context.tasks
      .filter(task => task.status !== 'completed')
      .forEach(task => {
        const marker = task.status === 'in_progress' ? '[>]' : '[ ]';
        const activeForm = task.status === 'in_progress' && task.activeForm
          ? ` · ${task.activeForm}`
          : '';
        const owner = task.owner ? ` @${task.owner}` : '';
        const blocked = task.blockedBy.length > 0
          ? ` (blocked by: ${task.blockedBy.join(', ')})`
          : '';
        auxiliaryLines.push({
          kind: 'task',
          content: `  ${marker} ${task.content}${activeForm}${owner}${blocked}`,
        });
      });
  }

  const tip = selectSpinnerTip(state.time, context);
  if (tip) auxiliaryLines.push({ kind: 'tip', content: tip });
  if (context.budgetText) {
    auxiliaryLines.push({ kind: 'budget', content: context.budgetText });
  }
  if (context.nextTaskText) {
    auxiliaryLines.push({ kind: 'next-task', content: context.nextTaskText });
  }

  return {
    active: true,
    variant: 'normal',
    animation,
    auxiliaryLines,
    rowCount: 1 + auxiliaryLines.length,
  };
}
```

该实现让 brief 立即返回 1 行；normal 依次 push teammate 或 task、Tip、Budget、NextTask。Task 文本固定复用 `[>]`/`[ ]` 标记，completed 不输出。

- [ ] **Step 6: 运行测试并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/spinner-store.test.ts --reporter=verbose`

Expected: 全部 PASS，暂停测试仍证明 `time` 冻结，因此 Tip 阈值也冻结。

- [ ] **Step 7: 提交共享 View**

```powershell
git add src/tui/state/spinner-store.ts src/tui/state/spinner-view.ts src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-view.test.ts
git diff --cached --check
git commit -m "feat: add shared spinner view selector"
```

---

### Task 5: 对齐 Ink 组件树并集中动画时钟

**Files:**
- Create: `src/tui/hooks/useSpinnerClock.ts`
- Create: `src/__tests__/tui/use-spinner-clock.test.tsx`
- Modify: `src/tui/components/Spinner.tsx`
- Modify: `src/tui/components/Footer.tsx`
- Modify: `src/tui/App.tsx`
- Modify: `src/tui/ConnectedApp.tsx`
- Test: `src/__tests__/tui/spinner-component.test.tsx`
- Test: `src/__tests__/tui/spinner-integration.test.tsx`
- Test: `src/__tests__/tui/layout.test.tsx`

**Interfaces:**
- Consumes: `selectSpinnerView(store.getState())`、`SpinnerView.rowCount`、`SpinnerAnimationView`。
- Produces: `useSpinnerClock(store)`、`SpinnerAnimationRow`、`BriefSpinner`、`SpinnerWithVerbInner`、`SpinnerWithVerb`。

- [ ] **Step 1: 写唯一时钟所有权的失败测试**

```tsx
function ClockHarness({ store }: { store: SpinnerStore }): React.ReactElement {
  useSpinnerClock(store);
  return <></>;
}

it('仅 clock owner 在 active 期间推进，inactive 和卸载后停止', () => {
  const store = createSpinnerStore();
  store.getState().start('responding');
  const view = render(<ClockHarness store={store} />);
  vi.advanceTimersByTime(150);
  expect(store.getState().time).toBe(150);
  store.getState().stop();
  vi.advanceTimersByTime(150);
  expect(store.getState().time).toBe(0);
  view.unmount();
});
```

把旧 Spinner 组件定时器测试改为：

```ts
it('纯渲染组件不拥有 interval', () => {
  const store = createSpinnerStore();
  store.getState().start('responding');
  const { unmount } = render(React.createElement(Spinner, { store }));
  vi.advanceTimersByTime(150);
  expect(store.getState().time).toBe(0);
  unmount();
});
```

- [ ] **Step 2: 写 normal/brief 和辅助行顺序的失败测试**

```ts
it('normal 显示暗色辅助内容，brief 只保留动画主行', () => {
  const store = createSpinnerStore();
  store.getState().setContext({
    variant: 'normal',
    teammates: [],
    tasks: [{ id: '1', content: 'Ship', status: 'pending', owner: null, activeForm: null, blockedBy: [] }],
    spinnerTip: 'custom tip', hasUsedBtw: true,
    budgetText: 'Budget: 10m', nextTaskText: 'Next: verify',
  });
  store.getState().start('responding');
  const rendered = render(React.createElement(Spinner, { store }));
  expect(rendered.lastFrame()).toContain('[ ] Ship');
  expect(rendered.lastFrame()).toContain('custom tip');
  expect(rendered.lastFrame()).toContain('Budget: 10m');
  expect(rendered.lastFrame()).toContain('Next: verify');

  store.getState().setContext({ ...store.getState().context, variant: 'brief' });
  rendered.rerender(React.createElement(Spinner, { store }));
  expect(rendered.lastFrame()).not.toContain('[ ] Ship');
  expect(rendered.lastFrame()).not.toContain('custom tip');
});
```

- [ ] **Step 3: 运行组件测试并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/use-spinner-clock.test.tsx src/__tests__/tui/spinner-component.test.tsx --reporter=verbose`

Expected: FAIL，hook 不存在，且旧 `Spinner` 仍自行推进 time。

- [ ] **Step 4: 实现时钟 hook 并只在 ConnectedApp 调用**

```ts
import { useEffect } from 'react';
import { useStore } from 'zustand/react';
import { TICK_MS, type SpinnerStore } from '../state/spinner-store.js';

export function useSpinnerClock(store: SpinnerStore): void {
  const active = useStore(store, state => state.active);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => { store.getState().tick(); }, TICK_MS);
    return () => { clearInterval(id); };
  }, [active, store]);
}
```

在 `ConnectedApp` 所有 early return 之前调用 `useSpinnerClock(spinnerStore)`；从 `Spinner.tsx` 删除 `useEffect` 和 `TICK_MS` interval。

- [ ] **Step 5: 拆分 Ink 组件边界**

```tsx
export function SpinnerAnimationRow({ animation }: {
  animation: SpinnerAnimationView;
}): React.ReactElement {
  const theme = useTheme();
  const displayText = animation.label || animation.verb;
  const messageWidth = measureShimmerMessage(displayText);
  const glimmerIndex = computeGlimmerIndex(animation.time, messageWidth, {
    speed: animation.mode === 'requesting' ? TICK_MS : SHIMMER_SPEED,
    cyclePad: SHIMMER_PAD,
    stalled: animation.stalled,
    direction: animation.mode === 'requesting'
      ? 'left-to-right'
      : 'right-to-left',
  });
  const showMetrics = shouldShowSpinnerTimer(
    animation.time,
    animation.verbose,
    animation.activeTeammateCount,
  );
  const totalTokens = totalSpinnerTokens(
    animation.displayedTokens,
    animation.teammateTokens,
  );
  const tokens = totalTokens > 0
    ? ` ${animation.mode === 'requesting' ? '↑' : '↓'} ${totalTokens}`
    : '';
  const thinkingText = animation.mode === 'thinking'
    ? thinkingStatusText(animation.thinkingEffort)
    : animation.thinkingSummaryDurationMs !== null
      ? thoughtStatusText(animation.thinkingSummaryDurationMs)
      : null;

  return (
    <Text>
      <SpinnerGlyph
        time={animation.time}
        activeColor={theme.spinnerActive}
        stalledIntensity={animation.stalledIntensity}
        reducedMotion={animation.reducedMotion}
      />
      <GlimmerMessage
        message={displayText}
        glimmerIndex={glimmerIndex}
        baseColor={theme.spinnerActive}
        shimmerColor={theme.spinnerShimmer}
        flashOpacity={animation.mode === 'tool-use' && !animation.stalled
          ? toolUseFlashOpacity(animation.time)
          : undefined}
        stalledIntensity={animation.stalledIntensity}
      />
      {thinkingText
        ? <ThinkingIndicator
            storeTime={animation.time}
            thinkStartTime={animation.mode === 'thinking'
              ? animation.thinkStartTime
              : null}
            text={thinkingText}
          />
        : <DotsCycle time={animation.time} color={theme.textMuted} />}
      {showMetrics
        ? <Text color={theme.textMuted}>{`  ${formatSpinnerDuration(animation.time)}${tokens}`}</Text>
        : null}
    </Text>
  );
}

export function BriefSpinner({ animation }: {
  animation: SpinnerAnimationView;
}): React.ReactElement {
  return <SpinnerAnimationRow animation={animation} />;
}

function MutedLine({ line }: {
  line: SpinnerAuxiliaryLine;
}): React.ReactElement {
  const theme = useTheme();
  return <Text color={theme.textMuted} dimColor>{line.content}</Text>;
}

export function TeammateSpinnerTree({ lines }: {
  lines: readonly SpinnerAuxiliaryLine[];
}): React.ReactElement {
  return <>{lines.map((line, index) =>
    <MutedLine key={`teammate-${index}`} line={line} />)}</>;
}

export function TaskListV2({ lines }: {
  lines: readonly SpinnerAuxiliaryLine[];
}): React.ReactElement {
  return <>{lines.map((line, index) =>
    <MutedLine key={`task-${index}`} line={line} />)}</>;
}

export function Tip({ line }: {
  line: SpinnerAuxiliaryLine | undefined;
}): React.ReactElement | null {
  return line ? <MutedLine line={line} /> : null;
}

export function Budget({ line }: {
  line: SpinnerAuxiliaryLine | undefined;
}): React.ReactElement | null {
  return line ? <MutedLine line={line} /> : null;
}

export function NextTask({ line }: {
  line: SpinnerAuxiliaryLine | undefined;
}): React.ReactElement | null {
  return line ? <MutedLine line={line} /> : null;
}

export function SpinnerWithVerbInner({ view }: {
  view: SpinnerView;
}): React.ReactElement {
  const teammates = view.auxiliaryLines.filter(line => line.kind === 'teammate');
  const tasks = view.auxiliaryLines.filter(line => line.kind === 'task');
  const tip = view.auxiliaryLines.find(line => line.kind === 'tip');
  const budget = view.auxiliaryLines.find(line => line.kind === 'budget');
  const nextTask = view.auxiliaryLines.find(line => line.kind === 'next-task');
  return (
    <Box flexDirection="column">
      <SpinnerAnimationRow animation={view.animation!} />
      <TeammateSpinnerTree lines={teammates} />
      <TaskListV2 lines={tasks} />
      <Tip line={tip} />
      <Budget line={budget} />
      <NextTask line={nextTask} />
    </Box>
  );
}

export function SpinnerWithVerb({ view }: { view: SpinnerView }): React.ReactElement | null {
  if (!view.active || !view.animation) return null;
  return view.variant === 'brief'
    ? <BriefSpinner animation={view.animation} />
    : <SpinnerWithVerbInner view={view} />;
}
```

保留兼容入口：

```tsx
export function Spinner({ store }: SpinnerProps): React.ReactElement | null {
  const view = useStore(store, selectSpinnerView);
  return <SpinnerWithVerb view={view} />;
}
```

- [ ] **Step 6: 用同一个 rowCount 修正 Ink 布局**

`App` 订阅 View 并把 `spinnerView.rowCount` 同时用于：

```ts
const spinnerView = useStore(spinnerStore, selectSpinnerView);
const footerRows = FOOTER_ROWS + spinnerView.rowCount + inputViewportExtraLines;
const inputRowY = scrollboxRenderedRows + LOGO_ROWS + spinnerView.rowCount + 1;
```

`Footer` 接收 `spinnerView` 并渲染 `<SpinnerWithVerb view={spinnerView} />`。`ConnectedApp` 的可见区和 `inputRowY` 使用：

```ts
const spinnerRowCount = useStore(spinnerStore, state => selectSpinnerView(state).rowCount);
```

- [ ] **Step 7: 运行 Ink 和时钟测试并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/use-spinner-clock.test.tsx src/__tests__/tui/spinner-component.test.tsx src/__tests__/tui/spinner-integration.test.tsx src/__tests__/tui/layout.test.tsx --reporter=verbose`

Expected: 全部 PASS；纯 Spinner 渲染不推进时间，hook 推进；brief 无辅助行。

- [ ] **Step 8: 提交 Ink 组合和统一时钟**

```powershell
git add src/tui/hooks/useSpinnerClock.ts src/tui/components/Spinner.tsx src/tui/components/Footer.tsx src/tui/App.tsx src/tui/ConnectedApp.tsx src/__tests__/tui/use-spinner-clock.test.tsx src/__tests__/tui/spinner-component.test.tsx src/__tests__/tui/spinner-integration.test.tsx src/__tests__/tui/layout.test.tsx
git diff --cached --check
git commit -m "feat: compose spinner views in ink"
```

---

### Task 6: 把 inline 扩展为共享多行 Spinner

**Files:**
- Modify: `src/tui/inline/SpinnerLine.tsx`
- Modify: `src/tui/inline/InlineApp.tsx`
- Modify: `src/tui/inline/layout.ts:32-46,105-106,190-245`
- Test: `src/__tests__/tui/SpinnerLine.test.tsx`
- Test: `src/tui/inline/layout.test.ts`
- Test: `src/tui/inline/cursor-row-regression.test.ts`
- Test: `src/tui/inline/input-viewport-scroll-regression.test.ts`

**Interfaces:**
- Consumes: `SpinnerView`、现有 `buildSpinnerLine()`、`computeSpinnerVisible()`、`slice-ansi`。
- Produces: `buildSpinnerLines(view, cols)`；`FooterInput.spinnerLines?: readonly string[]`。

- [ ] **Step 1: 写共享 View 到 ANSI 多行的失败测试**

```ts
it('normal 输出主行和按顺序 dim 的辅助行，brief 只输出主行', () => {
  const store = createSpinnerStore();
  store.getState().setContext({
    variant: 'normal', teammates: [], tasks: [],
    spinnerTip: 'tip', hasUsedBtw: true,
    budgetText: 'budget', nextTaskText: 'next',
  });
  store.getState().start('responding');
  const normal = buildSpinnerLines(selectSpinnerView(store.getState()), 80, THEME);
  expect(normal).toHaveLength(4);
  expect(stripAnsi(normal[1]!)).toBe('tip');
  expect(stripAnsi(normal[2]!)).toBe('budget');
  expect(stripAnsi(normal[3]!)).toBe('next');
  expect(normal.slice(1).every(line => line.includes('\x1b[2m'))).toBe(true);

  store.getState().setContext({ ...store.getState().context, variant: 'brief' });
  expect(buildSpinnerLines(selectSpinnerView(store.getState()), 80, THEME)).toHaveLength(1);
});

it('所有 inline Spinner 行截断到 usable width', () => {
  const store = createSpinnerStore();
  store.getState().setContext({
    variant: 'normal', teammates: [], tasks: [],
    spinnerTip: 'x'.repeat(100), hasUsedBtw: true,
    budgetText: null, nextTaskText: null,
  });
  store.getState().start('responding');

  const lines = buildSpinnerLines(selectSpinnerView(store.getState()), 20, THEME);

  expect(lines).toHaveLength(2);
  expect(lines.every(line => stringWidth(stripAnsi(line)) <= 19)).toBe(true);
});
```

- [ ] **Step 2: 写动态 Footer 行数和光标坐标的失败测试**

```ts
it('spinnerLines 动态占用间隔行加实际行数', () => {
  const layout = layoutFooter(makeFooterInput({ spinnerLines: ['main', 'tip', 'next'] }));
  expect(layout.lines.slice(0, 4)).toEqual(['', 'main', 'tip', 'next']);
  expect(layout.cursorToTop).toBe(5); // 1 间隔 + 3 spinner + 1 border
  expect(layout.height).toBe(8);      // 上述 4 + border/input/border/status
});

it('无 spinnerLines 时只保留现有单个间隔行', () => {
  const layout = layoutFooter(makeFooterInput({ spinnerLines: [] }));
  expect(layout.lines[0]).toBe('');
  expect(layout.cursorToTop).toBe(2);
});
```

- [ ] **Step 3: 运行 inline 单元测试并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/SpinnerLine.test.tsx src/tui/inline/layout.test.ts --reporter=verbose`

Expected: FAIL，缺少 `buildSpinnerLines` 和 `spinnerLines`；旧布局只接受单行。

- [ ] **Step 4: 实现 ANSI 多行构建器**

在 `SpinnerLine.tsx` 导出 `SpinnerLineOpts`，并新增：

```ts
export function buildSpinnerLines(
  view: SpinnerView,
  cols: number,
  theme: SpinnerTheme = spinnerThemeFrom(getTheme()),
): string[] {
  if (!view.active || !view.animation) return [];
  const usableWidth = getUsableWidth(cols);
  const main = buildSpinnerLine({ ...view.animation, theme });
  const muted = toAnsiColor(theme.muted);
  const auxiliary = view.auxiliaryLines.map(line =>
    `${muted}\x1b[2m${sliceAnsi(line.content, 0, usableWidth)}${RESET}`
  );
  return [main, ...auxiliary].map(line => sliceAnsi(line, 0, usableWidth));
}
```

同时导入 `Theme` 并补齐默认主题转换，避免 InlineApp 重复组装色槽：

```ts
function spinnerThemeFrom(theme: Theme): SpinnerTheme {
  return {
    active: theme.spinnerActive,
    shimmer: theme.spinnerShimmer,
    stalled: theme.spinnerStalled,
    muted: theme.textMuted,
  };
}
```

把 `parseRGB()` 的表达式改为允许 `rgb()` 逗号两侧空格：

```ts
const match = color.match(
  /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/,
);
```

对应测试增加 `rgb(100, 200, 240)` 输入，断言输出仍含 `38;2;100;200;240m`。同时把旧测试中的非契约 mode `generating`/`tool` 改为 `responding`/`tool-use`。

保持 stalled、tool-use、thinking、timer/token 的现有主行实现不变。

- [ ] **Step 5: 把 layoutFooter 改成数组契约**

```ts
spinnerLines?: readonly string[];
```

组装和坐标只使用一份计数：

```ts
const visibleSpinnerLines = spinnerLines ?? [];
const lines: string[] = ['', ...visibleSpinnerLines, border];
const reserveRows = 1 + visibleSpinnerLines.length;
let cursorPhysLine0 = reserveRows + 1;
```

Select 分支保持原样并继续完全替换 Footer。

- [ ] **Step 6: InlineApp 删除重复构建器和本地 interval**

删除 `SpinnerSnapshot`、内部 `buildSpinnerLine()` 及其只服务于该函数的动画导入；订阅共享 View：

```ts
const spinnerView = useStore(spinnerStore, selectSpinnerView);
```

保留 `computeSpinnerVisible()` 守卫，然后：

```ts
const spinnerLines = spinnerVisible
  ? buildSpinnerLines(spinnerView, cols)
  : [];

const footerLayout = layoutFooter({
  input: inputText, cursor, status: statusText, cols, rows,
  suggestions, dropdownIndex, viewportTop: vp.viewportTop,
  spinnerLines,
  selectView,
});
```

删除 InlineApp 的 `setInterval()` effect；时钟只由 `ConnectedApp/useSpinnerClock` 推进。

- [ ] **Step 7: 运行 inline 单元与光标回归并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/SpinnerLine.test.tsx src/tui/inline/layout.test.ts src/tui/inline/cursor-row-regression.test.ts src/tui/inline/input-viewport-scroll-regression.test.ts --reporter=verbose`

Expected: 全部 PASS；三条 Spinner 行时 `cursorToTop` 比无 Spinner 多 3。

- [ ] **Step 8: 提交 inline 多行布局**

```powershell
git add src/tui/inline/SpinnerLine.tsx src/tui/inline/InlineApp.tsx src/tui/inline/layout.ts src/__tests__/tui/SpinnerLine.test.tsx src/tui/inline/layout.test.ts src/tui/inline/cursor-row-regression.test.ts src/tui/inline/input-viewport-scroll-regression.test.ts
git diff --cached --check
git commit -m "feat: render shared spinner lines inline"
```

---

### Task 7: 接入 Teammate/Todo 快照和 Bootstrap 上下文 API

**Files:**
- Modify: `src/tui/bootstrap.tsx:44-105,124-139,217-250`
- Modify: `src/index.ts:117-130,630-660,818-838`
- Test: `src/__tests__/tui/spinner-store.test.ts`
- Test: `src/__tests__/tui/spinner-view.test.ts`

**Interfaces:**
- Consumes: `TeammateManager.list()`、`TodoManager.getItems()`、`SpinnerState.setContext()`。
- Produces: `BootstrapOptions.spinnerContext?`、`BootstrapHandle.setSpinnerContext(snapshot)`、`refreshSpinnerContext()`。

- [ ] **Step 1: 写初始化上下文与运行时替换的失败测试**

在 Store 测试中增加：

```ts
it('createSpinnerStore 接受初始上下文并允许后续原子替换', () => {
  const initial = { ...EMPTY_SPINNER_CONTEXT, variant: 'brief' as const };
  const store = createSpinnerStore(undefined, initial);
  expect(store.getState().context.variant).toBe('brief');
  store.getState().setContext({ ...initial, variant: 'normal' });
  expect(store.getState().context.variant).toBe('normal');
});
```

- [ ] **Step 2: 运行 Store 测试并确认 RED**

Run: `npx.cmd vitest run src/__tests__/tui/spinner-store.test.ts --reporter=verbose`

Expected: FAIL，`createSpinnerStore` 尚不接受第二个参数。

- [ ] **Step 3: 扩展 Store 和 Bootstrap 精确接口**

```ts
export function createSpinnerStore(
  verbConfig?: SpinnerVerbConfig,
  initialContext: SpinnerContextSnapshot = EMPTY_SPINNER_CONTEXT,
): SpinnerStore
```

Store 初始对象使用 `context: normalizeSpinnerContext(initialContext)`，禁止直接保存调用方引用。

Bootstrap 增加：

```ts
spinnerContext?: SpinnerContextSnapshot;
```

```ts
setSpinnerContext: (snapshot: SpinnerContextSnapshot) => void;
```

创建 Store 时传 `opts.spinnerContext`，handle setter 只调用 `spinnerStore.getState().setContext(snapshot)`。删除旧 `setSpinnerActiveTeammates()`。

- [ ] **Step 4: 在 index 中集中构建真实快照**

```ts
function readSpinnerContext(
  fallback: SpinnerContextSnapshot,
): SpinnerContextSnapshot {
  try {
    return {
      variant: 'normal',
      teammates: teammateManager.list().map(member => ({ ...member })),
      tasks: todoManager.getItems().map(item => ({
        id: item.id,
        content: item.content,
        status: item.status,
        owner: item.owner ?? null,
        activeForm: item.activeForm ?? null,
        blockedBy: [...(item.blockedBy ?? [])],
      })),
      spinnerTip: null,
      hasUsedBtw: false,
      budgetText: null,
      nextTaskText: null,
    };
  } catch {
    return fallback;
  }
}

function refreshSpinnerContext(): void {
  if (!tuiHandle) return;
  const previous = tuiHandle.spinnerStore.getState().context;
  tuiHandle.setSpinnerContext(readSpinnerContext(previous));
}
```

`bootstrap()` 初始化传 `spinnerContext: readSpinnerContext(EMPTY_SPINNER_CONTEXT)`；每个 turn 的 `startSpinner()` 前以及 `eventBus.onToolResult` 完成 pipeline emit 后调用 `refreshSpinnerContext()`。不增加 interval 或 manager 订阅。

- [ ] **Step 5: 运行数据层和相关 manager 测试并确认 GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-view.test.ts src/__tests__/team.test.ts src/__tests__/todo.test.ts --reporter=verbose`

Expected: 全部 PASS；shutdown/completed 过滤仍由 View 测试保护。

- [ ] **Step 6: 提交运行时上下文桥接**

```powershell
git add src/tui/state/spinner-store.ts src/tui/bootstrap.tsx src/index.ts src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-view.test.ts
git diff --cached --check
git commit -m "feat: bridge runtime data into spinner context"
```

---

### Task 8: 修复直接相关 Footer 契约并验证滚动链路

**Files:**
- Modify: `src/tui/inline/cursor-drift-regression.test.ts`
- Modify: `src/tui/inline/cursor-row-regression.test.ts`
- Modify: `src/tui/inline/input-viewport-scroll-regression.test.ts`
- Modify: `src/tui/inline/logo-regression.test.ts`
- Modify: `src/tui/inline/physical-line-footer-regression.test.ts`
- Modify: 其余失败且仍写死“无 Spinner 两个预留位”的直接相关 Footer 测试
- Modify: `src/__tests__/tui/bootstrap-spinner-completion.test.ts`
- Modify: `src/__tests__/tui/selection/flatten-messages.test.ts`

**Interfaces:**
- Consumes: `SystemTurnDurationMessage` 仍满足 `TuiMessage`；`layoutFooter().height/cursorToTop`。
- Produces: 完成消息进入 Ink flatten 和 inline finalized ledger 的回归证据。

- [ ] **Step 1: 运行受影响布局集合并记录真实 RED**

Run: `npx.cmd vitest run src/tui/inline/footer-regression.test.ts src/tui/inline/physical-line-footer-regression.test.ts src/tui/inline/cursor-drift-regression.test.ts src/tui/inline/cursor-row-regression.test.ts src/tui/inline/input-viewport-scroll-regression.test.ts src/tui/inline/logo-regression.test.ts src/tui/inline/layout.test.ts --reporter=verbose`

Expected: 只允许出现由旧固定两行假设导致的坐标/高度断言失败；若出现内容丢失或 ANSI 崩坏，先停在该测试定位生产代码。

- [ ] **Step 2: 按公式更新直接相关断言**

所有测试改用同一公式，避免新的魔数：

```ts
const spinnerLines = ['main', 'tip'];
const reserveRows = 1 + spinnerLines.length;
const expectedCursorToTop = reserveRows + 1 + cursorViewportLine;
```

无 Spinner 时 `reserveRows = 1`；一条主行时 `reserveRows = 2`。只修改与新契约直接冲突的注释和断言，不改状态栏 ANSI 测试。

- [ ] **Step 3: 增加完成消息进入普通 flatten 列表的测试**

```ts
it('turn-duration 消息按普通固化行进入滚动列表', () => {
  const message = createTurnDurationMessage({
    uuid: 'duration-1', durationMs: 9_000,
    prependBlankLine: true, random: () => 0.5,
  });
  const flat = flattenMessages([message]);
  expect(flat.map(line => line.line.content)).toEqual(['', '✻ Cooked for 9s']);
});
```

- [ ] **Step 4: 增加 inline finalized ledger 的完成消息测试**

在 `src/tui/inline/layout.test.ts` 导入 `layoutFrame`、`InlineRenderState`、`createTurnDurationMessage`，增加：

```ts
it('turn-duration 首帧进入 newLines，下一帧账本阻止重复追加', () => {
  const state = new InlineRenderState();
  const message = createTurnDurationMessage({
    uuid: 'duration-1', durationMs: 9_000,
    prependBlankLine: true, random: () => 0.5,
  });
  const input = {
    messages: [message],
    streamingMsg: null,
    footer: makeFooterInput(),
    cols: 80,
    state,
  };

  const first = layoutFrame(input);
  const second = layoutFrame(input);

  expect(first.newLines.map(stripAnsi)).toEqual(['', '✻ Cooked for 9s']);
  expect(second.newLines).toEqual([]);
});
```

- [ ] **Step 5: 运行布局与滚动回归并确认 GREEN**

Run: `npx.cmd vitest run src/tui/inline/ src/__tests__/tui/selection/flatten-messages.test.ts src/__tests__/tui/bootstrap-spinner-completion.test.ts --reporter=dot`

Expected: 直接相关 inline、flatten 和 completion 测试全部 PASS；若状态栏两条既有 ANSI 断言仍失败，记录为既有无关失败，不修改其生产逻辑。

- [ ] **Step 6: 提交布局和滚动回归**

```powershell
git add src/tui/inline src/__tests__/tui/selection/flatten-messages.test.ts src/__tests__/tui/bootstrap-spinner-completion.test.ts
git diff --cached --check
git commit -m "test: cover dynamic spinner footer rows"
```

---

### Task 9: 分层验证、日志和任务收口

**Files:**
- Create: `logs/2026-07-18-spinner-completion-composition.md`
- Modify: `to-do-list.md:43-104,116-129`
- Inspect: 所有本计划修改文件

**Interfaces:**
- Consumes: 前八个任务的提交和测试证据。
- Produces: 可复查验证日志、准确 todo 状态、最终提交。

- [ ] **Step 1: 运行 L1/L2 相关测试集合**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/turn-duration-message.test.ts src/__tests__/tui/messages-store.test.ts src/__tests__/tui/spinner-store.test.ts src/__tests__/tui/spinner-view.test.ts src/__tests__/tui/use-spinner-clock.test.tsx src/__tests__/tui/spinner-component.test.tsx src/__tests__/tui/spinner-integration.test.tsx src/__tests__/tui/SpinnerLine.test.tsx src/__tests__/tui/bootstrap-spinner-completion.test.ts src/__tests__/tui/pipeline-integration.test.ts src/tui/inline/ --reporter=dot
```

Expected: 所列测试全部 PASS，0 failed。

- [ ] **Step 2: 运行静态检查**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: 两条命令 exit code 0；无 unused、floating promise 或 ESLint error。

- [ ] **Step 3: 运行全量测试**

Run: `npm.cmd test -- --reporter=dot`

Expected: 理想结果为全绿。若仍有失败，逐条与计划前基线和设计文档中的已知失败比对；任何本次相关失败必须修复后重跑，不能以“既有失败”跳过。

- [ ] **Step 4: 写只包含证据的验证日志**

日志固定使用以下标题，并在每项下面粘贴本次实际命令、exit code、Vitest 文件/测试计数和首个关键错误或通过摘要：

```md
# Spinner completion/composition verification — 2026-07-18

## TDD evidence

### Turn duration message RED

### SpinnerView RED

### Inline spinnerLines RED

## Verification

### Focused tests

### TypeScript

### ESLint

### Full suite

## Failure classification
```

没有失败时在最后一节写 `none`；有失败时只记录已用独立命令复现并确认与本次改动无关的条目，不得写推测结论。

- [ ] **Step 5: 仅在门禁通过后更新任务状态**

在 `to-do-list.md` 中：

- AUTO-0020、AUTO-0021、AUTO-0022 在对应功能和相关测试通过后移到已完成。
- AUTO-0023 在新增单元、集成、inline/Ink 回归全部通过后完成。
- AUTO-0024 在 typecheck、lint 和最终验证日志完成后完成。
- AUTO-0009 仅在 AUTO-0010～AUTO-0024 全部满足时完成。
- 日志表追加一行实际完成记录，不改写历史记录。

- [ ] **Step 6: 检查变更范围和提交收口**

Run:

```powershell
git status --short
git diff --check
git diff --stat HEAD
```

Expected: 无空白错误；每个生产改动都能映射到本计划要求；无无关状态栏或 TUI 重构。

Commit:

```powershell
git add logs/2026-07-18-spinner-completion-composition.md to-do-list.md
git diff --cached --check
git commit -m "docs: record spinner completion verification"
```

- [ ] **Step 7: 按完成工作流做最终审查**

依次使用 `superpowers:requesting-code-review`、`superpowers:verification-before-completion` 和 `superpowers:finishing-a-development-branch`。任何 CRITICAL 正确性、布局或生命周期问题都会阻止完成声明。
