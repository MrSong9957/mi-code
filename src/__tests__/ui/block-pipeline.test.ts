// src/__tests__/ui/block-pipeline.test.ts
// 统一输出管道 BlockPipeline 测试

import { describe, it, expect, vi } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
describe('finishToolCall fallback', () => {
  it('prints the complete tool exchange once when in-place update is declined', () => {
    const { renderer, prints } = mockRenderer();
    renderer.startToolCall = vi.fn();
    renderer.finishToolCall = vi.fn(() => false);
    const pipeline = new BlockPipeline(renderer);

    pipeline.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'fallback.ts' }, toolUseId: 'fallback-1' });
    pipeline.emit({ kind: 'tool_result', name: 'read_file', output: 'fallback result', toolUseId: 'fallback-1' });
    pipeline.clearTurnState();

    const contentTexts = prints.filter(print => print.text !== '').map(print => print.text);
    expect(contentTexts.filter(text => text.includes('fallback.ts'))).toHaveLength(1);
    expect(contentTexts.filter(text => text.includes('fallback result'))).toHaveLength(1);
  });
});

/** mock 的 Renderer：记录所有 printMessage / appendStreamingMarkdown 调用 */
function mockRenderer() {
  const prints: { text: string; role?: string; style?: Record<string, unknown>; toolUseId?: string }[] = [];
  const streamMarks: { text: string; isFinal: boolean }[] = [];
  const renderer = {
    printMessage: vi.fn((text: string, role?: string, style?: Record<string, unknown>) => {
      prints.push({ text, role, style });
    }),
    appendStreamingMarkdown: vi.fn((text: string, isFinal: boolean) => {
      streamMarks.push({ text, isFinal });
    }),
    appendStreamingThinking: vi.fn(),
    eraseStreamingThinking: vi.fn(),
    sealStreaming: vi.fn(),
    startToolCall: vi.fn((toolUseId: string, lines: { content: string; style: Record<string, unknown> }[]) => {
      for (const line of lines) prints.push({ text: line.content, role: 'tool', style: line.style, toolUseId });
    }),
    finishToolCall: vi.fn((toolUseId: string, lines: { content: string; style: Record<string, unknown> }[]) => {
      const index = prints.map(print => print.toolUseId).lastIndexOf(toolUseId);
      prints.splice(index + 1, 0, ...lines.slice(1).map(line => ({
        text: line.content, role: 'tool', style: line.style, toolUseId,
      })));
      return true;
    }),
    appendToolHook: vi.fn((toolUseId: string, lines: { content: string; style: Record<string, unknown> }[]) => {
      const index = prints.map(print => print.toolUseId).lastIndexOf(toolUseId);
      prints.splice(index + 1, 0, ...lines.map(line => ({
        text: line.content, role: 'tool', style: line.style, toolUseId,
      })));
      return true;
    }),
    finalizeStreaming: vi.fn(),
    appendStreaming: vi.fn(),
    flushNow: vi.fn(),
    clearMessages: vi.fn(),
  };
  return { renderer, prints, streamMarks };
}

/** 从 prints 找第一条非空内容（跳过块间空行） */
function firstContent(prints: { text: string }[]): { text: string } | undefined {
  return prints.find(p => p.text !== '');
}

