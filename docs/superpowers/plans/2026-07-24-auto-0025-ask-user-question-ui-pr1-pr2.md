# AUTO-0025 AskUserQuestion UI 优化 — PR1(Phase 1a)+ PR2(Phase B)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决 AskUserQuestion 两大体验痛点 —— 交互期 overlay 视觉品质差(PR1),回答固化后 tool_result 被当 Bash 输出折叠(PR2)。

**Architecture:** PR1 是纯渲染层改造(`AskQuestionOverlayV2` 重写,对齐 `ExitPlanModeOverlayV2` 容器模式)。PR2 是跨链路数据透传(ToolExecutor ctx → registry → streaming-query → block-pipeline,UI/API 双通道隔离)。两者完全解耦,可并行开发,建议先合并 PR1。

**Tech Stack:** TypeScript ES2022、Node.js >= 18、React/Ink、Zustand、Vitest。

**设计文档:** `docs/superpowers/specs/2026-07-22-auto-0025-ask-user-ui-ux-redesign-design.md` 第 15 节(增量补丁)。

## Global Constraints

- 默认 TDD,严格执行 RED → GREEN → REFACTOR。
- PR1 只改渲染层,不碰 store、input handler、数据链路。
- PR2 不碰 overlay UI;`ToolExecutor` 返回类型保持 `Promise<string>`。
- API 通道(`ToolResultBlock.content`)零污染;`structuredOutcome` 只走 UI 通道。
- 禁止裸 `catch {}`;禁止字符串反解析自然语言;禁止 marker 协议。
- 用户级验收以真实 TTY 为最终标准。

## 关键参考文件

| 用途 | 文件 |
|------|------|
| PR1 重写目标 | `src/tui/inline-v2/AskQuestionOverlayV2.tsx`(当前 116 行) |
| PR1 容器模式模板 | `src/tui/inline-v2/ExitPlanModeOverlayV2.tsx`(参考实现) |
| 文本布局纯函数 | `src/tui/inline/text-layout.ts`(`displayWidth`/`foldLine`) |
| 主题色槽 | `src/utils/theme.ts`(`suggestion`/`planMode`/`textMuted`/`borderMuted`) |
| overlay 状态机 | `src/tui/state/ask-question-store.ts`(**不改**) |
| 键盘路由 | `src/tui/input/use-input-handler.ts`(**不改**) |
| 分发点 | `src/tui/inline-v2/InlineAppV2.tsx:323-328`(**不改**) |
| PR2 类型定义 | `src/agent/types.ts:69`(`ToolExecutor`) |
| PR2 registry | `src/agent/tool-registry.ts:41-52`(`execute`) |
| PR2 数据流 | `src/agent/streaming-query.ts`(generator + 阶段3) |
| PR2 渲染模板 | `src/ui/subagent-presentation.ts` + `src/ui/block-pipeline.ts:277-300` |

---
---

# PR1:Phase 1a — 交互期 overlay 视觉重构

**范围:** 仅 `AskQuestionOverlayV2.tsx` 渲染层 + 新增 `computeTabLayout` 纯函数。
**不碰:** store、input handler、数据链路、ExitPlanMode。
**验收:** 24/40/80 列下 overlay 带圆角边框、radio/checkbox 区分、suggestion 色层级、tabs 不超宽。

## File Structure(PR1)

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/tui/inline-v2/ask-question-layout.ts` | `computeTabLayout` 纯函数(tabs 宽度分配) | 新建 |
| `src/tui/inline-v2/AskQuestionOverlayV2.tsx` | 通用问卷渲染(圆角边框+suggestion 色+radio/checkbox) | 重写 |
| `src/__tests__/tui/inline-v2/ask-question-layout.test.ts` | `computeTabLayout` 单测 | 新建 |
| `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx` | overlay 渲染断言(已存在,补充) | 修改 |

---

## Task 1:`computeTabLayout` 纯函数(TDD 锚点)

**Files:**
- Create: `src/tui/inline-v2/ask-question-layout.ts`
- Test: `src/__tests__/tui/inline-v2/ask-question-layout.test.ts`

- [ ] **Step 1:写失败测试 — 宽终端全显示**

```ts
// src/__tests__/tui/inline-v2/ask-question-layout.test.ts
import { describe, it, expect } from 'vitest';
import { computeTabLayout } from '../../../tui/inline-v2/ask-question-layout.js';

describe('computeTabLayout', () => {
  const questions = [
    { header: 'Auth', question: 'q1', options: [], multiSelect: false },
    { header: 'Library', question: 'q2', options: [], multiSelect: false },
  ];

  it('宽终端全部显示 + Submit 可见', () => {
    const tabs = computeTabLayout(questions, { pageIndex: 0, answered: [true, false], cols: 80 });
    expect(tabs.every(t => t.truncated === false)).toBe(true);
    expect(tabs.some(t => t.label.includes('Submit'))).toBe(true);
    // 总显示宽度不超过 cols
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(80);
  });
});
```

- [ ] **Step 2:运行测试确认失败**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-layout.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3:写最小实现**

```ts
// src/tui/inline-v2/ask-question-layout.ts
// AskQuestion 问卷导航栏(tabs)宽度分配纯函数。
// 物理本质:把有限的终端宽度按权重分给各个 question header + Submit,
// 当前页优先(weight=2),其他页次之(weight=1),Submit 固定预留。

import { displayWidth } from '../inline/text-layout.js';
import type { AskQuestion } from '../../agent/ask-user-types.js';

export interface TabSlice {
  /** 显示文本(可能已截断并带 …) */
  label: string;
  /** 是否为当前页 */
  active: boolean;
  /** 显示宽度(列) */
  width: number;
  /** 是否被截断 */
  truncated: boolean;
}

export interface ComputeTabLayoutOptions {
  pageIndex: number;
  /** 每个 question 是否已答(与 questions 等长) */
  answered: boolean[];
  cols: number;
}

const SUBMIT_TEXT = ' ✓ Submit ';
const MIN_TAB_WIDTH = 6;

/**
 * 计算 tabs 布局。Submit 永远可见;当前页 weight=2,其他 weight=1。
 */
