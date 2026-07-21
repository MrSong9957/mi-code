# AUTO-0025 AskUserQuestion Questionnaire Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy single-text `ask_user_question` flow with a Claude Code-style 1–4 question questionnaire and atomically migrate `exit_plan_mode` to the same interaction path.

**Architecture:** Keep `AskUserManager` as the single-pending async boundary, add a dedicated bootstrap-owned vanilla Zustand `AskQuestionStore` for questionnaire state, and render it through a focused inline V2 overlay. Public tool input is validated and normalized before the UI opens; all outcomes remain ordinary string tool results. Plan approval uses the same manager/store path and delegates mode/context side effects to one testable transition function.

**Tech Stack:** TypeScript ES2022/NodeNext, React 19, Ink 7, Zustand vanilla, Vitest 3, ESLint, Node.js >=18; no new dependencies.

## Global Constraints

- Directly migrate to `{ questions: AskQuestion[] }`; do not retain the legacy `{ question, header?, options?: string[] }` protocol.
- Public schema contains only `question`, `header`, `options[{label, description}]`, and optional `multiSelect`; `preview` and `annotations` stay unadvertised and ignored.
- Accept 1–4 questions and 2–4 options per question; trim strings, count header length by Unicode code point, and reject duplicate questions or per-question labels.
- `multiSelect` defaults to `false`; runtime validation returns `{ ok: true, value } | { ok: false, error }` and never throws.
- Outcomes are `submitted | cancelled | chat`, serialized to ordinary strings; do not change Provider, streaming, tool-result, or JSONL protocols.
- Preserve `/model` `SelectStore` behavior and production inline V2 rendering; do not add alt-screen questionnaire UI.
- Every question automatically exposes Other; non-empty Other text overrides selected labels.
- No new dependency, no preview rendering, no annotations/notes, no image answer, and no Plan Mode Skip interview.
- Baseline exception recorded 2026-07-21: full `npm.cmd test` has 1684 passed / 5 failed / 2 skipped; the accepted failures are 3 timeout-status assertions in `src/__tests__/background.test.ts` and 2 ANSI-sensitive StatusBar assertions in `src/__tests__/tui/layout.test.tsx`. AUTO-0025 must introduce no additional failing test file or test case.

---

## Wheel Reuse Check

- Reuse `zustand/vanilla` and the callback-in-closure pattern from `src/tui/state/select-store.ts`; do not create a second state library or React context.
- Reuse `displayWidth()`/`foldLine()` from `src/tui/inline/text-layout.ts` for narrow-terminal layout.
- Reuse `InlineAppV2`'s existing conditional active-region replacement pattern used by `SelectOverlayV2`.
- Reuse `BlockPipeline.clear()`, `messagesStore.clear()`, `statusStore.setContextPct()`, `PermissionChecker.setMode()`, and `ConfigStore.setPermissionMode()` for plan approval effects.
- Reuse current tool registration and string `ToolExecutor`; do not add a result enum.

## Core Anchor Functions

1. `validateAskUserInput(input: Record<string, unknown>): ValidationResult` is the untrusted-input boundary.
2. `createAskQuestionStore()` owns all user-visible questionnaire transitions and produces one `AskQuestionOutcome`.
3. `AskUserManager.ask(request: AskQuestionRequest): Promise<AskQuestionOutcome>` connects tool execution to the store without depending on React.
4. `applyPlanApproval(mode, clearContext, deps)` is the single ordered plan-approval side-effect boundary.

---

### Task 1: Protocol Types, Validation, and Exact Serialization

**Files:**
- Create: `src/agent/ask-user-types.ts`
- Create: `src/agent/ask-user-validation.ts`
- Create: `src/agent/ask-user-serialization.ts`
- Create: `src/__tests__/agent/ask-user-validation.test.ts`
- Create: `src/__tests__/agent/ask-user-serialization.test.ts`
- Create: `src/__tests__/fixtures/ask-user-chat-feedback.ts`

**Interfaces:**
- Produces: `AskQuestionOption`, `AskQuestion`, `AskQuestionRequest`, `AskQuestionOutcome`, `ValidationResult`, `validateAskUserInput()`, `serializeAskQuestionOutcome()`.
- `AskQuestionRequest.otherLabel?: string` is internal presentation metadata used only by `exit_plan_mode`; it is absent from public JSON schema and from validator input.

