import type { TodoItem } from '../agent/todo.js';
import type {
  SpinnerContextSnapshot,
  SpinnerTeammate,
  SpinnerTask,
} from './state/spinner-store.js';

export interface SpinnerTeammateSource {
  list(): readonly SpinnerTeammate[];
}

export interface SpinnerTodoSource {
  getItems(): readonly TodoItem[];
}

export function readSpinnerContext(
  teammateManager: SpinnerTeammateSource,
  todoManager: SpinnerTodoSource,
  fallback: SpinnerContextSnapshot,
): SpinnerContextSnapshot {
  try {
    return {
      variant: 'normal',
      teammates: teammateManager.list().map(member => ({ ...member })),
      tasks: todoManager.getItems().map((item): SpinnerTask => ({
        id: item.id,
        content: item.content,
        status: item.status,
        owner: item.owner ?? null,
        activeForm: item.activeForm ?? null,
        blockedBy: [...(item.blockedBy ?? [])],
      })),
      spinnerTip: null,
      hasUsedBtw: false,
      budgetText: null,
      nextTaskText: null,
    };
  } catch {
    return fallback;
  }
}
