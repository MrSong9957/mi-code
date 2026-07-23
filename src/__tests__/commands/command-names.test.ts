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

  it('不包含已由问卷替代的 approve/reject', () => {
    expect(COMMAND_NAMES).not.toContain('approve');
    expect(COMMAND_NAMES).not.toContain('reject');
  });
});
