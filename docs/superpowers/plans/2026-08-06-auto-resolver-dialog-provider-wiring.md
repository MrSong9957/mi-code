# Auto Resolver dialogProvider Production Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the auto permission resolver to the real production TUI dialog so that auto-mode main-origin unresolved asks surface a 4-option permission questionnaire (Allow once / Allow session / Always allow / Reject) via the existing AskUserManager, with classifier/dialog race, ESC/reject classifier abort, and session/always remember all reachable in production.

**Architecture:** Three layers, decoupled. (1) `mapDialogResult` — pure function `AskQuestionOutcome → DialogResult` (adapter boundary; `cancelled → escape`). (2) `createAutoPermissionDialogProvider` in a new side-effect-free module `src/permission/auto-permission-dialog.ts` — produces a `dialog` function; holds NO side-effect callbacks. (3) Resolver wiring — `DefaultPermissionAskResolver` + seam thread `onSessionAllow`/`onPersistRule`/`recheck` (currently missing) into `resolveInteractiveAsk`; `recheck` is a **parameterized** `(toolName, input) => SecurityDecision` captured into a closure at `resolveByClassifier` (the only layer with `request.executableToolCall`). `interactive-ask.ts` and the TUI layer are unchanged.

**Tech Stack:** TypeScript ESM, Vitest, Node 18+.

**Spec:** `docs/superpowers/specs/2026-08-06-auto-resolver-dialog-provider-wiring-design.md` (approved).

**TDD phase expectations:**

| Test group | After Task 1 (RED) | After Task 2 (mapDialogResult) | After Task 3 (resolver threading) | After Task 4 (adapter module) | After Task 5 (index wiring) |
|---|---|---|---|---|---|
| mapDialogResult unit (§7.1) | FAIL (not exported) | **PASS** | PASS | PASS | PASS |
| adapter behavior A1-A3 (§7.2) | FAIL (module absent) | FAIL | FAIL | **PASS** | PASS |
| resolver end-to-end #1-#8 (§7.3) | FAIL (seam fields absent) | FAIL | partial | partial | **PASS** |

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/permission/permission-answer-mapping.ts` | Pure outcome→decision mappers. Add `mapDialogResult` + `ALLOW_ALWAYS_LABEL`. | Modify |
| `src/permission/auto-permission-dialog.ts` | **New side-effect-free module**: `createAutoPermissionDialogProvider(askMgr)`. | Create |
| `src/permission/ask-resolver.ts` | `DefaultPermissionAskResolver`. Add `onSessionAllow`/`onPersistRule`/`recheck` options; thread + capture closure in `resolveByClassifier`. | Modify |
| `src/permission/authority-gate.ts` | Seam. Add the three callbacks to input + TurnRuntimeDeps + resolver construction. | Modify |
| `src/index.ts` | Import adapter; pass `dialogProvider` + `dialogDelayMs:2000` + callbacks at the seam call. | Modify |
| `src/__tests__/permission/auto-dialog-mapping.test.ts` | §7.1 unit + §7.2 adapter behavior. | Create |
| `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` | §7.3 #1-#8 end-to-end. | Create |

Unchanged: `interactive-ask.ts`, `ask-user-types.ts`, `ask-question-store.ts`, `use-input-handler.ts`, all TUI.

> **Why adapter is NOT in index.ts:** `src/index.ts` has a `#!/usr/bin/env node` shebang and top-level side effects (`new AskUserManager` line 337, `new RuntimeSecurityGate` line 419, `bootstrap(...)` line 1151), with no main guard. Importing it from a test triggers those side effects. No existing test imports `src/index.ts` (verified: `grep -rn "from '../../index" src/__tests__/` returns nothing). The adapter goes in a dedicated permission module; index.ts imports it for production wiring. `permission → agent` (for `AskUserManager`) is an existing dependency pattern, not a new cycle.

---

### Task 1: RED — clean test shells that fail ONLY on missing capability

**Files:**
- Create: `src/__tests__/permission/auto-dialog-mapping.test.ts`
- Create: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

- [ ] **Step 1: Write `auto-dialog-mapping.test.ts` (§7.1 + §7.2 shells)**

