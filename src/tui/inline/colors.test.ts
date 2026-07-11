/**
 * 色板模块单元测试
 *
 * 主题驱动配色方案（TrueColor SGR）：
 *   mode    → theme.statusMode
 *   model   → theme.statusModel
 *   dir     → theme.statusDir
 *   branch  → theme.statusBranch
 *   context → theme.statusFill
 *   LOGO    → theme.brand
 *
 * 物理模型（染色印章）：
 *   resolveSGR(theme, 'brand') 是印章的"品牌印泥"
 *   RESET 是"橡皮擦"——印完必须擦干净，否则颜色泄漏到分隔符
 *   colorize = 蘸印泥盖章 + 立即擦除，形成完整的着色包裹
 */
import { describe, it, expect } from 'vitest';
import {
  RESET,
  cyanBright,
  magentaBright,
  yellowBright,
  greenBright,
  blueBright,
  colorize,
  colorizeLogo,
  colorizeStatus,
  type StatusFields,
} from './colors.js';
import { darkTheme } from '../../utils/theme.js';
import { resolveSGR } from '../../utils/theme-resolve.js';

// 预计算 dark theme 的 TrueColor SGR 序列
const BRAND_SGR = resolveSGR(darkTheme, 'brand');
const STATUS_MODE_SGR = resolveSGR(darkTheme, 'statusMode');
const STATUS_MODEL_SGR = resolveSGR(darkTheme, 'statusModel');
const STATUS_DIR_SGR = resolveSGR(darkTheme, 'statusDir');
const STATUS_BRANCH_SGR = resolveSGR(darkTheme, 'statusBranch');
const STATUS_FILL_SGR = resolveSGR(darkTheme, 'statusFill');

describe('色板模块 - SGR 常量（16色降级后备）', () => {
  it('RESET 是 SGR 0（所有属性归零）', () => {
    expect(RESET).toBe('\x1b[0m');
  });

  it('cyanBright 是 SGR 96（16色降级后备）', () => {
    expect(cyanBright).toBe('\x1b[96m');
  });

  it('magentaBright 是 SGR 95（16色降级后备）', () => {
    expect(magentaBright).toBe('\x1b[95m');
  });

  it('yellowBright 是 SGR 93（16色降级后备）', () => {
    expect(yellowBright).toBe('\x1b[93m');
  });

  it('greenBright 是 SGR 92（16色降级后备）', () => {
    expect(greenBright).toBe('\x1b[92m');
  });

  it('blueBright 是 SGR 94（16色降级后备）', () => {
    expect(blueBright).toBe('\x1b[94m');
  });
});

describe('colorize - 文本着色包裹', () => {
  it('前置色码 + 文本 + RESET 后缀', () => {
    expect(colorize(cyanBright, 'auto')).toBe('\x1b[96mauto\x1b[0m');
  });

  it('不同颜色生成不同前缀', () => {
    expect(colorize(magentaBright, 'gpt-4o')).toBe('\x1b[95mgpt-4o\x1b[0m');
    expect(colorize(yellowBright, 'mi-code')).toBe('\x1b[93mmi-code\x1b[0m');
    expect(colorize(greenBright, 'main')).toBe('\x1b[92mmain\x1b[0m');
    expect(colorize(blueBright, '████░░ 40%')).toBe('\x1b[94m████░░ 40%\x1b[0m');
  });

  it('空文本也被正确包裹（色码+reset）', () => {
    expect(colorize(cyanBright, '')).toBe('\x1b[96m\x1b[0m');
  });

  it('着色包裹完整：以色码开头、reset 结尾', () => {
    const result = colorize(greenBright, 'feat/branch');
    expect(result.startsWith('\x1b[92m')).toBe(true);
    expect(result.endsWith('\x1b[0m')).toBe(true);
    // 中间是原文
    expect(result).toContain('feat/branch');
  });
});

