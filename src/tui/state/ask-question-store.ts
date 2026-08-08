import { createStore, type StoreApi } from 'zustand/vanilla';
import type {
  AskQuestionOutcome,
  AskQuestionOutcomeCallback,
  AskQuestionRequest,
} from '../../agent/ask-user-types.js';

export interface AskQuestionState {
  visible: boolean;
  requestId: string | null;
  request: AskQuestionRequest | null;
  pageIndex: number;
  focusIndex: number;
  inputMode: boolean;
  otherDraft: string;
  otherCursor: number;
  selected: Record<string, string[]>;
  selectedValues: Record<string, string[]>;
  others: Record<string, string>;
  open: (id: string, request: AskQuestionRequest, cb: AskQuestionOutcomeCallback) => void;
  close: (id?: string) => void;
  moveFocusNext: () => void;
  moveFocusPrevious: () => void;
  nextPage: () => void;
  previousPage: () => void;
  activateFocused: () => void;
  insertOther: (text: string) => void;
  backspaceOther: () => void;
  deleteOther: () => void;
  moveOtherCursorLeft: () => void;
  moveOtherCursorRight: () => void;
  submitOther: () => void;
  submit: () => void;
  cancel: () => void;
  chat: () => void;
}

export type AskQuestionStore = StoreApi<AskQuestionState>;

const CHAT_PREFIX = `The user wants to clarify these questions.
This means they may have additional information, context or questions for you.
Take their response into account and then reformulate the questions if appropriate.
Start by asking them what they would like to clarify.`;

function emptyState(): Pick<AskQuestionState,
  'visible' | 'requestId' | 'request' | 'pageIndex' | 'focusIndex' | 'inputMode' |
  'otherDraft' | 'otherCursor' | 'selected' | 'selectedValues' | 'others'
> {
  return {
    visible: false,
    requestId: null,
    request: null,
    pageIndex: 0,
    focusIndex: 0,
    inputMode: false,
    otherDraft: '',
    otherCursor: 0,
    selected: {},
    selectedValues: {},
    others: {},
  };
}

function answersFor(state: Pick<AskQuestionState, 'request' | 'selected' | 'others'>): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of state.request?.questions ?? []) {
    const other = state.others[question.question]?.trim();
    if (other) {
      answers[question.question] = other;
      continue;
    }
    const selected = state.selected[question.question] ?? [];
    if (selected.length > 0) answers[question.question] = selected.join(', ');
  }
  return answers;
}

function answerValuesFor(
  state: Pick<AskQuestionState, 'request' | 'selectedValues' | 'others'>,
): Record<string, string> {
  const answerValues: Record<string, string> = {};
  for (const question of state.request?.questions ?? []) {
    if (state.others[question.question]?.trim()) continue;
    const selectedValues = state.selectedValues[question.question] ?? [];
    if (selectedValues.length > 0) {
      answerValues[question.question] = selectedValues.join(', ');
    }
  }
  return answerValues;
}

function chatFeedback(state: Pick<AskQuestionState, 'request' | 'selected' | 'others'>): string {
  const answers = answersFor(state);
  const questions = (state.request?.questions ?? []).map((question) => {
    const answer = answers[question.question];
    return `- ${JSON.stringify(question.question)}\n  ${answer ? `Answer: ${answer}` : '(No answer provided)'}`;
  });
  return `${CHAT_PREFIX}\n\nQuestions asked:\n${questions.join('\n')}`;
}

