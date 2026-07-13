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

  it('基础场景：commit 画 footer（无新行、无流式）', () => {
    const beforeWrites = mock.written.length;
    renderer.commit(makeFrame());
    // commit 应写入 footer 内容（border/status 等）
    expect(mock.written.length).toBeGreaterThan(beforeWrites);
    const output = mock.written.slice(beforeWrites).join('');
    expect(output).toContain('test'); // status 文本
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

  it('有新增固化行时：先 commitFooter 再 appendLine（顺序契约）', () => {
    // 先画一次 footer 建立 footerHeight>0（否则 commitFooter 是 no-op）
    renderer.commit(makeFrame());
    const afterFirstCommit = mock.written.length;

    // 第二次 commit：有新增固化行 → commitFooter（擦旧 footer）→ appendLine
    renderer.commit(makeFrame({
      newLines: ['MARKER_LINE'],
      hasNewFinalized: true,
    }));
    const secondCommitOutput = mock.written.slice(afterFirstCommit).join('');
    const markerIdx = secondCommitOutput.indexOf('MARKER_LINE');
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    // MARKER_LINE 之前应有 cursorUp 序列（commitFooter 擦 footer 留下的）
    const beforeMarker = secondCommitOutput.slice(0, markerIdx);
    expect(beforeMarker).toMatch(/\x1b\[\d+A/); // cursorUp
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
});