- [ ] **Step 1: Write failing validation tests**

Create table-driven tests covering one and four questions, two and four options, trimming, default `multiSelect: false`, emoji/code-point header length, and every rejection rule:

```ts
const validInput = {
  questions: [{
    question: 'Choose cache?',
    header: 'Cache',
    options: [
      { label: 'Redis', description: 'Shared cache' },
      { label: 'Memory', description: 'Process local' },
    ],
  }],
};

expect(validateAskUserInput(validInput)).toEqual({
  ok: true,
  value: {
    questions: [{
      question: 'Choose cache?',
      header: 'Cache',
      options: [
        { label: 'Redis', description: 'Shared cache' },
        { label: 'Memory', description: 'Process local' },
      ],
      multiSelect: false,
    }],
  },
});

for (const input of [
  {},
  { questions: [] },
  { questions: Array.from({ length: 5 }, () => validInput.questions[0]) },
  { questions: [{ ...validInput.questions[0], header: '1234567890123' }] },
  { questions: [{ ...validInput.questions[0], multiSelect: 'yes' }] },
]) {
  const result = validateAskUserInput(input as Record<string, unknown>);
  expect(result.ok).toBe(false);
}
```

- [ ] **Step 2: Run the validation tests and observe RED**

Run: `npx.cmd vitest run src/__tests__/agent/ask-user-validation.test.ts`

Expected: FAIL because `ask-user-validation.ts` and its exports do not exist.

- [ ] **Step 3: Implement normalized types and the pure validator**

Define these exact public contracts:

```ts
export interface AskQuestionOption { label: string; description: string }
export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}
export interface AskQuestionRequest {
  questions: AskQuestion[];
  otherLabel?: string;
}
export type AskQuestionOutcome =
  | { kind: 'submitted'; answers: Record<string, string> }
  | { kind: 'cancelled' }
  | { kind: 'chat'; feedback: string };
export type AskQuestionOutcomeCallback = (
  requestId: string,
  outcome: AskQuestionOutcome,
) => void;
export type ValidationResult =
  | { ok: true; value: AskQuestionRequest }
  | { ok: false; error: string };
```

Implement `validateAskUserInput()` as a sequence of explicit guards. Use `[...header].length` for code points, `Set` for duplicate detection, and return path-specific messages such as `questions[0].header must be at most 12 characters`. Never mutate the input and never throw.

- [ ] **Step 4: Run validation tests and observe GREEN**

Run: `npx.cmd vitest run src/__tests__/agent/ask-user-validation.test.ts`

Expected: PASS for all valid boundaries and invalid inputs.

- [ ] **Step 5: Write failing serializer tests with one canonical chat fixture**

Export one literal `CHAT_FEEDBACK_FIXTURE` from the fixture file and assert exact equality:

```ts
export const CHAT_FEEDBACK_FIXTURE = `The user wants to clarify these questions.
This means they may have additional information, context or questions for you.
Take their response into account and then reformulate the questions if appropriate.
Start by asking them what they would like to clarify.

Questions asked:
- "Q1"
  Answer: A1
- "Q2"
  (No answer provided)`;

expect(serializeAskQuestionOutcome({
  kind: 'submitted', answers: { Q1: 'A1', Q2: 'A2' },
})).toBe('User has answered your questions: "Q1"="A1", "Q2"="A2". You can now continue with the user\'s answers in mind.');
expect(serializeAskQuestionOutcome({ kind: 'cancelled' }))
  .toBe('User declined to answer questions');
expect(serializeAskQuestionOutcome({ kind: 'chat', feedback: CHAT_FEEDBACK_FIXTURE }))
  .toBe(CHAT_FEEDBACK_FIXTURE);
```

- [ ] **Step 6: Run serializer tests, implement the serializer, and observe GREEN**

Run RED: `npx.cmd vitest run src/__tests__/agent/ask-user-serialization.test.ts`

Implement submitted serialization with `JSON.stringify(question)` and `JSON.stringify(answer)` so quotes/newlines are escaped consistently; return the two fixed strings for cancelled/chat.

