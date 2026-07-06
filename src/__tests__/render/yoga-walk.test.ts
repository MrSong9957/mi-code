// src/__tests__/render/yoga-walk.test.ts
// yoga-walk：遍历 Ink DOM 树（含 yogaNode）调 blit 写入 Screen。

import { describe, it, expect } from 'vitest';
import { renderTree } from '../../render/yoga-walk.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';
import { DEFAULT_STYLE } from '../../render/types.js';

/** 构造一个 mock Ink DOM 节点（最小可用） */
function makeNode(opts: {
  name: 'ink-root' | 'ink-box' | 'ink-text';
  text?: string;
  children?: any[];
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  displayNone?: boolean;
}): any {
  // 用对象字面量模拟 yogaNode（真实 Ink 传的是 yoga-layout 的 YogaNode，API 一致）
  // 注意常量对齐：真实 Yoga 的 Display.None = 1，Display.Flex = 0
  //（见 node_modules/yoga-layout/dist/src/generated/YGEnums.js）
  const y: any = {
    getComputedLeft: () => opts.left ?? 0,
    getComputedTop: () => opts.top ?? 0,
    getComputedWidth: () => opts.width ?? 10,
    getComputedHeight: () => opts.height ?? 1,
    getDisplay: () => (opts.displayNone ? 1 : 0), // 1 = DISPLAY_NONE, 0 = DISPLAY_FLEX
  };
  return {
    nodeName: opts.name,
    yogaNode: y,
    childNodes: opts.children ?? [],
    style: {},
    internal_transform: undefined,
    internal_static: false,
    // ink-text 节点的文本内容（squashTextNodes 会读）
    ...(opts.text !== undefined ? { textValue: opts.text } : {}),
  };
}

function makeScreen(rows: number, cols: number): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

describe('renderTree (yoga-walk)', () => {
  it('单文本节点：写入对应位置', () => {
    const screen = makeScreen(1, 5);
    const root = makeNode({
      name: 'ink-root',
      left: 0, top: 0, width: 5, height: 1,
      children: [makeNode({ name: 'ink-text', text: 'hello' })],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    expect(screen.charPool.get(screen.cellAt(0, 0).charId)).toBe('h');
    expect(screen.charPool.get(screen.cellAt(4, 0).charId)).toBe('o');
  });

  it('display=NONE 节点跳过', () => {
    const screen = makeScreen(1, 5);
    const root = makeNode({
      name: 'ink-root',
      children: [makeNode({ name: 'ink-text', text: 'hi', displayNone: true })],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    expect(screen.cellAt(0, 0).charId).toBe(0); // 未写
  });

  it('box 偏移：子节点坐标加父 offset', () => {
    const screen = makeScreen(2, 10);
    const root = makeNode({
      name: 'ink-root',
      children: [
        makeNode({
          name: 'ink-box',
          left: 2, top: 1,
          children: [makeNode({ name: 'ink-text', text: 'X' })],
        }),
      ],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    expect(screen.charPool.get(screen.cellAt(2, 1).charId)).toBe('X');
  });

  it('递归多层 box', () => {
    const screen = makeScreen(1, 10);
    const root = makeNode({
      name: 'ink-root',
      children: [
        makeNode({
          name: 'ink-box', left: 1, top: 0,
          children: [
            makeNode({
              name: 'ink-box', left: 2, top: 0,
              children: [makeNode({ name: 'ink-text', text: 'Y' })],
            }),
          ],
        }),
      ],
    });
    renderTree(root, screen, DEFAULT_STYLE);
    // 总 offset = 1 + 2 = 3
    expect(screen.charPool.get(screen.cellAt(3, 0).charId)).toBe('Y');
  });
});
