import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { DotsCycle } from '../../tui/components/DotsCycle.js';

describe('DotsCycle', () => {
  it('cycles through ., .., ... every 300ms', () => {
    const { lastFrame, rerender } = render(
      React.createElement(DotsCycle, { time: 0, color: 'rgb(110,110,120)' })
    );
    expect(lastFrame()).toContain('.  ');

    rerender(React.createElement(DotsCycle, { time: 300, color: 'rgb(110,110,120)' }));
    expect(lastFrame()).toContain('.. ');

    rerender(React.createElement(DotsCycle, { time: 600, color: 'rgb(110,110,120)' }));
    expect(lastFrame()).toContain('...');
  });
});
