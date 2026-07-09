// src/render/output-ops.ts
// 操作收集器：blit 是编码值的唯一生产点（spec §3.6 铁律 4）。
// 接收 Style 对象（非 poolId），内部 intern + 编码 + 全角续位处理。
//
// blitAnsi：解析 Ink 在文本里嵌入的 ANSI（color/bold/etc.），按 Ink 的
// output.js 思路把 ANSI 串拆成 per-char styled cell。tokenize 用
// @alcalzone/ansi-tokenize（Ink 的 transitive dep，battle-tested），
// SGR 参数 → Style 字段由本文件的 sgrApply 解析。

import stringWidth from 'string-width';
import { tokenize } from '@alcalzone/ansi-tokenize';
import type { Screen } from './screen.js';
import { DEFAULT_STYLE, type Style } from './types.js';
import { encodeStyleId } from './types.js';

/**
 * 在 screen 的（y 行 x 列起）写入字符串，应用样式。
 * 处理：码点遍历、全角字符双 cell、行末整字裁剪、多行（\n）。
 */
export function blit(screen: Screen, x: number, y: number, text: string, style: Style): void {
  if (text === '') return;
  const styleId = screen.stylePool.intern(style);

  // 按行分割（支持多行）
  const lines = text.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    const targetY = y + lineIdx;
    if (targetY < 0 || targetY >= screen.rows) continue;

    // 按码点遍历（[...line] 等价）
    let cx = x;
    for (const ch of line) {
      if (cx >= screen.cols) break;  // 行末裁剪
      const w = stringWidth(ch);
      if (w <= 0) continue;  // 零宽字符（如组合标记）跳过
      if (cx + w > screen.cols) break;  // 全角字符跨右边界，整字裁掉

      const charId = screen.charPool.intern(ch);
      // head cell
      screen.setCell(cx, targetY, charId, encodeStyleId(styleId, false));
      // 全角续位 cell（w===2 时）
      if (w === 2 && cx + 1 < screen.cols) {
        screen.setCell(cx + 1, targetY, charId, encodeStyleId(styleId, true));
      }
      cx += w;
    }
  }
}

/**
 * 把 Screen 的指定矩形区域清空（写空白 + 默认样式）。
 * 用于 yoga-walk 在重绘前清场，或 clip 区域。
 */
export function clearRegion(screen: Screen, x1: number, y1: number, x2: number, y2: number): void {
  for (let y = Math.max(0, y1); y < Math.min(screen.rows, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(screen.cols, x2); x++) {
      screen.setCell(x, y, 0, 0);
    }
  }
}

// ===== blitAnsi：解析嵌入 ANSI 的文本，逐字符写带样式的 cell =====

/**
 * 在 screen 的（y 行 x 列起）写入 ANSI 嵌入的文本。
 * 用 @alcalzone/ansi-tokenize 拆 token，遇到 ansi token 更新当前 Style，
 * 遇到 char token 写 cell。与 blit 不同的只是「每字符可有自己的 Style」。
 *
 * @alcalzone/ansi-tokenize 只给原始 ANSI 码字节，SGR → Style 由 sgrApply 解析。
 */
export function blitAnsi(screen: Screen, x: number, y: number, ansiText: string): void {
  if (ansiText === '') return;

  const tokens = tokenize(ansiText);
  let style: Style = DEFAULT_STYLE; // 当前活动样式（不可变替换）

  // 按行分割：tokens 里 \n 是 char token，用它切行
  let targetY = y;
  let cx = x;

  for (const tok of tokens) {
    if (tok.type === 'ansi') {
      // 更新当前样式（apply 后返回新对象）
      style = applyAnsiCode(style, tok.code);
      continue;
    }
    if (tok.type === 'control') {
      continue; // 其它控制码（光标移动等）忽略，与 Ink sanitize 一致
    }
    // char token
    const ch = tok.value;
    if (ch === '\n') {
      targetY++;
      cx = x;
      continue;
    }
    if (targetY < 0 || targetY >= screen.rows) continue;
    if (cx >= screen.cols) continue;

    const w = tok.fullWidth ? 2 : stringWidth(ch);
    if (w <= 0) continue; // 零宽（组合标记等）跳过
    if (cx + w > screen.cols) continue; // 全角跨右边界：整字裁掉

    const charId = screen.charPool.intern(ch);
    const styleId = screen.stylePool.intern(style);
    screen.setCell(cx, targetY, charId, encodeStyleId(styleId, false));
    if (w === 2 && cx + 1 < screen.cols) {
      screen.setCell(cx + 1, targetY, charId, encodeStyleId(styleId, true));
    }
    cx += w;
  }
}

