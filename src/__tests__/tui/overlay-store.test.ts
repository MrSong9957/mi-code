// src/__tests__/tui/overlay-store.test.ts
import { describe, it, expect } from 'vitest';
import { createOverlayStore } from '../../tui/state/overlay-store.js';

describe('overlay-store', () => {
  it('初始：visible=false', () => {
    const s = createOverlayStore();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().title).toBe('');
    expect(s.getState().lines).toEqual([]);
  });

  it('open：visible=true，存 title/lines', () => {
    const s = createOverlayStore();
    s.getState().open('Thinking', [{ content: 'hello', style: {}, indent: 0 }]);
    const st = s.getState();
    expect(st.visible).toBe(true);
    expect(st.title).toBe('Thinking');
    expect(st.lines).toHaveLength(1);
  });

  it('close：visible=false，清 lines', () => {
    const s = createOverlayStore();
    s.getState().open('x', [{ content: 'a', style: {}, indent: 0 }]);
    s.getState().close();
    expect(s.getState().visible).toBe(false);
    expect(s.getState().lines).toEqual([]);
  });
});