describe('BlockPipeline', () => {
  describe('emit 路由 + 格式契约', () => {
    it('user_input → printMessage("❯ 你好", green bold)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'user_input', text: '你好' });
      expect(prints[0].text).toBe('❯ 你好');
      expect(prints[0].style).toMatchObject({ fg: 'success', bold: true });
    });

    it('thinking_start → awaitingContent,不立即固化标题行(AUTO-0025-transient)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      // 新行为:start 不固化,不产生任何 printMessage
      expect(prints.length).toBe(0);
      expect(renderer.appendStreamingThinking).not.toHaveBeenCalled();
    });

    it('thinking_delta 纯空白 → 不渲染;首个非空 → appendStreamingThinking(AUTO-0025-transient)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: '   ' });
      expect(renderer.appendStreamingThinking).not.toHaveBeenCalled();
      p.emit({ kind: 'thinking_delta', content: '用户问...' });
      // 首个非空 delta 显示临时行
      expect(renderer.appendStreamingThinking).toHaveBeenCalledWith('Thinking…');
      expect(renderer.appendStreamingThinking).toHaveBeenCalledTimes(1);
    });

    it('thinking_end → printMessage("  Thought for Ns...", dim),需先 visible(AUTO-0025-transient)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: '实质内容' });
      p.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 2 });
      const summary = prints.find(p => p.text.includes('Thought for'));
      expect(summary).toBeDefined();
      expect(summary!.text).toBe('  Thought for 5s, read 2 files (ctrl+o to expand)');
      expect(summary!.style).toMatchObject({ dim: true });
    });

    it('thinking_end 未 thinking_start → 不输出摘要', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_end', durationSec: 5, filesRead: 0 });
      expect(prints.find(p => p.text.includes('Thought for'))).toBeUndefined();
    });

    it('assistant_text → appendStreamingMarkdown(text, isFinal, opts)', () => {
      const { renderer } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'assistant_text', text: '你好', isFinal: false });
      // 第三个参数是格式 opts（含 indent/firstLinePrefix）
      expect(renderer.appendStreamingMarkdown).toHaveBeenCalledWith(
        '你好', false, expect.objectContaining({ firstLinePrefix: '● ' }),
      );
    });

    it('tool_call → printMessage("● Bash(cmd)", magenta)；首个模型块前有空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // tool_call 进缓冲区，需配对 result（或 clear 兜底 flush）才落屏
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 't1' });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'done', toolUseId: 't1' });
      expect(prints[0].text).toBe(''); // 首个模型块前空行
      const content = firstContent(prints);
      expect(content!.text).toBe('● Bash(ls)');
    });

    it('tool_result edit_file → printMessage("⎿  Added N lines...", dim)，含行数', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({
        kind: 'tool_result',
        name: 'edit_file',
        input: { path: 'a.ts', old_text: 'x', new_text: 'y\nz' },
        output: 'File edited: a.ts',
      });
      const resultLine = prints.find(p => p.text.includes('⎿'));
      expect(resultLine).toBeDefined();
      expect(resultLine!.text).toContain('Added');
      expect(resultLine!.style).toMatchObject({ dim: true });
    });

    it('tool_result run_bash → rawOutput 摘要', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'stdout line1' });
      const resultLine = prints.find(p => p.text.includes('stdout'));
      expect(resultLine).toBeDefined();
    });

    it('hook → printMessage(text, dim)；紧跟 tool_result 不加块间空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 先有 tool_result 内容，再 emit hook（模拟 PostToolUse 紧跟 tool_result）
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'out' });
      const printsBeforeHook = prints.length;
      p.emit({ kind: 'hook', text: '[Hook] run_bash done' });
      // hook 文本经 printMessage 输出，带 dim 样式
      const hookLine = prints.slice(printsBeforeHook).find(p => p.text.includes('[Hook]'));
      expect(hookLine, '应有 hook 输出行').toBeDefined();
      expect(hookLine!.style).toMatchObject({ dim: true });
      // hook 是 tool_result 的附属信息，紧跟其后，不加块间空行
      const hasGapBeforeHook = prints.slice(printsBeforeHook).some(p => p.text === '');
      expect(hasGapBeforeHook, 'hook 前不应有块间空行（紧跟 tool_result）').toBe(false);
    });

    // 注：纯 UI 的 system / error 不再是 Block kind——banner/错误直接走 UILayout.send。
    // PostToolUse hook 作为工具附属事件，走 pipeline（kind: 'hook'）以获得同步时序 + gap 契约。
  });

  describe('块间空行（集中化）', () => {
    it('首个模型块前有空行（AUTO-0025-transient:用 tool_call 触发,thinking_start 不产输出）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // thinking_start 不产生输出(AUTO-0025-transient awaitingContent)
      p.emit({ kind: 'thinking_start' });
      // tool_call 是第一个产出内容的模型块:强制加空行
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 't1' });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'done', toolUseId: 't1' });
      expect(prints[0].text).toBe(''); // 首个模型块前空行
      const content = firstContent(prints);
      expect(content!.text).toBe('● Bash(ls)');
    });

    it('第二个块前加空行（tool_call 在 thinking_end 之后）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
      // tool_call 进缓冲区，补 result 触发 flush
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' }, toolUseId: 't2' });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'done', toolUseId: 't2' });
      // tool_call 前应有空行（thinking_end 之后，flushTool 的 openModelBlock 加空行）
      const toolIdx = prints.findIndex(p => p.text.includes('Bash'));
      expect(toolIdx).toBeGreaterThan(0);
    });

    it('assistant_text 多次 delta 只加一次空行(AUTO-0025-transient)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 用 thinking visible 建立首块(thinking_start + 非空 delta)
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: '实质内容' }); // → visible,openModelBlock 加首空行
      // assistant 流式块
      p.emit({ kind: 'assistant_text', text: 'a', isFinal: false });
      p.emit({ kind: 'assistant_text', text: 'ab', isFinal: false });
      p.emit({ kind: 'assistant_text', text: 'abc', isFinal: true });
      // 空行数:thinking visible 首 1 + thinking→assistant 间 1 = 2
      const emptyCount = prints.filter(p => p.text === '').length;
      expect(emptyCount).toBe(2);
    });

    it('tool_result 紧跟 tool_call 不加额外空行（结果续接调用）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'file1' });
      const emptyCount = prints.filter(p => p.text === '').length;
      expect(emptyCount).toBe(1); // 仅首块 tool_call 前的空行，result 续接不另加
    });

    it('thinking→assistant 之间不出现双重空行', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // thinking 块（thinking_end 不再调 finalizeStreaming，无多余分隔行）
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
      // 下一个块（assistant_text）
      p.emit({ kind: 'assistant_text', text: '你好', isFinal: true });
      // 不应有连续两个空行
      const empties = prints.map(p => p.text === '');
      let consecutiveDouble = false;
      for (let i = 0; i < empties.length - 1; i++) {
        if (empties[i] && empties[i + 1]) { consecutiveDouble = true; break; }
      }
      expect(consecutiveDouble).toBe(false);
    });
  });

  describe('ctrl+o 临时 alt screen 覆盖层（getLastExpandableFullLines）', () => {
    it('thinking_end 注册可折叠块，折叠态显示摘要（主屏不展开，完整内容靠覆盖层）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: '完整思考内容' });
      p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
      // 折叠态（主屏）：应含 Thought for 摘要(AUTO-0025-transient 大写)
      expect(prints.some(p => p.text.includes('Thought for'))).toBe(true);
    });

    it('getLastExpandableFullLines 返回 thinking 完整内容（覆盖层渲染用）', () => {
      const { renderer } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: '完整思考内容' });
      p.emit({ kind: 'thinking_end', durationSec: 3, filesRead: 0 });
      const expandable = p.getLastExpandableFullLines();
      expect(expandable).not.toBeNull();
      expect(expandable!.kind).toBe('thinking');
      // 完整内容应在 fullLines 里（覆盖层会渲染这些）
      expect(expandable!.lines.some(l => l.content.includes('完整思考内容'))).toBe(true);
    });

    it('tool_result 截断时注册可折叠块，getLastExpandableFullLines 返回完整输出', () => {
      const { renderer } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'tool_call', name: 'run_bash', input: { command: 'ls' } });
      p.emit({ kind: 'tool_result', name: 'run_bash', output: 'l1\nl2\nl3\nl4\nl5\nl6\nl7' });
      const expandable = p.getLastExpandableFullLines();
      expect(expandable).not.toBeNull();
      expect(expandable!.kind).toBe('tool_result');
      // 完整输出含 l7（被截断的内容，覆盖层可见）
      expect(expandable!.lines.some(l => l.content.includes('l7'))).toBe(true);
    });

    it('无可折叠块时 getLastExpandableFullLines 返回 null', () => {
      const { renderer } = mockRenderer();
      const p = new BlockPipeline(renderer);
      expect(p.getLastExpandableFullLines()).toBeNull();
    });

    it('clearTurnState 清空可折叠块，getLastExpandableFullLines 返回 null', () => {
      const { renderer } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      p.emit({ kind: 'thinking_delta', content: '内容' });
      p.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
      p.clearTurnState();
      expect(p.getLastExpandableFullLines()).toBeNull();
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 并行工具调用配对（Bug 1 修复验证）
  //
  // 物理本质：4 个同名 write_file 同时下发，每个有自己的 toolUseId。
  // 旧版用 name 做 key 缓存 input，4 个互相覆盖——所有 result 都拿到
  // 最后一个 call 的 input。新版用 toolUseId 做 key + FIFO 队列，精确配对。
  //
  // 验证方式：write_file 的 result summary 是 "⎿  Added N lines"，
  // N 来自 input.content 的行数。让 4 个 call 的 content 行数各不同
  //（1/2/3/4 行），配对错了 N 就会错位。
  // ════════════════════════════════════════════════════════════════════
  describe('并行工具调用配对（toolUseId）', () => {
    // 提取 "⎿  Added N line(s)" 中的 N
    function addedCount(text: string): number | null {
      const m = text.match(/Added\s+(\d+)\s+line/);
      return m ? parseInt(m[1], 10) : null;
    }

    it('4 个并行 write_file：每个 result 配对自己 call 的 input（按 toolUseId）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 4 个 call，content 行数 1/2/3/4 各不同（配对错了 N 就错）
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'a.txt', content: 'A' }, toolUseId: 'id-1' });
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'b.txt', content: 'B\nB' }, toolUseId: 'id-2' });
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'c.txt', content: 'C\nC\nC' }, toolUseId: 'id-3' });
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'd.txt', content: 'D\nD\nD\nD' }, toolUseId: 'id-4' });
      // 4 个 result 按 toolUseId 到达（顺序与 call 一致）
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: a.txt', toolUseId: 'id-1' });
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: b.txt', toolUseId: 'id-2' });
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: c.txt', toolUseId: 'id-3' });
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: d.txt', toolUseId: 'id-4' });

      const addedLines = prints
        .map(pr => addedCount(pr.text))
        .filter((n): n is number => n !== null);
      // 各自配对自己的 content 行数：1/2/3/4
      expect(addedLines).toEqual([1, 2, 3, 4]);
    });

    it('result 无 toolUseId 时按 FIFO 配对（兼容旧路径，顺序保证）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // call 带 id，result 不带 id → 走 FIFO 队列
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'first.txt', content: 'X' }, toolUseId: 'u-1' });
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'second.txt', content: 'Y\nY' }, toolUseId: 'u-2' });
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: first.txt' }); // 无 id
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: second.txt' }); // 无 id

      const addedLines = prints
        .map(pr => addedCount(pr.text))
        .filter((n): n is number => n !== null);
      // FIFO：第 1 个 result 配对第 1 个 call（1 行），第 2 个配第 2 个（2 行）
      expect(addedLines).toEqual([1, 2]);
    });

    it('无 toolUseId 的同名工具串行调用（最老路径）仍能配对', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 都不带 id（模拟旧版完全无 id 的场景）
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'old1.txt', content: 'a' } });
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: old1.txt' });
      p.emit({ kind: 'tool_call', name: 'write_file', input: { path: 'old2.txt', content: 'b\nc' } });
      p.emit({ kind: 'tool_result', name: 'write_file', output: 'File written: old2.txt' });

      const addedLines = prints
        .map(pr => addedCount(pr.text))
        .filter((n): n is number => n !== null);
      expect(addedLines).toEqual([1, 2]);
    });
  });

  // ════════════════════════════════════════════════════════════════════
  // 工具块缓冲模型（方案 C：视觉位置修复）
  //
  // 物理本质：旧版 emit 即落屏，5 个并行 call 先印完，5 个 result 才能堆屏幕底部，
  // 视觉上"call 们在上、result 们在下"，每个 result 不知道对应哪个 call。
  // 新版把 tool_call/tool_result 进缓冲区，配对成 call→result→call→result 顺序 flush。
  // ════════════════════════════════════════════════════════════════════
  describe('工具块缓冲（视觉位置修复）', () => {
    it('5 个并行 Read：result 紧跟各自 call（call₁→result₁→call₂→result₂...）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 模拟真实时序：阶段 1 全部 emit call，阶段 3 才 emit result
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'a.ts' }, toolUseId: 'id-1' });
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'b.ts' }, toolUseId: 'id-2' });
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'c.ts' }, toolUseId: 'id-3' });
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'd.ts' }, toolUseId: 'id-4' });
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'e.ts' }, toolUseId: 'id-5' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'A-content', toolUseId: 'id-1' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'B-content', toolUseId: 'id-2' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'C-content', toolUseId: 'id-3' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'D-content', toolUseId: 'id-4' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'E-content', toolUseId: 'id-5' });

      // 提取所有非空内容行的文本，保留顺序
      const contentTexts = prints
        .filter(pr => pr.text !== '')
        .map(pr => pr.text);

      // 找每个 call 的位置（● Read(path)）和对应 result 的位置（含 output 内容）
      // 期望顺序：call₁, result₁, call₂, result₂, ...
      // 关键：call₁ 和 result₁ 必须相邻（中间不能夹着 call₂）
      const findCallIdx = (path: string) =>
        contentTexts.findIndex(t => t.includes('●') && t.includes(path));
      const findResultIdx = (content: string) =>
        contentTexts.findIndex(t => t.includes(content));

      const aCall = findCallIdx('a.ts');
      const aResult = findResultIdx('A-content');
      const bCall = findCallIdx('b.ts');

      // 核心断言：a 的 result 紧跟 a 的 call，且都在 b 的 call 之前
      expect(aCall, 'a 的 call 应存在').toBeGreaterThanOrEqual(0);
      expect(aResult, 'a 的 result 应存在').toBeGreaterThanOrEqual(0);
      expect(bCall, 'b 的 call 应存在').toBeGreaterThanOrEqual(0);
      // a 的 result 在 a 的 call 之后、b 的 call 之前（成对 flush 的证据）
      expect(aResult, 'a 的 result 应在 a 的 call 之后').toBeGreaterThan(aCall);
      expect(bCall, 'b 的 call 应在 a 的 result 之后（成对 flush）').toBeGreaterThan(aResult);
    });

    it('hook 紧跟对应 tool_result，不串到下一个 call', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 第 1 个工具：call + result + hook
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'x.ts' }, toolUseId: 'h-1' });
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'y.ts' }, toolUseId: 'h-2' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'X', toolUseId: 'h-1' });
      p.emit({ kind: 'hook', text: '[Hook] read_file done (x)' });
      p.emit({ kind: 'tool_result', name: 'read_file', output: 'Y', toolUseId: 'h-2' });
      p.emit({ kind: 'hook', text: '[Hook] read_file done (y)' });

      const contentTexts = prints
        .filter(pr => pr.text !== '')
        .map(pr => pr.text);

      const xResultIdx = contentTexts.findIndex(t => t === 'X' || t.includes('X'));
      const hookXIdx = contentTexts.findIndex(t => t.includes('(x)'));
      const yCallIdx = contentTexts.findIndex(t => t.includes('y.ts'));

      // x 的 hook 必须在 x 的 result 之后、y 的 call 之前（不串到 y 后面）
      expect(hookXIdx, 'x 的 hook 应存在').toBeGreaterThanOrEqual(0);
      expect(hookXIdx, 'x 的 hook 应在 x 的 result 之后').toBeGreaterThan(xResultIdx);
      expect(yCallIdx, 'y 的 call 应在 x 的 hook 之后').toBeGreaterThan(hookXIdx);
    });

    it('clear() 时未配对的 call 也能 flush（不丢失）', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // 只 emit call，不 emit result，然后 clear
      p.emit({ kind: 'tool_call', name: 'read_file', input: { path: 'orphan.ts' }, toolUseId: 'orphan-1' });
      p.clear();

      const contentTexts = prints
        .filter(pr => pr.text !== '')
        .map(pr => pr.text);
      // 即使没 result，call 行也得渲染出来（不能因缓冲而丢失）
      expect(contentTexts.some(t => t.includes('orphan.ts')), '未配对 call 不应丢失').toBe(true);
    });
  });
});

