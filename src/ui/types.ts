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
  /** raw=true 时跳过 Markdown 渲染，原样显示（工具输出等不该被 md 误判的内容） */
  raw?: boolean;
}

/** 消息样式 */
export interface UIMessageStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 反转视频（SGR 7）——选区行高亮用 */
  inverse?: boolean;
}

/** Writer 接口 */
export type Writer = (s: string) => void;

/**
 * Block：统一输出管道的数据模型。
 *
 * 物理本质：每「一块」从大模型返回的内容都是一个 Block。
 * pipeline 负责模型内容（thinking / assistant / tool）+ 工具附属事件（hook 日志）。
 * 纯 UI 内容（banner / 系统行 / 错误）不走 pipeline，直接经 UILayout.send。
 *
 * hook 走 pipeline 的原因：PostToolUse hook 紧跟 tool_result，作为工具调用的附属信息。
 * 若异步 printLine 会穿插进下一轮流式内容（时序竞态），走 pipeline 则获得统一 gap 契约 +
 * 同步时序（紧跟 tool_result 之后、下一轮之前）。
 */
export type Block =
  | { kind: 'user_input'; text: string }
  | { kind: 'thinking_start' }
  | { kind: 'thinking_delta'; content: string }      // 累积，折叠模式下不渲染
  | { kind: 'thinking_end'; durationSec: number; filesRead: number }
  | { kind: 'assistant_text'; text: string; isFinal: boolean }  // 流式 markdown
  | { kind: 'tool_call'; name: string; input: Record<string, unknown>; toolUseId?: string }
  | { kind: 'tool_result'; name: string; input?: Record<string, unknown>; output: string; toolUseId?: string }
  | {
      kind: 'subagent_tool_progress';
      /** 外层 spawn_agent 这次调用的 toolUseId,用于精确挂到对应父 pending 消息 */
      parentToolUseId: string;
      /** 子代理内部那次工具调用的 toolUseId,用于同一父消息内多个子工具的状态替换 */
      childToolUseId: string;
      /** 子代理工具名 */
      name: string;
      /** 阶段:'running' 表示进行中,'done' 表示完成(此时 output 是结果摘要) */
      phase: 'running' | 'done';
      /** phase='done' 时的结果摘要(可选,running 时省略) */
      output?: string;
    }
  | { kind: 'hook'; text: string };  // PostToolUse 等 hook 日志（紧跟 tool_result，同步渲染）

/** 终端尺寸 */
export interface TermSize {
  rows: number;
  cols: number;
}
