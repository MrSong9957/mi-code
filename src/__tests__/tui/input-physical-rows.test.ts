// src/__tests__/tui/input-physical-rows.test.ts
// 物理行模型测试。随 Step 2 起逐步累积。
//
// Step 2:prompt/continuation 常量导出。
// 契约:宽度由 stringWidth(字符串) 计算,不硬编码——若 prompt 改样式,宽度自动跟随。

import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  PROMPT,
  CONTINUATION_INDENT,
  PROMPT_WIDTH,
  CONTINUATION_INDENT_WIDTH,
} from '../../tui/state/input-viewport.js';

describe('prompt/continuation 常量与宽度(从字符串计算,非硬编码)', () => {
  it('PROMPT / CONTINUATION_INDENT 字符串值', () => {
    expect(PROMPT).toBe('❯ ');
    expect(CONTINUATION_INDENT).toBe('  ');
  });

  it('PROMPT_WIDTH = stringWidth(PROMPT),非硬编码', () => {
    expect(PROMPT_WIDTH).toBe(stringWidth(PROMPT));
    expect(PROMPT_WIDTH).toBeGreaterThan(0);
  });

  it('CONTINUATION_INDENT_WIDTH = stringWidth(CONTINUATION_INDENT),非硬编码', () => {
    expect(CONTINUATION_INDENT_WIDTH).toBe(stringWidth(CONTINUATION_INDENT));
    expect(CONTINUATION_INDENT_WIDTH).toBeGreaterThan(0);
  });
});
