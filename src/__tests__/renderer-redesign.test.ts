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
    const lastFrame = frames[frames.length - 1]!;
    expect(lastFrame).toContain('\x1b[5;');
    expect(lastFrame).toContain('─');
    expect(lastFrame).toContain('MDL');
    expect(lastFrame).toContain('❯');
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
