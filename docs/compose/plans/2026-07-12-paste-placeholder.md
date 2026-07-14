# Paste Content Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement pasted content placeholders so long text paste shows `[Pasted text #N +M lines]` in the input box, with original content stored in memory and expanded on submit.

**Architecture:** Add a `paste-handler.ts` module managing a `pastedContents` dictionary, modify `use-input-handler.ts` to detect bracketed paste and insert placeholders, and modify `handleUserSubmit` to expand placeholders before processing.

**Tech Stack:** TypeScript, Zustand (existing), Ink (existing), Vitest (existing)

## Global Constraints

- ID auto-increments per session, resets on restart (no persistence needed)
- Placeholder format: `[Pasted text #N +M lines]` (N=1-based ID, M=line count)
- Truncation threshold: 10000 chars → show `[...Truncated text #N +M lines...]` with 500-char front/back preview
- Image placeholders `[Image #N]` are NOT expanded (out of scope)
- History only stores placeholder text, not original content

---

### Task 1: Create paste-handler module

**Covers:** [S1, S2, S3, S4, S5]

**Files:**
- Create: `src/tui/input/paste-handler.ts`
- Test: `src/__tests__/tui/paste-handler.test.ts`

**Interfaces:**
- Consumes: none (standalone module)
- Produces: `storePastedContent(content: string): string`, `expandPastedTextRefs(text: string): string`, `resetPasteState(): void`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/tui/paste-handler.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { storePastedContent, expandPastedTextRefs, resetPasteState } from '../../tui/input/paste-handler.js';

