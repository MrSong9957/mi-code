// src/ui/block-format.ts
// 统一块格式化契约（纯函数）
//
// 物理本质：排版工人的「标签模板库」。
// 所有输出块（thinking / tool_call / tool_result / assistant）的视觉契约
// ——前缀、缩进、样式、参数提取、行数统计、输出截断——都集中在这里。
// 上层 MessageFormatter 只负责把语义消息类型路由到这里。
//
// 设计目标：让每个块的输出都遵循同一套缩进与样式规则，
// 杜绝「thinking 走原始文本路径、tool_call 丢参数」这类断裂。

/**
 * 统一缩进（空格数）。
 * - block：顶层块（● 前缀行），0 缩进。
 * - nested：块内嵌套内容（⎿ 前缀行、摘要行），2 空格缩进。
 */
export const INDENT = { block: 0, nested: 2 } as const;

/**
 * 统一样式常量。
 * 物理本质：每种块复用同一把「画笔」，避免每次 new 对象导致 styleEq 失败。
 */
export const BLOCK_STYLES = {
  /** 顶层块标题（● 行）：brand（magenta） */
  magenta: { fg: 'brand' },
  /** 嵌套内容（⎿ 行、摘要行）：dim */
  dim: { dim: true },
  /** 用户输入提示符（❯）：success（green）+ bold + 灰底高亮（贴近 Claude Code） */
  greenBold: { fg: 'success', bold: true, bg: 'gray' },
  /** 错误：error（red） */
  red: { fg: 'error' },
  /** 默认：无样式 */
  default: {},
} as const;

/** 工具调用参数的最大显示长度（超出截断为 … ） */
const MAX_TOOL_DISPLAY_LEN = 60;

/**
 * 把工具调用格式化为显示文本：`Name(key_args)`。
 *
 * 物理本质：给工具调用贴一个「人能读懂的名字牌」。
 * 按工具名分派：
 *   - run_bash  → Bash(command)
 *   - edit_file → Update(path)
 *   - write_file→ Write(path)
 *   - read_file → Read(path)
 *   - 其他      → Name(关键参数 JSON)，过长截断到 MAX_TOOL_DISPLAY_LEN
 *
 * 无参数或空对象时只返回 Name。
 */
export function formatToolCallDisplay(name: string, input: Record<string, unknown> | undefined): string {
  if (!input || Object.keys(input).length === 0) {
    return name;
  }

  let display: string;
  switch (name) {
    case 'run_bash': {
      const cmd = String(input.command ?? '');
      display = `Bash(${cmd})`;
      break;
    }
    case 'edit_file': {
      const path = String(input.path ?? '');
      display = `Update(${path})`;
      break;
    }
    case 'write_file': {
      const path = String(input.path ?? '');
      display = `Write(${path})`;
      break;
    }
    case 'read_file': {
      const path = String(input.path ?? '');
      display = `Read(${path})`;
      break;
    }
    default: {
      // 其他工具：紧凑 JSON 表示关键参数
      const args = JSON.stringify(input);
      display = `${name}(${args})`;
      break;
    }
  }

  // 截断过长显示（保留 Name(...) 结构，但参数部分截断）
  return truncateDisplay(display, name);
}

/**
 * 把超长的工具显示文本截断到 MAX_TOOL_DISPLAY_LEN（参数部分以 … 结尾）。
 * 仅在 `Name(...)` 的括号内过长时生效；若无括号则整体截断。
 */
function truncateDisplay(display: string, name: string): string {
  if (display.length <= MAX_TOOL_DISPLAY_LEN) return display;

  // 形如 `Name(...)`：保留 Name( 与 )，参数部分截断
  const openIdx = display.indexOf('(');
  const closeIdx = display.lastIndexOf(')');
  if (openIdx >= 0 && closeIdx > openIdx) {
    const prefix = display.slice(0, openIdx + 1); // "Name("
    const suffix = display.slice(closeIdx);       // ")"
    // 可用长度 = 总限额 - 前缀 - 后缀 - 1（留给 …）
    const budget = MAX_TOOL_DISPLAY_LEN - prefix.length - suffix.length - 1;
    if (budget > 0) {
      return `${prefix}${display.slice(openIdx + 1, openIdx + 1 + budget)}…${suffix}`;
    }
  }
  // 兜底：整体截断
  return `${display.slice(0, MAX_TOOL_DISPLAY_LEN - 1)}…`;
}

/**
 * 计算 edit_file 的行变化（+added / -removed）。
 *
 * 物理本质：比较两段文本的「行清单」，看新增和删除了多少行。
 * 按行拆分后做简单集合式比较（不做 LCS，足够给出近似 +N/-M）。
 *
 * 边界：
 * - oldText 空 → 全部算新增。
 * - newText 空 → 全部算删除。
 * - 尾部空行不计入（split('\n') 后过滤空串）。
 */
export function computeEditDiff(oldText: string, newText: string): { added: number; removed: number } {
  const oldLines = splitNonEmptyLines(oldText);
  const newLines = splitNonEmptyLines(newText);

  // 用多集差异近似：newLines 中不在 oldLines 的算 added，反之算 removed。
  // 同一行重复出现时按计数抵消。
  const oldCounts = countLines(oldLines);
  const newCounts = countLines(newLines);

  let added = 0;
  let removed = 0;

  // 遍历所有出现过的行
  const allLines = new Set<string>([...oldCounts.keys(), ...newCounts.keys()]);
  for (const line of allLines) {
    const oldN = oldCounts.get(line) ?? 0;
    const newN = newCounts.get(line) ?? 0;
    if (newN > oldN) added += newN - oldN;
    else if (oldN > newN) removed += oldN - newN;
  }

  return { added, removed };
}

