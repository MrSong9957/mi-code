// src/output/types.ts
// 输出系统类型定义

/** 消息类型 */
export type MessageType =
  | 'thinking'      // 思考内容（实时渲染，折叠后变 dim）
  | 'assistant'     // AI 回复（Markdown 渲染）
  | 'tool_call'     // 工具调用（● name）
  | 'tool_result'   // 工具结果（↳ name 完成 — N 行）
  | 'tool_output'   // 工具输出（编码清洗后的实际内容）
  | 'system'        // 系统消息（hook 日志等）
  | 'error'         // 错误（红色）
  | 'input';        // 用户输入（❯ prompt）

/** 消息优先级（数字越大优先级越高） */
export enum MessagePriority {
  SYSTEM = 0,
  TOOL_OUTPUT = 1,
  ASSISTANT = 2,
  TOOL_CALL = 3,
  // TOOL_CALL 与 TOOL_RESULT 必须同优先级，由 MessageQueue 的稳定插入顺序维持 FIFO。
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  TOOL_RESULT = 3,
  INPUT = 4,
  THINKING = 5,
  ERROR = 10,
}

/** 输出消息 */
export interface OutputMessage {
  id: string;
  type: MessageType;
  content: string;
  style?: OutputStyle;
  priority: MessagePriority;
  timestamp: number;
}

/** 输出样式（简化版，对齐 Claude Code Style 对象） */
export interface OutputStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

/** Writer 接口（测试注入 fake） */
export type Writer = (s: string) => void;

/** 终端尺寸 */
export interface TermSize {
  rows: number;
  cols: number;
}