export function computeTabLayout(
  questions: AskQuestion[],
  opts: ComputeTabLayoutOptions,
): TabSlice[] {
  const { pageIndex, answered, cols } = opts;
  const submitWidth = displayWidth(SUBMIT_TEXT);

  // 极窄降级:只显示当前页前 3 字符 + Submit
  if (cols <= submitWidth + MIN_TAB_WIDTH) {
    const tabs: TabSlice[] = questions.map((q, i) => {
      const header = q.header || `Q${i + 1}`;
      const sliced = i === pageIndex ? header.slice(0, 3) : '';
      return { label: sliced, active: i === pageIndex, width: displayWidth(sliced), truncated: i === pageIndex && header.length > 3 };
    });
    tabs.push({ label: SUBMIT_TEXT, active: false, width: submitWidth, truncated: false });
    return tabs;
  }

  const available = cols - submitWidth;
  const headers = questions.map(q => q.header || `Q${q ? 1 : 1}`); // placeholder, 下行修正
  // 计算每个 tab 理想宽度:符号(✓/○ 2字符)+ header + 间距(2)
  const ideals = questions.map(q => 2 + displayWidth(q.header || 'Q') + 2);
  const idealTotal = ideals.reduce((s, w) => s + w, 0);

  // 全部装得下
  if (idealTotal <= available) {
    const tabs: TabSlice[] = questions.map((q, i) => ({
      label: `${answered[i] ? '✓' : '○'} ${q.header}`,
      active: i === pageIndex,
      width: ideals[i]!,
      truncated: false,
    }));
    tabs.push({ label: SUBMIT_TEXT, active: false, width: submitWidth, truncated: false });
    return tabs;
  }

  // 需要按权重分配:当前页 weight=2,其他 weight=1
  const weights = questions.map((_, i) => i === pageIndex ? 2 : 1);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const tabs: TabSlice[] = questions.map((q, i) => {
    const budget = Math.max(MIN_TAB_WIDTH, Math.floor((available * weights[i]!) / totalWeight));
    const fullLabel = `${answered[i] ? '✓' : '○'} ${q.header}`;
    const fullWidth = displayWidth(fullLabel);
    if (fullWidth <= budget) {
      return { label: fullLabel, active: i === pageIndex, width: fullWidth, truncated: false };
    }
    // 截断:保留符号 + 部分 header + …
    const prefix = `${answered[i] ? '✓' : '○'} `;
    const prefixWidth = displayWidth(prefix);
    const headerBudget = Math.max(1, budget - prefixWidth - 1); // -1 给 …
    let header = '';
    let hw = 0;
    for (const ch of q.header) {
      const cw = displayWidth(ch);
      if (hw + cw > headerBudget) break;
      header += ch;
      hw += cw;
    }
    const label = `${prefix}${header}…`;
    return { label, active: i === pageIndex, width: displayWidth(label), truncated: true };
  });
  tabs.push({ label: SUBMIT_TEXT, active: false, width: submitWidth, truncated: false });
  return tabs;
}
```

- [ ] **Step 4:运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-layout.test.ts`
Expected: PASS。

- [ ] **Step 5:补充窄终端 + 极窄降级测试**

```ts
  it('窄终端:当前页优先分配,其他截断带 …', () => {
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
      { header: 'Library', question: 'q2', options: [], multiSelect: false },
      { header: 'Runtime', question: 'q3', options: [], multiSelect: false },
      { header: 'Deploy', question: 'q4', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 1, answered: [true, false, false, false], cols: 40 });
    // Submit 必须可见
    expect(tabs.some(t => t.label.includes('Submit'))).toBe(true);
    // 当前页(index 1)不被过度截断(权重更高)
    const currentTab = tabs[1]!;
    expect(currentTab.active).toBe(true);
    // 总宽度不超
    const totalWidth = tabs.reduce((sum, t) => sum + t.width, 0);
    expect(totalWidth).toBeLessThanOrEqual(40);
  });

  it('极窄终端(20列):降级只显示当前页前3字符 + Submit', () => {
    const qs = [
      { header: 'Auth', question: 'q1', options: [], multiSelect: false },
      { header: 'Library', question: 'q2', options: [], multiSelect: false },
    ];
    const tabs = computeTabLayout(qs, { pageIndex: 0, answered: [false, false], cols: 20 });
    // 非当前页不显示文本
    expect(tabs[1]!.label).toBe('');
    // Submit 仍在
    expect(tabs.some(t => t.label.includes('Submit'))).toBe(true);
  });
```

- [ ] **Step 6:运行全部测试确认通过**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-layout.test.ts`
Expected: 3 passed。

- [ ] **Step 7:Commit**

```bash
git add src/tui/inline-v2/ask-question-layout.ts src/__tests__/tui/inline-v2/ask-question-layout.test.ts
git commit -m "feat(tui): add computeTabLayout pure function for ask-question tabs

权重分配(当前页 weight=2,其他 weight=1),Submit 固定预留,
极窄降级只显示当前页前3字符。覆盖宽/窄/极窄终端。"
```

---

## Task 2:AskQuestionOverlayV2 重写 — 容器 + 视觉层级

**Files:**
- Rewrite: `src/tui/inline-v2/AskQuestionOverlayV2.tsx`
- Test: `src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`

- [ ] **Step 1:先读现有 overlay 测试,确认现有断言不破**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`
记录当前通过的测试(这些是回归基线)。

- [ ] **Step 2:写失败测试 — 圆角边框 + suggestion 色容器**

```tsx
// 在 src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx 追加
import { renderWithOverlay } from './test-helpers.js'; // 复用现有 helper

it('overlay 渲染圆角边框 + suggestion 色', () => {
  const { output } = renderWithOverlay({
    questions: [{ header: 'Auth', question: 'How?', options: [{ label: 'OAuth', description: 'd' }], multiSelect: false }],
    pageIndex: 0,
  });
  // 圆角边框字符
  expect(output).toContain('╭');
  expect(output).toContain('╰');
  // suggestion 色应用到 header(通过 ANSI 码或主题色 rgb)
  expect(output).toContain('How?');
});
```

- [ ] **Step 3:运行确认失败**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`
Expected: FAIL — 当前无圆角边框。

- [ ] **Step 4:重写 AskQuestionOverlayV2(对齐 ExitPlanMode 容器模式)**

```tsx
// src/tui/inline-v2/AskQuestionOverlayV2.tsx
// 通用 ask_user_question 问卷渲染(Phase 1a 重构)。
// 对齐 ExitPlanModeOverlayV2 的容器模式:圆角边框 + theme.suggestion。
// 本组件不处理键盘输入(由 useInputHandler 路由到 store)。

import React from 'react';
import { Box, Text } from 'ink';
import { useStore } from 'zustand/react';
import { useShallow } from 'zustand/react/shallow';
import { displayWidth, foldLine } from '../inline/text-layout.js';
import { useTheme } from '../state/theme-context.js';
import { computeTabLayout } from './ask-question-layout.js';
import type { AskQuestionStore } from '../state/ask-question-store.js';

export interface AskQuestionOverlayV2Props {
  store: AskQuestionStore;
  cols: number;
}

function truncateLine(text: string, budget: number): string {
  let result = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = displayWidth(character);
    if (width + characterWidth > budget) break;
    result += character;
    width += characterWidth;
  }
  return result;
}

