// src/tui/state/spinner-verbs.ts
// Spinner 动词词库（spinner 区显示文字）。
//
// 对标 Claude Code 的 SPINNER_VERBS（spinnerVerbs.ts，204 个 -ing 动词）。
// 本项目精选词库——不追求全量 204，保证词感一致（-ing 现在进行时、首字母大写、
// 涵盖思考/创造/处理/分析等动作类型）。
//
// 每次 spinner 启动时随机选一个，整个 turn 不变（对标 Claude Code 的
// `const [randomVerb] = useState(() => sample(getSpinnerVerbs()))`）。
//
// settings 覆盖钩子（getSpinnerVerbs）预留：默认返回内置词库副本，
// 后续可接入用户配置（replace/追加模式，对标 spinnerVerbs.ts:3-12）。

/** 精选动词词库（-ing 现在进行时，首字母大写） */
export const SPINNER_VERBS = [
  // 思考类
  'Thinking', 'Pondering', 'Reflecting', 'Contemplating', 'Reasoning',
  'Analyzing', 'Considering', 'Deliberating', 'Musing', 'Ruminating',
  // 创造类
  'Crafting', 'Building', 'Creating', 'Designing', 'Constructing',
  'Generating', 'Composing', 'Shaping', 'Forging', 'Assembling',
  // 处理类
  'Processing', 'Computing', 'Calculating', 'Crunching', 'Parsing',
  'Compiling', 'Resolving', 'Evaluating', 'Investigating', 'Exploring',
  // 行动类
  'Working', 'Tackling', 'Solving', 'Figuring', 'Unraveling',
  'Navigating', 'Tracing', 'Hunting', 'Digging', 'Searching',
] as const;

/**
 * 从词库均匀随机选一个动词（对标 Claude Code 的 lodash sample）。
 * 用 Math.random 实现，零依赖。
 */
export function sampleVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

/**
 * 获取词库（预留 settings 覆盖钩子）。
 *
 * 对标 Claude Code spinnerVerbs.ts:3-12：
 * - 默认：返回内置词库副本
 * - TODO: settings.spinnerVerbs（replace 模式替换 / 默认追加）
 *
 * 返回副本避免外部修改污染原库。
 */
export function getSpinnerVerbs(): string[] {
  return [...SPINNER_VERBS];
}
