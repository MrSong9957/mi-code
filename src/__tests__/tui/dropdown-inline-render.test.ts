// src/__tests__/tui/dropdown-inline-render.test.ts
// 端到端：completionStore → InlineRenderer.renderFooter 渲染下拉菜单。
//
// 物理本质：渲染逻辑的唯一事实源是 InlineRenderer.renderFooter。
// 本测试直接调用真实 renderer（捕获 stdout），而非在测试里复制渲染逻辑（杜绝假测试）。
// 验证：filter → candidates → renderFooter → stdout 含正确候选 + 选中主题色高亮。

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCompletionStore } from '../../tui/state/completion-store.js';
import { COMMAND_NAMES, COMMAND_SUGGESTIONS, type SuggestionItem } from '../../commands/executor.js';

/** 匹配任意 TrueColor 前景 SGR(如 \x1b[38;2;120;140;255m)。不硬编码具体色值,兼容 dark/light 主题。 */
const TRUE_COLOR_SGR = '\\x1b\\[38;2;\\d+;\\d+;\\d+m';
/** 选中态断言:命令名 /xxx 紧跟 TrueColor SGR(主题色高亮)。 */
function expectSelected(output: string, name: string): void {
  expect(output).toMatch(new RegExp(`${TRUE_COLOR_SGR}/${name}`));
}
/** 未选中态断言:命令名前无 TrueColor SGR(未高亮)。 */
function expectNotSelected(output: string, name: string): void {
  expect(output).not.toMatch(new RegExp(`${TRUE_COLOR_SGR}/${name}`));
}

