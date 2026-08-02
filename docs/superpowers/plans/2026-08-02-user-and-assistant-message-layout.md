# UserBlock and Completed Assistant Message Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Inline V2 中 UserBlock 多行缩进与整行主题背景，并把 completed Assistant Markdown 的跨 token 段落边界规范为恰好一个空白物理行。

**Architecture:** UserBlock 新增一个只消费 `text` 与局部安全 `width` 的纯布局函数，复用现有 grapheme 安全的 `wrapLineWithSpans`，再由 `TranscriptBlockLine` 用定宽 Ink Box 承载 `bgMuted`。Completed Assistant 新增仅供 `AssistantBlockLine` 使用的 token 行化模块，先把 raw/table token 变为 Assistant 专用可检查行，再归一化跨 token 外部空白；streaming、interrupted 与 fallback 保持原路径。

**Tech Stack:** TypeScript 6、React 19、Ink 7、Vitest 3、marked 18、`@alcalzone/ansi-tokenize`、`string-width`

## Global Constraints

- 唯一设计依据：`docs/superpowers/specs/2026-08-02-user-and-assistant-message-layout-design.md`。
- 只修改 Inline V2 的已固化 UserBlock 与正常 completed Assistant Markdown。
- 不修改 submit-transformer、history、transcript store、消息类型、reducer、streaming、tool 或 system 渲染。
- 不引入通用 `PhysicalRow[]` 或跨消息类型的行模型；Assistant 行类型只能由 Assistant token 布局与 `AssistantBlockLine` 消费。
- UserBlock 的 Tab 只在渲染副本中展开为 4 个空格，原始消息绝对不变。
- UserBlock 背景必须由 `Box width + backgroundColor` 产生；纯布局函数不得追加视觉填充空格。
- 只有 `prefix + 正文首 grapheme` 能在首行合法容纳时才显示 `❯ `；正文优先。
- 仅当单个不可拆分 grapheme 自身显示宽度大于 `width` 时允许最小必要溢出；其余行不得超过 `width`。
- Completed Assistant 必须先生成局部可检查 token 行，再把两个可渲染 token 之间的最终边界归一为一个空白物理行。
- fenced code、list、blockquote、table 的 token 内部空白不得压缩。
- 保留 `InlineAppV2.tsx` 现有 `marginBottom={1}`，不把消息间距并入 Assistant 内部段落规则。
- 不新增依赖；复用 `wrapLineWithSpans`、`string-width`、`useTheme`、`marked.lexer` 与 `layoutMarkdownTable`。
- 工作区已有 `src/prompts/planner.generated.ts` 未提交修改；每次 `git add` 必须列出精确文件，禁止暂存该文件。

---

## File Structure

