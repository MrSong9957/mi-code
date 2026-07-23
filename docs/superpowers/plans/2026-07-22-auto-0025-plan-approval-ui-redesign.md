# AUTO-0025 Plan Approval UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic `exit_plan_mode` questionnaire chrome with a dedicated main-screen plan approval view that renders the saved Markdown plan and preserves all approved outcomes.

**Architecture:** Add an optional internal presentation variant to the normalized questionnaire request. `plan-tools.ts` attaches a frontmatter-free plan snapshot; `AskUserManager` and `AskQuestionStore` transport it unchanged; `InlineAppV2` routes only `kind: 'plan-approval'` to a focused `ExitPlanModeOverlayV2` component and keeps the generic questionnaire path untouched.

**Tech Stack:** TypeScript ES2022/NodeNext, React, Ink, Zustand vanilla/react, Vitest, ink-testing-library, existing `marked`-based `renderMarkdown()` and semantic theme.

## Global Constraints

- Render on the main terminal screen; do not enter alternate screen.
- Do not implement `FullscreenLayout`, sticky footer, independent plan scrolling, or `Ctrl+G` editing in this change.
- Preserve the public tool JSON schema, manager settlement behavior, outcomes, provider tool-result protocol, and ordinary `AskUserQuestion` visuals.
- Keep the approved Chinese copy, three approval mappings, Other, Chat, and Esc behavior exactly as specified.
- Wrap plan and decision content by terminal display width; do not truncate it.
- Reuse `renderMarkdown()` and existing semantic theme colors; add no theme slot and no dependency.
- Strip only a complete frontmatter block at the start of the plan snapshot; never modify the plan file on disk.
- Markdown failure must log the error and degrade to visible plain text without blocking approval.
- Accepted repository baseline remains: three `background.test.ts` timeout/status failures and two `layout.test.tsx` ANSI-sensitive failures; full lint also has documented pre-existing debt. Do not change unrelated debt.

## File Structure

- Create `src/plan/plan-presentation.ts`: pure frontmatter-to-display-content conversion.
- Modify `src/agent/ask-user-types.ts`: internal `PlanApprovalPresentation` and optional request field only.
- Modify `src/agent/tools/plan-tools.ts`: attach the plan presentation snapshot to the existing approval request.
- Create `src/tui/inline-v2/ExitPlanModeOverlayV2.tsx`: dedicated plan display and approval visuals; no state-machine logic.
- Modify `src/tui/inline-v2/InlineAppV2.tsx`: route recognized plan presentations to the dedicated component, otherwise retain the generic overlay.
- Create `src/__tests__/plan-presentation.test.ts`: pure conversion behavior.
- Modify `src/__tests__/plan-approval.test.ts`: plan snapshot and schema isolation at the tool boundary.
- Create `src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx`: dedicated visual, fallback, wrapping, and Markdown degradation behavior.
- Modify `src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`: production routing plus real key/outcome behavior.
- Modify `logs/auto-0025-verification.md`: append exact verification evidence and the renewed real-terminal gate.

## Wheel Reuse Check

- `PlanStore.getCurrent()` remains the source of truth for plan content and path.
- `AskUserManager` remains the single-pending/request-ID coordinator; no plan-specific branch is added.
- `AskQuestionStore` remains the sole keyboard interaction and outcome state machine.
- `renderMarkdown()` remains the Markdown renderer; the new component only adds an error boundary around invocation.
- `getTheme()` supplies `brand`, `borderMuted`, `suggestion`, and `textMuted`; no direct RGB values are introduced.
- Ink flex wrapping handles visible content; no new text-layout package is added.

## Core Anchor Function

The end-to-end anchor is the render branch in `InlineAppV2`:

```tsx
request?.presentation?.kind === 'plan-approval'
  ? <ExitPlanModeOverlayV2 ... />
  : <AskQuestionOverlayV2 ... />
```

Its input is the exact request held by `AskQuestionStore`; its output is the user-visible component. Tasks first create the typed presentation data, then the dedicated renderer, then connect this branch and prove the existing store produces unchanged outcomes.

## Defense Boundaries

