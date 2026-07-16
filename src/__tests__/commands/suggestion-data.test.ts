// src/__tests__/commands/suggestion-data.test.ts
// COMMAND_SUGGESTIONS 数据完整性测试

import { describe, it, expect } from 'vitest';
import { COMMAND_SUGGESTIONS, COMMAND_NAMES, type CommandGroup } from '../../commands/suggestion-data.js';

describe('COMMAND_SUGGESTIONS', () => {
  it('每项有 name + description + group', () => {
    for (const s of COMMAND_SUGGESTIONS) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.group).toBeTruthy();
    }
  });

  it('name 无重复', () => {
    const names = COMMAND_SUGGESTIONS.map(s => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('分组只含预定义值', () => {
    const validGroups: CommandGroup[] = ['Config', 'Mode', 'Skills', 'Session'];
    for (const s of COMMAND_SUGGESTIONS) {
      expect(validGroups).toContain(s.group);
    }
  });

  it('四个分组都有命令', () => {
    const groups = new Set(COMMAND_SUGGESTIONS.map(s => s.group));
    expect(groups.has('Config')).toBe(true);
    expect(groups.has('Mode')).toBe(true);
    expect(groups.has('Skills')).toBe(true);
    expect(groups.has('Session')).toBe(true);
  });

  it('同分组命令相邻(分组内连续)', () => {
    const groups = COMMAND_SUGGESTIONS.map(s => s.group);
    let prev = groups[0];
    for (let i = 1; i < groups.length; i++) {
      if (groups[i] !== prev) {
        // 组变化后,后续不应再出现旧组(严格分组)
        for (let j = i + 1; j < groups.length; j++) {
          if (groups[j] === prev) {
            throw new Error(`分组 ${prev} 在位置 ${i} 后再次出现在位置 ${j},分组不连续`);
          }
        }
        prev = groups[i]!;
      }
    }
  });
});

describe('COMMAND_NAMES(向后兼容)', () => {
  it('从 COMMAND_SUGGESTIONS 派生,长度一致', () => {
    expect(COMMAND_NAMES.length).toBe(COMMAND_SUGGESTIONS.length);
  });

  it('内容与 COMMAND_SUGGESTIONS.name 一致', () => {
    for (let i = 0; i < COMMAND_SUGGESTIONS.length; i++) {
      expect(COMMAND_NAMES[i]).toBe(COMMAND_SUGGESTIONS[i]!.name);
    }
  });

  it('包含关键命令(config/model/help/theme/image)', () => {
    expect(COMMAND_NAMES).toContain('config');
    expect(COMMAND_NAMES).toContain('model');
    expect(COMMAND_NAMES).toContain('help');
    expect(COMMAND_NAMES).toContain('theme');
    expect(COMMAND_NAMES).toContain('image');
  });
});
