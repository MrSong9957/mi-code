// TaskBoard 类型定义
//
// 四态看板（waiting/ready/active/done），由依赖图驱动状态流转。

/** 任务状态：看板的四个状态桶 */
export type TaskStatus = 'waiting' | 'ready' | 'active' | 'done';

/** 单个任务（看板上的一张卡片） */
export interface Task {
  /** 唯一标识，如 "T1"、"T2" */
  id: string;
  /** 任务名称 */
  title: string;
  /** 依赖的其它任务 ID 列表（全部 done 后本任务才可就绪） */
  dependencies: string[];
  /** 当前状态 */
  status: TaskStatus;
  /** 执行成功后的产物概要（done 时写入） */
  result: string;
}

/** 看板快照（持久化用） */
export interface TaskGraphSnapshot {
  tasks: Task[];
}