function isAnswered(
  question: { question: string },
  selected: Record<string, string[]>,
  others: Record<string, string>,
): boolean {
  return (selected[question.question]?.length ?? 0) > 0 || Boolean(others[question.question]?.trim());
}

export const AskQuestionOverlayV2 = React.memo(function AskQuestionOverlayV2({
  store,
  cols,
}: AskQuestionOverlayV2Props): React.ReactElement | null {
  const theme = useTheme();
  const state = useStore(store, useShallow((value) => ({
    visible: value.visible,
    request: value.request,
    pageIndex: value.pageIndex,
    focusIndex: value.focusIndex,
    inputMode: value.inputMode,
    otherDraft: value.otherDraft,
    otherCursor: value.otherCursor,
    selected: value.selected,
    others: value.others,
  })));

  if (!state.visible || !state.request) return null;

  const contentWidth = Math.max(1, cols - 4);  // 减边框(各1)+paddingX(各1)
  const questions = state.request.questions;

  // tabs 用 computeTabLayout
  const answeredFlags = questions.map(q => isAnswered(q, state.selected, state.others));
  const tabs = computeTabLayout(questions, {
    pageIndex: state.pageIndex,
    answered: answeredFlags,
    cols,
  });

  const question = questions[state.pageIndex];

  // Submit 页
  if (!question) {
    const unanswered = questions.some((item, i) => !answeredFlags[i]);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.suggestion} paddingX={1}>
        <Text>{tabs.map(t => t.label).join(' ')}</Text>
        <Text color={theme.suggestion} bold>{truncateLine('Submit', contentWidth)}</Text>
        {unanswered && <Text color={theme.warning}>{truncateLine('请先完成所有问题再提交', contentWidth)}</Text>}
        <Text color={state.focusIndex === 0 ? theme.suggestion : undefined}>{truncateLine(`${state.focusIndex === 0 ? '❯ ' : '  '}提交答案`, contentWidth)}</Text>
        <Text color={state.focusIndex === 1 ? theme.suggestion : undefined}>{truncateLine(`${state.focusIndex === 1 ? '❯ ' : '  '}取消`, contentWidth)}</Text>
        <Text color={theme.textMuted}>{truncateLine('Enter 提交 · Esc 取消', contentWidth)}</Text>
      </Box>
    );
  }

  const selected = state.selected[question.question] ?? [];
  const divider = '┄'.repeat(contentWidth);

  // 选项行
  const optionRows: React.ReactNode[] = [];
  question.options.forEach((option, index) => {
    const isFocused = state.focusIndex === index;
    const focused = isFocused ? '❯ ' : '  ';
    // 单选 radio,多选 checkbox
    const checkSymbol = question.multiSelect
      ? (selected.includes(option.label) ? '[x]' : '[ ]')
      : (selected.includes(option.label) ? '◉' : '◯');
    optionRows.push(
      <Text key={`option-${option.label}`} color={isFocused ? theme.suggestion : undefined}>
        {truncateLine(`${focused}${checkSymbol} ${option.label}`, contentWidth)}
      </Text>
    );
    foldLine(option.description, Math.max(1, contentWidth - 2)).forEach((line, lineIndex) => {
      optionRows.push(
        <Text key={`desc-${option.label}-${lineIndex}`} color={theme.textMuted}>
          {truncateLine(`  ${line}`, contentWidth)}
        </Text>
      );
    });
  });

  // Other 行
  const otherIndex = question.options.length;
  const otherLabel = state.request.otherLabel ?? '其他';
  const otherFocused = state.focusIndex === otherIndex;
  if (state.inputMode) {
    const cursor = Math.min(state.otherCursor, state.otherDraft.length);
    const draft = `${state.otherDraft.slice(0, cursor)}|${state.otherDraft.slice(cursor)}`;
    optionRows.push(
      <Text key="other" color={otherFocused ? theme.suggestion : undefined}>
        {truncateLine(`${otherFocused ? '❯ ' : '  '}${otherLabel}:${draft}`, contentWidth)}
      </Text>
    );
  } else {
    optionRows.push(
      <Text key="other" color={otherFocused ? theme.suggestion : undefined}>
        {truncateLine(`${otherFocused ? '❯ ' : '  '}${otherLabel}`, contentWidth)}
      </Text>
    );
  }

  // Chat 行
  const chatFocused = state.focusIndex === otherIndex + 1;
  optionRows.push(
    <Text key="chat" color={chatFocused ? theme.suggestion : theme.textMuted}>
      {truncateLine(`${chatFocused ? '❯ ' : '  '}与 Agent 讨论此问题`, contentWidth)}
    </Text>
  );

  const help = state.inputMode
    ? 'Enter 保存 · Esc 取消'
    : '↑↓ 导航 · Enter 选择 · Esc 取消';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.suggestion} paddingX={1}>
      <Text>{truncateLine(tabs.map(t => t.label).join(' '), contentWidth)}</Text>
      <Text color={theme.suggestion} bold>{truncateLine(question.header, contentWidth)}</Text>
      {foldLine(question.question, contentWidth).map((line, index) => (
        <Text key={`question-${index}`}>{line}</Text>
      ))}
      <Text color={theme.borderMuted}>{divider}</Text>
      {optionRows}
      <Text color={theme.textMuted}>{truncateLine(help, contentWidth)}</Text>
    </Box>
  );
});
```

- [ ] **Step 5:运行测试确认通过**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx`
Expected: 新测试 PASS + 现有回归测试 PASS。若有现有测试因文案变化(如 `>` → `❯`、英文 → 中文)失败,更新断言以匹配新设计(这是预期的视觉变化)。

- [ ] **Step 6:Commit**

```bash
git add src/tui/inline-v2/AskQuestionOverlayV2.tsx src/__tests__/tui/inline-v2/ask-question-overlay.test.tsx
git commit -m "feat(tui): rewrite AskQuestionOverlayV2 with round border & suggestion theme

对齐 ExitPlanMode 容器模式:
- 圆角边框 + theme.suggestion 色
- 单选 radio ◉/◯,多选 checkbox [x]/[ ]
- 聚焦项 ❯ + suggestion 高亮
- tabs 用 computeTabLayout
- Other 默认'其他',Chat 中文文案"
```

---

## Task 3:类型检查 + Lint + 影响模块测试

- [ ] **Step 1:TypeScript 通过**

Run: `npx tsc --noEmit`
Expected: exit 0,无错误。

- [ ] **Step 2:Lint 通过**

Run: `npx eslint src/tui/inline-v2/AskQuestionOverlayV2.tsx src/tui/inline-v2/ask-question-layout.ts`
Expected: 无错误。

- [ ] **Step 3:overlay 相关全部测试**

Run: `npx vitest run src/__tests__/tui/inline-v2/`
Expected: 全部 PASS。

