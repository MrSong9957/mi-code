// src/ui/tool-presentation.ts
//
// 结构化工具展示构建器:把工具调用的 input/output 转成 ToolPresentation 数据。
//
// 物理本质:工具结果的"语义化通道"。上游配对 call/result 后,本模块按工具类型
// 把原始字符串输出解析成结构化明细(DetailItem[])+ 单行 summary + 状态分类
// (success/empty/error)。渲染层只消费数据,不再做脆弱的字符串启发式。
//
// 复用既有边界(不重复造轮子):
// - 错误脱敏 → formatUnknownError(不自建第二个敏感字段正则)
// - spawn_agent 展示 → buildSubagentCompletionPresentation(legacy envelope 解析)
//
// 安全要求:绝不输出 bullet / 子字形 / 缩进 / ANSI / 堆栈 / [object Object];
// 畸形 input(如 pattern 为对象)走占位符降级,不产生 [object Object]。

import type {
  DetailItem,
  ToolPresentation,
  ToolPresentationStatus,
} from '../tui/transcript-types.js';
import { formatUnknownError } from '../utils/error-message.js';
import { buildSubagentCompletionPresentation } from './subagent-presentation.js';

/** 可分组的工具集合(同类工具多次调用可合并为一个 ToolBlock)。 */
const GROUPABLE_TOOLS = new Set<string>(['glob', 'grep', 'read_file']);

/** 工具别名:历史/口语名 → 规范名。 */
const TOOL_ALIASES: Record<string, string> = {
  read: 'read_file',
  search: 'glob',
};

/** 匹配工具错误输出前缀(对齐各工具 executor 的 'Error: ...' 约定)。 */
const ERROR_PREFIX = /^\s*Error:\s*/i;

/** ANSI 转义序列(展示前清除,避免污染单行 summary)。 */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** summary 的安全最大长度(summarizeOutput 截断阈值)。 */
const SUMMARY_MAX_LENGTH = 200;

/** buildToolPresentation 的输入。 */
export interface BuildToolPresentationInput {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: string;
  durationMs?: number;
}

/** 各工具分支共享的基础字段(再叠加 summary/details/...)。 */
interface PresentationBase {
  toolUseId: string;
  toolName: string;
  status: ToolPresentationStatus;
}

/**
 * 把工具名归一化为规范名:先查别名表,未命中则原样返回。
 * 例:read → read_file,search → glob,glob → glob。
 */
export function normalizeToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/**
 * 判断工具是否可分组:归一化后是否落在 GROUPABLE_TOOLS 内。
 * 副作用类工具(run_bash 等)永远不可分组。
 */
export function isGroupableTool(name: string): boolean {
  return GROUPABLE_TOOLS.has(normalizeToolName(name));
}

/**
 * 构建工具分组的展示标题(单复数随 count 变化)。
 * - glob/grep → `Searched N pattern(s)`
 * - read_file → `Read N item(s)`
 * - 其它 → `Ran N operation(s)`(理论不会被分组工具命中,仅兜底)
 */
export function buildToolGroupTitle(name: string, count: number): string {
  const normalized = normalizeToolName(name);
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  switch (normalized) {
    case 'glob':
    case 'grep':
      return `Searched ${n} ${n === 1 ? 'pattern' : 'patterns'}`;
    case 'read_file':
      return `Read ${n} ${n === 1 ? 'item' : 'items'}`;
    default:
      return `Ran ${n} ${n === 1 ? 'operation' : 'operations'}`;
  }
}

/**
 * 构建工具展示:按工具类型把 input/output 解析为 summary + details + status。
 *
 * 状态分类顺序(全局,先于工具分支):
 *  ① output 以 `Error:` 开头 → error(剥前缀后经 formatUnknownError 脱敏得到 errorMessage)
 *  ② trim 后为空 → empty
 *  ③ 否则 → success
 *
 * 工具分支:glob/grep/read_file 按各自契约解析结构化明细;spawn_agent 复用
 * buildSubagentCompletionPresentation;其余走通用 summarizeOutput 降级。
 * 畸形 input(pattern/path 为对象等)走占位符降级,绝不产生 [object Object]。
 */