- No current plan: `exit_plan_mode` returns its existing error before `manager.ask()`.
- Empty display body: render `未找到计划正文` while leaving controls active.
- Markdown exception: `console.error` once and render the same source as plain text.
- Missing or unknown presentation: route to the generic overlay instead of returning a blank UI.
- Manager replacement: presentation is a request field, so closing/resetting the old request removes its plan snapshot atomically.
- Narrow terminal: use Ink wrapping inside width-bounded rows; tests reject any rendered line wider than `cols` and verify normalized content is preserved.

---

### Task 1: Plan Presentation Contract and Snapshot

**Files:**
- Create: `src/plan/plan-presentation.ts`
- Modify: `src/agent/ask-user-types.ts`
- Modify: `src/agent/tools/plan-tools.ts`
- Create: `src/__tests__/plan-presentation.test.ts`
- Modify: `src/__tests__/plan-approval.test.ts`
- Modify: `src/__tests__/ask-user.test.ts`

**Interfaces:**
- Consumes: `PlanStore.getCurrent(): PlanEntry | null`; existing `AskQuestionRequest` passed through `AskUserManager.ask()`.
- Produces: `stripPlanFrontmatter(content: string): string`; `PlanApprovalPresentation`; `AskQuestionRequest.presentation?: PlanApprovalPresentation`.

- [ ] **Step 1: Write failing frontmatter conversion tests**

Create `src/__tests__/plan-presentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { stripPlanFrontmatter } from '../plan/plan-presentation.js';

describe('stripPlanFrontmatter', () => {
  it.each(['\n', '\r\n'])('strips one complete leading block with %j newlines', (nl) => {
    const input = [
      '---',
      'session: sess-1',
      'status: pending',
      '---',
      '',
      '# Plan',
      '',
      'Do **this**.',
    ].join(nl);

    expect(stripPlanFrontmatter(input)).toBe(['# Plan', '', 'Do **this**.'].join(nl));
  });

  it('preserves thematic breaks in the Markdown body', () => {
    expect(stripPlanFrontmatter('# Plan\n\n---\n\nNext')).toBe('# Plan\n\n---\n\nNext');
  });

  it('preserves an incomplete leading frontmatter block', () => {
    expect(stripPlanFrontmatter('---\nstatus: pending\n# Plan')).toBe('---\nstatus: pending\n# Plan');
  });

  it('returns an empty string when the file contains only frontmatter', () => {
    expect(stripPlanFrontmatter('---\nsession: sess-1\n---\n')).toBe('');
  });
});
```

- [ ] **Step 2: Run the new test and observe the intended RED state**

Run:

```bash
npx vitest run src/__tests__/plan-presentation.test.ts
```

Expected: FAIL because `src/plan/plan-presentation.ts` does not exist.

- [ ] **Step 3: Implement the pure frontmatter conversion**

Create `src/plan/plan-presentation.ts`:

```ts
const LEADING_FRONTMATTER = /^---(\r?\n)[\s\S]*?\1---(?:\1|$)/;

/** Remove one complete leading YAML frontmatter block for display only. */
export function stripPlanFrontmatter(content: string): string {
  const match = content.match(LEADING_FRONTMATTER);
  if (!match) return content;
  return content.slice(match[0].length).replace(/^\r?\n/, '');
}
```

- [ ] **Step 4: Run the conversion tests and confirm GREEN**

Run:

```bash
npx vitest run src/__tests__/plan-presentation.test.ts
```

Expected: 1 file and 5 parameterized tests pass.

- [ ] **Step 5: Write failing tool-boundary tests for the internal snapshot and public-schema isolation**

In `src/__tests__/plan-approval.test.ts`, extend `opens the normalized three-option approval questionnaire` after the `otherLabel` assertion:

```ts
expect(request.presentation).toEqual({
  kind: 'plan-approval',
  content: 'plan body\n',
  filePath: expect.stringMatching(/\.md$/),
});
```

Add a separate test in the same `exit_plan_mode 工具` describe block:

```ts
it('keeps presentation metadata out of the public tool schema', () => {
  const { tool } = createReadyTool();
  expect(JSON.stringify(tool.definition.parameters)).not.toContain('presentation');
});
```

