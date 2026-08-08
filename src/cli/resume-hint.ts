// src/cli/resume-hint.ts
// 退出时写入 resume 提示：推进到 footer 下方 + 隔行显示 resume 命令。
// 不擦除 footer——用 \r\n 推进出 footer 区域，footer 内容保留。

import type { Translator } from '../locale/types.js';

const DEFAULT_LABEL = 'Resume this session with:';

/**
 * footer 通常 4 行（border + 输入框 + border + status），光标在输入框行，
 * 下面还有 2 行 footer → 推进 3 行出 footer + 1 行间隔 = 4 个 \r\n。
 */
export function writeResumeHint(
  stdout: { write: (s: string) => boolean },
  sessionId: string,
  translator?: Translator,
): void {
  const label = translator ? translator.t('cli.resumeHintLabel') : DEFAULT_LABEL;
  stdout.write(`\r\n\r\n\r\n\r\n\x1b[2m${label}\nmicode --resume ${sessionId}\n\x1b[0m`);
}
