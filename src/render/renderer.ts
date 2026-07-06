// src/render/renderer.ts
// fork 接缝：组合 yoga-walk + diff + optimizer + emit。
// 返回 Ink 期望的 {output, outputHeight, staticOutput} 占位（output 为空串，
// 因为我们已直接写 stdout；Ink 的 onRender 不会再写 output）。
//
// feature flag + fallback：USE_DOUBLE_BUFFER=false 或自研抛错 → 走 fallback（Ink 原生 renderer）。

import { DoubleBuffer } from './screen.js';
import { renderTree } from './yoga-walk.js';
import { diff } from './diff.js';
import { optimize } from './optimizer.js';
import { emit, type EmitContext } from './emit.js';
import { type CursorPos } from './types.js';

/** Ink renderer 的返回形状 */
interface RenderResult {
  output: string;
  outputHeight: number;
  staticOutput: string;
}

/** Ink renderer 函数签名（简化版，真实 Ink 还传 isScreenReaderEnabled） */
export type InkRenderer = (node: unknown, options: { width: number; height: number }) => RenderResult;

export interface CustomRendererOptions {
  stdout: { write: (s: string) => boolean; columns?: number; rows?: number; isTTY?: boolean };
  /** feature flag；默认读 USE_DOUBLE_BUFFER（MICODE_DOUBLE_BUFFER 环境变量） */
  useDoubleBuffer?: boolean;
  /** fallback renderer（Ink 原生）；自研抛错时走这里 */
  fallback?: InkRenderer;
}

export function createCustomRenderer(opts: CustomRendererOptions): InkRenderer {
  const useFlag = opts.useDoubleBuffer ?? (process.env.MICODE_DOUBLE_BUFFER !== '0');
  const fallback = opts.fallback;

  // 懒初始化 DoubleBuffer（首次调用时按尺寸创建）
  let db: DoubleBuffer | null = null;
  let lastCursor: CursorPos | undefined;

  return (node: unknown, options: { width: number; height: number }): RenderResult => {
    if (!useFlag && fallback) {
      return fallback(node, options);
    }
    // 空树（null / undefined）：无内容可渲染。outputHeight=0 告知 Ink 非全屏，
    // 也避免下游 yoga-walk 对 null 节点解引用。
    if (node == null) {
      return { output: '', outputHeight: 0, staticOutput: '' };
    }
    try {
      if (!db || db.front.rows !== options.height || db.front.cols !== options.width) {
        db = new DoubleBuffer(options.height, options.width);
      }

      // 1. 清 back buffer（每帧重画整个画面）
      db.back.clear();

      // 1.5 校验根节点布局：读 computed 尺寸做边界 sanity check，并把
      // 「malformed yoga 节点（如方法抛错）」统一路由进下方 catch → fallback。
      const rootYoga = (node as { yogaNode?: { getComputedWidth(): number; getComputedHeight(): number } }).yogaNode;
      if (rootYoga) {
        rootYoga.getComputedWidth();
        rootYoga.getComputedHeight();
      }

      // 2. yoga-walk：遍历 Ink 树写 back
      renderTree(node as never, db.back);

      // 3. diff
      const patches = diff(db.front, db.back);

      // 4. optimize
      const optimized = optimize(patches);

      // 5. emit
      const ctx: EmitContext = {
        charPool: db.charPool,
        stylePool: db.stylePool,
        stdout: opts.stdout,
        cursor: lastCursor,
      };
      emit(optimized, ctx);

      // 6. swap（back → front，back 清零，含定期池子重置）
      db.swap();

      return { output: '', outputHeight: options.height, staticOutput: '' };
    } catch (err) {
      // 自研抛错 → fallback
      if (fallback) {
        console.error('[mi-code render] custom renderer failed, falling back:', err);
        return fallback(node, options);
      }
      throw err;
    }
  };
}

/**
 * 设置光标位置（fork 后 Ink 的 setCursorPosition 改调这里）。
 * 由 patch-package fork 的 ink.js 调用，把 useCursor 的 {x,y} 传进来。
 * Task 12/13 接入 Ink 时由 patch 调用此函数；当前 Task 仅占位。
 */
const cursorListeners: Array<(pos: CursorPos | undefined) => void> = [];
export function onCursorUpdate(listener: (pos: CursorPos | undefined) => void): () => void {
  cursorListeners.push(listener);
  return () => {
    const idx = cursorListeners.indexOf(listener);
    if (idx >= 0) cursorListeners.splice(idx, 1);
  };
}
export function setCursorPos(pos: CursorPos | undefined): void {
  for (const listener of cursorListeners) listener(pos);
}
