// src/tui/inline/diff.ts
// Diff Layer：line-level diff，生成 RenderOperation[]。
//
// Phase 3 第一版：line-level diff（非 cell diff）。
// 比较上一帧的行数（prevCount）与下一帧的行内容（nextLines），
// 生成最小操作序列（cursorUp + writeLine/eraseLine + deleteLines）。
//
// 输入：prevCount（上一帧物理行数）+ nextLines（这一帧的行内容数组）
// 输出：RenderOperation[]（Writer 消费，执行 stdout 写入）
//
// 设计原则：
// - 纯函数：无 stdout.write / 无副作用
// - line-level：比较行数和行内容，不做 cell 级 diff
// - 覆写语义：假设光标在 prev 区域的末尾（下一行），操作序列把它变成 next

/**
 * 渲染操作：Writer 消费的最小操作单元。
 *
 * 操作语义（按顺序执行）：
 * - cursorUp：光标上移 N 行
 * - appendLine：写 content + \n（追加模式，不擦行）
 * - overwriteLine：\r\x1b[2K + content + \n（擦行 + 写内容 + 换行）
 * - eraseAndAdvance：\r\x1b[2K + \n（擦行 + 换行）
 * - eraseNoAdvance：\r\x1b[2K（擦行，不换行——commitFooter 最后一行用）
 * - advanceNewLine：\n（只换行，不擦）
 * - deleteLines：\x1b[<count>M（DL 删除 N 行）
 */
export type RenderOperation =
  | { type: 'cursorUp'; count: number }
  | { type: 'appendLine'; content: string }
  | { type: 'overwriteLine'; content: string }
  | { type: 'eraseAndAdvance' }
  | { type: 'eraseNoAdvance' }
  | { type: 'advanceNewLine' }
  | { type: 'deleteLines'; count: number };

/**
 * 覆写 diff：把一块 prevCount 行的区域变成 nextLines。
 *
 * 物理模型：光标当前在 prev 区域的「下一行」（即 prev 区域末尾下方）。
 * 生成的操作序列会把 prev 区域覆写成 next 内容，操作后光标停在 next 区域的下一行。
 *
 * 两种路径：
 * - prevCount === 0（首次/追加）：逐行 appendLine
 * - prevCount > 0（覆写）：cursorUp(prevCount) → 逐行 overwriteLine/eraseAndAdvance → 行数减少时 deleteLines
 *
 * @param prevCount 上一帧的物理行数（0 = 首次追加）
 * @param nextLines 这一帧的行内容数组（已上色已折行，不含 \n）
 * @returns 操作序列
 */
export function diffOverlay(prevCount: number, nextLines: string[]): RenderOperation[] {
  const ops: RenderOperation[] = [];

  if (prevCount === 0) {
    // 追加模式：逐行 appendLine
    for (const line of nextLines) {
      ops.push({ type: 'appendLine', content: line });
    }
    return ops;
  }

  // 覆写模式：cursorUp 回顶 + 逐行擦写
  ops.push({ type: 'cursorUp', count: prevCount });

  const maxLines = Math.max(prevCount, nextLines.length);
  for (let i = 0; i < maxLines; i++) {
    if (i < nextLines.length) {
      ops.push({ type: 'overwriteLine', content: nextLines[i]! });
    } else {
      // next 比 prev 短：多余行擦除
      ops.push({ type: 'eraseAndAdvance' });
    }
  }

  // 行数减少时：物理删除多余行（DL），不留空行
  // 注意：当前的 eraseAndAdvance 会把多余行擦成空行但仍占空间。
  // streaming 场景用 deleteLines 物理删除；footer 场景用 eraseAndAdvance 擦空（commit 前会逐行擦）。
  // diffOverlay 不自动加 deleteLines——由调用方根据场景决定（commitFooter 用 erase，streaming 用 DL）。
  // 保持 diffOverlay 通用：只生成覆写操作，DL 由特定场景的 diff 函数追加。

  return ops;
}

/**
 * 流式覆写 diff：把 lastStreamingHeight 行的草稿区变成 nextLines。
 *
 * 与 diffOverlay 的区别：行数减少时用 deleteLines 物理删除（streaming 场景的已知正确行为）。
 * 这复刻了改造前 rewriteStreamingLines 的精确逻辑：
 * - prevCount=0：逐行 appendLine
 * - prevCount>0：cursorUp + 逐行 overwriteLine + 行数减少时 DL
 *
 * @param prevCount 上一帧草稿行数（lastStreamingHeight）
 * @param nextLines 这一帧的草稿行内容
 */