In `src/__tests__/ask-user.test.ts`, extend `publishes only the nested questionnaire schema`:

```ts
expect(JSON.stringify(definition.parameters)).not.toContain('presentation');
```

- [ ] **Step 6: Run the tool tests and observe the intended RED state**

Run:

```bash
npx vitest run src/__tests__/plan-approval.test.ts src/__tests__/ask-user.test.ts
```

Expected: the snapshot assertion fails because `request.presentation` is undefined; existing schema assertions remain green.

- [ ] **Step 7: Add the internal presentation type and attach the snapshot**

Add to `src/agent/ask-user-types.ts` before `AskQuestionRequest`:

```ts
export interface PlanApprovalPresentation {
  kind: 'plan-approval';
  content: string;
  filePath: string;
}
```

Extend the request interface:

```ts
export interface AskQuestionRequest {
  questions: AskQuestion[];
  otherLabel?: string;
  presentation?: PlanApprovalPresentation;
}
```

In `src/agent/tools/plan-tools.ts`, import the converter:

```ts
import { stripPlanFrontmatter } from '../../plan/plan-presentation.js';
```

Add the field to the request constructed by `exit_plan_mode`:

```ts
presentation: {
  kind: 'plan-approval',
  content: stripPlanFrontmatter(plan.content),
  filePath: plan.filePath,
},
```

Do not modify `AskUserManager`, `AskQuestionStore`, or either public tool definition.

- [ ] **Step 8: Run Task 1 tests and typecheck**

Run:

```bash
npx vitest run src/__tests__/plan-presentation.test.ts src/__tests__/plan-approval.test.ts src/__tests__/ask-user.test.ts
npm run typecheck
```

Expected: all three test files pass and TypeScript exits 0.

- [ ] **Step 9: Commit Task 1**

```bash
git add src/plan/plan-presentation.ts src/agent/ask-user-types.ts src/agent/tools/plan-tools.ts src/__tests__/plan-presentation.test.ts src/__tests__/plan-approval.test.ts src/__tests__/ask-user.test.ts
git commit -m "feat(plan): attach approval presentation snapshot"
```

---

### Task 2: Dedicated Plan Approval Visual Component

**Files:**
- Create: `src/tui/inline-v2/ExitPlanModeOverlayV2.tsx`
- Create: `src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx`

**Interfaces:**
- Consumes: `AskQuestionStore`; `AskQuestionRequest.presentation`; `renderMarkdown(text)`; `getTheme()`; terminal `cols`.
- Produces: `ExitPlanModeOverlayV2({ store, cols })`; `renderPlanContent(content, renderer?)` for the explicit Markdown fallback boundary.

- [ ] **Step 1: Write failing component tests for content hierarchy and specialized chrome**

Create `src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx`:

