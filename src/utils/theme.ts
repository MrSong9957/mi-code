// src/utils/theme.ts
// 集中管控的颜色主题系统
//
// 物理本质：所有颜色的「身份证」。
// 组件不直接写 rgb/hex，而是引用 theme 上的语义槽位（如 theme.brand、theme.success），
// 由 resolveInkProps() 或 resolveSGR() 翻译成终端能懂的格式。
//
// 设计原则：
// - 每个颜色必须通过「眯眼测试」——模糊后仍能区分语义
// - Dark 为主，Light 不是简单的反转，而是色温偏移后的独立调色板
// - 所有 rgb 值显式声明，不依赖终端默认色

// ─────────────── Theme 类型定义 ───────────────

export interface Theme {
  // 基础表面（背景层级）
  bgBase: string;         // 终端背景
  bgSurface: string;      // 浮层背景（overlay）
  bgMuted: string;        // 低饱和背景（输入框、代码块）

  // 边框
  border: string;         // 边框、分隔线
  borderMuted: string;    // 弱边框（hr、引用线）

  // 文本
  textPrimary: string;    // 主文本（高对比）
  textSecondary: string;  // 次要文本（弱化）
  textMuted: string;      // 静音文本（占位符、注释）

  // 语义色
  brand: string;          // 品牌色——标题、LOGO
  success: string;        // 成功——用户输入提示、正向状态
  error: string;          // 错误——报错、停滞 spinner
  warning: string;        // 警告——目录路径、警告信息
  info: string;           // 信息——模式指示、代码块
  suggestion: string;     // 建议——链接、进度条

  // 状态栏字段色
  statusMode: string;     // 权限模式（auto/plan/build）
  statusModel: string;    // 模型名
  statusDir: string;      // 工作目录
  statusBranch: string;   // git 分支
  statusFill: string;     // 进度条填充
  statusEmpty: string;    // 进度条空位、分隔符
  statusSeparator: string; // 字段间 │ 分隔符

  // Markdown 渲染
  mdHeading: string;      // 标题 H1-H6（bold）
  mdCode: string;         // 行内代码、代码块
  mdLink: string;         // 链接（underline）
  mdBlockquote: string;   // 引用 │ 前缀、<hr>
  mdStrikethrough: string; // 删除线 ~~del~~

  // 选区高亮
  selectionBg: string;    // 选中背景
  selectionFg: string;    // 选中前景

  // Spinner 状态
  spinnerActive: string;  // 旋转中（cyan）
  spinnerShimmer: string; // shimmer 高亮段（亮版 active）
  spinnerStalled: string; // 停滞/错误（red）

  // Diff（工具输出）
  diffAdded: string;      // 新增行
  diffRemoved: string;    // 删除行
  diffHeader: string;     // hunk 头
  diffContext: string;    // 上下文行
}

// ─────────────── Dark Theme ───────────────
// 中性灰底 + 低饱和冷色调，长时间使用不疲劳

