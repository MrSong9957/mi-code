# AUTO-0025 AskUserQuestion Phase 1a Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic AskUserQuestion overlay's flat text presentation with Claude Code-style navigation, focus, selection, footer, help, and answer-review visuals without changing any interaction or outcome behavior.

**Architecture:** Keep `AskQuestionStore` and `useInputHandler` byte-for-byte unchanged in Phase 1a. Extract a pure navigation model plus three focused React components, then let `AskQuestionOverlayV2` choose the question or submit view. Automated tests protect 40/80-column terminal frames and existing behavior; real-terminal checks cover semantic colors that `ink-testing-library` cannot reliably expose as stable assertions.

**Tech Stack:** Node.js >=18, ESM, TypeScript strict/NodeNext, React 19, Ink 7, Zustand 5, Vitest 3, `ink-testing-library`, `string-width`.

## Global Constraints

- Work only in the existing `codex/auto-0025` worktree.
- Phase 1a must not modify `AskQuestionStore`, `useInputHandler`, manager, provider, public schema, outcome, tool-result, or persistence behavior.
- `ExitPlanModeOverlayV2` must retain its current visual output and interaction paths.
- Use existing `theme.suggestion`, `theme.success`, `theme.warning`, `theme.textPrimary`, `theme.textMuted`, and `theme.selectionFg`; add no theme fields.
- Add no runtime or development dependency.
- Supported terminal baseline is 40 columns; narrower output must continue to avoid overflow but full fail-soft behavior belongs to Phase 1b.
- Preserve the Phase 1a `|` Other cursor; the native cursor is Phase 2 work.
- Existing single-choice immediate submit, multi-question advance, multi-select toggling, Chat, Submit, Cancel, paste, spinner/footer recovery, and plan approval assertions must remain unchanged.
- TDD is mandatory: observe each new focused test fail for the intended reason before adding production code.
- Do not stage or modify the pre-existing `package-lock.json` worktree change.

---

## File Structure

### Create

- `src/tui/inline-v2/ask-question-layout.ts` — Phase 1a display-width truncation and navigation render-model construction; Phase 1b will extend this file with grapheme-aware wrapping and visible-window computation.
- `src/tui/inline-v2/QuestionNavigationBarV2.tsx` — normal and compressed question navigation presentation.
- `src/tui/inline-v2/QuestionOptionViewportV2.tsx` — current question's option, Other, divider, Chat, and help presentation; renders every control in Phase 1a.
- `src/tui/inline-v2/QuestionSubmitViewV2.tsx` — answer review, unanswered warning, and Submit/Cancel presentation.
- `src/__tests__/tui/inline-v2/ask-question-layout.test.ts` — pure navigation width/model tests.
- `logs/AUTO-0025-ask-user-phase1a.md` — commands, real-terminal evidence, and final Phase 1a result only.

### Modify

- `src/tui/inline-v2/AskQuestionOverlayV2.tsx` — reduce to store subscription plus question/submit view composition.
- `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx` — add 40/80-column RED frames and visual semantics assertions.

### Regression-only, do not modify

- `src/tui/state/ask-question-store.ts`
- `src/tui/input/use-input-handler.ts`
- `src/tui/inline-v2/ExitPlanModeOverlayV2.tsx`
- `src/__tests__/tui/ask-question-store.test.ts`
- `src/__tests__/tui/use-input-handler.test.tsx`
- `src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`
- `src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx`
- `src/__tests__/tui/inline-v2/exit-plan-mode-routing.test.tsx`
- `src/__tests__/plan-approval.test.ts`

---

### Task 1: Lock 40/80-column navigation frames and build the navigation component

**Files:**
- Create: `src/tui/inline-v2/ask-question-layout.ts`
- Create: `src/tui/inline-v2/QuestionNavigationBarV2.tsx`
- Create: `src/__tests__/tui/inline-v2/ask-question-layout.test.ts`
- Modify: `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`
- Modify: `src/tui/inline-v2/AskQuestionOverlayV2.tsx`

**Interfaces:**
- Consumes: `AskQuestion[]`, `pageIndex`, `selected`, `others`, `cols`, and the existing theme context.
- Produces:

```ts
export interface QuestionNavigationItem {
  key: string;
  text: string;
  current: boolean;
  answered: boolean;
}

export interface QuestionNavigationModel {
  mode: 'full' | 'compact';
  canGoPrevious: boolean;
  canGoNext: boolean;
  items: QuestionNavigationItem[];
  leftAggregate?: '☑' | '☐';
  rightAggregate?: '☑' | '☐';
}

export function truncateDisplay(text: string, budget: number): string;
export function buildQuestionNavigationModel(args: {
  headers: readonly string[];
  answered: readonly boolean[];
  currentIndex: number;
  cols: number;
}): QuestionNavigationModel;
```

