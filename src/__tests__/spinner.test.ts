// 单测：spinner.ts —— 旋转指示器
//
// 物理本质：一个会翻页的电子指示牌。
// 给它一个"我在干活"的信号（start），它就开始翻页（在 ⠋⠙⠹⠸... 之间循环）。
// 每次调 tick() 翻到下一格；长时间没人喂 token（3 秒），牌子变红（stall 警告）。
// 调 stop() 牌子熄灭。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Spinner } from '../renderer/spinner.js';

describe('Spinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('生命周期', () => {
    it('初始状态 inactive', () => {
      const s = new Spinner();
      expect(s.isActive()).toBe(false);
    });

    it('start(label) 后 active 且 label 正确', () => {
      const s = new Spinner();
      s.start('Thinking…');
      expect(s.isActive()).toBe(true);
      expect(s.getLabel()).toBe('Thinking…');
    });

    it('stop 后 inactive', () => {
      const s = new Spinner();
      s.start('Thinking…');
      s.stop();
      expect(s.isActive()).toBe(false);
    });

    it('setLabel 运行中切换文案（不停 spinner）', () => {
      const s = new Spinner();
      s.start('Thinking…');
      s.setLabel('Running bash…');
      expect(s.isActive()).toBe(true);
      expect(s.getLabel()).toBe('Running bash…');
    });

    it('start 重置 frameIndex 为 0', () => {
      const s = new Spinner();
      s.start('first');
      s.tick(); s.tick(); s.tick();
      s.start('second');
      // 重新 start 后第一个 tick 应回到第 1 帧（index 0 → tick 后 1）
      s.tick();
      const state = s.getState();
      expect(state.frameIndex).toBe(1);
    });
  });

  describe('tick 帧推进', () => {
    it('tick 推进 frameIndex', () => {
      const s = new Spinner();
      s.start('x');
      const i0 = s.getState().frameIndex;
      s.tick();
      const i1 = s.getState().frameIndex;
      expect(i1).toBe((i0 + 1) % 10); // 10 帧 Braille
    });

    it('tick 循环：10 次后回到第 0 帧', () => {
      const s = new Spinner();
      s.start('x');
      for (let i = 0; i < 10; i++) s.tick();
      // 10 次 tick 后 frameIndex 应为 0（10 % 10）
      expect(s.getState().frameIndex).toBe(0);
    });

    it('inactive 时 tick 无效', () => {
      const s = new Spinner();
      s.tick();
      // 不抛错，状态保持 inactive
      expect(s.isActive()).toBe(false);
    });
  });

  describe('render 渲染', () => {
    it('active 时 render 返回当前帧字符 + label', () => {
      const s = new Spinner();
      s.start('Thinking…');
      const r = s.render();
      expect(r.text).toContain('⠋'); // 第 0 帧 Braille
      expect(r.text).toContain('Thinking…');
    });

    it('active 时 render 样式 fg = accent', () => {
      const s = new Spinner();
      s.start('x');
      expect(s.render().style.fg).toBe('accent');
    });

    it('stalled 时 render 样式 fg = error（红色警告）', () => {
      const s = new Spinner();
      s.start('x');
      // 模拟 3 秒无 token
      vi.advanceTimersByTime(3500);
      s.tick(); // tick 触发 stall 检测
      expect(s.render().style.fg).toBe('error');
    });

    it('inactive 时 render 返回空', () => {
      const s = new Spinner();
      const r = s.render();
      expect(r.text).toBe('');
    });
  });

  describe('stall 检测', () => {
    it('start 后 3 秒内 tick 不 stall', () => {
      const s = new Spinner();
      s.start('x');
      vi.advanceTimersByTime(2500);
      s.tick();
      expect(s.getState().stalled).toBe(false);
    });

    it('start 后 3 秒无 onToken → tick 后 stalled=true', () => {
      const s = new Spinner();
      s.start('x');
      vi.advanceTimersByTime(3100);
      s.tick();
      expect(s.getState().stalled).toBe(true);
    });

    it('onToken 重置 stall 计时器', () => {
      const s = new Spinner();
      s.start('x');
      vi.advanceTimersByTime(2000);
      s.onToken(); // 收到 token，重置
      vi.advanceTimersByTime(2000); // 距离 onToken 只过了 2 秒
      s.tick();
      expect(s.getState().stalled).toBe(false);
    });

    it('stalled 后 onToken 恢复正常（stalled=false, fg=accent）', () => {
      const s = new Spinner();
      s.start('x');
      vi.advanceTimersByTime(3100);
      s.tick();
      expect(s.getState().stalled).toBe(true);
      s.onToken();
      expect(s.getState().stalled).toBe(false);
      expect(s.render().style.fg).toBe('accent');
    });

    it('stop 清除 stall 状态', () => {
      const s = new Spinner();
      s.start('x');
      vi.advanceTimersByTime(3100);
      s.tick();
      s.stop();
      // 重新 start 应是干净状态
      s.start('y');
      expect(s.getState().stalled).toBe(false);
    });
  });
});
