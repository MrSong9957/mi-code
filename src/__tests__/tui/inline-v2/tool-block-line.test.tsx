// src/__tests__/tui/inline-v2/tool-block-line.test.tsx
// ToolBlockLine 渲染测试:验证分组工具块的视觉输出。
//
// 用 ink-testing-library render + strip-ansi 断言去色后的纯文本行。
// 断言来自计划 Task 6 Step 1 的精确帧定义。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import { LocaleProvider } from '../../../locale/context.js';
import { createLanguageStore } from '../../../locale/language-store.js';
import type { Language } from '../../../locale/types.js';
import { ToolBlockLine } from '../../../tui/inline-v2/ToolBlockLine.js';
import type { ToolBlock, ToolPresentation } from '../../../tui/transcript-types.js';

// ---- file-local fixtures(独立于 reducer fixtures) ----

function globPresentation(
  toolUseId: string,
  pattern: string,
  count: number,
): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${pattern} → ${count} file${count === 1 ? '' : 's'}`,
    details: Array.from({ length: count }, (_, index) => ({
      kind: 'path' as const,
      path: `${pattern}#${index + 1}`,
    })),
    status: 'success',
  };
}

function emptyGlobPresentation(
  toolUseId: string,
  pattern: string,
): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${pattern} → no matches`,
    details: [],
    status: 'empty',
  };
}

function errorGlobPresentation(
  toolUseId: string,
  pattern: string,
  errorMessage: string,
): ToolPresentation {
  return {
    toolUseId,
    toolName: 'glob',
    summary: `${pattern} → failed: ${errorMessage}`,
    details: [],
    status: 'error',
    errorMessage,
  };
}

function cancelledPresentation(toolUseId: string, compact = false): ToolPresentation {
  return {
    toolUseId,
    toolName: 'spawn_agent',
    summary: 'spawn_agent → cancelled',
    details: [],
    status: 'cancelled',
    layout: compact ? 'compact-completion' : undefined,
  };
}

function renderToolBlockLine(block: ToolBlock, language: Language = 'en-US'): string {
  const store = createLanguageStore(language);
  return stripAnsi(render(
    <LocaleProvider store={store}>
      <ToolBlockLine block={block} cols={100} />
    </LocaleProvider>,
  ).lastFrame() ?? '');
}

function renderRawToolBlockLine(block: ToolBlock): string {
  const previousLevel = chalk.level;
  chalk.level = 1;
  try {
    const store = createLanguageStore('en-US');
    return render(
      <LocaleProvider store={store}>
        <ToolBlockLine block={block} cols={100} />
      </LocaleProvider>,
    ).lastFrame() ?? '';
  } finally {
    chalk.level = previousLevel;
  }
}

describe('ToolBlockLine', () => {
  it('renders one summary block for adjacent glob calls', () => {
    const block: ToolBlock = {
      id: 'tg1',
      kind: 'tool',
      toolName: 'glob',
      presentations: [
        globPresentation('g1', 'src/**/*.test.ts', 11),
        globPresentation('g2', 'src/render/**/*.test.ts', 2),
        emptyGlobPresentation('g3', 'src/**/*.spec.ts'),
        errorGlobPresentation('g4', 'src/**/protected/*.ts', 'permission denied'),
      ],
      thinking: [{ durationMs: 1_000 }, { durationMs: 2_000 }],
    };
    expect(renderToolBlockLine(block)).toBe([
      '● Searched 4 patterns',
      '  ⎿ src/**/*.test.ts → 11 files',
      '  ⎿ src/render/**/*.test.ts → 2 files',
      '  ⎿ src/**/*.spec.ts → no matches',
      '  ⎿ src/**/protected/*.ts → failed: permission denied',
      '  ⎿ Thought 3s (2 entries)',
    ].join('\n'));
  });

  it('orders error entries after success/empty', () => {
    const block: ToolBlock = {
      id: 'tg2',
      kind: 'tool',
      toolName: 'glob',
      presentations: [
        errorGlobPresentation('e1', 'protected/**', 'denied'),
        globPresentation('s1', 'src/**/*.ts', 3),
        emptyGlobPresentation('e2', 'src/**/*.spec.ts'),
      ],
      thinking: [],
    };
    const frame = renderToolBlockLine(block);
    const lines = frame.split('\n');
    // title
    expect(lines[0]).toBe('● Searched 3 patterns');
    // success 先于 empty 先于 error(orderToolPresentations 稳定排序)
    expect(lines[1]).toContain('src/**/*.ts → 3 files');
    expect(lines[2]).toContain('src/**/*.spec.ts → no matches');
    expect(lines[3]).toContain('protected/** → failed: denied');
  });

  it('renders a cancelled tool summary', () => {
    expect(renderToolBlockLine({
      id: 'cancelled-tool',
      kind: 'tool',
      toolName: 'spawn_agent',
      presentations: [cancelledPresentation('cancelled')],
      thinking: [],
    })).toContain('spawn_agent → cancelled');
  });

  it('renders a compact cancelled tool dim', () => {
    const block: ToolBlock = {
      id: 'compact-cancelled-tool',
      kind: 'tool',
      toolName: 'spawn_agent',
      presentations: [cancelledPresentation('cancelled', true)],
      thinking: [],
    };
    const frame = renderRawToolBlockLine(block);

    expect(stripAnsi(frame)).toContain('● spawn_agent → cancelled');
    expect(frame).toContain('\u001B[2m');
  });

  it('omits thinking metadata when single entry below 2s', () => {
    const block: ToolBlock = {
      id: 'tg3',
      kind: 'tool',
      toolName: 'glob',
      presentations: [globPresentation('g1', '*.ts', 1)],
      thinking: [{ durationMs: 1_000 }],
    };
    const frame = renderToolBlockLine(block);
    expect(frame).not.toContain('Thought');
    expect(frame.split('\n')).toHaveLength(2); // title + 1 summary
  });

  it('renders read group title through LocaleProvider', () => {
    const block: ToolBlock = {
      id: 'tg4',
      kind: 'tool',
      toolName: 'read_file',
      presentations: [
        { toolUseId: 'r1', toolName: 'read_file', summary: 'src/a.ts', details: [], status: 'success' },
        { toolUseId: 'r2', toolName: 'read_file', summary: 'src/b.ts', details: [], status: 'success' },
      ],
      thinking: [],
    };
    const frame = renderToolBlockLine(block);
    expect(frame.split('\n')[0]).toBe('● Read 2 items');
  });

  it('localizes fixed group labels in zh-CN while preserving raw summaries', () => {
    const block: ToolBlock = {
      id: 'tg5',
      kind: 'tool',
      toolName: 'glob',
      presentations: [
        globPresentation('g1', 'src/**/*.ts', 3),
        emptyGlobPresentation('g2', 'src/**/*.spec.ts'),
      ],
      thinking: [],
    };

    const frame = renderToolBlockLine(block, 'zh-CN');
    expect(frame).toContain('● 搜索了 2 个模式');
    expect(frame).toContain('⎿ src/**/*.ts → 3 files');
    expect(frame).toContain('⎿ src/**/*.spec.ts → no matches');
  });
});
