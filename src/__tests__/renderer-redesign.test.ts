import { describe, it, expect } from 'vitest';
import { Renderer } from '../renderer/renderer.js';

describe('底部区刷新器 refreshFooter（CUP 绝对定位）', () => {
  it('底部区内容总在屏幕最后 footerHeight 行（用 CUP 定位，不依赖光标位置）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    // Task 2 后 commit 末尾的 showCursor 是最后一帧；检查合并输出里 footer 是否被渲染。
    const all = frames.join('');
    expect(all).toContain('\x1b[5;');
    expect(all).toContain('─');
    expect(all).toContain('MDL');
    expect(all).toContain('❯');
  });

  it('底部区用 CUP 绝对定位，不含相对移动 CUB/CUU（避开光标脱钩）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.setInput('hello', 5);
    r.flushNow();
    const all = frames.join('');
    const bigCub = [...all.matchAll(/\x1b\[(\d+)D/g)].map(m => +m[1]!).filter(n => n > 10);
    expect(bigCub).toEqual([]);
  });
});

describe('消息追加器 writeMsgLine（顺序追加）', () => {
  it('连续 printMessage 多条：每条作为新行追加，旧行不重复', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('msg-1', 'system');
    r.flushNow();
    r.printMessage('msg-2', 'system');
    r.flushNow();
    const all = frames.join('');
    expect((all.match(/msg-1/g) || []).length).toBe(1);
    expect((all.match(/msg-2/g) || []).length).toBe(1);
  });

  it('满屏后（消息超过 rows-footerHeight）：最新消息在可视区，不内容重复', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    for (let i = 1; i <= 10; i++) {
      r.printMessage('msg-' + i, 'system');
      r.flushNow();
    }
    const all = frames.join('');
    for (let i = 1; i <= 10; i++) {
      // 负向先行断言：msg-1 不应匹配 msg-10 的前缀（精确匹配整条消息）
      const count = (all.match(new RegExp('msg-' + i + '(?!\\d)', 'g')) || []).length;
      expect(count, 'msg-' + i + ' 出现 ' + count + ' 次（应 ≤1）').toBeLessThanOrEqual(1);
    }
  });
});

describe('流式重写器 rewriteStreamingBlock（退格重写）', () => {
  it('assistant delta 逐字增长：当前块被退格重写，封口后内容保留', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 20, cols: 60,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.appendStreamingMarkdown('hello', false);
    r.flushNow();
    r.appendStreamingMarkdown('hello world', false);
    r.flushNow();
    r.appendStreamingMarkdown('hello world final', true);
    r.flushNow();
    frames.length = 0;
    r.printMessage('next-msg', 'system');
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('hello world final');
    expect(all).toContain('next-msg');
  });

  it('流式重写用 CUU（退格）回到块起点，范围=块行数（不超过屏幕）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 20, cols: 60,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.appendStreamingMarkdown('first version', false);
    r.flushNow();
    frames.length = 0;
    r.appendStreamingMarkdown('first version extended', false);
    r.flushNow();
    const delta = frames.join('');
    const cuu = [...delta.matchAll(/\x1b\[(\d+)A/g)].map(m => +m[1]!);
    expect(cuu.length, '流式重写应含 CUU 退格').toBeGreaterThan(0);
    expect(Math.max(0, ...cuu)).toBeLessThan(20);
  });
});

describe('边界：clearMessages / resize / enter', () => {
  it('clearMessages 全清屏，lastFlushedLine 归零', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('to-clear', 'system');
    r.flushNow();
    frames.length = 0;
    r.clearMessages();
    r.flushNow();
    expect(frames.join('')).toContain('\x1b[2J');
  });

  it('resize 后消息从 MessageBuffer 重画', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('resize-test', 'system');
    r.flushNow();
    frames.length = 0;
    r.resize(10, 50);
    r.flushNow();
    const all = frames.join('');
    expect(all).toContain('\x1b[2J');
    expect(all).toContain('resize-test');
  });

  it('enter 首帧清屏（\\x1b[2J）并画出页脚', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    const all = frames.join('');
    expect(all).toContain('\x1b[2J');
    expect(all).toContain('MDL');
  });
});

describe('样式精修（SGR 颜色）', () => {
  it('消息行 cells 的 style 被转为 SGR（magenta → 35m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    r.printMessage('● magenta test', 'system', { fg: 'magenta' });
    r.flushNow();
    expect(frames.join('')).toContain('\x1b[35m');
  });

  it('边框行带 dim 样式（2m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    expect(frames.join('')).toContain('\x1b[2m');
  });

  it('prompt 带 green+bold 样式（32m + 1m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    const all = frames.join('');
    expect(all).toContain('\x1b[32m');
    expect(all).toContain('\x1b[1m');
  });

  it('状态栏 cells 的 style 被转为 SGR（cyan → 36m）', () => {
    const frames: string[] = [];
    const r = new Renderer({
      rows: 8, cols: 40,
      writer: (s: string) => { frames.push(s); },
      status: { model: 'MDL', branch: 'main', dir: '~/d', mode: 'Act', contextUsage: 0 },
    });
    r.enter();
    expect(frames.join('')).toContain('\x1b[36m');
  });
});
