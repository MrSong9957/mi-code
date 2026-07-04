// 单测：capabilities.ts —— 终端能力探测（同步更新 BSU/ESU 支持）
//
// 物理本质：探测终端"懂不懂某条指令"。
// BSU/ESU（DEC 2026 同步更新）是防止整帧重画闪烁的关键，
// 但老终端不认这条指令会把 \x1b[?2026h 当垃圾字符显示，所以要先探测。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { supportsSyncUpdate } from '../renderer/capabilities.js';

describe('capabilities', () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    'COLORTERM', 'TERM', 'TERM_PROGRAM', 'TMUX',
    'WT_SESSION', 'TERM_PROGRAM_VERSION', 'NO_COLOR',
  ];

  beforeEach(() => {
    // 备份相关环境变量
    for (const k of envKeys) {
      envBackup[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    // 恢复
    for (const k of envKeys) {
      if (envBackup[k] === undefined) delete process.env[k];
      else process.env[k] = envBackup[k];
    }
  });

  describe('supportsSyncUpdate', () => {
    it('Windows Terminal（WT_SESSION 存在）→ true', () => {
      process.env.WT_SESSION = 'some-guid';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('COLORTERM=truecolor → true（现代终端基本支持 2026）', () => {
      process.env.COLORTERM = 'truecolor';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM=xterm-256color 且无其他信号 → false（保守，xterm 老版不一定支持）', () => {
      process.env.TERM = 'xterm-256color';
      expect(supportsSyncUpdate()).toBe(false);
    });

    it('TERM_PROGRAM=WezTerm → true', () => {
      process.env.TERM_PROGRAM = 'WezTerm';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM 包含 wezterm → true', () => {
      process.env.TERM = 'wezterm';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM_PROGRAM=iTerm.app → true', () => {
      process.env.TERM_PROGRAM = 'iTerm.app';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM_PROGRAM=vscode → true（VS Code 终端基于 xterm.js 支持 2026）', () => {
      process.env.TERM_PROGRAM = 'vscode';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM 包含 kitty → true', () => {
      process.env.TERM = 'xterm-kitty';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM 包含 alacritty → true', () => {
      process.env.TERM = 'alacritty';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TERM 包含 foot → true', () => {
      process.env.TERM = 'foot';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('TMUX 下保守返回 false（透传不可靠，除非外层终端明确支持）', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
      process.env.TERM = 'screen-256color';
      expect(supportsSyncUpdate()).toBe(false);
    });

    it('TMUX 下若外层是 WezTerm 仍返回 true（COLORTERM=truecolor 提示外层支持）', () => {
      process.env.TMUX = '/tmp/tmux-1000/default,1234,0';
      process.env.COLORTERM = 'truecolor';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('NO_COLOR 设置时不影响同步更新判断（颜色关了但 2026 仍可用）', () => {
      process.env.NO_COLOR = '1';
      process.env.WT_SESSION = 'guid';
      expect(supportsSyncUpdate()).toBe(true);
    });

    it('所有信号都缺失 → false（保守降级）', () => {
      expect(supportsSyncUpdate()).toBe(false);
    });

    it('dumb 终端 → false', () => {
      process.env.TERM = 'dumb';
      expect(supportsSyncUpdate()).toBe(false);
    });
  });
});