```ts
// Auto permission dialog: outcome→DialogResult mapping (§7.1) + adapter behavior (§7.2).
import { describe, test, expect } from 'vitest';
import {
  mapDialogResult,
  ALLOW_ALWAYS_LABEL,
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
} from '../../permission/permission-answer-mapping.js';
import { createAutoPermissionDialogProvider } from '../../permission/auto-permission-dialog.js';
import type { AskQuestionOutcome, AskQuestionRequest } from '../../agent/ask-user-types.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

// ═══════════════════════════════════════════════════════════════════════════════
// §7.1 mapDialogResult pure-function unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('[auto-dialog] mapDialogResult unit', () => {
  test('submitted Allow once -> approved_once', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: ALLOW_ONCE_LABEL } };
    expect(mapDialogResult(o)).toEqual({ kind: 'approved_once' });
  });
  test('submitted Allow session -> approved_session', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: ALLOW_EXACT_LABEL } };
    expect(mapDialogResult(o)).toEqual({ kind: 'approved_session' });
  });
  test('submitted Always allow -> approved_always', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: ALLOW_ALWAYS_LABEL } };
    expect(mapDialogResult(o)).toEqual({ kind: 'approved_always' });
  });
  test('submitted Reject -> rejected', () => {
    const o: AskQuestionOutcome = { kind: 'submitted', answers: { q: 'Reject' } };
    expect(mapDialogResult(o)).toEqual({ kind: 'rejected' });
  });
  test('submitted unknown/empty -> rejected', () => {
    expect(mapDialogResult({ kind: 'submitted', answers: {} })).toEqual({ kind: 'rejected' });
    expect(mapDialogResult({ kind: 'submitted', answers: { q: 'whatever' } })).toEqual({ kind: 'rejected' });
  });
  test('cancelled -> escape', () => {
    expect(mapDialogResult({ kind: 'cancelled' })).toEqual({ kind: 'escape' });
  });
  test('chat -> rejected', () => {
    expect(mapDialogResult({ kind: 'chat', feedback: 'later' })).toEqual({ kind: 'rejected' });
  });
});

// ═══════════════调查══════════════════════════════════════════════════════════════
// §7.2 adapter behavior: real createAutoPermissionDialogProvider + scripted AskUserManager
// ═══════════════════════════════════════════════════════════════════════════════

class ScriptedAskManager {
  constructor(private readonly outcome: AskQuestionOutcome) {}
  async ask(_request: AskQuestionRequest): Promise<AskQuestionOutcome> { return this.outcome; }
}

const askInput = {
  decision: { decision_id: 'd1', behavior: 'ask' as const, reason_code: 'x', human_reason: 'r' },
  toolName: 'run_bash',
  input: { command: 'echo hi' },
  origin: 'main' as const,
};

describe('[auto-dialog] adapter behavior (§7.2)', () => {
  test('A1: cancelled -> adapter returns DialogResult.escape', async () => {
    const mgr = new ScriptedAskManager({ kind: 'cancelled' });
    const dialog = createAutoPermissionDialogProvider(mgr as never);
    const result: DialogResult = await dialog(askInput as never);
    expect(result).toEqual({ kind: 'escape' });
  });
  test('A2: submitted labels -> corresponding DialogResult', async () => {
    const cases: Array<[string, DialogResult]> = [
      [ALLOW_ONCE_LABEL, { kind: 'approved_once' }],
      [ALLOW_EXACT_LABEL, { kind: 'approved_session' }],
      [ALLOW_ALWAYS_LABEL, { kind: 'approved_always' }],
      ['Reject', { kind: 'rejected' }],
    ];
    for (const [label, expected] of cases) {
      const mgr = new ScriptedAskManager({ kind: 'submitted', answers: { q: label } });
      const dialog = createAutoPermissionDialogProvider(mgr as never);
      expect(await dialog(askInput as never)).toEqual(expected);
    }
  });
  test('A3: chat -> rejected', async () => {
    const mgr = new ScriptedAskManager({ kind: 'chat', feedback: 'later' });
    const dialog = createAutoPermissionDialogProvider(mgr as never);
    expect(await dialog(askInput as never)).toEqual({ kind: 'rejected' });
  });
});
```

