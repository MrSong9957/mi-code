// src/commands/suggestion-data.ts
// Slash 命令的富数据源：命令名 + 描述 + 参数提示 + 分组。

import type { TranslationKey, Translator } from '../locale/types.js';

/** 命令分组（内部稳定键） */
export type CommandGroup = 'Config' | 'Mode' | 'Skills' | 'Session';

/** 下拉菜单候选项（对标 Claude Code SuggestionItem） */
export interface SuggestionItem {
  /** 命令名，如 'compact' */
  name: string;
  /** 描述 */
  description: string;
  /** 参数提示，如 '<name>'；无参数则省略 */
  argHint?: string;
  /** 内部分组键 */
  group: CommandGroup;
  /** 对用户显示的分组名 */
  groupLabel?: string;
}

interface CommandSuggestionDefinition {
  name: string;
  description: string;
  descriptionKey: TranslationKey;
  argHint?: string;
  group: CommandGroup;
}

const COMMAND_DEFINITIONS: readonly CommandSuggestionDefinition[] = Object.freeze([
  { name: 'config',   description: 'Show or set configuration',                descriptionKey: 'commands.suggestions.config',   argHint: '[set <key> <value>]', group: 'Config' },
  { name: 'login',    description: 'Set API key for a provider',               descriptionKey: 'commands.suggestions.login',    argHint: '<provider> <api-key>', group: 'Config' },
  { name: 'provider', description: 'Switch provider',                          descriptionKey: 'commands.suggestions.provider', argHint: '[name]', group: 'Config' },
  { name: 'model',    description: 'Switch model',                             descriptionKey: 'commands.suggestions.model',    argHint: '[name]', group: 'Config' },
  { name: 'theme',    description: 'Switch theme',                             descriptionKey: 'commands.suggestions.theme',    argHint: '<dark|light>', group: 'Config' },
  { name: 'language', description: 'Show current language or switch UI language', descriptionKey: 'commands.suggestions.language', argHint: '[lang]', group: 'Config' },
  { name: 'build',    description: 'Standard mode: writes ask confirmation',   descriptionKey: 'commands.suggestions.build',    group: 'Mode' },
  { name: 'plan',     description: 'Plan mode: read-only',                     descriptionKey: 'commands.suggestions.plan',     group: 'Mode' },
  { name: 'auto',     description: 'Auto mode: everything allowed',            descriptionKey: 'commands.suggestions.auto',     group: 'Mode' },
  { name: 'skill',    description: 'Manage skills',                            descriptionKey: 'commands.suggestions.skill',    argHint: '<list|off|retry>', group: 'Skills' },
  { name: 'trigger',  description: 'Trigger or block a skill',                 descriptionKey: 'commands.suggestions.trigger',  argHint: '<name>', group: 'Skills' },
  { name: 'y',        description: 'Confirm pending skill',                    descriptionKey: 'commands.suggestions.y',        group: 'Skills' },
  { name: 'n',        description: 'Skip pending skill',                       descriptionKey: 'commands.suggestions.n',        group: 'Skills' },
  { name: 'edit',     description: 'Feedback on pending skill',                descriptionKey: 'commands.suggestions.edit',     argHint: '<feedback>', group: 'Skills' },
  { name: 'compact',  description: 'Trigger context compaction',               descriptionKey: 'commands.suggestions.compact',  group: 'Session' },
  { name: 'image',    description: 'Attach image (file or clipboard)',         descriptionKey: 'commands.suggestions.image',    argHint: '<path> [text]', group: 'Session' },
  { name: 'help',     description: 'Show available commands',                  descriptionKey: 'commands.suggestions.help',     group: 'Session' },
]);

function groupLabelKey(group: CommandGroup): TranslationKey {
  switch (group) {
    case 'Config':
      return 'commands.groups.config';
    case 'Mode':
      return 'commands.groups.mode';
    case 'Skills':
      return 'commands.groups.skills';
    case 'Session':
      return 'commands.groups.session';
  }
}

export function getCommandGroupLabel(group: CommandGroup, translator: Translator): string {
  return translator.t(groupLabelKey(group));
}

export function getCommandSuggestions(translator: Translator): readonly SuggestionItem[] {
  return Object.freeze(
    COMMAND_DEFINITIONS.map((definition) => ({
      name: definition.name,
      description: translator.t(definition.descriptionKey),
      argHint: definition.argHint,
      group: definition.group,
      groupLabel: getCommandGroupLabel(definition.group, translator),
    })),
  );
}

/** 下拉菜单渲染的向后兼容静态真相源（保持英文 fallback） */
export const COMMAND_SUGGESTIONS: readonly SuggestionItem[] = Object.freeze(
  COMMAND_DEFINITIONS.map(({ name, description, argHint, group }) => ({
    name,
    description,
    argHint,
    group,
  })),
);

/** 向后兼容：命令名纯字符串数组 */
export const COMMAND_NAMES: readonly string[] = Object.freeze(
  COMMAND_DEFINITIONS.map((suggestion) => suggestion.name),
);

export function buildHelpMessage(translator: Translator): string {
  const suggestions = getCommandSuggestions(translator);
  const lines: string[] = [translator.t('commands.help.title')];
  let currentGroup: CommandGroup | null = null;

  for (const suggestion of suggestions) {
    if (suggestion.group !== currentGroup) {
      currentGroup = suggestion.group;
      lines.push('', `${suggestion.groupLabel ?? suggestion.group}:`);
    }

    const args = suggestion.argHint ? ` ${suggestion.argHint}` : '';
    lines.push(`  /${suggestion.name}${args}  ${suggestion.description}`);
    if (suggestion.name === 'image') {
      lines.push(`  /image [text]  ${suggestion.description}`);
    }
  }

  return lines.join('\n');
}
