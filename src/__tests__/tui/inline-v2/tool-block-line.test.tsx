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

  // Updated from "<2s" cutoff to "<1s" cutoff (Task 2 unified the thinking
  // commit threshold to 1000ms). Intent unchanged: a single short entry is
  // omitted from the rendered block.
  it('omits thinking metadata when single entry below 1s', () => {
    const block: ToolBlock = {
      id: 'tg3',
      kind: 'tool',
      toolName: 'glob',
      presentations: [globPresentation('g1', '*.ts', 1)],
      thinking: [{ durationMs: 500 }],
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

  // ── semantic-activity 标题提升 ──
  // memory_* / read_file(path='.') 的 summary 描述活动本身,应成为 ● 标题,
  // 而非重复输出为 ⎿ 子行(否则出现 "● Ran 1 operation / ⎿ Checked memory")。

  it('promotes singleton memory_list semantic to the title line', () => {
    const block: ToolBlock = {
      id: 'mem-singleton',
      kind: 'tool',
      toolName: 'memory_list',
      presentations: [
        {
          toolUseId: 'm1',
          toolName: 'memory_list',
          summary: 'Checked memory',
          details: [],
          status: 'success',
          semanticActivity: true,
        },
      ],
      thinking: [],
    };
    const frame = renderToolBlockLine(block);
    const lines = frame.split('\n');
    // 标题即 semantic 活动
    expect(lines[0]).toBe('● Checked memory');
    // 不出现 generic 分组标题
    expect(frame).not.toContain('Ran 1 operation');
    // 不重复输出 ⎿ semantic 子行
    expect(frame).not.toContain('⎿ Checked memory');
    // singleton 语义块只有标题一行
    expect(lines).toHaveLength(1);
  });

  it('promotes singleton read_file(path=".") semantic to the title line', () => {
    const block: ToolBlock = {
      id: 'dir-singleton',
      kind: 'tool',
      toolName: 'read_file',
      presentations: [
        {
          toolUseId: 'd1',
          toolName: 'read_file',
          summary: 'Read project structure',
          details: [],
          status: 'success',
          semanticActivity: true,
        },
      ],
      thinking: [],
    };
    const frame = renderToolBlockLine(block);
    const lines = frame.split('\n');
    expect(lines[0]).toBe('● Read project structure');
    expect(frame).not.toContain('Read 1 item');
    expect(frame).not.toContain('⎿ Read project structure');
    expect(lines).toHaveLength(1);
  });
});