- Produces `QuestionNavigationBarV2Props`:

```ts
export interface QuestionNavigationBarV2Props {
  questions: readonly { question: string; header: string }[];
  pageIndex: number;
  selected: Record<string, string[]>;
  others: Record<string, string>;
  cols: number;
}
```

- [ ] **Step 1: Add the four-question fixture and failing 80/40-column overlay assertions**

Add this fixture and helper to `ask-question-overlay.test.tsx`:

```tsx
const fourQuestionRequest = {
  questions: [
    { header: 'Runtime', question: 'Runtime?', options: request.questions[0]!.options, multiSelect: false },
    { header: 'Checks', question: 'Checks?', options: request.questions[0]!.options, multiSelect: true },
    { header: 'Deploy', question: 'Deploy?', options: request.questions[0]!.options, multiSelect: false },
    { header: 'Review', question: 'Review?', options: request.questions[0]!.options, multiSelect: false },
  ],
};

function frameLines(frame: string | undefined): string[] {
  return (frame ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.trimEnd());
}
```

Add two tests. The selected second question makes unanswered questions exist on both sides:

```tsx
it('renders the full navigation frame when four tabs fit at 80 columns', () => {
  const store = createAskQuestionStore();
  store.getState().open('question-80', fourQuestionRequest, () => {});
  store.setState({ pageIndex: 1, selected: { 'Checks?': ['A'] } });

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const navigation = frameLines(lastFrame())[0];

  expect(navigation).toContain('←');
  expect(navigation).toContain('☐ Runtime');
  expect(navigation).toContain('☑ Checks');
  expect(navigation).toContain('☐ Deploy');
  expect(navigation).toContain('☐ Review');
  expect(navigation).toContain('✓ Submit');
  expect(navigation).toContain('→');
});

it('renders aggregate unanswered status in the 40-column compact frame', () => {
  const store = createAskQuestionStore();
  store.getState().open('question-40', fourQuestionRequest, () => {});
  store.setState({ pageIndex: 1, selected: { 'Checks?': ['A'] } });

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={40} />);
  const navigation = frameLines(lastFrame())[0];

  expect(navigation).toContain('← ☐');
  expect(navigation).toContain('☑ 2/4 Checks');
  expect(navigation).toContain('☐ →');
  expect(navigation).not.toContain('Runtime');
  expect(navigation).not.toContain('Deploy');
});
```

Replace the existing `renders completion tabs and a Submit tab` assertion with the new visual vocabulary so the old `○` glyph is not preserved accidentally:

```tsx
it('renders answered, unanswered, and Submit navigation markers', () => {
  const store = openStore();
  store.setState({ selected: { Q1: ['A'] } });
  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const navigation = frameLines(lastFrame())[0];

  expect(navigation).toContain('☑ One');
  expect(navigation).toContain('☐ Two');
  expect(navigation).toContain('✓ Submit');
  expect(navigation).not.toContain('○');
});
```

- [ ] **Step 2: Run the overlay test and verify the intended RED state**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
```

Expected: both new tests fail because the current first line is the flat `✓/○` string and does not contain `☑/☐`, arrows, or compact aggregate status. Existing tests should still pass.

- [ ] **Step 3: Add failing pure navigation-model tests**

Create `ask-question-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildQuestionNavigationModel,
  truncateDisplay,
} from '../../../tui/inline-v2/ask-question-layout.js';

