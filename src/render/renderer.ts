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
export type InkRenderer = (node: unknown, options: { width: number; height: number; cursor?: CursorPos }) => RenderResult;

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

  // 光标桥：订阅模块级 pub/sub，让 setCursorPos（来自 Ink 的 onSetCursorPosition）
  // 能更新本闭包的 lastCursor，下次 emit 时定位光标。
  // useCursor 在 Footer unmount/重渲染时会调 setCursorPosition(undefined) 清理，
  // undefined 会传播到这里 → emit 隐藏光标（hideCursor）。
  onCursorUpdate((pos) => { lastCursor = pos; });

  return (node: unknown, options: { width: number; height: number; cursor?: CursorPos }): RenderResult => {
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
      // cursor 优先用 options.cursor（Ink 直接传的同步值，无时序问题），
      // fallback 到 lastCursor（pub/sub，可能因 effect 时序滞后一帧）。
      const ctx: EmitContext = {
        charPool: db.charPool,
        stylePool: db.stylePool,
        stdout: opts.stdout,
        cursor: options.cursor ?? lastCursor,
      };
      emit(optimized, ctx);

      // 6. swap（back → front，back 清零，含定期池子重置）
      db.swap();

      // outputHeight: 0——关键：让 Ink 认为帧非全屏，永不触发 Windows 上的
      // shouldClearTerminalForFrame（ink.js:100-101：isWindowsConsole && isFullscreen → clearTerminal）。
      // 我们的 renderer 已直接写 stdout，不需要 Ink 的帧输出/clearTerminal 参与。
      // 返回空 output + height 0 = "我什么都没渲染，你别碰屏幕"。
      return { output: '', outputHeight: 0, staticOutput: '' };
    } catch (err) {
      // 自研抛错 → fallback。
      // 不用 console.error——Ink 的 patchConsole 会拦截它路由到 writeToStderr，
      // 在 PowerShell 上 stderr 有内容就触发 NativeCommandError 杀进程。
      // 仅在 MI_CODE_DEBUG 时写 process.stderr（绕过 patchConsole）。
      if (process.env.MI_CODE_DEBUG) {
        process.stderr.write(`[mi-code render] custom renderer failed, falling back: ${String(err)}\n`);
      }
      if (fallback) {
        return fallback(node, options);
      }
      throw err;
    }
  };
}

/**
 * 光标位置 pub/sub：Ink 的 setCursorPosition（经 fork patch 的 onSetCursorPosition 钩子）
 * → bootstrap.tsx 调 setCursorPos → 通知所有 onCursorUpdate 订阅者（renderer 闭包是其中之一）。
 * useCursor 在 Footer unmount/重渲染 cleanup 时调 setCursorPosition(undefined)，
 * undefined 流到这里 → renderer 闭包 lastCursor=undefined → emit 隐藏光标。
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
