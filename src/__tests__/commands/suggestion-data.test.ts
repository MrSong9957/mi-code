// src/__tests__/commands/suggestion-data.test.ts
// COMMAND_SUGGESTIONS 数据完整性测试

import { describe, it, expect } from 'vitest';
import {
  buildHelpMessage,
  COMMAND_SUGGESTIONS,
  COMMAND_NAMES,
  getCommandSuggestions,
  type CommandGroup,
  type SuggestionItem,
} from '../../commands/suggestion-data.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import type { Language } from '../../locale/types.js';

function translatorFor(language: Language) {
  return createTranslator(createLanguageStore(language));
}

function suggestionByName(items: readonly SuggestionItem[], name: string): SuggestionItem {
  const item = items.find(s => s.name === name);
  if (!item) {
    throw new Error(`missing suggestion: ${name}`);
  }
  return item;
}

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

  it('不展示已由问卷替代的 approve/reject', () => {
    const names = COMMAND_SUGGESTIONS.map(s => s.name);
    expect(names).not.toContain('approve');
    expect(names).not.toContain('reject');
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

describe('localized command suggestion data', () => {
  it('localizes descriptions and group labels without changing names or arg hints', () => {
    const english = getCommandSuggestions(translatorFor('en-US'));
    const chinese = getCommandSuggestions(translatorFor('zh-CN'));

    expect(english.map(s => s.name)).toEqual(COMMAND_SUGGESTIONS.map(s => s.name));
    expect(chinese.map(s => s.name)).toEqual(COMMAND_SUGGESTIONS.map(s => s.name));
    expect(english.map(s => s.argHint)).toEqual(COMMAND_SUGGESTIONS.map(s => s.argHint));
    expect(chinese.map(s => s.argHint)).toEqual(COMMAND_SUGGESTIONS.map(s => s.argHint));

    expect(suggestionByName(english, 'theme')).toMatchObject({
      description: 'Switch theme',
      group: 'Config',
      groupLabel: 'Config',
      argHint: '<dark|light>',
    });
    expect(suggestionByName(chinese, 'theme')).toMatchObject({
      description: '切换主题',
      group: 'Config',
      groupLabel: '配置',
      argHint: '<dark|light>',
    });
  });

  it('localizes help text while preserving slash command names and arg hints', () => {
    const english = buildHelpMessage(translatorFor('en-US'));
    const chinese = buildHelpMessage(translatorFor('zh-CN'));

    expect(english).toContain('Available commands:');
    expect(english).toContain('/language [lang]  Show current language or switch UI language');
    expect(english).toContain('/image <path> [text]');
    expect(english).toContain('/image [text]');
    expect(chinese).toContain('/image <path> [text]');
    expect(chinese).toContain('/image [text]');
    expect(chinese).toContain('可用命令：');
    expect(chinese).toContain('/language [lang]  查看当前语言或切换界面语言');
    expect(chinese).toContain('/theme <dark|light>  切换主题');
  });
});