describe('AskQuestion navigation layout', () => {
  it('truncates by displayed width rather than UTF-16 length', () => {
    expect(truncateDisplay('运行😀abc', 6)).toBe('运行😀');
  });

  it('keeps every tab in full mode when the formatted content fits', () => {
    const model = buildQuestionNavigationModel({
      headers: ['Runtime', 'Checks', 'Deploy', 'Review'],
      answered: [false, true, false, false],
      currentIndex: 1,
      cols: 80,
    });

    expect(model.mode).toBe('full');
    expect(model.items.map((item) => [item.text, item.current, item.answered])).toEqual([
      ['Runtime', false, false],
      ['Checks', true, true],
      ['Deploy', false, false],
      ['Review', false, false],
      ['Submit', false, false],
    ]);
  });

  it('uses side aggregates in compact mode so remote unanswered questions remain visible', () => {
    const model = buildQuestionNavigationModel({
      headers: ['Runtime', 'Checks', 'Deploy', 'Review'],
      answered: [false, true, true, false],
      currentIndex: 1,
      cols: 40,
    });

    expect(model).toMatchObject({
      mode: 'compact',
      canGoPrevious: true,
      canGoNext: true,
      leftAggregate: '☐',
      rightAggregate: '☐',
    });
    expect(model.items).toEqual([
      { key: 'question-1', text: '2/4 Checks', current: true, answered: true },
    ]);
  });

  it('marks a side complete only when every question on that side is answered', () => {
    const model = buildQuestionNavigationModel({
      headers: ['One', 'Two', 'Three', 'Four'],
      answered: [true, true, true, false],
      currentIndex: 2,
      cols: 40,
    });

    expect(model.leftAggregate).toBe('☑');
    expect(model.rightAggregate).toBe('☐');
  });
});
```

- [ ] **Step 4: Run the pure test and verify it fails because the module does not exist**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-layout.test.ts
```

Expected: FAIL with module resolution error for `ask-question-layout.js`.

- [ ] **Step 5: Implement the minimal navigation model**

Create `ask-question-layout.ts`:

```ts
import stringWidth from 'string-width';

export interface QuestionNavigationItem {
  key: string;
  text: string;
  current: boolean;
  answered: boolean;
}

export interface QuestionNavigationModel {
  mode: 'full' | 'compact';
  canGoPrevious: boolean;
  canGoNext: boolean;
  items: QuestionNavigationItem[];
  leftAggregate?: '☑' | '☐';
  rightAggregate?: '☑' | '☐';
}

export function truncateDisplay(text: string, budget: number): string {
  if (budget <= 0) return '';
  let result = '';
  for (const character of text) {
    if (stringWidth(result + character) > budget) break;
    result += character;
  }
  return result;
}

function aggregate(values: readonly boolean[]): '☑' | '☐' | undefined {
  if (values.length === 0) return undefined;
  return values.every(Boolean) ? '☑' : '☐';
}

export function buildQuestionNavigationModel(args: {
  headers: readonly string[];
  answered: readonly boolean[];
  currentIndex: number;
  cols: number;
}): QuestionNavigationModel {
  const { headers, answered, currentIndex, cols } = args;
  const submitIndex = headers.length;
  const fullItems: QuestionNavigationItem[] = [
    ...headers.map((header, index) => ({
      key: `question-${index}`,
      text: header,
      current: currentIndex === index,
      answered: answered[index] ?? false,
    })),
    {
      key: 'submit',
      text: 'Submit',
      current: currentIndex === submitIndex,
      answered: false,
    },
  ];
  const fullWidth = 4 + fullItems.reduce((width, item) => {
    const symbol = item.key === 'submit' ? '✓' : item.answered ? '☑' : '☐';
    return width + stringWidth(` ${symbol} ${item.text} `);
  }, 0);

  if (fullWidth <= cols) {
    return {
      mode: 'full',
      canGoPrevious: currentIndex > 0,
      canGoNext: currentIndex < submitIndex,
      items: fullItems,
    };
  }

  if (currentIndex === submitIndex) {
    return {
      mode: 'compact',
      canGoPrevious: headers.length > 0,
      canGoNext: false,
      items: [{ key: 'submit', text: 'Submit', current: true, answered: false }],
      leftAggregate: aggregate(answered),
    };
  }

  const labelBudget = Math.max(1, cols - 18);
  const header = truncateDisplay(headers[currentIndex] ?? `Q${currentIndex + 1}`, labelBudget);
  return {
    mode: 'compact',
    canGoPrevious: currentIndex > 0,
    canGoNext: true,
    items: [{
      key: `question-${currentIndex}`,
      text: `${currentIndex + 1}/${headers.length} ${header}`,
      current: true,
      answered: answered[currentIndex] ?? false,
    }],
    leftAggregate: aggregate(answered.slice(0, currentIndex)),
    rightAggregate: aggregate(answered.slice(currentIndex + 1)),
  };
}
```

- [ ] **Step 6: Run the pure test and verify GREEN**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-layout.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 7: Implement `QuestionNavigationBarV2` and replace only the old tabs line**

