// Spinner 动词词库与配置。
//
// SpinnerVerb 是一个 turn 级别的稳定值：启动时抽样一次，直到本轮结束都不变。
// 配置支持 append（默认）与 replace 两种模式，调用方只拿到副本，避免运行时污染词库。

import type { SpinnerVerbConfig as StoredSpinnerVerbConfig } from '../../config/schema.js';

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

/** 获取当前词库副本，支持用户追加或替换内置词库。 */
export function getSpinnerVerbs(config?: SpinnerVerbConfig): string[] {
  const configured = (config?.verbs ?? []).filter(isSpinnerVerb);
  const verbs = config?.mode === 'replace'
    ? configured
    : [...SPINNER_VERBS, ...configured];
  const unique = [...new Set(verbs)];
  return unique.length > 0 ? unique : [...SPINNER_VERBS];
}

/** 从当前词库均匀随机选一个动词。 */
export function sampleVerb(config?: SpinnerVerbConfig): string {
  const verbs = getSpinnerVerbs(config);
  return verbs[Math.floor(Math.random() * verbs.length)] ?? 'Thinking';
}
