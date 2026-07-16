import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InlineRenderer, type CommitFrame } from './InlineRenderer.js';
import { layoutFooter } from './layout.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    write: vi.fn((s: string) => { written.push(s); return true; }),
  };
}

describe('InlineRenderer', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('appendLine writes text + newline to stdout', () => {
    renderer.appendLine('hello');
    expect(mock.write).toHaveBeenCalledWith('hello\n');
  });

  it('renderFooter writes footer lines and tracks them', () => {
    renderer.renderFooter('hello', 5, 'test | model');
    expect(mock.written.length).toBeGreaterThan(0);
  });

  it('commitFooter clears footer state', () => {
    renderer.renderFooter('hello', 5, 'test | model');
    renderer.commitFooter();
    const prevLen = mock.written.length;
    renderer.renderFooter('world', 5, 'test | model');
    expect(mock.written.length).toBeGreaterThan(prevLen);
  });

  it('renderFooter erases previous footer before writing new', () => {
    renderer.renderFooter('line1', 0, 'status1');
    const afterFirst = mock.written.length;
    renderer.renderFooter('line2', 0, 'status2');
    const secondWrites = mock.written.slice(afterFirst);
    const combined = secondWrites.join('');
    expect(combined).toContain('\x1b[');
  });

  it('commitFooter moves cursor below footer and resets state', () => {
    renderer.renderFooter('hello', 0, 'status');
    const afterFirst = mock.written.length;
    renderer.commitFooter();
    expect(mock.written.length).toBeGreaterThan(afterFirst);
    renderer.renderFooter('world', 0, 'status2');
    const afterSecond = mock.written.length;
    expect(afterSecond).toBeGreaterThan(afterFirst);
  });

  it('renderFooter 不渲染补全（下拉菜单由 DropdownOverlay 处理）', () => {
    renderer.renderFooter('/', 1, 'status', 80);
    const output = mock.written.join('');
    expect(output).toContain('status');
    expect(output).not.toContain('▸');
  });
});

