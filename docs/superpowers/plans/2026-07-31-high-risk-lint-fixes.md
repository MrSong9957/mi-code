# High-Risk Lint Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复当前 lint 清单中具有实际运行风险或可机械消除的第一波 9 个 error，然后停止 lint 清理并转向测试循环工作。

**Architecture:** 不追求仓库 lint 全绿。唯一行为性修改是让 `ConnectedApp` 始终以固定顺序调用 Ink/React Hooks，并通过 `isActive` 和 effect 内部 guard 控制 alt-screen 行为；其余修改保持运行语义不变。`TOOL_CALL` 与 `TOOL_RESULT` 继续共享优先级 `3`，用行为测试和局部 suppression 明确这是设计决策。

**Tech Stack:** TypeScript、React、Ink、Vitest、ESLint 9、PowerShell、npm

## Global Constraints

- 从干净的 `master` 创建隔离 worktree 和 `codex/high-risk-lint-fixes` 分支；不要在当前带用户改动的工作区直接执行。
- 不修改 `src/prompts/planner.generated.ts`、`src/prompts/system.generated.ts`、`src/prompts/system.md` 或 `ai-news-2026-07.html`。
- 本计划只处理 9 个已列明的 lint error；不顺手处理 `any`、其他 unused、ANSI/NUL regex、无效 disable 或生成文件可复现性。
- 不新增依赖；本轮不安装 `eslint-plugin-react-hooks`。通过消除条件 Hook 和移除三条无效 suppression 修复实际风险。
- 行为修改遵循 TDD。纯 lint 修改以“现有行为测试通过 + 定向 ESLint 先失败”为 RED 证据。
- 不改变 inline 模式的终端原生选区行为；inline 模式不得启用 SGR mouse tracking 或切换 raw mode。
- alt-screen 模式继续启用 `?1003h`、`?1006h` 和 raw mode，并在退出该模式或卸载时关闭它们。
- `MessagePriority.TOOL_CALL` 和 `MessagePriority.TOOL_RESULT` 必须继续相等，且同优先级消息保持 FIFO。
- 每个任务独立提交；不要把第二波 cleanup 混入提交。

## Baseline and Success Criteria

当前基线：

```text
npm run lint
72 errors
105 warnings
```

本计划完成后：

```text
第一波涉及文件运行 eslint --quiet：0 errors
仓库全量 lint：预期仍有 63 errors，允许失败
npm run typecheck：通过
npm test：通过
```

全量 lint 剩余 63 个 error 属于第二波，不是本计划失败。

---

### Task 1: 消除 `ConnectedApp` 条件 Hook

**Files:**
- Create: `src/__tests__/tui/connected-app-render-mode-transition.test.tsx`
- Modify: `src/tui/ConnectedApp.tsx:329-355`

**Interfaces:**
- Consumes: `useRenderMode(): { mode, setMode }`、Ink `useInput(handler, { isActive })`、`useStdin()`
- Produces: 固定 Hook 调用顺序；inline 与 alt-screen 之间切换时不触发 React Hook-order 异常

- [ ] **Step 1: 创建动态 render-mode 回归测试**

在新测试中复用 `connected-app-spinner-clock.test.tsx` 的 store 装配方式，并加入一个捕获 `setMode` 的控制组件：

```tsx
import React, { act } from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ConnectedApp } from '../../tui/ConnectedApp.js';
import {
  RenderModeProvider,
  useRenderMode,
  type RenderMode,
} from '../../tui/state/render-mode.js';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { createInputStore } from '../../tui/state/input-store.js';
import { createLogoStore } from '../../tui/state/logo-store.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';
import { createAskQuestionStore } from '../../tui/state/ask-question-store.js';
import { createSelectStore } from '../../tui/state/select-store.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { createStatusStore } from '../../tui/state/status-store.js';
import { createClearScreenStore } from '../../tui/state/clear-screen-store.js';

let switchMode: ((mode: RenderMode) => void) | undefined;

function ModeControl(): null {
  switchMode = useRenderMode().setMode;
  return null;
}

function TestTree(): React.ReactElement {
  return (
    <RenderModeProvider initialMode="inline">
      <ModeControl />
      <ConnectedApp
        messagesStore={createMessagesStore()}
        inputStore={createInputStore()}
        statusStore={createStatusStore({
          mode: 'chat',
          model: 'test',
          dir: '/tmp',
          branch: 'main',
        })}
        logoStore={createLogoStore({ version: '0.0.0', dir: '/tmp' })}
        spinnerStore={createSpinnerStore()}
        completionStore={createCompletionStore()}
        selectStore={createSelectStore()}
        overlayStore={createOverlayStore()}
        askQuestionStore={createAskQuestionStore()}
        clearScreenStore={createClearScreenStore()}
        onExit={() => {}}
      />
    </RenderModeProvider>
  );
}

describe('ConnectedApp render-mode transition', () => {
  it('switches inline -> alt-screen -> inline without changing hook order', () => {
    const view = render(<TestTree />);
    expect(switchMode).toBeTypeOf('function');

    expect(() => {
      act(() => switchMode?.('alt-screen'));
      act(() => switchMode?.('inline'));
    }).not.toThrow();

    view.unmount();
  });
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/connected-app-render-mode-transition.test.tsx
```

