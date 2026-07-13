// src/__tests__/tui/submit-transformer.test.ts
// 提交文本双轨契约测试
//
// L1 验证 paste 展开（调用 storePastedContent 准备真实占位符）
// L2 验证双轨分发（硬编码字符串，与 paste 内部实现解耦）
// L3 验证真实落盘（用真实 HistoryManager + 真实磁盘 I/O，复用 history.test.ts 模板）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { splitSubmitTracks, commitNewTurn } from '../../tui/input/submit-transformer.js';
import { storePastedContent, resetPasteState } from '../../tui/input/paste-handler.js';
import { HistoryManager } from '../../history.js';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('splitSubmitTracks 双轨分裂（阶段1：text transformation）', () => {
  beforeEach(() => { resetPasteState(); });

  it('含占位符：historyText 保留占位符，agentText 展开为原文', () => {
    expect.hasAssertions();
    const pasted = storePastedContent('hello\nworld');
    const { historyText, agentText } = splitSubmitTracks(`请查看 ${pasted}`);
    expect(historyText).not.toBe(agentText);
    expect(historyText).toContain('[Pasted text #');
    expect(agentText).toContain('hello\nworld');
    expect(agentText).not.toContain('[Pasted text #');
  });

  it('无占位符：两版本相同（普通输入不分轨）', () => {
    expect.hasAssertions();
    const { historyText, agentText } = splitSubmitTracks('  普通文本  ');
    expect(historyText).toBe('普通文本');
    expect(historyText).toBe(agentText);
  });

  it('多个占位符：historyText 保留全部占位符，agentText 全部展开', () => {
    expect.hasAssertions();
    const p1 = storePastedContent('片段A\n第二行');
    const p2 = storePastedContent('片段B\n第二行');
    const { historyText, agentText } = splitSubmitTracks(`审查 ${p1} 和 ${p2}`);
    expect(historyText.match(/\[Pasted text #/g)).toHaveLength(2);
    expect(agentText).toBe('审查 片段A\n第二行 和 片段B\n第二行');
  });

  it('trim 生效：双轨都基于 trim 后文本', () => {
    expect.hasAssertions();
    const { historyText, agentText } = splitSubmitTracks('  \n  内容  \n  ');
    expect(historyText).toBe('内容');
    expect(agentText).toBe('内容');
  });
});

describe('commitNewTurn 调用层契约（阶段2：commit orchestration）', () => {
  // 注意：L2 不调用 storePastedContent，直接硬编码 historyText/agentText 字符串，
  // 与 paste-handler 内部实现解耦。L2 只负责验证双轨分发。

  it('historyText → addEntry（含占位符标记），agentText → emit（含完整原文）', async () => {
    expect.hasAssertions();
    const historyText = '占位符 [Pasted text #1]';
    const agentText = '占位符 完整内容';

    const addEntry = vi.fn<(i: string, p: string) => Promise<void>>();
    const emit = vi.fn<(b: { kind: 'user_input'; text: string }) => void>();
    const clearTurnState = vi.fn();

    const committed = await commitNewTurn(
      { addEntry, clearTurnState, emit },
      { historyText, agentText, project: 'proj', isProcessing: false }
    );

    expect(committed).toBe(true);
    // 核心契约：history 收占位符版本（含标记），不绑定具体格式
    expect(addEntry).toHaveBeenCalledWith(expect.stringContaining('[Pasted text'), 'proj');
    // agent 收展开版本（含完整原文，不含占位符标记）
    expect(emit).toHaveBeenCalledWith({
      kind: 'user_input',
      text: expect.stringContaining('完整内容'),
    });
    const emittedText = (emit.mock.calls[0][0] as { text: string }).text;
    expect(emittedText).not.toContain('[Pasted text');
  });

  it('空 agentText：不提交（早返回）', async () => {
    expect.hasAssertions();
    const addEntry = vi.fn();
    const emit = vi.fn();
    const committed = await commitNewTurn(
      { addEntry, clearTurnState: vi.fn(), emit },
      { historyText: '占位符', agentText: '', project: 'proj', isProcessing: false }
    );
    expect(committed).toBe(false);
    expect(addEntry).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('isProcessing=true：不提交（早返回）', async () => {
    expect.hasAssertions();
    const addEntry = vi.fn();
    const emit = vi.fn();
    const committed = await commitNewTurn(
      { addEntry, clearTurnState: vi.fn(), emit },
      { historyText: 'x', agentText: 'x', project: 'proj', isProcessing: true }
    );
    expect(committed).toBe(false);
    expect(addEntry).not.toHaveBeenCalled();
  });
});

describe('commitNewTurn 真实落盘集成（L3：真实 HistoryManager + 真实磁盘）', () => {
  // L3 的意义：L2 用 vi.fn() 只证明 commitNewTurn 调对了 addEntry，
  // 不证明 index.ts:347 的 historyManager.addEntry 真的把占位符写到磁盘。
  // 这里用真实 HistoryManager + 真实 fs，readFileSync 直读 jsonl 文件，
  // 验证"提交后历史文件里真的是占位符字符串"。
  //
  // 模板复用 history.test.ts：mkdtempSync + USERPROFILE 重定向 + readFileSync 断言。

  let tempDir: string;
  let originalUserprofile: string | undefined;
  let testHistoryPath: string;
  let realHistoryManager: HistoryManager;

  beforeEach(() => {
    resetPasteState();
    tempDir = mkdtempSync(join(tmpdir(), 'mi-code-submit-test-'));
    originalUserprofile = process.env.USERPROFILE;
    process.env.USERPROFILE = tempDir;
    testHistoryPath = join(tempDir, '.micode', 'history.jsonl.test');
    realHistoryManager = new HistoryManager(testHistoryPath);
  });

  afterEach(() => {
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
    else delete process.env.USERPROFILE;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('提交含占位符的文本：历史文件存占位符版本（不含原始内容）', async () => {
    expect.hasAssertions();
    const pasted = storePastedContent('secret-original-content\nsecond-line');
    const { historyText, agentText } = splitSubmitTracks(`请查看 ${pasted}`);

    // emit 仍用 spy（pipeline 在 index.ts 是模块级单例，无法真实化）
    const emit = vi.fn();
    const committed = await commitNewTurn(
      {
        addEntry: (i, p) => realHistoryManager.addEntry(i, p),
        clearTurnState: () => {},
        emit,
      },
      { historyText, agentText, project: 'proj', isProcessing: false }
    );

    expect(committed).toBe(true);
    expect(existsSync(testHistoryPath)).toBe(true);

    // 核心断言：直读磁盘文件，验证历史存的是占位符版本
    const fileContent = readFileSync(testHistoryPath, 'utf-8');
    const lines = fileContent.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    // 历史存占位符标记
    expect(entry.input).toContain('[Pasted text #');
    // 历史绝不存原始内容（省磁盘是核心契约）
    expect(entry.input).not.toContain('secret-original-content');
    expect(entry.project).toBe('proj');
    // emit（消息区回显）收展开版本——完整原文
    expect(emit).toHaveBeenCalledWith({
      kind: 'user_input',
      text: expect.stringContaining('secret-original-content'),
    });
  });

  it('提交无占位符的文本：历史与 emit 收到相同内容', async () => {
    expect.hasAssertions();
    const { historyText, agentText } = splitSubmitTracks('普通输入');
    const emit = vi.fn();
    await commitNewTurn(
      {
        addEntry: (i, p) => realHistoryManager.addEntry(i, p),
        clearTurnState: () => {},
        emit,
      },
      { historyText, agentText, project: 'proj', isProcessing: false }
    );

    const fileContent = readFileSync(testHistoryPath, 'utf-8');
    const entry = JSON.parse(fileContent.split('\n').filter((l) => l.trim())[0]);
    expect(entry.input).toBe('普通输入');
    expect(emit).toHaveBeenCalledWith({ kind: 'user_input', text: '普通输入' });
  });
});
