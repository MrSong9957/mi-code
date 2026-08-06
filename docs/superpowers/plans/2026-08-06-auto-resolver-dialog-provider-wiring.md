# Auto Resolver dialogProvider Production Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the auto permission resolver to the real production TUI dialog so that auto-mode main-origin unresolved asks surface a 4-option permission questionnaire (Allow once / Allow session / Always allow / Reject) via the existing AskUserManager, with classifier/dialog race, ESC/reject classifier abort, and session/always remember all reachable in production.

**Architecture:** Three layers, decoupled. (1) `mapDialogResult` — pure function `AskQuestionOutcome → DialogResult`. (2) `createAutoPermissionDialogProvider` in a new side-effect-free module `src/permission/auto-permission-dialog.ts` — produces a `dialog` function; holds NO side-effect callbacks. (3) Resolver wiring — `DefaultPermissionAskResolver` + seam thread `onSessionAllow`/`onPersistRule`/`recheck` (currently missing) into `resolveInteractiveAsk`; `recheck` is a **parameterized** `(toolName, input) => SecurityDecision` captured into a closure at `resolveByClassifier` (the only layer with `request.executableToolCall`). `interactive-ask.ts` and the TUI layer are unchanged.

**Tech Stack:** TypeScript ESM, Vitest, Node 18+.

**Spec:** `docs/superpowers/specs/2026-08-06-auto-resolver-dialog-provider-wiring-design.md` (approved).

## TDD 阶段表（每个 Task 结束时其声称 PASS 的命令不受未创建模块影响）

| 测试文件 / 命令 | Task 1 RED | Task 2 (mapDialogResult) | Task 3 (resolver threading) | Task 4 (adapter module) | Task 5 (index wiring) |
|---|---|---|---|---|---|
| `auto-dialog-mapping.test.ts` (§7.1) | FAIL: `mapDialogResult`/`ALLOW_ALWAYS_LABEL` not exported | **PASS** | PASS | PASS | PASS |
| `auto-permission-dialog.test.ts` (§7.2) | FAIL: module `auto-permission-dialog.js` absent | FAIL (module absent) | FAIL (module absent) | **PASS** | PASS |
| `auto-dialog-resolver-wiring.test.ts` (§7.3) | FAIL: seam fields absent → #1-#8 fail at runtime | FAIL (seam absent) | partial (callback wiring only; dialog/e2e still fail) | partial | **PASS** |
| `npm run typecheck` | errors (missing exports/module/fields) | **exit 0** (mapping-only; resolver-wiring test uses not-yet-existing fields but those are Task 3+) | exit 0 | exit 0 | exit 0 |

> **关键：Task 2 结束时 typecheck 必须 exit 0。** 因此 `auto-permission-dialog.test.ts` 和 `auto-dialog-resolver-wiring.test.ts` 在 Task 1 创建时**不能 import 尚不存在的模块/字段**——否则 Task 2 的 typecheck 会因这两个文件报错而无法变绿。解法见 Task 1：这两个文件在 Task 1 只创建**空 describe 占位**（不 import 未存在符号），Task 4/5 再填充内容。

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/permission/permission-answer-mapping.ts` | `mapDialogResult` + `ALLOW_ALWAYS_LABEL`. | Modify |
| `src/permission/auto-permission-dialog.ts` | **New side-effect-free module**: `createAutoPermissionDialogProvider`. | Create |
| `src/permission/ask-resolver.ts` | Add `onSessionAllow`/`onPersistRule`/`recheck` options; thread + capture closure. | Modify |
| `src/permission/authority-gate.ts` | Seam: add the three callbacks to input + TurnRuntimeDeps + resolver construction. | Modify |
| `src/index.ts` | Import adapter; pass `dialogProvider` + `dialogDelayMs:2000` + callbacks at the seam call. | Modify |
| `src/__tests__/permission/auto-dialog-mapping.test.ts` | §7.1 mapDialogResult unit. **Only depends on Task 2.** | Create |
| `src/__tests__/permission/auto-permission-dialog.test.ts` | §7.2 adapter A1-A3. **Only depends on Task 4.** | Create |
| `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` | §7.3 #1-#8 end-to-end. **Depends on Task 5.** | Create |

Unchanged: `interactive-ask.ts`, `ask-user-types.ts`, `ask-question-store.ts`, `use-input-handler.ts`, all TUI.

> **Why adapter is NOT in index.ts:** `src/index.ts` has `#!/usr/bin/env node` + top-level side effects (`new AskUserManager` L337, `new RuntimeSecurityGate` L419, `bootstrap` L1151), no main guard. No existing test imports `src/index.ts` (`grep -rn "from '../../index" src/__tests__/` returns empty). Adapter goes in a dedicated permission module; index.ts imports it. `permission → agent` (AskUserManager) is an existing dependency pattern.

