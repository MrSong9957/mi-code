// src/commands/suggestion-data.ts
// 斜杠命令的富数据源:命令名 + 描述 + 参数提示 + 分组。
//
// COMMAND_NAMES(纯字符串数组)从这里派生,向后兼容。
// COMMAND_SUGGESTIONS 是下拉菜单渲染的单一真相源。

/** 命令分组(下拉菜单按此分组显示) */
export type CommandGroup = 'Config' | 'Mode' | 'Skills' | 'Session';

/** 下拉菜单候选项(对标 Claude Code SuggestionItem) */
export interface SuggestionItem {
  /** 命令名,如 'compact' */
  name: string;
  /** 描述,如 'Trigger context compaction' */
  description: string;
  /** 参数提示,如 '<name>';无参数则省略 */
  argHint?: string;
  /** 分组 */
  group: CommandGroup;
}

/**
 * 全部斜杠命令的富数据(单一真相源)。
 * 按 group 连续排列(Config → Mode → Skills → Session)。
 */
export const COMMAND_SUGGESTIONS: readonly SuggestionItem[] = Object.freeze([
  // Config
  { name: 'config',   description: 'Show or set configuration', argHint: '[set <key> <value>]', group: 'Config' },
  { name: 'login',    description: 'Set API key for a provider', argHint: '<provider> <api-key>', group: 'Config' },
  { name: 'provider', description: 'Switch provider', argHint: '[name]', group: 'Config' },
  { name: 'model',    description: 'Switch model', argHint: '[name]', group: 'Config' },
  { name: 'theme',    description: 'Switch theme', argHint: '<dark|light>', group: 'Config' },
  // Mode
  { name: 'build',    description: 'Standard mode: writes ask confirmation', group: 'Mode' },
  { name: 'plan',     description: 'Plan mode: read-only', group: 'Mode' },
  { name: 'auto',     description: 'Auto mode: everything allowed', group: 'Mode' },
  // Skills
  { name: 'skill',    description: 'Manage skills', argHint: '<list|off|retry>', group: 'Skills' },
  { name: 'trigger',  description: 'Trigger or block a skill', argHint: '<name>', group: 'Skills' },
  { name: 'y',        description: 'Confirm pending skill', group: 'Skills' },
  { name: 'n',        description: 'Skip pending skill', group: 'Skills' },
  { name: 'edit',     description: 'Feedback on pending skill', argHint: '<feedback>', group: 'Skills' },
  // Session
  { name: 'compact',  description: 'Trigger context compaction', group: 'Session' },
  { name: 'image',    description: 'Attach image (file or clipboard)', argHint: '<path> [text]', group: 'Session' },
  { name: 'help',     description: 'Show available commands', group: 'Session' },
]);

/** 向后兼容:命令名纯字符串数组(从 COMMAND_SUGGESTIONS 派生) */
export const COMMAND_NAMES: readonly string[] = Object.freeze(
  COMMAND_SUGGESTIONS.map(s => s.name),
);
