// src/__tests__/tui/select-store.test.ts
// SelectStore 单元测试:通用交互式选择器 store

import { describe, it, expect } from 'vitest';
import { createSelectStore } from '../../tui/state/select-store.js';
import type { SelectOption } from '../../tui/state/select-store.js';

const OPTS: SelectOption[] = [
  { value: 'sonnet', label: 'Claude Sonnet 4', description: 'Balanced' },
  { value: 'opus', label: 'Claude Opus 4', description: 'Most intelligent' },
  { value: 'haiku', label: 'Claude Haiku 4.5', description: 'Fastest' },
];

describe('select-store', () => {
  it('初始:visible=false, options=[], index=0', () => {
    const store = createSelectStore();
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.options).toEqual([]);
    expect(s.index).toBe(0);
    expect(s.title).toBe('');
  });

  it('open:设置 title + options, visible=true, index=0', () => {
    const store = createSelectStore();
    store.getState().open('Select model', OPTS);
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.title).toBe('Select model');
    expect(s.options).toEqual(OPTS);
    expect(s.index).toBe(0);
  });

  it('close:visible=false, 清空 options/title', () => {
    const store = createSelectStore();
    store.getState().open('Select model', OPTS);
    store.getState().close();
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.options).toEqual([]);
    expect(s.title).toBe('');
  });

  it('cycle:向下循环', () => {
    const store = createSelectStore();
    store.getState().open('T', OPTS);
    expect(store.getState().index).toBe(0);
    store.getState().cycle();
    expect(store.getState().index).toBe(1);
    store.getState().cycle();
    expect(store.getState().index).toBe(2);
    store.getState().cycle();
    expect(store.getState().index).toBe(0); // wrap
  });

  it('cyclePrev:向上循环', () => {
    const store = createSelectStore();
    store.getState().open('T', OPTS);
    store.getState().cyclePrev();
    expect(store.getState().index).toBe(2); // wrap to last
    store.getState().cyclePrev();
    expect(store.getState().index).toBe(1);
  });

  it('selected:返回当前选项', () => {
    const store = createSelectStore();
    store.getState().open('T', OPTS);
    expect(store.getState().selected()).toEqual(OPTS[0]);
    store.getState().cycle();
    expect(store.getState().selected()).toEqual(OPTS[1]);
  });

  it('selected:无选项返回 null', () => {
    const store = createSelectStore();
    expect(store.getState().selected()).toBeNull();
  });

  it('cycle/cyclePrev 在 options 为空时不崩', () => {
    const store = createSelectStore();
    store.getState().cycle();
    expect(store.getState().index).toBe(0);
    store.getState().cyclePrev();
    expect(store.getState().index).toBe(0);
  });
});
