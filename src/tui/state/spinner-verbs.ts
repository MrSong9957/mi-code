// Spinner 动词词库与配置。
//
// SpinnerVerb 是一个 turn 级别的稳定值：启动时抽样一次，直到本轮结束都不变。
// 配置支持 append（默认）与 replace 两种模式，调用方只拿到副本，避免运行时污染词库。
//
// i18n：内置词库按 Language 选择。
//   - en-US：直接复用本文件的 SPINNER_VERBS 常量（单一数据源，避免与 en-US.ts 数组双写）。
//   - zh-CN：读取 zhCN.spinner.builtinVerbs。
//   - 未传 language：英文 SPINNER_VERBS（向后兼容旧测试与不需要本地化的调用点）。
//
// 不再通过探测 translator 字符串推断语言——Language 本身就是干净的真实来源，
// 且不会因 spinner.thinking 文案被改写而错选词库。

import type { SpinnerVerbConfig as StoredSpinnerVerbConfig } from '../../config/schema.js';
import type { Language } from '../../locale/types.js';
import { zhCN } from '../../locale/resources/zh-CN.js';

/** Claude Code 风格的 Spinner 动词配置。运行时字段允许省略以保持调用简洁。 */
export type SpinnerVerbConfig = Partial<StoredSpinnerVerbConfig>;

/** 内置 Spinner 动词词库（约 200 个，全部为首字母大写的 -ing 形式）。 */
export const SPINNER_VERBS = [
  // 思考与分析
  'Thinking', 'Pondering', 'Reflecting', 'Contemplating', 'Reasoning',
  'Analyzing', 'Considering', 'Deliberating', 'Musing', 'Ruminating',
  'Crystallizing', 'Brainstorming', 'Synthesizing', 'Visualizing',
  'Conceptualizing', 'Theorizing', 'Hypothesizing', 'Interpreting',
  'Inferring', 'Deducing', 'Inducing', 'Comparing', 'Contrasting',
  'Classifying', 'Prioritizing', 'Evaluating', 'Assessing', 'Reviewing',
  'Examining', 'Inspecting', 'Questioning', 'Clarifying', 'Deciding',
  'Determining', 'Discovering', 'Uncovering', 'Recognizing', 'Recalling',
  'Remembering', 'Imagining', 'Envisioning', 'Predicting', 'Estimating',
  'Calculating', 'Debating', 'Arguing', 'Probing',

  // 创造与组织
  'Crafting', 'Building', 'Creating', 'Designing', 'Constructing',
  'Generating', 'Composing', 'Shaping', 'Forging', 'Assembling',
  'Inventing', 'Developing', 'Prototyping', 'Modeling', 'Sketching',
  'Drafting', 'Writing', 'Rewriting', 'Editing', 'Refining',
  'Polishing', 'Tuning', 'Balancing', 'Arranging', 'Organizing',
  'Structuring', 'Sequencing', 'Grouping', 'Mapping', 'Charting',
  'Planning', 'Preparing', 'Designating', 'Naming', 'Defining',
  'Describing', 'Documenting', 'Explaining', 'Illustrating', 'Translating',
  'Adapting', 'Simplifying', 'Generalizing', 'Specializing', 'Personalizing',

  // 处理与计算
  'Processing', 'Computing', 'Crunching', 'Parsing', 'Compiling',
  'Resolving', 'Investigating', 'Exploring', 'Working', 'Tackling',
  'Solving', 'Figuring', 'Unraveling', 'Navigating', 'Tracing',
  'Hunting', 'Digging', 'Searching', 'Scanning', 'Indexing',
  'Filtering', 'Sorting', 'Matching', 'Joining', 'Merging',
  'Splitting', 'Extracting', 'Converting', 'Encoding', 'Decoding',
  'Tokenizing', 'Validating', 'Checking', 'Testing',
  'Proving', 'Verifying', 'Measuring', 'Counting', 'Aggregating',
  'Summarizing', 'Reducing', 'Expanding', 'Transforming', 'Migrating',

  // 工程与代码
  'Coding', 'Programming', 'Refactoring', 'Debugging', 'Fixing',
  'Patching', 'Branching', 'Committing',
  'Deploying', 'Releasing', 'Versioning', 'Packaging', 'Bundling',
  'Linking', 'Transpiling', 'Minifying',
  'Linting', 'Formatting', 'Typechecking', 'Annotating', 'Instrumenting',
  'Profiling', 'Benchmarking', 'Optimizing', 'Caching', 'Buffering',
  'Queueing', 'Scheduling', 'Parallelizing', 'Synchronizing', 'Locking',
  'Unlocking', 'Mounting', 'Unmounting', 'Connecting', 'Disconnecting',
  'Listening', 'Routing', 'Serving', 'Streaming', 'Uploading',
  'Downloading', 'Fetching', 'Sending', 'Receiving', 'Polling',

  // 协作与交互
  'Consulting', 'Discussing', 'Collaborating', 'Coordinating', 'Delegating',
  'Negotiating', 'Communicating', 'Responding', 'Answering', 'Asking',
  'Suggesting', 'Recommending', 'Guiding', 'Helping', 'Teaching',
  'Browsing', 'Reading', 'Looking', 'Watching',
  'Noticing', 'Following', 'Leading', 'Tracking',
  'Monitoring', 'Observing', 'Waiting', 'Retrying', 'Resuming',
  'Continuing', 'Finishing', 'Completing', 'Delivering', 'Sharing',
  'Presenting', 'Demonstrating', 'Celebrating', 'Improving', 'Learning',
  'Adventuring', 'Wandering', 'Warming', 'Brewing', 'Cooking',
  'Baking', 'Churning', 'Cogitating', 'Sautéing', 'Wondering',
] as const;