- Create: `src/tui/inline-v2/user-block-layout.ts` — UserBlock 专用纯布局、prefix 决策、Tab 展开与局部宽度折行。
- Create: `src/__tests__/tui/inline-v2/user-block-layout.test.ts` — UserBlock 纯函数的 Tab、空行、Unicode、窄宽与确定性测试。
- Modify: `src/tui/inline-v2/TranscriptBlockLine.tsx:18-50` — 只替换 `case 'user'` 的渲染叶子，接入局部宽度、`useTheme()` 与整行背景。
- Modify: `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx:1-76` — UserBlock Ink frame、主题背景和 marker 前景色回归。
- Create: `src/tui/inline-v2/assistant-token-layout.ts` — Completed Assistant 专用 raw/table token 行化与跨 token 边界归一化。
- Create: `src/__tests__/tui/inline-v2/assistant-token-layout.test.ts` — token 边界、内部空白、table 与连续 space 的纯布局测试。
- Modify: `src/tui/inline-v2/AssistantBlockLine.tsx:1-87` — 把正常 completed 分支接到 Assistant token 行结果；保留 interrupted 与 raw fallback。
- Modify: `src/__tests__/tui/inline-v2/assistant-block-line.test.tsx:1-100` — completed Assistant 的真实 Ink frame 与 Markdown 结构回归。
- Verify only: `src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx` — interrupted、lexer throw 与无内容宽度 fallback。
- Verify only: `src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx` — 单个 table 布局失败时只回退该 table。
- Verify only: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx:188-205,1171-1233` — 外层消息间距、streaming→completed 生命周期与原始 transcript 不变。
- Verify only: `src/__tests__/tui/inline-v2/streaming-text.test.tsx` — streaming 路径不受影响。
- Reuse unchanged: `src/tui/state/wrap-line.ts:251-269`、`src/tui/state/theme-context.ts:26-28`、`src/utils/theme.ts:74-187`、`src/tui/markdown/table-layout.ts`。

---

### Task 1: UserBlock 纯布局函数

**Files:**
- Create: `src/tui/inline-v2/user-block-layout.ts`
- Create: `src/__tests__/tui/inline-v2/user-block-layout.test.ts`

**Interfaces:**
- Consumes: `wrapLineWithSpans(line, firstLineWidth, continuationWidth)`、`stringWidth(text)`、`tokenize(text)` 与 `styledCharsFromTokens(tokens)`。
- Produces: `USER_PROMPT: '❯ '`、`shouldShowUserPrompt(text: string, width: number): boolean`、`layoutUserBlockRows(text: string, width: number): string[]`。
- Invariant: 返回数组至少一行；只有第 0 行可能包含合成的 `USER_PROMPT`；返回值不含为背景添加的尾随空格，但允许返回完全来自原文缩进的空格行。

- [ ] **Step 1: 探查共享折行器的前导空格行为**

Run this read-only probe before writing the UserBlock helper:

```bash
node --import tsx --input-type=module -e "import { wrapLineWithSpans } from './src/tui/state/wrap-line.ts'; const input='    sudo whoami'; for (const width of [4,8,11]) { const rows=wrapLineWithSpans(input,width,width).map((span)=>span.text); console.log(JSON.stringify({width,rows})); }"
```

Expected current output:

```text
{"width":4,"rows":["","sudo","whoa","mi"]}
{"width":8,"rows":["","sudo who","ami"]}
{"width":11,"rows":["    sudo","whoami"]}
```

This proves that the shared word-boundary policy drops the four leading spaces at widths 4 and 8. The fix must stay local to `user-block-layout.ts`; do not modify `src/tui/state/wrap-line.ts` or change its shared word-wrap policy.

- [ ] **Step 2: 写一组完整失败测试，锁定 Tab、缩进、空行、prefix 与 Unicode**

Create `src/__tests__/tui/inline-v2/user-block-layout.test.ts` with the complete Task 1 test set before writing production code:

```ts
import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  layoutUserBlockRows,
  shouldShowUserPrompt,
} from '../../../tui/inline-v2/user-block-layout.js';

describe('layoutUserBlockRows', () => {
  it('expands tabs only in the render result and preserves logical blank lines', () => {
    const input = '请执行：\n\n\tsudo whoami\n\n\t返回执行结果。';
    const before = input;

    expect(layoutUserBlockRows(input, 40)).toEqual([
      '❯ 请执行：',
      '',
      '    sudo whoami',
      '',
      '    返回执行结果。',
    ]);
    expect(input).toBe(before);
  });

  it('does not append background padding spaces', () => {
    const rows = layoutUserBlockRows('short', 20);
    expect(rows).toEqual(['❯ short']);
    expect(rows[0]!.endsWith(' ')).toBe(false);
  });

  it('is deterministic for the same text and local width', () => {
    const input = 'a\n\t中🤖';
    expect(layoutUserBlockRows(input, 6)).toEqual(layoutUserBlockRows(input, 6));
  });

  it.each<[number, string[]]>([
    [4, ['❯ ', '    ', 'sudo', 'whoa', 'mi']],
    [8, ['❯ ', '    sudo', 'whoami']],
    [11, ['❯ ', '    sudo', 'whoami']],
  ])('preserves four source-derived leading spaces at width %i', (width, expected) => {
    expect(layoutUserBlockRows('\n\tsudo whoami', width)).toEqual(expected);
  });

  it('shows the prompt at width 3 for ASCII but omits it for CJK', () => {
    expect(shouldShowUserPrompt('a', 3)).toBe(true);
    expect(layoutUserBlockRows('a', 3)).toEqual(['❯ a']);

    expect(shouldShowUserPrompt('中', 3)).toBe(false);
    expect(layoutUserBlockRows('中', 3)).toEqual(['中']);
  });

  it('uses the full local width after the first physical row', () => {
    expect(layoutUserBlockRows('abcd', 3)).toEqual(['❯ a', 'bcd']);
  });

  it('keeps CJK, emoji ZWJ sequences and combining graphemes intact', () => {
    expect(layoutUserBlockRows('中文', 2)).toEqual(['中', '文']);
    expect(layoutUserBlockRows('👨‍👩‍👧‍👦x', 1)).toEqual(['👨‍👩‍👧‍👦', 'x']);
    expect(layoutUserBlockRows('e\u0301x', 1)).toEqual(['e\u0301', 'x']);
  });

  it('allows overflow only for one indivisible grapheme wider than width', () => {
    const rows = layoutUserBlockRows('中a', 1);
    expect(rows).toEqual(['中', 'a']);
    expect(stringWidth(rows[0]!)).toBe(2);
    expect(stringWidth(rows[1]!)).toBeLessThanOrEqual(1);
  });

  it('clamps non-finite and non-positive widths without dropping text', () => {
    expect(layoutUserBlockRows('ab', 0).join('')).toBe('ab');
    expect(layoutUserBlockRows('ab', Number.NaN).join('')).toBe('ab');
  });
});
```

- [ ] **Step 3: 运行完整测试集，确认一次 RED**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/user-block-layout.test.ts
```