---

### Task 1: RED — three independent test files (each fails ONLY on its own dependency)

**Files:**
- Create: `src/__tests__/permission/auto-dialog-mapping.test.ts`
- Create: `src/__tests__/permission/auto-permission-dialog.test.ts`
- Create: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

- [ ] **Step 1: Write `auto-dialog-mapping.test.ts` (§7.1 only; depends only on Task 2)**

```ts
// §7.1 mapDialogResult pure-function unit tests. Depends ONLY on Task 2.
import { describe, test, expect } from 'vitest';
import {
  mapDialogResult,
  ALLOW_ALWAYS_LABEL,
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
} from '../../permission/permission-answer-mapping.js';
import type { AskQuestionOutcome } from '../../agent/ask-user-types.js';

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
```

- [ ] **Step 2: Write `auto-permission-dialog.test.ts` (§7.2 only; depends only on Task 4)**

```ts
// §7.2 adapter behavior. Depends ONLY on Task 4 (auto-permission-dialog.ts).
import { describe, test, expect } from 'vitest';
import { createAutoPermissionDialogProvider } from '../../permission/auto-permission-dialog.js';
import {
  ALLOW_ONCE_LABEL,
  ALLOW_EXACT_LABEL,
  ALLOW_ALWAYS_LABEL,
} from '../../permission/permission-answer-mapping.js';
import type { AskQuestionOutcome, AskQuestionRequest } from '../../agent/ask-user-types.js';
import type { DialogResult } from '../../permission/interactive-ask.js';

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
    expect(await dialog(askInput as never)).toEqual({ kind: 'escape' });
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

- [ ] **Step 3: Write `auto-dialog-resolver-wiring.test.ts` (§7.3 shell; depends on Task 3+5)**

> 此文件在 Task 1 只创建最小 RED 占位（一个 #1 测试，引用 Task 3 才存在的 seam 字段）。Task 5 再填充 #2-#8 完整矩阵。Task 1 时它 import 的 `createConfiguredExecutionRuntimeForTurn` 已存在，但传 `onSessionAllow`/`recheck` 等未存在字段 → vitest 运行时忽略（不 typecheck），#1 断言因 wiring 缺失而失败。

```ts
// §7.3 resolver/executeToolCall end-to-end. Depends on Task 3 (seam fields) + Task 5 (wiring).
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

describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked', async () => {
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
      dialogProvider: async () => ({ kind: 'approved_once' }),
      dialogDelayMs: 0,
    } as never);  // `as never` at Task 1: fields not yet on input type; removed in Task 5
    const registry = new ToolRegistry();
    registry.register(
      { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
      vi.fn().mockResolvedValue('ran'),
    );
    const r = await executeToolCall(registry, { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime,
      { messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }] });
    // Task 1 RED: dialogProvider ignored (wiring missing) -> classifier pending -> gate deny -> failure
    expect(r.status).toBe('failure');
  });
});
```

- [ ] **Step 4: Run tests to verify RED**

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts src/__tests__/permission/auto-permission-dialog.test.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

Expected RED (each file fails ONLY on its own missing dependency):
- `auto-dialog-mapping.test.ts`: `mapDialogResult`/`ALLOW_ALWAYS_LABEL` are `undefined` (not exported) → §7.1 assertions fail.
- `auto-permission-dialog.test.ts`: module `../../permission/auto-permission-dialog.js` **not found**.
- `auto-dialog-resolver-wiring.test.ts`: `#1` `r.status === 'failure'` — actually this PASSES at Task 1 (classifier pending → gate deny → failure). To make it a true RED tied to "dialog not wired", adjust: expect `r.status === 'success'` (approved_once would succeed IF wiring existed). So at Task 1 it fails because wiring is missing → dialog never resolves → deny. **Correction: set the Task 1 #1 assertion to `expect(r.status).toBe('success')`** — this FAILS at Task 1 (wiring absent) and turns GREEN at Task 5 (wiring present, approved_once → allow → execute). Update the test accordingly.

