// src/tui/inline/shimmer.ts
// shimmer 光效纯函数（动画三）
//
// 对标 Claude Code SpinnerAnimationRow.tsx:136-138（computeGlimmerIndex 内联）+
// GlimmerMessage.tsx（computeShimmerSegments 渲染逻辑）。
//
// 物理本质：高亮段（3 显示列宽）在文字上从右→左扫描，产生"光带掠过"效果。
// 文字铺在列 [0, width) 上，每个 CJK 全角字符占 2 列。高亮段是连续 3 列
// {glimmerIndex-1, glimmerIndex, glimmerIndex+1}（中心 glimmerIndex）。
// 扫出文字边界后留 10 列缓冲（全暗停顿），再从另一侧重新进入。
//
// CJK 安全：判断字符是否高亮，看它占的列区间与高亮列集合是否有交集——
// 只要字符的任一列落在高亮段内，整字符进 shimmer 段（不拆半字）。

import stringWidth from 'string-width';
import {
  formatSpinnerColor,
  interpolateSpinnerColor,
  parseSpinnerColor,
} from '../state/spinner-glyph.js';

let graphemeSegmenter: Intl.Segmenter | undefined;

export function getGraphemeSegmenter(): Intl.Segmenter {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return graphemeSegmenter;
}

export interface GraphemeSegment {
  text: string;
  width: number;
}

/** 按字素簇分割并预计算终端显示宽度。 */
export function getGraphemeSegments(message: string): GraphemeSegment[] {
  return Array.from(getGraphemeSegmenter().segment(message), ({ segment }) => ({
    text: segment,
    width: stringWidth(segment),
  }));
}

export function measureShimmerMessage(message: string): number {
  return getGraphemeSegments(message).reduce((total, segment) => total + segment.width, 0);
}

export function toolUseFlashOpacity(time: number): number {
  return (Math.sin((time / 1_000) * Math.PI) + 1) / 2;
}

export function interpolateShimmerColor(
  messageColor: string,
  shimmerColor: string,
  opacity: number,
): string {
  const message = parseSpinnerColor(messageColor);
  const shimmer = parseSpinnerColor(shimmerColor);
  if (!message || !shimmer) return messageColor;
  return formatSpinnerColor(interpolateSpinnerColor(message, shimmer, opacity));
}

export function toolUseFlashColor(
  time: number,
  messageColor: string,
  shimmerColor: string,
): string {
  return interpolateShimmerColor(messageColor, shimmerColor, toolUseFlashOpacity(time));
}

export interface GlimmerOpts {
  /** shimmer 步进速度（ms/步）。生成中/thinking = 200，requesting = 50 */
  speed: number;
  /** 单侧缓冲列数（文字外的全暗停顿宽度）。Claude Code = 10 */
  cyclePad: number;
  /** 卡住时停用 shimmer */
  stalled: boolean;
  /** 扫描方向；默认保持生成/工具模式的右→左。 */
  direction?: 'left-to-right' | 'right-to-left';
}

/**
 * 算高亮段中心列位置。
 *
 * 生成中/thinking 模式：glimmerIndex = width + pad - floor(time/speed) % cycleLength
 * 从 width+pad（文字右侧 pad 列外）开始，随 time 递增向左移动。
 * cycleLength = width + 2*pad（双侧缓冲），到达 -pad 后循环回 width+pad。
 *
 * @returns 高亮段中心列。stalled 时返回 -100（渲染时整体降级为 before）。
 */
export function computeGlimmerIndex(
  time: number,
  messageWidth: number,
  opts: GlimmerOpts,
): number {
  if (opts.stalled) return -100;
  const cycleLength = messageWidth + opts.cyclePad * 2;
  const pos = Math.floor(time / opts.speed) % cycleLength;
  return opts.direction === 'left-to-right'
    ? -opts.cyclePad + pos
    : messageWidth + opts.cyclePad - pos;
}

/**
 * 高亮段覆盖的列集合：{glimmerIndex-1, glimmerIndex, glimmerIndex+1}。
 * 渲染时一个字符是否进 shimmer 段，取决于它占的列与此集合是否有交集。
 */
function highlightColumns(glimmerIndex: number): Set<number> {
  return new Set([glimmerIndex - 1, glimmerIndex, glimmerIndex + 1]);
}

/**
 * 把 message 切成 before/shimmer/after 三段（按显示宽度切，CJK 安全）。
 *
 * 规则：逐字符累计显示宽度。每个字符占列区间 [colStart, colStart+w)。
 * 若该区间与高亮列集合有交集 → 进 shimmer 段；否则根据当前列位置进 before 或 after。
 *
 * 三段拼接还原原 message（内容不丢不重）。
 * 高亮段完全在文字外（glimmerIndex=-100 或全列越界）→ 全 before。
 */
export function computeShimmerSegments(
  message: string,
  glimmerIndex: number,
): { before: string; shimmer: string; after: string } {
  if (message === '') return { before: '', shimmer: '', after: '' };

  const hl = highlightColumns(glimmerIndex);
  const graphemes = getGraphemeSegments(message);
  const width = graphemes.reduce((total, grapheme) => total + grapheme.width, 0);

  // 高亮段完全在文字外：全 before
  // glimmerIndex+1 < 0（高亮段全在左侧外）或 glimmerIndex-1 >= width（全在右侧外）
  if (glimmerIndex + 1 < 0 || glimmerIndex - 1 >= width) {
    return { before: message, shimmer: '', after: '' };
  }

  let before = '';
  let shimmer = '';
  let after = '';
  let col = 0;
  let phase: 'before' | 'shimmer' | 'after' = 'before';

  for (const grapheme of graphemes) {
    const { text, width: w } = grapheme;
    // 此字符占列区间 [col, col+w)，与高亮列集合求交集
    let touches = false;
    for (let c = col; c < col + w; c++) {
      if (hl.has(c)) { touches = true; break; }
    }

    if (touches) {
      shimmer += text;
      phase = 'shimmer';
    } else if (phase === 'before') {
      before += text;
    } else {
      // 已经过高亮段，后续都进 after
      after += text;
      phase = 'after';
    }
    col += w;
  }

  return { before, shimmer, after };
}
