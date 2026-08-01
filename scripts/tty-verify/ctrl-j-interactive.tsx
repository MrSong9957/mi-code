// scripts/tty-verify/ctrl-j-interactive.tsx
//
// ConPTY Ctrl+J 端到端回归驱动。
// 渲染真实 Footer + useInputHandler,从真实 stdin 接收按键字节。
// 模拟:输入 AAA → Ctrl+J → 输入 BBB → 验证两行渲染(❯ AAA /   BBB)。
//
// 用法: node --import tsx scripts/tty-verify/ctrl-j-interactive.tsx <cols>
// 外层 verify-ctrl-j.cjs 通过 pty.spawn 启动本脚本,用 pty.write 发送按键。

import React from 'react';
import { render } from 'ink';
import { Box } from 'ink';
import { useStore } from 'zustand/react';
import { createInputStore } from '../../src/tui/state/input-store.js';
import { createSpinnerStore } from '../../src/tui/state/spinner-store.js';
import { createCompletionStore } from '../../src/tui/state/completion-store.js';
import { createSelectionStore } from '../../src/tui/state/selection-store.js';
import { computeInputViewportLayout, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH } from '../../src/tui/state/input-viewport.js';
import { useInputHandler } from '../../src/tui/input/use-input-handler.js';
import { Footer } from '../../src/tui/components/Footer.js';

const cols = parseInt(process.argv[2] ?? '80', 10);

const inputStore = createInputStore({ onSubmit: () => {} });
const spinnerStore = createSpinnerStore();
const completionStore = createCompletionStore();
const selectionStore = createSelectionStore();
const spinnerView = { rowCount: 0, glyph: '', verb: '' };

function InteractiveFooter(): React.ReactElement {
  // 用 useStore 订阅 inputStore(vanilla store,非 hook)
  const text = useStore(inputStore, (s) => s.text);
  const cursor = useStore(inputStore, (s) => s.cursor);
  // 真实按键处理链路
  useInputHandler(
    inputStore,
    undefined, undefined, undefined, undefined,
    undefined, completionStore, undefined,
    spinnerStore, undefined, undefined, undefined,
  );
  const layout = computeInputViewportLayout(text, cursor, cols, PROMPT_WIDTH, CONTINUATION_INDENT_WIDTH);
  return (
    <Box flexDirection="column">
      <Footer
        status={{ mode: 'build', model: 'test', dir: '/tmp', branch: 'main', contextPct: 0 }}
        cols={cols}
        inputRowY={1}
        layout={layout}
        spinnerView={spinnerView as any}
        completionStore={completionStore}
        selectionStore={selectionStore}
      />
    </Box>
  );
}

const { unmount } = render(<InteractiveFooter />, { stdout: process.stdout } as any);
setTimeout(() => { unmount(); setTimeout(() => process.exit(0), 100); }, 2000);
