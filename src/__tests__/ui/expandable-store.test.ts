// src/__tests__/ui/expandable-store.test.ts
// 可折叠块存储测试

import { describe, it, expect } from 'vitest';
import { ExpandableBlockStore } from '../../ui/expandable-store.js';
import { BLOCK_STYLES } from '../../ui/block-format.js';
import type { FormattedLine } from '../../ui/types.js';

function line(text: string): FormattedLine {
  return { content: text, style: BLOCK_STYLES.dim, indent: 2 };
}

describe('ExpandableBlockStore', () => {
  it('add 注册块，初始 expanded=false', () => {
    const store = new ExpandableBlockStore();
    store.add({
      id: 'thinking-1',
      kind: 'thinking',
      summaryLines: [line('Thought for 3s (ctrl+o to expand)')],
      fullLines: [line('完整思考内容第一行'), line('完整思考内容第二行')],
    });
    expect(store.lastExpanded()).toBe(false);
    expect(store.count()).toBe(1);
  });

  it('toggleLast 切换最后一个块的 expanded，返回 true（有变化）', () => {
    const store = new ExpandableBlockStore();
    store.add({
      id: 'thinking-1', kind: 'thinking',
      summaryLines: [line('Thought for 3s')],
      fullLines: [line('完整思考')],
    });
    expect(store.toggleLast()).toBe(true);  // false→true，有变化
    expect(store.lastExpanded()).toBe(true);
    expect(store.toggleLast()).toBe(true);  // true→false，有变化
    expect(store.lastExpanded()).toBe(false);
  });

  it('多个块时 toggleLast 只切最后一个', () => {
    const store = new ExpandableBlockStore();
    store.add({ id: 'thinking-1', kind: 'thinking', summaryLines: [line('s1')], fullLines: [line('f1')] });
    store.add({ id: 'tool-1', kind: 'tool_result', summaryLines: [line('s2')], fullLines: [line('f2')] });
    store.toggleLast();
    // 只有最后一个（tool-1）被切换
    expect(store.isExpanded('tool-1')).toBe(true);
    expect(store.isExpanded('thinking-1')).toBe(false);
  });

  it('空 store 时 toggleLast 返回 false（无变化）', () => {
    const store = new ExpandableBlockStore();
    expect(store.toggleLast()).toBe(false);
    expect(store.lastExpanded()).toBe(false);
  });

  it('isExpanded 按 id 查询', () => {
    const store = new ExpandableBlockStore();
    store.add({ id: 't1', kind: 'thinking', summaryLines: [line('s')], fullLines: [line('f')] });
    expect(store.isExpanded('t1')).toBe(false);
    expect(store.isExpanded('nonexistent')).toBe(false);
    store.toggleLast();
    expect(store.isExpanded('t1')).toBe(true);
  });

  it('getLines 按 expanded 返回 summary 或 full', () => {
    const store = new ExpandableBlockStore();
    store.add({
      id: 't1', kind: 'thinking',
      summaryLines: [line('摘要')],
      fullLines: [line('完整1'), line('完整2')],
    });
    // 折叠态：返回 summary
    expect(store.getLines('t1').map(l => l.content)).toEqual(['摘要']);
    // 展开后：返回 full
    store.toggleLast();
    expect(store.getLines('t1').map(l => l.content)).toEqual(['完整1', '完整2']);
  });

  it('clear 清空所有块', () => {
    const store = new ExpandableBlockStore();
    store.add({ id: 't1', kind: 'thinking', summaryLines: [line('s')], fullLines: [line('f')] });
    store.clear();
    expect(store.count()).toBe(0);
    expect(store.toggleLast()).toBe(false);
  });

  it('lastId 返回最后一个块的 id', () => {
    const store = new ExpandableBlockStore();
    expect(store.lastId()).toBeUndefined();
    store.add({ id: 't1', kind: 'thinking', summaryLines: [line('s')], fullLines: [line('f')] });
    expect(store.lastId()).toBe('t1');
    store.add({ id: 't2', kind: 'tool_result', summaryLines: [line('s')], fullLines: [line('f')] });
    expect(store.lastId()).toBe('t2');
  });
});
