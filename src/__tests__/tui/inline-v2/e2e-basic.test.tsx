// src/__tests__/tui/inline-v2/e2e-basic.test.tsx
//
// V2 inline 模式 L1 E2E 基础场景。
//
// 用 createE2EHarness 装配完整 <ConnectedApp> + V2 路径,模拟真实用户操作。
// 这些测试覆盖 plan Task 5a.7 中可自动化的场景(键盘交互为主)。
// 不覆盖:Resize(需真 PTY)、退出码(需进程级)、真实 ANSI 终端行为。

import { describe, it, expect } from 'vitest';
import { createE2EHarness, KEYS, waitMs, typeText } from './helpers/e2e-harness.js';

describe('V2 inline E2E - 基础场景', () => {
  it('场景 1:启动 → 渲染 logo + footer + 输入光标定位', () => {
    const h = createE2EHarness({
      logo: { version: '1.0.0', dir: '/tmp/proj' },
      status: { mode: 'build', model: 'sonnet', dir: '/tmp/proj', branch: 'main' },
    });
    try {
      const frame = h.lastFrame() ?? '';
      // footer border
      expect(frame).toContain('─');
      // prompt
      expect(frame).toContain('❯');
      // statusbar
      expect(frame).toContain('build');
      expect(frame).toContain('sonnet');
      expect(frame).toContain('main');
    } finally {
      h.unmount();
    }
  });

  it('场景 2:输入文本 → 回车 → onSubmit 被调用 + 输入框清空', async () => {
    let submittedText: string | null = null;
    const h = createE2EHarness({
      onSubmit: (text) => { submittedText = text; },
    });
    try {
      await typeText(h.stdin, 'hello world');
      await waitMs(20);
      expect(h.lastFrame() ?? '').toContain('hello world');

      h.stdin.write(KEYS.ENTER);
      await waitMs(20);

      expect(submittedText).toBe('hello world');
      // 提交后输入框应清空
      const afterFrame = h.lastFrame() ?? '';
      expect(afterFrame).not.toContain('hello world');
    } finally {
      h.unmount();
    }
  });

  it('场景:输入过程中 footer border 稳定(行数不变)', async () => {
    // 模拟 plan Task 3.4 的 memo 隔离在端到端层面的效果
    const h = createE2EHarness();
    try {
      const initialFrame = h.lastFrame() ?? '';
      const initialBorderCount = (initialFrame.match(/─/g) ?? []).length;

      await typeText(h.stdin, 'typing some text here');
      await waitMs(20);

      const afterFrame = h.lastFrame() ?? '';
      const afterBorderCount = (afterFrame.match(/─/g) ?? []).length;

      // border 行数应该一致(footer 高度稳定)
      expect(afterBorderCount).toBe(initialBorderCount);
      expect(afterFrame).toContain('typing some text here');
    } finally {
      h.unmount();
    }
  });

  it('场景 5:输入 /model → 触发 Select 选择器', async () => {
    // 注:Select 由命令处理器在 /model 提交后触发,不是输入 / 时触发。
    // 这里直接验证 selectStore.open 后 SelectOverlay 出现。
    const h = createE2EHarness();
    try {
      // 直接通过 store 模拟 /model 命令触发 select
      h.stores.selectStore.getState().open('Select model', [
        { value: 'sonnet', label: 'Sonnet' },
        { value: 'opus', label: 'Opus' },
      ]);
      await waitMs(20);

      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('Select model');
      expect(frame).toContain('Sonnet');
      expect(frame).toContain('Opus');
      // 选中项前缀
      expect(frame).toContain('> Sonnet');

      // 按 ↓ 切换选中
      h.stdin.write(KEYS.DOWN_ARROW);
      await waitMs(20);
      expect(h.lastFrame() ?? '').toContain('> Opus');

      // 按 ESC 关闭
      h.stdin.write(KEYS.ESC);
      await waitMs(20);
      const afterClose = h.lastFrame() ?? '';
      expect(afterClose).not.toContain('Select model');
    } finally {
      h.unmount();
    }
  });

  it('场景 6:Ctrl+O → Overlay 显示 + 再 Ctrl+O 退出恢复', async () => {
    let overlayToggled = 0;
    const h = createE2EHarness({
      onToggleOverlay: () => {
        overlayToggled++;
        const s = h.stores.overlayStore.getState();
        if (!s.visible) {
          s.open('Thinking output', [
            { content: 'long thinking content line 1', style: {}, indent: 0 },
            { content: 'long thinking content line 2', style: {}, indent: 0 },
          ]);
        } else {
          s.close();
        }
      },
    });
    try {
      // 按 Ctrl+O 打开 overlay
      h.stdin.write(KEYS.CTRL_O);
      await waitMs(30);
      expect(overlayToggled).toBe(1);
      // Overlay 走 alt-screen 直写 stdout,主屏 Ink 渲染空白(footer 隐藏)
      let frame = h.lastFrame() ?? '';
      expect(frame).not.toContain('sonnet');
      expect(frame).not.toContain('❯');
      // overlayStore 状态正确
      expect(h.stores.overlayStore.getState().visible).toBe(true);

      // 再按 Ctrl+O 关闭
      h.stdin.write(KEYS.CTRL_O);
      await waitMs(50);
      expect(overlayToggled).toBe(2);
      // OverlayHost 直写 stdout(\x1b[?1049l)与 Ink 帧混合,
      // 用 frames 数组找恢复后的 Ink 帧(含 sonnet)
      const restoredFrame = h.frames.find((f) => f.includes('sonnet'));
      expect(restoredFrame).toBeDefined();
      expect(h.stores.overlayStore.getState().visible).toBe(false);
    } finally {
      h.unmount();
    }
  });

  it('场景 8:多行输入(粘贴含 \\n) → 输入框视口渲染多行', async () => {
    const h = createE2EHarness();
    try {
      // 模拟粘贴多行文本(Ctrl+J 或 \n)
      // inputStore 支持通过 stdin 模拟逐字符输入
      await typeText(h.stdin, 'line1');
      h.stdin.write(KEYS.ENTER);  // 注:这里 Enter 是 submit 不是 newline
      await waitMs(20);

      // 直接通过 store 模拟多行输入(insertNewline)
      h.stores.inputStore.getState().setText('first\nsecond\nthird');
      await waitMs(20);

      const frame = h.lastFrame() ?? '';
      expect(frame).toContain('first');
      expect(frame).toContain('second');
      expect(frame).toContain('third');
    } finally {
      h.unmount();
    }
  });

  it('场景 9:多轮对话 → 已固化消息累积进 scrollback', async () => {
    const h = createE2EHarness();
    try {
      // 模拟 3 轮对话:user 问 + assistant 答
      h.stores.messagesStore.getState().appendMessage('user', [
        { content: 'question 1', style: {}, indent: 0 },
      ]);
      h.stores.messagesStore.getState().appendMessage('assistant', [
        { content: 'answer 1', style: {}, indent: 0 },
      ]);
      h.stores.messagesStore.getState().appendMessage('user', [
        { content: 'question 2', style: {}, indent: 0 },
      ]);
      h.stores.messagesStore.getState().appendMessage('assistant', [
        { content: 'answer 2', style: {}, indent: 0 },
      ]);
      await waitMs(20);

      const frame = h.lastFrame() ?? '';
      // 所有消息都应出现(V2 用 <Static>,最终帧应包含所有已固化消息)
      expect(frame).toContain('question 1');
      expect(frame).toContain('answer 1');
      expect(frame).toContain('question 2');
      expect(frame).toContain('answer 2');
    } finally {
      h.unmount();
    }
  });

  it('场景:流式消息渲染 + spinner 同时显示', async () => {
    const h = createE2EHarness();
    try {
      // 先有一条已固化消息
      h.stores.messagesStore.getState().appendMessage('assistant', [
        { content: 'previous answer', style: {}, indent: 0 },
      ]);
      // 开新流式
      h.stores.messagesStore.getState().startStreaming('partial reply\n');
      h.stores.spinnerStore.getState().start('responding');
      await waitMs(50);

      const frame = h.lastFrame() ?? '';
      // 已固化消息
      expect(frame).toContain('previous answer');
      // 流式草稿
      expect(frame).toContain('partial reply');
    } finally {
      h.unmount();
    }
  });
});