Run GREEN: `npx.cmd vitest run src/__tests__/agent/ask-user-serialization.test.ts`

- [ ] **Step 7: Commit the protocol boundary**

```bash
git add src/agent/ask-user-types.ts src/agent/ask-user-validation.ts src/agent/ask-user-serialization.ts src/__tests__/agent/ask-user-validation.test.ts src/__tests__/agent/ask-user-serialization.test.ts src/__tests__/fixtures/ask-user-chat-feedback.ts
git commit -m "feat(ask-user): add questionnaire contract validation"
```

---

### Task 2: Dedicated AskQuestionStore State Machine

**Files:**
- Create: `src/tui/state/ask-question-store.ts`
- Create: `src/__tests__/tui/ask-question-store.test.ts`

**Interfaces:**
- Consumes: `AskQuestionRequest`, `AskQuestionOutcome` from Task 1.
- Produces: `AskQuestionStore`, `AskQuestionState`, `createAskQuestionStore()`.
- The callback is closure-owned: `open(requestId, request, onOutcome)` stores no function in Zustand state.

- [ ] **Step 1: Write failing state-machine tests**

Use a two-question request and assert result, state, and callback side effects for:

```ts
const request: AskQuestionRequest = { questions: [
  { question: 'Q1', header: 'One', multiSelect: false, options: [
    { label: 'A', description: 'first' }, { label: 'B', description: 'second' },
  ] },
  { question: 'Q2', header: 'Two', multiSelect: true, options: [
    { label: 'C', description: 'third' }, { label: 'D', description: 'fourth' },
  ] },
] };

store.getState().open('req-1', request, onOutcome);
store.getState().activateFocused(); // select A and advance to Q2
store.getState().activateFocused(); // toggle C
store.getState().moveFocusNext();
store.getState().activateFocused(); // toggle D
store.getState().nextPage();        // Submit page
store.getState().activateFocused(); // Submit answers
expect(onOutcome).toHaveBeenCalledWith('req-1', {
  kind: 'submitted', answers: { Q1: 'A', Q2: 'C, D' },
});
expect(store.getState().visible).toBe(false);
```

Add focused cases for single-question immediate submit, multi-select not auto-advancing, forward/back tabs, Submit with unanswered questions, Cancel, Chat fixture text, request-ID-safe close, and every terminal path resetting request/questions/answers/focus/input/callback.

- [ ] **Step 2: Run store tests and observe RED**

Run: `npx.cmd vitest run src/__tests__/tui/ask-question-store.test.ts`

Expected: FAIL because `createAskQuestionStore()` does not exist.

- [ ] **Step 3: Implement the minimal store shape**

Use this state vocabulary and no parallel duplicate model:

```ts
export interface AskQuestionState {
  visible: boolean;
  requestId: string | null;
  request: AskQuestionRequest | null;
  pageIndex: number;      // 0..questions.length; last index is Submit
  focusIndex: number;     // option/Other/Chat or Submit/Cancel
  inputMode: boolean;
  otherDraft: string;
  otherCursor: number;
  selected: Record<string, string[]>;
  others: Record<string, string>;
  open: (id: string, request: AskQuestionRequest, cb: AskQuestionOutcomeCallback) => void;
  close: (id?: string) => void;
  moveFocusNext: () => void;
  moveFocusPrevious: () => void;
  nextPage: () => void;
  previousPage: () => void;
  activateFocused: () => void;
  insertOther: (text: string) => void;
  backspaceOther: () => void;
  deleteOther: () => void;
  moveOtherCursorLeft: () => void;
  moveOtherCursorRight: () => void;
  submitOther: () => void;
  submit: () => void;
  cancel: () => void;
  chat: () => void;
}
```

Treat focus indices for a question as `0..options.length-1`, `options.length = Other`, and `options.length + 1 = Chat`. On Submit, focus `0 = Submit answers`, `1 = Cancel`. Other editing inserts/deletes at `otherCursor`; clamp cursor movement to `0..otherDraft.length`. Derive answers only when settling: non-empty trimmed Other wins; otherwise join selected labels with `, `; omit unanswered questions.

Build the chat string inside the store with the exact Task 1 fixture format. Settle through a private helper that snapshots the callback, resets all state and closure data, then calls the snapshot once.