- [ ] **Step 4:ask-question E2E 测试(回归)**

Run: `npx vitest run src/__tests__/tui/inline-v2/ask-question-e2e.test.tsx`
Expected: PASS。E2E 覆盖 store 交互,若因文案变化失败,更新断言。

- [ ] **Step 5:Commit(如有断言更新)**

```bash
git add -A
git commit -m "test(tui): align ask-question assertions with new overlay visuals"
```

---

## Task 4:真实 TTY 验收(PR1 完成条件)

- [ ] **Step 1:构建并运行,触发 ask_user_question**

手动触发一个 ask_user_question 调用(让 agent 问用户问题),在真实终端验收:
- [ ] 80 列:圆角边框完整,header 为 suggestion 色,tabs 全显示
- [ ] 40 列:tabs 截断正常,当前页优先,Submit 可见
- [ ] 24 列:极窄降级,边框不超宽,不崩溃
- [ ] 单选题显示 ◉/◯,多选题显示 [x]/[ ]
- [ ] 聚焦项 ❯ + suggestion 高亮
- [ ] Other 默认显示"其他",Chat 显示"与 Agent 讨论此问题"
- [ ] Esc 正常取消,Enter 正常选择

- [ ] **Step 2:dark/light 主题切换验收**

确认 suggestion 色在两个主题下都可读。

- [ ] **Step 3:全量测试(提交前)**

Run: `npm test`
Expected: 全部 PASS,无回归。

**PR1 完成标准:TTY 验收全部通过 + 全量测试通过。**

---
---

# PR2:Phase B — 固化结果结构化(meta 旁路)

**范围:** 跨 7 个文件的数据链路改造 + 新增 `ask-outcome-store.ts` + `ask-user-presentation.ts`。
**不碰:** overlay UI(AskQuestionOverlayV2)、store、input handler。
**验收:** tool_result 结构化展示 + API diff 证明 content 不变 + orphan 清理无残留。

## File Structure(PR2)

| 文件 | 职责 | 动作 |
|------|------|------|
| `src/agent/ask-user-types.ts` | 新增 `StructuredAskResult` 类型 | 修改 |
| `src/agent/ask-outcome-store.ts` | outcome store(set/take/sweep/clear + TTL) | 新建 |
| `src/agent/types.ts` | `ToolExecutionContext` + `ToolExecutor` ctx 扩展 | 修改 |
| `src/agent/tool-registry.ts` | `execute` 透传 ctx | 修改 |
| `src/agent/tools/ask-user-tool.ts` | executor 写入 store | 修改 |
| `src/agent/streaming-query.ts` | 阶段3 take + 挂载 structuredOutcome + finally sweep | 修改 |
| `src/agent/streaming-executor.ts` | 调用点补 ctx | 修改 |
| `src/agent/loop.ts` | 2 个调用点补 ctx(legacy) | 修改 |
| `src/agent/stream-event-bus.ts` | `ToolResultEvent` 加 structuredOutcome | 修改 |
| `src/ui/types.ts` | Block tool_result 加 structuredOutcome | 修改 |
| `src/ui/ask-user-presentation.ts` | `buildAskUserPresentation` 纯函数 | 新建 |
| `src/ui/block-pipeline.ts` | ask_user_question 特判分支 | 修改 |
| `src/index.ts` | onToolResult 透传 structuredOutcome | 修改 |

## 数据流全景(实施参照)

```
Anthropic tool_use (tool_use_id)
  → streaming-query 阶段1: addTool
  → streaming-executor.executeTool:132 registry.execute(name,input,{toolUseId})
  → registry.execute:41 tool.executor(input, ctx)
  → ask-user-tool executor: outcome=mgr.ask(input); store.set(toolUseId, {version:1,request,outcome})
  → streaming-query 阶段3: take(toolUseId) → 挂载 structuredOutcome 到 UI 通道
    ├─ API 分叉: ToolResultBlock.content = serialize(outcome)  [不变]
    └─ UI 分叉:  eventBus.emitToolResult({...,structuredOutcome})
  → index.ts:681 pipeline.emit({kind:'tool_result',...,structuredOutcome})
  → block-pipeline:245 buildAskUserPresentation(structuredOutcome) → ⎿ Answered N questions
  → finally: store.sweep()
```

---

## Task 5:`StructuredAskResult` 类型定义

**Files:**
- Modify: `src/agent/ask-user-types.ts`

- [ ] **Step 1:在 ask-user-types.ts 末尾追加类型**

```ts
// 追加到 src/agent/ask-user-types.ts

/**
 * 结构化问卷结果(走 UI 通道,不进 API)。
 * version 用于 renderer 降级:不识别的版本回退 rawOutput。
 */
export interface StructuredAskResult {
  version: 1;
  /** 含 questions(header/options/multiSelect),供展示配对 */
  request: AskQuestionRequest;
  /** submitted/cancelled/chat */
  outcome: AskQuestionOutcome;
}
```

- [ ] **Step 2:类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3:Commit**

```bash
git add src/agent/ask-user-types.ts
git commit -m "feat(agent): add StructuredAskResult type for UI-channel outcome"
```

---

## Task 6:`askOutcomeStore`(TDD)

**Files:**
- Create: `src/agent/ask-outcome-store.ts`
- Test: `src/__tests__/agent/ask-outcome-store.test.ts`

- [ ] **Step 1:写失败测试 — set/take/sweep/clear + 并发隔离 + TTL**

```ts
// src/__tests__/agent/ask-outcome-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { askOutcomeStore } from '../../agent/ask-outcome-store.js';
import type { StructuredAskResult } from '../../agent/ask-user-types.js';

describe('askOutcomeStore', () => {
  beforeEach(() => askOutcomeStore.clear());

  const makeResult = (header: string): StructuredAskResult => ({
    version: 1,
    request: { questions: [{ header, question: 'q', options: [], multiSelect: false }] },
    outcome: { kind: 'submitted', answers: { q: header } },
  });

  it('set + take:一次性消费', () => {
    askOutcomeStore.set('idA', makeResult('A'));
    expect(askOutcomeStore.take('idA')?.outcome.answers.q).toBe('A');
    expect(askOutcomeStore.take('idA')).toBeUndefined(); // 已消费
  });

  it('并发隔离:set(A)/set(B)/take(A)=>A/take(B)=>B', () => {
    askOutcomeStore.set('idA', makeResult('A'));
    askOutcomeStore.set('idB', makeResult('B'));
    expect(askOutcomeStore.take('idA')?.outcome.answers.q).toBe('A');
    expect(askOutcomeStore.take('idB')?.outcome.answers.q).toBe('B');
  });

  it('sweep:删除超 TTL 的 entry', () => {
    vi.useFakeTimers();
    askOutcomeStore.set('old', makeResult('old'));
    vi.advanceTimersByTime(6 * 60 * 1000); // 6min > TTL 5min
    askOutcomeStore.sweep();
    expect(askOutcomeStore.take('old')).toBeUndefined();
    vi.useRealTimers();
  });

  it('sweep:保留未过期的 entry', () => {
    vi.useFakeTimers();
    askOutcomeStore.set('fresh', makeResult('fresh'));
    vi.advanceTimersByTime(2 * 60 * 1000); // 2min < TTL
    askOutcomeStore.sweep();
    expect(askOutcomeStore.take('fresh')?.outcome.answers.q).toBe('fresh');
    vi.useRealTimers();
  });

  it('clear:全清', () => {
    askOutcomeStore.set('x', makeResult('x'));
    askOutcomeStore.clear();
    expect(askOutcomeStore.take('x')).toBeUndefined();
  });
});
```

