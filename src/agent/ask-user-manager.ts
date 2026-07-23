import { randomUUID } from 'crypto';
import type {
  AskQuestionOutcome,
  AskQuestionOutcomeCallback,
  AskQuestionRequest,
} from './ask-user-types.js';

export interface AskUserUI {
  open: (
    id: string,
    request: AskQuestionRequest,
    onOutcome: AskQuestionOutcomeCallback,
  ) => void;
  close: (id: string) => void;
}

interface PendingAsk {
  id: string;
  resolve: (outcome: AskQuestionOutcome) => void;
}

export class AskUserManager {
  private pending: PendingAsk | null = null;

  constructor(private readonly ui: AskUserUI) {}

  ask(request: AskQuestionRequest): Promise<AskQuestionOutcome> {
    this.cancelPending();
    const id = randomUUID();

    return new Promise((resolve) => {
      this.pending = { id, resolve };
      this.ui.open(id, request, (callbackId, outcome) => {
        this.complete(callbackId, outcome);
      });
    });
  }

  private complete(id: string, outcome: AskQuestionOutcome): void {
    if (!this.pending || this.pending.id !== id) return;
    const { resolve } = this.pending;
    this.pending = null;
    resolve(outcome);
  }

  private cancelPending(): void {
    if (!this.pending) return;
    const { id, resolve } = this.pending;
    this.pending = null;
    this.ui.close(id);
    resolve({ kind: 'cancelled' });
  }
}