describe('completionStore → InlineRenderer.renderFooter 数据流', () => {
  let stdoutChunks: string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let writeSpy: any;

  beforeEach(() => {
    stdoutChunks = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    });
  });

  it('filter("") → renderFooter 输出含全部候选且 index=0 主题色高亮', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();

    expect(s.visible).toBe(true);
    expect(s.candidates.length).toBe(COMMAND_NAMES.length);
    expect(s.index).toBe(0);

    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/', 1, 'S', 80, s.candidates, s.index);
    const output = stdoutChunks.join('');

    // 第一个候选（index=0）必须主题色高亮（TrueColor SGR + /name）
    const firstCandidate = s.candidates[0]!.name;
    expectSelected(output, firstCandidate);
    // 全部候选都应出现（≤8 条可见）
    const visibleCount = Math.min(s.candidates.length, 8);
    for (let i = 0; i < visibleCount; i++) {
      expect(output).toContain(`/${s.candidates[i]!.name}`);
    }
  });

  it('filter("pl") → 仅 plan 相关候选出现在输出', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('pl');
    const s = store.getState();

    expect(s.visible).toBe(true);
    expect(s.candidates.every(c => c.name.startsWith('pl'))).toBe(true);

    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/pl', 3, 'S', 80, s.candidates, s.index);
    const output = stdoutChunks.join('');

    expect(output).toContain('/plan');
    // 不应出现非 pl 开头的命令（如 config）
    expect(output).not.toContain('/config');
  });

  it('cycle → renderFooter 主题色高亮第二个候选', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cycle(); // index: 0 → 1
    const s = store.getState();
    expect(s.index).toBe(1);

    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/', 1, 'S', 80, s.candidates, s.index);
    const output = stdoutChunks.join('');

    // 第二个候选主题色高亮,第一个不高亮
    expectSelected(output, s.candidates[1]!.name);
    expectNotSelected(output, s.candidates[0]!.name);
  });

  it('hide → 无候选行输出（suggestions 为空）', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().hide();
    const s = store.getState();

    expect(s.visible).toBe(false);

    const renderer = new InlineRenderer(process.stdout);
    // visible=false 时 InlineApp 传空数组给 renderFooter
    renderer.renderFooter('/', 1, 'S', 80, [], 0);
    const output = stdoutChunks.join('');

    // 不含任何候选命令名
    for (const name of COMMAND_NAMES) {
      expect(output).not.toContain(`/${name}`);
    }
    // 不含主题色高亮序列
    expect(output).not.toMatch(new RegExp(TRUE_COLOR_SGR));
  });

  // ── 窗口居中滚动（对齐 Claude Code 源码 PromptInputFooterSuggestions.tsx:238）──
  // 旧 bug：slice(0, 8) 写死首屏，selectedIndex > 7 时选中项不在窗口里，高亮消失。
  it('selectedIndex=9（超出首屏）→ 第 9 条必须可见且高亮，第 0 条滚出窗口', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');  // 全部 18 条候选
    const s = store.getState();
    expect(s.candidates.length).toBeGreaterThan(8);  // 前提：候选超过一屏

    const renderer = new InlineRenderer(process.stdout);
    // 模拟用户按 ↓ 到第 9 条
    renderer.renderFooter('/', 1, 'S', 80, s.candidates, 9);
    const output = stdoutChunks.join('');

    // 第 9 条必须主题色高亮可见（居中）
    expectSelected(output, s.candidates[9]!.name);
    // 第 0 条已滚出窗口（窗口起始约 5，显示 5~12）
    expect(output).not.toContain(`/${s.candidates[0]!.name}`);
  });

  it('selectedIndex=17（末项）→ 第 17 条必须可见且高亮', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();
    const lastIndex = s.candidates.length - 1;
    expect(lastIndex).toBeGreaterThanOrEqual(8);

    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/', 1, 'S', 80, s.candidates, lastIndex);
    const output = stdoutChunks.join('');

    // 末项必须主题色高亮可见
    expectSelected(output, s.candidates[lastIndex]!.name);
    // 第 0 条已滚出窗口
    expect(output).not.toContain(`/${s.candidates[0]!.name}`);
  });

  it('少量候选（3 条）不滚动：全部可见，selectedIndex=2 高亮末项', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const three: SuggestionItem[] = [
      ...COMMAND_SUGGESTIONS.filter(s => s.name === 'config'),
      ...COMMAND_SUGGESTIONS.filter(s => s.name === 'compact'),
      { name: 'context', description: 'fake for test', group: 'Session' },
    ];
    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/c', 2, 'S', 80, three, 2);
    const output = stdoutChunks.join('');

    // 全部 3 条都应可见（无滚动）
    for (const item of three) {
      expect(output).toContain(`/${item.name}`);
    }
    // 第 2 条（末项）主题色高亮，前两条不高亮
    expectSelected(output, three[2]!.name);
    expectNotSelected(output, three[0]!.name);
    expectNotSelected(output, three[1]!.name);
  });

  // ── 加固：反向滚动（↑ 从 index=0 循环到末项）──
  // cyclePrev 在 index=0 时跳到末项，这是真实用户路径。
  // 正向（↓）和反向（↑）到末项的 startIndex 计算应一致。
  it('selectedIndex=末项（↑ 从 0 循环回来）→ 末项可见高亮，首项滚出窗口', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');
    store.getState().cyclePrev();  // index: 0 → 末项
    const s = store.getState();
    const lastIndex = s.candidates.length - 1;
    expect(s.index).toBe(lastIndex);

    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/', 1, 'S', 80, s.candidates, s.index);
    const output = stdoutChunks.join('');

    // 末项必须主题色高亮可见
    expectSelected(output, s.candidates[lastIndex]!.name);
    // 首项已滚出窗口（末项居中，窗口显示末 8 条）
    expect(output).not.toContain(`/${s.candidates[0]!.name}`);
  });

  // ── 加固：selectedIndex 越界防御（Claude Code 风格按值匹配的核心卖点）──
  // 即使 store 的 % length 保证不越界，renderer 也必须独立防御——
  // 防止未来重构改回相对下标时 bug 悄无声息回来。
  it('selectedIndex=999（越界）→ 不崩溃、不高亮任何候选', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const store = createCompletionStore();
    store.getState().filter('');
    const s = store.getState();
    const lastIndex = s.candidates.length - 1;

    const renderer = new InlineRenderer(process.stdout);
    // 越界 selectedIndex——不应抛错
    expect(() => renderer.renderFooter('/', 1, 'S', 80, s.candidates, 999)).not.toThrow();
    const output = stdoutChunks.join('');

    // 不应出现任何主题色高亮序列（suggestions[999] === undefined，name === undefined 全 false）
    expect(output).not.toMatch(new RegExp(TRUE_COLOR_SGR));
    // 候选仍正常显示：越界 selectedIndex 被公式钳制，窗口滚到末尾显示末 8 条
    // （startIndex = min(999-4, 17-8) = 9，显示 candidates[9..16]）
    expect(output).toContain(`/${s.candidates[lastIndex]!.name}`);
  });

  // ── 加固：候选恰好 8 条（length === maxVisible）边界 ──
  // 公式 length - maxVisible = 0，startIndex 恒 0，不滚动。
  // 防止有人把 maxVisible 改成 min(length, 7) 之类导致静默退化。
  it('候选恰好 8 条 → 不滚动，selectedIndex=7 时末项可见高亮', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const eight = COMMAND_SUGGESTIONS.slice(0, 8);  // 恰好 8 条
    expect(eight.length).toBe(8);

    const renderer = new InlineRenderer(process.stdout);
    renderer.renderFooter('/', 1, 'S', 80, eight, 7);  // 选中末项
    const output = stdoutChunks.join('');

    // 全部 8 条都可见（窗口=全部，无滚动）
    for (const item of eight) {
      expect(output).toContain(`/${item.name}`);
    }
    // 末项（index=7）主题色高亮，首项不高亮
    expectSelected(output, eight[7]!.name);
    expectNotSelected(output, eight[0]!.name);
  });

  // ── 加固：空 suggestions 数组（InlineApp 关闭下拉时传 []）──
  it('空 suggestions → 无候选行、无高亮、不崩溃', async () => {
    const { InlineRenderer } = await import('../../tui/inline/InlineRenderer.js');
    const renderer = new InlineRenderer(process.stdout);
    expect(() => renderer.renderFooter('/', 1, 'S', 80, [], 0)).not.toThrow();
    const output = stdoutChunks.join('');

    // 无主题色高亮序列
    expect(output).not.toMatch(new RegExp(TRUE_COLOR_SGR));
    // 无候选命令名（COMMAND_NAMES 都不应出现）
    for (const name of COMMAND_NAMES) {
      expect(output).not.toContain(`/${name}`);
    }
    // footer 骨架仍完整（border + prompt + border + status）
    expect(output).toContain('❯');
    expect(output).toContain('S');
  });
});
