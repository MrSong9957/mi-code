// src/__tests__/tui/inline-v2/overlay-host.test.tsx
//
// <OverlayHost> 单元测试。
//
// 验证契约:
// - visible 翻 true 时写 \x1b[?1049h(进备用屏)+ 内容 + 返回提示
// - visible 翻 false 时写 \x1b[?1049l(退备用屏)
// - 不渲染任何可见 React 元素(返回 null)
// - unmount 时若仍在备用屏,强制退出(防御)
//
// 测试方式:真实 Ink render + MockStdout(捕获所有 stdout 写入,含 ANSI 转义序列)。
// OverlayHost 通过 useStdout() 拿 Ink 的 stdout,所以必须用真实 Ink render
// 才能正确拦截。

import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink';
import { OverlayHost } from '../../../tui/inline-v2/OverlayHost.js';
import { createOverlayStore } from '../../../tui/state/overlay-store.js';
import { createMockStdout } from './helpers/mock-stdout.js';

describe('<OverlayHost>', () => {
  it('visible=true 时进备用屏 + 写标题/分隔线/内容/返回提示', async () => {
    const store = createOverlayStore();
    store.getState().open('Thinking output', [
      { content: 'line 1 content', style: {}, indent: 0 },
      { content: '  indented line', style: {}, indent: 2 },
    ]);
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={80} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    // 进备用屏
    expect(all).toContain('\x1b[?1049h');
    // 清屏 + 光标归位
    expect(all).toContain('\x1b[2J\x1b[H');
    // 标题
    expect(all).toContain('Thinking output');
    // 分隔线(限制 60 列)
    expect(all).toContain('━');
    // 内容行
    expect(all).toContain('line 1 content');
    expect(all).toContain('  indented line');
    // 返回提示
    expect(all).toContain('按 q / Ctrl+O / Esc 返回');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('visible 翻 false 时退备用屏', async () => {
    const store = createOverlayStore();
    store.getState().open('T', [{ content: 'c', style: {}, indent: 0 }]);
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={80} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    // 清空之前的写入
    stdout.writes.length = 0;
    store.getState().close();
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    expect(all).toContain('\x1b[?1049l');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('初始 visible=false 时不进备用屏', async () => {
    const store = createOverlayStore();
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={80} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    expect(all).not.toContain('\x1b[?1049h');
    expect(all).not.toContain('\x1b[?1049l');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('unmount 时若仍在备用屏,强制退出(防御)', async () => {
    const store = createOverlayStore();
    store.getState().open('T', [{ content: 'c', style: {}, indent: 0 }]);
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={80} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));
    stdout.writes.length = 0;

    instance.unmount();
    instance.waitUntilRenderFlush?.();
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    expect(all).toContain('\x1b[?1049l');
  });

  it('unmount 时若未在备用屏,不发退出序列', async () => {
    const store = createOverlayStore();
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={80} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));
    stdout.writes.length = 0;

    instance.unmount();
    instance.waitUntilRenderFlush?.();
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    expect(all).not.toContain('\x1b[?1049l');
  });

  it('长行按 cols 截断', async () => {
    const store = createOverlayStore();
    const longContent = 'a'.repeat(200);
    store.getState().open('T', [{ content: longContent, style: {}, indent: 0 }]);
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={40} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    // cols=40,每行最多 40 个 'a'(无缩进)
    const aLine = all.split('\n').find((l) => l.startsWith('a'));
    expect(aLine).toBeDefined();
    expect(aLine!.length).toBeLessThanOrEqual(40);

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });

  it('内容变化时重新写(同一次 visible 期间)', async () => {
    const store = createOverlayStore();
    store.getState().open('T', [{ content: 'first', style: {}, indent: 0 }]);
    const stdout = createMockStdout();
    const instance = render(<OverlayHost store={store} cols={80} />, {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    await new Promise((r) => setTimeout(r, 30));

    // 更新内容(不切换 visible)
    store.getState().open('T', [{ content: 'second', style: {}, indent: 0 }]);
    await new Promise((r) => setTimeout(r, 30));

    const all = stdout.writes.map((w) => w.data).join('');
    expect(all).toContain('first');
    expect(all).toContain('second');

    instance.unmount();
    instance.waitUntilRenderFlush?.();
  });
});
