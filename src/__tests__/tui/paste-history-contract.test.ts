// src/__tests__/tui/paste-history-contract.test.ts
// 历史记录存储契约：历史存占位符版本，agent 收展开版本。
//
// 物理本质：占位符是「快捷方式」，展开是「全文」。
// 历史文件只存快捷方式（省磁盘），agent 循环收全文（需上下文）。
// sessionStore 存展开版本（resume 后 agent 需完整上下文，占位符 ID 跨 session 失效）。
//
// 本测试验证 expandPastedTextRefs 的分离契约：
// - 占位符文本（rawText.trim()）≠ 展开文本（expandPastedTextRefs(rawText).trim()）
// - 历史应存前者，agent 应收后者

import { describe, it, expect, beforeEach } from 'vitest';
import { storePastedContent, expandPastedTextRefs, resetPasteState } from '../../tui/input/paste-handler.js';

describe('历史记录存储契约：占位符 vs 展开', () => {
  beforeEach(() => {
    resetPasteState();
  });

  it('含占位符的文本：占位符版本 ≠ 展开版本（历史存占位符，agent 收展开）', () => {
    expect.hasAssertions();
    const pasted = storePastedContent('hello\nworld');
    const rawText = `请查看 ${pasted}`;
    const trimmedRaw = rawText.trim();                     // 历史版本（占位符）
    const userInput = expandPastedTextRefs(trimmedRaw);    // agent 版本（展开）

    // 两者必须不同——否则历史没省磁盘
    expect(trimmedRaw).not.toBe(userInput);
    // 占位符版本含占位符标记
    expect(trimmedRaw).toContain('[Pasted text #');
    // 展开版本含原始内容
    expect(userInput).toContain('hello\nworld');
    expect(userInput).not.toContain('[Pasted text #');
  });

  it('无占位符的文本：占位符版本 = 展开版本（普通输入不区分）', () => {
    expect.hasAssertions();
    const rawText = '普通文本输入';
    const trimmedRaw = rawText.trim();
    const userInput = expandPastedTextRefs(trimmedRaw);
    expect(trimmedRaw).toBe(userInput);
  });

  it('随机化：多次粘贴，占位符版本恒短于展开版本', () => {
    expect.hasAssertions();
    for (let i = 0; i < 10; i++) {
      const content = 'x'.repeat(100 + Math.floor(Math.random() * 500));
      const pasted = storePastedContent(content);
      const rawText = `前置 ${pasted} 后置`;
      const trimmedRaw = rawText.trim();
      const userInput = expandPastedTextRefs(trimmedRaw);
      // 占位符版本更短（省磁盘）
      expect(trimmedRaw.length).toBeLessThan(userInput.length);
    }
  });
});
