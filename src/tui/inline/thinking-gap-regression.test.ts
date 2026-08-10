// thinking_end → assistant 间距回归测试
//
// 已反复出现过的错误：Thought for 与下一条 assistant 消息之间没有空行间隔。
// 本测试从数据层 + 渲染层双重验证间距不会退化。

import { describe, it, expect } from 'vitest';
import { BlockPipeline } from '../../ui/block-pipeline.js';
import { createLanguageStore } from '../../locale/language-store.js';
import { createTranslator } from '../../locale/translator.js';
import { PipelineToStoreAdapter } from '../../tui/state/pipeline-adapter.js';
import { createMessagesStore } from '../../tui/state/messages-store.js';
import { renderFinalizedLine } from './text-layout.js';

/** 构造完整流程的 store（user → thinking → final-only assistant），返回 semantic model。 */
function setupFullConversation() {
  const store = createMessagesStore();
  const adapter = new PipelineToStoreAdapter(store);
  const translator = createTranslator(createLanguageStore('zh-CN'));
  const pipeline = new BlockPipeline(adapter, translator);
  pipeline.emit({ kind: 'user_input', text: '你是谁？' });
  pipeline.emit({ kind: 'thinking_start' });
  pipeline.emit({ kind: 'thinking_delta', content: '思考' });
  pipeline.emit({ kind: 'thinking_end', durationSec: 1, filesRead: 0 });
  pipeline.emit({ kind: 'assistant_text', text: '你好！', isFinal: true });
  return { model: store.getState().model, translator };
}

describe('thinking_end → final-only assistant semantic lifecycle', () => {
  it('flushes the thinking summary before creating the finalized assistant', () => {
    const { model, translator } = setupFullConversation();
    const thoughtIdx = model.items.findIndex(
      item => item.kind === 'system'
        && item.subkind === 'thinking-summary'
        && item.text === translator.t('thinking.summary', { seconds: 1 }),
    );
    const assistantIdx = model.items.findIndex(
      item => item.kind === 'assistant' && item.text === '你好！',
    );

    expect(thoughtIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(thoughtIdx);
    expect(model.deferredThinking).toEqual([]);
  });
});

describe('renderFinalizedLine 不吞空行', () => {
  it('content="" 的 system 行渲染为 [""]（appendLine 会补 \\n 形成视觉空行）', () => {
    const result = renderFinalizedLine('system', { content: '', style: {}, indent: 0 }, 80);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('');
  });

  it('content="" 的 assistant 行也渲染为 [""]（不被 highlightLine 吞掉）', () => {
    const result = renderFinalizedLine('assistant', { content: '', style: {}, indent: 0 }, 80);
    expect(result).toHaveLength(1);
  });
});