Create `QuestionNavigationBarV2.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../state/theme-context.js';
import { buildQuestionNavigationModel } from './ask-question-layout.js';

export interface QuestionNavigationBarV2Props {
  questions: readonly { question: string; header: string }[];
  pageIndex: number;
  selected: Record<string, string[]>;
  others: Record<string, string>;
  cols: number;
}

function isAnswered(
  question: { question: string },
  selected: Record<string, string[]>,
  others: Record<string, string>,
): boolean {
  return (selected[question.question]?.length ?? 0) > 0
    || Boolean(others[question.question]?.trim());
}

export const QuestionNavigationBarV2 = React.memo(function QuestionNavigationBarV2({
  questions,
  pageIndex,
  selected,
  others,
  cols,
}: QuestionNavigationBarV2Props): React.ReactElement {
  const theme = useTheme();
  const model = buildQuestionNavigationModel({
    headers: questions.map((question) => question.header),
    answered: questions.map((question) => isAnswered(question, selected, others)),
    currentIndex: pageIndex,
    cols,
  });

  const arrowColor = (enabled: boolean) => enabled ? undefined : theme.textMuted;
  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text color={arrowColor(model.canGoPrevious)}>← </Text>
      {model.leftAggregate && <Text>{model.leftAggregate} </Text>}
      {model.items.map((item) => {
        const symbol = item.key === 'submit' ? '✓' : item.answered ? '☑' : '☐';
        return (
          <Text
            key={item.key}
            backgroundColor={item.current ? theme.suggestion : undefined}
            color={item.current ? theme.selectionFg : undefined}
          >
            {` ${symbol} ${item.text} `}
          </Text>
        );
      })}
      {model.rightAggregate && <Text>{` ${model.rightAggregate}`}</Text>}
      <Text color={arrowColor(model.canGoNext)}> →</Text>
    </Box>
  );
});
```

In `AskQuestionOverlayV2.tsx`, remove the local `isAnswered` and `tabs` construction, import `QuestionNavigationBarV2`, and replace both `<Text>{tabs}</Text>` occurrences with:

```tsx
<QuestionNavigationBarV2
  questions={questions}
  pageIndex={state.pageIndex}
  selected={state.selected}
  others={state.others}
  cols={width}
/>
```

- [ ] **Step 8: Run the navigation and overlay tests**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-layout.test.ts src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
```

Expected: all tests pass. If the exact 40-column spacing differs, adjust component spacing, not the semantic expectations.

- [ ] **Step 9: Commit Task 1**

```powershell
git add -- src/tui/inline-v2/ask-question-layout.ts src/tui/inline-v2/QuestionNavigationBarV2.tsx src/tui/inline-v2/AskQuestionOverlayV2.tsx src/__tests__/tui/inline-v2/ask-question-layout.test.ts src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
git commit -m "style(ask-user): add adaptive question navigation"
```

---

### Task 2: Add Claude Code-style option, Other, Chat, divider, and help visuals

**Files:**
- Create: `src/tui/inline-v2/QuestionOptionViewportV2.tsx`
- Modify: `src/tui/inline-v2/AskQuestionOverlayV2.tsx`
- Modify: `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`

**Interfaces:**
- Consumes: one normalized `AskQuestion`, current `focusIndex`, `inputMode`, current Other draft/cursor, selected labels, custom Other label, and `cols`.
- Produces:

```ts
export interface QuestionOptionViewportV2Props {
  question: AskQuestion;
  focusIndex: number;
  inputMode: boolean;
  otherDraft: string;
  otherCursor: number;
  selected: readonly string[];
  otherAnswer?: string;
  otherLabel: string;
  cols: number;
}
```

- [ ] **Step 1: Replace loose content assertions with failing semantic frame assertions**

Add these tests to `ask-question-overlay.test.tsx` while keeping the existing behavior-oriented tests. Replace the old `[x]/[ ]` visual test with the Unicode-marker test below; it protects no behavior and must not keep the legacy syntax alive:

```tsx
it('renders a focused single-select option without checkbox syntax', () => {
  const store = createAskQuestionStore();
  store.getState().open('single-visual', {
    questions: [{ ...request.questions[0]!, multiSelect: false }],
  }, () => {});

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const frame = frameLines(lastFrame()).join('\n');

  expect(frame).toContain('❯ 1. A');
  expect(frame).toContain('  2. B');
  expect(frame).not.toContain('[ ]');
  expect(frame).not.toContain('☐ 1. A');
});

it('renders multi-select choices with Unicode selection markers', () => {
  const store = openStore();
  store.setState({ selected: { Q1: ['A'] } });

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const frame = frameLines(lastFrame()).join('\n');

  expect(frame).toContain('❯ ☑ 1. A');
  expect(frame).toContain('  ☐ 2. B');
  expect(frame).not.toContain('[x]');
  expect(frame).not.toContain('[ ]');
});

