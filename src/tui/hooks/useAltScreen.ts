// src/tui/hooks/useAltScreen.ts
// Alt Screen 生命周期 hook（charter §固定架构约束 1）
//
// 物理本质：进/出终端「备用屏」的开关。
// 备用屏（alt screen）是独立于主屏的缓冲区，退出时恢复主屏原样。
// Claude Code / vim / less 都用备用屏——程序"接管"整个屏幕，退出不留痕迹。
//
// 副作用：
// - mount：写 \x1b[?1049h（进备用屏）+ 清屏
// - unmount：写 \x1b[?1049l（回主屏，恢复用户原终端内容）
//
// 防御边界（charter 防御 #1）：alt screen 泄漏是最易崩溃的边界——
// 进程异常退出（SIGINT/未捕获异常）若没退 alt screen，用户终端会卡在备用屏。
// 本 hook 只管 React 生命周期的进出；进程级异常退出由 src/tui/bootstrap.ts
// 的 process.on('SIGINT'/'SIGTERM'/'exit') + finally 兜底（Phase 7）。

import { useEffect } from 'react';
import { useStdout } from 'ink';
import { useRenderMode } from '../state/render-mode.js';

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';

/**
 * 进 alt screen（mount 时），卸载时退回主屏。
 * 在 inline 模式下为 no-op——不写任何转义序列。
 * 返回当前是否在 alt screen 模式。
 */
export function useAltScreen(): boolean {
  const { stdout } = useStdout();
  const { mode } = useRenderMode();
  const isAlt = mode === 'alt-screen';

  useEffect(() => {
    if (!stdout || !isAlt) return;
    stdout.write(ENTER_ALT + CLEAR_SCREEN);
    return () => {
      stdout.write(EXIT_ALT);
    };
  }, [stdout, isAlt]);

  return isAlt;
}

/** 仅写转义序列（不依赖 Ink 上下文，供 bootstrap 在 render 外直接调用） */
export function enterAltScreen(stream: NodeJS.WriteStream): void {
  stream.write(ENTER_ALT + CLEAR_SCREEN);
}

export function exitAltScreen(stream: NodeJS.WriteStream): void {
  stream.write(EXIT_ALT);
}
