// src/render/screen.ts
// Screen：Int32Array 二维 cell 网格（每 cell 2×Int32 = 8 字节）。
// spec §3.5：Screen 只持有数据 + 池子引用，不暴露写编码值的公共方法。
// 写入由 output-ops.blit 完成（唯一生产点）。
//
// 编码：chars[i*2] = charId, chars[i*2+1] = encodedStyleId（poolId<<1|fullWidthFlag）。
// 见 types.ts encodeStyleId/decodeStyleId。

import { CharPool } from './char-pool.js';
import { StylePool } from './style-pool.js';
import { decodeStyleId, isFullWidthContinuation, encodeStyleId } from './types.js';

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

// ===== DoubleBuffer（spec §3.8）=====

const POOL_RESET_INTERVAL_MS = 5 * 60 * 1000;

/** 把 screen 的 charId/styleId 从旧池迁移到新池（原地改 Int32Array） */
function migrateScreenPools(
  screen: Screen,
  oldCharPool: CharPool,
  oldStylePool: StylePool,
  newCharPool: CharPool,
  newStylePool: StylePool,
): void {
  const len = screen.chars.length;
  for (let i = 0; i < len; i += 2) {
    const oldCharId = screen.chars[i]!;
    const oldEncoded = screen.chars[i + 1]!;
    if (oldCharId === 0 && oldEncoded === 0) continue;  // 空 cell 跳过
    const oldStyleId = decodeStyleId(oldEncoded);
    const fw = isFullWidthContinuation(oldEncoded);
    // 用旧池查字符/样式，新池 intern
    const newCharId = oldCharId === 0 ? 0 : newCharPool.intern(oldCharPool.get(oldCharId));
    const newStyleId = oldStyleId === 0 ? 0 : newStylePool.intern(oldStylePool.get(oldStyleId));
    screen.chars[i] = newCharId;
    screen.chars[i + 1] = encodeStyleId(newStyleId, fw);
  }
}

export class DoubleBuffer {
  front: Screen;
  back: Screen;
  charPool: CharPool;
  stylePool: StylePool;
  private lastPoolResetTime: number;

  constructor(rows: number, cols: number) {
    this.charPool = new CharPool();
    this.stylePool = new StylePool();
    this.front = new Screen(rows, cols, this.charPool, this.stylePool);
    this.back = new Screen(rows, cols, this.charPool, this.stylePool);
    this.lastPoolResetTime = Date.now();
  }

  /** 交换：back → front，back 清零。含定期池子重置。 */
  swap(): void {
    const now = Date.now();
    if (now - this.lastPoolResetTime > POOL_RESET_INTERVAL_MS) {
      this.resetPools();
      this.lastPoolResetTime = now;
    }
    // back 内容拷到 front
    this.front.chars.set(this.back.chars);
    // back 清零
    this.back.clear();
  }

  /** 重建为新尺寸（resize 事件） */
  resize(rows: number, cols: number): void {
    this.front.resize(rows, cols);
    this.back.resize(rows, cols);
    // resize 后 Screen 的 pool 引用不变（resize 不重建池子）
    this.front.charPool = this.charPool;
    this.front.stylePool = this.stylePool;
    this.back.charPool = this.charPool;
    this.back.stylePool = this.stylePool;
  }

  /** 池子重置：创建新池，迁移 front/back 的 id */
  resetPools(): void {
    const newCharPool = new CharPool();
    const newStylePool = new StylePool();
    // 迁移时用旧池查字符（front/back 的 charPool 字段还指向旧池）
    const oldCharPool = this.charPool;
    const oldStylePool = this.stylePool;
    migrateScreenPools(this.front, oldCharPool, oldStylePool, newCharPool, newStylePool);
    migrateScreenPools(this.back, oldCharPool, oldStylePool, newCharPool, newStylePool);
    // 换引用
    this.charPool = newCharPool;
    this.stylePool = newStylePool;
    this.front.charPool = newCharPool;
    this.front.stylePool = newStylePool;
    this.back.charPool = newCharPool;
    this.back.stylePool = newStylePool;
  }
}
