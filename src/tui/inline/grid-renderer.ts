// src/tui/inline/grid-renderer.ts
// Inline 模式的 footer 渲染器：用 cell 级双缓冲 + 绝对坐标定位。
//
// 核心区别（vs InlineRenderer.writeFooter 的 cursorUp 相对定位）：
// - 双缓冲：应用持有完整 footer 真相（front/back Screen），不依赖终端物理行
// - 绝对坐标：emit 用 \x1b[row;colH 定位，不依赖光标当前位置
// - resize 免疫：reflow 后重画即正确（绝对坐标不随 reflow 变化）

import { DoubleBuffer } from '../../render/screen.js';
import { diff } from '../../render/diff.js';
import { optimize } from '../../render/optimizer.js';
import { emit } from '../../render/emit.js';
import { blitAnsi } from '../../render/output-ops.js';
import type { FooterLayout } from './layout.js';

export class InlineGridRenderer {
  private db: DoubleBuffer | null = null;
  /** 上一次 footer 高度（供 clearRegion 清旧区域） */
  private lastHeight = 0;
  /** 上一次 cols（检测宽度变化） */
  private lastCols = 0;
  /** 上一次 footer 顶的绝对行号（1-based，供 clearRegion） */
  private lastFooterTopRow = 0;

  constructor(private stdout: NodeJS.WriteStream) {}

  /**
   * 清除屏幕上从 topRow 到屏幕底的区域。
   * CUP(topRow, 1) + ED（\x1b[0J）。
   */
  private clearRegion(topRow: number): void {
    this.stdout.write(`\x1b[${topRow};1H\x1b[0J`);
  }

  /**
   * 写入 footer（核心接口）。
   *
   * footerTopRow 每次实时计算（rows - newHeight + 1），不作为实例字段。
   * 高度或宽度变化时，先用缓存的旧值清旧区域，再重建 buffer 全量重画。
   */
  commitFooter(layout: FooterLayout, rows: number, cols: number): void {
    const newHeight = layout.lines.length;
    const footerTopRow = rows - newHeight + 1;

    const sizeChanged = (this.lastHeight !== newHeight || this.lastCols !== cols);

    // 高度或宽度变化 → 先清旧区域（用缓存的旧 footerTopRow）
    if (this.db && sizeChanged && this.lastFooterTopRow > 0) {
      this.clearRegion(this.lastFooterTopRow);
    }

    // 重建 DoubleBuffer（尺寸变化或首次）
    if (!this.db || sizeChanged) {
      this.db = new DoubleBuffer(newHeight, cols);
    }

    // back.clear() → blitAnsi 写入每行 footer 内容
    this.db.back.clear();
    for (let y = 0; y < layout.lines.length; y++) {
      blitAnsi(this.db.back, 0, y, layout.lines[y]!);
    }

    // diff → optimize → emit（yBias = footerTopRow - 1）
    const patches = optimize(diff(this.db.front, this.db.back));
    emit(patches, {
      charPool: this.db.charPool,
      stylePool: this.db.stylePool,
      stdout: this.stdout,
      yBias: footerTopRow - 1,
      cursor: { x: layout.cursorCol, y: layout.cursorToTop },
    });

    // swap
    this.db.swap();

    // 缓存本次的值
    this.lastHeight = newHeight;
    this.lastCols = cols;
    this.lastFooterTopRow = footerTopRow;
  }

  /**
   * Resize 时彻底擦除旧 footer + 丢弃 buffer。
   * 下次 commitFooter 发现 db===null → 新建 → front 全 0 → 全量重画。
   */
  clearForResize(): void {
    if (this.lastFooterTopRow > 0) {
      this.clearRegion(this.lastFooterTopRow);
    }
    this.db = null;
    this.lastHeight = 0;
    this.lastCols = 0;
    this.lastFooterTopRow = 0;
  }

  /** unmount 时清除 footer（生命周期清理）。 */
  dispose(): void {
    this.clearForResize();
  }
}