```tsx
import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { AskQuestionRequest } from '../../../agent/ask-user-types.js';
import { displayWidth } from '../../../tui/inline/text-layout.js';
import {
  ExitPlanModeOverlayV2,
  renderPlanContent,
} from '../../../tui/inline-v2/ExitPlanModeOverlayV2.js';
import { createAskQuestionStore } from '../../../tui/state/ask-question-store.js';

const request: AskQuestionRequest = {
  questions: [{
    header: 'Plan',
    question: 'Claude 已拟定执行方案，是否继续？',
    multiSelect: false,
    options: [
      {
        label: '确认执行，清空上下文并使用自动模式',
        description: '重置对话（已占用 5%），Agent 自动执行所有修改',
      },
      {
        label: '确认执行，使用自动模式',
        description: '保留当前上下文，Agent 自动执行所有修改',
      },
      {
        label: '确认执行，手动审核修改',
        description: '保留当前上下文，每步修改需你确认',
      },
    ],
  }],
  otherLabel: '提出修改意见',
  presentation: {
    kind: 'plan-approval',
    content: '# MiCode 项目改造计划\n\n1. **第一步**\n2. 第二步',
    filePath: 'C:\\Users\\tester\\.micode\\plans\\plan.md',
  },
};

function openStore(value: AskQuestionRequest = request) {
  const store = createAskQuestionStore();
  store.getState().open('plan-1', value, () => {});
  return store;
}

describe('<ExitPlanModeOverlayV2>', () => {
  it('renders the dedicated Chinese hierarchy and Markdown plan', () => {
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={openStore()} cols={80} />);
    const frame = lastFrame() ?? '';

    expect(frame).toContain('准备开始编码？');
    expect(frame).toContain('以下是 Agent 拟定的计划：');
    expect(frame).toContain('MiCode 项目改造计划');
    expect(frame).toContain('第一步');
    expect(frame).toContain('Agent 已完成计划，是否继续执行？');
    expect(frame).toContain('❯ ☐ 确认执行，清空上下文并使用自动模式');
    expect(frame).toContain('提出修改意见');
    expect(frame).toContain('与 Agent 讨论此计划');
    expect(frame).toContain('↑↓ 导航 · Enter 选择 · Esc 取消');
    expect(frame).not.toContain('Plan · Submit');
    expect(frame).not.toContain('[ ]');
    expect(frame).not.toContain('[x]');
  });

  it('renders Other input in place with a visible cursor', () => {
    const store = openStore();
    store.setState({
      focusIndex: request.questions[0]!.options.length,
      inputMode: true,
      otherDraft: '请先补充测试',
      otherCursor: 3,
    });
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={store} cols={80} />);

    expect(lastFrame()).toContain('提出修改意见：请先补▌充测试');
    expect(lastFrame()).toContain('Enter 保存意见 · Esc 取消');
  });

  it('keeps decision content within a narrow terminal without dropping text', () => {
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={openStore()} cols={32} />);
    const frame = lastFrame() ?? '';

    for (const line of frame.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(32);
    }
    expect(frame.replace(/\s/g, '')).toContain('确认执行，清空上下文并使用自动模式');
    expect(frame.replace(/\s/g, '')).toContain('重置对话（已占用5%），Agent自动执行所有修改');
  });

  it('shows an actionable placeholder for empty content', () => {
    const emptyRequest: AskQuestionRequest = {
      ...request,
      presentation: { ...request.presentation!, content: '' },
    };
    const { lastFrame } = render(<ExitPlanModeOverlayV2 store={openStore(emptyRequest)} cols={80} />);
    expect(lastFrame()).toContain('未找到计划正文');
    expect(lastFrame()).toContain('确认执行，使用自动模式');
  });
});

describe('renderPlanContent', () => {
  it('logs and degrades to plain text when Markdown rendering throws', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const renderer = vi.fn(() => { throw new Error('bad markdown'); });
    try {
      const { lastFrame } = render(renderPlanContent('# raw plan', renderer));
      expect(lastFrame()).toContain('# raw plan');
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });

  it('uses the supplied Markdown renderer when it succeeds', () => {
    const renderer = vi.fn((content: string) => <Text>{`rendered:${content}`}</Text>);
    const { lastFrame } = render(renderPlanContent('# Plan', renderer));
    expect(lastFrame()).toContain('rendered:# Plan');
  });
});
```

- [ ] **Step 2: Run the component test and observe the intended RED state**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx
```

Expected: FAIL because `ExitPlanModeOverlayV2.tsx` does not exist.

- [ ] **Step 3: Implement the dedicated component and Markdown error boundary**

Create `src/tui/inline-v2/ExitPlanModeOverlayV2.tsx`:

```tsx
import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { renderMarkdown } from '../markdown/render-markdown.js';
import { getTheme } from '../../utils/theme.js';
import type { AskQuestionStore } from '../state/ask-question-store.js';

export interface ExitPlanModeOverlayV2Props {
  store: AskQuestionStore;
  cols: number;
}

type PlanRenderer = (content: string) => React.ReactElement;

export function renderPlanContent(
  content: string,
  renderer: PlanRenderer = renderMarkdown,
): React.ReactElement {
  const visibleContent = content.trim() || '未找到计划正文';
  try {
    return renderer(visibleContent);
  } catch (error) {
    console.error('Failed to render plan Markdown:', error);
    return <Text>{visibleContent}</Text>;
  }
}

