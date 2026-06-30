// src/ui/types.ts
// UI 渲染系统类型定义

/** 消息类型 */
export type UIMessageType =
  | 'thinking'          // thinking 开始（● Thinking…）
  | 'thinking_content'  // thinking 内容（灰色，2空格缩进）
  | 'thinking_end'      // thinking 结束（Thought for Ns）
  | 'assistant'         // AI 回复（● + Markdown）
  | 'tool_call'         // 工具调用（● name(args)）
  | 'tool_result'       // 工具结果（  ⎿  Done）
  | 'tool_output'       // 工具输出（  ⎿  > ...）
  | 'permission'        // 权限信息（  ⎿  Allowed...）
  | 'system'            // 系统消息
  | 'error'             // 错误信息
  | 'input';            // 用户输入（❯）

/** 消息元数据 */
export interface UIMessageMeta {
  toolName?: string;      // 工具名（用于 tool_call / tool_result 分派）
  toolArgs?: string;      // 工具参数字符串（旧字段，保留兼容）
  toolInput?: Record<string, unknown>;  // 工具原始输入（用于 tool_call 显示参数）
  rawOutput?: string;     // 工具原始输出（Bash 等，formatter 内部 summarize）
  isWriteTool?: boolean;  // 标记 write_file（区分覆盖式 vs edit 式 diff）
  duration?: number;      // 耗时秒数（用于 thinking_end）
  filesRead?: number;     // 读取文件数（用于 thinking_end）
  linesAdded?: number;    // 添加行数（用于 tool_result）
  linesRemoved?: number;  // 删除行数（用于 tool_result）
  filePath?: string;      // 文件路径（用于 Update）
  output?: string;        // 输出内容（用于 tool_output）
  permission?: string;    // 权限信息（用于 permission）
}

/** 格式化后的消息行 */
export interface FormattedLine {
  content: string;    // 格式化后的内容（含前缀、缩进）
  style: UIMessageStyle;
  indent: number;     // 缩进空格数
}

/** 消息样式 */
export interface UIMessageStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Writer 接口 */
export type Writer = (s: string) => void;

/**
 * Block：统一输出管道的数据模型（仅模型内容）。
 *
 * 物理本质：每「一块」从大模型返回的内容都是一个 Block。
 * pipeline 只负责模型内容（thinking / assistant / tool）。非模型内容
 * （banner / hook / 系统行 / 错误）不走 pipeline，直接经 UILayout.send。
 *
 * 这保证了 pipeline 的块间空行 + 格式契约只作用于模型内容流，
 * 不会被 banner/hook 等打断（避免 tool_call 与 tool_result 被拆开）。
 */
export type Block =
  | { kind: 'user_input'; text: string }
  | { kind: 'thinking_start' }
  | { kind: 'thinking_delta'; content: string }      // 累积，折叠模式下不渲染
  | { kind: 'thinking_end'; durationSec: number; filesRead: number }
  | { kind: 'assistant_text'; text: string; isFinal: boolean }  // 流式 markdown
  | { kind: 'tool_call'; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; input?: Record<string, unknown>; output: string };

/** 终端尺寸 */
export interface TermSize {
  rows: number;
  cols: number;
}
