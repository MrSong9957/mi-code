// src/render/yoga-walk.ts
// 遍历 Ink DOM 树（已 Yoga 布局），把文本节点 blit 到 Screen。
// 借鉴 node_modules/ink/build/render-node-to-output.js 的遍历结构，
// 但目标是 Screen（Int32Array）而非 Ink 的 Output（对象网格）。
//
// Real Ink DOM 节点字段（已验证 node_modules/ink/build/）：
// - nodeName: 'ink-root' | 'ink-box' | 'ink-text' | 'ink-virtual-text' | '#text'
// - yogaNode: Yoga 节点（getComputedLeft/Top/Width/Height/getDisplay）
// - childNodes: 子节点数组（#text 节点没有此字段）
// - nodeValue: 仅 #text 节点有（DOM spec）；内容是 ANSI 嵌入的字符串
//   （Ink 的 <Text> 在 render 前用 chalk 包色 → 色码进 nodeValue）
// - internal_transform: 可选 transformer 函数（squashTextNodes 时应用）
// - internal_static: 是否 <Static> 子树
//
// 关键修正（Task 9 bug）：旧版读不存在的 textValue 字段 → 全屏空白。
// 现按 Ink 的 squash-text-nodes.js 算法递归 #text/ink-virtual-text 提取文本，
// 再用 blitAnsi 解析嵌入的 ANSI 重建每字符 Style。

import Yoga from 'yoga-layout';
import type { Screen } from './screen.js';
import { blitAnsi } from './output-ops.js';

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
  /** #text 节点的文本（ANSI 嵌入） */
  nodeValue?: string;
  /** 可选 transformer（squashTextNodes 时对每个文本子节点应用） */
  internal_transform?: (text: string, index: number) => string;
  internal_static?: boolean;
  /** Footer 输入行标记（patch reconciler 挂到 node）——yoga-walk 读它的绝对坐标定位光标 */
  internal_cursorTarget?: boolean;
}

/**
 * 把 Ink 文本节点（ink-text/ink-virtual-text）的子节点 squash 成单个字符串。
 * 镜像 node_modules/ink/build/squash-text-nodes.js 的算法：
 * - #text → 取 nodeValue
 * - ink-text / ink-virtual-text → 递归 squashTextNodes
 * - 对每个非 #text 子节点，若有 internal_transform 则应用
 * 注意：这里返回的是「ANSI 嵌入的原始串」，样式解析交给 blitAnsi。
 */
function squashTextNodes(node: InkNode): string {
  let text = '';
  const childNodes = node.childNodes;
  if (!childNodes) return text;
  for (let index = 0; index < childNodes.length; index++) {
    const childNode = childNodes[index];
    if (!childNode) continue;
    let nodeText = '';
    if (childNode.nodeName === '#text') {
      nodeText = childNode.nodeValue ?? '';
    } else if (childNode.nodeName === 'ink-text' || childNode.nodeName === 'ink-virtual-text') {
      nodeText = squashTextNodes(childNode);
      // squash 串联后 Output 无法逐子节点 transform，需在此手动应用
      if (nodeText.length > 0 && typeof childNode.internal_transform === 'function') {
        nodeText = childNode.internal_transform(nodeText, index);
      }
    }
    text += nodeText;
  }
  return text;
}

/** renderTree 返回值：光标目标节点的绝对 y 坐标（输入框行） */
export interface RenderResult {
  /** 输入框行（internal_cursorTarget 节点）的绝对 y；未找到则 undefined */
  cursorTargetY?: number;
}

/**
 * 渲染 Ink DOM 树到 Screen，返回光标目标节点的坐标（如有）。
 * @param root Ink 根节点（已 Yoga 布局）
 * @param screen 目标 Screen（back buffer）
 */
export function renderTree(root: InkNode, screen: Screen): RenderResult {
  let cursorTargetY: number | undefined;
  walk(root, screen, 0, 0, (y) => { cursorTargetY = y; });
  return cursorTargetY === undefined ? {} : { cursorTargetY };
}

/** 累计坐标偏移递归写 cell。样式不继承——文本样式由 ANSI 嵌入文本本身携带。 */
function walk(
  node: InkNode,
  screen: Screen,
  offsetX: number,
  offsetY: number,
  onCursorTarget: (y: number) => void,
): void {
  if (node.internal_static) return; // 跳过 <Static>（spec §5.4）

  const yoga = node.yogaNode;
  if (!yoga) return;
  if (yoga.getDisplay() === Yoga.DISPLAY_NONE) return;

  const x = offsetX + yoga.getComputedLeft();
  const y = offsetY + yoga.getComputedTop();

  // Footer 输入行标记：记录绝对 y（光标定位用，解决 inputRowY 不算动态行数的问题）
  if (node.internal_cursorTarget) {
    onCursorTarget(y);
  }

  if (node.nodeName === 'ink-text') {
    // squash 出 ANSI 嵌入的整段文本，blitAnsi 逐字符重建样式
    const text = squashTextNodes(node);
    if (text.length > 0) {
      blitAnsi(screen, x, y, text);
    }
    return;
  }

  if (node.nodeName === 'ink-box' || node.nodeName === 'ink-root') {
    const childNodes = node.childNodes;
    if (childNodes) {
      for (const child of childNodes) {
        walk(child, screen, x, y, onCursorTarget);
      }
    }
  }
  // 其它 nodeName（ink-virtual-text 作为文本子节点已在 squashTextNodes 里处理，
  // 不应直接出现在 walk 路径上；'#text' 无 yogaNode，前面已 return）
}
