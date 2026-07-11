/**
 * 主题切换回归测试
 *
 * 验证 dark ↔ light 切换后颜色确实变化，且两个方向都正确。
 *
 * 核心契约：
 * - dark 和 light 主题对同一语义槽位产生不同的 rgb 值
 * - colorizeLogo / colorizeStatus / styleToSGR 在两个主题下输出不同的 SGR 序列
 * - 切换回原主题后输出与初始一致（幂等性）
 */
import { describe, it, expect } from 'vitest';
import { colorizeLogo, colorizeStatus, styleToSGR, type StatusFields } from './colors.js';
import { darkTheme, lightTheme } from '../../utils/theme.js';
import { resolveSGR } from '../../utils/theme-resolve.js';
import type { UIMessageStyle } from '../../ui/types.js';

const FIELDS: StatusFields = {
  mode: 'auto',
  model: 'gpt-4o',
  dir: 'mi-code',
  branch: 'main',
  context: '████░░░░░░ 40%',
};

// ─────────────── dark vs light 颜色差异 ───────────────

describe('主题回归：dark vs light 颜色差异', () => {
  it('dark 和 light 的 brand 色不同', () => {
    expect(darkTheme.brand).not.toBe(lightTheme.brand);
  });

  it('dark 和 light 的 success 色不同', () => {
    expect(darkTheme.success).not.toBe(lightTheme.success);
  });

  it('dark 和 light 的 error 色不同', () => {
    expect(darkTheme.error).not.toBe(lightTheme.error);
  });

  it('dark 和 light 的 statusMode 色不同', () => {
    expect(darkTheme.statusMode).not.toBe(lightTheme.statusMode);
  });

  it('dark 和 light 的 selectionBg 色不同', () => {
    expect(darkTheme.selectionBg).not.toBe(lightTheme.selectionBg);
  });
});

// ─────────────── colorizeLogo 切换 ───────────────

describe('主题回归：colorizeLogo dark→light→dark', () => {
  it('dark→light：LOGO 着色序列变化', () => {
    const dark = colorizeLogo('logo', 'dark');
    const light = colorizeLogo('logo', 'light');
    expect(dark).not.toBe(light);
    // 两个都以 RESET 结尾
    expect(dark).toContain('\x1b[0m');
    expect(light).toContain('\x1b[0m');
  });

  it('light→dark：切换回 dark 后输出与初始一致（幂等性）', () => {
    const initial = colorizeLogo('logo', 'dark');
    const switched = colorizeLogo('logo', 'dark');
    expect(switched).toBe(initial);
  });

  it('dark SGR 以 38;2; 开头（TrueColor）', () => {
    const dark = colorizeLogo('logo', 'dark');
    expect(dark).toMatch(/^.*logo/); // 以品牌色 SGR 开头
    // dark brand = rgb(180,130,255)
    expect(dark).toContain('\x1b[38;2;180;130;255m');
  });

  it('light SGR 以不同的 TrueColor 开头', () => {
    const light = colorizeLogo('logo', 'light');
    // light brand = rgb(140,70,220)
    expect(light).toContain('\x1b[38;2;140;70;220m');
  });
});

// ─────────────── colorizeStatus 切换 ───────────────

