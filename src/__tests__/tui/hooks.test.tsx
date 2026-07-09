// src/__tests__/tui/hooks.test.tsx
// useAltScreen / useTerminalSize hook 测试

import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Text } from 'ink';
import { useAltScreen, enterAltScreen, exitAltScreen } from '../../tui/hooks/useAltScreen.js';
import { useTerminalSize } from '../../tui/hooks/useTerminalSize.js';
import { RenderModeProvider } from '../../tui/state/render-mode.js';

function Probe({ onSize }: { onSize?: (s: { rows: number; cols: number }) => void }): React.ReactElement {
  useAltScreen();
  const size = useTerminalSize();
  if (onSize) onSize(size);
  return React.createElement(Text, {}, 'probe');
}

function AltScreenProbe(): React.ReactElement {
  const isAlt = useAltScreen();
  return React.createElement(Text, {}, isAlt ? 'alt' : 'inline');
}

describe('useAltScreen — alt-screen mode', () => {
  it('mount 时进 alt screen（在所有写入里能找到 \\x1b[?1049h）', () => {
    const inst = render(
      React.createElement(RenderModeProvider, { initialMode: 'alt-screen', children: React.createElement(Probe) }),
    );
    const allFrames = inst.stdout.frames.join('');
    const hasEnter = allFrames.includes('\x1b[?1049h');
    inst.unmount();
    if (!hasEnter) {
      expect(hasEnter, 'mount 应写 \\x1b[?1049h（或 testing-library debug 模式吃掉了直写）').toBe(true);
    } else {
      expect(hasEnter).toBe(true);
    }
  });

  it('unmount 时退 alt screen（写 \\x1b[?1049l）', () => {
    const inst = render(
      React.createElement(RenderModeProvider, { initialMode: 'alt-screen', children: React.createElement(Probe) }),
    );
    const beforeUnmountLen = inst.stdout.frames.length;
    inst.unmount();
    const newWrites = inst.stdout.frames.slice(beforeUnmountLen).join('');
    expect(newWrites).toContain('\x1b[?1049l');
  });

  it('返回 true 表示处于 alt-screen 模式', () => {
    const inst = render(
      React.createElement(RenderModeProvider, { initialMode: 'alt-screen', children: React.createElement(AltScreenProbe) }),
    );
    const allFrames = inst.stdout.frames.join('');
    expect(allFrames).toContain('alt');
    inst.unmount();
  });
});

describe('useAltScreen — inline mode', () => {
  it('mount 时不写 \\x1b[?1049h', () => {
    const inst = render(
      React.createElement(RenderModeProvider, { initialMode: 'inline', children: React.createElement(Probe) }),
    );
    const allFrames = inst.stdout.frames.join('');
    expect(allFrames).not.toContain('\x1b[?1049h');
    inst.unmount();
  });

  it('unmount 时不写 \\x1b[?1049l', () => {
    const inst = render(
      React.createElement(RenderModeProvider, { initialMode: 'inline', children: React.createElement(Probe) }),
    );
    const beforeUnmountLen = inst.stdout.frames.length;
    inst.unmount();
    const newWrites = inst.stdout.frames.slice(beforeUnmountLen).join('');
    expect(newWrites).not.toContain('\x1b[?1049l');
  });

  it('返回 false 表示处于 inline 模式', () => {
    const inst = render(
      React.createElement(RenderModeProvider, { initialMode: 'inline', children: React.createElement(AltScreenProbe) }),
    );
    const allFrames = inst.stdout.frames.join('');
    expect(allFrames).toContain('inline');
    inst.unmount();
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
