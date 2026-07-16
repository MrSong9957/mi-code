// src/commands/model-options.ts
// 各 provider 的模型列表(硬编码预设 + 配置文件覆盖)。
//
// 用于 /model 交互式选择界面。
// 优先级:配置文件 providers[x].models > 硬编码预设 MODEL_OPTIONS。
// 用户可在 ~/.micode/config.json 里自定义模型列表,替换预设。

import type { SelectOption } from '../tui/state/select-store.js';

/** 各 provider 的预设模型(配置文件未指定 models 时回退到此) */
export const MODEL_OPTIONS: Record<string, SelectOption[]> = {
  anthropic: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', description: 'Balanced speed & intelligence' },
    { value: 'claude-opus-4-20250514', label: 'Claude Opus 4', description: 'Most intelligent' },
    { value: 'claude-haiku-4-20250506', label: 'Claude Haiku 4.5', description: 'Fastest' },
  ],
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o', description: 'OpenAI flagship' },
    { value: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Fast & affordable' },
    { value: 'o4-mini', label: 'o4-mini', description: 'Reasoning model' },
  ],
  google: [
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Fast & versatile' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Most capable' },
  ],
};

/**
 * 获取指定 provider 的模型列表。
 *
 * 优先级:
 *   1. 配置文件 providers[provider].models(用户自定义,完全替换预设)
 *   2. 硬编码预设 MODEL_OPTIONS
 *
 * 如果当前使用的模型不在列表中,自动添加到顶部(标记 "Current model")。
 *
 * @param provider provider 名称
 * @param currentModel 当前使用的模型 ID(可选)
 * @param configModels 配置文件里的 models 列表(可选,优先于预设)
 */
export function getModelsForProvider(
  provider: string,
  currentModel?: string,
  configModels?: Array<{ value: string; label: string; description?: string }>,
): SelectOption[] {
  // 优先用配置文件的 models,否则回退到硬编码预设
  const presets: SelectOption[] = configModels && configModels.length > 0
    ? configModels.map(m => ({ value: m.value, label: m.label, description: m.description }))
    : (MODEL_OPTIONS[provider] ?? []);

  if (!currentModel) return [...presets];

  // 当前模型不在列表 → 动态添加到顶部
  const inList = presets.some(o => o.value === currentModel);
  if (inList) return [...presets];

  return [
    { value: currentModel, label: currentModel, description: 'Current model' },
    ...presets,
  ];
}
