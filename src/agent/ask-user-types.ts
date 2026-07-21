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