export function createAskQuestionStore(): AskQuestionStore {
  let onOutcome: AskQuestionOutcomeCallback | null = null;

  return createStore<AskQuestionState>((set, get) => {
    const settle = (outcome: AskQuestionOutcome) => {
      const state = get();
      const callback = onOutcome;
      const requestId = state.requestId;
      onOutcome = null;
      set(emptyState());
      if (callback && requestId) callback(requestId, outcome);
    };

    const currentQuestion = () => {
      const state = get();
      return state.request?.questions[state.pageIndex] ?? null;
    };

    const controlCount = () => {
      const state = get();
      const question = currentQuestion();
      return question ? question.options.length + 2 : state.request ? 2 : 0;
    };

    return {
      ...emptyState(),
      open: (id, request, callback) => {
        onOutcome = callback;
        set({
          visible: true,
          requestId: id,
          request,
          pageIndex: 0,
          focusIndex: 0,
          inputMode: false,
          otherDraft: '',
          otherCursor: 0,
          selected: {},
          selectedValues: {},
          others: {},
        });
      },
      close: (id) => {
        const state = get();
        if (id !== undefined && id !== state.requestId) return;
        onOutcome = null;
        set(emptyState());
      },
      moveFocusNext: () => {
        const count = controlCount();
        if (count === 0) return;
        set((state) => ({ focusIndex: (state.focusIndex + 1) % count }));
      },
      moveFocusPrevious: () => {
        const count = controlCount();
        if (count === 0) return;
        set((state) => ({ focusIndex: (state.focusIndex - 1 + count) % count }));
      },
      nextPage: () => set((state) => {
        if (!state.request) return state;
        return { pageIndex: Math.min(state.pageIndex + 1, state.request.questions.length), focusIndex: 0, inputMode: false, otherDraft: '', otherCursor: 0 };
      }),
      previousPage: () => set((state) => {
        if (!state.request) return state;
        return { pageIndex: Math.max(state.pageIndex - 1, 0), focusIndex: 0, inputMode: false, otherDraft: '', otherCursor: 0 };
      }),
      activateFocused: () => {
        const state = get();
        if (!state.visible || !state.request) return;
        const question = currentQuestion();
        if (!question) {
          if (state.focusIndex === 0) get().submit();
          else get().cancel();
          return;
        }
        if (state.focusIndex < question.options.length) {
          const option = question.options[state.focusIndex]!;
          const label = option.label;
          if (!question.multiSelect) {
            const selectedValues = { ...state.selectedValues };
            if (option.value === undefined) delete selectedValues[question.question];
            else selectedValues[question.question] = [option.value];
            set({
              selected: { ...state.selected, [question.question]: [label] },
              selectedValues,
            });
            if (state.request.questions.length === 1) {
              get().submit();
              return;
            }
            get().nextPage();
            return;
          }
          const previous = state.selected[question.question] ?? [];
          const selected = previous.includes(label)
            ? previous.filter((value) => value !== label)
            : [...previous, label];
          const values = selected.flatMap((selectedLabel) => {
            const value = question.options.find(({ label: optionLabel }) => optionLabel === selectedLabel)?.value;
            return value === undefined ? [] : [value];
          });
          const selectedValues = { ...state.selectedValues };
          if (values.length === 0) delete selectedValues[question.question];
          else selectedValues[question.question] = values;
          set({
            selected: { ...state.selected, [question.question]: selected },
            selectedValues,
          });
          return;
        }
        if (state.focusIndex === question.options.length) {
          const otherDraft = state.others[question.question] ?? '';
          set({ inputMode: true, otherDraft, otherCursor: otherDraft.length });
          return;
        }
        get().chat();
      },
      insertOther: (text) => set((state) => {
        if (!state.inputMode) return state;
        const otherDraft = `${state.otherDraft.slice(0, state.otherCursor)}${text}${state.otherDraft.slice(state.otherCursor)}`;
        return { otherDraft, otherCursor: state.otherCursor + text.length };
      }),
      backspaceOther: () => set((state) => {
        if (!state.inputMode || state.otherCursor === 0) return state;
        const otherCursor = state.otherCursor - 1;
        return { otherDraft: `${state.otherDraft.slice(0, otherCursor)}${state.otherDraft.slice(state.otherCursor)}`, otherCursor };
      }),
      deleteOther: () => set((state) => {
        if (!state.inputMode || state.otherCursor >= state.otherDraft.length) return state;
        return { otherDraft: `${state.otherDraft.slice(0, state.otherCursor)}${state.otherDraft.slice(state.otherCursor + 1)}` };
      }),
      moveOtherCursorLeft: () => set((state) => ({ otherCursor: Math.max(state.otherCursor - 1, 0) })),
      moveOtherCursorRight: () => set((state) => ({ otherCursor: Math.min(state.otherCursor + 1, state.otherDraft.length) })),
      submitOther: () => {
        const state = get();
        const question = currentQuestion();
        if (!state.inputMode || !question) return;
        const others = { ...state.others };
        if (state.otherDraft.trim()) others[question.question] = state.otherDraft;
        else delete others[question.question];
        set({ others, inputMode: false, otherDraft: '', otherCursor: 0 });
      },
      submit: () => {
        const state = get();
        if (!state.visible || !state.request) return;
        const answers = answersFor(state);
        const answerValues = answerValuesFor(state);
        settle(Object.keys(answerValues).length > 0
          ? { kind: 'submitted', answers, answerValues }
          : { kind: 'submitted', answers });
      },
      cancel: () => {
        if (!get().visible) return;
        settle({ kind: 'cancelled' });
      },
      chat: () => {
        const state = get();
        if (!state.visible || !state.request) return;
        settle({ kind: 'chat', feedback: chatFeedback(state) });
      },
    };
  });
}
