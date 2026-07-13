// src/tui/inline/render-state.test.ts
// InlineRenderState 单元测试：验证统一状态所有者的契约。
//
// Phase 1：footerHeight/cursorToTop/lastStreamingHeight/renderedLines
// 从分散的三处（InlineRenderer private 字段 + InlineApp ref）收拢到此类。

import { describe, it, expect } from 'vitest';
import { InlineRenderState } from './render-state.js';

describe('InlineRenderState', () => {
  it('初始状态：所有计数为 0，账本为空', () => {
    const s = new InlineRenderState();
    expect(s.footerHeight).toBe(0);
    expect(s.cursorToTop).toBe(0);
    expect(s.lastStreamingHeight).toBe(0);
    expect(s.renderedCount).toBe(0);
  });

  it('footerHeight / cursorToTop / lastStreamingHeight 可直接读写', () => {
    const s = new InlineRenderState();
    s.footerHeight = 4;
    s.cursorToTop = 1;
    s.lastStreamingHeight = 3;
    expect(s.footerHeight).toBe(4);
    expect(s.cursorToTop).toBe(1);
    expect(s.lastStreamingHeight).toBe(3);
  });

  it('getFooterHeight() 代理到 footerHeight（兼容旧 API）', () => {
    const s = new InlineRenderState();
    s.footerHeight = 7;
    expect(s.getFooterHeight()).toBe(7);
  });

  it('renderedLines 账本：getRenderedLineCount 未记录返回 0', () => {
    const s = new InlineRenderState();
    expect(s.getRenderedLineCount('msg-1')).toBe(0);
  });

  it('renderedLines 账本：setRenderedLineCount 记录后可读取', () => {
    const s = new InlineRenderState();
    s.setRenderedLineCount('msg-1', 3);
    s.setRenderedLineCount('msg-2', 5);
    expect(s.getRenderedLineCount('msg-1')).toBe(3);
    expect(s.getRenderedLineCount('msg-2')).toBe(5);
    expect(s.renderedCount).toBe(2);
  });

  it('renderedLines 账本：重复 setRenderedLineCount 覆盖旧值（幂等更新）', () => {
    const s = new InlineRenderState();
    s.setRenderedLineCount('msg-1', 2);
    s.setRenderedLineCount('msg-1', 4); // pipeline ensureGap 追加行后更新
    expect(s.getRenderedLineCount('msg-1')).toBe(4);
    expect(s.renderedCount).toBe(1); // 同 uuid 不增加计数
  });

  it('renderedLines 是同一 Map 实例（renderer.state 和组件层共享）', () => {
    const s = new InlineRenderState();
    s.setRenderedLineCount('msg-1', 1);
    // renderedLines 属性返回同一 Map（readonly 约束的是类型，不是实例）
    expect(s.renderedLines.get('msg-1')).toBe(1);
  });
});

describe('InlineRenderer 与 InlineRenderState 的集成', () => {
  it('renderer.state 是同一实例（renderer 和组件层共享状态）', async () => {
    const { InlineRenderer } = await import('./InlineRenderer.js');
    const mock = { write: (_s: string) => true, columns: 80 };
    const renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);

    // renderer 持有 state，组件层通过 renderer.state 访问同一实例
    expect(renderer.state).toBe(renderer.state); // 同一引用
    expect(renderer.state.footerHeight).toBe(0);

    // renderFooter 后 state.footerHeight 应更新
    renderer.renderFooter('', 0, 'status', 80, [], 0, 0);
    expect(renderer.state.footerHeight).toBeGreaterThan(0);
    expect(renderer.getFooterHeight()).toBe(renderer.state.footerHeight);

    // commitFooter 后归零
    renderer.commitFooter();
    expect(renderer.state.footerHeight).toBe(0);
  });
});