- [ ] **Step 4: Add Other precedence tests and complete GREEN**

```ts
store.getState().open('req-other', {
  questions: [{ ...request.questions[1]!, question: 'Languages?' }],
}, onOutcome);
store.getState().activateFocused(); // select C
store.getState().moveFocusNext();
store.getState().moveFocusNext();   // focus Other
store.getState().activateFocused();
store.getState().insertOther('Rust');
store.getState().submitOther();
store.getState().submit();
expect(onOutcome).toHaveBeenCalledWith('req-other', {
  kind: 'submitted', answers: { 'Languages?': 'Rust' },
});
```

Run: `npx.cmd vitest run src/__tests__/tui/ask-question-store.test.ts`

Expected: PASS, including blank Other not counting as an answer and custom `otherLabel` affecting display metadata only.

- [ ] **Step 5: Commit the state machine**

```bash
git add src/tui/state/ask-question-store.ts src/__tests__/tui/ask-question-store.test.ts
git commit -m "feat(tui): add ask question state machine"
```

---

### Task 3: Inline V2 Questionnaire Rendering

**Files:**
- Create: `src/tui/inline-v2/AskQuestionOverlayV2.tsx`
- Create: `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`

**Interfaces:**
- Consumes: `AskQuestionStore`, `displayWidth()`, `foldLine()`.
- Produces: `<AskQuestionOverlayV2 store={store} cols={cols} />`.
- Rendering is passive: the component subscribes and displays state but invokes no navigation outcome itself.

- [ ] **Step 1: Write failing component tests**

Open real stores and verify:

```tsx
const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
const frame = lastFrame() ?? '';
expect(frame).toContain('One');
expect(frame).toContain('Q1');
expect(frame).toContain('A');
expect(frame).toContain('first');
expect(frame).toContain('Other');
expect(frame).toContain('Chat about this');
```

Add tests for `✓/○` tabs plus Submit, `[ ]/[x]`, custom “提出修改意见”, Other input text/cursor state, unanswered Submit warning, contextual help, and every rendered line having `displayWidth(line) <= cols` at `cols=32`.

- [ ] **Step 2: Run component tests and observe RED**

Run: `npx.cmd vitest run src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the focused renderer**

Use `useStore(store, useShallow((state) => ({ visible: state.visible, request: state.request, pageIndex: state.pageIndex, focusIndex: state.focusIndex, inputMode: state.inputMode, otherDraft: state.otherDraft, selected: state.selected, others: state.others })))` as in `SelectOverlayV2`. Render:

```tsx
<Box flexDirection="column">
  <Text>{tabs}</Text>
  <Text bold>{question.header}</Text>
  <Text>{question.question}</Text>
  {rows.map((row) => <Text key={row.key}>{row.text}</Text>)}
  <Text dimColor>{help}</Text>