Expected: FAIL solely because `src/tui/inline-v2/user-block-layout.ts` does not exist, after Vitest successfully parses the complete file containing every Tab, leading-space, blank-line, prefix, grapheme and invalid-width case. Do not create a test stub that returns constants.

- [ ] **Step 4: 写最小生产实现**

Create `src/tui/inline-v2/user-block-layout.ts` with this implementation shape:

```ts
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { wrapLineWithSpans } from '../state/wrap-line.js';

export const USER_PROMPT = '❯ ';
const USER_PROMPT_WIDTH = stringWidth(USER_PROMPT);
const TAB_RENDERING = '    ';

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
}

function renderCopy(text: string): string {
  return text.replaceAll('\t', TAB_RENDERING);
}

function firstGrapheme(text: string): string | undefined {
  return styledCharsFromTokens(tokenize(text))[0]?.value;
}

function shouldShowPromptForFirstLine(firstLine: string, width: number): boolean {
  const grapheme = firstGrapheme(firstLine);
  return grapheme === undefined
    ? USER_PROMPT_WIDTH <= width
    : USER_PROMPT_WIDTH + stringWidth(grapheme) <= width;
}

function wrapUserLinePreservingLeadingSpaces(
  line: string,
  firstWidthRaw: number,
  continuationWidthRaw: number,
): string[] {
  const firstWidth = Math.max(1, firstWidthRaw);
  const continuationWidth = Math.max(1, continuationWidthRaw);
  const leadingSpaces = line.match(/^ */u)?.[0] ?? '';
  if (leadingSpaces === '') {
    return wrapLineWithSpans(line, firstWidth, continuationWidth).map((span) => span.text);
  }

  const body = line.slice(leadingSpaces.length);
  const rows: string[] = [];
  let remainingSpaces = leadingSpaces;
  let currentWidth = firstWidth;

  while (
    remainingSpaces.length >= currentWidth
    && (remainingSpaces.length > currentWidth || body !== '')
  ) {
    rows.push(remainingSpaces.slice(0, currentWidth));
    remainingSpaces = remainingSpaces.slice(currentWidth);
    currentWidth = continuationWidth;
  }

  if (body === '') {
    if (remainingSpaces !== '' || rows.length === 0) rows.push(remainingSpaces);
    return rows;
  }

  const wrappedBody = wrapLineWithSpans(
    body,
    currentWidth - remainingSpaces.length,
    continuationWidth,
  ).map((span) => span.text);
  rows.push(remainingSpaces + wrappedBody[0]!);
  rows.push(...wrappedBody.slice(1));
  return rows;
}

export function shouldShowUserPrompt(text: string, width: number): boolean {
  const normalized = renderCopy(text);
  const firstLine = normalized.split('\n', 1)[0] ?? '';
  return shouldShowPromptForFirstLine(firstLine, safeWidth(width));
}

export function layoutUserBlockRows(text: string, width: number): string[] {
  const normalized = renderCopy(text);
  const localWidth = safeWidth(width);
  const logicalLines = normalized.split('\n');
  const showPrompt = shouldShowPromptForFirstLine(logicalLines[0] ?? '', localWidth);
  const rows: string[] = [];

  for (let lineIndex = 0; lineIndex < logicalLines.length; lineIndex += 1) {
    const line = logicalLines[lineIndex]!;
    const isFirstLogicalLine = lineIndex === 0;
    const firstWidth = isFirstLogicalLine && showPrompt
      ? localWidth - USER_PROMPT_WIDTH
      : localWidth;
    const wrappedRows = wrapUserLinePreservingLeadingSpaces(line, firstWidth, localWidth);

    wrappedRows.forEach((wrappedRow, rowIndex) => {
      const prefix = isFirstLogicalLine && rowIndex === 0 && showPrompt
        ? USER_PROMPT
        : '';
      rows.push(prefix + wrappedRow);
    });
  }

  return rows;
}
```

`wrapUserLinePreservingLeadingSpaces` is intentionally private and UserBlock-specific. Rows containing only spaces represent source-derived indentation, not background padding. Do not modify `src/tui/state/wrap-line.ts`; its existing tokenizer still supplies grapheme-safe wrapping for the non-indent body.