export function buildToolPresentation(input: BuildToolPresentationInput): ToolPresentation {
  const { toolUseId, toolName, input: toolInput, output, durationMs } = input;
  const normalized = normalizeToolName(toolName);
  const classification = classifyStatus(output);
  const { status } = classification;
  const errorMessage = classification.errorMessage;

  const base: PresentationBase = { toolUseId, toolName, status };

  switch (normalized) {
    case 'glob':
      return buildGlobPresentation(base, toolInput, output, status, errorMessage);
    case 'grep':
      return buildGrepPresentation(base, toolInput, output, status, errorMessage);
    case 'read_file':
      return buildReadFilePresentation(base, toolInput, output, status, errorMessage);
    case 'spawn_agent':
      return buildSpawnAgentPresentation(
        base,
        toolInput,
        output,
        durationMs ?? 0,
        status,
        errorMessage,
      );
    default:
      return buildGenericPresentation(base, toolName, output, status, errorMessage);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 状态分类 + 错误脱敏
// ─────────────────────────────────────────────────────────────────────────────

interface StatusClassification {
  status: ToolPresentationStatus;
  /** error 状态下经 formatUnknownError 脱敏后的消息(已限长、敏感字段已替换)。 */
  errorMessage?: string;
}

/** 按 `Error:` 前缀 / 空 / 非空 判定状态;error 时剥前缀并脱敏。 */
function classifyStatus(output: string): StatusClassification {
  const match = output.match(ERROR_PREFIX);
  if (match) {
    const body = output.slice(match[0].length);
    return { status: 'error', errorMessage: sanitizeErrorBody(body) };
  }
  if (output.trim() === '') {
    return { status: 'empty' };
  }
  return { status: 'success' };
}

/**
 * 错误正文脱敏(复用 formatUnknownError,不自建敏感字段正则)。
 *
 * - 以 `{` 或 `[` 开头 → 尝试 JSON.parse 后交给 formatUnknownError
 *   (其内部 serializeObject 会把 apiKey/token 等敏感字段替换为 [REDACTED])
 * - 解析失败或非 JSON → 把纯字符串交给 formatUnknownError(限长)
 */
function sanitizeErrorBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return formatUnknownError(parsed);
    } catch {
      return formatUnknownError(trimmed);
    }
  }
  return formatUnknownError(trimmed);
}

// ─────────────────────────────────────────────────────────────────────────────
// 各工具专用的展示构建
// ─────────────────────────────────────────────────────────────────────────────

/** glob:每非空行一个文件路径;summary 统计文件数,空时提示 no matches。 */
function buildGlobPresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  status: ToolPresentationStatus,
  errorMessage: string | undefined,
): ToolPresentation {
  const pattern = asString(toolInput.pattern) ?? '<invalid pattern>';

  if (status === 'error') {
    return {
      ...base,
      summary: `${pattern} → failed: ${errorMessage}`,
      details: [],
      errorMessage,
    };
  }

  const lines = splitNonEmptyLines(output);
  if (status === 'empty' || lines.length === 0) {
    return { ...base, summary: `${pattern} → no matches`, details: [] };
  }

  const details: DetailItem[] = lines.map(
    (path): DetailItem => ({ kind: 'path', path }),
  );
  return {
    ...base,
    summary: `${pattern} → ${lines.length} ${lines.length === 1 ? 'file' : 'files'}`,
    details,
  };
}

/**
 * grep:每行 `path:line: text`,解析为 snippet 明细;解析失败的行降级为 text。
 * summary 形如 `TODO in src → 2 matches`。
 */
function buildGrepPresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  status: ToolPresentationStatus,
  errorMessage: string | undefined,
): ToolPresentation {
  const pattern = asString(toolInput.pattern) ?? '<invalid pattern>';
  const scope = asString(toolInput.path) ?? 'workspace';

  if (status === 'error') {
    return {
      ...base,
      summary: `${pattern} in ${scope} → failed: ${errorMessage}`,
      details: [],
      errorMessage,
    };
  }
  if (status === 'empty') {
    return { ...base, summary: `${pattern} in ${scope} → no matches`, details: [] };
  }

  const lines = splitNonEmptyLines(output);
  let matches = 0;
  const details: DetailItem[] = [];
  for (const line of lines) {
    const parsed = parseGrepLine(line);
    if (parsed) {
      matches += 1;
      details.push({
        kind: 'snippet',
        text: parsed.text,
        path: parsed.path,
        line: parsed.line,
      });
    } else {
      // 解析失败的行不丢弃,原样保留为 text 明细
      details.push({ kind: 'text', text: line });
    }
  }

  return {
    ...base,
    summary: `${pattern} in ${scope} → ${matches} ${matches === 1 ? 'match' : 'matches'}`,
    details,
  };
}