describe('colorizeLogo - LOGO 全行单色着色（TrueColor）', () => {
  it('整行用 theme.brand（TrueColor）包裹', () => {
    const line = ' ▐▛███▜▌   MiCode v1.0.0';
    expect(colorizeLogo(line)).toBe(`${BRAND_SGR} ▐▛███▜▌   MiCode v1.0.0${RESET}`);
  });

  it('三行 LOGO 各自独立着色（每行都有独立的色码和 reset）', () => {
    const lines = [
      ' ▐▛███▜▌   MiCode v1.0.0',
      '▝▜█████▛▘  TypeScript CLI · Node.js Runtime',
      '  ▘▘ ▝▝    projects/mi-code',
    ];
    const colored = lines.map((line) => colorizeLogo(line));
    // 每行都以 brand SGR 开头、reset 结尾
    for (const c of colored) {
      expect(c.startsWith(BRAND_SGR)).toBe(true);
      expect(c.endsWith(RESET)).toBe(true);
    }
  });
});

describe('colorizeStatus - 状态栏 5 字段分色着色（TrueColor）', () => {
  const fields: StatusFields = {
    mode: 'auto',
    model: 'gpt-4o',
    dir: 'mi-code',
    branch: 'main',
    context: '████░░░░░░ 40%',
  };

  it('5 个字段分别用主题色，用 │ 分隔（分隔符不着色）', () => {
    const result = colorizeStatus(fields);
    // 分隔符 │ 不被颜色包裹（前后是 reset 和色码）
    expect(result).toContain(`${RESET} │ ${STATUS_MODEL_SGR}`); // mode 和 model 之间
    // 5 个字段各自的 TrueColor SGR
    expect(result).toContain(`${STATUS_MODE_SGR}auto${RESET}`);
    expect(result).toContain(`${STATUS_MODEL_SGR}gpt-4o${RESET}`);
    expect(result).toContain(`${STATUS_DIR_SGR}mi-code${RESET}`);
    expect(result).toContain(`${STATUS_BRANCH_SGR}main${RESET}`);
    expect(result).toContain(`${STATUS_FILL_SGR}████░░░░░░ 40%${RESET}`);
  });

  it('整体结构：mode │ model │ dir │ branch │ context', () => {
    const result = colorizeStatus(fields);
    // 去掉所有 ANSI 码后应是纯文本结构
    const plain = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toBe('auto │ gpt-4o │ mi-code │ main │ ████░░░░░░ 40%');
  });

  it('分隔符 │ 保持默认色（不被 SGR 包裹）', () => {
    const result = colorizeStatus(fields);
    // 分隔符前一定是 reset（前一字段的结尾），后一定是色码（后一字段的开头）
    const separators = result.split(' │ ');
    expect(separators.length).toBe(5); // 5 段 = 4 个分隔符
  });

  it('进度条和百分比作为整体用 statusFill 包裹', () => {
    const result = colorizeStatus({ ...fields, context: '██ 50%' });
    // context 整体被 statusFill 包裹，进度条和百分比不分开
    expect(result).toContain(`${STATUS_FILL_SGR}██ 50%${RESET}`);
  });

  it('不同字段值着色正确（值变化不影响色码分配）', () => {
    const result = colorizeStatus({
      mode: 'plan',
      model: 'claude-3',
      dir: 'other-project',
      branch: 'feat/x',
      context: '░░░░░░░░░░ 0%',
    });
    expect(result).toContain(`${STATUS_MODE_SGR}plan${RESET}`);
    expect(result).toContain(`${STATUS_MODEL_SGR}claude-3${RESET}`);
    expect(result).toContain(`${STATUS_DIR_SGR}other-project${RESET}`);
    expect(result).toContain(`${STATUS_BRANCH_SGR}feat/x${RESET}`);
    expect(result).toContain(`${STATUS_FILL_SGR}░░░░░░░░░░ 0%${RESET}`);
  });
});
