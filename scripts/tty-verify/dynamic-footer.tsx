// scripts/tty-verify/dynamic-footer.tsx
//
// ConPTY 动态 footer 验收驱动:在真实伪终端渲染 InlineAppV2/App,
// 构造各输入状态(1/2-5/6+行/长英文/长中文),捕获屏幕供外层断言。
//
// 用法: node --import tsx scripts/tty-verify/dynamic-footer.tsx <scenario> <cols>

import React from 'react';
import { render } from 'ink';
import { App } from '../../src/tui/App.js';
import { createMessagesStore } from '../../src/tui/state/messages-store.js';
import { createInputStore } from '../../src/tui/state/input-store.js';
import { createStatusStore } from '../../src/tui/state/status-store.js';
import { createSpinnerStore } from '../../src/tui/state/spinner-store.js';
import { createCompletionStore } from '../../src/tui/state/completion-store.js';
import { createSelectStore } from '../../src/tui/state/select-store.js';
import { createOverlayStore } from '../../src/tui/state/overlay-store.js';
import { createSelectionStore } from '../../src/tui/state/selection-store.js';
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../src/tui/state/input-viewport.js';

const scenario = process.argv[2] ?? 'empty';
const cols = parseInt(process.argv[3] ?? '80', 10);
const rows = 24;

// 按 scenario 构造输入文本 + cursor(模拟 Ctrl+J 多行 / 粘贴长文本)。
function inputFor(scenario: string): { input: string; cursor: number; msgs: string[] } {
  switch (scenario) {
    case 'empty':      return { input: '', cursor: 0, msgs: [] };
    case 'two':        return { input: 'line1\nline2', cursor: 11, msgs: [] };
    case 'five':       return { input: 'l1\nl2\nl3\nl4\nl5', cursor: 14, msgs: [] };
    case 'six':        return { input: 'l1\nl2\nl3\nl4\nl5\nl6', cursor: 17, msgs: [] };
    case 'long-en':    return { input: 'word '.repeat(40), cursor: 200, msgs: [] };
    case 'long-zh':    return { input: '你好世界测试中文折行'.repeat(20), cursor: 200, msgs: [] };
    case 'anchor':     return { input: 'l1\nl2\nl3\nl4\nl5', cursor: 14, msgs: Array.from({ length: 30 }, (_, i) => `msg${i}`) };
    default:           return { input: '', cursor: 0, msgs: [] };
  }
}

const { input, cursor, msgs } = inputFor(scenario);

const messagesStore = createMessagesStore();
for (const m of msgs) messagesStore.getState().appendMessage('assistant', [{ content: m, style: {}, indent: 0 }]);
const inputStore = createInputStore({ onSubmit: () => {} });
inputStore.getState().setText(input);
// cursor 设到末尾(setText 已把 cursor 移到末尾)

const layout = computeInputViewportLayout(input, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
const flatLines = msgs.map((m, i) => ({ messageUuid: `m${i}`, lineIndex: 0, line: { content: m, style: {}, indent: 0 } }));

const { unmount } = render(
  <App
    messages={messagesStore.getState().messages}
    status={{ mode: 'build', model: 'sonnet', dir: '/tmp', branch: 'main', contextPct: 0 }}
    logo={{ version: '0', dir: '/tmp' }}
    selectionStore={createSelectionStore()}
    spinnerStore={createSpinnerStore()}
    completionStore={createCompletionStore()}
    overlayStore={createOverlayStore()}
    layout={layout}
    scrollTop={0}
    flatLines={flatLines}
    cols={cols}
    rows={rows}
  />,
  { stdout: process.stdout } as any,
);

setTimeout(() => { unmount(); setTimeout(() => process.exit(0), 100); }, 300);