export const ExitPlanModeOverlayV2 = React.memo(function ExitPlanModeOverlayV2({
  store,
  cols,
}: ExitPlanModeOverlayV2Props): React.ReactElement | null {
  const state = useStore(store, useShallow((value) => ({
    visible: value.visible,
    request: value.request,
    focusIndex: value.focusIndex,
    inputMode: value.inputMode,
    otherDraft: value.otherDraft,
    otherCursor: value.otherCursor,
  })));

  const presentation = state.request?.presentation;
  const question = state.request?.questions[0];
  if (!state.visible || presentation?.kind !== 'plan-approval' || !question) return null;

  const theme = getTheme();
  const width = Math.max(1, cols);
  const separator = '┄'.repeat(Math.max(1, width - 4));
  const otherIndex = question.options.length;
  const chatIndex = otherIndex + 1;
  const otherLabel = state.request?.otherLabel ?? '提出修改意见';
  const cursor = Math.min(state.otherCursor, state.otherDraft.length);
  const otherText = state.inputMode
    ? `${otherLabel}：${state.otherDraft.slice(0, cursor)}▌${state.otherDraft.slice(cursor)}`
    : otherLabel;
  const help = state.inputMode
    ? 'Enter 保存意见 · Esc 取消'
    : '↑↓ 导航 · Enter 选择 · Esc 取消';

  return (
    <Box
      width={width}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.brand}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
      marginTop={1}
    >
      <Box paddingX={1} flexDirection="column">
        <Text bold color={theme.brand}>准备开始编码？</Text>
        <Box marginTop={1}><Text>以下是 Agent 拟定的计划：</Text></Box>
        <Text color={theme.borderMuted}>{separator}</Text>
        {renderPlanContent(presentation.content)}
        <Text color={theme.borderMuted}>{separator}</Text>
        <Box marginTop={1}>
          <Text color={theme.textMuted}>Agent 已完成计划，是否继续执行？</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {question.options.map((option, index) => {
            const focused = state.focusIndex === index;
            return (
              <Box key={option.label} flexDirection="column">
                <Box flexDirection="row">
                  <Text color={focused ? theme.suggestion : undefined}>
                    {focused ? '❯ ☐ ' : '  ☐ '}
                  </Text>
                  <Box flexGrow={1}>
                    <Text color={focused ? theme.suggestion : undefined} wrap="wrap">
                      {option.label}
                    </Text>
                  </Box>
                </Box>
                <Box marginLeft={4}>
                  <Text color={theme.textMuted} wrap="wrap">{option.description}</Text>
                </Box>
              </Box>
            );
          })}
          <Box flexDirection="row">
            <Text color={state.focusIndex === otherIndex ? theme.suggestion : theme.textMuted}>
              {state.focusIndex === otherIndex ? '❯ ' : '  '}
            </Text>
            <Box flexGrow={1}>
              <Text color={state.focusIndex === otherIndex ? theme.suggestion : theme.textMuted} wrap="wrap">
                {otherText}
              </Text>
            </Box>
          </Box>
          <Box flexDirection="row">
            <Text color={state.focusIndex === chatIndex ? theme.suggestion : theme.textMuted}>
              {state.focusIndex === chatIndex ? '❯ ' : '  '}
            </Text>
            <Text color={state.focusIndex === chatIndex ? theme.suggestion : theme.textMuted}>
              与 Agent 讨论此计划
            </Text>
          </Box>
        </Box>
        <Box marginTop={1}><Text color={theme.textMuted}>{help}</Text></Box>
      </Box>
    </Box>
  );
});
```

- [ ] **Step 4: Run the component and existing Markdown tests**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx src/__tests__/tui/render-markdown.test.tsx
npm run typecheck
```