it('separates Chat from the options and states the destructive Esc action', () => {
  const store = openStore();
  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const lines = frameLines(lastFrame());
  const chatIndex = lines.findIndex((line) => line.includes('4. Chat about this'));

  expect(chatIndex).toBeGreaterThan(0);
  expect(lines[chatIndex - 1]).toMatch(/^─+$/);
  expect(lines.join('\n')).toContain('Esc: Cancel interview');
});

it('keeps the Phase 1a Other pipe cursor and uses the numbered Other row', () => {
  const store = openStore();
  store.setState({ inputMode: true, otherDraft: 'because', otherCursor: 3, focusIndex: 2 });

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  expect(frameLines(lastFrame()).join('\n')).toContain('❯ 3. Other: bec|ause');
});
```

Update the existing Other-help visual assertion to the Phase 1a truth: `Enter: Save Other · Esc: Cancel interview`. Do not claim `Esc: Exit input` until Phase 1b changes the behavior.

- [ ] **Step 2: Run the overlay test and verify RED**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
```

Expected: new tests fail on `>`, `[x]/[ ]`, missing divider, unnumbered Chat, and the old ambiguous help text.

- [ ] **Step 3: Implement `QuestionOptionViewportV2`**

Create `QuestionOptionViewportV2.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { AskQuestion } from '../../agent/ask-user-types.js';
import { foldLine } from '../inline/text-layout.js';
import { useTheme } from '../state/theme-context.js';
import { truncateDisplay } from './ask-question-layout.js';

export interface QuestionOptionViewportV2Props {
  question: AskQuestion;
  focusIndex: number;
  inputMode: boolean;
  otherDraft: string;
  otherCursor: number;
  selected: readonly string[];
  otherAnswer?: string;
  otherLabel: string;
  cols: number;
}

export const QuestionOptionViewportV2 = React.memo(function QuestionOptionViewportV2({
  question,
  focusIndex,
  inputMode,
  otherDraft,
  otherCursor,
  selected,
  otherAnswer,
  otherLabel,
  cols,
}: QuestionOptionViewportV2Props): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(1, cols);
  const multi = question.multiSelect;
  const optionIndent = multi ? 7 : 4;
  const descriptionWidth = Math.max(1, width - optionIndent);
  const otherIndex = question.options.length;
  const chatIndex = otherIndex + 1;
  const otherAnswered = Boolean(otherAnswer?.trim());
  const help = inputMode
    ? 'Enter: Save Other · Esc: Cancel interview'
    : 'Enter: Select · ↑/↓: Navigate · Esc: Cancel interview';

  return (
    <Box flexDirection="column" marginTop={1}>
      {question.options.map((option, index) => {
        const focused = focusIndex === index;
        const checked = selected.includes(option.label);
        const marker = multi ? `${checked ? '☑' : '☐'} ` : '';
        return (
          <React.Fragment key={option.label}>
            <Text>
              <Text color={focused ? theme.suggestion : undefined}>{focused ? '❯ ' : '  '}</Text>
              <Text color={checked ? theme.success : focused ? theme.suggestion : undefined}>
                {`${marker}${index + 1}. ${option.label}`}
              </Text>
            </Text>
            {foldLine(option.description, descriptionWidth).map((line, lineIndex) => (
              <Text key={`${option.label}-description-${lineIndex}`} color={theme.textMuted}>
                {`${' '.repeat(optionIndent)}${line}`}
              </Text>
            ))}
          </React.Fragment>
        );
      })}

      <Text>
        <Text color={otherAnswered ? theme.success : focusIndex === otherIndex ? theme.suggestion : undefined}>
          {focusIndex === otherIndex ? '❯ ' : '  '}
        </Text>
        <Text color={focusIndex === otherIndex ? theme.suggestion : undefined}>
          {inputMode
            ? `${otherIndex + 1}. ${otherLabel}: ${otherDraft.slice(0, otherCursor)}|${otherDraft.slice(otherCursor)}`
            : `${otherIndex + 1}. ${otherLabel}`}
        </Text>
      </Text>

      <Text color={theme.textMuted}>{'─'.repeat(width)}</Text>
      <Text>
        <Text color={focusIndex === chatIndex ? theme.suggestion : undefined}>
          {focusIndex === chatIndex ? '❯ ' : '  '}
        </Text>
        <Text color={focusIndex === chatIndex ? theme.suggestion : undefined}>
          {`${otherIndex + 2}. Chat about this`}
        </Text>
      </Text>
      <Box marginTop={1}>
        <Text color={theme.textMuted} dimColor>
          {truncateDisplay(help, width)}
        </Text>
      </Box>
    </Box>
  );
});
```

