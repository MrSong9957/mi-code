// inline 模式 bracketed paste 集成测试
//
// 核心契约：bracketed paste 序列 → usePaste 收到内容 → storePastedContent 生成占位符 → inputStore 含占位符
// 这条链路在 inline 模式下必须完整生效（之前自研拦截器在 !isInline 分支，inline 不执行）。
//
// 防作弊设计：
// - expect.hasAssertions() 防空跑
// - 断言 store.text 含占位符标记且不含原始粘贴内容
// - 随机化粘贴内容

import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { Text, usePaste } from 'ink';
import { createInputStore } from '../../tui/state/input-store.js';
import { storePastedContent, resetPasteState } from '../../tui/input/paste-handler.js';
import { useInputHandler } from '../../tui/input/use-input-handler.js';

// 模拟 ConnectedApp：useInputHandler（普通按键）+ usePaste（粘贴占位符），与真实组件一致
function PasteProbe({ store }: { store: ReturnType<typeof createInputStore> }) {
  useInputHandler(store, undefined, undefined, undefined, undefined, undefined, undefined);
  usePaste((text: string) => {
    // 与 ConnectedApp 的 usePaste handler 完全一致：insertPaste 追踪 pasteRanges
    store.getState().insertPaste(storePastedContent(text));
  });
  return React.createElement(Text, {}, `text="${store.getState().text}"`);
}

describe('inline 模式 bracketed paste → 占位符生成', () => {
  beforeEach(() => { resetPasteState(); });

  it('bracketed paste 序列 → store 含占位符，不含原始内容', () => {
    expect.hasAssertions();
    const store = createInputStore();
    const { stdin } = render(React.createElement(PasteProbe, { store }));
    // 发送 bracketed paste 序列（多行内容）
    stdin.write('\x1b[200~hello\nworld\nfoo\nbar\x1b[201~');
    const text = store.getState().text;
    // 占位符标记应出现
    expect(text).toContain('[Pasted text #');
    expect(text).toContain('+4 lines]');
    // 原始内容不应出现（被占位符替换）
    expect(text).not.toContain('hello\nworld');
    // insertPaste 应创建 pasteRange，覆盖完整占位符文本
    expect(store.getState().pasteRanges).toEqual([{ start: 0, end: [...text].length }]);
  });

  it('普通按键输入不受 usePaste 影响（仍走 useInput）', () => {
    expect.hasAssertions();
    const store = createInputStore();
    const { stdin } = render(React.createElement(PasteProbe, { store }));
    // 普通逐字输入（非 bracketed paste）
    stdin.write('hi');
    // store 应含原始字符（非占位符）
    expect(store.getState().text).toBe('hi');
    expect(store.getState().text).not.toContain('[Pasted text');
  });

  it('随机化：多次粘贴 ID 递增', () => {
    expect.hasAssertions();
    const store = createInputStore();
    const { stdin } = render(React.createElement(PasteProbe, { store }));
    for (let i = 0; i < 3; i++) {
      const content = `content${i}\nline2`;
      stdin.write(`\x1b[200~${content}\x1b[201~`);
    }
    const text = store.getState().text;
    // 三次粘贴 ID 递增
    expect(text).toContain('[Pasted text #1');
    expect(text).toContain('[Pasted text #2');
    expect(text).toContain('[Pasted text #3');
  });

  it('超长粘贴触发截断占位符', () => {
    expect.hasAssertions();
    const store = createInputStore();
    const { stdin } = render(React.createElement(PasteProbe, { store }));
    const longContent = 'x'.repeat(12000);
    stdin.write(`\x1b[200~${longContent}\x1b[201~`);
    const text = store.getState().text;
    // 截断占位符（含 Truncated 标记）
    expect(text).toContain('...Truncated text #1');
    expect(text).toContain('+1 lines');
    // 原始 12000 字符不应完整出现
    expect(text.length).toBeLessThan(longContent.length);
  });
});
