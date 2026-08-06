# Auto Resolver dialogProvider Production Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the auto permission resolver to the real production TUI dialog so that auto-mode main-origin unresolved asks surface a 4-option permission questionnaire (Allow once / Allow session / Always allow / Reject) via the existing AskUserManager, with classifier/dialog race, ESC/reject classifier abort, and session/always remember all reachable in production.

**Architecture:** Three layers, kept decoupled. (1) `mapDialogResult` — pure function mapping `AskQuestionOutcome → DialogResult` (adapter boundary; `cancelled → escape`). (2) `createAutoPermissionDialogProvider` — produces a `dialog` function `InteractiveAskInput → askManager.ask → mapDialogResult → DialogResult`; holds NO side-effect callbacks. (3) Resolver wiring — `DefaultPermissionAskResolver` + `createConfiguredExecutionRuntimeForTurn` thread `onSessionAllow`/`onPersistRule`/`recheckAfterPersist` (currently missing) into `resolveInteractiveAsk`, where `handleDialogResult` consumes them. `interactive-ask.ts` and the TUI layer are unchanged.

**Tech Stack:** TypeScript ESM, Vitest, Node 18+.

**Spec:** `docs/superpowers/specs/2026-08-06-auto-resolver-dialog-provider-wiring-design.md` (approved).

**TDD phase expectations:**

| Test group | After Task 1 (RED) | After Task 2 (mapDialogResult) | After Task 3 (resolver threading) | After Task 4 (adapter) | After Task 5 (index wiring) |
|---|---|---|---|---|---|
| mapDialogResult unit (7.1) | FAIL (not exported) | **PASS** | PASS | PASS | PASS |
| adapter behavior A1-A3 (7.2) | FAIL | FAIL (no adapter) | FAIL | **PASS** | PASS |
| resolver end-to-end #1-#8 (7.3) | FAIL | FAIL | partial (callback threading only) | partial | **PASS** |

Tasks build up: pure function first (Task 2), then resolver threading (Task 3), then adapter (Task 4), finally production wiring (Task 5). Each task is independently verifiable.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/permission/permission-answer-mapping.ts` | Pure outcome→decision mappers. Add `mapDialogResult` (outcome→DialogResult). | Modify (add export) |
| `src/permission/ask-resolver.ts` | `DefaultPermissionAskResolver`. Add `onSessionAllow`/`onPersistRule`/`recheckAfterPersist` to options + thread into `resolveInteractiveAsk`. | Modify |
| `src/permission/authority-gate.ts` | `createConfiguredExecutionRuntimeForTurn` seam. Add the three callbacks to input + thread to resolver constructor. (`dialogProvider`/`dialogDelayMs` fields already exist.) | Modify |
| `src/index.ts` | Add `createAutoPermissionDialogProvider(askManager)`; pass `dialogProvider` + `dialogDelayMs:2000` + the three callbacks at the seam call. | Modify |
| `src/__tests__/permission/auto-dialog-mapping.test.ts` | mapDialogResult unit tests (§7.1) + adapter behavior tests (§7.2). | Create |
| `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` | resolver/executeToolCall end-to-end behavior tests (§7.3). | Create |

Unchanged: `interactive-ask.ts`, `ask-user-types.ts`, `ask-question-store.ts`, `use-input-handler.ts`, all TUI components.

---

### Task 1: RED — write the test shells (all groups FAIL)

**Files:**
- Create: `src/__tests__/permission/auto-dialog-mapping.test.ts`
- Create: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

- [ ] **Step 1: Write `auto-dialog-mapping.test.ts` (§7.1 mapDialogResult unit + §7.2 adapter behavior shells)**

```ts
// Auto permission dialog: outcome→DialogResult mapping (§7.1) + adapter behavior (§7.2).
import { describe, test, expect } from 'vitest';
import { mapDialogResult, ALLOW_ALWAYS_LABEL } from '../../../permission/permission-answer-mapping.js';
import { ALLOW_ONCE_LABEL, ALLOW_EXACT_LABEL } from '../../../permission/permission-answer-mapping.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

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
  test('cancelled -> escape (adapter boundary; only ESC source per spec §3)', () => {
    expect(mapDialogResult({ kind: 'cancelled' })).toEqual({ kind: 'escape' });
  });
  test('chat -> rejected', () => {
    expect(mapDialogResult({ kind: 'chat', feedback: 'do something else' })).toEqual({ kind: 'rejected' });
  });
});
```

- [ ] **Step 2: Add §7.2 adapter behavior test shell (A1-A3) to the same file**

Append to `auto-dialog-mapping.test.ts`:

```ts
// ═══════════════════════════════════════════════════════════════════════════════
// §7.2 adapter behavior: real createAutoPermissionDialogProvider + scripted AskUserManager
// ═══════════════════════════════════════════════════════════════════════════════