</Box>
```

Use `foldLine()` for question/description and a local width-aware truncator for one-line labels/tabs; the truncator must iterate code points and stop before exceeding the budget. Do not import `slice-ansi`, add preview layout, or render through `OverlayHost` alt-screen.

- [ ] **Step 4: Run renderer tests and observe GREEN**

Run: `npx.cmd vitest run src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/inline-v2/select-overlay.test.tsx`

Expected: questionnaire tests PASS and existing `/model` overlay tests remain PASS.

- [ ] **Step 5: Commit the renderer**

```bash
git add src/tui/inline-v2/AskQuestionOverlayV2.tsx src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
git commit -m "feat(tui): render ask question overlay"
```

---

### Task 4: Keyboard Routing and Bootstrap Wiring

**Files:**
- Modify: `src/tui/input/use-input-handler.ts`
- Modify: `src/tui/ConnectedApp.tsx`
- Modify: `src/tui/bootstrap.tsx`
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`
- Modify: `src/__tests__/tui/use-input-handler.test.tsx`
- Modify: `src/__tests__/tui/inline-v2/helpers/e2e-harness.tsx`
- Create: `src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`
- Update compile fixtures that construct `InlineAppV2Stores`: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`, `logo-regression.test.tsx`, `logo-static-identity.test.tsx`, `overlay-footer-recovery.test.tsx`, `v2-resize.test.tsx`, and `src/__tests__/tui/connected-app-spinner-clock.test.tsx`.

**Interfaces:**
- Consumes: `AskQuestionStore` from Task 2 and overlay from Task 3.
- Produces: one bootstrap-owned `askQuestionStore` exposed through `BootstrapHandle`, passed to `ConnectedApp`, `useInputHandler`, and `InlineAppV2`.
- Append `askQuestionStore?: AskQuestionStore` to `useInputHandler()` to avoid changing unrelated positional call sites; production always supplies it.

- [ ] **Step 1: Write failing input-priority tests**

Extend `InputProbe` to accept an AskQuestionStore and test exact routes:

```ts
inputStore.getState().setText('draft stays');
askStore.getState().open('req', request, onOutcome);
stdin.write('\x1b[B'); // down
stdin.write('\r');     // select/activate
expect(inputStore.getState().text).toBe('draft stays');
expect(onOutcome).toHaveBeenCalled();
```

Cover Up/Down, Ctrl+P/Ctrl+N, Tab/Right, Shift+Tab/Left, Space/Enter, Other character/Backspace/Delete/Enter, Esc, Chat, and Ctrl+C. Assert questionnaire handling precedes overlay/select/completion/input, while Ctrl+C remains global first.

- [ ] **Step 2: Run input tests and observe RED**

Run: `npx.cmd vitest run src/__tests__/tui/use-input-handler.test.tsx`

Expected: FAIL because questionnaire keys currently reach normal input or other overlays.

- [ ] **Step 3: Implement questionnaire key routing**

Immediately after the global Ctrl+C branch and before normal overlay handling:

```ts
const ask = askQuestionStore?.getState();
if (ask?.visible) {
  if (key.escape) ask.cancel();
  else if (ask.inputMode && key.return) ask.submitOther();
  else if (ask.inputMode && (key.backspace || input === '\x7f' || input === '\x08')) ask.backspaceOther();
  else if (ask.inputMode && key.delete) ask.deleteOther();
  else if (ask.inputMode && key.leftArrow) ask.moveOtherCursorLeft();
  else if (ask.inputMode && key.rightArrow) ask.moveOtherCursorRight();
  else if (ask.inputMode && input && !key.ctrl && !key.meta) ask.insertOther(input);
  else if (key.upArrow || (key.ctrl && input === 'p')) ask.moveFocusPrevious();
  else if (key.downArrow || (key.ctrl && input === 'n')) ask.moveFocusNext();
  else if ((key.tab && !key.shift) || key.rightArrow) ask.nextPage();
  else if ((key.tab && key.shift) || key.leftArrow) ask.previousPage();
  else if (key.return || input === ' ') ask.activateFocused();
  return;
}
```

Keep Other input handling before navigation so typed characters never leak. Do not alter `/model` Select branches beyond their new lower priority.

- [ ] **Step 4: Wire store ownership and active-region rendering**

In `bootstrap()`, create one store, pass it through `ConnectedApp`, and return it on `BootstrapHandle`. In `InlineAppV2`, subscribe to `askQuestionStore.visible` and render precedence as:

```tsx
{askQuestionVisible ? (
  <AskQuestionOverlayV2 store={stores.askQuestionStore} cols={cols} />
) : selectVisible ? (
  <SelectOverlayV2 store={stores.selectStore} cols={cols} />
) : (
  <>
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
  </>
)}
```

Update the shared E2E harness to create and expose the same store. Update direct store fixtures mechanically; do not change their assertions.

- [ ] **Step 5: Add full user-path E2E tests and observe GREEN**

Using `createE2EHarness()`, verify a single-choice question immediately settles, a multi-question flow reaches Submit, Esc cancels, Chat settles, spinner/footer disappear while visible and return afterward, and a pre-existing input draft is byte-for-byte unchanged.

Run: `npx.cmd vitest run src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/inline-v2/select-overlay.test.tsx`

Expected: PASS with no `/model` or footer regression.

- [ ] **Step 6: Commit keyboard and composition wiring**

```bash
git add src/tui/input/use-input-handler.ts src/tui/ConnectedApp.tsx src/tui/bootstrap.tsx src/tui/inline-v2/InlineAppV2.tsx src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/helpers/e2e-harness.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/inline-v2/logo-regression.test.tsx src/__tests__/tui/inline-v2/logo-static-identity.test.tsx src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx src/__tests__/tui/inline-v2/v2-resize.test.tsx src/__tests__/tui/connected-app-spinner-clock.test.tsx
git commit -m "feat(tui): wire questionnaire input and overlay"
```

---

### Task 5: Atomic Manager, Tool, Store-Adapter, and exit_plan_mode Cutover

**Files:**
- Modify: `src/agent/ask-user-manager.ts`
- Modify: `src/agent/tools/ask-user-tool.ts`
- Rewrite: `src/__tests__/ask-user.test.ts`
- Modify: `src/__tests__/streaming-executor.test.ts`
- Create: `src/plan/plan-approval-transition.ts`
- Create: `src/__tests__/plan-approval-transition.test.ts`
- Modify: `src/agent/tools/plan-tools.ts`
- Modify: `src/__tests__/plan-approval.test.ts`
- Modify: `src/index.ts`
- Modify: `src/__tests__/index.test.ts` only if its import smoke fixture needs updated bootstrap mocks.

**Interfaces:**
- Consumes: Task 1 contracts/validator/serializer and Task 4's bootstrap-owned store.
- Produces: `AskUserUI.open(id, request, onOutcome)`, `AskUserUI.close(id)`, and `AskUserManager.ask(request)`.
- The public ask tool executor is exactly schema → validate → `manager.ask()` → serialize.
- Produces: `applyPlanApproval(mode: 'auto' | 'build', clearContext: boolean, deps: PlanApprovalTransitionDeps): void`.
- `createExitPlanModeTool(askManager, planStore, { getUsagePercent, onApprove })` receives all runtime dependencies explicitly.

- [ ] **Step 1: Replace legacy manager tests with failing outcome/race tests**

Use a fake UI that captures the request callback:

```ts
const ui = {
  open: vi.fn<(id: string, request: AskQuestionRequest, done: AskQuestionOutcomeCallback) => void>(),
  close: vi.fn<(id: string) => void>(),
};
const manager = new AskUserManager(ui);
const first = manager.ask(request);
const requestId = ui.open.mock.calls[0]![0];
ui.open.mock.calls[0]![2](requestId, { kind: 'submitted', answers: { Q1: 'A' } });
await expect(first).resolves.toEqual({ kind: 'submitted', answers: { Q1: 'A' } });
```

Add a race test: call `ask()` twice, assert the first resolves `{ kind: 'cancelled' }`, invoke the stale first callback, prove the second remains pending, then complete the second with its own request ID.

- [ ] **Step 2: Write failing ask tool schema/executor tests**

Assert the definition requires `questions`, contains nested option object properties, and exposes neither the legacy top-level `question` nor `preview`/`annotations`. Assert unknown fields are ignored, invalid input returns `Error: questions must contain 1 to 4 items` without opening the UI, and submitted/cancelled/chat produce Task 1's exact strings.

Add a `StreamingToolExecutor` regression with two deferred `ask_user_question` calls. Track `active`/`maxActive`, release the first promise, then the second, and assert `maxActive === 1` plus result order `[call-1, call-2]`; this locks the existing non-read-only exclusive queue behavior without modifying the executor.

- [ ] **Step 3: Write failing plan transition and exit_plan_mode tests**

For ordered effects, use spies that append names:

```ts
applyPlanApproval('auto', true, {
  clearPipeline: () => calls.push('pipeline'),
  clearSessionMessages: () => calls.push('messages'),
  rotateSessionId: () => calls.push('session'),
  resetContextUsage: () => calls.push('usage'),
  setPermissionMode: (mode) => calls.push(`permission:${mode}`),
  setConfigMode: (mode) => calls.push(`config:${mode}`),
  setStatusMode: (mode) => calls.push(`status:${mode}`),
});
expect(calls).toEqual([
  'pipeline', 'messages', 'session', 'usage',
  'permission:auto', 'config:auto', 'status:auto',
]);
```

Add `clearContext=false` auto/build cases. For `exit_plan_mode`, capture `AskUserUI.open` and assert:

```ts
const tool = createExitPlanModeTool(manager, planStore, {
  getUsagePercent: () => 22,
  onApprove,
});
const resultPromise = tool.executor({});
const request = ui.open.mock.calls[0]![1];
expect(request.questions[0]!.header).toBe('Plan');
expect(request.questions[0]!.options).toHaveLength(3);
expect(request.questions[0]!.options[0]!.description).toContain('22%');
expect(request.otherLabel).toBe('提出修改意见');
```

Complete separate calls with each approval label, Other text, cancelled, and chat. Assert only the first three call `onApprove` with `('auto', true)`, `('auto', false)`, and `('build', false)` respectively. Assert callback occurs before executor resolution, approved selections set PlanStore status approved, and Other/Esc/Chat leave it pending and return standard serialization.

- [ ] **Step 4: Run the complete cutover tests and observe RED**

Run: `npx.cmd vitest run src/__tests__/ask-user.test.ts src/__tests__/streaming-executor.test.ts src/__tests__/plan-approval-transition.test.ts src/__tests__/plan-approval.test.ts`

Expected: FAIL because the manager still returns strings, the ask tool still accepts the legacy schema, the transition module does not exist, and plan approval still asks for `/approve`/`/reject`.

- [ ] **Step 5: Implement the request-ID guarded manager and direct ask tool migration**

Replace `PendingQuestion`, `resolve(string)`, and `cancel()` with:

```ts
interface PendingAsk {
  id: string;
  resolve: (outcome: AskQuestionOutcome) => void;
}

