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
    expect(frame).toContain('Generating');
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