// ===== SGR 参数解析 =====
// 解析单个 ANSI 码（如 "\x1b[1m" / "\x1b[38;2;255;0;0m" / "\x1b[0m"）
// 返回应用该码后的新 Style（纯函数，不改入参）。
//
// 支持范围（对齐 Style 字段 + Ink/chalk 实际产出）：
// - 属性：1=bold 2=dim 3=italic 4=underline 7=inverse 9=strikethrough
// - 关闭：22(bold/dim) 23 24 27 29
// - reset：0（回 DEFAULT_STYLE）
// - 前景：38;2;r;g;b（24bit）/ 38;5;n（256色，降级用 xterm 调色板）/ 30-37 / 90-97（16色降级）
// - 背景：48;2;r;g;b / 48;5;n / 40-47 / 100-107
// - 关闭色：39（默认前景）/ 49（默认背景）
//
// 16/256 色无直接 RGB，用标准 xterm 调色板降级为 24-bit RGB 写入 Style.fg/bg。

/** 把 RGB 打包成 24 位 */
function rgb(r: number, g: number, b: number): number {
  return ((r & 0xFF) << 16) | ((g & 0xFF) << 8) | (b & 0xFF);
}

/** xterm 16 色调色板（标准 ANSI，索引 0-15） */
const ANSI_16 = [
  rgb(0, 0, 0),       rgb(205, 0, 0),    rgb(0, 205, 0),    rgb(205, 205, 0),
  rgb(0, 0, 238),     rgb(205, 0, 205),   rgb(0, 205, 205),   rgb(229, 229, 229),
  rgb(127, 127, 127), rgb(255, 0, 0),    rgb(0, 255, 0),    rgb(255, 255, 0),
  rgb(92, 92, 255),   rgb(255, 0, 255),   rgb(0, 255, 255),   rgb(255, 255, 255),
];

/** xterm 256 色调色板：索引 → RGB（0-15 用 ANSI_16，16-231 立方体，232-255 灰阶） */
function xterm256(n: number): number {
  if (n < 0 || n > 255) return 0;
  if (n < 16) return ANSI_16[n]!;
  if (n < 232) {
    // 6x6x6 立方体：n = 16 + 36*r + 6*g + b
    const c = n - 16;
    const r = Math.floor(c / 36) % 6;
    const g = Math.floor(c / 6) % 6;
    const b = c % 6;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return rgb(step(r), step(g), step(b));
  }
  // 232-255：灰阶（24 级，8-238）
  const v = 8 + (n - 232) * 10;
  return rgb(v, v, v);
}

/**
 * 解析并应用一个 ANSI SGR 码到 style，返回新 Style。
 * @param code 形如 "\x1b[1m" / "\x1b[38;2;255;0;0m" / "\x1b[0m"
 */
function applyAnsiCode(style: Style, code: string): Style {
  // 仅处理 CSI ... m（SGR）；其它 CSI/OSC 直接忽略（不改变样式）
  const m = /^\x1b\[([\d:;]*)m$/.exec(code);
  if (!m) return style;
  const params = m[1]!;
  // 空参数（"\x1b[m"）等价于 0
  const codes = params === '' ? [0] : params.split(';').map(s => {
    const n = Number(s);
    return Number.isNaN(n) ? 0 : n;
  });
  return applySgrParams(style, codes);
}

/** 把 SGR 参数数组应用到 style（处理复合序列如 38;2;r;g;b） */
function applySgrParams(style: Style, codes: number[]): Style {
  let next: Style = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    switch (c) {
      case 0: next = { ...DEFAULT_STYLE }; break;
      case 1: next.bold = true; break;
      case 2: next.dim = true; break;
      case 3: next.italic = true; break;
      case 4: next.underline = true; break;
      case 7: next.inverse = true; break;
      case 9: next.strikethrough = true; break;
      case 22: next.bold = false; next.dim = false; break;
      case 23: next.italic = false; break;
      case 24: next.underline = false; break;
      case 27: next.inverse = false; break;
      case 29: next.strikethrough = false; break;
      case 39: next.fg = 0; break; // 默认前景
      case 49: next.bg = 0; break; // 默认背景
      // 16 色前景
      case 30: case 31: case 32: case 33:
      case 34: case 35: case 36: case 37:
        next.fg = ANSI_16[c - 30]!; break;
      case 90: case 91: case 92: case 93:
      case 94: case 95: case 96: case 97:
        next.fg = ANSI_16[c - 90 + 8]!; break;
      // 16 色背景
      case 40: case 41: case 42: case 43:
      case 44: case 45: case 46: case 47:
        next.bg = ANSI_16[c - 40]!; break;
      case 100: case 101: case 102: case 103:
      case 104: case 105: case 106: case 107:
        next.bg = ANSI_16[c - 100 + 8]!; break;
      case 38:
      case 48: {
        // 38/48;2;r;g;b 或 38/48;5;n
        const sub = codes[i + 1];
        if (sub === 2) {
          const r = codes[i + 2] ?? 0;
          const g = codes[i + 3] ?? 0;
          const b = codes[i + 4] ?? 0;
          if (c === 38) next.fg = rgb(r, g, b); else next.bg = rgb(r, g, b);
          i += 4;
        } else if (sub === 5) {
          const n = codes[i + 2] ?? 0;
          if (c === 38) next.fg = xterm256(n); else next.bg = xterm256(n);
          i += 2;
        }
        break;
      }
      default:
        // 其它 SGR（如光标、未支持属性）忽略
        break;
    }
  }
  return next;
}
