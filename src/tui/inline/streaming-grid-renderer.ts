// src/tui/inline/streaming-grid-renderer.ts
// 流式草稿的 cell diff 渲染器。
// 用 cell 级 diff 替换行级覆写（cursorUp + \r\x1b[2K），消除闪烁。
// 复用 src/render/ 的 DoubleBuffer/diff/optimize/emit/blitAnsi。

import { DoubleBuffer } from '../../render/screen.js';
import { diff } from '../../render/diff.js';
import { optimize } from '../../render/optimizer.js';
import { emit } from '../../render/emit.js';
import { blitAnsi } from '../../render/output-ops.js';

export class StreamingGridRenderer {
  private db: DoubleBuffer | null = null;
  private lastHeight = 0;
  private lastCols = 0;
  private lastTopRow = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 写入草稿（流式增量核心接口）。
   *
   * buffer 高度取 max(lastHeight, newHeight)——行数缩减时不缩小 buffer，
   * 否则 diff 看不见被裁掉的旧行 → 屏幕残留。
   */
  commitStream(lines: string[], topRow: number, cols: number): void {
    const newHeight = lines.length;
    const topRowChanged = (this.lastTopRow > 0 && this.lastTopRow !== topRow);
    this.lastTopRow = topRow;
    const sizeChanged = (this.lastHeight !== newHeight || this.lastCols !== cols);

    // buffer 高度取 max——行数缩减时保留旧行高度，diff 能输出清除 patch
    const bufferHeight = Math.max(this.lastHeight, newHeight);

    if (!this.db || sizeChanged) {
      const oldFront = this.db?.front ?? null;
      this.db = new DoubleBuffer(bufferHeight, cols);
      // 旧 front 内容拷贝到新 front（保留旧行）
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

    // back.clear() → blitAnsi 写入新草稿行（只写 newHeight 行，多出行保持空）
    this.db.back.clear();
    for (let y = 0; y < newHeight; y++) {
      blitAnsi(this.db.back, 0, y, lines[y]!);
    }

    // diff → optimize → emit
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: topRow - 1,
    });

    this.db.swap();
    this.lastHeight = newHeight;
    this.lastCols = cols;
  }

  /**
   * 固化时清空草稿区。
   * front 保持（有上一帧内容），back 全空 → diff 输出全部清除 patch。
   * 用内部 lastTopRow 定位（不依赖外部传值）。
   */
  clear(): void {
    if (!this.db || this.lastHeight === 0 || this.lastTopRow === 0) return;
    this.db.back.clear();
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: this.lastTopRow - 1,
    });
    this.db = null;
    this.lastHeight = 0;
    this.lastCols = 0;
    this.lastTopRow = 0;
  }
}
