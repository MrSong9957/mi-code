// 主题层：semantic token → 多级颜色表示（truecolor RGB + 256 + 16 降级）
//
// 物理本质：色票本，每格贴三张色卡。
// 每个语义角色（强调、错误、提示等）在色票本上占一格，写三张色卡：
//   - rgb：truecolor 精确色（现代终端）
//   - ansi256：256 色近似索引（老终端）
//   - ansi16：16 色命名（最保守兜底）
// 组件代码只认"角色"（如 brand），换主题或换终端能力都能自动挑合适的色卡。
//
// dark 主题色值对齐 Claude Code（D:\Files\GitHub\claude-code-source-code\src\utils\theme.ts）。

/** semantic token：语义化的颜色角色名 */
export type ColorToken =
  | 'accent'   // 主强调（边框 / 状态栏 / 进度条）
  | 'brand'    // 品牌色（assistant ● / banner / 工具名 / spinner）
  | 'success'  // 成功（提示符 / 工具完成 / 字符串 / ☑）
  | 'warn'     // 警告（标题 / 数字 / 工具运行中）
  | 'error'    // 错误（spinner stall）
  | 'muted'    // 低调灰
  | 'text'     // 默认前景
  | 'prompt'   // 输入提示符
  | 'border';  // 边框

/** RGB 三元组 */
export type Rgb = readonly [number, number, number];

/** 色卡：一个 token 的多级颜色表示 */
export interface ColorSpec {
  /** truecolor 精确色 [r,g,b] */
  rgb: Rgb;
  /** 16 色 ANSI 命名（colors.ts FG_MAP 的 key，如 'cyan'/'green'...）；空串=默认前景 */
  ansi16: string;
}

/** 主题：token → 色卡 */
export interface Theme {
  name: string;
  tokens: Record<ColorToken, ColorSpec>;
}

/** dark 主题：对齐 Claude Code dark 配色
 *  - brand 用 claude 橙（rgb(215,119,87)），是 Claude 的标志性品牌色
 *  - accent 用 permission 浅蓝紫（rgb(177,185,249)），比 cyan 柔和现代
 *  - text 用浅灰（rgb(230,230,230)）而非纯白，降低长时间阅读刺眼感
 *  ansi16 降级保持原 mi-code 风格（视觉接近）。 */
export const darkTheme: Theme = {
  name: 'dark',
  tokens: {
    // 主强调：浅蓝紫（Claude Code permission/suggestion）
    accent:   { rgb: [177, 185, 249], ansi16: 'cyan' },
    // 品牌色：claude 橙（Claude Code claude token）
    brand:    { rgb: [215, 119, 87],  ansi16: 'magenta' },
    // 成功：亮绿（Claude Code success）
    success:  { rgb: [78, 186, 101],  ansi16: 'green' },
    // 警告：琥珀黄（Claude Code warning）
    warn:     { rgb: [255, 193, 7],   ansi16: 'yellow' },
    // 错误：亮红（Claude Code error）
    error:    { rgb: [255, 107, 128], ansi16: 'red' },
    // 低调灰：中灰（Claude Code inactive）
    muted:    { rgb: [153, 153, 153], ansi16: 'gray' },
    // 主文本：浅灰（非纯白，降刺眼）
    text:     { rgb: [230, 230, 230], ansi16: '' },
    // 输入提示符：亮绿（与 success 同源，❯ 用绿色是终端传统）
    prompt:   { rgb: [78, 186, 101],  ansi16: 'green' },
    // 边框：中灰（Claude Code promptBorder rgb(136,136,136)）
    border:   { rgb: [136, 136, 136], ansi16: 'gray' },
  },
};

/** 主题注册表：name → Theme */
export const THEME_REGISTRY = new Map<string, Theme>([
  ['dark', darkTheme],
]);

let activeTheme: Theme = darkTheme;

/** 获取当前激活主题 */
export function getTheme(): Theme {
  return activeTheme;
}

/** 切换激活主题。成功返回 true；主题不存在返回 false 且不改变当前主题。 */
export function setTheme(name: string): boolean {
  const t = THEME_REGISTRY.get(name);
  if (!t) return false;
  activeTheme = t;
  return true;
}

/** 把 semantic token 解析成 RGB 三元组。未知 token 返回 null。 */
export function resolveTokenRgb(token: ColorToken): Rgb | null {
  const spec = activeTheme.tokens[token];
  return spec ? spec.rgb : null;
}

/** 把 semantic token 解析成 16 色 ANSI 命名（colors.ts FG_MAP 的 key）。
 *  未知 token 或 text（默认前景）返回空串。 */
export function resolveTokenAnsi16(token: ColorToken): string {
  const spec = activeTheme.tokens[token];
  return spec ? spec.ansi16 : '';
}

/** @deprecated 用 resolveTokenRgb / resolveTokenAnsi16 代替。保留兼容旧测试。 */
export function resolveToken(token: ColorToken): string {
  return resolveTokenAnsi16(token);
}
