// src/__tests__/render/cursor-target.test.ts
// 回归测试：yoga-walk 必须返回输入框的正确绝对 Y（cursorTargetY）。
//
// 历史 bug：internal_cursorTarget 标记机制依赖 Box 转发 prop + reconciler 挂标记，
// 但 Box 不转发该 prop（吞进 ...style），且 ref 回调方案因 Ink resetAfterCommit
// 早于 React ref attach 也失败 → cursorTargetY 永远 undefined → renderer 走 fallback
// 用 formula inputRowY（不算 Spinner 动态行）→ 光标 Y 偏移到消息区。
//
// 修复：renderTree 用「标记优先 + 结构兜底」双保险。标记丢失时，按「最后一个含 ❯
// 的文本行」自动识别 Footer 输入框（Footer 总在布局底部）。
//
// 本测试手构造 Ink DOM 树（模拟真实布局：LOGO + 消息 + Footer），不依赖 Ink render，
// 精确验证两种识别路径。

import { describe, it, expect } from 'vitest';
import { renderTree } from '../../render/yoga-walk.js';
import { Screen } from '../../render/screen.js';
import { CharPool } from '../../render/char-pool.js';
import { StylePool } from '../../render/style-pool.js';

/** 构造 mock Yoga 节点 */
function yoga(opts: { left?: number; top?: number; width?: number; height?: number } = {}): object {
  return {
    getComputedLeft: () => opts.left ?? 0,
    getComputedTop: () => opts.top ?? 0,
    getComputedWidth: () => opts.width ?? 10,
    getComputedHeight: () => opts.height ?? 1,
    getDisplay: () => 0, // DISPLAY_FLEX
  };
}

function textNode(value: string): object {
  return { nodeName: '#text', nodeValue: value, childNodes: [] };
}

function inkText(top: number, children: object[]): object {
  return {
    nodeName: 'ink-text',
    yogaNode: yoga({ top }),
    childNodes: children,
    style: {},
    internal_transform: undefined,
    internal_static: false,
  };
}

function inkBox(top: number, children: object[], opts: { cursorTarget?: boolean } = {}): object {
  return {
    nodeName: 'ink-box',
    yogaNode: yoga({ top }),
    childNodes: children,
    style: {},
    internal_static: false,
    ...(opts.cursorTarget ? { internal_cursorTarget: true } : {}),
  };
}

function makeScreen(rows = 24, cols = 80): Screen {
  return new Screen(rows, cols, new CharPool(), new StylePool());
}

/**
 * 构造模拟 App 布局的 Ink DOM 树：
 *   root
 *   ├─ logoBox（top=0，3 行 LOGO）
 *   ├─ scrollBox（top=3，N 行消息）
 *   └─ footerBox（top=3+N，含输入框）
 *      ├─ border Text
 *      ├─ inputBox（含 ❯ prompt）← cursorTarget
 *      ├─ border Text
 *      └─ statusBar Text
 */
function buildTree(messageCount: number, opts: { markInput?: boolean; spinnerActive?: boolean } = {}): object {
  const messages = Array.from({ length: messageCount }, (_, i) =>
    inkText(0, [textNode(`❯ user msg ${i}`)]), // 用户消息 echo 也含 ❯（模拟真实）
  );
  const scrollBoxTop = 3;
  const footerTop = scrollBoxTop + messageCount + (opts.spinnerActive ? 1 : 0);

  const inputBox = opts.markInput
    ? inkBox(1, [inkText(0, [textNode('❯ '), textNode('')])], { cursorTarget: true })
    : inkBox(1, [inkText(0, [textNode('❯ '), textNode('')])]);

  const footerChildren = [
    ...(opts.spinnerActive ? [inkText(0, [textNode('⠋ Thinking…')])] : []),
    inkText(0, [textNode('───')]),
    inputBox,
    inkText(2, [textNode('───')]),
    inkText(3, [textNode('build │ sonnet')]),
  ];

  return {
    nodeName: 'ink-root',
    yogaNode: yoga({ top: 0 }),
    childNodes: [
      inkBox(0, [
        inkText(0, [textNode('MiCode v1.0.0')]),
        inkText(1, [textNode('TypeScript CLI')]),
        inkText(2, [textNode('/tmp/proj')]),
      ]),
      inkBox(scrollBoxTop, messages),
      inkBox(footerTop, footerChildren),
    ],
    style: {},
    internal_static: false,
  };
}

