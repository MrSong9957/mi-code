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
  // AUTO-0025 Phase B:记录每次 finishToolCall 的 (toolUseId, lines, finalKind),供结构化断言
  const finishToolCalls: { toolUseId: string; lines: { content: string; style: Record<string, unknown>; indent?: number; raw?: boolean }[]; finalKind?: string }[] = [];
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
    finishToolCall: vi.fn((toolUseId: string, lines: { content: string; style: Record<string, unknown>; indent?: number; raw?: boolean }[], finalKind?: string) => {
      finishToolCalls.push({ toolUseId, lines, finalKind });
      const index = prints.map(print => print.toolUseId).lastIndexOf(toolUseId);
      if (finalKind === 'agent-completion') {
        // agent-completion:替换 pending call 行为 resultLines[0](父标题),
        // 追加 resultLines[1:](子项行)。模拟真实 store:整组 lines 存为一条 TuiMessage。
        // (spawn_agent 仍是单行;ask_user_question 现为父标题+子项多行)
        if (index >= 0) {
          prints[index] = { text: lines[0]?.content ?? '', role: 'tool', style: lines[0]?.style, toolUseId };
          prints.splice(index + 1, 0, ...lines.slice(1).map(line => ({
            text: line.content, role: 'tool', style: line.style, toolUseId,
          })));
        } else {
          for (const line of lines) prints.push({ text: line.content, role: 'tool', style: line.style, toolUseId });
        }
      } else {
        prints.splice(index + 1, 0, ...lines.slice(1).map(line => ({
          text: line.content, role: 'tool', style: line.style, toolUseId,
        })));
      }
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
  return { renderer, prints, streamMarks, finishToolCalls };
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

    it('thinking_start → 立即显示闪烁行(idle→active,AUTO-0025-transient 修正)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      // start 立即触发 appendStreamingThinking + openModelBlock(首块空行)
      expect(renderer.appendStreamingThinking).toHaveBeenCalledWith('Thinking…');
      expect(prints[0].text).toBe(''); // openModelBlock 的首块空行
    });

    it('thinking_delta 在 active 态只累积,不额外触发显示(AUTO-0025-transient 修正)', () => {
      const { renderer } = mockRenderer();
      const p = new BlockPipeline(renderer);
      p.emit({ kind: 'thinking_start' });
      // start 已触发一次
      expect(renderer.appendStreamingThinking).toHaveBeenCalledTimes(1);
      p.emit({ kind: 'thinking_delta', content: '用户问...' });
      // delta 不再额外触发显示(只累积 buffer)
      expect(renderer.appendStreamingThinking).toHaveBeenCalledTimes(1);
    });

    it('thinking_end → printMessage("  Thought for Ns...", dim),需先 active(AUTO-0025-transient 修正)', () => {
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
    it('首个模型块前有空行(AUTO-0025-transient:thinking_start 即 active,触发 openModelBlock)', () => {
      const { renderer, prints } = mockRenderer();
      const p = new BlockPipeline(renderer);
      // thinking_start 现在立即 active,openModelBlock 产生首块空行
      p.emit({ kind: 'thinking_start' });
      expect(prints[0].text).toBe(''); // 首个模型块前空行
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
      // thinking_start 即 active,openModelBlock 加首空行
      p.emit({ kind: 'thinking_start' });
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

// ────────────────────────────────────────────────────────────────────
// AUTO-0025-transient Task 3:spawn_agent 完成展示。
//
// 验证:完成的 spawn_agent 渲染为单行 ● Agent "..." finished · Ns,
// 完整输出注册为 expandable 供 Ctrl+O。malformed 输出走通用降级。
// ────────────────────────────────────────────────────────────────────

describe('BlockPipeline spawn_agent 完成展示 (AUTO-0025-transient Task 3)', () => {
  it('正常结果:单行 ● Agent "..." finished · duration', () => {
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a1',
      input: { role: 'explore', description: '查找实现', prompt: '...' },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a1', durationMs: 147_000,
      output: '[Subagent status=completed]\nfull child result',
    });
    const contentTexts = prints.filter(p => p.text !== '').map(p => p.text);
    expect(contentTexts.some(t => t.includes('Agent "查找实现" finished · 2m 27s'))).toBe(true);
  });

  it('正常结果:Ctrl+O full lines 含完整子代理正文(无 envelope)', () => {
    const { renderer } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a1',
      input: { role: 'explore', prompt: '...' },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a1', durationMs: 5_000,
      output: '[Subagent status=completed]\nfull child result body',
    });
    const expandable = pipeline.getLastExpandableFullLines();
    expect(expandable).not.toBeNull();
    expect(expandable!.lines.map(l => l.content).join('\n')).toContain('full child result body');
    expect(expandable!.lines.map(l => l.content).join('\n')).not.toContain('[Subagent status=');
  });

  it('malformed 输出(无 envelope):走通用降级,含 call 行 + 原始预览', () => {
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a1',
      input: { role: 'explore', prompt: '...' },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a1', durationMs: 1_000,
      output: 'malformed output',
    });
    const contentTexts = prints.filter(p => p.text !== '').map(p => p.text);
    // 含 spawn_agent call 行(通用降级)
    expect(contentTexts.some(t => t.includes('spawn_agent'))).toBe(true);
    // 不含 Agent finished 专用行
    expect(contentTexts.some(t => t.includes('Agent "'))).toBe(false);
    // 无 expandable(通用降级不注册)
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('并行 spawn_agent 结果乱序到达:各自独立 finalize', () => {
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a1',
      input: { role: 'explore', description: '任务一', prompt: 'p1' },
    });
    pipeline.emit({
      kind: 'tool_call', name: 'spawn_agent', toolUseId: 'a2',
      input: { role: 'plan', description: '任务二', prompt: 'p2' },
    });
    // 结果乱序:a2 先到
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a2', durationMs: 3_000,
      output: '[Subagent status=completed]\nresult two',
    });
    pipeline.emit({
      kind: 'tool_result', name: 'spawn_agent', toolUseId: 'a1', durationMs: 5_000,
      output: '[Subagent status=completed]\nresult one',
    });
    const contentTexts = prints.filter(p => p.text !== '').map(p => p.text);
    expect(contentTexts.some(t => t.includes('任务一'))).toBe(true);
    expect(contentTexts.some(t => t.includes('任务二'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// AUTO-0025 Phase B (Task 13):ask_user_question 结构化展示。
//
// 验证:带 structuredOutcome 的 ask_user_question tool_result 渲染为
// ⎿ Answered N questions(折叠态)+ header → answer(展开态 Ctrl+O),
// 不走通用 Bash 折叠(不留 ● ask_user_question call 行)。
// ────────────────────────────────────────────────────────────────────

describe('BlockPipeline ask_user_question 结构化展示 (AUTO-0025 Phase B Task 13)', () => {
  const structuredSubmitted = {
    version: 1 as const,
    request: {
      questions: [
        {
          header: 'Auth',
          question: 'Which auth?',
          options: [{ label: 'OAuth', description: 'd' }, { label: 'Key', description: 'd' }],
          multiSelect: false,
        },
        {
          header: 'Lib',
          question: 'Which lib?',
          options: [{ label: 'A', description: 'd' }, { label: 'B', description: 'd' }],
          multiSelect: true,
        },
      ],
    },
    outcome: { kind: 'submitted' as const, answers: { 'Which auth?': 'OAuth', 'Which lib?': 'A, B' } },
  };

  it('submitted:父标题 ● Answered N + 子项 ⎿ header → answer 都在主消息区', () => {
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'q1',
      input: { questions: structuredSubmitted.request.questions },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'q1',
      output: 'User has answered your questions: ...',
      structuredOutcome: structuredSubmitted,
    });
    const contentTexts = prints.filter(p => p.text !== '').map(p => p.text);
    // 父标题:● Answered 2 questions(顶层块标记,非 ⎿ 子项标记)
    expect(contentTexts.some(t => t.startsWith('● ') && t.includes('Answered') && t.includes('2 question'))).toBe(true);
    // 子项:header → answer 配对,默认显示在主消息区(非 Ctrl+O 展开)
    expect(contentTexts.some(t => t.includes('Auth → OAuth'))).toBe(true);
    expect(contentTexts.some(t => t.includes('Lib → A, B'))).toBe(true);
    // 不含 ask_user_question call 行(agent-completion 复用:跳过 callLines)
    expect(contentTexts.some(t => t.includes('ask_user_question'))).toBe(false);
    // 不含 question 全文(证明走 header 配对,非 raw answers)
    expect(contentTexts.some(t => t.includes('Which auth?'))).toBe(false);
    // 不含 raw API 字符串(证明走结构化路径,非 Bash 折叠)
    expect(contentTexts.some(t => t.includes('User has answered'))).toBe(false);
  });

  it('submitted:不再注册 Ctrl+O expandable(子项已在主消息区)', () => {
    const { renderer } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'q1',
      input: { questions: structuredSubmitted.request.questions },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'q1',
      output: 'raw serialize',
      structuredOutcome: structuredSubmitted,
    });
    // ask_user_question 不再特判 Ctrl+O:无 expandable 注册
    expect(pipeline.getLastExpandableFullLines()).toBeNull();
  });

  it('cancelled:父标题 ● Declined to answer', () => {
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'q2',
      input: { questions: structuredSubmitted.request.questions },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'q2',
      output: 'User declined to answer questions',
      structuredOutcome: { ...structuredSubmitted, outcome: { kind: 'cancelled' } },
    });
    const contentTexts = prints.filter(p => p.text !== '').map(p => p.text);
    // cancelled 无子项,只有父标题行(● 前缀,与 submitted 同为顶层块)
    expect(contentTexts.some(t => t.startsWith('● ') && t.toLowerCase().includes('declined'))).toBe(true);
  });

  it('无 structuredOutcome:走通用降级(含 call 行 + raw 预览)', () => {
    const { renderer, prints } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'q3',
      input: { questions: [] },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'q3',
      output: 'some raw output',
      // 无 structuredOutcome
    });
    const contentTexts = prints.filter(p => p.text !== '').map(p => p.text);
    // 通用降级:含 call 行
    expect(contentTexts.some(t => t.includes('ask_user_question'))).toBe(true);
    // 无结构化摘要
    expect(contentTexts.some(t => t.includes('Answered'))).toBe(false);
  });

  // ── 回归测试:锁定 review 验收点(父标题格式 / 子项格式 / 单复数) ──

  it('父标题格式:● 前缀(非 ⎿),magenta 样式', () => {
    const { renderer, finishToolCalls } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'q-fmt',
      input: { questions: structuredSubmitted.request.questions },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'q-fmt',
      output: 'x',
      structuredOutcome: structuredSubmitted,
    });
    expect(finishToolCalls).toHaveLength(1);
    const lines = finishToolCalls[0]!.lines;
    // 父标题是第一行,● 前缀
    expect(lines[0]!.content.startsWith('● ')).toBe(true);
    // 父标题用 magenta(brand)样式
    expect(lines[0]!.style).toMatchObject({ fg: 'brand' });
  });

  it('子项格式:首行 ⎿  前缀,续行    对齐,dim + indent:2 + raw', () => {
    const { renderer, finishToolCalls } = mockRenderer();
    const pipeline = new BlockPipeline(renderer);
    pipeline.emit({
      kind: 'tool_call', name: 'ask_user_question', toolUseId: 'q-child',
      input: { questions: structuredSubmitted.request.questions },
    });
    pipeline.emit({
      kind: 'tool_result', name: 'ask_user_question', toolUseId: 'q-child',
      output: 'x',
      structuredOutcome: structuredSubmitted,
    });
    const lines = finishToolCalls[0]!.lines;
    // lines[0] 是父标题,lines[1]/[2] 是子项
    const child1 = lines[1]!;
    const child2 = lines[2]!;
    // 首子行:⎿  (⎿ + 两空格)前缀
    expect(child1.content.startsWith('⎿  ')).toBe(true);
    // 续子行:   (三空格)前缀对齐
    expect(child2.content.startsWith('   ')).toBe(true);
    expect(child2.content.startsWith('⎿')).toBe(false);
    // 子项样式:dim + indent:2 + raw:true
    for (const child of [child1, child2]) {
      expect(child.style).toMatchObject({ dim: true });
      expect(child.indent).toBe(2);
      expect(child.raw).toBe(true);
    }
  });

  it('单复数:0 questions / 1 question / N questions', () => {
    const mk = (n: number) => ({
      version: 1 as const,
      request: {
        questions: Array.from({ length: n }, (_, i) => ({
          header: `H${i}`,
          question: `q${i}`,
          options: [{ label: 'a', description: 'd' }, { label: 'b', description: 'd' }],
          multiSelect: false,
        })),
      },
      outcome: { kind: 'submitted' as const, answers: Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, 'a'])) },
    });

    for (const [n, expected] of [[0, 'Answered 0 questions'], [1, 'Answered 1 question'], [3, 'Answered 3 questions']] as const) {
      const { renderer, finishToolCalls } = mockRenderer();
      const pipeline = new BlockPipeline(renderer);
      pipeline.emit({ kind: 'tool_call', name: 'ask_user_question', toolUseId: `q-plural-${n}`, input: { questions: [] } });
      pipeline.emit({
        kind: 'tool_result', name: 'ask_user_question', toolUseId: `q-plural-${n}`,
        output: 'x',
        structuredOutcome: mk(n),
      });
      const titleLine = finishToolCalls[0]!.lines[0]!.content;
      expect(titleLine).toBe(`● ${expected}`);
    }
  });
});

