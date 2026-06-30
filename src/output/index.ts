// src/output/index.ts
// 输出系统公共导出

export { MessageQueue } from './message-queue.js';

export { Encoder } from './encoder.js';

export { LayoutScheduler } from './layout-scheduler.js';
export type { Layout, LayoutArea, LayoutParams } from './layout-scheduler.js';

export { StylePool } from './style-pool.js';

export type {
  MessageType,
  OutputMessage,
  OutputStyle,
  Writer,
  TermSize,
} from './types.js';

export { MessagePriority } from './types.js';