Expected: FAIL，错误包含 `Rendered more hooks than during the previous render`、`Rendered fewer hooks than expected` 或等价 Hook-order 诊断。

如果测试因 fixture/TTY 装配而失败，先修 fixture，直到失败原因明确是 Hook 顺序；禁止用捕获所有异常的宽泛断言制造假 RED。

- [ ] **Step 3: 无条件调用三个 Hook，用开关控制副作用**

把 `if (!isInline) { ... }` 改为固定 Hook 顺序：

```tsx
useInput(
  (input: string) => {
    if (!SGR_FRAGMENT_RE.test(input)) return;
    const events = parserRef.current.feed('\x1b' + input);
    for (const ev of events) {
      routeMouseEvent(ev);
    }
  },
  { isActive: !isInline },
);

const { stdin, setRawMode } = useStdin();

useEffect(() => {
  if (isInline || !stdin) return;

  setRawMode(true);
  process.stdout.write('\x1b[?1003h\x1b[?1006h');

  return () => {
    process.stdout.write('\x1b[?1003l\x1b[?1006l');
    setRawMode(false);
    stopAutoScroll();
  };
}, [isInline, stdin, setRawMode]);
```

同时删除三条：

```tsx
// eslint-disable-next-line react-hooks/rules-of-hooks
```

不要改动 `SGR_FRAGMENT_RE` 上现有的 `no-control-regex` warning；它属于第二波。

- [ ] **Step 4: 运行动态切换与现有 ConnectedApp 测试**

Run:

```powershell
npx.cmd vitest run src/__tests__/tui/connected-app-render-mode-transition.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx src/__tests__/tui/render-mode.test.tsx src/__tests__/tui/inline-v2/v2-resize.test.tsx
```

Expected: PASS。

- [ ] **Step 5: 验证该文件不再有 error**

Run:

```powershell
npx.cmd eslint src/tui/ConnectedApp.tsx src/__tests__/tui/connected-app-render-mode-transition.test.tsx --quiet
```

Expected: exit code 0。`--quiet` 有意忽略第二波 warning。

- [ ] **Step 6: 提交**

```powershell
git add -- src/tui/ConnectedApp.tsx src/__tests__/tui/connected-app-render-mode-transition.test.tsx
git commit -m "fix: keep ConnectedApp hooks unconditional"
```

---

### Task 2: 锁定工具消息的相同优先级

**Files:**
- Create: `src/__tests__/output-message-priority.test.ts`
- Modify: `src/output/types.ts:16-17`

**Interfaces:**
- Consumes: `MessagePriority`、`MessageQueue.enqueue()`、`MessageQueue.dequeue()`
- Produces: `TOOL_CALL === TOOL_RESULT === 3` 且相同优先级保持 FIFO

- [ ] **Step 1: 添加行为刻画测试**

```ts
import { describe, expect, it } from 'vitest';
import { MessageQueue } from '../output/message-queue.js';
import { MessagePriority } from '../output/types.js';

describe('tool message priority', () => {
  it('keeps tool call and result at the same priority in FIFO order', () => {
    expect(MessagePriority.TOOL_CALL).toBe(3);
    expect(MessagePriority.TOOL_RESULT).toBe(MessagePriority.TOOL_CALL);

    const queue = new MessageQueue();
    queue.enqueue({
      type: 'tool_call',
      content: 'call',
      priority: MessagePriority.TOOL_CALL,
    });
    queue.enqueue({
      type: 'tool_result',
      content: 'result',
      priority: MessagePriority.TOOL_RESULT,
    });

    expect(queue.dequeue()?.type).toBe('tool_call');
    expect(queue.dequeue()?.type).toBe('tool_result');
  });
});
```

- [ ] **Step 2: 运行刻画测试**

Run:

```powershell
npx.cmd vitest run src/__tests__/output-message-priority.test.ts
```

Expected: PASS。这里是对既有正确语义的 characterization test；本任务的 RED 来自下一步 ESLint。

- [ ] **Step 3: 确认定向 ESLint 为 RED**

Run:

```powershell
npx.cmd eslint src/output/types.ts --quiet
```

Expected: FAIL，唯一目标错误为 `@typescript-eslint/no-duplicate-enum-values`。

- [ ] **Step 4: 添加最窄范围 suppression**

保持数值不变：