ask(request: AskQuestionRequest): Promise<AskQuestionOutcome> {
  this.cancelPending();
  const id = randomUUID();
  return new Promise((resolve) => {
    this.pending = { id, resolve };
    this.ui.open(id, request, (callbackId, outcome) => this.complete(callbackId, outcome));
  });
}
```

`complete()` ignores stale IDs and clears pending before resolving. `cancelPending()` closes and resolves the previous request as cancelled.

Build the nested public JSON schema in `ask-user-tool.ts`. Its executor is exactly:

```ts
const validated = validateAskUserInput(input);
if (!validated.ok) return `Error: ${validated.error}`;
const outcome = await mgr.ask(validated.value);
return serializeAskQuestionOutcome(outcome);
```

- [ ] **Step 6: Implement ordered plan effects and exit_plan_mode**

Implement `applyPlanApproval()` as the direct seven-callback sequence shown in Step 3, with only the `clearContext` conditional.

Construct one normalized `AskQuestionRequest` with the exact approved Chinese copy, `multiSelect: false`, three options, and `otherLabel: '提出修改意见'`. Await the manager outcome; for `submitted`, compare the answer under `Claude 已拟定执行方案，是否继续？` against the three exact labels, call `onApprove`, and mark approved only for those labels. Always return `serializeAskQuestionOutcome(outcome)`.

Keep all plan-specific branching in `plan-tools.ts`; add none to `ask-user-tool.ts`.

- [ ] **Step 7: Replace the index adapter and remove the old input branch**

Instantiate `AskUserManager` with the bootstrap-forwarded adapter:

```ts
const askManager = new AskUserManager({
  open: (id, request, done) => tuiHandle?.askQuestionStore.getState().open(id, request, done),
  close: (id) => tuiHandle?.askQuestionStore.getState().close(id),
});
```

Create the exit tool dependencies with:

```ts
getUsagePercent: () => Math.round((tuiHandle?.statusStore.getState().contextPct ?? 0) * 100),
onApprove: (mode, clearContext) => applyPlanApproval(mode, clearContext, {
  clearPipeline: () => pipeline.clear(),
  clearSessionMessages: () => { sessionMessages = []; },
  rotateSessionId: () => { sessionId = randomUUID(); },
  resetContextUsage: () => tuiHandle?.statusStore.getState().setContextPct(0),
  setPermissionMode: (next) => permissionChecker.setMode(next),
  setConfigMode: (next) => configStore.setPermissionMode(next),
  setStatusMode: (next) => tuiHandle?.statusStore.getState().setMode(next),
}),
```

Delete the entire `askManager.hasPending()` branch in `handleUserSubmit()`, including `/approve`, `/reject`, ordinary pending-answer resolution, and its stale comments. Do not replace it with another text-input special case.

- [ ] **Step 8: Run atomic migration and static checks and observe GREEN**

Run: `npx.cmd vitest run src/__tests__/ask-user.test.ts src/__tests__/agent/ask-user-validation.test.ts src/__tests__/agent/ask-user-serialization.test.ts src/__tests__/streaming-executor.test.ts src/__tests__/plan-approval.test.ts src/__tests__/plan-approval-transition.test.ts src/__tests__/index.test.ts`

Run: `npm.cmd run typecheck`

Expected: all tests PASS and TypeScript exits 0; the repository never contains a commit where the manager protocol and either tool caller disagree.

- [ ] **Step 9: Commit the atomic cutover**

```bash
git add src/agent/ask-user-manager.ts src/agent/tools/ask-user-tool.ts src/__tests__/ask-user.test.ts src/__tests__/streaming-executor.test.ts src/plan/plan-approval-transition.ts src/__tests__/plan-approval-transition.test.ts src/agent/tools/plan-tools.ts src/__tests__/plan-approval.test.ts src/index.ts src/__tests__/index.test.ts
git commit -m "feat(ask-user): atomically migrate questionnaire tools"
```

---

### Task 6: Affected-Suite Regression, Static Checks, and Manual Verification

**Files:**
- Modify only files required to fix regressions caused by Tasks 1–5.
- Create: `logs/auto-0025-verification.md`

**Interfaces:**
- Consumes the completed questionnaire path.
- Produces verification evidence; no feature expansion.

- [ ] **Step 1: Run the focused AUTO-0025 suite**

```bash
npx.cmd vitest run src/__tests__/agent/ask-user-validation.test.ts src/__tests__/agent/ask-user-serialization.test.ts src/__tests__/ask-user.test.ts src/__tests__/tui/ask-question-store.test.ts src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/plan-approval.test.ts src/__tests__/plan-approval-transition.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run affected-module regressions**

