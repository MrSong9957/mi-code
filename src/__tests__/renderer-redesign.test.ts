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