Chat uses the next unique visible number after Other (`options.length + 2`). This is presentation only: Chat's store focus index remains `options.length + 1`, so Phase 1a does not alter input behavior.

- [ ] **Step 4: Replace only the current-question row renderer**

In the question branch of `AskQuestionOverlayV2.tsx`, keep the existing question title and Other state subscription, delete the local `rows` construction, and render:

```tsx
{foldLine(question.question, width).map((line, index) => (
  <Text key={`question-${index}`} bold color={theme.textPrimary}>{line}</Text>
))}
<QuestionOptionViewportV2
  question={question}
  focusIndex={state.focusIndex}
  inputMode={state.inputMode}
  otherDraft={state.otherDraft}
  otherCursor={state.otherCursor}
  selected={state.selected[question.question] ?? []}
  otherAnswer={state.others[question.question]}
  otherLabel={state.request.otherLabel ?? 'Other'}
  cols={width}
/>
```

Import `useTheme` in `AskQuestionOverlayV2` and retain `foldLine` for the question title exactly as shown. Remove `truncateLine` only after the compiler confirms no remaining caller.

- [ ] **Step 5: Run focused overlay tests and fix presentation-only mismatches**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
```

Expected: all overlay tests pass. The existing test that expects `bec|ause` must continue to pass.

- [ ] **Step 6: Prove behavior files did not change and run behavior regressions**

Run:

```powershell
git diff --exit-code -- src/tui/state/ask-question-store.ts src/tui/input/use-input-handler.ts
npm.cmd test -- src/__tests__/tui/ask-question-store.test.ts src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
```

Expected: `git diff --exit-code` exits 0; all behavior tests pass with their original assertions.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- src/tui/inline-v2/QuestionOptionViewportV2.tsx src/tui/inline-v2/AskQuestionOverlayV2.tsx src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
git commit -m "style(ask-user): clarify option focus and footer hierarchy"
```

---

### Task 3: Build the answer-review Submit view

**Files:**
- Create: `src/tui/inline-v2/QuestionSubmitViewV2.tsx`
- Modify: `src/tui/inline-v2/AskQuestionOverlayV2.tsx`
- Modify: `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`

**Interfaces:**
- Consumes: normalized questions, existing `selected` and `others` records, unchanged Submit-page `focusIndex`, and `cols`.
- Produces:

```ts
export interface QuestionSubmitViewV2Props {
  questions: readonly AskQuestion[];
  selected: Record<string, string[]>;
  others: Record<string, string>;
  focusIndex: number;
  cols: number;
}
```

- Phase 1a answer resolution remains the current behavior: non-empty Other replaces selected labels; otherwise selected labels join with `, `. Additive multi-select Other belongs to Phase 1b.

- [ ] **Step 1: Add failing answer-review frame tests**

Add to `ask-question-overlay.test.tsx`. Replace the existing `warns when the Submit page has unanswered questions` test with the explicit warning test below; the old sentence is intentionally removed:

```tsx
it('renders answered questions as bullet and success-arrow rows on Submit', () => {
  const store = openStore();
  store.setState({
    pageIndex: request.questions.length,
    selected: { Q1: ['A'] },
    others: { Q2: 'custom' },
  });

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const frame = frameLines(lastFrame()).join('\n');

  expect(frame).toContain('Review your answers');
  expect(frame).toContain('● Q1');
  expect(frame).toContain('→ A');
  expect(frame).toContain('● Q2');
  expect(frame).toContain('→ custom');
  expect(frame).toContain('Ready to submit your answers?');
});

it('renders an explicit warning and omits unanswered questions from the summary', () => {
  const store = openStore();
  store.setState({ pageIndex: request.questions.length, selected: { Q1: ['A'] } });

  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);
  const frame = frameLines(lastFrame()).join('\n');

  expect(frame).toContain('⚠ You have not answered all questions');
  expect(frame).toContain('● Q1');
  expect(frame).not.toContain('● Q2');
});

it('uses the Claude Code pointer for Submit and Cancel without changing focus behavior', async () => {
  const store = openStore();
  store.setState({ pageIndex: request.questions.length, focusIndex: 0 });
  const { lastFrame } = render(<AskQuestionOverlayV2 store={store} cols={80} />);

  expect(frameLines(lastFrame()).join('\n')).toContain('❯ 1. Submit answers');
  store.getState().moveFocusNext();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(frameLines(lastFrame()).join('\n')).toContain('❯ 2. Cancel');
});
```

