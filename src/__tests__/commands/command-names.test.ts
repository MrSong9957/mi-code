// src/__tests__/commands/command-names.test.ts
// COMMAND_NAMES 必须覆盖 executor switch 的所有 case

import { describe, it, expect } from 'vitest';
import { COMMAND_NAMES } from '../../commands/executor.js';

describe('COMMAND_NAMES（命令名单一真相源）', () => {
  it('包含核心命令', () => {
    for (const name of ['config', 'login', 'provider', 'model', 'compact', 'build', 'plan', 'auto', 'help', 'skill', 'trigger', 'y', 'n', 'edit']) {
      expect(COMMAND_NAMES, `缺少 ${name}`).toContain(name);
    }
  });

  it('不含重复', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length);
  });

  it('approve/reject 也包含（help 列出但 switch 特殊处理）', () => {
    // approve/reject 在 index.ts 特殊路径，但仍应可被 TAB 补全
    expect(COMMAND_NAMES).toContain('approve');
    expect(COMMAND_NAMES).toContain('reject');
  });
});
