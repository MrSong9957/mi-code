// inline overlay（ctrl+o 备用屏）测试（RED 阶段）
//
// 验证 InlineApp 在 inline 模式下渲染 overlay（ctrl+o 打开的 thinking 全文）：
// overlayStore.visible=true 时，清除屏幕显示 overlay 内容；
// visible=false 时正常渲染消息。

import { describe, it, expect, beforeEach } from 'vitest';
import { InlineRenderer } from './InlineRenderer.js';

function createMockStdout() {
  const written: string[] = [];
  return {
    written,
    get output() { return written.join(''); },
    clear() { written.length = 0; },
    write: (s: string) => { written.push(s); return true; },
  };
}

describe('InlineRenderer.renderOverlay：备用屏渲染', () => {
  let mock: ReturnType<typeof createMockStdout>;
  let renderer: InlineRenderer;

  beforeEach(() => {
    mock = createMockStdout();
    renderer = new InlineRenderer(mock as unknown as NodeJS.WriteStream);
  });

  it('renderOverlay 进入备用屏 + 显示标题 + 分隔线 + 内容行', () => {
    renderer.renderOverlay('Thinking', ['思考第一行', '思考第二行'], 80);
    const out = mock.output;
    // 进入备用屏序列（\x1b[?1049h）
    expect(out).toContain('\x1b[?1049h');
    // 标题
    expect(out).toContain('Thinking');
    // 内容行
    expect(out).toContain('思考第一行');
    expect(out).toContain('思考第二行');
  });

  it('exitOverlay 退出备用屏（\x1b[?1049l），终端自动恢复主屏', () => {
    renderer.exitOverlay();
    expect(mock.output).toContain('\x1b[?1049l');
  });

  it('renderOverlay 含返回提示（按 q / Ctrl+O / Esc 返回）', () => {
    renderer.renderOverlay('Thinking', ['内容'], 80);
    expect(mock.output).toContain('q');
    expect(mock.output).toContain('Esc');
  });
});