- [ ] **Step 2:运行确认失败**

Run: `npx vitest run src/__tests__/agent/ask-outcome-store.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3:写实现**

```ts
// src/agent/ask-outcome-store.ts
// ask_user_question 结构化结果的临时存储(meta 旁路)。
// 物理本质:executor 拿到结构化 outcome 后暂存,streaming-query take 后消费。
// 不进 API 通道(ToolResultBlock.content 仍是 serialize 字符串)。
// 生命周期:take 即删 + streamingQuery finally sweep + TTL 5min 兜底。

import type { StructuredAskResult } from './ask-user-types.js';

const TTL_MS = 5 * 60 * 1000;

interface StoredEntry {
  result: StructuredAskResult;
  createdAt: number;
}

const store = new Map<string, StoredEntry>();

export const askOutcomeStore = {
  set(id: string, result: StructuredAskResult): void {
    store.set(id, { result, createdAt: Date.now() });
  },

  /** 取出并删除(一次性消费)。 */
  take(id: string): StructuredAskResult | undefined {
    const entry = store.get(id);
    if (!entry) return undefined;
    store.delete(id);
    return entry.result;
  },

  /** 删除超 TTL 的 entry(streamingQuery finally 调用)。 */
  sweep(): void {
    const now = Date.now();
    for (const [id, entry] of store) {
      if (now - entry.createdAt > TTL_MS) store.delete(id);
    }
  },

  /** 全清(极端兜底)。 */
  clear(): void {
    store.clear();
  },
};
```

- [ ] **Step 4:运行测试确认通过**

Run: `npx vitest run src/__tests__/agent/ask-outcome-store.test.ts`
Expected: 5 passed。

- [ ] **Step 5:Commit**

```bash
git add src/agent/ask-outcome-store.ts src/__tests__/agent/ask-outcome-store.test.ts
git commit -m "feat(agent): add askOutcomeStore with TTL & sweep cleanup"
```

---

## Task 7:ToolExecutor ctx 扩展 + registry 透传

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/tool-registry.ts`
- Test: `src/__tests__/agent/tool-registry-ctx.test.ts`

- [ ] **Step 1:写失败测试 — registry.execute 透传 ctx**

```ts
// src/__tests__/agent/tool-registry-ctx.test.ts
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../agent/tool-registry.js';
import type { ToolDefinition } from '../../agent/types.js';

describe('registry.execute ctx 透传', () => {
  it('executor 收到 ctx.toolUseId', async () => {
    const registry = new ToolRegistry();
    let receivedCtx: { toolUseId: string } | undefined;
    const def: ToolDefinition = {
      name: 'test_tool',
      description: 'test',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    registry.register(def, async (_input, ctx) => {
      receivedCtx = ctx;
      return 'ok';
    });
    await registry.execute('test_tool', {}, { toolUseId: 'tuu-123' });
    expect(receivedCtx?.toolUseId).toBe('tuu-123');
  });

  it('不传 ctx 时旧 executor 仍正常工作', async () => {
    const registry = new ToolRegistry();
    const def: ToolDefinition = {
      name: 'legacy_tool',
      description: 'legacy',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    registry.register(def, async () => 'legacy-ok');
    const result = await registry.execute('legacy_tool', {});
    expect(result).toBe('legacy-ok');
  });
});
```

- [ ] **Step 2:运行确认失败**

Run: `npx vitest run src/__tests__/agent/tool-registry-ctx.test.ts`
Expected: FAIL — ctx 未透传。

- [ ] **Step 3:扩展 types.ts**

```ts
// src/agent/types.ts — 找到 ToolExecutor 定义(约 line 69),替换为:

/** 工具执行上下文(通用扩展点,非 ask 专用)。当前仅 toolUseId。 */
export interface ToolExecutionContext {
  toolUseId: string;
  // 未来扩展(当前不实现,仅预留):
  // signal?: AbortSignal;   // 用户取消 / turn 中断 / timeout
}

/** 工具执行函数。ctx 可选,旧 executor 零改动。返回类型固定 string。 */
export type ToolExecutor = (
  input: Record<string, unknown>,
  ctx?: ToolExecutionContext,
) => Promise<string>;
```

- [ ] **Step 4:修改 registry.execute**

```ts
// src/agent/tool-registry.ts:41 — 替换 execute 方法:
async execute(name: string, input: Record<string, unknown>, ctx?: ToolExecutionContext): Promise<string> {
  const tool = this._tools.get(name);
  if (!tool) {
    return `Error: Unknown tool "${name}"`;
  }
  try {
    return await tool.executor(input, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Error executing tool "${name}": ${message}`;
  }
}
```

同时在文件顶部 import 补充:
```ts
import type { ToolDefinition, ToolExecutor, RegisteredTool, ToolExecutionContext } from './types.js';
```

- [ ] **Step 5:运行测试确认通过**

Run: `npx vitest run src/__tests__/agent/tool-registry-ctx.test.ts`
Expected: 2 passed。

- [ ] **Step 6:类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0(旧 executor 签名 `(input) => ...` 仍兼容可选 ctx)。

- [ ] **Step 7:Commit**

```bash
git add src/agent/types.ts src/agent/tool-registry.ts src/__tests__/agent/tool-registry-ctx.test.ts
git commit -m "feat(agent): extend ToolExecutor with optional ctx (toolUseId)