- [ ] **Step 5: 运行当前测试，确认 GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/user-block-layout.test.ts
```

Expected: PASS with all UserBlock layout cases green. Widths 4, 8 and 11 must retain exactly four source-derived leading spaces even though the Step 1 shared-wrapper probe loses them at narrower widths. Do not weaken the grapheme, prefix, Tab, leading-space or no-background-padding contracts.

- [ ] **Step 6: 提交 Task 1**

```bash
git add src/tui/inline-v2/user-block-layout.ts src/__tests__/tui/inline-v2/user-block-layout.test.ts
git commit -m "feat(tui): add user block row layout"
```

Expected: one commit containing only the new pure layout module and its tests.

---

### Task 2: UserBlock Ink 整行 `bgMuted` 渲染

**Files:**
- Modify: `src/tui/inline-v2/TranscriptBlockLine.tsx:18-50`
- Modify: `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx:1-76`

**Interfaces:**
- Consumes: `layoutUserBlockRows(text, width)`, `shouldShowUserPrompt(text, width)`, `USER_PROMPT`, `getUsableWidth(cols)` and `useTheme()`.
- Produces: UserBlock 每个物理行一个 `Box width={width} height={1} backgroundColor={theme.bgMuted}`；其他 `TranscriptBlock` 分支无变化。
- Width rule: 当前结构下 `width = getUsableWidth(cols)`；`layoutUserBlockRows` 只看到该局部宽度，不读取 terminal columns。

- [ ] **Step 1: 写失败的 UserBlock Ink frame 测试**

Update imports in `src/__tests__/tui/inline-v2/transcript-block-line.test.tsx`:

```ts
import { styledCharsFromTokens, tokenize } from '@alcalzone/ansi-tokenize';
import stringWidth from 'string-width';
import { ThemeProvider } from '../../../tui/state/theme-context.js';
import { darkTheme, lightTheme, type Theme } from '../../../utils/theme.js';
```

Add this helper above the `describe` block:

```tsx
function renderUser(text: string, cols: number, theme: Theme = darkTheme): string {
  const block: UserBlock = { id: 'user-layout', kind: 'user', text };
  return render(
    <ThemeProvider value={theme}>
      <TranscriptBlockLine block={block} cols={cols} />
    </ThemeProvider>,
  ).lastFrame() ?? '';
}

const BG_MUTED_CASES: ReadonlyArray<readonly [string, Theme, string]> = [
  ['dark-derived', { ...darkTheme, bgMuted: '#ff00ff' }, '\u001b[105m'],
  ['light-derived', { ...lightTheme, bgMuted: '#00ffff' }, '\u001b[106m'],
];

function styleCodesForCharacter(raw: string, value: string): string[] {
  const character = styledCharsFromTokens(tokenize(raw)).find((entry) => entry.value === value);
  expect(character).toBeDefined();
  return character!.styles.map((style) => style.code);
}
```

Add these tests inside the existing `describe('TranscriptBlockLine')`:

```tsx
it.each(BG_MUTED_CASES)(
  'renders every physical row with the exact %s bgMuted sentinel',
  (_name, theme, backgroundAnsi) => {
    const raw = renderUser('请执行：\n\n\tsudo whoami', 12, theme);
    const rawLines = raw.split('\n');
    const visible = stripAnsi(raw).split('\n').map((line) => line.trimEnd());
    const physicalLines = stripAnsi(raw).split('\n');

    expect(visible).toEqual(['❯ 请执行：', '', '    sudo', 'whoami']);
    expect(physicalLines).toHaveLength(4);
    expect(physicalLines.every((line) => stringWidth(line) === 11)).toBe(true);
    expect(rawLines.every((line) => line.includes(backgroundAnsi))).toBe(true);
  },
);

it('keeps green and bold styles on the marker but not the body regardless of ANSI order', () => {
  const [, theme, backgroundAnsi] = BG_MUTED_CASES[0]!;
  const raw = renderUser('plain question', 20, theme);
  const markerCodes = styleCodesForCharacter(raw, '❯');
  const bodyCodes = styleCodesForCharacter(raw, 'p');

  expect(markerCodes).toEqual(expect.arrayContaining([
    '\u001b[32m',
    '\u001b[1m',
    backgroundAnsi,
  ]));
  expect(bodyCodes).toContain(backgroundAnsi);
  expect(bodyCodes).not.toContain('\u001b[32m');
  expect(bodyCodes).not.toContain('\u001b[1m');
  expect(stripAnsi(raw).trimEnd()).toContain('❯ plain question');
});
```

The exact `105m` and `106m` sentinel assertions rely on the repository's `vitest.config.ts` setting `FORCE_COLOR='1'`. They prove that every normal, wrapped and blank physical row consumes the active `theme.bgMuted`, while the width assertion intentionally uses `cols - 1` to match existing `getUsableWidth` terminal safety. Do not replace them with a broad background-color regex or a `dark !== light` assertion.

- [ ] **Step 2: 运行测试，确认 RED 原因正确**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
```

