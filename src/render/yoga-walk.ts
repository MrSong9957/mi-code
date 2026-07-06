// src/render/yoga-walk.ts
// 遍历 Ink DOM 树（已 Yoga 布局），把文本节点 blit 到 Screen。
// 借鉴 node_modules/ink/build/render-node-to-output.js 的遍历结构，
// 但目标是 Screen（Int32Array）而非 Ink 的 Output（对象网格）。
//
// Ink DOM 节点字段：
// - nodeName: 'ink-root' | 'ink-box' | 'ink-text'
// - yogaNode: Yoga 节点（getComputedLeft/Top/Width/Height/getDisplay）
// - childNodes: 子节点数组
// - style: { flexDirection, overflow, overflowX, overflowY, textWrap, ... }
// - internal_transform: 可选 transformer 函数（项目未用，先忽略）
// - internal_static: 是否 <Static> 子树
//
// 简化范围（与项目实际用法对齐）：
// - 不处理 overflow clip（项目 ScrollBox 用 visibleRows 裁剪消息，不靠 overflow:hidden）
// - 不处理 border/background（项目用 ASCII 字符画边框，不是 Yoga border）
// - 不处理 internal_transform（项目无 <Transform> 用法，grep 确认）
// - 不处理 <Static>（项目未用）
// - 样式用 inheritedStyle（简化，Task 13 冒烟后补 node.style 解析）

import Yoga from 'yoga-layout';
import type { Screen } from './screen.js';
import type { Style } from './types.js';
import { blit } from './output-ops.js';

/** Ink DOM 节点的最小类型（避免依赖 Ink 内部类型） */
interface InkNode {
  nodeName: string;
  yogaNode?: {
    getComputedLeft(): number;
    getComputedTop(): number;
    getComputedWidth(): number;
    getComputedHeight(): number;
    getDisplay(): number;
  };
  childNodes?: InkNode[];
  style?: Record<string, unknown>;
  internal_static?: boolean;
  // ink-text 节点的文本（squashTextNodes 的简化读取）
  textValue?: string;
  // 真实 Ink：childNodes 里可能有字符串字面量子节点
}

/** 把 Ink 文本节点的子节点（字符串数组）squash 成单个字符串 */
function squashTextNodes(node: InkNode): string {
  if (typeof node.textValue === 'string') return node.textValue;
  // 真实 Ink：childNodes 是字符串或文本节点
  if (!node.childNodes) return '';
  return node.childNodes
    .map(c => (typeof c === 'string' ? c : (c as InkNode).textValue ?? ''))
    .join('');
}

/**
 * 渲染 Ink DOM 树到 Screen。
 * @param root Ink 根节点（已 Yoga 布局）
 * @param screen 目标 Screen（back buffer）
 * @param baseStyle 继承的样式（项目用 <Text> 自己的 style，这里作为 fallback）
 */
export function renderTree(root: InkNode, screen: Screen, baseStyle: Style): void {
  walk(root, screen, 0, 0, baseStyle);
}

function walk(node: InkNode, screen: Screen, offsetX: number, offsetY: number, inheritedStyle: Style): void {
  if (node.internal_static) return; // 跳过 <Static>（spec §5.4）

  const yoga = node.yogaNode;
  if (!yoga) return;
  if (yoga.getDisplay() === Yoga.DISPLAY_NONE) return;

  const x = offsetX + yoga.getComputedLeft();
  const y = offsetY + yoga.getComputedTop();

  if (node.nodeName === 'ink-text') {
    const text = squashTextNodes(node);
    if (text.length > 0) {
      blit(screen, x, y, text, inheritedStyle);
    }
    return;
  }

  if (node.nodeName === 'ink-box' || node.nodeName === 'ink-root') {
    // 真实 Ink 会从 node.style 读 <Text> 的 color/bold 等，构造 Style；
    // 这里简化：用 inheritedStyle（项目里 <Text> 样式由 Ink 算，我们暂用继承）。
    // TODO Task 13 冒烟后：从 node.style 解析 color/bold/etc. → Style
    const childStyle = inheritedStyle;
    if (node.childNodes) {
      for (const child of node.childNodes) {
        walk(child, screen, x, y, childStyle);
      }
    }
  }
}
