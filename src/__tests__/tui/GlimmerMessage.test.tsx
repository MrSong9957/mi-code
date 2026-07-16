import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { GlimmerMessage } from '../../tui/components/GlimmerMessage.js';

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
    const stripped = frame.replace(/\x1b\[[0-9;]*m/g, '');
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
    const stripped = frame.replace(/\x1b\[[0-9;]*m/g, '');
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
});