- [ ] **Step 2: Run the overlay test and verify RED**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
```

Expected: new tests fail because the current Submit branch has no answer summary, bullet/arrow rows, `Review your answers`, or `❯` actions.

- [ ] **Step 3: Implement `QuestionSubmitViewV2`**

Create `QuestionSubmitViewV2.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import type { AskQuestion } from '../../agent/ask-user-types.js';
import { useTheme } from '../state/theme-context.js';
import { truncateDisplay } from './ask-question-layout.js';

export interface QuestionSubmitViewV2Props {
  questions: readonly AskQuestion[];
  selected: Record<string, string[]>;
  others: Record<string, string>;
  focusIndex: number;
  cols: number;
}

function answerFor(
  question: AskQuestion,
  selected: Record<string, string[]>,
  others: Record<string, string>,
): string | undefined {
  const other = others[question.question]?.trim();
  if (other) return other;
  const labels = selected[question.question] ?? [];
  return labels.length > 0 ? labels.join(', ') : undefined;
}

export const QuestionSubmitViewV2 = React.memo(function QuestionSubmitViewV2({
  questions,
  selected,
  others,
  focusIndex,
  cols,
}: QuestionSubmitViewV2Props): React.ReactElement {
  const theme = useTheme();
  const width = Math.max(1, cols);
  const answers = questions.map((question) => ({
    question: question.question,
    answer: answerFor(question, selected, others),
  }));
  const unanswered = answers.some((item) => item.answer === undefined);

  const action = (index: number, label: string) => {
    const focused = focusIndex === index;
    return (
      <Text>
        <Text color={focused ? theme.suggestion : undefined}>{focused ? '❯ ' : '  '}</Text>
        <Text color={focused ? theme.suggestion : undefined}>{`${index + 1}. ${label}`}</Text>
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Text bold color={theme.textPrimary}>Review your answers</Text>
      <Text color={theme.textMuted}>{'─'.repeat(width)}</Text>
      {unanswered && <Text color={theme.warning}>⚠ You have not answered all questions</Text>}
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {answers.filter((item) => item.answer !== undefined).map((item) => (
          <Box key={item.question} flexDirection="column" marginLeft={1}>
            <Text>{truncateDisplay(`● ${item.question}`, Math.max(1, width - 1))}</Text>
            <Box marginLeft={2}>
              <Text color={theme.success}>
                {truncateDisplay(`→ ${item.answer}`, Math.max(1, width - 3))}
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
      <Text color={theme.textMuted}>Ready to submit your answers?</Text>
      <Box flexDirection="column" marginTop={1}>
        {action(0, 'Submit answers')}
        {action(1, 'Cancel')}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.textMuted} dimColor>
          {truncateDisplay('Enter: Select · Esc: Cancel interview', width)}
        </Text>
      </Box>
    </Box>
  );
});
```

- [ ] **Step 4: Compose the Submit view without changing store behavior**

In the no-current-question branch of `AskQuestionOverlayV2.tsx`, retain `QuestionNavigationBarV2`, delete the inline warning/actions, and render:

```tsx
<QuestionSubmitViewV2
  questions={questions}
  selected={state.selected}
  others={state.others}
  focusIndex={state.focusIndex}
  cols={width}
/>
```

- [ ] **Step 5: Run the focused overlay test and verify GREEN**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
```

Expected: all tests pass, including the original unanswered-warning and focus-change tests after updating their purely visual `>` expectations to `❯`.

- [ ] **Step 6: Run normal-question and plan-approval regressions**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx src/__tests__/tui/inline-v2/exit-plan-mode-routing.test.tsx src/__tests__/plan-approval.test.ts
```

Expected: all tests pass; plan approval output retains its existing dedicated border, labels, and help.

- [ ] **Step 7: Commit Task 3**

```powershell
git add -- src/tui/inline-v2/QuestionSubmitViewV2.tsx src/tui/inline-v2/AskQuestionOverlayV2.tsx src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
git commit -m "style(ask-user): add answer review presentation"
```

---

### Task 4: Verify Phase 1a as an independently deliverable visual slice

**Files:**
- Create: `logs/AUTO-0025-ask-user-phase1a.md`
- Verify only: all files listed under Regression-only.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: reproducible automated and real-terminal evidence that Phase 1a changed presentation only.

- [ ] **Step 1: Run the complete Phase 1a focused suite**

Run:

```powershell
npm.cmd test -- src/__tests__/tui/inline-v2/ask-question-layout.test.ts src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/ask-question-store.test.ts src/__tests__/tui/use-input-handler.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx src/__tests__/tui/inline-v2/exit-plan-mode-routing.test.tsx src/__tests__/plan-approval.test.ts
```

Expected: every test passes with zero unhandled errors.

- [ ] **Step 2: Run typecheck and lint**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run lint
```

Expected: both commands exit 0; no unused import, floating promise, or TypeScript error.

- [ ] **Step 3: Run the full test suite because Phase 1a changes the active Inline V2 composition**

Run:

```powershell
npm.cmd test
```

Expected: full suite passes.

- [ ] **Step 4: Inspect the diff boundary before real-terminal QA**

Run:

```powershell
git diff --name-only HEAD~3..HEAD
git diff --exit-code HEAD~3..HEAD -- src/tui/state/ask-question-store.ts src/tui/input/use-input-handler.ts src/tui/inline-v2/ExitPlanModeOverlayV2.tsx
git status --short
```

Expected: only Phase 1a components/tests plus the plan/log are present; the second command exits 0; the pre-existing unstaged `package-lock.json` remains untouched.

- [ ] **Step 5: Perform real-terminal visual checks**

Start the CLI using the repository's normal development entry point and open ordinary AskUserQuestion fixtures that cover:

```text
80 columns / dark theme / four questions / current middle question
40 columns / dark theme / four questions / compact aggregate navigation
80 columns / light theme / multi-select with one selected option
80 columns / Other focused and Other input mode
80 columns / Submit view with all answers
80 columns / Submit view with an unanswered warning
Plan approval / all three approval choices / Other / Chat / Esc
```

For each ordinary-question frame confirm:

```text
current tab = suggestion background + selectionFg
focus pointer = suggestion-colored ❯
selected option = success color
description/divider/help = textMuted
title = bold textPrimary
help explicitly says Esc: Cancel interview
no line exceeds the selected terminal width
```

Expected: ordinary questionnaire matches the approved hierarchy; behavior remains unchanged; plan approval is visually unchanged.

- [ ] **Step 6: Record verification evidence**

Create `logs/AUTO-0025-ask-user-phase1a.md` with this exact structure, replacing command result fields with observed counts and exit codes:

```markdown
# AUTO-0025 AskUserQuestion Phase 1a Verification

## Scope

Visual-only questionnaire slice: navigation, option hierarchy, footer/help, and Submit review. Store, input routing, outcomes, and plan approval behavior are unchanged.

## TDD evidence

- 40/80 navigation tests observed RED before implementation: yes
- option/footer visual tests observed RED before implementation: yes
- Submit review tests observed RED before implementation: yes

## Automated verification

- Focused suite: PASS — exit 0
- Typecheck: PASS — exit 0
- Lint: PASS — exit 0
- Full suite: PASS — exit 0

## Real-terminal verification

- 80-column full navigation: PASS
- 40-column compact navigation: PASS
- dark/light semantic colors: PASS
- Other pipe-cursor presentation retained: PASS
- answered/unanswered Submit review: PASS
- plan approval visual and behavior regression: PASS

## Result

Phase 1a is independently deliverable. Phase 1b may begin with grapheme/display-width foundations, then the approved state-machine `it.each` RED tables.
```

- [ ] **Step 7: Commit the verification record**

```powershell
git add -- logs/AUTO-0025-ask-user-phase1a.md
git commit -m "test(ask-user): record Phase 1a verification"
```

---

## Phase 1a Completion Gate

Do not begin Phase 1b until all of the following are true:

- 40/80-column visual assertions pass.
- Existing questionnaire behavior tests pass without semantic assertion changes.
- Plan approval overlay, routing, approval, Other, Chat, and Esc tests pass.
- Typecheck, lint, focused tests, and full suite pass.
- Real-terminal dark/light and 40/80-column checks pass.
- `AskQuestionStore`, `useInputHandler`, and `ExitPlanModeOverlayV2` have no Phase 1a diff.
- The pre-existing `package-lock.json` change remains unstaged.

## Required Phase 1b Plan Prelude

The later Phase 1b implementation plan must begin with a pure display-layout task before the state-machine tables:

1. Audit the existing `displayWidth`/`foldLine` behavior.
2. Add RED tests for CJK double width, emoji, ANSI sequences, combining marks, and zero-width-joiner emoji.
3. Implement a shared grapheme/display-width wrapper in `ask-question-layout.ts` using existing dependencies only.
4. Add a case-sensitive multi-select Other dedupe test proving preset `Yes` plus Other `yes` produces both values; use strict `===`, never lowercase normalization.
5. Only after that foundation is GREEN, add the approved focus and Esc `it.each` RED tables.
