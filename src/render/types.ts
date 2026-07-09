// src/render/types.ts
// 自研渲染层的共享类型与常量。
// spec §3.6 styleId 编码纪律：Int32Array 存编码值（poolId<<1|fullWidthFlag），
// Patch 存解码后的纯 poolId + 独立的 isFullWidthContinuation。

/** 特殊 charId：optimizer 标记「此 cell 应擦除」（写空格+默认样式） */
export const ERASE_CHAR_ID = -1;

/** RGB 打包成 24 位（0xFFFFFF）；0 = 默认前景/背景 */
export interface Style {
  fg: number;
  bg: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  dim: boolean;
  strikethrough: boolean;
}

/** 默认样式（无任何装饰） */
export const DEFAULT_STYLE: Style = {
  fg: 0, bg: 0,
  bold: false, italic: false, underline: false,
  inverse: false, dim: false, strikethrough: false,
};

/** Patch：单 cell 变更（spec §3.7） */
export interface Patch {
  x: number;
  y: number;
  /** charPool 索引（纯 poolId）；或 ERASE_CHAR_ID */
  charId: number;
  /** stylePool 索引（纯 poolId，非编码） */
  styleId: number;
  /** 全角字符的续位 cell，emit 时跳过字符输出 */
  isFullWidthContinuation: boolean;
}

/** 光标位置（绝对坐标，0-based；来自 useCursor） */
export interface CursorPos {
  x: number;
  y: number;
}

// ===== styleId 编解码（spec §3.6 铁律 1-4）=====

/** 编码：纯 poolId + 全角标记 → Int32Array 存储值 */
export function encodeStyleId(poolId: number, fullWidth: boolean): number {
  return (poolId << 1) | (fullWidth ? 1 : 0);
}

/** 解码：Int32Array 存储值 → 纯 poolId */
export function decodeStyleId(encoded: number): number {
  return encoded >>> 1;  // 无符号右移，避免符号位问题
}

/** 解码：Int32Array 存储值 → 是否全角续位 cell */
export function isFullWidthContinuation(encoded: number): boolean {
  return (encoded & 1) === 1;
}
