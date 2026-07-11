// CLI argv 解析（Node 内置 parseArgs，无新依赖）
//
// 物理本质：门口的接待员。看用户进 micode 时带了什么 flag：
//   micode --resume <id>   → 接待员记下"恢复指定会话"
//   micode --continue      → 接待员记下"恢复最近会话"
//   micode --theme dark    → 接待员记下"使用 dark 主题"
//   micode                 → 接待员记下"新会话"
// 接待员把决定告诉主程序，主程序据此加载或不加载历史。

import { parseArgs } from 'node:util';
import type { ThemeName } from './config/schema.js';

export interface CliOptions {
  /** --resume <id>：恢复指定 id 的会话 */
  resume?: string;
  /** --continue：恢复最近一个会话 */
  continueLatest?: boolean;
  /** 列出所有可恢复会话然后退出（不进 TUI） */
  list?: boolean;
  /** --theme <dark|light>：指定主题（覆盖配置文件） */
  theme?: ThemeName;
}

/** 解析 process.argv，返回 CLI 选项。
 *  无参数时返回空对象（正常启动新会话）。
 *  未知参数忽略（不报错，保持简单）。 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        resume: { type: 'string', short: 'r' },
        continue: { type: 'boolean', short: 'c' },
        list: { type: 'boolean', short: 'l' },
        theme: { type: 'string', short: 't' },
      },
      allowNegative: true,
      strict: false,  // 未知参数不报错
    });
    const opts: CliOptions = {};
    if (typeof values.resume === 'string') opts.resume = values.resume;
    if (values.continue === true) opts.continueLatest = true;
    if (values.list === true) opts.list = true;
    if (typeof values.theme === 'string') {
      const t = values.theme.toLowerCase();
      if (t === 'dark' || t === 'light') opts.theme = t;
    }
    return opts;
  } catch {
    // parseArgs 出错（如 --resume 没给值），降级为新会话
    return {};
  }
}