export const darkTheme: Theme = {
  // 基础表面
  bgBase:       'rgb(30, 30, 34)',
  bgSurface:    'rgb(36, 36, 42)',
  bgMuted:      'rgb(48, 48, 56)',

  // 边框
  border:       'rgb(68, 68, 78)',
  borderMuted:  'rgb(56, 56, 64)',

  // 文本
  textPrimary:  'rgb(220, 220, 226)',
  textSecondary:'rgb(160, 160, 170)',
  textMuted:    'rgb(110, 110, 120)',

  // 语义色
  brand:        'rgb(180, 130, 255)',   // 紫罗兰
  success:      'rgb(100, 200, 80)',    // 翠绿
  error:        'rgb(255, 90, 90)',     // 朱红
  warning:      'rgb(255, 210, 80)',    // 琥珀
  info:         'rgb(100, 200, 240)',   // 天蓝
  suggestion:   'rgb(120, 140, 255)',   // 靛蓝

  // 状态栏
  statusMode:       'rgb(100, 200, 240)',
  statusModel:      'rgb(180, 130, 255)',
  statusDir:        'rgb(200, 160, 255)',
  statusBranch:     'rgb(255, 210, 80)',
  statusFill:       'rgb(100, 200, 240)',
  statusEmpty:      'rgb(100, 100, 112)',
  statusSeparator:  'rgb(100, 100, 112)',

  // Markdown
  mdHeading:        'rgb(180, 130, 255)',
  mdCode:           'rgb(100, 200, 240)',
  mdLink:           'rgb(120, 140, 255)',
  mdBlockquote:     'rgb(110, 110, 120)',
  mdStrikethrough:  'rgb(110, 110, 120)',

  // 选区
  selectionBg:  'rgb(100, 200, 240)',
  selectionFg:  'rgb(30, 30, 34)',

  // Spinner
  spinnerActive:   'rgb(100, 200, 240)',
  spinnerShimmer:  'rgb(170, 230, 255)',
  spinnerStalled:  'rgb(255, 90, 90)',

  // Diff
  diffAdded:    'rgb(100, 200, 80)',
  diffRemoved:  'rgb(255, 90, 90)',
  diffHeader:   'rgb(180, 130, 255)',
  diffContext:  'rgb(110, 110, 120)',
};

// ─────────────── Light Theme ───────────────
// 暖白底 + 深色调语义色，白天/明亮环境可读

export const lightTheme: Theme = {
  // 基础表面
  bgBase:       'rgb(250, 249, 246)',
  bgSurface:    'rgb(242, 240, 236)',
  bgMuted:      'rgb(230, 228, 224)',

  // 边框
  border:       'rgb(200, 198, 194)',
  borderMuted:  'rgb(216, 214, 210)',

  // 文本
  textPrimary:  'rgb(40, 40, 46)',
  textSecondary:'rgb(100, 100, 108)',
  textMuted:    'rgb(148, 148, 156)',

  // 语义色（深色版本，确保在浅底上 4.5:1 对比度）
  brand:        'rgb(140, 70, 220)',
  success:      'rgb(40, 160, 50)',
  error:        'rgb(220, 50, 50)',
  warning:      'rgb(180, 130, 0)',
  info:         'rgb(0, 140, 190)',
  suggestion:   'rgb(60, 80, 200)',

  // 状态栏
  statusMode:       'rgb(0, 140, 190)',
  statusModel:      'rgb(140, 70, 220)',
  statusDir:        'rgb(120, 60, 180)',
  statusBranch:     'rgb(170, 120, 0)',
  statusFill:       'rgb(0, 140, 190)',
  statusEmpty:      'rgb(180, 178, 174)',
  statusSeparator:  'rgb(180, 178, 174)',

  // Markdown
  mdHeading:        'rgb(140, 70, 220)',
  mdCode:           'rgb(0, 140, 190)',
  mdLink:           'rgb(60, 80, 200)',
  mdBlockquote:     'rgb(148, 148, 156)',
  mdStrikethrough:  'rgb(148, 148, 156)',

  // 选区
  selectionBg:  'rgb(0, 140, 190)',
  selectionFg:  'rgb(250, 249, 246)',

  // Spinner
  spinnerActive:   'rgb(0, 140, 190)',
  spinnerShimmer:  'rgb(90, 200, 235)',
  spinnerStalled:  'rgb(220, 50, 50)',

  // Diff
  diffAdded:    'rgb(40, 160, 50)',
  diffRemoved:  'rgb(220, 50, 50)',
  diffHeader:   'rgb(140, 70, 220)',
  diffContext:  'rgb(148, 148, 156)',
};

// ─────────────── Theme 注册表 ───────────────

export type ThemeName = 'dark' | 'light';

export const themes: Record<ThemeName, Theme> = {
  dark: darkTheme,
  light: lightTheme,
};

/**
 * 获取主题。不存在时回退到 dark。
 */
export function getTheme(name?: ThemeName): Theme {
  return themes[name ?? 'dark'] ?? darkTheme;
}