/** read_file:用 input.path 作语义标识;output 原样保留为单个 text 明细。 */
function buildReadFilePresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  status: ToolPresentationStatus,
  errorMessage: string | undefined,
): ToolPresentation {
  const path = asString(toolInput.path) ?? '<invalid path>';

  if (status === 'error') {
    return {
      ...base,
      summary: `${path} → failed: ${errorMessage}`,
      details: [],
      errorMessage,
    };
  }
  if (status === 'empty') {
    return { ...base, summary: path, details: [] };
  }

  return {
    ...base,
    summary: path,
    details: [{ kind: 'text', text: output }],
  };
}

/**
 * spawn_agent:复用 buildSubagentCompletionPresentation 解析 envelope,
 * 标记 `layout: 'compact-completion'` 让渲染层走紧凑完成样式。
 * output 就是 formatSubagentResult 的产物,直接传给 legacy 解析器;
 * envelope 未命中或状态非 success 时走通用降级。
 */
function buildSpawnAgentPresentation(
  base: PresentationBase,
  toolInput: Record<string, unknown>,
  output: string,
  durationMs: number,
  status: ToolPresentationStatus,
  errorMessage: string | undefined,
): ToolPresentation {
  if (status === 'error') {
    return {
      ...base,
      summary: `spawn_agent → failed: ${errorMessage}`,
      details: [],
      errorMessage,
    };
  }
  if (status === 'empty') {
    return { ...base, summary: 'spawn_agent → no output', details: [] };
  }

  const sub = buildSubagentCompletionPresentation(toolInput, output, durationMs);
  if (sub) {
    return {
      ...base,
      summary: sub.line.startsWith('● ') ? sub.line.slice(2) : sub.line,
      details: sub.fullOutput ? [{ kind: 'text', text: sub.fullOutput }] : [],
      layout: 'compact-completion',
    };
  }

  // envelope 未命中(formatSubagentResult 未产出标准信封)→ 通用降级
  return {
    ...base,
    summary: summarizeOutput(output),
    details: [{ kind: 'text', text: output }],
  };
}

/** 通用工具:不可分组,用安全的单行 summarizeOutput 作 summary。 */
function buildGenericPresentation(
  base: PresentationBase,
  toolName: string,
  output: string,
  status: ToolPresentationStatus,
  errorMessage: string | undefined,
): ToolPresentation {
  if (status === 'error') {
    return {
      ...base,
      summary: `${toolName} → failed: ${errorMessage}`,
      details: [],
      errorMessage,
    };
  }
  if (status === 'empty') {
    return { ...base, summary: `${toolName} → no output`, details: [] };
  }

  return {
    ...base,
    summary: summarizeOutput(output),
    details: [{ kind: 'text', text: output }],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 解析辅助
// ─────────────────────────────────────────────────────────────────────────────

/** 仅当值为字符串时返回,否则 null(避免 String({}) → [object Object])。 */
function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 按行拆分并去掉首尾空白与空行(用于 glob 文件列表 / grep 匹配列表)。 */
function splitNonEmptyLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 解析 grep 的单行 `path:line: text`。
 *
 * 契约来自 search-tools.ts:`${displayPath}:${lineNo}: ${lineContent}`。
 * 行号恒为数字;text 可能含 ':'(原行内容);相对路径下 path 罕见 ':'。
 * 用 /^(.+):(\d+): ?(.*)$/ 让 path 贪心匹配、行号锁定中间的纯数字段,
 * 即"从右往左"锁定 `:digits: ` 结构。解析失败返回 null(调用方降级为 text)。
 */
function parseGrepLine(
  line: string,
): { path: string; line: number; text: string } | null {
  const match = line.match(/^(.+):(\d+): ?(.*)$/);
  if (!match) return null;
  const [, pathStr, lineStr, text] = match;
  return { path: pathStr!, line: Number(lineStr!), text: text! };
}

/**
 * 把任意输出压缩成安全的单行 summary:
 * - 剥 ANSI 转义(避免颜色码泄漏)
 * - 取首个非空行(避免堆栈/多行污染)
 * - 折叠连续空白(避免缩进/格式伪影)
 * - 截断到 SUMMARY_MAX_LENGTH 字符
 */
function summarizeOutput(output: string): string {
  const cleaned = output.replace(ANSI_ESCAPE, '');
  const firstLine = splitNonEmptyLines(cleaned)[0] ?? '';
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_LENGTH);
}