// ── commit(frame)：Render commit boundary 契约测试 ──
// Phase 0：commit 是组件层渲染的唯一入口，内部按固定顺序复用现有方法。
// 这些测试验证 commit 正确编排渲染顺序，且作为未来 Phase 改造的稳定入口。
describe('InlineRenderer.commit(frame) — render commit boundary', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  /** 构建最小 footer 的 Frame（footer 用 layoutFooter 算好布局） */
  function makeFrame(overrides: Partial<CommitFrame> = {}): CommitFrame {
    return {
      newLines: [],
      streamingLines: null,
      footer: layoutFooter({
        input: '', cursor: 0, status: 'test', cols: 80,
        suggestions: [], dropdownIndex: 0, viewportTop: 0,
      }),
      hasNewFinalized: false,
      transitions: { justFinalized: false, needEraseDraft: false },
      ...overrides,
    };
  }

  it('基础场景：commit 写 footer（统一管线，无新行无流式时只写 footer）', () => {
    const beforeWrites = mock.written.length;
    renderer.commit(makeFrame());
    // commit 现在写 footer（统一管线：writeFooter 始终在 commit 末尾调用）
    // 无新行、无流式 → commit 只写 footer + BSU/ESU 包裹
    expect(mock.written.length).toBeGreaterThan(beforeWrites);
    const output = mock.written.slice(beforeWrites).join('');
    // 含 BSU/ESU 原子包裹
    expect(output).toContain('\x1b[?2026h');
    expect(output).toContain('\x1b[?2026l');
  });

  it('有新增固化行：appendLine 写入每行', () => {
    renderer.commit(makeFrame({
      newLines: ['LINE_A', 'LINE_B'],
      hasNewFinalized: true,
    }));
    const output = mock.written.join('');
    expect(output).toContain('LINE_A\n');
    expect(output).toContain('LINE_B\n');
  });

  it('有新增固化行时：commit appendLine + writeFooter（统一管线）', () => {
    renderer.commit(makeFrame({
      newLines: ['MARKER_LINE'],
      hasNewFinalized: true,
    }));
    const output = mock.written.join('');
    expect(output).toContain('MARKER_LINE\n');
    // commit 现在写 footer（统一管线：appendLine + writeFooter 都在 commit 内）
    // 含 border 字符（─）
    expect(output).toContain('─');
    // BSU/ESU 原子包裹
    expect(output).toContain('\x1b[?2026h');
    expect(output).toContain('\x1b[?2026l');
  });

  it('流式场景：rewriteStreamingLines 写入草稿行', () => {
    renderer.commit(makeFrame({
      streamingLines: ['STREAM_A', 'STREAM_B'],
    }));
    const output = mock.written.join('');
    expect(output).toContain('STREAM_A');
    expect(output).toContain('STREAM_B');
  });

  it('justFinalized 转换：先 commitFooter + clearStreamingHeight 再流式', () => {
    // justFinalized=true 时，commit 应先 commitFooter，然后 clearStreamingHeight，
    // 最后 rewriteStreamingLines。验证流式内容在清零之后（首次追加模式）。
    renderer.commit(makeFrame({
      streamingLines: ['POST_FINALIZE_STREAM'],
      transitions: { justFinalized: true, needEraseDraft: false },
    }));
    const output = mock.written.join('');
    // 流式内容应存在
    expect(output).toContain('POST_FINALIZE_STREAM');
    // justFinalized 路径不触发"非转换的 commitFooter"（:73 的 if 分支跳过）
    // 但会触发 :61 的 commitFooter（justFinalized→true）+ clearStreamingHeight
    // 这里验证不崩溃 + 内容写入即可（精确字节断言留给底层方法测试）
  });

  it('单次 write 防闪烁：commit 只调一次 stdout.write（writeBuf 缓冲）', () => {
    // constructor 调了一次 write（\x1b[?7l），commit 应只多调一次
    const callsBeforeCommit = mock.write.mock.calls.length;
    renderer.commit(makeFrame({
      newLines: ['LINE_A'],
      hasNewFinalized: true,
      streamingLines: ['STREAM_A'],
    }));
    // commit 期间所有操作进 writeBuf，结束时一次 stdout.write
    // 只应多 1 次调用（writeBuf flush）
    const callsAfterCommit = mock.write.mock.calls.length;
    expect(callsAfterCommit - callsBeforeCommit).toBe(1);
  });

  it('草稿消失时擦除残留：streamingLines=null 但 lastStreamingHeight>0 → eraseStreamingLines', () => {
    // 第一帧：有草稿（如 spinner 行），建立 lastStreamingHeight>0
    renderer.commit(makeFrame({
      streamingLines: ['✶ Crafting'],
    }));
    expect(renderer.state.lastStreamingHeight).toBe(1);

    // 第二帧：草稿消失（spinner 停止），streamingLines=null
    // 新增的 else 分支应擦除残留行（eraseStreamingLines：cursorUp + DL）
    mock.written.length = 0;
    renderer.commit(makeFrame({
      streamingLines: null,
    }));
    const output = mock.written.join('');
    // 应含物理删除序列（擦除草稿行）
    expect(output).toContain('\x1b[1M');
    // lastStreamingHeight 被清零
    expect(renderer.state.lastStreamingHeight).toBe(0);
  });

  it('草稿消失无残留时 no-op：streamingLines=null 且 lastStreamingHeight=0', () => {
    // 从未有草稿，streamingLines=null → 不触发擦除
    const beforeWrites = mock.written.length;
    renderer.commit(makeFrame({
      streamingLines: null,
    }));
    // 不应含删除序列（无残留可擦）
    const output = mock.written.slice(beforeWrites).join('');
    expect(output).not.toContain('\x1b[1M');
    expect(output).not.toMatch(/\x1b\[\d+M/);
  });
});