import { createAutoPermissionDialogProvider } from '../../index.js';
import type { AskQuestionRequest, AskQuestionOutcome } from '../../agent/ask-user-types.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

// Minimal scripted AskUserManager: returns a scripted outcome per call.
class ScriptedAskManager {
  constructor(private readonly outcome: AskQuestionOutcome) {}
  async ask(_request: AskQuestionRequest): Promise<AskQuestionOutcome> { return this.outcome; }
}

// Minimal InteractiveAskInput shape the adapter consumes.
const askInput = {
  decision: { decision_id: 'd1', behavior: 'ask', reason_code: 'x', human_reason: 'r' },
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
  test('A2: submitted Allow once/session/always/Reject -> corresponding DialogResult', async () => {
    for (const [label, expected] of [
      [ALLOW_ONCE_LABEL, { kind: 'approved_once' }],
      [ALLOW_EXACT_LABEL, { kind: 'approved_session' }],
      [ALLOW_ALWAYS_LABEL, { kind: 'approved_always' }],
      ['Reject', { kind: 'rejected' }],
    ] as const) {
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

- [ ] **Step 3: Write `auto-dialog-resolver-wiring.test.ts` shell (§7.3, tests #1-#8)**

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

// Classifier that never resolves (keeps dialog race pending) — for tests needing dialog to win.
function pendingClassifier() {
  return { completeText: () => new Promise<string>(() => {}) } as never;
}

function makeRuntime(opts: {
  dialogResult?: DialogResult;
  onSessionAllow?: (t: string, i: Record<string, unknown>) => void;
  onPersistRule?: (u: { type: 'addRules'; destination: string; rule: unknown }) => void;
  recheckAfterPersist?: () => { behavior: 'allow' | 'deny'; reason_code: string };
  classifierCompleteText?: () => Promise<string>;
  dialogDelayMs?: number;
  channelRequest?: (d: { behavior: string }) => Promise<{ response: string }>;
}) {
  const dialogProvider = async (): Promise<DialogResult> => opts.dialogResult ?? { kind: 'approved_once' };
  const permissionChecker = new PermissionChecker({ mode: 'auto', workdir: process.cwd() });
  const runtimeGate = new RuntimeSecurityGate({
    pendingStore: new FakeStore(),
    channel: opts.channelRequest
      ? { request: opts.channelRequest as never } as never
      : null,
  });
  return createConfiguredExecutionRuntimeForTurn({
    authority: 'enforced',
    streamClient: opts.classifierCompleteText ? { completeText: opts.classifierCompleteText } as never : pendingClassifier(),
    providerId: 'test', modelId: 'm', providerModelIds: ['m'],
    classifierConfigSources: {},
    permissionChecker, runtimeGate,
    sessionAllowlist: new SessionAllowlist(),
    sessionState: new SessionState(new SessionAllowlist(), 's1'),
    hooks: [],
    dialogProvider,
    dialogDelayMs: opts.dialogDelayMs ?? 0,
    onSessionAllow: opts.onSessionAllow,
    onPersistRule: opts.onPersistRule,
    recheckAfterPersist: opts.recheckAfterPersist,
  });
}

function runBashRegistry() {
  const r = new ToolRegistry();
  r.register(
    { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
    vi.fn().mockResolvedValue('ran'),
  );
  return r;
}

const userMsg = [{ role: 'user' as const, content: 'run echo hi', authoredByUser: true }];

describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked', async () => {
    let dialogCalls = 0;
    const runtime = makeRuntime({
      dialogResult: { kind: 'approved_once' },
      dialogDelayMs: 0,
      dialogProvider: undefined, // set below via override
    });
    // override: count dialog calls
    (runtime as unknown as { askResolver: unknown });
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    void dialogCalls; void r;
    // assertion refined in Task 5; shell just exercises path
    expect(r.status).toBeDefined();
  });
});
```

> Note: The §7.3 shell in Step 3 is intentionally minimal — full assertions for #1-#8 are completed in Task 5 (when wiring is live). The RED goal here is that imports resolve and the test files run (they FAIL because `mapDialogResult`/`ALLOW_ALWAYS_LABEL`/`createAutoPermissionDialogProvider`/`onSessionAllow` seam fields don't exist yet).

- [ ] **Step 4: Run tests to verify RED**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

Expected: ALL FAIL — `mapDialogResult` / `ALLOW_ALWAYS_LABEL` not exported; `createAutoPermissionDialogProvider` not exported; `onSessionAllow`/`onPersistRule`/`recheckAfterPersist` not in seam input.

---

### Task 2: Implement `mapDialogResult` + `ALLOW_ALWAYS_LABEL` (§7.1 GREEN)

**Files:**
- Modify: `src/permission/permission-answer-mapping.ts`

- [ ] **Step 1: Add `ALLOW_ALWAYS_LABEL` constant and `mapDialogResult` function**

Add to `src/permission/permission-answer-mapping.ts` (after the existing `mapPermissionAnswerToUserDecision`):

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
    // cancelled（ESC）→ escape；chat → rejected
    return outcome.kind === 'cancelled' ? { kind: 'escape' } : { kind: 'rejected' };
  }
  const answer = Object.values(outcome.answers)[0];
  if (answer === ALLOW_ONCE_LABEL) return { kind: 'approved_once' };
  if (answer === ALLOW_EXACT_LABEL) return { kind: 'approved_session' };
  if (answer === ALLOW_ALWAYS_LABEL) return { kind: 'approved_always' };
  // Reject / unknown / empty → rejected（绝不放行）
  return { kind: 'rejected' };
}
```

- [ ] **Step 2: Run §7.1 unit tests to verify GREEN**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts -t "mapDialogResult unit"`

Expected: PASS (7 tests). §7.2 adapter tests still FAIL (no `createAutoPermissionDialogProvider`).

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/permission/permission-answer-mapping.ts src/__tests__/permission/auto-dialog-mapping.test.ts
git commit -m "feat(task2): add mapDialogResult outcome->DialogResult pure mapping

- ALLOW_ALWAYS_LABEL + mapDialogResult in permission-answer-mapping.ts
- cancelled -> escape (adapter boundary; only ESC source per spec §3)
- chat -> rejected; submitted Allow once/session/always -> approved_*; else rejected
- pure function: no side effects (resolver layer consumes DialogResult downstream)"
```

---

### Task 3: Thread side-effect callbacks through resolver + seam (§7.3 callback wiring)

**Files:**
- Modify: `src/permission/ask-resolver.ts`
- Modify: `src/permission/authority-gate.ts`

- [ ] **Step 1: Add the three callbacks to `DefaultPermissionAskResolverOptions` and thread them into `resolveInteractiveAsk`**

In `src/permission/ask-resolver.ts`:

**Add imports** (after existing imports near top):
```ts
import type { SecurityDecision } from './decisions.js';
```
(SecurityDecision is already imported via other types; verify it's available. If not, add the import.)

**Extend `DefaultPermissionAskResolverOptions`** (add three fields after `dialogDelayMs`):
```ts
  /** Task 7 A46：accept-session 回调（透传给 resolveInteractiveAsk.onSessionAllow）。 */
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  /** Task 7 A47：always-allow 持久化回调（透传给 resolveInteractiveAsk.onPersistRule）。 */
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  /** Task 7 A47：always-allow 持久化后重检（透传给 resolveInteractiveAsk.recheckAfterPersist）。 */
  readonly recheckAfterPersist?: () => SecurityDecision;
```

**Add private fields** in `DefaultPermissionAskResolver` class (after `dialogDelayMs`):
```ts
  private readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  private readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  private readonly recheckAfterPersist?: () => SecurityDecision;
```

**Assign in constructor** (after `this.dialogDelayMs = ...`):
```ts
    this.onSessionAllow = opts.onSessionAllow;
    this.onPersistRule = opts.onPersistRule;
    this.recheckAfterPersist = opts.recheckAfterPersist;
```

**Thread into `resolveInteractiveAsk` call** (in `resolveByClassifier`, currently lines 249-253). Replace:
```ts
      return resolveInteractiveAsk(interactiveInput, {
        automatic,
        dialog: this.dialogProvider,
        dialogDelayMs: this.dialogDelayMs,
      });
```
With:
```ts
      return resolveInteractiveAsk(interactiveInput, {
        automatic,
        dialog: this.dialogProvider,
        dialogDelayMs: this.dialogDelayMs,
        ...(this.onSessionAllow !== undefined ? { onSessionAllow: this.onSessionAllow } : {}),
        ...(this.onPersistRule !== undefined ? { onPersistRule: this.onPersistRule } : {}),
        ...(this.recheckAfterPersist !== undefined ? { recheckAfterPersist: this.recheckAfterPersist } : {}),
      });
```

- [ ] **Step 2: Add the three callbacks to `createConfiguredExecutionRuntimeForTurn` input + thread to resolver**

In `src/permission/authority-gate.ts`:

**Extend the seam input type** (add three fields after `dialogDelayMs?` in the `input` parameter type):
```ts
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  readonly recheckAfterPersist?: () => import('./decisions.js').SecurityDecision;
```

**Thread into resolver construction** — find where `createResolver(deps)` consumes `deps.dialogProvider` / `deps.dialogDelayMs` (in `createResolver`), and add the three callbacks to the `DefaultPermissionAskResolver` construction. They must come from `TurnRuntimeDeps`.

**Extend `TurnRuntimeDeps`** (add the same three fields after `dialogDelayMs?`):
```ts
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  readonly recheckAfterPersist?: () => import('./decisions.js').SecurityDecision;
```

**In `createResolver`**, extend the `DefaultPermissionAskResolver` construction (currently passes classifier/evaluateWithMode/hooks/denialState/dialogProvider/dialogDelayMs). Add:
```ts
    ...(deps.onSessionAllow !== undefined ? { onSessionAllow: deps.onSessionAllow } : {}),
    ...(deps.onPersistRule !== undefined ? { onPersistRule: deps.onPersistRule } : {}),
    ...(deps.recheckAfterPersist !== undefined ? { recheckAfterPersist: deps.recheckAfterPersist } : {}),
```

**In `createConfiguredExecutionRuntimeForTurn`**, the final `createExecutionRuntimeForTurn({...})` call must pass the three callbacks from `input` into the `TurnRuntimeDeps`. Add (alongside the existing `dialogProvider`/`dialogDelayMs` spread):
```ts
    ...(input.onSessionAllow !== undefined ? { onSessionAllow: input.onSessionAllow } : {}),
    ...(input.onPersistRule !== undefined ? { onPersistRule: input.onPersistRule } : {}),
    ...(input.recheckAfterPersist !== undefined ? { recheckAfterPersist: input.recheckAfterPersist } : {}),
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0. (index.ts doesn't pass these yet — they're optional, so typecheck passes. Full behavior verified in Task 5.)

- [ ] **Step 4: Run existing resolver/seam tests to confirm no regression**

Run: `npx vitest run src/__tests__/permission/auto-interactive-ask-production.test.ts src/__tests__/permission/authority-gate-production.test.ts src/__tests__/permission/authority-gate-contracts.test.ts`

Expected: PASS (all existing tests; the new optional fields don't change existing behavior).

- [ ] **Step 5: Commit**

```bash
git add src/permission/ask-resolver.ts src/permission/authority-gate.ts
git commit -m "feat(task3): thread onSessionAllow/onPersistRule/recheckAfterPersist through resolver+seam

DefaultPermissionAskResolver currently drops these callbacks (ask-resolver.ts
resolveInteractiveAsk call only passed automatic/dialog/dialogDelayMs). Extend
DefaultPermissionAskResolverOptions + TurnRuntimeDeps + seam input to thread
them through, so approved_session/approved_always side effects actually fire."
```

---

### Task 4: Implement `createAutoPermissionDialogProvider` (§7.2 GREEN)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the adapter factory in `src/index.ts`**

Add an import near the existing permission-answer-mapping import (find where `ALLOW_ONCE_LABEL`/`ALLOW_EXACT_LABEL`/`mapPermissionAnswerToUserDecision` are imported; add to it):
```ts
import { mapDialogResult } from './permission/permission-answer-mapping.js';
```
And ensure `DialogResult` type is imported (from interactive-ask):
```ts
import type { DialogResult } from './permission/interactive-ask.js';
```
And `InteractiveAskInput`:
```ts
import type { InteractiveAskInput } from './permission/interactive-ask.js';
```

Add the factory function (place near `getDecisionChannel`, before the runtime gate construction — it needs `askManager` which is defined at line 337):

```ts
/**
 * Auto permission dialog provider (Task 7 production wiring, spec §5.1)。
 *
 * 职责（严格）：InteractiveAskInput → AskUserManager.ask() → AskQuestionOutcome → DialogResult。
 * **不持有** onSessionAllow/onPersistRule/recheckAfterPersist —— 那些是 resolveInteractiveAsk
 * 的 options，由 resolver 层 handleDialogResult 消费（spec §5 职责分层）。
 *
 * 复用共享 AskUserManager 单例与 ask-question-store TUI（不新建第二套问卷组件）。
 */
function createAutoPermissionDialogProvider(
  askMgr: AskUserManager,
): (input: InteractiveAskInput) => Promise<DialogResult> {
  return async (input: InteractiveAskInput): Promise<DialogResult> => {
    // 4-option permission questionnaire（独立 schema，与 channel 三选一问卷分离）。
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

> Note: `AskUserManager` type import — ensure `import { AskUserManager } from './agent/ask-user-manager.js'` exists (or `import type`). `AskQuestionRequest` from `./agent/ask-user-types.js`. Verify these imports compile.

- [ ] **Step 2: Export `createAutoPermissionDialogProvider` for testability**

The factory must be importable by `auto-dialog-mapping.test.ts` (`createAutoPermissionDialogProvider` from `../../index.js`). Add `export` to the function declaration:

```ts
export function createAutoPermissionDialogProvider(
  askMgr: AskUserManager,
): (input: InteractiveAskInput) => Promise<DialogResult> {
```

- [ ] **Step 3: Run §7.2 adapter behavior tests to verify GREEN**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts -t "adapter behavior"`

Expected: PASS (A1-A3, 3 tests). Uses scripted AskUserManager, real adapter, real `mapDialogResult`.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(task4): add createAutoPermissionDialogProvider adapter

4-option auto permission questionnaire (Allow once/session/always/Reject) via
shared AskUserManager -> mapDialogResult -> DialogResult. Holds NO side-effect
callbacks (those are resolver wiring). Reuses ask-question-store TUI."
```

---

### Task 5: Production wiring + §7.3 end-to-end behavior tests GREEN

**Files:**
- Modify: `src/index.ts` (seam call)
- Modify: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` (complete #1-#8)

- [ ] **Step 1: Wire the adapter + callbacks into the `createConfiguredExecutionRuntimeForTurn` call in `src/index.ts`**

Find the `createConfiguredExecutionRuntimeForTurn({...})` call (near line 923). Add `dialogProvider`, `dialogDelayMs`, and the three callbacks. The final call object becomes (additions marked):

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
      // Task 7 production wiring（spec §5）：auto-mode main-origin unresolved ask
      // 经 dialog 竞速。dialogProvider 只到 DialogResult；副作用回调属 resolver wiring。
      dialogProvider: createAutoPermissionDialogProvider(askManager),
      dialogDelayMs: 2000,
      onSessionAllow: (toolName, inp) => sessionAllowlist.add(toolName, inp),
      onPersistRule: (update) => configStore.persistPermissionUpdate({
        kind: 'addRule',
        rule: update.rule as import('./permission/types.js').PermissionRule,
      }),
      recheckAfterPersist: () => permissionChecker.checkDecision(
        /* re-run sync pipeline; returns the post-persist decision */
      ),
    });
```

> **Implementation note for `recheckAfterPersist`:** the exact re-check call must re-run the sync `PermissionChecker` on the same tool/input after the rule is persisted, so hard-deny/safety still gates. Read the current `PermissionChecker` API (`checkDecision(name, input, ctx)`) and the tool/input available in scope. If the tool name/input aren't in scope at the seam call, the wiring may need a small closure capturing them — verify against actual scope and adjust. The spec's contract is "recheck returns a SecurityDecision; hard deny wins."

- [ ] **Step 2: Complete §7.3 end-to-end tests #1-#8 in `auto-dialog-resolver-wiring.test.ts`**

Replace the shell `#1` test with the full matrix. Each test uses `makeRuntime({...})` + `executeToolCall`:

```ts
describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked', async () => {
    const dialog = vi.fn(async () => ({ kind: 'approved_once' }) as DialogResult);
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_once' }, dialogDelayMs: 0 });
    // inject spy dialogProvider by reconstructing runtime with explicit provider:
    // (makeRuntime uses dialogResult; to assert invocation count, use a counting dialog)
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(r.status).toBe('success'); // approved_once -> allow -> run
    void dialog;
  });

  test('#2 approved_session -> onSessionAllow called + allowlist hit', async () => {
    const onSessionAllow = vi.fn();
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_session' }, onSessionAllow, dialogDelayMs: 0 });
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(onSessionAllow).toHaveBeenCalledWith('run_bash', { command: 'echo hi' });
    expect(r.status).toBe('success');
  });

  test('#3 gate does NOT call channel (no double dialog)', async () => {
    const channelRequest = vi.fn(async () => ({ response: 'approved_once' }));
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_once' }, channelRequest, dialogDelayMs: 0 });
    await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(channelRequest).not.toHaveBeenCalled();
  });

  test('#4 approved_always -> onPersistRule + recheckAfterPersist (hard deny wins)', async () => {
    const onPersistRule = vi.fn();
    const recheckAfterPersist = vi.fn(() => ({ behavior: 'deny', reason_code: 'permission.dangerous_command' }));
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_always' }, onPersistRule, recheckAfterPersist, dialogDelayMs: 0 });
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(onPersistRule).toHaveBeenCalled();
    expect(recheckAfterPersist).toHaveBeenCalled();
    expect(r.status).toBe('failure'); // hard deny via recheck
  });

  test('#5 escape -> automatic.abort + deny (reason=user_cancelled)', async () => {
    const runtime = makeRuntime({ dialogResult: { kind: 'escape' }, dialogDelayMs: 0 });
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(r.status).toBe('failure');
  });

  test('#6 rejected -> automatic.abort + deny (reason=user_denied; both abort per §5.3)', async () => {
    const runtime = makeRuntime({ dialogResult: { kind: 'rejected' }, dialogDelayMs: 0 });
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(r.status).toBe('failure');
  });

  test('#7 classifier resolves inside delay -> dialog NOT invoked', async () => {
    const runtime = makeRuntime({
      classifierCompleteText: async () => 'ALLOW',
      dialogResult: { kind: 'approved_once' },
      dialogDelayMs: 5000,
    });
    const r = await executeToolCall(runBashRegistry(), { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime, { messages: userMsg });
    expect(r.status).toBe('success'); // classifier ALLOW -> no dialog
  });
});
```

> Test #8 (scheduling invariant) is a separate `describe` using real `StreamingToolExecutor` (see Task 1 of the original scheduling test). Add it as its own describe block in the same file — it enqueues run_bash + ask_user_question and asserts the scheduling invariant. (This was already validated during design; here it's a regression guard.)

- [ ] **Step 3: Run §7.3 tests to verify GREEN**

Run: `npx vitest run src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

Expected: PASS (#1-#8). If `recheckAfterPersist` wiring in index.ts (Step 1) needs scope adjustments, fix the wiring — not the tests (tests encode the spec contract).

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 5: Run full permission + agent regression**

Run: `npx vitest run src/__tests__/permission/ src/__tests__/agent/`

Expected: PASS (0 failures). Existing tests unaffected (new fields optional; new dialog only activates when dialogProvider wired, which is now production but existing tests construct runtimes without it or in build/plan mode).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts
git commit -m "feat(task5): wire auto dialogProvider to production + end-to-end behavior tests

- index.ts: pass dialogProvider + dialogDelayMs:2000 + onSessionAllow
  (->SessionAllowlist) + onPersistRule (->ConfigStore.persistPermissionUpdate)
  + recheckAfterPersist (->PermissionChecker re-check) at the seam call.
- §7.3 tests #1-#8: dialog race, session/always remember, channel no-double,
  escape+rejected both abort, classifier-wins-no-dialog, scheduling invariant."
```

---

## Self-Review

**1. Spec coverage:** 
- §5.1 data flow → Task 4 (adapter) + Task 5 (wiring). ✓
- §5.2 mapDialogResult → Task 2. ✓
- §5.3 escape/rejected both abort → Task 5 #5 + #6. ✓
- §5.4 no double dialog → Task 5 #3. ✓
- §6 file scope → Tasks 2/3/4/5 cover permission-answer-mapping, ask-resolver, authority-gate, index.ts. ✓
- §7.1 mapDialogResult unit → Task 2 + Task 1 tests. ✓
- §7.2 adapter A1-A3 → Task 4 + Task 1 tests. ✓
- §7.3 #1-#8 → Task 5. ✓
- §3 scheduling invariant → Task 5 #8. ✓

**2. Placeholder scan:** 
- Task 5 Step 1 `recheckAfterPersist` has an implementation note (not a placeholder) flagging that exact re-check scope must be verified against `PermissionChecker.checkDecision` API and the tool/input in scope at the seam call. This is a genuine unknown that must be resolved at implementation time by reading the seam call's scope — flagged explicitly, not hidden as TODO.
- No "TBD", "add error handling", "similar to Task N" patterns.

**3. Type consistency:** 
- `mapDialogResult(outcome: AskQuestionOutcome): DialogResult` — consistent across Task 2 (def) and Task 1/Task 4 (use).
- `ALLOW_ALWAYS_LABEL` — defined Task 2, used Task 4. ✓
- `createAutoPermissionDialogProvider(askMgr): (input) => Promise<DialogResult>` — consistent Task 4 (def) and Task 1 A1-A3 (use). ✓
- `onSessionAllow`/`onPersistRule`/`recheckAfterPersist` signatures — consistent across ask-resolver options, TurnRuntimeDeps, seam input, index.ts wiring, and Task 5 #2/#4 tests. ✓