```ts
  TOOL_CALL = 3,
  // TOOL_CALL 与 TOOL_RESULT 必须同优先级，由 MessageQueue 的稳定插入顺序维持 FIFO。
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  TOOL_RESULT = 3,
```

不要把 `TOOL_RESULT` 改成 `4`，也不要全局关闭规则。

- [ ] **Step 5: 验证行为与 lint**

Run:

```powershell
npx.cmd vitest run src/__tests__/output-message-priority.test.ts
npx.cmd eslint src/output/types.ts src/__tests__/output-message-priority.test.ts --quiet
```

Expected: 两条命令均 exit code 0。

- [ ] **Step 6: 提交**

```powershell
git add -- src/output/types.ts src/__tests__/output-message-priority.test.ts
git commit -m "test: lock tool message priority semantics"
```

---

### Task 3: 将两个 provider usage 累加器改为 `const`

**Files:**
- Modify: `src/agent/google-stream-client.ts:142`
- Modify: `src/agent/openai-stream-client.ts:152`
- Test: `src/__tests__/agent/google-stream-client.test.ts`
- Test: `src/__tests__/agent/openai-stream-client.test.ts`

**Interfaces:**
- Consumes: 可变 `Usage` 对象，其字段在流式 chunk 中原地更新
- Produces: 相同 usage 累加行为，仅禁止重新绑定对象引用

- [ ] **Step 1: 记录现有行为测试为 GREEN**

```powershell
npx.cmd vitest run src/__tests__/agent/google-stream-client.test.ts src/__tests__/agent/openai-stream-client.test.ts
```

Expected: PASS。

- [ ] **Step 2: 确认定向 ESLint 为 RED**

```powershell
npx.cmd eslint src/agent/google-stream-client.ts src/agent/openai-stream-client.ts --quiet
```

Expected: 两个 `prefer-const` error。

- [ ] **Step 3: 做最小修改**

在两个文件中分别将：

```ts
let usage: Usage = { input_tokens: 0, output_tokens: 0 };
```

改为：

```ts
const usage: Usage = { input_tokens: 0, output_tokens: 0 };
```

保留后续 `usage.input_tokens = ...` 和 `usage.output_tokens = ...`；`const` 只限制引用重新赋值，不限制字段更新。

- [ ] **Step 4: 验证测试与 lint**

```powershell
npx.cmd vitest run src/__tests__/agent/google-stream-client.test.ts src/__tests__/agent/openai-stream-client.test.ts
npx.cmd eslint src/agent/google-stream-client.ts src/agent/openai-stream-client.ts --quiet
```

Expected: PASS、exit code 0。

- [ ] **Step 5: 提交**

```powershell
git add -- src/agent/google-stream-client.ts src/agent/openai-stream-client.ts
git commit -m "chore: keep provider usage accumulators constant"
```

---

### Task 4: 清理 image cache 测试中的无效变量和 CommonJS import

**Files:**
- Modify: `src/__tests__/agent/image-utils.test.ts:7,177-184`

**Interfaces:**
- Consumes: Node ESM named import `statSync`
- Produces: 同一条真实文件大小断言，不再创建无用空 Buffer，也不使用 `require()`

- [ ] **Step 1: 运行现有测试并确认行为基线**

```powershell
npx.cmd vitest run src/__tests__/agent/image-utils.test.ts
```

Expected: PASS。

- [ ] **Step 2: 确认两个目标 lint error**

```powershell
npx.cmd eslint src/__tests__/agent/image-utils.test.ts --quiet
```

Expected: 至少包含：

```text
'readBack' is assigned a value but never used
A `require()` style import is forbidden
```

- [ ] **Step 3: 使用 ESM import 并删除假读取**

把文件顶部 import 改为：

```ts
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  statSync,
} from 'fs';
```

把测试中的以下内容删除：

```ts
const readBack = Buffer.from('', 'base64');
const { statSync } = require('fs');
```

保留真实断言：

```ts
expect(statSync(cachePath).size).toBeGreaterThan(0);
```

- [ ] **Step 4: 验证测试与 error 清零**

```powershell
npx.cmd vitest run src/__tests__/agent/image-utils.test.ts
npx.cmd eslint src/__tests__/agent/image-utils.test.ts --quiet
```

Expected: 测试 PASS；ESLint exit code 0。该文件仍可能有 `no-explicit-any` warning，属于第二波，`--quiet` 不处理。

- [ ] **Step 5: 提交**

```powershell
git add -- src/__tests__/agent/image-utils.test.ts
git commit -m "test: simplify image cache verification"
```

---

### Task 5: 删除 permission channel 的原样重抛 catch