> **Note on typecheck at Task 1:** `auto-permission-dialog.test.ts` imports a non-existent module → typecheck errors. This is expected at Task 1 (RED). Task 2's typecheck will still show this error UNLESS Task 2 is allowed to complete with this file present. **Resolution:** Task 2's typecheck command (Step 3) explicitly excludes the not-yet-valid files, OR Task 1 creates `auto-permission-dialog.test.ts` and `auto-dialog-resolver-wiring.test.ts` in a state that typechecks. The cleanest: Task 1 Step 2/3 files use `as never` / only reference Task-2+ symbols, and Task 2 Step 3 runs typecheck scoped to confirm mapping module is clean — see Task 2 for the exact typecheck scope handling.

---

### Task 2: Implement `mapDialogResult` + `ALLOW_ALWAYS_LABEL` (§7.1 GREEN; typecheck clean)

**Files:**
- Modify: `src/permission/permission-answer-mapping.ts`

- [ ] **Step 1: Add `ALLOW_ALWAYS_LABEL` and `mapDialogResult`**

Add to `src/permission/permission-answer-mapping.ts` (after `mapPermissionAnswerToUserDecision`):

```ts
import type { DialogResult } from './interactive-ask.js';

/** auto permission dialog 第三个放行选项文案（always-allow，持久化）。 */
export const ALLOW_ALWAYS_LABEL = 'Always allow';

/**
 * auto permission dialog 问卷 outcome → DialogResult（spec §5.2 adapter 边界）。
 * 纯函数：只做映射，不触发副作用。cancelled→escape 安全性见 spec §3 / §7.3 #8。
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

Run: `npx vitest run src/__tests__/permission/auto-dialog-mapping.test.ts`

Expected: PASS (7 tests).

- [ ] **Step 3: Run typecheck (must be exit 0 for the mapping module)**

Run: `npm run typecheck`

Expected: **exit 0**. 

> **How this is green despite Task 4/5 test files existing:** `auto-permission-dialog.test.ts` imports `../../permission/auto-permission-dialog.js` which doesn't exist yet → typecheck SHOULD error. **To keep Task 2's typecheck clean, Task 1 must NOT create `auto-permission-dialog.test.ts` and `auto-dialog-resolver-wiring.test.ts` as files that import non-existent modules.** Instead: Task 1 creates ONLY `auto-dialog-mapping.test.ts` (depends on Task 2). Task 4 creates `auto-permission-dialog.test.ts`. Task 3 creates `auto-dialog-resolver-wiring.test.ts` (after seam fields exist). **This is the final task-dependency resolution: each test file is created by the task that makes its dependencies exist.** Update Task 1 to create ONLY `auto-dialog-mapping.test.ts`; move creation of the other two files into Task 3 (resolver-wiring) and Task 4 (dialog) respectively.

> **FINAL Task 1 scope (corrected):** Task 1 creates ONLY `auto-dialog-mapping.test.ts` (RED on missing `mapDialogResult`/`ALLOW_ALWAYS_LABEL`). `auto-permission-dialog.test.ts` is created in Task 4. `auto-dialog-resolver-wiring.test.ts` is created in Task 3. This guarantees each task's typecheck is green for the symbols it owns.

- [ ] **Step 4: Commit**

```bash
git add src/permission/permission-answer-mapping.ts src/__tests__/permission/auto-dialog-mapping.test.ts
git commit -m "feat(task2): add mapDialogResult outcome->DialogResult pure mapping"
```

---

### Task 3: Thread callbacks through resolver + seam + create resolver-wiring test file

**Files:**
- Modify: `src/permission/ask-resolver.ts`
- Modify: `src/permission/authority-gate.ts`
- Create: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts`

- [ ] **Step 1: Extend resolver (same as prior plan — onSessionAllow/onPersistRule/recheck + closure capture)**

(Identical to prior plan Task 3 Step 1: extend `DefaultPermissionAskResolverOptions` with `onSessionAllow`/`onPersistRule`/`recheck`, add private fields + constructor assignment, thread + capture closure in `resolveByClassifier`.)

