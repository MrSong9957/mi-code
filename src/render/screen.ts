// src/render/screen.ts
// Screen：Int32Array 二维 cell 网格（每 cell 2×Int32 = 8 字节）。
// spec §3.5：Screen 只持有数据 + 池子引用，不暴露写编码值的公共方法。
// 写入由 output-ops.blit 完成（唯一生产点）。
//
// 编码：chars[i*2] = charId, chars[i*2+1] = encodedStyleId（poolId<<1|fullWidthFlag）。
// 见 types.ts encodeStyleId/decodeStyleId。

import type { CharPool } from './char-pool.js';
import type { StylePool } from './style-pool.js';

export class Screen {
  rows: number;
  cols: number;
  chars: Int32Array;
  charPool: CharPool;
  stylePool: StylePool;

  constructor(rows: number, cols: number, charPool: CharPool, stylePool: StylePool) {
    this.rows = rows;
    this.cols = cols;
    this.chars = new Int32Array(rows * cols * 2);  // 初始全 0
    this.charPool = charPool;
    this.stylePool = stylePool;
  }

  /** 取 cell 的 {charId, encodedStyleId}（越界返回 0/0，不抛错） */
  cellAt(x: number, y: number): { charId: number; encodedStyleId: number } {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) {
      return { charId: 0, encodedStyleId: 0 };
    }
    const i = (y * this.cols + x) * 2;
    return { charId: this.chars[i], encodedStyleId: this.chars[i + 1] };
  }

  /**
   * 直接写入 cell 的 charId + encodedStyleId。
   * ⚠️ 仅 output-ops.blit 调用（spec §3.6 铁律 4：编码值唯一生产点）。
   * encodedStyleId 必须是编码后的值（用 encodeStyleId 生成）。
   */
  setCell(x: number, y: number, charId: number, encodedStyleId: number): void {
    if (x < 0 || x >= this.cols || y < 0 || y >= this.rows) return;
    const i = (y * this.cols + x) * 2;
    this.chars[i] = charId;
    this.chars[i + 1] = encodedStyleId;
  }

  /** 清空（全 0） */
  clear(): void {
    this.chars.fill(0);
  }

  /** 重建为新尺寸（数据丢失） */
  resize(rows: number, cols: number): void {
    this.rows = rows;
    this.cols = cols;
    this.chars = new Int32Array(rows * cols * 2);
  }
}