ToolExecutionContext 是通用扩展点。registry.execute 透传 ctx。
旧 executor 零改动(可选参数)。返回类型仍 Promise<string>。"
```

---

## Task 8:4 个调用点补 ctx 实参

**Files:**
- Modify: `src/agent/streaming-executor.ts:132`
- Modify: `src/agent/streaming-query.ts:364`
- Modify: `src/agent/loop.ts:265, 293`

- [ ] **Step 1:streaming-executor.ts:132 补 ctx**

```ts
// 找到(约 line 132):
const output = await this.registry.execute(tool.block.name, tool.block.input);
// 改为:
const output = await this.registry.execute(tool.block.name, tool.block.input, { toolUseId: tool.block.id });
```

- [ ] **Step 2:streaming-query.ts:364 补 ctx(传统分支)**

```ts
// 找到(约 line 364):
const output = await registry.execute(block.name, block.input);
// 改为:
const output = await registry.execute(block.name, block.input, { toolUseId: block.id });
```

- [ ] **Step 3:loop.ts:265 补 ctx(legacy 并行)**

```ts
// 找到(约 line 265):
const rawOutput = await registry.execute(call.name, call.input);
// 改为:
const rawOutput = await registry.execute(call.name, call.input, { toolUseId: call.id });
```

- [ ] **Step 4:loop.ts:293 补 ctx(legacy 串行)**

```ts
// 找到(约 line 293):
const rawOutput = await registry.execute(call.name, call.input);
// 改为:
const rawOutput = await registry.execute(call.name, call.input, { toolUseId: call.id });
```

- [ ] **Step 5:类型检查 + 回归测试**

Run: `npx tsc --noEmit && npx vitest run src/__tests__/streaming-executor.test.ts src/__tests__/streaming-query.test.ts`
Expected: exit 0 + 测试 PASS。

- [ ] **Step 6:Commit**

```bash
git add src/agent/streaming-executor.ts src/agent/streaming-query.ts src/agent/loop.ts
git commit -m "feat(agent): pass toolUseId ctx at all 4 registry.execute call sites"
```

---

## Task 9:ask-user-tool executor 写入 store

**Files:**
- Modify: `src/agent/tools/ask-user-tool.ts`

- [ ] **Step 1:写失败测试 — executor 写入 store**

```ts
// src/__tests__/agent/ask-user-tool-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createAskUserTool } from '../../agent/tools/ask-user-tool.js';
import { askOutcomeStore } from '../../agent/ask-outcome-store.js';
import type { AskUserManager } from '../../agent/ask-user-manager.js';

// Mock manager
const mockManager = {
  ask: async () => ({ kind: 'submitted' as const, answers: { 'q': 'A' } }),
} as unknown as AskUserManager;

describe('ask-user-tool executor writes store', () => {
  beforeEach(() => askOutcomeStore.clear());

  it('executor 带 ctx 时写入 StructuredAskResult', async () => {
    const { executor } = createAskUserTool(mockManager);
    await executor(
      { questions: [{ header: 'H', question: 'q', options: [{ label: 'A', description: 'd' }], multiSelect: false }] },
      { toolUseId: 'tuu-test' },
    );
    const result = askOutcomeStore.take('tuu-test');
    expect(result?.version).toBe(1);
    expect(result?.request.questions[0]?.header).toBe('H');
    expect(result?.outcome.kind).toBe('submitted');
  });
});
```

- [ ] **Step 2:运行确认失败**

Run: `npx vitest run src/__tests__/agent/ask-user-tool-store.test.ts`
Expected: FAIL — store 未写入。

- [ ] **Step 3:修改 executor**

```ts
// src/agent/tools/ask-user-tool.ts — 替换 executor(约 line 59-64):
import { askOutcomeStore } from '../ask-outcome-store.js';
// ...

    executor: async (input, ctx) => {
      const validated = validateAskUserInput(input);
      if (!validated.ok) return `Error: ${validated.error}`;
      const outcome = await mgr.ask(validated.value);
      if (ctx) {
        askOutcomeStore.set(ctx.toolUseId, {
          version: 1,
          request: validated.value,
          outcome,
        });
      }
      return serializeAskQuestionOutcome(outcome);
    },
```

- [ ] **Step 4:运行测试确认通过**

Run: `npx vitest run src/__tests__/agent/ask-user-tool-store.test.ts`
Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/agent/tools/ask-user-tool.ts src/__tests__/agent/ask-user-tool-store.test.ts
git commit -m "feat(agent): ask-user-tool executor writes StructuredAskResult to store"
```

---

## Task 10:UI 通道类型扩展(3 处)

**Files:**
- Modify: `src/agent/stream-event-bus.ts`(ToolResultEvent)
- Modify: `src/agent/streaming-query.ts`(StreamMessage)
- Modify: `src/ui/types.ts`(Block)

- [ ] **Step 1:ToolResultEvent 加字段**

```ts
// src/agent/stream-event-bus.ts:28-34 — 替换:
import type { StructuredAskResult } from './ask-user-types.js';

export interface ToolResultEvent {
  toolUseId: string;
  name: string;
  output: string;
  duration: number;
  structuredOutcome?: StructuredAskResult;
}
```

- [ ] **Step 2:StreamMessage tool_result 加字段**

```ts
// src/agent/streaming-query.ts:56-60 — tool_result 分支加字段:
import type { StructuredAskResult } from './ask-user-types.js';

export type StreamMessage =
  | NormalizedMessage
  | StreamEvent
  | { type: 'tool_result'; toolUseId: string; name: string; output: string; structuredOutcome?: StructuredAskResult };
```

- [ ] **Step 3:Block tool_result 加字段**

```ts
// src/ui/types.ts:76 — tool_result Block 加字段:
import type { StructuredAskResult } from '../agent/ask-user-types.js';

// 在 tool_result 行追加 structuredOutcome?:
  | { kind: 'tool_result'; name: string; input?: Record<string, unknown>; output: string; toolUseId?: string; durationMs?: number; structuredOutcome?: StructuredAskResult }
```

- [ ] **Step 4:类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 5:Commit**

```bash
git add src/agent/stream-event-bus.ts src/agent/streaming-query.ts src/ui/types.ts
git commit -m "feat(ui): add structuredOutcome field to UI channel types (3 files)"
```

---

## Task 11:streaming-query 阶段3 take + 挂载 + finally sweep

**Files:**
- Modify: `src/agent/streaming-query.ts`(阶段3 两个分支 + finally)

- [ ] **Step 1:阶段3 流式分支(约 313-343)take + 挂载**

```ts
// src/agent/streaming-query.ts — 阶段3 流式分支,找到 emitToolResult 和 yield 前后:
// 在 const output = ... 之后,emitToolResult 之前加:
        const structuredOutcome = askOutcomeStore.take(tool.id);
// emitToolResult 加字段:
        eventBus?.emitToolResult({
          toolUseId: tool.id,
          name: tool.block.name,
          output,
          duration: Date.now() - (toolStartTimes.get(tool.id) ?? Date.now()),
          structuredOutcome,
        });
// yield 加字段:
        yield {
          type: 'tool_result',
          toolUseId: tool.id,
          name: tool.block.name,
          output,
          structuredOutcome,
        };
```

- [ ] **Step 2:阶段3 传统分支(约 364-389)同步**

