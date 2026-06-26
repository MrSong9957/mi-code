// 后台任务类型定义
//
// RuntimeTaskRecord: 一个后台任务的元数据
// Notification:      任务完成时通知主循环的消息

export type TaskStatus = 'running' | 'completed' | 'timeout' | 'error';

export interface RuntimeTaskRecord {
  id: string;
  command: string;
  status: TaskStatus;
  startedAt: string;      // ISO 8601
  finishedAt?: string;
  outputFile: string;     // .runtime-tasks/{id}.log
  preview?: string;       // 摘要，最多 500 字符
  /** 最近一次 stdout 产出的时间戳（毫秒），用于僵尸检测 */
  lastActivityAt?: number;
}

export interface Notification {
  type: 'background_completed';
  taskId: string;
  status: TaskStatus;
  preview: string;
}