Expected: FAIL because the current single `<Text>` does not create four deterministic physical rows and has no `bgMuted` Box background. Existing tool/ask/assistant/system routing tests should remain green.

- [ ] **Step 3: 接入 UserBlock 专用渲染叶子**

Add imports to `src/tui/inline-v2/TranscriptBlockLine.tsx`:

```ts
import { getUsableWidth } from '../state/wrap-line.js';
import { useTheme } from '../state/theme-context.js';
import {
  layoutUserBlockRows,
  shouldShowUserPrompt,
  USER_PROMPT,
} from './user-block-layout.js';
```

Add this focused component above `TranscriptBlockLine`:

```tsx
function UserBlockLine({ text, width }: { text: string; width: number }): React.ReactElement {
  const theme = useTheme();
  const rows = layoutUserBlockRows(text, width);
  const showPrompt = shouldShowUserPrompt(text, width);

  return (
    <Box width={width} flexDirection="column">
      {rows.map((row, index) => {
        const isPromptRow = index === 0 && showPrompt;
        const body = isPromptRow ? row.slice(USER_PROMPT.length) : row;
        return (
          <Box
            key={`user-row-${index}`}
            width={width}
            height={1}
            backgroundColor={theme.bgMuted}
          >
            <Text>
              {isPromptRow && <Text color="green" bold>❯</Text>}
              {isPromptRow ? ` ${body}` : body}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
```

Replace only the `case 'user'` body:

```tsx
case 'user': {
  const width = getUsableWidth(cols);
  return <UserBlockLine text={block.text} width={width} />;
}
```

Do not change any other switch branch or `TranscriptBlockLineProps`.

- [ ] **Step 4: 运行 UserBlock 组件测试，确认 GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/transcript-block-line.test.tsx src/__tests__/tui/inline-v2/user-block-layout.test.ts
```

Expected: PASS. Every raw frame line must contain its exact `bgMuted` sentinel, the stripped rows must keep the blank line and four-space indentation, and parsed character styles must prove that only the marker receives green and bold.

- [ ] **Step 5: 运行现有消息间距回归，确认没有把内部背景与外部 margin 混合**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/inline-app-v2.test.tsx -t "相邻消息块之间保留一个空行"
```

Expected: PASS with `❯ question\n\n● answer`; no modification to `InlineAppV2.tsx` is needed.

- [ ] **Step 6: 提交 Task 2**

```bash
git add src/tui/inline-v2/TranscriptBlockLine.tsx src/__tests__/tui/inline-v2/transcript-block-line.test.tsx
git commit -m "feat(tui): render full-width user message backgrounds"
```

Expected: one commit containing only UserBlock Ink wiring and frame tests.

---

### Task 3: Completed Assistant token 行化与边界归一化

**Files:**
- Create: `src/tui/inline-v2/assistant-token-layout.ts`
- Create: `src/__tests__/tui/inline-v2/assistant-token-layout.test.ts`

**Interfaces:**
- Consumes: `Token[]` from `marked.lexer`, `layoutMarkdownTable(table, availableWidth)` and `TableLayoutLine`.
- Produces: Assistant-only `AssistantTokenRenderRow` union and `layoutCompletedAssistantTokens(tokens: Token[], availableWidth: number): AssistantTokenRenderRow[]`.
- Isolation: This row union is not added to `src/tui/types.ts`, `src/tui/transcript-types.ts` or any shared model; only `AssistantBlockLine` and its direct tests may import it.

- [ ] **Step 1: 写一组完整失败测试，锁定跨 token 边界与真实 token 内部空行**

