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
  toolName?: string;      // 工具名（用于 tool_call）
  toolArgs?: string;      // 工具参数（用于 tool_call）
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

/** 终端尺寸 */
export interface TermSize {
  rows: number;
  cols: number;
}