function isSpinnerVerb(value: string): boolean {
  return /^[A-Z].*ing$/.test(value);
}

/**
 * 按 Language 返回对应内置动词词库的副本。
 *
 * - language 缺省：英文 SPINNER_VERBS（向后兼容旧调用点）。
 * - 'en-US'：直接返回 SPINNER_VERBS 副本（单一数据源；en-US.ts 中的数组仅作
 *   资源结构对齐/独立可读，运行时不作为英文词库来源）。
 * - 'zh-CN'：返回 zhCN.spinner.builtinVerbs 副本。
 */
function builtinVerbsFor(language: Language | undefined): string[] {
  if (language === 'en-US') return [...SPINNER_VERBS];
  if (language === 'zh-CN') return [...zhCN.spinner.builtinVerbs];
  // undefined 或任何未知值：英文回退（向后兼容）。
  return [...SPINNER_VERBS];
}

/**
 * 获取当前词库副本，支持用户追加或替换内置词库。
 *
 * 当 language 缺省时，内置词库使用英文 SPINNER_VERBS（向后兼容）。
 */
export function getSpinnerVerbs(
  config?: SpinnerVerbConfig,
  language?: Language,
): string[] {
  const configured = (config?.verbs ?? []).filter(isSpinnerVerb);
  const builtins = builtinVerbsFor(language);
  const verbs = config?.mode === 'replace'
    ? configured
    : [...builtins, ...configured];
  const unique = [...new Set(verbs)];
  return unique.length > 0 ? unique : builtins;
}

/**
 * 从当前词库均匀随机选一个动词。
 *
 * - replace 模式 + 配置 verbs：直接从配置词库抽样（用户数据，不翻译）。
 * - append 模式 + 配置 verbs：从 [内置 + 配置] 合并词库抽样。
 * - 无配置或配置为空：从内置词库抽样（按 language，缺省英文）。
 *
 * 注意：configured/custom 动词一律原样返回（它们是用户数据）。
 */
export function sampleVerb(config?: SpinnerVerbConfig, language?: Language): string {
  const verbs = getSpinnerVerbs(config, language);
  return verbs[Math.floor(Math.random() * verbs.length)] ?? 'Thinking';
}