export function diffStreamingOverlay(prevCount: number, nextLines: string[]): RenderOperation[] {
  const ops: RenderOperation[] = [];

  if (prevCount === 0) {
    for (const line of nextLines) {
      ops.push({ type: 'appendLine', content: line });
    }
    return ops;
  }

  // 覆写：cursorUp 回顶
  ops.push({ type: 'cursorUp', count: prevCount });

  // 逐行擦写新内容（只写 nextLines.length 行，不擦多余的——DL 处理）
  for (let i = 0; i < nextLines.length; i++) {
    ops.push({ type: 'overwriteLine', content: nextLines[i]! });
  }

  // 行数减少：DL 物理删除多余行
  if (nextLines.length < prevCount) {
    const excess = prevCount - nextLines.length;
    // 光标现在在最后一行写入内容下方一行 → cursorUp(1) 到末行 → DL excess → \n 回基准
    ops.push({ type: 'cursorUp', count: 1 });
    ops.push({ type: 'deleteLines', count: excess });
    ops.push({ type: 'advanceNewLine' });
  }

  return ops;
}

/**
 * Footer 覆写 diff：把 footerHeight 行的 footer 区域变成 nextLines。
 *
 * 与 diffOverlay 的区别：
 * - 行数相等或 next 更长：cursorUp(cursorToTop) + 逐行 overwriteLine（多余的旧行用 eraseAndAdvance 擦空）
 * - cursorUp 用 cursorToTop（光标到 footer 顶的距离），不是 footerHeight（光标在输入框，不在 footer 底）
 * - 复刻改造前 writeFooter 覆写模式的精确逻辑（max(prev,next) 次擦写）
 *
 * @param prevCount 上一帧 footer 行数（footerHeight）
 * @param cursorToTop 光标当前所在行到 footer 顶的距离
 * @param nextLines 这一帧的 footer 行内容
 */
export function diffFooterOverlay(prevCount: number, cursorToTop: number, nextLines: string[]): RenderOperation[] {
  const ops: RenderOperation[] = [];

  if (prevCount === 0) {
    for (const line of nextLines) {
      ops.push({ type: 'appendLine', content: line });
    }
    return ops;
  }

  // 覆写：cursorUp 回顶（用 cursorToTop，不是 footerHeight）+ max(prev,next) 次擦写
  ops.push({ type: 'cursorUp', count: cursorToTop });
  const maxLines = Math.max(prevCount, nextLines.length);
  for (let i = 0; i < maxLines; i++) {
    if (i < nextLines.length) {
      ops.push({ type: 'overwriteLine', content: nextLines[i]! });
    } else {
      ops.push({ type: 'eraseAndAdvance' });
    }
  }

  return ops;
}

/**
 * Footer commit diff：把 footerHeight 行的 footer 区域清空（next = 空）。
 *
 * 复刻改造前 commitFooter 的精确逻辑：
 * cursorUp(cursorToTop) → 逐行 \r\x1b[2K（前 N-1 行加 \n，最后一行不加）
 * → cursorUp(footerHeight-1) 回顶
 *
 * @param prevCount footer 行数（footerHeight）
 * @param cursorToTop 光标到 footer 顶的距离
 */
export function diffFooterCommit(prevCount: number, cursorToTop: number): RenderOperation[] {
  if (prevCount === 0) return [];

  const ops: RenderOperation[] = [];
  if (cursorToTop > 0) {
    ops.push({ type: 'cursorUp', count: cursorToTop });
  }
  for (let i = 0; i < prevCount; i++) {
    if (i < prevCount - 1) {
      ops.push({ type: 'eraseAndAdvance' });
    } else {
      // 最后一行：擦行不换行（光标停在最后一行）
      ops.push({ type: 'eraseNoAdvance' });
    }
  }
  // 回到 footer 顶部（让 appendLine 从原顶部覆盖）
  if (prevCount > 1) {
    ops.push({ type: 'cursorUp', count: prevCount - 1 });
  }
  return ops;
}