```bash
npx.cmd vitest run src/__tests__/tui/inline-v2/ src/__tests__/tui/select-store.test.ts src/__tests__/streaming-query.test.ts src/__tests__/plan-mode-streaming.test.ts src/__tests__/regression/permission-executor-integration.test.ts
```

Expected: no new failures; `/model`, inline footer/spinner recovery, and exclusive tool execution stay green.

- [ ] **Step 3: Run TypeScript and lint**

```bash
npm.cmd run typecheck
npm.cmd run lint
```

Expected: both commands exit 0 with no unused variables or floating promises.

- [ ] **Step 4: Run the full suite against the recorded baseline**

Run: `npm.cmd test`

Expected: all newly added tests pass; the failure set is no larger than the accepted baseline and contains only the three `background.test.ts` timeout assertions plus two `layout.test.tsx` ANSI assertions. If any new test fails, stop and fix it before continuing.

- [ ] **Step 5: Manually verify the real inline V2 user paths**

Run the project and exercise:

1. One single-choice question: Enter submits immediately.
2. Two questions: Tab/Shift+Tab navigates; Submit permits an unanswered question with warning.
3. Multi-select: Space/Enter toggles and does not auto-advance.
4. Other: typed text overrides selected labels.
5. Chat: returned tool result matches the fixture structure.
6. Esc: returns `User declined to answer questions`.
7. Draft preservation: text in the normal input returns unchanged after the questionnaire.
8. `exit_plan_mode`: auto+clear, auto+keep, build+keep, feedback, Esc, and Chat follow the approved mappings; auto+clear visibly resets context percentage.

- [ ] **Step 6: Record exact evidence**

Write `logs/auto-0025-verification.md` containing the command, exit code, pass/fail/skip counts, unchanged baseline failures, and concise manual observations. Do not claim the accepted baseline tests passed.

- [ ] **Step 7: Commit verification-only adjustments and evidence**

```bash
git add src logs/auto-0025-verification.md
git commit -m "test(ask-user): verify questionnaire integration"
```

After this commit, invoke `superpowers:requesting-code-review`, address accepted findings through `superpowers:receiving-code-review`, then invoke `superpowers:verification-before-completion` before branch integration.
