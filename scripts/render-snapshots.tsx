// scripts/render-snapshots.tsx
//
// 渲染 V2 inline 模式各典型场景的最终帧,导出到 docs 用于人工审阅。
// 用 ink-testing-library render + strip-ansi 去掉颜色码,保留布局结构。
//
// 用法: npx tsx scripts/render-snapshots.tsx

import React from 'react';
import { render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { writeFileSync } from 'fs';
import { InlineAppV2 } from '../src/tui/inline-v2/InlineAppV2.js';
import { createSpinnerStore } from '../src/tui/state/spinner-store.js';
import { createMessagesStore } from '../src/tui/state/messages-store.js';
import { createInputStore } from '../src/tui/state/input-store.js';
import { createStatusStore } from '../src/tui/state/status-store.js';
import { createCompletionStore } from '../src/tui/state/completion-store.js';
import { createSelectStore } from '../src/tui/state/select-store.js';
import { createSelectionStore } from '../src/tui/state/selection-store.js';
import { createOverlayStore } from '../src/tui/state/overlay-store.js';
import { EMPTY_SPINNER_CONTEXT } from '../src/tui/state/spinner-store.js';

interface Stores {
  messagesStore: ReturnType<typeof createMessagesStore>;
  inputStore: ReturnType<typeof createInputStore>;
  statusStore: ReturnType<typeof createStatusStore>;
  spinnerStore: ReturnType<typeof createSpinnerStore>;
  completionStore: ReturnType<typeof createCompletionStore>;
  selectStore: ReturnType<typeof createSelectStore>;
  selectionStore: ReturnType<typeof createSelectionStore>;
  overlayStore: ReturnType<typeof createOverlayStore>;
}

function makeStores(): Stores {
  return {
    messagesStore: createMessagesStore(),
    inputStore: createInputStore({ onSubmit: () => {} }),
    statusStore: createStatusStore({ mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main' }),
    spinnerStore: createSpinnerStore(undefined, EMPTY_SPINNER_CONTEXT),
    completionStore: createCompletionStore(),
    selectStore: createSelectStore(),
    selectionStore: createSelectionStore(),
    overlayStore: createOverlayStore(),
  };
}

const STATUS = { mode: 'build', model: 'sonnet', dir: 'Projects/mi-code', branch: 'main', contextPct: 0.25 };
const LOGO = { version: '1.0.0', dir: 'Projects/mi-code' };

function snapshot(stores: Stores): string {
  const { lastFrame } = render(
    React.createElement(InlineAppV2, {
      messages: stores.messagesStore.getState().messages,
      status: STATUS,
      logo: LOGO,
      stores,
      cols: 80,
      rows: 24,
    }),
  );
  return stripAnsi(lastFrame() ?? '');
}

const snapshots: string[] = [];

function addSnapshot(title: string, frame: string): void {
  snapshots.push(`### ${title}\n\n\`\`\`\n${frame}\n\`\`\`\n`);
}

// 场景 1:空启动
{
  const s = makeStores();
  addSnapshot('场景 1:启动(空消息)', snapshot(s));
}

// 场景 2:已有多轮对话
{
  const s = makeStores();
  s.messagesStore.getState().appendMessage('user', [{ content: '你好', style: {}, indent: 0 }]);
  s.messagesStore.getState().appendMessage('assistant', [{ content: '● 你好!有什么可以帮你的吗?', style: {}, indent: 0 }]);
  addSnapshot('场景 2:两轮对话(已固化)', snapshot(s));
}

// 场景 3:流式 + spinner active
{
  const s = makeStores();
  s.messagesStore.getState().appendMessage('user', [{ content: '写首诗', style: {}, indent: 0 }]);
  s.messagesStore.getState().startStreaming('秋风起\n落叶飞\n');
  s.spinnerStore.getState().start('responding');
  addSnapshot('场景 3:流式响应中(spinner + 草稿)', snapshot(s));
}

// 场景 4:Select 选择器
{
  const s = makeStores();
  s.selectStore.getState().open('Select model', [
    { value: 'sonnet', label: 'Sonnet', description: 'fast' },
    { value: 'opus', label: 'Opus', description: 'powerful' },
    { value: 'haiku', label: 'Haiku', description: 'cheap' },
  ]);
  addSnapshot('场景 4:Select 选择器(/model)', snapshot(s));
}

// 场景 5:Overlay(Ctrl+O)
{
  const s = makeStores();
  s.overlayStore.getState().open('Thinking output', [
    { content: '让我思考一下这个问题...', style: {}, indent: 0 },
    { content: '  首先需要理解用户意图', style: {}, indent: 0 },
    { content: '  然后给出合适的回答', style: {}, indent: 0 },
  ]);
  addSnapshot('场景 5:Overlay(Ctrl+O 显示 thinking)', snapshot(s));
}

// 场景 6:多行输入
{
  const s = makeStores();
  s.inputStore.getState().setText('def hello():\n    print("world")\n    return 42');
  addSnapshot('场景 6:多行输入(代码粘贴)', snapshot(s));
}

// 写出
const md = `# V2 inline 模式渲染快照

> 自动生成于 scripts/render-snapshots.tsx,展示 V2 路径典型场景的最终渲染帧。
> ANSI 颜色码已剥离,只保留布局结构。
> 终端尺寸:80x24

${snapshots.join('\n')}
`;

writeFileSync('docs/inline-v2-render-snapshots.md', md, 'utf8');
console.log('Wrote docs/inline-v2-render-snapshots.md (' + snapshots.length + ' snapshots)');
