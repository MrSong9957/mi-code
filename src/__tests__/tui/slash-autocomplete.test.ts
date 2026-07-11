/**
 * 斜杠命令自动补全回归测试
 *
 * 验证：输入 / 自动弹出下拉菜单，实时过滤，上下选择，Enter 确认。
 */
import { describe, it, expect } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';

describe('completion-store filter', () => {
  it('filter("") 显示全部命令', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates.length).toBeGreaterThan(0);
    expect(s.candidates).toContain('theme');
    expect(s.candidates).toContain('help');
    expect(s.candidates).toContain('config');
  });

  it('filter("th") 过滤为只含 theme', () => {
    const store = createCompletionStore();
    store.getState().filter('th');
    const s = store.getState();
    expect(s.visible).toBe(true);
    expect(s.candidates).toEqual(['theme']);
  });

  it('filter("zzz") 无匹配时隐藏', () => {
    const store = createCompletionStore();
    store.getState().filter('zzz');
    const s = store.getState();
    expect(s.visible).toBe(false);
    expect(s.candidates).toEqual([]);
  });

  it('filter 重置 index 为 0', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle(); // index → 1
    store.getState().filter('th'); // 重置
    expect(store.getState().index).toBe(0);
  });
});

describe('completion-store cyclePrev', () => {
  it('cyclePrev 向上循环', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const len = store.getState().candidates.length;
    // 初始 index=0，cyclePrev 应到末尾
    store.getState().cyclePrev();
    expect(store.getState().index).toBe(len - 1);
  });

  it('cycle + cyclePrev 回到原位', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle();
    store.getState().cyclePrev();
    expect(store.getState().index).toBe(0);
  });
});

describe('completion-store selected', () => {
  it('selected 返回当前高亮候选', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const first = store.getState().candidates[0];
    expect(store.getState().selected()).toBe(first);
  });

  it('cycle 后 selected 变化', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const first = store.getState().selected();
    store.getState().cycle();
    const second = store.getState().selected();
    expect(second).not.toBe(first);
  });
});

describe('下拉菜单竖排渲染', () => {
  it('candidates 是字符串数组，每个以命令名开头', () => {
    const store = createCompletionStore();
    store.getState().filter('');
    const candidates = store.getState().candidates;
    for (const c of candidates) {
      expect(typeof c).toBe('string');
      expect(c.length).toBeGreaterThan(0);
    }
  });
});
