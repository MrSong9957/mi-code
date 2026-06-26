// 定时调度类型定义
//
// 物理本质：闹钟记录本。
// 每条记录 = 一个闹钟：什么时候响（cron）、响了说什么（prompt）、响一次还是反复响（recurring）。

/** 调度记录 */
export interface ScheduleRecord {
  id: string;
  cron: string;              // cron 表达式（5 位：分 时 日 月 周）
  prompt: string;            // 触发时注入的提示
  recurring: boolean;        // 是否重复
  enabled: boolean;          // 是否启用
  durable: boolean;          // 是否持久化（重启后保留）
  createdAt: number;         // 创建时间戳
  lastFiredAt: number | null; // 上次触发时间戳
  expectedNextRun: number | null; // 下次预期触发时间戳
}

/** 调度通知（触发后放入队列） */
export interface ScheduleNotification {
  type: 'scheduled_prompt';
  scheduleId: string;
  prompt: string;
}