Create `src/__tests__/tui/inline-v2/assistant-token-layout.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { lexer, type Token } from 'marked';
import {
  layoutCompletedAssistantTokens,
  type AssistantTokenRenderRow,
} from '../../../tui/inline-v2/assistant-token-layout.js';

function visible(rows: AssistantTokenRenderRow[]): string[] {
  return rows.map((row) => {
    if (row.kind === 'blank') return '';
    if (row.kind === 'raw') return row.text;
    return row.line.spans.map((span) => span.text).join('');
  });
}

describe('layoutCompletedAssistantTokens', () => {
  it('normalizes a paragraph boundary to exactly one blank row', () => {
    expect(visible(layoutCompletedAssistantTokens(lexer('one\n\ntwo'), 40)))
      .toEqual(['one', '', 'two']);
  });

  it('collapses consecutive space tokens and ignores leading/trailing boundaries', () => {
    const tokens = [
      { type: 'space', raw: '\n\n' },
      { type: 'paragraph', raw: 'one', text: 'one', tokens: [] },
      { type: 'space', raw: '\n\n' },
      { type: 'space', raw: '\n\n' },
      { type: 'paragraph', raw: 'two', text: 'two', tokens: [] },
      { type: 'space', raw: '\n\n' },
    ] as unknown as Token[];

    expect(visible(layoutCompletedAssistantTokens(tokens, 40)))
      .toEqual(['one', '', 'two']);
  });

  it('counts renderer leading/trailing blanks without stacking another row', () => {
    const tokens = [
      { type: 'paragraph', raw: 'one\n', text: 'one', tokens: [] },
      { type: 'space', raw: '\n\n' },
      { type: 'paragraph', raw: '\ntwo', text: 'two', tokens: [] },
    ] as unknown as Token[];

    expect(visible(layoutCompletedAssistantTokens(tokens, 40)))
      .toEqual(['one', '', 'two']);
  });

  it.each<[string, string, string, string[]]>([
    [
      'fenced code',
      'code',
      'before\n\n~~~\nline one\n\nline three\n~~~\n\nafter',
      ['before', '', '~~~', 'line one', '', 'line three', '~~~', '', 'after'],
    ],
    [
      'loose list',
      'list',
      'before\n\n- one\n\n- two\n\nafter',
      ['before', '', '- one', '', '- two', '', 'after'],
    ],
    [
      'blockquote',
      'blockquote',
      'before\n\n> first\n>\n> third\n\nafter',
      ['before', '', '> first', '>', '> third', '', 'after'],
    ],
  ])('preserves the real internal blank row of one %s token', (
    _name,
    structuralType,
    markdown,
    expected,
  ) => {
    const tokens = lexer(markdown);
    expect(tokens.filter((token) => token.type !== 'space').map((token) => token.type))
      .toEqual(['paragraph', structuralType, 'paragraph']);
    expect(visible(layoutCompletedAssistantTokens(tokens, 40))).toEqual(expected);
  });

  it('keeps table layout rows and one blank boundary on each side', () => {
    const rows = layoutCompletedAssistantTokens(lexer(
      'before\n\n| A |\n| --- |\n| x |\n\nafter',
    ), 20);
    const lines = visible(rows);
    const top = lines.findIndex((line) => line.startsWith('┌'));
    const bottom = lines.findIndex((line) => line.startsWith('└'));

    expect(top).toBeGreaterThan(1);
    expect(lines[top - 1]).toBe('');
    expect(lines[bottom + 1]).toBe('');
    expect(lines[bottom + 2]).toBe('after');
  });
});
```

The `lexer(markdown)` assertion is part of the contract: the fenced code, loose list and blockquote fixtures must each contain exactly one structural token between the outer paragraphs, so their middle blank row is genuinely token-internal rather than an inter-token `space` boundary.

- [ ] **Step 2: 运行测试，确认 RED 原因正确**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-token-layout.test.ts
```

Expected: FAIL solely because `assistant-token-layout.ts` does not exist, after Vitest successfully parses the complete file containing the boundary, consecutive-space, renderer-edge, fenced-code, loose-list, blockquote and table cases.

- [ ] **Step 3: 写 Assistant 专用局部行实现**

Create `src/tui/inline-v2/assistant-token-layout.ts`:

```ts
import type { Token, Tokens } from 'marked';
import {
  layoutMarkdownTable,
  type TableLayoutLine,
} from '../markdown/table-layout.js';

export type AssistantTokenRenderRow =
  | { kind: 'raw'; text: string }
  | { kind: 'table'; line: TableLayoutLine }
  | { kind: 'blank' };

function rawRows(raw: string): AssistantTokenRenderRow[] {
  return raw.split('\n').map((text): AssistantTokenRenderRow => (
    text === '' ? { kind: 'blank' } : { kind: 'raw', text }
  ));
}

function renderToken(token: Token, availableWidth: number): AssistantTokenRenderRow[] {
  if (token.type !== 'table') return rawRows(token.raw);

  try {
    return layoutMarkdownTable(token as Tokens.Table, availableWidth).lines.map(
      (line): AssistantTokenRenderRow => ({ kind: 'table', line }),
    );
  } catch {
    return rawRows(token.raw);
  }
}

function isBoundaryBlank(row: AssistantTokenRenderRow): boolean {
  return row.kind === 'blank';
}

