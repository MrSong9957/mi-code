// 主题层：semantic token → 颜色名映射
//
// 物理本质：色票本。
// 每个语义角色（强调、错误、提示等）在色票本上占一格，写着一个颜色名。
// 组件代码只认"角色"（如 accent），不认具体颜色（如 cyan）。
// 换主题 = 换一本色票本，所有组件自动跟随变色。
//
// 当前只内置 dark 一套，但 Theme 接口 + THEME_REGISTRY 为未来多主题留扩展点。

/** semantic token：语义化的颜色角色名 */
export type ColorToken =
  | 'accent'   // 主强调（边框 / 状态栏 / 进度条 / spinner）
  | 'brand'    // 品牌色（assistant ● / banner）
  | 'success'  // 成功（提示符 / 工具完成 / 字符串）
  | 'warn'     // 警告（标题 / 数字 / 工具运行中）
  | 'error'    // 错误
  | 'muted'    // 低调（dim 同义）
  | 'text'     // 默认前景（空 = 无 fg 码）
  | 'prompt'   // 输入提示符
  | 'border';  // 边框

/** 主题：token → 颜色名（colors.ts FG_MAP 的 key，如 'cyan' / 'green'） */
export interface Theme {
  name: string;
  /** token → 颜色名（空串表示"无 fg 码"，用终端默认前景） */
  tokens: Record<ColorToken, string>;
}

/** dark 主题：视觉与改造前完全一致（仅 token 化，不改颜色） */
export const darkTheme: Theme = {
  name: 'dark',
  tokens: {
    accent: 'cyan',
    brand: 'magenta',
    success: 'green',
    warn: 'yellow',
    error: 'red',
    muted: 'gray',
    text: '',
    prompt: 'green',
    border: 'gray',
  },
};

/** 主题注册表：name → Theme。未来加 light / ansi 等主题往这里塞。 */
export const THEME_REGISTRY = new Map<string, Theme>([
  ['dark', darkTheme],
]);

/** 当前激活主题（模块级单例，测试用 setTheme 切换） */
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

/** 把 semantic token 解析成颜色名（如 'accent' → 'cyan'）。
 *  未知 token 返回空串（= 无 fg 码，终端默认前景）。 */
export function resolveToken(token: ColorToken): string {
  return activeTheme.tokens[token] ?? '';
}
