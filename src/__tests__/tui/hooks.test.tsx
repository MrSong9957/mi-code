// src/__tests__/tui/hooks.test.tsx
// useAltScreen / useTerminalSize hook 测试

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { useAltScreen, enterAltScreen, exitAltScreen } from '../../tui/hooks/useAltScreen.js';
import { useTerminalSize } from '../../tui/hooks/useTerminalSize.js';

function Probe({ onSize }: { onSize?: (s: { rows: number; cols: number }) => void }): React.ReactElement {
  useAltScreen();
  const size = useTerminalSize();
  if (onSize) onSize(size);
  return React.createElement(Text, {}, 'probe');
}

describe('useAltScreen', () => {
  it('mount 时进 alt screen（在所有写入里能找到 \\x1b[?1049h）', () => {
    // ink-testing-library 的 stdout.write 把每帧 push 进 frames。
    // useAltScreen 的 stdout.write(ENTER_ALT) 会作为一帧进 frames。
    const inst = render(React.createElement(Probe));
    // frames 里应能找到进 alt screen 的序列（可能与其他渲染混合，用 join 查找）
    const allFrames = inst.stdout.frames.join('');
    // 注意：debug 模式下 Ink 可能只在最终帧输出；alt screen 序列是 useEffect 直写
    // 若 frames 不含，则退回验证 unmount 的退出序列（间接证明 mount 进过）
    const hasEnter = allFrames.includes('\x1b[?1049h');
    inst.unmount();
    if (!hasEnter) {
      // 兜底断言：至少 unmount 的退出序列存在（说明 mount 进了又退）
      // 这条由下一个测试覆盖，这里若 hasEnter 为 true 就直接断言
      expect(hasEnter, 'mount 应写 \\x1b[?1049h（或 testing-library debug 模式吃掉了直写）').toBe(true);
    } else {
      expect(hasEnter).toBe(true);
    }
  });

  it('unmount 时退 alt screen（写 \\x1b[?1049l）', () => {
    const inst = render(React.createElement(Probe));
    const beforeUnmountLen = inst.stdout.frames.length;
    inst.unmount();
    // unmount 后新增的写入里应含退出 alt screen 序列
    const newWrites = inst.stdout.frames.slice(beforeUnmountLen).join('');
    // 允许序列混在帧里，用 includes 查找
    expect(newWrites).toContain('\x1b[?1049l');
  });
});

describe('enterAltScreen / exitAltScreen（裸函数，bootstrap 用）', () => {
  it('enterAltScreen 写 \\x1b[?1049h + 清屏', () => {
    const writes: string[] = [];
    const fake = { write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
    enterAltScreen(fake);
    const joined = writes.join('');
    expect(joined).toContain('\x1b[?1049h');
    expect(joined).toContain('\x1b[2J'); // 清屏
  });

  it('exitAltScreen 写 \\x1b[?1049l', () => {
    const writes: string[] = [];
    const fake = { write: (s: string) => { writes.push(s); return true; } } as unknown as NodeJS.WriteStream;
    exitAltScreen(fake);
    expect(writes.join('')).toContain('\x1b[?1049l');
  });
});

describe('useTerminalSize', () => {
  it('返回 stdout 的 columns/rows（默认值兜底）', () => {
    let captured: { rows: number; cols: number } | null = null;
    render(React.createElement(Probe, { onSize: s => { captured = s; } }));
    // ink-testing-library 默认 columns 80；rows 默认 24 或测试环境值
    expect(captured).not.toBeNull();
    expect(captured!.cols).toBeGreaterThan(0);
    expect(captured!.rows).toBeGreaterThan(0);
  });
});