export function layoutCompletedAssistantTokens(
  tokens: Token[],
  availableWidth: number,
): AssistantTokenRenderRow[] {
  const output: AssistantTokenRenderRow[] = [];
  let pendingBoundary = false;

  for (const token of tokens) {
    if (token.type === 'space') {
      pendingBoundary = true;
      continue;
    }

    const rendered = renderToken(token, availableWidth);
    let start = 0;
    let end = rendered.length;
    while (start < end && isBoundaryBlank(rendered[start]!)) start += 1;
    while (end > start && isBoundaryBlank(rendered[end - 1]!)) end -= 1;

    const hasLeadingBoundary = start > 0;
    const hasTrailingBoundary = end < rendered.length;
    const content = rendered.slice(start, end);
    if (content.length === 0) {
      pendingBoundary = pendingBoundary || hasLeadingBoundary || hasTrailingBoundary;
      continue;
    }

    if (output.length > 0 && (pendingBoundary || hasLeadingBoundary)) {
      output.push({ kind: 'blank' });
    }
    output.push(...content);
    pendingBoundary = hasTrailingBoundary;
  }

  return output;
}
```

This implementation treats only explicit empty raw rows as external boundary candidates. A table row with `spans.length === 0` remains `kind: 'table'`, preserving the existing key-value table record separator.

- [ ] **Step 4: 运行 token 布局测试，确认 GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-token-layout.test.ts
```

Expected: PASS for paragraph, consecutive space, renderer-edge blank, fenced-code internal blank, loose-list internal blank, blockquote internal blank and table cases.

- [ ] **Step 5: 提交 Task 3**

```bash
git add src/tui/inline-v2/assistant-token-layout.ts src/__tests__/tui/inline-v2/assistant-token-layout.test.ts
git commit -m "feat(tui): normalize completed assistant token boundaries"
```

Expected: one commit containing only the Assistant token layout module and its pure tests. `AssistantBlockLine` is intentionally not wired yet, so Task 4 can observe a real component-level RED.

---

### Task 4: 接入 Completed Assistant 并完成集成与静态验收

**Files:**
- Modify: `src/tui/inline-v2/AssistantBlockLine.tsx:1-87`
- Modify: `src/__tests__/tui/inline-v2/assistant-block-line.test.tsx:1-100`
- Verify only: `src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx`
- Verify only: `src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx`
- Verify only: `src/__tests__/tui/inline-v2/inline-app-v2.test.tsx`
- Verify only: `src/__tests__/tui/inline-v2/streaming-text.test.tsx`

**Interfaces:**
- Consumes: `layoutCompletedAssistantTokens(tokens, cols - 2)` and `AssistantTokenRenderRow` from Task 3.
- Produces: normal completed Assistant rows rendered under the existing single `● ` shell; interrupted, lexer failure and width-unavailable paths still call the current raw branch.
- Fallback: `lexer` throw or unexpected token-layout throw returns `rawContent(block.text, cols)`; table-local exceptions remain contained by Task 3's table fallback.

- [ ] **Step 1: 写失败的 completed Assistant Ink frame 回归**

Add these helpers below the existing `frame` helper in `src/__tests__/tui/inline-v2/assistant-block-line.test.tsx`:

```ts
function trimmedLines(text: string, cols = 80): string[] {
  return frame(text, cols).split('\n').map((line) => line.trimEnd());
}

function blankIndexes(lines: string[]): number[] {
  return lines.flatMap((line, index) => line === '' ? [index] : []);
}
```

Add these tests inside `describe('AssistantBlockLine')`:

```tsx
it('renders exactly one physical blank row at every completed paragraph boundary', () => {
  const lines = trimmedLines(
    '子代理已尝试执行，但结果如下：\n\n```\nDangerous command blocked by built-in policy\n```\n\n'
    + '**sudo 命令被系统内置安全策略拦截了。**\n\n如果确实需要，要我执行吗？',
  );

  expect(blankIndexes(lines)).toEqual([1, 5, 7]);
  expect(lines[0]).toBe('● 子代理已尝试执行，但结果如下：');
  expect(lines[2]).toContain('```');
  expect(lines[3]).toContain('Dangerous command blocked by built-in policy');
  expect(lines[8]).toContain('如果确实需要');
});

it.each([
  ['list', 'before\n\n- one\n- two\n\nafter', ['● before', '', '  - one', '  - two', '', '  after']],
  ['blockquote', 'before\n\n> quote\n> next\n\nafter', ['● before', '', '  > quote', '  > next', '', '  after']],
])('preserves completed %s token rows while normalizing outer boundaries', (_name, markdown, expected) => {
  expect(trimmedLines(markdown)).toEqual(expected);
});