传统分支同样:`registry.execute` 已带 ctx(Task 8),take 后挂载到 emitToolResult 和 yield。重复 Step 1 的模式。

- [ ] **Step 3:finally 块加 sweep**

```ts
// src/agent/streaming-query.ts:460-463 — 现有 finally:
  } finally {
    if (onMessages) onMessages(messages);
  }
// 改为:
  } finally {
    askOutcomeStore.sweep();  // 清理未消费/超 TTL 的 entry
    if (onMessages) onMessages(messages);
  }
```

在文件顶部 import:
```ts
import { askOutcomeStore } from './ask-outcome-store.js';
```

- [ ] **Step 4:集成测试 — streaming-query 透传 structuredOutcome**

```ts
// src/__tests__/streaming-query-structured-outcome.test.ts
import { describe, it, expect } from 'vitest';
// 使用现有 streaming-query 测试 fixture,验证 ask_user_question 的 tool_result
// 事件里携带 structuredOutcome(需 mock LLM 返回 ask_user_question tool_use + 模拟 manager resolve)
// 断言:eventBus.onToolResult 收到的 data.structuredOutcome 不为 undefined
```

(具体 fixture 参考 `src/__tests__/streaming-query.test.ts` 现有 ask_user 相关用例。)

- [ ] **Step 5:运行测试**

Run: `npx vitest run src/__tests__/streaming-query-structured-outcome.test.ts src/__tests__/streaming-query.test.ts`
Expected: PASS。

- [ ] **Step 6:Commit**

```bash
git add src/agent/streaming-query.ts src/__tests__/streaming-query-structured-outcome.test.ts
git commit -m "feat(agent): streaming-query takes structuredOutcome & sweeps store in finally"
```

---

## Task 12:`buildAskUserPresentation` 纯函数(TDD)

**Files:**
- Create: `src/ui/ask-user-presentation.ts`
- Test: `src/__tests__/ui/ask-user-presentation.test.ts`

- [ ] **Step 1:写失败测试 — submitted/cancelled/chat 三种**

```ts
// src/__tests__/ui/ask-user-presentation.test.ts
import { describe, it, expect } from 'vitest';
import { buildAskUserPresentation } from '../../ui/ask-user-presentation.js';
import type { StructuredAskResult } from '../../agent/ask-user-types.js';

const makeResult = (overrides: Partial<StructuredAskResult> = {}): StructuredAskResult => ({
  version: 1,
  request: {
    questions: [
      { header: 'Auth', question: 'How to auth?', options: [{ label: 'OAuth', description: 'd' }, { label: 'Key', description: 'd' }], multiSelect: false },
      { header: 'Lib', question: 'Which lib?', options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }], multiSelect: true },
    ],
  },
  outcome: { kind: 'submitted', answers: { 'How to auth?': 'OAuth', 'Which lib?': 'A, B' } },
  ...overrides,
});

describe('buildAskUserPresentation', () => {
  it('submitted:折叠摘要 + 展开 Q→A', () => {
    const p = buildAskUserPresentation(makeResult());
    expect(p).not.toBeNull();
    expect(p!.summary).toContain('2');  // Answered 2 questions
    // 展开行用 header 配对
    expect(p!.lines.some(l => l.includes('Auth') && l.includes('OAuth'))).toBe(true);
    expect(p!.lines.some(l => l.includes('Lib') && l.includes('A, B'))).toBe(true);
  });

  it('cancelled:Declined', () => {
    const p = buildAskUserPresentation(makeResult({ outcome: { kind: 'cancelled' } }));
    expect(p!.summary.toLowerCase()).toMatch(/declined/);
  });

  it('chat:Feedback', () => {
    const p = buildAskUserPresentation(makeResult({ outcome: { kind: 'chat', feedback: 'need more info' } }));
    expect(p!.summary).toContain('need more info');
  });

  it('不支持的 version:返回 null(fallback rawOutput)', () => {
    const p = buildAskUserPresentation({ version: 99, request: makeResult().request, outcome: makeResult().outcome } as any);
    expect(p).toBeNull();
  });
});
```

- [ ] **Step 2:运行确认失败**

Run: `npx vitest run src/__tests__/ui/ask-user-presentation.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3:写实现**

```ts
// src/ui/ask-user-presentation.ts
// ask_user_question 结构化结果 → 展示模型。
// 仿 subagent-presentation.ts 模式:返回 { summary, lines } 或 null(null = fallback rawOutput)。

import type { StructuredAskResult } from '../agent/ask-user-types.js';

export interface AskUserPresentation {
  /** 折叠时单行摘要,如 "Answered 2 questions" */
  summary: string;
  /** 展开时每行内容(不含 ⎿ 前缀,由 block-pipeline 加) */
  lines: string[];
}

/**
 * 把 StructuredAskResult 转成展示模型。
 * 不识别的 version 返回 null(调用方回退 rawOutput)。
 */
export function buildAskUserPresentation(result: StructuredAskResult): AskUserPresentation | null {
  if (result.version !== 1) return null;

  const { request, outcome } = result;

  if (outcome.kind === 'cancelled') {
    return { summary: 'Declined to answer', lines: ['User declined to answer questions'] };
  }

  if (outcome.kind === 'chat') {
    return { summary: `Feedback: ${outcome.feedback}`, lines: [outcome.feedback] };
  }

  // submitted:request.questions 的 header 配对 outcome.answers 的 question
  const entries = request.questions.map(q => ({
    header: q.header,
    answer: outcome.answers[q.question] ?? '(no answer)',
  }));

  const summary = `Answered ${entries.length} question${entries.length === 1 ? '' : 's'}`;
  const lines = entries.map(e => `${e.header} → ${e.answer}`);

  return { summary, lines };
}
```

- [ ] **Step 4:运行测试确认通过**

Run: `npx vitest run src/__tests__/ui/ask-user-presentation.test.ts`
Expected: 4 passed。

- [ ] **Step 5:Commit**

```bash
git add src/ui/ask-user-presentation.ts src/__tests__/ui/ask-user-presentation.test.ts
git commit -m "feat(ui): add buildAskUserPresentation pure function (submitted/cancelled/chat)"
```

---

## Task 13:block-pipeline ask_user_question 特判分支

**Files:**
- Modify: `src/ui/block-pipeline.ts:245`(case 'tool_result')

- [ ] **Step 1:在 spawn_agent 特判后(约 300 行后)加 ask_user_question 分支**

```ts
// src/ui/block-pipeline.ts — 在 spawn_agent 分支(约 277-300)之后、
// const meta = buildToolResultBlock(...) 之前,加:

        // AUTO-0025 Phase B:ask_user_question 结构化展示。
        if (item.name === 'ask_user_question' && block.structuredOutcome) {
          try {
            const presentation = buildAskUserPresentation(block.structuredOutcome);
            if (presentation) {
              item.resultLines = [{
                content: `⎿ ${presentation.summary}`,
                style: BLOCK_STYLES.magenta,
                indent: 0,
              }];
              item.finalKind = 'agent-completion';
              const id = `ask-${++this.idCounter}`;
              const fullLines = presentation.lines.map((l, i) => ({
                content: `${i === 0 ? '⎿  ' : '   '}${l}`,
                style: BLOCK_STYLES.dim,
                indent: INDENT.nested,
                raw: true,
              }));
              item.expandableId = id;
              item.expandableFullLines = fullLines;
              item.hasExpandable = true;
              this.finishTool(idx);
              break;
            }
          } catch (err) {
            // 降级:记录 debug log + 回退 rawOutput,不中断 pipeline
            console.error('[ask_user presentation failed]', { toolUseId: block.toolUseId, err });
            // 落到下面的通用 rawOutput 逻辑
          }
        }
