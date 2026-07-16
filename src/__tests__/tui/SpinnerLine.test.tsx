import { describe, it, expect } from 'vitest';
import { buildSpinnerLine } from '../../tui/inline/SpinnerLine.js';

describe('SpinnerLine (inline mode)', () => {
  it('builds ANSI string with shimmer segments', () => {
    const result = buildSpinnerLine({
      time: 1000,
      mode: 'generating',
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
    expect(result).toMatch(/\x1b\[/);
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

  it('uses stalled theme color when stalled is true', () => {
    const result = buildSpinnerLine({
      time: 1000,
      mode: 'generating',
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
    expect(result).toContain('\x1b[38;2;255;90;90m');
    expect(result).not.toContain('\x1b[38;2;100;200;240m');
  });

  it('cycles dots animation through 1-3 dots', () => {
    const make = (time: number) => buildSpinnerLine({
      time,
      mode: 'generating',
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
    const r0 = make(0);
    expect(r0).toContain('.');

    const r300 = make(300);
    expect(r300).toContain('..');

    const r600 = make(600);
    expect(r600).toContain('...');
  });

  it('falls back to verb when label is empty', () => {
    const result = buildSpinnerLine({
      time: 100,
      mode: 'tool',
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
      mode: 'tool',
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
});