/**
 * 计算 write_file 的行变化。
 * write_file 是整文件覆盖：oldContent 为 undefined 表示新文件（全部算新增）。
 */
export function computeWriteDiff(
  oldContent: string | undefined,
  newContent: string,
): { added: number; removed: number } {
  if (oldContent === undefined) {
    return { added: splitNonEmptyLines(newContent).length, removed: 0 };
  }
  return computeEditDiff(oldContent, newContent);
}

/**
 * 摘要工具输出（如 Bash stdout）：截取头 maxLines 行，统计总行数，标记是否截断。
 *
 * 返回：
 * - preview：头 maxLines 行（用 \n 连接）。
 * - totalLines：去除尾部空行后的总行数。
 * - truncated：是否发生截断（totalLines > maxLines）。
 *
 * 边界：
 * - 空输出 → preview='', totalLines=0, truncated=false。
 * - 尾部空行不计入。
 */
export function summarizeOutput(
  rawOutput: string,
  maxLines: number,
): { preview: string; totalLines: number; truncated: boolean } {
  const allLines = splitNonEmptyLines(rawOutput);
  const totalLines = allLines.length;

  if (totalLines === 0) {
    return { preview: '', totalLines: 0, truncated: false };
  }

  const truncated = totalLines > maxLines;
  const head = allLines.slice(0, maxLines);
  return {
    preview: head.join('\n'),
    totalLines,
    truncated,
  };
}

/**
 * 格式化 thinking 结束摘要：`Thought for Ns, read M files (ctrl+o to expand)`。
 *
 * - filesRead=0 时省略 "read M files"。
 * - filesRead=1 单数 file，否则 files。
 * - duration 始终输出（含 0）。
 */
export function formatThinkingSummary(durationSec: number, filesRead: number): string {
  let text = `Thought for ${durationSec}s`;
  if (filesRead > 0) {
    text += `, read ${filesRead} file${filesRead > 1 ? 's' : ''}`;
  }
  text += ' (ctrl+o to expand)';
  return text;
}

/**
 * 把工具执行结果翻译成「UI 能读懂的摘要数据」。
 *
 * 物理本质：工具执行完返回的是原始字符串，但不同工具要显示不同摘要——
 * edit_file 显示 +N/-M 行数、write_file 显示 stdout 摘要。这个函数按工具名分派。
 *
 * 优先级（事实优于名字）：
 * 1. 若 output 是拦截/错误文本（[Blocked by permission]、Error: ...），
 *    一律走 rawOutput 诚实展示——哪怕工具名是 write_file，也不能谎报行数。
 *    （否则权限拦截的 write 会被显示成 "Added N lines"，让人误判安全防线失效。）
 * 2. edit_file：用 input.old_text/new_text 算 +N/-M（经 computeEditDiff）。
 * 3. write_file：覆盖式，旧内容未知 → 当作全新增（经 computeWriteDiff）。
 * 4. run_bash / 其他：直接传 rawOutput（让 formatter 内部 summarize）。
 * 5. input 为 undefined：退化传 rawOutput（无法算行数）。
 *
 * 返回值直接作为 MessageFormatter.format('tool_result', meta) 的 meta 字段。
 */
export function buildToolResultBlock(
  name: string,
  input: Record<string, unknown> | undefined,
  output: string,
): { linesAdded?: number; linesRemoved?: number; rawOutput?: string; filePath?: string; toolName: string } {
  // 事实优先：output 已表明操作未真正生效（被拦截/报错），诚实展示，不算行数
  if (isNonSuccessOutput(output)) {
    return { toolName: name, rawOutput: output };
  }

  if (name === 'edit_file' && input) {
    const oldText = String(input.old_text ?? '');
    const newText = String(input.new_text ?? '');
    const { added, removed } = computeEditDiff(oldText, newText);
    return { toolName: name, linesAdded: added, linesRemoved: removed, filePath: String(input.path ?? '') };
  }

  if (name === 'write_file' && input) {
    const newText = String(input.content ?? '');
    const { added, removed } = computeWriteDiff(undefined, newText);
    return { toolName: name, linesAdded: added, linesRemoved: removed, filePath: String(input.path ?? '') };
  }

  // run_bash / 其他 / input 缺失：传原始输出（formatter 内部 summarize，带 ctrl+o 折叠提示）
  return { toolName: name, rawOutput: output };
}

// ─────────────── 内部辅助 ───────────────

/**
 * 判定工具 output 是否表明「操作未真正生效」
 *
 * 物理本质：投递员的话里有没有"被退回/出错了"的信号。
 * 命中任一即说明操作没真正落盘——此时 UI 必须诚实展示原文，
 * 不能因为工具名是 write_file 就谎报 "Added N lines"。
 *
 * 覆盖三类未生效：
 * - [Blocked by permission]：权限层硬拦截（越界、危险命令）
 * - Error:：执行层返回错误（old_text not found、未知工具等）
 * - [Tool Error]：执行层异常捕获
 */
function isNonSuccessOutput(output: string): boolean {
  return output.startsWith('[Blocked by permission]')
    || output.startsWith('Error:')
    || output.startsWith('[Tool Error]');
}

/** 按 \n 拆行并过滤掉空串（尾部空行不计入）。 */
function splitNonEmptyLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n').filter(l => l !== '');
}

/** 统计每行出现次数（用于多集差异比较）。 */
function countLines(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    m.set(l, (m.get(l) ?? 0) + 1);
  }
  return m;
}