describe('paste-handler', () => {
  beforeEach(() => {
    resetPasteState();
  });

  it('storePastedContent returns placeholder with line count', () => {
    const content = 'line1\nline2\nline3';
    const placeholder = storePastedContent(content);
    expect(placeholder).toBe('[Pasted text #1 +3 lines]');
  });

  it('multiple pastes get sequential IDs', () => {
    const p1 = storePastedContent('a\nb');
    const p2 = storePastedContent('c');
    expect(p1).toBe('[Pasted text #1 +2 lines]');
    expect(p2).toBe('[Pasted text #2 +1 lines]');
  });

  it('expandPastedTextRefs restores original content', () => {
    const content = 'hello\nworld';
    const placeholder = storePastedContent(content);
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe(content);
  });

  it('expandPastedTextRefs handles multiple placeholders', () => {
    const p1 = storePastedContent('aaa');
    const p2 = storePastedContent('bbb');
    const text = `before ${p1} middle ${p2} after`;
    const expanded = expandPastedTextRefs(text);
    expect(expanded).toBe('before aaa middle bbb after');
  });

  it('expandPastedTextRefs leaves non-paste text unchanged', () => {
    const expanded = expandPastedTextRefs('no placeholders here');
    expect(expanded).toBe('no placeholders here');
  });

  it('long content (>10000 chars) gets truncated in placeholder', () => {
    const longContent = 'x'.repeat(12000);
    const placeholder = storePastedContent(longContent);
    expect(placeholder).toMatch(/^\[\.\.\.Truncated text #1 \+1 lines\.\.\.\]$/);
  });

  it('long content expands with full original', () => {
    const longContent = 'x'.repeat(12000);
    const placeholder = storePastedContent(longContent);
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe(longContent);
    expect(expanded.length).toBe(12000);
  });

  it('resetPasteState clears all stored content', () => {
    storePastedContent('aaa');
    storePastedContent('bbb');
    resetPasteState();
    const p = storePastedContent('ccc');
    expect(p).toBe('[Pasted text #1 +1 lines]');
  });

  it('single line content shows +1 lines', () => {
    const placeholder = storePastedContent('just one line');
    expect(placeholder).toBe('[Pasted text #1 +1 lines]');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/paste-handler.test.ts`
Expected: FAIL with "Cannot find module" or "storePastedContent is not a function"

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/tui/input/paste-handler.ts
// 粘贴内容占位符管理器
//
// 物理本质：剪贴板的「临时仓库」。
// 粘贴时把原文存进内存字典，输入框只显示占位符快捷方式，
// 提交时再把占位符展开回原文。省磁盘、省 token、省眼。

const TRUNCATE_THRESHOLD = 10000;
const PREVIEW_CHARS = 500;

let nextPasteId = 1;
const pastedContents = new Map<number, string>();

/** 存储粘贴内容，返回占位符 */
export function storePastedContent(content: string): string {
  const id = nextPasteId++;
  pastedContents.set(id, content);
  const lineCount = content.split('\n').length;
  if (content.length > TRUNCATE_THRESHOLD) {
    return `[...Truncated text #${id} +${lineCount} lines...]`;
  }
  return `[Pasted text #${id} +${lineCount} lines]`;
}

/** 将文本中的占位符展开为原始内容 */
export function expandPastedTextRefs(text: string): string {
  return text.replace(/\[Pasted text #(\d+) \+(\d+) lines\]/g, (_match, idStr) => {
    const id = Number(idStr);
    const content = pastedContents.get(id);
    return content ?? _match;
  }).replace(/\[\.\.\.Truncated text #(\d+) \+(\d+) lines\.\.\.\]/g, (_match, idStr) => {
    const id = Number(idStr);
    const content = pastedContents.get(id);
    return content ?? _match;
  });
}

/** 重置所有粘贴状态（新 session 或测试用） */
export function resetPasteState(): void {
  nextPasteId = 1;
  pastedContents.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/paste-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/input/paste-handler.ts src/__tests__/tui/paste-handler.test.ts
git commit -m "feat(paste): add paste-handler module with placeholder storage and expansion"
```

---

### Task 2: Integrate paste detection into input handler

**Covers:** [S1, S2]

**Files:**
- Modify: `src/tui/input/use-input-handler.ts:174-183`
- Modify: `src/tui/ConnectedApp.tsx:266-275`
- Test: `src/__tests__/tui/use-input-handler.test.tsx`

**Interfaces:**
- Consumes: `storePastedContent` from `paste-handler.ts`
- Produces: bracketed paste detection in `useInputHandler`, placeholder insertion into input store

- [ ] **Step 1: Write the failing test**

Add to existing `src/__tests__/tui/use-input-handler.test.tsx`:

```typescript
it('bracketed paste → placeholder insertion', () => {
  const store = createInputStore();
  const { stdin } = render(React.createElement(InputProbe, { store }));
  // Simulate bracketed paste: \x1b[200~<content>\x1b[201~
  stdin.write('\x1b[200~hello\nworld\x1b[201');
  // The ~ may arrive separately; Ink processes it
  stdin.write('~');
  expect(store.getState().text).toContain('[Pasted text #');
  expect(store.getState().text).toContain('+2 lines]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/tui/use-input-handler.test.tsx`
Expected: The new test FAILS (bracketed paste not handled yet)

- [ ] **Step 3: Implement bracketed paste detection**

Modify `src/tui/input/use-input-handler.ts`:

1. Import `storePastedContent` at top:
```typescript
import { storePastedContent } from './paste-handler.js';
```

2. Add paste state before the `useInput` callback (inside the function, before `useInput`):
```typescript
let pasteBuffer = '';
let inPaste = false;
```

3. Add paste detection at the START of the `useInput` callback (after `const s = store.getState();`), before any other logic:

```typescript
// ─────────── 括号粘贴检测 ───────────
if (input.includes('\x1b[200~')) {
  inPaste = true;
  const afterStart = input.slice(input.indexOf('\x1b[200~') + 6);
  if (afterStart.includes('\x1b[201~')) {
    // 完整粘贴在单次事件内
    const content = afterStart.slice(0, afterStart.indexOf('\x1b[201~'));
    inPaste = false;
    s.insert(storePastedContent(content));
    return;
  }
  pasteBuffer = afterStart;
  return;
}
if (inPaste) {
  if (input.includes('\x1b[201~')) {
    inPaste = false;
    const content = pasteBuffer + input.slice(0, input.indexOf('\x1b[201~'));
    pasteBuffer = '';
    s.insert(storePastedContent(content));
    return;
  }
  pasteBuffer += input;
  return;
}
```

4. In `ConnectedApp.tsx`, enable bracketed paste mode alongside mouse mode. Add to the `useEffect` that enables mouse mode (line 269):

```typescript
process.stdout.write('\x1b[?1003h\x1b[?1006h\x1b[?2004h');
```

And in the cleanup (line 271):

```typescript
process.stdout.write('\x1b[?1003l\x1b[?1006l\x1b[?2004l');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/tui/use-input-handler.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/tui/input/use-input-handler.ts src/tui/ConnectedApp.tsx
git commit -m "feat(paste): detect bracketed paste and insert placeholder"
```

---

### Task 3: Expand placeholders on submit

**Covers:** [S3, S4]

**Files:**
- Modify: `src/index.ts:310-311`
- Test: `src/__tests__/tui/paste-handler.test.ts` (add submit integration test)

**Interfaces:**
- Consumes: `expandPastedTextRefs` from `paste-handler.ts`
- Produces: expanded text passed to agent loop

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/tui/paste-handler.test.ts`:

```typescript
it('expandPastedTextRefs preserves text around placeholders', () => {
  const p1 = storePastedContent('code snippet');
  const text = `Please review this:\n${p1}\nThanks`;
  const expanded = expandPastedTextRefs(text);
  expect(expanded).toBe('Please review this:\ncode snippet\nThanks');
});

it('expandPastedTextRefs handles empty input', () => {
  expect(expandPastedTextRefs('')).toBe('');
});

it('expandPastedTextRefs handles text with no placeholders', () => {
  expect(expandPastedTextRefs('just plain text')).toBe('just plain text');
});
```

- [ ] **Step 2: Run test to verify it passes (these test existing behavior)**

Run: `npx vitest run src/__tests__/tui/paste-handler.test.ts`
Expected: PASS

- [ ] **Step 3: Integrate into handleUserSubmit**

Modify `src/index.ts:310-311`:

1. Add import at top of file:
```typescript
import { expandPastedTextRefs } from './tui/input/paste-handler.js';
```

2. Modify `handleUserSubmit` to expand before trim:
```typescript
async function handleUserSubmit(rawText: string): Promise<void> {
  const userInput = expandPastedTextRefs(rawText).trim();
```

- [ ] **Step 4: Run full test suite to verify no regressions**

Run: `npx vitest run src/__tests__/tui/paste-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(paste): expand paste placeholders on submit"
```

---

### Task 4: Type check and final verification

**Covers:** [S1, S2, S3, S4, S5]

**Files:**
- No new files (verification only)

**Interfaces:**
- Consumes: all previous tasks
- Produces: passing type check and tests

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all paste-related tests**

Run: `npx vitest run src/__tests__/tui/paste-handler.test.ts src/__tests__/tui/use-input-handler.test.tsx`
Expected: All PASS

- [ ] **Step 3: Run L1 regression on affected modules**

Run: `npx vitest run src/__tests__/tui/input-store.test.ts src/__tests__/tui/continuation-indent.test.ts`
Expected: All PASS (no regressions in input handling)

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(paste): address type check or test issues"
```
