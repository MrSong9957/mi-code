import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import {
  buildSpinnerLine,
  buildSpinnerLines,
} from '../../tui/inline/SpinnerLine.js';
import { createSpinnerStore } from '../../tui/state/spinner-store.js';
import { selectSpinnerView } from '../../tui/state/spinner-view.js';

const THEME = {
  active: 'rgb(100, 200, 240)',
  shimmer: 'rgb(170,230,255)',
  stalled: 'rgb(255,90,90)',
  muted: 'rgb(110,110,120)',
};

describe('SpinnerLine (inline mode)', () => {
  it('builds ANSI string with shimmer segments', () => {
    const result = buildSpinnerLine({
      time: 1000,
      mode: 'responding',
      verb: 'Crafting',
      label: '',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('Crafting');
    expect(result).toContain('\x1b[');
    expect(result).toContain('38;2;100;200;240m');
  });

  it('shows thinking indicator in thinking mode', () => {
    const result = buildSpinnerLine({
      time: 5000,
      mode: 'thinking',
      verb: 'Thinking',
      label: '',
      stalled: false,
      thinkStartTime: 0,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('Thinking');
    expect(result).toContain('(thinking)');
  });

  it('stalledIntensity 默认满强度时使用固定错误红', () => {
    const result = buildSpinnerLine({
      time: 1000,
      mode: 'responding',
      verb: 'Crafting',
      label: '',
      stalled: true,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('\x1b[38;2;171;43;63m');
    expect(result).not.toContain('\x1b[38;2;100;200;240m');
  });

  it('stalled 文字按强度渐变到固定错误红，不直接跳到主题错误色', () => {
    const result = buildSpinnerLine({
      time: 4000,
      mode: 'responding',
      verb: 'Working',
      label: '',
      stalled: true,
      stalledIntensity: 0.5,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('\x1b[38;2;136;122;152mWorking');
    expect(result).not.toContain('\x1b[38;2;255;90;90mWorking');
  });

  it('verb 后固定追加省略号 …（Claude Code 样式，不再用 dots cycle）', () => {
    const make = (time: number) => buildSpinnerLine({
      time,
      mode: 'responding',
      verb: 'Working',
      label: '',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    // U+2026 省略号，固定不变（不随 time 累加变化）。
    expect(make(0)).toContain('…');
    expect(make(300)).toContain('…');
    expect(make(600)).toContain('…');
    // 不再有旧的 1-3 点循环。
    expect(make(0)).not.toMatch(/\.{3}/);
    expect(make(600)).not.toMatch(/\.{3}/);
  });

  it('falls back to verb when label is empty', () => {
    const result = buildSpinnerLine({
      time: 100,
      mode: 'tool-use',
      verb: 'Running',
      label: '',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('Running');
  });

  it('prefers label over verb when both are present', () => {
    const result = buildSpinnerLine({
      time: 100,
      mode: 'tool-use',
      verb: 'Running',
      label: 'Bash',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('Bash');
    expect(result).not.toContain('Running');
  });

  it('tool-use 对整段文本使用呼吸灯颜色，末尾追加 …（Claude Code 样式，不再保留空格）', () => {
    const result = buildSpinnerLine({
      time: 500,
      mode: 'tool-use',
      verb: 'Running',
      label: '',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    // 呼吸灯颜色（shimmer 色）覆盖整段 displayText，末尾 …。
    expect(result).toContain('\x1b[38;2;170;230;255mRunning…');
    // 不再保留尾随空格。
    expect(result).not.toContain('Running… ');
  });

  it('计时器始终显示（无论 verbose 或 teammate 数，默认开）', () => {
    const common = {
      time: 5_000,
      mode: 'responding' as const,
      verb: 'Working',
      label: '',
      stalled: false,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    };
    // 默认始终显示计时（用户期望从一开始就看到耗时）。
    expect(buildSpinnerLine({ ...common, verbose: false, activeTeammateCount: 0 })).toContain('5s');
    expect(buildSpinnerLine({ ...common, verbose: true, activeTeammateCount: 0 })).toContain('5s');
    expect(buildSpinnerLine({ ...common, verbose: false, activeTeammateCount: 1 })).toContain('5s');
  });

  it('totalTokens > 0 时显示 Claude Code 样式 metrics 段 (5s · ↓ 15 tokens)', () => {
    const result = buildSpinnerLine({
      time: 5_000,
      mode: 'responding',
      verb: 'Working',
      label: '',
      stalled: false,
      verbose: true,
      activeTeammateCount: 1,
      displayedTokens: 10,
      teammateTokens: 5,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    // Claude Code 样式：括号包裹 + U+00B7 中点分隔 + tokens 单位词。
    expect(result).toContain('(5s · ↓ 15 tokens)');
  });

  it('thinking 显示 effort 并使用 3 秒延迟后的灰色呼吸', () => {
    const result = buildSpinnerLine({
      time: 3_500,
      mode: 'thinking',
      verb: 'Working',
      label: '',
      stalled: false,
      thinkingEffort: 'hard',
      thinkStartTime: 0,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('(thinking hard)');
    expect(result).toContain('\x1b[38;2;185;185;185m');
  });

  it('退出 thinking 后显示 thought for 临时摘要', () => {
    const result = buildSpinnerLine({
      time: 4_000,
      mode: 'responding',
      verb: 'Working',
      label: '',
      stalled: false,
      thinkingSummaryDurationMs: 1_500,
      thinkStartTime: null,
      theme: {
        active: 'rgb(100,200,240)',
        shimmer: 'rgb(170,230,255)',
        stalled: 'rgb(255,90,90)',
        muted: 'rgb(110,110,120)',
      },
    });
    expect(result).toContain('(thought for 2s)');
  });

  it('normal 输出主行和按顺序 dim 的辅助行，brief 只输出主行', () => {
    const store = createSpinnerStore();
    store.getState().setContext({
      variant: 'normal', teammates: [], tasks: [],
      spinnerTip: 'tip', hasUsedBtw: true,
      budgetText: 'budget', nextTaskText: 'next',
    });
    store.getState().start('responding');

    const normal = buildSpinnerLines(
      selectSpinnerView(store.getState()),
      80,
      THEME,
    );

    expect(normal).toHaveLength(4);
    expect(stripAnsi(normal[1]!)).toBe('tip');
    expect(stripAnsi(normal[2]!)).toBe('budget');
    expect(stripAnsi(normal[3]!)).toBe('next');
    expect(normal.slice(1).every(line => line.includes('\x1b[2m'))).toBe(true);

    store.getState().setContext({
      ...store.getState().context,
      variant: 'brief',
    });
    expect(buildSpinnerLines(
      selectSpinnerView(store.getState()),
      80,
      THEME,
    )).toHaveLength(1);
  });

  it('inactive 不输出，所有 inline Spinner 行截断到 usable width', () => {
    const store = createSpinnerStore();
    expect(buildSpinnerLines(selectSpinnerView(store.getState()), 20, THEME))
      .toEqual([]);

    store.getState().setContext({
      variant: 'normal', teammates: [], tasks: [],
      spinnerTip: 'x'.repeat(100), hasUsedBtw: true,
      budgetText: null, nextTaskText: null,
    });
    store.getState().start('responding');

    const lines = buildSpinnerLines(
      selectSpinnerView(store.getState()),
      20,
      THEME,
    );

    expect(lines).toHaveLength(2);
    expect(lines.every(line => stringWidth(stripAnsi(line)) <= 19)).toBe(true);
  });
});
