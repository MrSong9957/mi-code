// src/ui/subagent-presentation.ts
//
// AUTO-0025-transient Task 3:子代理完成展示纯函数。
//
// 物理本质:把 spawn_agent 的 tool input/output/duration 转换为单行展示
// ● Agent "label" finished · Ns + 完整输出(供 Ctrl+O)。
//
// label 优先级:description(模型提供的短标签) > prompt 的有意义首行 > "Agent"。
// status 词:completed→finished, incomplete→incomplete, unverified→unverified。
// malformed 输出(无 [Subagent status=...] envelope)返回 null,调用方走通用降级。

/** 子代理完成展示结果。 */
export interface SubagentCompletionPresentation {
  /** 单行展示文本,如 ● Agent "查找实现" finished · 5s */
  line: string;
  /** envelope 剥离后的完整子代理输出(供 Ctrl+O 展开,不含 [Subagent status=...]) */
  fullOutput: string;
}

/** 匹配 formatSubagentResult 产出的结构化 envelope。 */
const ENVELOPE = /^\[Subagent status=(completed|incomplete|unverified)(?: reason=[^\]]+)?\]\r?\n([\s\S]*)$/;

/** 判断字符串是否含至少一个 Unicode 字母或数字(用于"有意义行"判定)。 */
const HAS_UNICODE_WORD = /[\p{L}\p{N}]/u;

/**
 * 从 prompt/description 提取有意义的单行标签。
 * 跳过空行、纯符号行、JSON 开头的行;返回首个含字母/数字的行;无则 null。
 */
function meaningfulLine(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('{') || line.startsWith('[')) continue;
    if (HAS_UNICODE_WORD.test(line)) return line;
  }
  return null;
}

/** 状态词映射:completed→finished(更口语),其余保持原状。 */
function statusWord(status: string): string {
  return status === 'completed' ? 'finished' : status;
}

/**
 * 格式化时长:ms → Ns 或 Nm Ms,至少 1s。无效/负数按 0。
 */
function formatDurationFromMs(durationMs: number): string {
  const safe = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const totalSec = Math.max(1, Math.round(safe / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const rest = totalSec % 60;
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`;
}

/**
 * 构建子代理完成展示。
 *
 * @param input spawn_agent 的工具输入(含可选 description、prompt、role、fork)
 * @param output 工具输出(formatSubagentResult 产出的带 envelope 字符串)
 * @param durationMs 工具执行耗时(毫秒)
 * @returns 展示结果,或 null(输出不符合 envelope 格式时,调用方走通用降级)
 */
export function buildSubagentCompletionPresentation(
  input: Record<string, unknown>,
  output: string,
  durationMs: number,
): SubagentCompletionPresentation | null {
  const match = output.match(ENVELOPE);
  if (!match) return null;
  const [, status, body] = match;
  const fullOutput = body ?? '';

  // label 优先级:description > prompt 有意义行 > "Agent"
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const label = description
    || meaningfulLine(input.prompt)
    || 'Agent';

  const line = `● Agent "${label}" ${statusWord(status!)} · ${formatDurationFromMs(durationMs)}`;
  return { line, fullOutput };
}