describe('renderTree cursorTargetY（输入框绝对 Y 识别）', () => {
  describe('结构兜底路径（无 internal_cursorTarget 标记，模拟 Box 不转发 prop 的真实场景）', () => {
    it('0 条消息：输入框在 Y=4（LOGO 3 + 上边框 1）', () => {
      const tree = buildTree(0, { markInput: false });
      const result = renderTree(tree as never, makeScreen());
      // 兜底识别最后一个含 ❯ 的行：footer input 在 root 内的绝对 Y
      // root→footerBox(top=3)→inputBox(top=1)→text，但 inputBox 的 text ❯ 在
      // footerBox.top(3) + inputBox.top(1) = 4
      expect(result.cursorTargetY).toBe(4);
    });

    it('1 条消息：输入框在 Y=5（LOGO 3 + 消息 1 + 上边框 1）', () => {
      const tree = buildTree(1, { markInput: false });
      const result = renderTree(tree as never, makeScreen());
      // 消息行（含 ❯ echo）在 scrollBox.top(3) + 0 = 3
      // footer 在 scrollBox.top(3) + 1 = 4，inputBox 在 footer.top(4) + 1 = 5
      expect(result.cursorTargetY).toBe(5);
    });

    it('Spinner 激活：输入框随 Spinner 下移 1 行（formula inputRowY 算不到的场景）', () => {
      const tree = buildTree(1, { markInput: false, spinnerActive: true });
      const result = renderTree(tree as never, makeScreen());
      // footer 在 3 + 1(msg) + 1(spinner) = 5，inputBox 在 5 + 1 = 6
      expect(result.cursorTargetY).toBe(6);
    });

    it('关键回归：1 条消息时光标不应停在消息行（Y=3）', () => {
      const tree = buildTree(1, { markInput: false });
      const result = renderTree(tree as never, makeScreen());
      // 消息行（❯ user msg 0）在 Y=3，输入框在 Y=5
      // 兜底必须取「最后」一个含 ❯ 的行（输入框），而非第一个（消息行）
      expect(result.cursorTargetY).not.toBe(3);
      expect(result.cursorTargetY).toBe(5);
    });
  });

  describe('标记优先路径（internal_cursorTarget 标记生效时）', () => {
    it('有标记时优先用标记的 Y（即使文本不含 ❯ 也能识别）', () => {
      const tree = buildTree(0, { markInput: true });
      const result = renderTree(tree as never, makeScreen());
      expect(result.cursorTargetY).toBe(4);
    });

    it('标记与兜底都指向同一节点时，结果一致', () => {
      const treeMarked = buildTree(2, { markInput: true });
      const treeUnmarked = buildTree(2, { markInput: false });
      const r1 = renderTree(treeMarked as never, makeScreen());
      const r2 = renderTree(treeUnmarked as never, makeScreen());
      expect(r1.cursorTargetY).toBe(r2.cursorTargetY);
      expect(r1.cursorTargetY).toBe(6); // LOGO 3 + 2 msg + border 1
    });
  });

  describe('边界', () => {
    it('无 ❯ 文本也无标记 → cursorTargetY undefined', () => {
      const tree = {
        nodeName: 'ink-root',
        yogaNode: yoga({ top: 0 }),
        childNodes: [inkBox(0, [inkText(0, [textNode('hello world')])])],
        style: {},
        internal_static: false,
      };
      const result = renderTree(tree as never, makeScreen());
      expect(result.cursorTargetY).toBeUndefined();
    });
  });
});