Expected: both test files pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/tui/inline-v2/ExitPlanModeOverlayV2.tsx src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx
git commit -m "feat(tui): render dedicated plan approval dialog"
```

---

### Task 3: Production Routing and Interaction Regression

**Files:**
- Modify: `src/tui/inline-v2/InlineAppV2.tsx`
- Modify: `src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`
- Test: `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`
- Test: `src/__tests__/tui/ask-question-store.test.ts`

**Interfaces:**
- Consumes: `ExitPlanModeOverlayV2`; `AskQuestionStore.request.presentation?.kind`.
- Produces: production render routing with generic fallback and unchanged key-to-outcome behavior.

- [ ] **Step 1: Write failing E2E routing tests**

In `src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`, add after `singleRequest`:

```ts
const planRequest: AskQuestionRequest = {
  questions: [{
    header: 'Plan',
    question: 'Claude 已拟定执行方案，是否继续？',
    multiSelect: false,
    options: [
      { label: '自动执行', description: '保留上下文并自动执行' },
      { label: '手动审核', description: '逐步审核修改' },
    ],
  }],
  otherLabel: '提出修改意见',
  presentation: {
    kind: 'plan-approval',
    content: '# Routed Plan\n\n- verify routing',
    filePath: 'C:\\plans\\routed.md',
  },
};
```

Add these tests inside the existing questionnaire describe block:

```tsx
it('routes plan approval presentations to the dedicated view and preserves Enter outcome', async () => {
  const h = createE2EHarness();
  const onOutcome = vi.fn();
  try {
    h.stores.askQuestionStore.getState().open('plan-route', planRequest, onOutcome);
    await waitMs(20);

    const frame = h.lastFrame() ?? '';
    expect(frame).toContain('准备开始编码？');
    expect(frame).toContain('Routed Plan');
    expect(frame).not.toContain('Plan · Submit');

    h.stdin.write(KEYS.ENTER);
    await waitMs(20);
    expect(onOutcome).toHaveBeenCalledWith('plan-route', {
      kind: 'submitted',
      answers: { 'Claude 已拟定执行方案，是否继续？': '自动执行' },
    });
  } finally {
    h.unmount();
  }
});

it('keeps ordinary questionnaires on the generic overlay', async () => {
  const h = createE2EHarness();
  try {
    h.stores.askQuestionStore.getState().open('generic-route', singleRequest, () => {});
    await waitMs(20);

    const frame = h.lastFrame() ?? '';
    expect(frame).toContain('Choose a runtime');
    expect(frame).toContain('Chat about this');
    expect(frame).not.toContain('准备开始编码？');
  } finally {
    h.unmount();
  }
});

it('falls back to the generic overlay for an unknown internal presentation', async () => {
  const h = createE2EHarness();
  const unknownRequest = {
    ...singleRequest,
    presentation: { kind: 'future-view' },
  } as unknown as AskQuestionRequest;
  try {
    h.stores.askQuestionStore.getState().open('unknown-route', unknownRequest, () => {});
    await waitMs(20);

    expect(h.lastFrame()).toContain('Choose a runtime');
    expect(h.lastFrame()).not.toContain('准备开始编码？');
  } finally {
    h.unmount();
  }
});
```

- [ ] **Step 2: Run the routing tests and observe the intended RED state**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
```

Expected: the plan routing assertion fails because `InlineAppV2` still renders `AskQuestionOverlayV2`; the generic fallback tests pass.

- [ ] **Step 3: Add the production routing branch**

In `src/tui/inline-v2/InlineAppV2.tsx`, import the dedicated component:

```ts
import { ExitPlanModeOverlayV2 } from './ExitPlanModeOverlayV2.js';
```

Subscribe to the presentation kind next to `askQuestionVisible`:

```ts
const askQuestionPresentationKind = useStore(
  stores.askQuestionStore,
  (s) => s.request?.presentation?.kind,
);
```

Replace only the visible-question JSX branch:

```tsx
{askQuestionVisible ? (
  askQuestionPresentationKind === 'plan-approval' ? (
    <ExitPlanModeOverlayV2 store={stores.askQuestionStore} cols={cols} />
  ) : (
    <AskQuestionOverlayV2 store={stores.askQuestionStore} cols={cols} />
  )
) : selectVisible ? (
```

Do not change the `<Static>` root identity, `OverlayHost`, spinner/footer branch, or `AskQuestionOverlayV2`.

