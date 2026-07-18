import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { GlimmerMessage } from '../../tui/components/GlimmerMessage.js';

function stripAnsi(value: string): string {
  return value.split('\x1b[').map((part, index) => {
    if (index === 0) return part;
    const terminator = part.indexOf('m');
    return terminator >= 0 ? part.slice(terminator + 1) : part;
  }).join('');
}

describe('GlimmerMessage', () => {
  it('renders three text segments with correct colors', () => {
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: 'Generating',
        glimmerIndex: 5,
        baseColor: 'rgb(100, 200, 240)',
        shimmerColor: 'rgb(170, 230, 255)',
      })
    );
    const frame = lastFrame() ?? '';
    // Strip ANSI codes to verify text content
    const stripped = stripAnsi(frame);
    expect(stripped).toBe('Generating');
    // baseColor ANSI code should appear for before/after segments
    expect(frame).toContain('\x1b[38;2;100;200;240m');
    // shimmerColor ANSI code should appear for the shimmer segment
    expect(frame).toContain('\x1b[38;2;170;230;255m');
  });

  it('splits shimmer segment at mid-string glimmerIndex', () => {
    // "HelloWorld" (10 chars), glimmerIndex=5 → highlight columns {4,5,6}
    // Expected: before="Hell", shimmer="oWo", after="rld"
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: 'HelloWorld',
        glimmerIndex: 5,
        baseColor: 'rgb(100, 200, 240)',
        shimmerColor: 'rgb(170, 230, 255)',
      })
    );
    const frame = lastFrame() ?? '';
    // Strip ANSI codes to verify text content
    const stripped = stripAnsi(frame);
    expect(stripped).toBe('HelloWorld');
    // shimmerColor applied to the mid-string shimmer segment
    expect(frame).toContain('\x1b[38;2;170;230;255m');
    // baseColor applied to before and after segments
    expect(frame).toContain('\x1b[38;2;100;200;240m');
  });

  it('renders empty message as nothing', () => {
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: '',
        glimmerIndex: 5,
        baseColor: 'rgb(100, 200, 240)',
        shimmerColor: 'rgb(170, 230, 255)',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toBe('');
  });

  it('tool-use 使用单一插值色渲染整段文本', () => {
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: 'Running tool',
        glimmerIndex: 5,
        baseColor: 'rgb(100, 200, 240)',
        shimmerColor: 'rgb(170, 230, 255)',
        flashOpacity: 1,
      })
    );
    const frame = lastFrame() ?? '';
    expect(stripAnsi(frame)).toBe('Running tool');
    expect(frame).toContain('\x1b[38;2;170;230;255m');
    expect(frame).not.toContain('\x1b[38;2;100;200;240m');
  });

  it('按 stalledIntensity 将基础色和 shimmer 色平滑插值到错误红', () => {
    const { lastFrame } = render(
      React.createElement(GlimmerMessage, {
        message: 'Working',
        glimmerIndex: 3,
        baseColor: 'rgb(100,200,240)',
        shimmerColor: 'rgb(170,230,255)',
        stalledIntensity: 0.5,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('\x1b[38;2;136;122;152m');
    expect(frame).toContain('\x1b[38;2;171;137;159m');
    expect(frame).not.toContain('\x1b[38;2;255;90;90m');
  });
});