**Files:**
- Modify: `src/index.ts:364-370`
- Test: `src/__tests__/index.test.ts`
- Test: `src/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `askManager.ask(request): Promise<AskQuestionOutcome>`
- Produces: 完全相同的 rejection 传播语义，减少无意义控制层

- [ ] **Step 1: 运行入口测试基线**

```powershell
npx.cmd vitest run src/__tests__/index.test.ts src/__tests__/cli.test.ts
```

Expected: PASS。

- [ ] **Step 2: 确认 `no-useless-catch` RED**

```powershell
npx.cmd eslint src/index.ts --quiet
```

Expected: 包含 `Unnecessary try/catch wrapper`。该文件另有不在本计划内的 unused error，因此本步允许同时报告它。

- [ ] **Step 3: 删除只负责重新抛出的 catch**

将：

```ts
let outcome: AskQuestionOutcome;
try {
  outcome = await askManager.ask(request);
} catch (err) {
  throw err;
}
```

改为：

```ts
const outcome: AskQuestionOutcome = await askManager.ask(request);
```

不要新增 fallback、包装错误或改变 gate 对 rejection 的处理。

- [ ] **Step 4: 验证行为，并只检查目标规则已消失**

```powershell
npx.cmd vitest run src/__tests__/index.test.ts src/__tests__/cli.test.ts
npx.cmd eslint src/index.ts
```

Expected:

- 测试 PASS。
- `no-useless-catch` 不再出现。
- `COMMAND_NAMES` 的既有 unused error 仍可出现，属于第二波；不要顺手删除。

- [ ] **Step 5: 提交**

```powershell
git add -- src/index.ts
git commit -m "refactor: propagate permission prompt failures directly"
```

---

### Task 6: 第一波集成验证与停止线

**Files:**
- Verify only: 本计划修改的所有文件
- Do not modify: 任何第二波 cleanup 文件

**Interfaces:**
- Consumes: Tasks 1-5 的五个独立提交
- Produces: 可交付分支；9 个目标 lint error 消失，功能测试保持通过

- [ ] **Step 1: 定向 ESLint 验证**

```powershell
npx.cmd eslint --quiet `
  src/tui/ConnectedApp.tsx `
  src/__tests__/tui/connected-app-render-mode-transition.test.tsx `
  src/output/types.ts `
  src/__tests__/output-message-priority.test.ts `
  src/agent/google-stream-client.ts `
  src/agent/openai-stream-client.ts `
  src/__tests__/agent/image-utils.test.ts
```

Expected: exit code 0。

`src/index.ts` 不放入该组合，因为它仍有第二波 `COMMAND_NAMES` unused error；单独确认 `no-useless-catch` 已消失：

```powershell
$lint = npx.cmd eslint src/index.ts 2>&1
if ($lint -match 'no-useless-catch') { throw 'no-useless-catch still present' }
```

- [ ] **Step 2: 影响范围测试**

```powershell
npx.cmd vitest run `
  src/__tests__/tui/connected-app-render-mode-transition.test.tsx `
  src/__tests__/tui/connected-app-spinner-clock.test.tsx `
  src/__tests__/tui/render-mode.test.tsx `
  src/__tests__/tui/inline-v2/v2-resize.test.tsx `
  src/__tests__/output-message-priority.test.ts `
  src/__tests__/agent/google-stream-client.test.ts `
  src/__tests__/agent/openai-stream-client.test.ts `
  src/__tests__/agent/image-utils.test.ts `
  src/__tests__/index.test.ts `
  src/__tests__/cli.test.ts
```

Expected: PASS。

- [ ] **Step 3: TypeScript 检查**

```powershell
npm.cmd run typecheck
```

Expected: exit code 0。

- [ ] **Step 4: 全量测试**

```powershell
npm.cmd test
```

Expected: exit code 0。记录 test file 数、passed/skipped 数和耗时。

- [ ] **Step 5: 记录全量 lint 的预期剩余债务**

```powershell
npm.cmd run lint
```

Expected: 仍然 exit code 1，但目标错误数应从 `72` 降到 `63`。如果不是 `63`：

- 少于 63：确认没有越界修改第二波问题。
- 多于 63：检查是否引入新 lint error。
- warning 数变化不作为本计划阻塞，除非新增 warning 来自本计划新文件。

- [ ] **Step 6: 检查范围与用户文件**

```powershell
git diff master...HEAD --name-only
git status --short
```

Expected:

- diff 只包含本计划明确列出的文件。
- worktree 干净。
- 不包含三个 prompt 文件或 `ai-news-2026-07.html`。

- [ ] **Step 7: 最终审查**

使用 `superpowers:requesting-code-review`，审查重点：

1. Hook 是否始终无条件调用。
2. inline 模式是否仍不启用 mouse/raw mode。
3. alt-screen cleanup 是否在模式切换和卸载时执行。
4. 工具消息优先级是否仍为相同值并保持 FIFO。
5. 是否越界清理第二波 lint 项。

审查无 Critical/Important 后停止。不要继续追求全量 lint 通过；下一项工作应回到测试循环。