- [ ] **Step 4: Run routing, generic overlay, and state-machine regression tests**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/ask-question-store.test.ts
npm run typecheck
```

Expected: all listed tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 3**

```bash
git add src/tui/inline-v2/InlineAppV2.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
git commit -m "feat(tui): route plan approvals to dedicated view"
```

---

### Task 4: Regression Evidence and Real-Terminal Gate

**Files:**
- Modify: `logs/auto-0025-verification.md`

**Interfaces:**
- Consumes: all Task 1–3 commits and the accepted baseline documented in the existing verification log.
- Produces: reproducible automated evidence plus an explicit user-run real-terminal result; no production behavior.

- [ ] **Step 1: Run the focused visual-redesign suite**

Run:

```bash
npx vitest run src/__tests__/plan-presentation.test.ts src/__tests__/plan-approval.test.ts src/__tests__/ask-user.test.ts src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx src/__tests__/tui/ask-question-store.test.ts
```

Expected: exit 0 with every listed test passing.

- [ ] **Step 2: Run the affected renderer and tool modules**

Run:

```bash
npx vitest run src/__tests__/tui/render-markdown.test.tsx src/__tests__/tui/streaming-markdown.test.tsx src/__tests__/tui/inline-v2/inline-app-v2.test.tsx src/__tests__/tui/inline-v2/footer-v2-memo.test.tsx src/__tests__/tui/inline-v2/overlay-footer-recovery.test.tsx src/__tests__/plan-approval-transition.test.ts src/__tests__/streaming-executor.test.ts
```

Expected: exit 0 with every listed test passing.

- [ ] **Step 3: Run static checks on the exact changed code**

Run:

```bash
npm run typecheck
npx eslint src/plan/plan-presentation.ts src/agent/ask-user-types.ts src/agent/tools/plan-tools.ts src/tui/inline-v2/ExitPlanModeOverlayV2.tsx src/tui/inline-v2/InlineAppV2.tsx src/__tests__/plan-presentation.test.ts src/__tests__/plan-approval.test.ts src/__tests__/ask-user.test.ts src/__tests__/tui/inline-v2/exit-plan-mode-overlay.test.tsx src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx
git diff --check df69a8c..HEAD
```

Expected: typecheck and `git diff --check` exit 0. Changed-file lint introduces no new diagnostic; if an existing diagnostic is encountered, prove it exists at `df69a8c` and record its exact path, line, rule, and baseline evidence rather than changing unrelated code.

- [ ] **Step 4: Run the full suite and classify only against the accepted baseline**

Run:

```bash
npm test
```

Expected repository baseline: only the previously accepted three `background.test.ts` timeout/status assertions and two `layout.test.tsx` ANSI-sensitive assertions may fail. Any different failure is a regression until a focused rerun proves an environment-only cause.

- [ ] **Step 5: Append reproducible evidence to the verification log**

Append a dated `2026-07-22 Plan approval UI redesign` section to `logs/auto-0025-verification.md` containing:

```markdown
## 2026-07-22 Plan approval UI redesign

- Focused command and exact files/tests passed.
- Affected-module command and exact files/tests passed.
- `npm run typecheck` exit code.
- Exact changed-file ESLint command and every diagnostic, including baseline attribution where applicable.
- `npm test` exact pass/fail/skip counts and comparison with the five accepted baseline assertions.
- `git diff --check df69a8c..HEAD` exit code.

### Real-terminal gate

- Main-screen rendering; no alternate-screen transition.
- Chinese purple title/top border and muted dashed plan separators.
- Frontmatter hidden; Markdown title, bold text, and list visible.
- No `Plan · Submit`, duplicate `Plan` header, or `[ ]/[x]` chrome.
- Three approval mappings work.
- Other input remains inline and does not approve the plan.
- Chat and Esc do not approve the plan.
- Narrow terminal and long plan do not truncate decision content.
```

Replace the prose bullet descriptions with the actual command output counts. Do not mark the real-terminal gate passed until a user reports those observations from an actual TTY/API session.

- [ ] **Step 6: Commit automated evidence after the real-terminal result is recorded**

```bash
git add logs/auto-0025-verification.md
git commit -m "test(plan): verify approval dialog redesign"
```
