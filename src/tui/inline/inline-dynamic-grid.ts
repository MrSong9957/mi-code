// src/tui/inline/inline-dynamic-grid.ts
// 合并草稿+footer 的统一动态区域渲染器。
//
// 核心思想：草稿和 footer 在屏幕上是连续相邻区域，草稿的底 = footer 的顶。
// 用一个 DoubleBuffer 管理整个区域，一次 diff 同时输出草稿增量 + footer 位移。
// 消除两个独立 grid 的竞争冲突。
//
// buffer 布局：
//   [0, draftLines.length)       → 草稿行
//   [draftLines.length, total)   → footer 行（border/输入框/border/status）
//
// 草稿行数变化时，footer 在 buffer 内的位置自动变化——diff 同时处理两者。

import { DoubleBuffer } from '../../render/screen.js';
import { diff } from '../../render/diff.js';
import { optimize } from '../../render/optimizer.js';
import { emit } from '../../render/emit.js';
import { blitAnsi } from '../../render/output-ops.js';
import type { FooterLayout } from './layout.js';

export class InlineDynamicGrid {
  private db: DoubleBuffer | null = null;
  private lastTotalHeight = 0;
  private lastCols = 0;
  private lastTopRow = 0;
  /** 上一帧草稿行数（assistant 固化时供 promoteDraft 使用） */
  private lastDraftHeight = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 写入整个动态区域（草稿 + footer）。
   *
   * @param streamingLines 草稿行（null = 无草稿，只有 footer）
   * @param footer footer 布局
   * @param topRow 整个区域在屏幕上的起始行（1-based）
   * @param cols 终端列宽
   */
  commit(
    streamingLines: string[] | null,
    footer: FooterLayout,
    topRow: number,
    cols: number,
  ): void {
    // 拼接完整区域：草稿行 + footer 行
    const draftLines = streamingLines ?? [];
    const allLines = [...draftLines, ...footer.lines];
    const newTotalHeight = allLines.length;

    const topRowChanged = (this.lastTopRow > 0 && this.lastTopRow !== topRow);
    this.lastTopRow = topRow;
    const sizeChanged = (this.lastTotalHeight !== newTotalHeight || this.lastCols !== cols);

    // 重建 DoubleBuffer（尺寸变化或首次）
    // buffer 高度取 max——行数缩减时不缩小，diff 能清除多余行
    const bufferHeight = Math.max(this.lastTotalHeight, newTotalHeight);
    if (!this.db || sizeChanged) {
      const oldFront = this.db?.front ?? null;
      this.db = new DoubleBuffer(bufferHeight, cols);
      // 旧 front 内容拷贝到新 front
      if (oldFront) {
        const copyRows = Math.min(oldFront.rows, bufferHeight);
        for (let y = 0; y < copyRows; y++) {
          for (let x = 0; x < Math.min(oldFront.cols, cols); x++) {
            const oldIdx = (y * oldFront.cols + x) * 2;
            const newIdx = (y * cols + x) * 2;
            this.db.front.chars[newIdx] = oldFront.chars[oldIdx]!;
            this.db.front.chars[newIdx + 1] = oldFront.chars[oldIdx + 1]!;
          }
        }
      }
    }

    // 位置变化 → front 全失效（强制在新位置全量重画）
    if (topRowChanged) {
      this.db.front.clear();
    }

    // back.clear() → blitAnsi 写入所有行
    this.db.back.clear();
    for (let y = 0; y < allLines.length; y++) {
      blitAnsi(this.db.back, 0, y, allLines[y]!);
    }

    // diff → optimize → emit（yBias = topRow - 1）
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: topRow - 1,
      // 光标定位到 footer 输入框行
      // 输入框在 buffer 内的行号 = draftLines.length + footer.cursorToTop
      cursor: {
        x: footer.cursorCol,
        y: draftLines.length + footer.cursorToTop,
      },
    });

    this.db.swap();
    this.lastTotalHeight = newTotalHeight;
    this.lastCols = cols;
    this.lastDraftHeight = draftLines.length;
  }

  /** 上一帧草稿行数（assistant 固化时供 InlineApp 获取） */
  getLastDraftHeight(): number { return this.lastDraftHeight; }

  /**
   * assistant 固化时调用：草稿行变成正式行，grid 只剥离管理权。
   *
   * 草稿行已经在屏幕上（由上一帧 emit 写入），格式和正式消息完全一致——
   * 不需要擦除重写。只清空 db + 调整 topRow：
   * - db = null → 下一帧 commit 新建 DoubleBuffer，全量重画 footer（BSU/ESU 内不闪）
   * - lastTopRow += draftHeight → footer 重画到草稿下方（同一物理位置）
   * - 草稿行不在新 db 管理范围 → 不被触碰
   *
   * 与 clear() 区别：clear() emit 擦除 patch（thinking 折叠，草稿内容必须删除）；
   * promoteDraft() 不 emit（assistant 固化，草稿内容保留为正式消息）。
   */
  promoteDraft(draftHeight: number): void {
    if (draftHeight === 0) return;
    this.db = null;                   // 清空 → 下一帧全量重画 footer
    this.lastTotalHeight = 0;
    this.lastDraftHeight = 0;
    this.lastTopRow += draftHeight;   // footer 位置下移（草稿行变成正式行）
    // lastCols 保留（下一帧 commit 用相同 cols 重建 db）
  }

  /**
   * 清除整个动态区域（thinking 折叠时用）。
   * front 保持（有上一帧内容），back 全空 → diff 输出清除 patch。
   * emit 末尾把光标定位到动态区域顶部（供后续 appendLine 从正确位置写入摘要行）。
   */
  clear(): void {
    if (!this.db || this.lastTotalHeight === 0 || this.lastTopRow === 0) return;
    this.db.back.clear();
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: this.lastTopRow - 1,
      // 光标定位到动态区域顶部（buffer y=0 → 屏幕 lastTopRow 行）
      // thinking 折叠后 appendLine 摘要行从此位置写入
      cursor: { x: 0, y: 0 },
    });
    this.db = null;
    this.lastTotalHeight = 0;
    this.lastCols = 0;
    this.lastTopRow = 0;
    this.lastDraftHeight = 0;
  }

  /**
   * 重置所有状态（resize 全量重画前调用）。
   * 不 emit——清屏由调用方（InlineApp）负责。
   * 与 clear() 区别：clear() emit 擦除 patch（旧区域有内容要清）；
   * reset() 不 emit（调用方已 \x1b[2J 清屏，不需要逐 cell 擦除）。
   */
  reset(): void {
    this.db = null;
    this.lastTotalHeight = 0;
    this.lastCols = 0;
    this.lastTopRow = 0;
    this.lastDraftHeight = 0;
  }

  /** unmount 时清除（生命周期清理）。 */
  dispose(): void {
    this.clear();
  }
}
