// Worktree 类型定义
//
// WorktreeRecord: 一条 worktree 索引记录
// WorktreeEvent:  事件流中的一条日志

export interface CloseoutRecord {
  action: 'keep' | 'remove';
  reason: string;
  at: string;
}

export interface WorktreeRecord {
  name: string;
  branch: string;
  path: string;
  taskId: string;
  createdAt: string;
  lastEnteredAt?: string;
  lastCommandAt?: string;
  lastCommandPreview?: string;
  closeout?: CloseoutRecord;
}

export interface WorktreeEvent {
  ts: string;
  type: 'created' | 'removed' | 'kept' | 'bound' | 'closeout_keep' | 'closeout_remove';
  name: string;
  taskId?: string;
  reason?: string;
}
