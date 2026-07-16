import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ThinkingIndicator, interpolateColor, toRGBColor } from '../../tui/components/ThinkingIndicator.js';

describe('ThinkingIndicator', () => {
  it('interpolates between two RGB colors', () => {
    const color1 = { r: 153, g: 153, b: 153 };
    const color2 = { r: 185, g: 185, b: 185 };

    const at0 = interpolateColor(color1, color2, 0);
    const at1 = interpolateColor(color1, color2, 1);
    const at05 = interpolateColor(color1, color2, 0.5);

    expect(toRGBColor(at0)).toBe('rgb(153,153,153)');
    expect(toRGBColor(at1)).toBe('rgb(185,185,185)');
    expect(toRGBColor(at05)).toBe('rgb(169,169,169)');
  });

  it('renders thinking text with computed color', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 5000,  // past 3s delay (3000ms)
        thinkStartTime: 0,
        text: 'thinking',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
  });

  it('wraps text in parentheses when showParens is true', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 5000,
        thinkStartTime: 0,
        text: 'thinking',
        showParens: true,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(');
    expect(frame).toContain(')');
    expect(frame).toContain('thinking');
  });

  it('returns null when text is empty', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 5000,
        thinkStartTime: 0,
        text: '',
      })
    );
    expect(lastFrame()).toBe('');
  });

  it('returns null when text is empty even with showParens', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 5000,
        thinkStartTime: 0,
        text: '',
        showParens: true,
      })
    );
    expect(lastFrame()).toBe('');
  });

  it('uses zero elapsed when thinkStartTime is null', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 5000,
        thinkStartTime: null,
        text: 'thinking',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
  });

  it('hides text opacity during initial delay (before 3s)', () => {
    const { lastFrame } = render(
      React.createElement(ThinkingIndicator, {
        storeTime: 30,
        thinkStartTime: 0,
        text: 'thinking',
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
  });
});
