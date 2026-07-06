// src/__tests__/tui/overlay-component.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Overlay } from '../../tui/components/Overlay.js';
import { createOverlayStore } from '../../tui/state/overlay-store.js';

describe('Overlay 组件', () => {
  it('invisible：渲染空', () => {
    const store = createOverlayStore();
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 80 }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('visible：渲染 title + 内容 + 提示', () => {
    const store = createOverlayStore();
    store.getState().open('Thinking', [
      { content: 'step 1', style: {}, indent: 0 },
      { content: 'step 2', style: {}, indent: 0 },
    ]);
    const { lastFrame } = render(React.createElement(Overlay, { store, cols: 80 }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Thinking');
    expect(frame).toContain('step 1');
    expect(frame).toContain('step 2');
    expect(frame).toContain('返回');
  });
});
