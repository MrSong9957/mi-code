// src/__tests__/render/yoga-walk.test.ts
// yoga-walk：遍历 Ink DOM 树（真实形状：#text/nodeValue/ANSI）调 blitAnsi 写入 Screen。

import { describe, it, expect } from 'vitest';
import { renderTree } from '../../render/yoga-walk.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE, decodeStyleId } from '../../render/types.js';

/** 构造一个 mock Yoga 节点（最小可用） */
function yoga(opts: {
  left?: number; top?: number; width?: number; height?: number; displayNone?: boolean;
}): any {
  return {
    getComputedLeft: () => opts.left ?? 0,
    getComputedTop: () => opts.top ?? 0,
    getComputedWidth: () => opts.width ?? 10,
    getComputedHeight: () => opts.height ?? 1,
    getDisplay: () => (opts.displayNone ? 1 : 0), // 1 = DISPLAY_NONE, 0 = DISPLAY_FLEX
  };
}

/** 真实 Ink DOM 的 #text 节点：nodeValue 是 ANSI 嵌入的字符串 */
function textNode(value: string): any {
  return { nodeName: '#text', nodeValue: value, childNodes: [] };
}

/** ink-text 节点：子节点是 #text 或嵌套 ink-text/ink-virtual-text */
function inkTextNode(children: any[], opts: { left?: number; top?: number; displayNone?: boolean; internal_transform?: ((s: string, i: number) => string) | undefined } = {}): any {
  return {
    nodeName: 'ink-text',
    yogaNode: yoga(opts),
    childNodes: children,
    style: {},
    internal_transform: opts.internal_transform,
    internal_static: false,
  };
}

/** ink-virtual-text 节点（无布局样式，但参与 squash 递归） */
function virtualTextNode(children: any[], opts: { left?: number; top?: number; displayNone?: boolean } = {}): any {
  return {
    nodeName: 'ink-virtual-text',
    yogaNode: yoga(opts),
    childNodes: children,
    style: {},
    internal_transform: undefined,
    internal_static: false,
  };
}

/** ink-box / ink-root 节点 */
function boxNode(children: any[], opts: { name?: 'ink-root' | 'ink-box'; left?: number; top?: number; width?: number; height?: number; displayNone?: boolean } = {}): any {
  return {
    nodeName: opts.name ?? 'ink-box',
    yogaNode: yoga(opts),
    childNodes: children,
    style: {},
    internal_static: false,
  };
}

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('renderTree (yoga-walk)', () => {
  it('<ink-text><#text>hello</#text></ink-text>：写入对应位置', () => {
    const screen = makeScreen(1, 5);
    const root = boxNode(
      [inkTextNode([textNode('hello')])],
      { name: 'ink-root', width: 5 },
    );
    renderTree(root, screen);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('h');
    expect(screen.charPool.get(screen.cellAt(4, 0).charId)).toBe('o');
  });

  it('display=NONE 节点跳过', () => {
    const screen = makeScreen(1, 5);
    const root = boxNode(
      [inkTextNode([textNode('hi')], { displayNone: true })],
      { name: 'ink-root' },
    );
    renderTree(root, screen);
    expect(screen.cellAt(0, 0).charId).toBe(0); // 未写
  });

  it('box 偏移：子节点坐标加父 offset', () => {
    const screen = makeScreen(2, 10);
    const root = boxNode(
      [boxNode([inkTextNode([textNode('X')])], { left: 2, top: 1 })],
      { name: 'ink-root' },
    );
    renderTree(root, screen);
    expect(screen.charPool.get(screen.cellAt(2, 1).charId)).toBe('X');
  });

  it('递归多层 box', () => {
    const screen = makeScreen(1, 10);
    const root = boxNode(
      [boxNode([boxNode([inkTextNode([textNode('Y')])], { left: 2 })], { left: 1 })],
      { name: 'ink-root' },
    );
    renderTree(root, screen);
    // 总 offset = 1 + 2 = 3
    expect(screen.charPool.get(screen.cellAt(3, 0).charId)).toBe('Y');
  });

  it('多 #text 子节点 squash 成单串（<Text>hello{" "}world</Text>）', () => {
    const screen = makeScreen(1, 11);
    const root = boxNode(
      [inkTextNode([textNode('hello'), textNode(' '), textNode('world')])],
      { name: 'ink-root', width: 11 },
    );
    renderTree(root, screen);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('h');
    expect(screen.charPool.get(screen.cellAt(5, 0).charId)).toBe(' ');
    expect(screen.charPool.get(screen.cellAt(6, 0).charId)).toBe('w');
    expect(screen.charPool.get(screen.cellAt(10, 0).charId)).toBe('d');
  });

  it('嵌套 ink-virtual-text：<ink-text><ink-virtual-text><#text>x</#text></ink-virtual-text></ink-text>', () => {
    const screen = makeScreen(1, 5);
    const root = boxNode(
      [inkTextNode([virtualTextNode([textNode('x')])])],
      { name: 'ink-root' },
    );
    renderTree(root, screen);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('x');
  });

  it('ANSI 嵌入文本：<Text color=red>hello</Text> → 带红色样式渲染', () => {
    // chalk.hex('#ff0000') 产出 \x1b[38;2;255;0;0m...\x1b[39m
    const screen = makeScreen(1, 5);
    const root = boxNode(
      [inkTextNode([textNode('\x1b[38;2;255;0;0mhello\x1b[39m')])],
      { name: 'ink-root', width: 5 },
    );
    renderTree(root, screen);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('h');
    const style = screen.stylePool.get(decodeStyleId(screen.cellAt(0, 0).encodedStyleId));
    expect(style.fg).toBe(0xFF0000);
  });

  it('ANSI bold：<Text bold>x</Text> → bold 样式', () => {
    const screen = makeScreen(1, 1);
    const root = boxNode(
      [inkTextNode([textNode('\x1b[1mb\x1b[22m')])],
      { name: 'ink-root', width: 1 },
    );
    renderTree(root, screen);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('b');
    const style = screen.stylePool.get(decodeStyleId(screen.cellAt(0, 0).encodedStyleId));
    expect(style.bold).toBe(true);
  });

  it('空 ink-text（无子节点）：无副作用，不抛错', () => {
    const screen = makeScreen(1, 5);
    const root = boxNode([inkTextNode([])], { name: 'ink-root' });
    expect(() => renderTree(root, screen)).not.toThrow();
    expect(screen.cellAt(0, 0).charId).toBe(0);
  });
});