```

文件顶部 import:
```ts
import { buildAskUserPresentation } from './ask-user-presentation.js';
```

- [ ] **Step 2:类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3:block-pipeline 测试 — ask_user 结构化渲染**

```ts
// 在 src/__tests__/ui/block-pipeline.test.ts 追加用例:
// 模拟 emit tool_call(ask_user_question) + tool_result(带 structuredOutcome)
// 断言:resultLines 包含 "Answered N questions"
// 断言:hasExpandable === true,展开后含 "header → answer" 行
```

- [ ] **Step 4:运行测试**

Run: `npx vitest run src/__tests__/ui/block-pipeline.test.ts`
Expected: PASS。

- [ ] **Step 5:Commit**

```bash
git add src/ui/block-pipeline.ts src/__tests__/ui/block-pipeline.test.ts
git commit -m "feat(ui): block-pipeline renders ask_user_question with structured presentation"
```

---

## Task 14:index.ts onToolResult 透传 structuredOutcome

**Files:**
- Modify: `src/index.ts:681-687`

- [ ] **Step 1:onToolResult handler 透传**

```ts
// src/index.ts:681 — 找到 eventBus.onToolResult handler,在 pipeline.emit 加字段:
eventBus.onToolResult((d) => {
  pipeline.emit({
    kind: 'tool_result',
    name: d.name,
    input: undefined,  // 或现有逻辑
    output: d.output,
    toolUseId: d.toolUseId,
    durationMs: d.duration,
    structuredOutcome: d.structuredOutcome,  // ← 新增
  });
});
```

- [ ] **Step 2:类型检查**

Run: `npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 3:Commit**

```bash
git add src/index.ts
git commit -m "feat: forward structuredOutcome from eventBus to pipeline"
```

---

## Task 15:API diff 验证(硬约束)

- [ ] **Step 1:写测试对比改造前后 API 请求的 tool_result content**

```ts
// src/__tests__/agent/api-diff-structured-outcome.test.ts
// 目标:证明 StructuredAskResult 不进入 ToolResultBlock.content
// 方法:mock Anthropic client,捕获 convertMessages 产出的 tool_result,
// 断言 content === serializeAskQuestionOutcome(outcome)(纯字符串,无 structuredOutcome 字段)
```

具体实现:参考 `src/agent/anthropic-stream-client.ts:250-270` 的 `convertMessages`,构造一个含 ask_user_question tool_result 的 messages 数组,断言转换后 content 是 string、无额外字段。

- [ ] **Step 2:运行测试**

Run: `npx vitest run src/__tests__/agent/api-diff-structured-outcome.test.ts`
Expected: PASS(content 仍是纯字符串)。

- [ ] **Step 3:Commit**

```bash
git add src/__tests__/agent/api-diff-structured-outcome.test.ts
git commit -m "test(agent): verify structuredOutcome does not leak into API tool_result content"
```

---

## Task 16:类型检查 + Lint + 全量测试 + TTY 验收

- [ ] **Step 1:TypeScript 通过**

Run: `npx tsc --noEmit`
Expected: exit 0。

- [ ] **Step 2:Lint 通过**

Run: `npx eslint src/agent/ask-outcome-store.ts src/agent/tools/ask-user-tool.ts src/agent/streaming-query.ts src/ui/ask-user-presentation.ts src/ui/block-pipeline.ts`
Expected: 无错误。

- [ ] **Step 3:影响模块测试**

Run: `npx vitest run src/agent/ src/ui/`
Expected: 全部 PASS。

- [ ] **Step 4:全量测试**

Run: `npm test`
Expected: 全部 PASS,无回归。

- [ ] **Step 5:真实 TTY 验收**

触发 ask_user_question,回答后观察:
- [ ] tool_result 显示 `⎿ Answered N questions`(折叠态)
- [ ] Ctrl+O 展开显示 `header → answer` 列表
- [ ] cancelled 显示 `⎿ Declined to answer`
- [ ] chat 显示 `⎿ Feedback: ...`
- [ ] 无控制台 error log

**PR2 完成标准:全量测试通过 + API diff 通过 + TTY 结构化展示正常。**

---

## Self-Review(plan 自审)

**Spec coverage(PR1):**
- A1 圆角边框 → Task 2 ✓
- A2 radio/checkbox → Task 2 ✓
- A3 computeTabLayout → Task 1 ✓
- A4 Other/Chat 文案 → Task 2 ✓

**Spec coverage(PR2):**
- 点1 ToolExecutor ctx → Task 7 ✓
- 点2 registry 透传 → Task 7 ✓
- 点3 4 调用点 → Task 8 ✓
- 点4 executor 写 store → Task 9 ✓
- 点5 askOutcomeStore → Task 6 ✓
- 点6 streaming-query take + sweep → Task 11 ✓
- 点7 buildAskUserPresentation + block-pipeline → Task 12, 13 ✓
- StructuredAskResult 类型 → Task 5 ✓
- UI 通道类型扩展 → Task 10 ✓
- index.ts 透传 → Task 14 ✓
- API diff 验证 → Task 15 ✓
- orphan 清理(三级) → Task 6(sweep/clear/TTL)+ Task 11(finally)✓
- 并发隔离测试 → Task 6 ✓

**类型一致性:** `StructuredAskResult { version, request, outcome }` 在 Task 5 定义,Task 6/9/10/12/13 全部一致使用。`ToolExecutionContext { toolUseId }` 在 Task 7 定义,Task 8/9 一致。

**Placeholder 检查:** Task 11 Step 4 和 Task 13 Step 3 的集成测试描述较简略(标注"参考现有 fixture")—— 这是因为现有测试文件结构需读取后才能精确给出,实施时参考 `streaming-query.test.ts` 和 `block-pipeline.test.ts` 的 mock 模式。这不属于 placeholder(有明确参考目标),但实施者需先读现有测试。
