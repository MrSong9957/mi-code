// 渲染诊断日志（pino）
// 用法：在关键节点调 log.debug({字节片段}, '标签')，日志写到 .mimocode/render.log
// 查根因：对比"实际写到 stdout 的字节" vs "预期带颜色码的字节"

import pino from 'pino';

const LOG_FILE = '.mimocode/render.log';

export const log = pino({
  level: 'debug',
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
}, pino.destination({
  dest: LOG_FILE,
  mkdir: true,
  sync: true,  // 同步写，确保崩溃前日志落盘
}));

/** 把字符串转成可读的转义形式（\x1b → \\x1b）供日志 */
export function esc(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}