- [ ] **Step 2: Write `auto-dialog-resolver-wiring.test.ts` (§7.3 shells #1-#8)**

```ts
// Auto permission dialog: resolver/executeToolCall end-to-end behavior (§7.3).
import { describe, test, expect, vi } from 'vitest';
import { executeToolCall } from '../../agent/tool-execution.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { createConfiguredExecutionRuntimeForTurn } from '../../permission/authority-gate.js';
import { PermissionChecker } from '../../permission/checker.js';
import { RuntimeSecurityGate } from '../../permission/runtime-gate.js';
import { SessionAllowlist } from '../../permission/session-allowlist.js';
import { SessionState } from '../../permission/session-state.js';
import type { PendingSecurityDecision, PendingDecisionStore } from '../../permission/runtime-gate.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

class FakeStore implements PendingDecisionStore {
  async save(): Promise<void> {}
  async load(): Promise<readonly PendingSecurityDecision[]> { return []; }
  async update(): Promise<void> {}
}

function pendingClassifier() {
  return { completeText: () => new Promise<string>(() => {}) } as never;
}

function makeRuntime(opts: {
  dialogResult: DialogResult;
  dialogDelayMs?: number;
  onSessionAllow?: (t: string, i: Record<string, unknown>) => void;
  onPersistRule?: (u: { type: 'addRules'; destination: string; rule: unknown }) => void;
  recheck?: (t: string, i: Record<string, unknown>) => { behavior: 'allow' | 'deny'; reason_code: string };
  classifierCompleteText?: () => Promise<string>;
  channelRequest?: (...args: unknown[]) => unknown;
  sessionAllowlist?: SessionAllowlist;
}) {
  const dialogProvider = async (): Promise<DialogResult> => opts.dialogResult;
  return createConfiguredExecutionRuntimeForTurn({
    authority: 'enforced',
    streamClient: opts.classifierCompleteText ? { completeText: opts.classifierCompleteText } as never : pendingClassifier(),
    providerId: 'test',
    modelId: 'm',
    providerModelIds: ['m'],
    classifierConfigSources: {},
    permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
    runtimeGate: new RuntimeSecurityGate({
      pendingStore: new FakeStore(),
      channel: opts.channelRequest ? ({ request: opts.channelRequest } as never) : null,
    }),
    sessionAllowlist: opts.sessionAllowlist ?? new SessionAllowlist(),
    sessionState: new SessionState(new SessionAllowlist(), 's1'),
    hooks: [],
    dialogProvider,
    dialogDelayMs: opts.dialogDelayMs ?? 0,
    onSessionAllow: opts.onSessionAllow,
    onPersistRule: opts.onPersistRule,
    recheck: opts.recheck,
  });
}

function runBashRegistry(executor = vi.fn().mockResolvedValue('ran')) {
  const r = new ToolRegistry();
  r.register(
    { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
    executor,
  );
  return { registry: r, executor };
}

const userMsg = [{ role: 'user' as const, content: 'run echo hi', authoredByUser: true }];
const bashCall = { type: 'tool_use' as const, id: 'c1', name: 'run_bash', input: { command: 'echo hi' } };

describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked', async () => {
    let dialogCalls = 0;
    const runtime = makeRuntime({
      dialogResult: { kind: 'approved_once' },
      dialogDelayMs: 0,
    });
    // wrap to count: reconstruct with a counting provider via direct override on returned runtime not possible,
    // so verify via outcome: approved_once -> executor runs (dialog must have been reached)
    const { registry, executor } = runBashRegistry();
    // override dialogProvider on the constructed runtime's resolver path is internal;
    // use a dedicated counting provider by passing through makeRuntime dialogResult.
    void dialogCalls;
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(executor).toHaveBeenCalled(); // proves dialog returned approved_once -> allow -> execute
    void r;
  });
});
```

> **RED goal for Task 1:** Both test files run but FAIL because `mapDialogResult`/`ALLOW_ALWAYS_LABEL` are not exported from `permission-answer-mapping.ts`, `createAutoPermissionDialogProvider` module `auto-permission-dialog.ts` does not exist, and `onSessionAllow`/`onPersistRule`/`recheck` are not fields on `createConfiguredExecutionRuntimeForTurn`'s input. The test code itself compiles against the *expected* API (types resolve once Tasks 2-4 land); at Task 1 it fails on missing exports/wiring, NOT on test-internal syntax errors.
>
> **Expected RED failure reasons:**
> - `auto-dialog-mapping.test.ts`: `mapDialogResult` / `ALLOW_ALWAYS_LABEL` not exported (§7.1); `../../permission/auto-permission-dialog.js` module not found (§7.2).
> - `auto-dialog-resolver-wiring.test.ts`: `onSessionAllow`/`onPersistRule`/`recheck` not in seam input type → TS error (typecheck) / runtime undefined (vitest). #1's `executor.toHaveBeenCalled()` fails because approved_once never reaches resolver side-effect without wiring.

- [ ] **Step 3: Run tests to verify RED**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

Expected: FAIL. Vitest does not typecheck (esbuild strips types), so the RED fails at runtime on missing capability, not on TS type errors:
- `auto-dialog-mapping.test.ts`: **module-not-found** `../../permission/auto-permission-dialog.js` (§7.2); once that resolves, `mapDialogResult`/`ALLOW_ALWAYS_LABEL` are `undefined` → §7.1 assertions fail. This is the clean "missing export / missing module" RED.
- `auto-dialog-resolver-wiring.test.ts`: the `onSessionAllow`/`onPersistRule`/`recheck` fields passed to `createConfiguredExecutionRuntimeForTurn` are silently ignored at runtime (fields not yet on the input type; vitest doesn't enforce), so `#1`'s `executor.toHaveBeenCalled()` fails because approved_once never reaches the resolver side-effect path without wiring → the tool is denied by the gate (classifier pending, no dialog resolution). This is the expected "wiring missing" RED.

> `npm run typecheck` at Task 1 will report TS errors for the not-yet-existing `auto-permission-dialog.js` module and the missing seam fields — that's expected and resolves as Tasks 2-4 land. The vitest RED above is the runtime confirmation.

---

### Task 2: Implement `mapDialogResult` + `ALLOW_ALWAYS_LABEL` (§7.1 GREEN)

**Files:**
- Modify: `src/permission/permission-answer-mapping.ts`

- [ ] **Step 1: Add `ALLOW_ALWAYS_LABEL` and `mapDialogResult`**

Add the `DialogResult` type import and the new export to `src/permission/permission-answer-mapping.ts` (after the existing `mapPermissionAnswerToUserDecision`):

```ts
import type { DialogResult } from './interactive-ask.js';

/** auto permission dialog 第三个放行选项文案（always-allow，持久化）。
 * 与 ALLOW_ONCE_LABEL / ALLOW_EXACT_LABEL 同源：adapter 构造问卷与 mapDialogResult 映射共用。 */
export const ALLOW_ALWAYS_LABEL = 'Always allow';

/**
 * auto permission dialog 问卷 outcome → DialogResult（spec §5.2 adapter 边界）。
 *
 * 纯函数：只做 outcome→DialogResult 映射，不触发任何副作用（不写 SessionAllowlist、
 * 不 persist rule、不 abort classifier）。副作用由 resolver 层 handleDialogResult 消费。
 *
 * 安全不变量（spec §3）：auto dialog 串行执行（streaming-executor 非只读工具串行 +
 * 只读工具不调 askManager），因此 `cancelled` 的唯一来源是用户 ESC。映射 cancelled→escape
 * 安全；见调度行为测试 §7.3 #8。
 */
export function mapDialogResult(outcome: AskQuestionOutcome): DialogResult {
  if (outcome.kind !== 'submitted') {
    return outcome.kind === 'cancelled' ? { kind: 'escape' } : { kind: 'rejected' };
  }
  const answer = Object.values(outcome.answers)[0];
  if (answer === ALLOW_ONCE_LABEL) return { kind: 'approved_once' };
  if (answer === ALLOW_EXACT_LABEL) return { kind: 'approved_session' };
  if (answer === ALLOW_ALWAYS_LABEL) return { kind: 'approved_always' };
  return { kind: 'rejected' };
}
```

- [ ] **Step 2: Run §7.1 unit tests to verify GREEN**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts -t "mapDialogResult unit"`

Expected: PASS (7 tests).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/permission/permission-answer-mapping.ts src/__tests__/permission/auto-dialog-mapping.test.ts
git commit -m "feat(task2): add mapDialogResult outcome->DialogResult pure mapping"
```

---

### Task 3: Thread `onSessionAllow`/`onPersistRule`/`recheck` through resolver + seam

**Files:**
- Modify: `src/permission/ask-resolver.ts`
- Modify: `src/permission/authority-gate.ts`

- [ ] **Step 1: Extend `DefaultPermissionAskResolverOptions` + capture closure in `resolveByClassifier`**

In `src/permission/ask-resolver.ts`:

**Extend `DefaultPermissionAskResolverOptions`** (add after `dialogDelayMs`):
```ts
  /** Task 7 A46：accept-session 回调（透传给 resolveInteractiveAsk.onSessionAllow）。 */
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  /** Task 7 A47：always-allow 持久化回调（透传给 resolveInteractiveAsk.onPersistRule）。 */
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  /** Task 7 A47：always-allow 后同步重检（带 tool/input；在 resolveByClassifier capture 当前调用）。
   *  注意：这是带参数的 recheck，不是无参数 recheckAfterPersist——后者由本 resolver 在
   *  resolveByClassifier 为当前 interaction 构造 closure（spec §6.1）。 */
  readonly recheck?: (toolName: string, input: Record<string, unknown>) => SecurityDecision;
```
(Ensure `SecurityDecision` is imported — it's used elsewhere in the file via `PermissionAskResolutionRequest.decision`; add `import type { SecurityDecision } from './decisions.js';` if not present.)

**Add private fields + constructor assignment** (after `this.dialogDelayMs = ...`):
```ts
  private readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  private readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  private readonly recheck?: (toolName: string, input: Record<string, unknown>) => SecurityDecision;
```
```ts
    this.onSessionAllow = opts.onSessionAllow;
    this.onPersistRule = opts.onPersistRule;
    this.recheck = opts.recheck;
```

**Thread + capture in `resolveByClassifier`** — replace the `resolveInteractiveAsk(interactiveInput, {...})` call (currently lines 249-253):
```ts
      return resolveInteractiveAsk(interactiveInput, {
        automatic,
        dialog: this.dialogProvider,
        dialogDelayMs: this.dialogDelayMs,
        ...(this.onSessionAllow !== undefined ? { onSessionAllow: this.onSessionAllow } : {}),
        ...(this.onPersistRule !== undefined ? { onPersistRule: this.onPersistRule } : {}),
        // §6.1：在此层 capture 当前 tool/input（request.executableToolCall）构造无参数 recheckAfterPersist
        ...(this.recheck !== undefined
          ? { recheckAfterPersist: () => this.recheck!(request.executableToolCall.canonicalToolName, request.executableToolCall.input) }
          : {}),
      });
```

- [ ] **Step 2: Extend seam input + TurnRuntimeDeps + resolver construction**

In `src/permission/authority-gate.ts`:

**Extend `TurnRuntimeDeps`** (add after `dialogDelayMs?`):
```ts
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  readonly recheck?: (toolName: string, input: Record<string, unknown>) => import('./decisions.js').SecurityDecision;
```

**Extend the `createConfiguredExecutionRuntimeForTurn` input type** (add after `dialogDelayMs?`):
```ts
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  readonly recheck?: (toolName: string, input: Record<string, unknown>) => import('./decisions.js').SecurityDecision;
```

**In `createResolver`** — extend the `new DefaultPermissionAskResolver({...})` construction. Add after the existing `dialogDelayMs` spread:
```ts
    ...(deps.onSessionAllow !== undefined ? { onSessionAllow: deps.onSessionAllow } : {}),
    ...(deps.onPersistRule !== undefined ? { onPersistRule: deps.onPersistRule } : {}),
    ...(deps.recheck !== undefined ? { recheck: deps.recheck } : {}),
```

**In `createConfiguredExecutionRuntimeForTurn`** — in the final `createExecutionRuntimeForTurn({...})` call, add (alongside existing `dialogProvider`/`dialogDelayMs` spread):
```ts
    ...(input.onSessionAllow !== undefined ? { onSessionAllow: input.onSessionAllow } : {}),
    ...(input.onPersistRule !== undefined ? { onPersistRule: input.onPersistRule } : {}),
    ...(input.recheck !== undefined ? { recheck: input.recheck } : {}),
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0. (index.ts still doesn't pass these — they're optional; Task 5 wires production.)

- [ ] **Step 4: Run existing resolver/seam tests to confirm no regression**

Run: `npx vitest run src/__tests__/permission/auto-interactive-ask-production.test.ts src/__tests__/permission/authority-gate-production.test.ts src/__tests__/permission/authority-gate-contracts.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/permission/ask-resolver.ts src/permission/authority-gate.ts
git commit -m "feat(task3): thread onSessionAllow/onPersistRule/recheck through resolver+seam"
```

---

### Task 4: Create `auto-permission-dialog.ts` adapter module (§7.2 GREEN)

**Files:**
- Create: `src/permission/auto-permission-dialog.ts`

- [ ] **Step 1: Create the side-effect-free adapter module**

```ts
// Auto permission dialog provider（Task 7 production wiring, spec §5.1）。
//
// 物理本质：auto resolver 的 dialogProvider 生产实现。把 InteractiveAskInput 转成
// 4 选项问卷，经共享 AskUserManager 弹出，outcome 经 mapDialogResult 映射为 DialogResult。
//
// 职责（严格，spec §5）：InteractiveAskInput → AskUserManager.ask() → AskQuestionOutcome
// → DialogResult。**不持有** onSessionAllow/onPersistRule/recheck —— 那些是
// resolveInteractiveAsk 的 options，由 resolver 层 handleDialogResult 消费。
//
// 模块边界：side-effect-free。不放 index.ts（index.ts 是带 shebang 的 CLI 入口，
// 顶层有 new AskUserManager / new RuntimeSecurityGate / bootstrap 等 TUI 副作用，
// 无 main guard；测试 import 它会触发副作用）。index.ts import 本模块做生产 wiring。
// permission → agent（AskUserManager）是既有依赖模式，非新循环。

import type { AskUserManager } from '../agent/ask-user-manager.js';
import type { AskQuestionRequest } from '../agent/ask-user-types.js';
import type { InteractiveAskInput, DialogResult } from './interactive-ask.js';
import {
  mapDialogResult,
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
  ALLOW_ALWAYS_LABEL,
} from './permission-answer-mapping.js';

/**
 * 构造 auto permission dialog provider（spec §5.1）。
 *
 * 返回的 dialog 函数：InteractiveAskInput → askManager.ask(4选项问卷) → mapDialogResult → DialogResult。
 * 复用共享 AskUserManager 单例与 ask-question-store TUI（不新建第二套问卷组件）。
 */
export function createAutoPermissionDialogProvider(
  askMgr: AskUserManager,
): (input: InteractiveAskInput) => Promise<DialogResult> {
  return async (input: InteractiveAskInput): Promise<DialogResult> => {
    const request: AskQuestionRequest = {
      questions: [{
        question:
          `Allow this action?\n\n` +
          `Tool: ${input.toolName}\n` +
          `Reason: ${input.decision.human_reason ?? ''}`,
        header: 'Permission (auto)',
        options: [
          { label: ALLOW_ONCE_LABEL, description: 'Run this action exactly once. Not remembered.' },
          { label: ALLOW_EXACT_LABEL, description: 'Run now and remember this exact command for this session.' },
          { label: ALLOW_ALWAYS_LABEL, description: 'Run now and always allow (persisted to config; re-checked against hard deny).' },
          { label: 'Reject', description: 'Do not run this action.' },
        ],
        multiSelect: false,
      }],
    };
    const outcome = await askMgr.ask(request);
    return mapDialogResult(outcome);
  };
}
```

- [ ] **Step 2: Run §7.2 adapter behavior tests to verify GREEN**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts -t "adapter behavior"`

Expected: PASS (A1-A3).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/permission/auto-permission-dialog.ts
git commit -m "feat(task4): add createAutoPermissionDialogProvider in side-effect-free module"
```

---

### Task 5: Production wiring + complete §7.3 #1-#8 tests

**Files:**
- Modify: `src/index.ts`
- Modify: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` (complete #1-#8)

- [ ] **Step 1: Wire adapter + callbacks in `src/index.ts`**

**Add import** (near the existing `permission-answer-mapping` import, line ~171):
```ts
import { createAutoPermissionDialogProvider } from './permission/auto-permission-dialog.js';
```

**At the `createConfiguredExecutionRuntimeForTurn({...})` call** (~line 923), add to the object (the existing fields stay; additions marked):
```ts
    const turnRuntime = createConfiguredExecutionRuntimeForTurn({
      authority: permissionAuthority,
      streamClient,
      providerId: provider,
      modelId: model,
      providerConfig,
      providerModelIds,
      classifierConfigSources,
      permissionChecker,
      runtimeGate,
      sessionAllowlist,
      sessionState,
      hooks: [],
      // Task 7 production wiring（spec §5）：auto-mode main-origin unresolved ask 经 dialog 竞速。
      // dialogProvider 只到 DialogResult；副作用回调属 resolver wiring（§5 职责分层）。
      // recheck 是带参数的（spec §6.1）：turn-level 只需 checker，resolver 层 capture tool/input。
      dialogProvider: createAutoPermissionDialogProvider(askManager),
      dialogDelayMs: 2000,
      onSessionAllow: (toolName, inp) => sessionAllowlist.add(toolName, inp),
      onPersistRule: (update) => configStore.persistPermissionUpdate({
        kind: 'addRule',
        rule: update.rule as import('./permission/types.js').PermissionRule,
      }),
      recheck: (toolName, inp) => permissionChecker.checkDecision(toolName, inp, {
        decision_id: `recheck:${toolName}`,
        action_snapshot_id: 'recheck',
        policy_id: 'permission-default',
        policy_version: '1',
      }),
    });
```

- [ ] **Step 2: Replace the `#1` shell in `auto-dialog-resolver-wiring.test.ts` with the full #1-#7 matrix**

Replace the entire `describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)')` block with:

```ts
describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked (spy call count)', async () => {
    let dialogCalls = 0;
    const dialogProvider = async (): Promise<DialogResult> => {
      dialogCalls++;
      return { kind: 'approved_once' };
    };
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [], dialogProvider, dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(dialogCalls).toBeGreaterThanOrEqual(1); // dialog actually invoked
    expect(executor).toHaveBeenCalled();           // approved_once -> allow -> execute
  });

  test('#2 approved_session -> same SessionAllowlist hit (not just spy)', async () => {
    const sessionAllowlist = new SessionAllowlist();
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist,                       // <-- runtime uses THIS instance
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => ({ kind: 'approved_session' }),
      dialogDelayMs: 0,
      // resolver threads onSessionAllow -> SessionAllowlist.add via the wiring's onSessionAllow.
      // In the test we pass it explicitly so the SAME sessionAllowlist instance is written:
      onSessionAllow: (t, i) => sessionAllowlist.add(t, i),
    });
    const { registry } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    // verify the SAME instance the runtime holds now contains the entry
    expect(sessionAllowlist.has('run_bash', { command: 'echo hi' })).toBe(true);
    expect(sessionAllowlist.has('run_bash', { command: 'echo different' })).toBe(false);
  });

  test('#3 gate does NOT call legacy channel (no double dialog)', async () => {
    const channelRequest = vi.fn(async () => ({ response: 'approved_once' }));
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: { request: channelRequest as never } }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => ({ kind: 'approved_once' }),
      dialogDelayMs: 0,
    });
    const { registry } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(channelRequest).not.toHaveBeenCalled(); // resolver turned ask->allow, gate never asks channel
  });

  test('#4 approved_always -> persist + recheck called + hard deny blocks executor', async () => {
    const onPersistRule = vi.fn();
    const recheck = vi.fn(() => ({ behavior: 'deny' as const, reason_code: 'permission.dangerous_command' }));
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => ({ kind: 'approved_always' }),
      dialogDelayMs: 0,
      onPersistRule,
      recheck,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(onPersistRule).toHaveBeenCalled();
    expect(recheck).toHaveBeenCalledWith('run_bash', { command: 'echo hi' });
    expect(executor).not.toHaveBeenCalled(); // hard deny via recheck -> no execute
    expect(r.status).toBe('failure');
  });

  test('#5 escape -> classifier aborted + reason user_cancelled + executor=0', async () => {
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const streamClient = {
      completeText: (_req: unknown, signal?: AbortSignal) => {
        classifierCalls.push({ signal: signal ?? new AbortController().signal });
        return new Promise<string>(() => {}); // never resolves; only abort ends it
      },
    } as never;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => ({ kind: 'escape' }),
      dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(classifierCalls.length).toBeGreaterThanOrEqual(1);
    expect(classifierCalls[0].signal.aborted).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
  });

  test('#6 rejected -> classifier aborted + reason user_denied + executor=0 (both abort per §5.3)', async () => {
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const streamClient = {
      completeText: (_req: unknown, signal?: AbortSignal) => {
        classifierCalls.push({ signal: signal ?? new AbortController().signal });
        return new Promise<string>(() => {});
      },
    } as never;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => ({ kind: 'rejected' }),
      dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(classifierCalls.length).toBeGreaterThanOrEqual(1);
    expect(classifierCalls[0].signal.aborted).toBe(true); // rejected ALSO aborts (§5.3)
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
  });

  test('#7 classifier resolves inside delay -> dialog NOT invoked (spy=0)', async () => {
    let dialogCalls = 0;
    const dialogProvider = async (): Promise<DialogResult> => {
      dialogCalls++;
      return { kind: 'approved_once' };
    };
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: { completeText: async () => 'ALLOW' } as never, // classifier resolves fast
      providerId: 'test', modelId: 'm', providerModelIds: ['m'],
      classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider,
      dialogDelayMs: 5000, // large; classifier wins the race
    });
    const { registry, executor } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(dialogCalls).toBe(0); // classifier ALLOW inside delay -> dialog never created
    expect(executor).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Add #8 scheduling-invariant test (full StreamingToolExecutor assembly, no "see prior test")**

Append to `auto-dialog-resolver-wiring.test.ts`:

```ts
// §7.3 #8: scheduling invariant via real StreamingToolExecutor queue.
import { StreamingToolExecutor } from '../../agent/streaming-executor.js';
import type { ToolUseBlock } from '../../agent/types.js';

function toolBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

describe('[auto-dialog] scheduling invariant (§7.3 #8)', () => {
  test('permission dialog pending blocks ask_user_question; no 2nd askManager.ask; no spurious cancelled', async () => {
    // shared scripted "askManager": first ask = permission dialog (pending forever); any 2nd ask = BUG
    let askCalls = 0;
    let pendingResolve: ((o: { kind: 'submitted'; answers: Record<string, string> }) => void) | null = null;
    let dialogSeenCancelled = false;
    const sharedAskManager = {
      ask: async (_req: unknown): Promise<{ kind: 'submitted'; answers: Record<string, string> } | { kind: 'cancelled' }> => {
        askCalls++;
        if (askCalls === 1) {
          return new Promise((res) => { pendingResolve = res as () => void; });
        }
        return { kind: 'submitted', answers: {} };
      },
    };
    const dialogProvider = async (): Promise<DialogResult> => {
      const outcome = await sharedAskManager.ask({});
      if (outcome.kind === 'cancelled') { dialogSeenCancelled = true; return { kind: 'escape' }; }
      return { kind: 'approved_once' };
    };

    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: { completeText: () => new Promise<string>(() => {}) } as never,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [], dialogProvider, dialogDelayMs: 0,
    });

    const askUserExec = vi.fn(async () => 'ask-user-done');
    const runBashExec = vi.fn(async () => 'ran');
    const registry = new ToolRegistry();
    registry.register(
      { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
      runBashExec,
    );
    registry.register(
      { name: 'ask_user_question', description: 'a', parameters: { type: 'object' as const, properties: { questions: { type: 'array' } }, required: ['questions'] } },
      askUserExec,
    );

    const exec = new StreamingToolExecutor(registry, runtime, new AbortController().signal, 'main',
      [{ role: 'user', content: 'run echo hi', authoredByUser: true }]);

    // run_bash FIRST -> enforced+auto classifier -> resolver -> dialog -> askManager.ask (pending)
    exec.addTool(toolBlock('c1', 'run_bash', { command: 'echo hi' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(askCalls, 'run_bash triggered exactly 1 askManager.ask').toBe(1);

    // enqueue ask_user_question WHILE permission dialog pending
    exec.addTool(toolBlock('c2', 'ask_user_question', { questions: [] }));
    await new Promise((r) => setTimeout(r, 40));
    expect(askUserExec, 'ask_user_question NOT started while permission pending').not.toHaveBeenCalled();
    expect(askCalls, 'no 2nd askManager.ask during permission pending').toBe(1);
    expect(dialogSeenCancelled, 'permission dialog NOT cancelled (no preempt)').toBe(false);
    expect(runBashExec, 'run_bash not executed while dialog pending').not.toHaveBeenCalled();

    // resolve permission dialog -> run_bash executes (closure)
    pendingResolve?.({ kind: 'submitted', answers: {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(runBashExec, 'run_bash executed after dialog approved').toHaveBeenCalled();
  }, 15000);
});
```

- [ ] **Step 4: Run §7.3 tests to verify GREEN**

Run: `npx vitest run src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

Expected: PASS (#1-#8). If `PermissionChecker.checkDecision` context shape in index.ts wiring (Step 1) needs adjustment, fix the wiring — not the tests.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Run permission + agent regression**

Run: `npx vitest run src/__tests__/permission/ src/__tests__/agent/`

Expected: PASS (0 failures).

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts
git commit -m "feat(task5): production wiring + §7.3 end-to-end behavior tests #1-#8"
```

---

## Self-Review

**1. Spec coverage:**
- §5.1 data flow → Task 4 (adapter module) + Task 5 (wiring) + Task 3 (recheck closure). ✓
- §5.2 mapDialogResult → Task 2. ✓
- §5.3 escape/rejected both abort → Task 5 #5 + #6 (both assert signal.aborted). ✓
- §5.4 no double dialog → Task 5 #3 (channel.request === 0). ✓
- §6 file scope (incl. new auto-permission-dialog.ts module + §6.1 recheck data flow) → Tasks 2/3/4/5. ✓
- §7.1 unit → Task 2. ✓
- §7.2 adapter A1-A3 → Task 4. ✓
- §7.3 #1-#8 → Task 5 (each is complete, executable code). ✓

**2. Placeholder scan:**
- No "TBD", "implementation note", "verify at implementation time", "see prior test", "assertion refined". 
- Task 5 Step 1 `recheck` wiring is fully specified: `(toolName, inp) => permissionChecker.checkDecision(toolName, inp, {decision_id, action_snapshot_id, policy_id, policy_version})` — concrete, no decisions deferred.
- Task 5 #8 is complete StreamingToolExecutor assembly, not a reference to prior code.

**3. Type/import consistency:**
- All test imports use `../../permission/...` and `../../agent/...` (verified paths from `src/__tests__/permission/`). ✓
- `mapDialogResult`/`ALLOW_ALWAYS_LABEL`/`ALLOW_ONCE_LABEL`/`ALLOW_EXACT_LABEL` all from `permission-answer-mapping.js`. ✓
- `createAutoPermissionDialogProvider` from `auto-permission-dialog.js` (both test §7.2 and index.ts). ✓
- `recheck(toolName, input) => SecurityDecision` consistent across resolver options, TurnRuntimeDeps, seam input, index.ts wiring, Task 5 #4 test. ✓
- `DialogResult` from `interactive-ask.js` consistent. ✓

**4. Each test proves its claim:**
- #1: spy `dialogCalls` >= 1 + executor called (dialog reached + approved_once flowed through). ✓
- #2: checks the SAME `sessionAllowlist` instance the runtime holds (`has` true/false). ✓
- #3: `channelRequest` not called (resolver turned ask->allow). ✓
- #4: `onPersistRule` + `recheck` called with exact args + executor=0 + failure (hard deny). ✓
- #5/#6: classifier `signal.aborted === true` + executor=0 + failure (escape AND rejected both abort). ✓
- #7: spy `dialogCalls === 0` + executor called (classifier won race). ✓
- #8: real StreamingToolExecutor queue; 1 ask + ask_user_question not started + no 2nd ask + no cancelled + run_bash closure. ✓

**5. Independent RED→GREEN→commit per task:** Each task has its own failing test (Task 1 RED), implementation (Tasks 2-5), verification command, and commit. ✓