it('keeps one blank row around a rendered table', () => {
  const lines = trimmedLines('before\n\n| A |\n| --- |\n| x |\n\nafter', 30);
  const top = lines.findIndex((line) => line.includes('┌'));
  const bottom = lines.findIndex((line) => line.includes('└'));

  expect(lines[top - 1]).toBe('');
  expect(lines[bottom + 1]).toBe('');
  expect(lines[bottom + 2]).toContain('after');
});
```

- [ ] **Step 2: 运行组件测试，确认 RED 原因正确**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-block-line.test.tsx
```

Expected: FAIL because the current component renders `space` token raw text directly and produces extra blank physical rows. Existing table-only tests may still pass.

- [ ] **Step 3: 把 AssistantTokenRenderRow 接入现有 shell**

In `src/tui/inline-v2/AssistantBlockLine.tsx`:

1. Change the marked import to `import { lexer, type Token } from 'marked';`.
2. Remove the direct `layoutMarkdownTable` import, keeping `TableLayoutLine` and `TableSpan` as type imports from `table-layout.js`.
3. Add:

```ts
import {
  layoutCompletedAssistantTokens,
  type AssistantTokenRenderRow,
} from './assistant-token-layout.js';
```

Add this renderer below `TableLine`:

```tsx
function AssistantRow({ row }: { row: AssistantTokenRenderRow }): React.ReactElement {
  switch (row.kind) {
    case 'raw':
      return <Text>{row.text}</Text>;
    case 'table':
      return <TableLine line={row.line} />;
    case 'blank':
      return <Text>{' '}</Text>;
  }
}
```

Replace the current `tokens.flatMap` block with:

```tsx
let rows: AssistantTokenRenderRow[];
try {
  rows = layoutCompletedAssistantTokens(tokens, cols - 2);
} catch {
  return rawContent(block.text, cols);
}

const content = rows.map((row, index) => (
  <AssistantRow key={`assistant-row-${index}`} row={row} />
));

return assistantShell(content, cols);
```

Do not change these earlier guards:

```ts
if (cols - 2 < 1) return <Text>{block.text}</Text>;
if (block.interrupted) return rawContent(block.text, cols);
```

- [ ] **Step 4: 运行 completed Assistant 目标测试，确认 GREEN**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-token-layout.test.ts src/__tests__/tui/inline-v2/assistant-block-line.test.tsx
```

Expected: PASS with exactly one blank physical row at each completed paragraph boundary, table layout preserved, and one `●` marker per Assistant block.

- [ ] **Step 5: 运行 fallback 与不受影响路径**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/assistant-block-line-interrupted.test.tsx src/__tests__/tui/inline-v2/assistant-block-line-table-fallback.test.tsx src/__tests__/tui/inline-v2/streaming-text.test.tsx
```

Expected: PASS. Interrupted must not call `marked.lexer`; lexer throw must render the whole raw block; one broken table must not prevent a later table from rendering; streaming output must remain on `StreamingText`.

- [ ] **Step 6: 运行 Inline V2 影响模块集成验收**

Run:

```bash
npx vitest run src/__tests__/tui/inline-v2/
```

Expected: PASS for the full Inline V2 suite, including existing `marginBottom={1}`, streaming→completed table lifecycle, raw transcript preservation and resize tests. Do not modify a pre-existing valid test merely to make this command green.

- [ ] **Step 7: 运行 TypeScript 与 lint 静态验收**

Run:

```bash
npm run typecheck
npm run lint
```

Expected: both commands exit 0 with no unused imports, unreachable switch branch, or floating promise. If lint reports only the pre-existing dirty `src/prompts/planner.generated.ts`, record that exact unrelated failure and do not edit or stage that file; all files named in this plan must still be lint-clean.

- [ ] **Step 8: 提交 Task 4**

```bash
git add src/tui/inline-v2/AssistantBlockLine.tsx src/__tests__/tui/inline-v2/assistant-block-line.test.tsx
git commit -m "fix(tui): normalize completed assistant message spacing"
```

Expected: one commit containing only completed Assistant component wiring and its frame regression tests. The Task 3 helper remains in its prior commit; no streaming, tool, system, submit, history or transcript file is staged.

---

## Completion Evidence

Before reporting implementation complete, preserve the terminal results for:

```bash
npx vitest run src/__tests__/tui/inline-v2/
npm run typecheck
npm run lint
git status --short
```

The final `git status --short` may still show the user's pre-existing `src/prompts/planner.generated.ts` modification; it must not show uncommitted changes in any file owned by this plan.