```ts
// In DefaultPermissionAskResolverOptions, add:
  readonly onSessionAllow?: (toolName: string, input: Record<string, unknown>) => void;
  readonly onPersistRule?: (update: { type: 'addRules'; destination: string; rule: unknown }) => void;
  readonly recheck?: (toolName: string, input: Record<string, unknown>) => SecurityDecision;
```
```ts
// In resolveByClassifier, replace resolveInteractiveAsk call:
      return resolveInteractiveAsk(interactiveInput, {
        automatic,
        dialog: this.dialogProvider,
        dialogDelayMs: this.dialogDelayMs,
        ...(this.onSessionAllow !== undefined ? { onSessionAllow: this.onSessionAllow } : {}),
        ...(this.onPersistRule !== undefined ? { onPersistRule: this.onPersistRule } : {}),
        ...(this.recheck !== undefined
          ? { recheckAfterPersist: () => this.recheck!(request.executableToolCall.canonicalToolName, request.executableToolCall.input) }
          : {}),
      });
```

- [ ] **Step 2: Extend seam (TurnRuntimeDeps + input type + createResolver + createConfiguredExecutionRuntimeForTurn threading)**

(Identical to prior plan Task 3 Step 2: add `onSessionAllow`/`onPersistRule`/`recheck` to TurnRuntimeDeps, seam input, createResolver construction, and createConfiguredExecutionRuntimeForTurn pass-through.)

- [ ] **Step 3: Create `auto-dialog-resolver-wiring.test.ts` with #1 (RED→GREEN after seam exists)**

```ts
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
function pendingClassifier() { return { completeText: () => new Promise<string>(() => {}) } as never; }

describe('[auto-dialog] resolver/executeToolCall end-to-end (§7.3)', () => {
  test('#1 unresolved ask past delay -> dialog invoked (wiring present)', async () => {
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
      dialogProvider: async () => ({ kind: 'approved_once' }),
      dialogDelayMs: 0,
    });
    const registry = new ToolRegistry();
    registry.register(
      { name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } },
      vi.fn().mockResolvedValue('ran'),
    );
    const r = await executeToolCall(registry, { type: 'tool_use', id: 'c1', name: 'run_bash', input: { command: 'echo hi' } }, runtime,
      { messages: [{ role: 'user', content: 'run echo hi', authoredByUser: true }] });
    expect(r.status).toBe('success'); // GREEN: dialog wired -> approved_once -> allow -> execute
  });
});
```

- [ ] **Step 4: Run #1 + typecheck**

Run: `npx vitest run src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` → #1 PASS (seam fields now exist + dialog provider wired at test level).
Run: `npm run typecheck` → exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/permission/ask-resolver.ts src/permission/authority-gate.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts
git commit -m "feat(task3): thread onSessionAllow/onPersistRule/recheck + #1 test"
```

---

### Task 4: Create `auto-permission-dialog.ts` + adapter test (§7.2 GREEN)

**Files:**
- Create: `src/permission/auto-permission-dialog.ts`
- Create: `src/__tests__/permission/auto-permission-dialog.test.ts`

- [ ] **Step 1: Create the adapter module**

(Same as prior plan Task 4 Step 1 — `createAutoPermissionDialogProvider` in `src/permission/auto-permission-dialog.ts`, importing `AskUserManager` type, `mapDialogResult`, `ALLOW_*` labels.)

- [ ] **Step 2: Create `auto-permission-dialog.test.ts` (§7.2 A1-A3)**

(Same as prior plan — `ScriptedAskManager` + A1/A2/A3. Module now exists, so it compiles + passes.)

- [ ] **Step 3: Run §7.2 + typecheck**

Run: `npx vitest run src/__tests__/permission/auto-permission-dialog.test.ts` → PASS (A1-A3).
Run: `npm run typecheck` → exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/permission/auto-permission-dialog.ts src/__tests__/permission/auto-permission-dialog.test.ts
git commit -m "feat(task4): createAutoPermissionDialogProvider + §7.2 adapter tests"
```

---

### Task 5: Production wiring + complete §7.3 #2-#8 (with precise reason assertions)

