export interface AskQuestionOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskQuestionOption[];
  multiSelect: boolean;
}

export interface PlanApprovalPresentation {
  kind: 'plan-approval';
  content: string;
  filePath: string;
}

export interface AskQuestionRequest {
  questions: AskQuestion[];
  otherLabel?: string;
  presentation?: PlanApprovalPresentation;
}

export type AskQuestionOutcome =
  | { kind: 'submitted'; answers: Record<string, string> }
  | { kind: 'cancelled' }
  | { kind: 'chat'; feedback: string };

export type AskQuestionOutcomeCallback = (
  requestId: string,
  outcome: AskQuestionOutcome,
) => void;

export type ValidationResult =
  | { ok: true; value: AskQuestionRequest }
  | { ok: false; error: string };

/**
 * 结构化问卷结果(走 UI 通道,不进 API)。
 *
 * 物理本质:ask_user_question 执行后产出的"双通道分叉点"。
 * API 通道仍是 serializeAskQuestionOutcome 产出的字符串(ToolResultBlock.content 不变);
 * UI 通道用此结构化对象,供 block-pipeline 渲染 "⎿ Answered N questions" 折叠态
 * 与 Ctrl+O 展开的 header → answer 配对。
 *
 * version 用于 renderer 降级:不识别的版本回退 rawOutput(见 buildAskUserPresentation)。
 * 含 request(非只 outcome)的原因:outcome.answers 的 key 是 question 全文,
 * 展示需要 header(短),需要从 request.questions 反查 question↔header 映射。
 */
export interface StructuredAskResult {
  version: 1;
  /** 含 questions(header/options/multiSelect),供展示 header↔answer 配对 */
  request: AskQuestionRequest;
  /** submitted/cancelled/chat */
  outcome: AskQuestionOutcome;
}
