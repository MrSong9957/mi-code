// src/tui/inline/colors.ts
// 色板模块：赛博亮色方案，给 LOGO 和状态栏字段着色。
//
// 物理本质：终端 SGR（Select Graphic Rendition）色码的「印泥盒」。
// 每个颜色常量是一块印泥，colorize() 是「蘸印泥盖章 + 立即擦除」的组合，
// 保证颜色不泄漏到分隔符或其他文本。
//
// 配色规格（赛博亮色）：
//   LOGO    → cyanBright   (96)  品牌主色
//   mode    → cyanBright   (96)
//   model   → magentaBright(95)
//   dir     → yellowBright (93)
//   branch  → greenBright  (92)
//   context → blueBright   (94)
//
// 复用 ansi-utils.ts 的 sgr()（此前是死代码，本模块激活它）。

import { sgr } from './ansi-utils.js';
import type { UIMessageStyle } from '../../ui/types.js';

/** 所有属性归零——着色包裹的收尾，防止颜色泄漏 */
export const RESET = sgr('0');

// 赛博亮色印泥（16 色 Bright 变体）—— 状态栏 / LOGO 用
export const cyanBright = sgr('96');
export const magentaBright = sgr('95');
export const yellowBright = sgr('93');
export const greenBright = sgr('92');
export const blueBright = sgr('94');

// 标准色印泥（SGR 30 系）—— 消息正文用（与 styleToInkProps 的语义映射一致）
// brand→magenta(35)、success→green(32)、error→red(31)、border→gray(90)
export const redBright = sgr('31');
const greenBrightStd = sgr('32');
const magentaBrightStd = sgr('35');
const grayBrightStd = sgr('90');

/**
 * 给文本着色：前置色码 + 文本 + RESET。
 * 像盖章——蘸印泥、盖上去、立即擦干净边框。
 */
export function colorize(color: string, text: string): string {
  return `${color}${text}${RESET}`;
}

/**
 * LOGO 全行单色着色（cyanBright 品牌主色）。
 * 整行包裹：色码 + 原文 + reset。
 */
export function colorizeLogo(line: string): string {
  return colorize(cyanBright, line);
}

/** 状态栏 5 字段（与 StatusBarData 对应，去掉无关字段） */
export interface StatusFields {
  mode: string;
  model: string;
  dir: string;
  branch: string;
  /** 进度条 + 百分比的组合文本，如「████░░░░░░ 40%」 */
  context: string;
}

/**
 * 状态栏分色着色：5 字段各用不同亮色，│ 分隔符保持默认色。
 *
 * 输出结构：cyan{mode} │ magenta{model} │ yellow{dir} │ green{branch} │ blue{context}
 * 每个字段独立包裹（色码...reset），分隔符落在两个 reset/色码之间不着色。
 */
export function colorizeStatus(fields: StatusFields): string {
  const parts = [
    colorize(cyanBright, fields.mode),
    colorize(magentaBright, fields.model),
    colorize(yellowBright, fields.dir),
    colorize(greenBright, fields.branch),
    colorize(blueBright, fields.context),
  ];
  return parts.join(' │ ');
}

// ─────────────── 消息正文语义样式（对齐 styleToInkProps）───────────────
//
// 物理本质：消息行的「语义→色码翻译器」。
// FormattedLine.style 用抽象 token（brand/success/error/dim），
// 本组函数把这些 token 翻译成终端 SGR 序列，让 InlineApp 能给每行正文上色。
//
// 映射表与 src/tui/types.ts:styleToInkProps 完全一致（单一事实源）：
//   brand   → magenta(35) —— ● 标题、assistant 前缀
//   success → green(32)   —— ❯ 用户输入
//   error   → red(31)     —— 错误
//   border  → gray(90)    —— 边框
//   其它    → 透传（可能是具名色）
//
// 复用 sgr() 原语（与状态栏同源），避免引入新依赖。

/** 语义 fg token → SGR 色码（与 styleToInkProps 的 fg 映射一致） */
function fgToSGR(fg: string): string | undefined {
  switch (fg) {
    case 'brand': return magentaBrightStd;   // magenta(35)
    case 'success': return greenBrightStd;   // green(32)
    case 'error': return redBright;          // red(31)
    case 'border': return grayBrightStd;     // gray(90)
    default: return undefined;               // 未知 token 不着色
  }
}

/**
 * UIMessageStyle → SGR 组合串（bold/dim/italic/underline/inverse + fg）。
 *
 * 物理本质：把多个样式属性拼成一条 SGR 序列（像把多块印泥叠在一起盖章）。
 * 顺序：fg → bold(1) → dim(2) → italic(3) → underline(4) → inverse(7)。
 * 无任何属性时返回空串。
 *
 * @param style 语义样式（可能为 undefined）
 * @returns SGR 序列串（空串表示无样式）
 */
export function styleToSGR(style: UIMessageStyle | undefined): string {
  if (!style) return '';
  let sgrSeq = '';
  if (style.fg) {
    const fgCode = fgToSGR(style.fg);
    if (fgCode) sgrSeq += fgCode;
  }
  if (style.bold) sgrSeq += sgr('1');
  if (style.dim) sgrSeq += sgr('2');
  if (style.italic) sgrSeq += sgr('3');
  if (style.underline) sgrSeq += sgr('4');
  if (style.inverse) sgrSeq += sgr('7');
  return sgrSeq;
}

/**
 * 给文本上色：SGR 序列 + text + RESET。
 *
 * 物理本质：盖章——蘸印泥（styleToSGR）、盖上去（text）、立即擦干净（RESET）。
 * 无样式时原样返回（不产生任何 SGR 序列），保证「纯净文本」可被 color-guard-rails 测试通过。
 *
 * @param text 原始文本
 * @param style 语义样式（可选；无则原样返回）
 * @returns 带 SGR 包裹的文本（或原样文本）
 */
export function colorizeStyled(text: string, style?: UIMessageStyle): string {
  const sgrSeq = styleToSGR(style);
  if (sgrSeq === '') return text;
  return `${sgrSeq}${text}${RESET}`;
}