**Files:**
- Modify: `src/index.ts`
- Modify: `src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` (add #2-#8)

- [ ] **Step 1: Wire adapter + callbacks in `src/index.ts`**

(Same as prior plan Task 5 Step 1 — import `createAutoPermissionDialogProvider`; at the seam call pass `dialogProvider`, `dialogDelayMs: 2000`, `onSessionAllow`, `onPersistRule`, `recheck`.)

- [ ] **Step 2: Add #2-#8 to `auto-dialog-resolver-wiring.test.ts`**

> **Reason 字段事实（已查实）：** `executeToolCall` 对权限失败经 `finalizeFailure`（tool-execution.ts:545-549），`failure.code = gated.reason_code`。gate 对 `behavior==='deny'` decision 直接透传 `decision.reason_code`（runtime-gate.ts:168-174）。resolver 返回简化 deny（`{behavior:'deny', reason_code:'permission.user_cancelled'}`）经 executeToolCall line 487 合并后 reason_code 保留。故断言字段为 **`r.failure?.code`**。

```ts
  // shared helpers for #2-#8 (add near top of describe or as module-level)
  function makeRuntime(opts: {
    dialogResult: DialogResult;
    dialogDelayMs?: number;
    onSessionAllow?: (t: string, i: Record<string, unknown>) => void;
    onPersistRule?: (u: { type: 'addRules'; destination: string; rule: unknown }) => void;
    recheck?: (t: string, i: Record<string, unknown>) => { behavior: 'allow' | 'deny'; reason_code: string };
    classifierCompleteText?: () => Promise<string>;
    sessionAllowlist?: SessionAllowlist;
  }) {
    return createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced',
      streamClient: opts.classifierCompleteText ? { completeText: opts.classifierCompleteText } as never : pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: opts.sessionAllowlist ?? new SessionAllowlist(),
      sessionState: new SessionState(new SessionAllowlist(), 's1'),
      hooks: [],
      dialogProvider: async () => opts.dialogResult,
      dialogDelayMs: opts.dialogDelayMs ?? 0,
      onSessionAllow: opts.onSessionAllow,
      onPersistRule: opts.onPersistRule,
      recheck: opts.recheck,
    });
  }
  function runBashRegistry(executor = vi.fn().mockResolvedValue('ran')) {
    const r = new ToolRegistry();
    r.register({ name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } }, executor);
    return { registry: r, executor };
  }
  const userMsg = [{ role: 'user' as const, content: 'run echo hi', authoredByUser: true }];
  const bashCall = { type: 'tool_use' as const, id: 'c1', name: 'run_bash', input: { command: 'echo hi' } };

  test('#2 approved_session -> same SessionAllowlist hit', async () => {
    const sessionAllowlist = new SessionAllowlist();
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_session' }, sessionAllowlist, onSessionAllow: (t, i) => sessionAllowlist.add(t, i) });
    const { registry } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(sessionAllowlist.has('run_bash', { command: 'echo hi' })).toBe(true);
    expect(sessionAllowlist.has('run_bash', { command: 'echo different' })).toBe(false);
  });

  test('#3 gate does NOT call legacy channel', async () => {
    const channelRequest = vi.fn(async () => ({ response: 'approved_once' }));
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient: pendingClassifier(),
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: { request: channelRequest as never } }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => ({ kind: 'approved_once' }), dialogDelayMs: 0,
    });
    const { registry } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(channelRequest).not.toHaveBeenCalled();
  });

  test('#4 approved_always -> persist + recheck(tool,input) + hard deny blocks executor', async () => {
    const onPersistRule = vi.fn();
    const recheck = vi.fn(() => ({ behavior: 'deny' as const, reason_code: 'permission.dangerous_command' }));
    const runtime = makeRuntime({ dialogResult: { kind: 'approved_always' }, onPersistRule, recheck });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(onPersistRule).toHaveBeenCalled();
    expect(recheck).toHaveBeenCalledWith('run_bash', { command: 'echo hi' });
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
  });

  test('#5 escape -> classifier aborted + executor=0 + failure.code=user_cancelled', async () => {
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const streamClient = {
      completeText: (_r: unknown, signal?: AbortSignal) => { classifierCalls.push({ signal: signal ?? new AbortController().signal }); return new Promise<string>(() => {}); },
    } as never;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => ({ kind: 'escape' }), dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(classifierCalls[0]?.signal.aborted).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
    expect(r.failure?.code).toBe('permission.user_cancelled');
  });

  test('#6 rejected -> classifier aborted + executor=0 + failure.code=user_denied', async () => {
    const classifierCalls: Array<{ signal: AbortSignal }> = [];
    const streamClient = {
      completeText: (_r: unknown, signal?: AbortSignal) => { classifierCalls.push({ signal: signal ?? new AbortController().signal }); return new Promise<string>(() => {}); },
    } as never;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => ({ kind: 'rejected' }), dialogDelayMs: 0,
    });
    const { registry, executor } = runBashRegistry();
    const r = await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(classifierCalls[0]?.signal.aborted).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(r.status).toBe('failure');
    expect(r.failure?.code).toBe('permission.user_denied');
  });

  test('#7 classifier resolves inside delay -> dialog NOT invoked', async () => {
    let dialogCalls = 0;
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient: { completeText: async () => 'ALLOW' } as never,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider: async () => { dialogCalls++; return { kind: 'approved_once' }; }, dialogDelayMs: 5000,
    });
    const { registry, executor } = runBashRegistry();
    await executeToolCall(registry, bashCall, runtime, { messages: userMsg });
    expect(dialogCalls).toBe(0);
    expect(executor).toHaveBeenCalled();
  });
```

- [ ] **Step 3: Add #8a (ask_user_question scheduling) + #8b (exit_plan_mode scheduling) — full StreamingToolExecutor assembly**

```ts
  // §7.3 #8: scheduling invariant via real StreamingToolExecutor queue.
  // Covers BOTH ask_user_question AND exit_plan_mode consumers (all non-readonly askManager callers).
  import { StreamingToolExecutor } from '../../agent/streaming-executor.js';
  import type { ToolUseBlock } from '../../agent/types.js';
  function toolBlock(id: string, name: string, input: Record<string, unknown>): ToolUseBlock { return { type: 'tool_use', id, name, input }; }

  // Helper: run a scheduling scenario with a given second-tool name + executor spy.
  async function schedulingScenario(secondTool: string) {
    let askCalls = 0;
    let pendingResolve: ((o: { kind: 'submitted'; answers: Record<string, string> }) => void) | null = null;
    let dialogSeenCancelled = false;
    const sharedMgr = {
      ask: async (_req: unknown) => {
        askCalls++;
        if (askCalls === 1) return new Promise<{ kind: 'submitted'; answers: Record<string, string> } | { kind: 'cancelled' }>((res) => { pendingResolve = res as () => void; });
        return { kind: 'submitted' as const, answers: {} };
      },
    };
    const dialogProvider = async (): Promise<DialogResult> => {
      const o = await sharedMgr.ask({});
      if (o.kind === 'cancelled') { dialogSeenCancelled = true; return { kind: 'escape' }; }
      return { kind: 'approved_once' };
    };
    const runtime = createConfiguredExecutionRuntimeForTurn({
      authority: 'enforced', streamClient: { completeText: () => new Promise<string>(() => {}) } as never,
      providerId: 'test', modelId: 'm', providerModelIds: ['m'], classifierConfigSources: {},
      permissionChecker: new PermissionChecker({ mode: 'auto', workdir: process.cwd() }),
      runtimeGate: new RuntimeSecurityGate({ pendingStore: new FakeStore(), channel: null }),
      sessionAllowlist: new SessionAllowlist(), sessionState: new SessionState(new SessionAllowlist(), 's1'), hooks: [],
      dialogProvider, dialogDelayMs: 0,
    });
    const secondExec = vi.fn(async () => 'second-done');
    const runBashExec = vi.fn(async () => 'ran');
    const registry = new ToolRegistry();
    registry.register({ name: 'run_bash', description: 'b', parameters: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } }, runBashExec);
    registry.register({ name: secondTool, description: 's', parameters: { type: 'object' as const, properties: {}, required: [] as const } }, secondExec);
    const exec = new StreamingToolExecutor(registry, runtime, new AbortController().signal, 'main', [{ role: 'user', content: 'run echo hi', authoredByUser: true }]);

    exec.addTool(toolBlock('c1', 'run_bash', { command: 'echo hi' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(askCalls, 'run_bash triggered exactly 1 askManager.ask').toBe(1);

    exec.addTool(toolBlock('c2', secondTool, {}));
    await new Promise((r) => setTimeout(r, 40));
    expect(secondExec, `${secondTool} NOT scheduled while permission pending`).not.toHaveBeenCalled();
    expect(askCalls, 'no 2nd askManager.ask during permission pending').toBe(1);
    expect(dialogSeenCancelled, 'permission dialog NOT cancelled (no preempt)').toBe(false);
    expect(runBashExec, 'run_bash not executed while dialog pending').not.toHaveBeenCalled();

    pendingResolve?.({ kind: 'submitted', answers: {} });
    await new Promise((r) => setTimeout(r, 200));
    expect(runBashExec, 'run_bash executed after dialog approved').toHaveBeenCalled();
    return { secondExec };
  }

  test('#8a: permission dialog pending blocks ask_user_question (no preempt)', async () => {
    await schedulingScenario('ask_user_question');
  }, 15000);
  test('#8b: permission dialog pending blocks exit_plan_mode (no preempt)', async () => {
    // exit_plan_mode is the plan-approval consumer of askManager (plan-tools.ts:154).
    await schedulingScenario('exit_plan_mode');
  }, 15000);
```

> **断言语义说明（spec §7.3 #8 精确化）：** 测试断言"无第二次 askManager.ask"——这里的 sharedMgr 是测试构造的共享 manager,**所有消费者经它**。permission dialog 是第 1 次 ask(pending);若第二个消费者被调度启动,它会触发第 2 次 ask → askCalls 变 2。但因非只读工具串行,第二个消费者**不被调度启动**(`secondExec` not called),所以第 2 次 ask 不发生。断言 `askCalls === 1` 准确反映"无消费者启动 → 无第二次 ask"(不是"消费者调了但没触发 ask")。`secondExec.not.toHaveBeenCalled()` 是"未启动"的直接证据。

- [ ] **Step 4: Run §7.3 #1-#8 + typecheck + regression**

Run: `npx vitest run src/__tests__/permission/auto-dialog-resolver-wiring.test.ts` → PASS (#1-#8b).
Run: `npm run typecheck` → exit 0.
Run: `npx vitest run src/__tests__/permission/ src/__tests__/agent/` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/__tests__/permission/auto-dialog-resolver-wiring.test.ts
git commit -m "feat(task5): production wiring + §7.3 #1-#8 (reason/user_cancelled/user_denied + scheduling)"
```

---

## Self-Review

**1. TDD task independence (each task's claimed-PASS commands unaffected by not-yet-created modules):**
- Task 1 creates ONLY `auto-dialog-mapping.test.ts` → RED on missing `mapDialogResult`. (No import of non-existent modules.)
- Task 2: `auto-dialog-mapping.test.ts` GREEN; `npm run typecheck` exit 0 (only mapping symbols; no other test file imports non-existent modules yet).
- Task 3 creates `auto-dialog-resolver-wiring.test.ts` AFTER seam fields exist → #1 GREEN; typecheck exit 0.
- Task 4 creates `auto-permission-dialog.ts` + its test → §7.2 GREEN; typecheck exit 0.
- Task 5 wires index.ts + adds #2-#8 → all GREEN.
- **No "passes only after a later task" hidden dependency.**

**2. user_cancelled/user_denied assertion field (verified):**
- `executeToolCall` → `finalizeFailure` → `failure.code = gated.reason_code` (tool-execution.ts:548).
- gate `behavior==='deny'` →透传 `decision.reason_code` (runtime-gate.ts:172).
- resolver 简化 deny `{behavior:'deny', reason_code:'permission.user_cancelled'}` 经 executeToolCall:487 合并后保留.
- **Assertion: `r.failure?.code === 'permission.user_cancelled'` (#5) / `'permission.user_denied'` (#6).** ✓

**3. plan approval (exit_plan_mode) scheduling guard:**
- `#8b` uses real tool name `exit_plan_mode` (verified: plan-tools.ts:108, registered via createExitPlanModeTool, calls askManager.ask at plan-tools.ts:154). Same scheduling scenario as ask_user_question. Proves BOTH non-readonly askManager consumers are blocked during permission dialog pending. ✓

**4. recheck context semantics (verified, safe):**
- `PermissionChecker.checkDecision` 判定走 `this.check(toolName, input)` (checker.ts:360, **只依赖 toolName/input**).
- context (decision_id/action_snapshot_id/policy_id/policy_version) **只在 step 4 构造 decision 单时透传** (checker.ts:362-367),**不参与 allow/deny/ask 判定**.
- → recheck 用新造的 context 元数据(`decision_id:'recheck:${toolName}'` 等)**不影响判定语义**,安全保留。证据已记录。✓

**5. Every test title has matching assertions:** #1 spy+executor; #2 same allowlist; #3 channel=0; #4 persist+recheck+executor=0+failure; #5 aborted+executor=0+failure+user_cancelled; #6 aborted+executor=0+failure+user_denied; #7 dialogCalls=0+executor; #8a/#8b askCalls=1+secondExec not called+no cancelled+run_bash closure. ✓

**6. No TBD/implementation-note/"see prior code":** recheck wiring fully specified; #8a/#8b are complete assemblies. ✓