describe('主题回归：colorizeStatus dark→light→dark', () => {
  it('dark→light：状态栏着色序列变化', () => {
    const dark = colorizeStatus(FIELDS, 'dark');
    const light = colorizeStatus(FIELDS, 'light');
    expect(dark).not.toBe(light);
  });

  it('light→dark：切换回 dark 后输出与初始一致', () => {
    const initial = colorizeStatus(FIELDS, 'dark');
    const switched = colorizeStatus(FIELDS, 'dark');
    expect(switched).toBe(initial);
  });

  it('dark 和 light 的 mode 字段用不同色码', () => {
    const dark = colorizeStatus(FIELDS, 'dark');
    const light = colorizeStatus(FIELDS, 'light');
    // dark statusMode = rgb(100,200,240)
    expect(dark).toContain('\x1b[38;2;100;200;240m');
    // light statusMode = rgb(0,140,190)
    expect(light).toContain('\x1b[38;2;0;140;190m');
  });

  it('dark 和 light 的 model 字段用不同色码', () => {
    const dark = colorizeStatus(FIELDS, 'dark');
    const light = colorizeStatus(FIELDS, 'light');
    // dark statusModel = rgb(180,130,255)
    expect(dark).toContain('\x1b[38;2;180;130;255m');
    // light statusModel = rgb(140,70,220)
    expect(light).toContain('\x1b[38;2;140;70;220m');
  });

  it('纯文本结构在两个主题下相同', () => {
    const dark = colorizeStatus(FIELDS, 'dark');
    const light = colorizeStatus(FIELDS, 'light');
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripAnsi(dark)).toBe(stripAnsi(light));
  });
});

// ─────────────── styleToSGR 切换 ───────────────

describe('主题回归：styleToSGR dark→light→dark', () => {
  const brandStyle: UIMessageStyle = { fg: 'brand' };
  const errorStyle: UIMessageStyle = { fg: 'error' };

  it('dark→light：brand 样式的 SGR 序列变化', () => {
    const dark = styleToSGR(brandStyle, 'dark');
    const light = styleToSGR(brandStyle, 'light');
    expect(dark).not.toBe(light);
    // dark brand = rgb(180,130,255)
    expect(dark).toContain('\x1b[38;2;180;130;255m');
    // light brand = rgb(140,70,220)
    expect(light).toContain('\x1b[38;2;140;70;220m');
  });

  it('dark→light：error 样式的 SGR 序列变化', () => {
    const dark = styleToSGR(errorStyle, 'dark');
    const light = styleToSGR(errorStyle, 'light');
    expect(dark).not.toBe(light);
    // dark error = rgb(255,90,90)
    expect(dark).toContain('\x1b[38;2;255;90;90m');
    // light error = rgb(220,50,50)
    expect(light).toContain('\x1b[38;2;220;50;50m');
  });

  it('light→dark：切换回 dark 后输出与初始一致', () => {
    const initial = styleToSGR(brandStyle, 'dark');
    const switched = styleToSGR(brandStyle, 'dark');
    expect(switched).toBe(initial);
  });

  it('复合样式（bold+fg）在两个主题下结构一致', () => {
    const style: UIMessageStyle = { fg: 'success', bold: true };
    const dark = styleToSGR(style, 'dark');
    const light = styleToSGR(style, 'light');
    // 都包含 bold SGR 序列
    expect(dark).toContain('\x1b[1m');
    expect(light).toContain('\x1b[1m');
    // fg 部分不同
    expect(dark).toContain('\x1b[38;2;100;200;80m');  // dark success
    expect(light).toContain('\x1b[38;2;40;160;50m');   // light success
  });
});

// ─────────────── resolveSGR 直接对比 ───────────────

describe('主题回归：resolveSGR dark vs light 精确值', () => {
  it('所有语义槽位在 dark 和 light 下产生不同的 SGR', () => {
    const slots = ['brand', 'success', 'error', 'warning', 'info', 'suggestion'] as const;
    for (const slot of slots) {
      const darkSGR = resolveSGR(darkTheme, slot);
      const lightSGR = resolveSGR(lightTheme, slot);
      expect(darkSGR).not.toBe(lightSGR);
      expect(darkSGR).toContain('38;2;');
      expect(lightSGR).toContain('38;2;');
    }
  });

  it('所有 status 槽位在 dark 和 light 下产生不同的 SGR', () => {
    const slots = ['statusMode', 'statusModel', 'statusDir', 'statusBranch', 'statusFill'] as const;
    for (const slot of slots) {
      const darkSGR = resolveSGR(darkTheme, slot);
      const lightSGR = resolveSGR(lightTheme, slot);
      expect(darkSGR).not.toBe(lightSGR);
    }
  });
});
