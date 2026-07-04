// 主题层：语义化 token 集中管理
//
// 物理本质：色票本。每个语义角色（品牌色、文本、错误等）在色票本上占一格，
// 写着对应的 16 色 ANSI 名（如 'ansi:cyan'）。组件代码只认角色（如 brand），
// 不认具体颜色。换主题就是换一本色票本，所有组件自动跟随变色。
//
// 设计原则（必须遵守）：
// 1. 保持 cyan 主色：brand = cyan，mi-code 的品牌色
// 2. 保持 16 色 ANSI：不升级 truecolor/256，与现有渲染器兼容
// 3. 语义化命名：代码用 brand/success/error，不用 cyan/green/red

/** MiCode Theme 类型
 *  语义化 token，值是 16 色 ANSI 名（'ansi:cyan' / 'ansi:whiteBright' 等）。
 *  'ansi:' 前缀由 colors.ts 解析时剥除，映射到 FG_MAP。 */
export interface Theme {
  // 品牌色
  brand: string;           // 主色（cyan）
  brandDim: string;        // 主色的 dim 版本
  brandShimmer: string;    // 主色的亮化版本（spinner 动画用）

  // 文本色
  text: string;            // 正文文本
  textDim: string;         // dim 文本（注释、次要信息）
  subtle: string;          // 更淡的文本（状态栏）

  // 语义色
  success: string;         // 成功、完成
  error: string;           // 错误、失败
  warning: string;         // 警告、提醒
  info: string;            // 信息、提示

  // 边框色
  border: string;          // 普通边框
  borderFocused: string;   // 聚焦状态边框

  // 背景色（可选）
  background?: string;     // 输入框背景（undefined = 透明）
  backgroundFocused?: string;

  // 代码高亮
  codeKeyword?: string;
  codeString?: string;
  codeComment?: string;
  codeFunction?: string;
  codeNumber?: string;
  codeOperator?: string;
}

/** MiCode 暗色主题（默认）
 *  颜色值使用 ANSI 16 色名称，便于渲染器解析。
 *  保持 cyan 品牌色，与升级前视觉零变化。 */
export const dark: Theme = {
  // 品牌色
  brand: 'ansi:cyan',
  brandDim: 'ansi:cyanBright',
  brandShimmer: 'ansi:white',

  // 文本色
  text: 'ansi:white',
  textDim: 'ansi:blackBright',  // gray
  subtle: 'ansi:blackBright',

  // 语义色
  success: 'ansi:green',
  error: 'ansi:red',
  warning: 'ansi:yellow',
  info: 'ansi:blue',

  // 边框色
  border: 'ansi:cyan',
  borderFocused: 'ansi:white',

  // 背景色（透明）
  background: undefined,
  backgroundFocused: undefined,

  // 代码高亮
  codeKeyword: 'ansi:magenta',
  codeString: 'ansi:green',
  codeComment: 'ansi:blackBright',
  codeFunction: 'ansi:yellow',
  codeNumber: 'ansi:cyan',
  codeOperator: 'ansi:white',
};

/** 主题注册表：未来加主题只需在这里添加条目 */
export const THEME_REGISTRY: Record<string, Theme> = {
  dark,
  // light: lightTheme,       // 未来扩展
  // 'dark-ansi': darkAnsiTheme,
};

let activeThemeName = 'dark';
let activeTheme: Theme = dark;

/** 获取当前激活主题 */
export function getCurrentTheme(): Theme {
  return activeTheme;
}

/** 根据名称获取主题（不存在则回退 dark） */
export function getTheme(name: string): Theme {
  return THEME_REGISTRY[name] ?? THEME_REGISTRY.dark;
}

/** 切换激活主题。成功返回 true；主题不存在返回 false。 */
export function setTheme(name: string): boolean {
  const t = THEME_REGISTRY[name];
  if (!t) return false;
  activeTheme = t;
  activeThemeName = name;
  return true;
}

/** 获取当前主题名 */
export function getActiveThemeName(): string {
  return activeThemeName;
}

// ═══════ token 解析（向后兼容 colors.ts 的 fg/bg 接口） ═══════
//
// colors.ts 的 fg(token) 接受两种入参：
//  1. semantic token key（'brand' / 'error' / ...）→ 查当前主题
//  2. 直接 ANSI 名（'ansi:cyan' / 'cyan'）→ 直接用
// 返回值是 'ansi:xxx' 格式的字符串，由 colors.ts 剥 'ansi:' 前缀查 FG_MAP。

/** 把 semantic token 解析成 'ansi:xxx' 格式颜色名。
 *  未知 token 返回空串（= 无颜色码，默认前景）。
 *  非 token（已是 'ansi:xxx' 或 'cyan' 等直接颜色名）原样返回。 */
export function resolveThemeColor(token: string | undefined): string {
  if (!token) return '';
  // 已是 'ansi:xxx' 格式，原样返回
  if (token.startsWith('ansi:')) return token;
  // semantic token：查主题
  const t = activeTheme as Record<string, string | undefined>;
  const v = t[token];
  return v ?? '';
}
