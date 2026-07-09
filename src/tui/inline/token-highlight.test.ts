// token-highlight 测试（RED 阶段）
//
// 验证 inline token 检测：把一行文本切成 segments（白色默认/蓝色/加粗），
// 拼成 ANSI 串。白底为主，文件路径/命令/包名蓝色，**bold** 加粗。

import { describe, it, expect } from 'vitest';
import { detectTokens, highlightLine } from './token-highlight.js';

describe('detectTokens：token 切片', () => {
  it('纯文本 → 单 segment 无 SGR（白色默认）', () => {
    const segs = detectTokens('hello world');
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe('hello world');
    expect(segs[0].sgr).toBe(''); // 无 SGR = 白色默认
  });

  it('反引号命令 `npm install` → 蓝色 segment，去掉反引号', () => {
    const segs = detectTokens('run `npm install` now');
    // 至少 3 段：'run ' + 'npm install'(蓝) + ' now'
    const blueSeg = segs.find(s => s.text === 'npm install');
    expect(blueSeg).toBeDefined();
    expect(blueSeg!.sgr).toContain('\x1b[34m'); // blue
    // 不含反引号
    expect(segs.every(s => !s.text.includes('`'))).toBe(true);
  });

  it('Markdown 加粗 **text** → bold segment，去掉 **', () => {
    const segs = detectTokens('this is **important** text');
    const boldSeg = segs.find(s => s.text === 'important');
    expect(boldSeg).toBeDefined();
    expect(boldSeg!.sgr).toContain('\x1b[1m'); // bold
    expect(segs.every(s => !s.text.includes('**'))).toBe(true);
  });

  it('文件路径 src/config/schema.ts → 蓝色', () => {
    const segs = detectTokens('edit src/config/schema.ts please');
    const pathSeg = segs.find(s => s.text.includes('src/config/schema.ts'));
    expect(pathSeg).toBeDefined();
    expect(pathSeg!.sgr).toContain('\x1b[34m');
  });

  it('带扩展名的文件 .transcripts/、AGENTS.md → 蓝色', () => {
    const segs = detectTokens('see AGENTS.md and .transcripts/');
    const mdSeg = segs.find(s => s.text === 'AGENTS.md');
    expect(mdSeg).toBeDefined();
    expect(mdSeg!.sgr).toContain('\x1b[34m');
  });

  it('目录名 node_modules → 蓝色', () => {
    const segs = detectTokens('check node_modules folder');
    const dirSeg = segs.find(s => s.text === 'node_modules');
    expect(dirSeg).toBeDefined();
    expect(dirSeg!.sgr).toContain('\x1b[34m');
  });

  it('混合：反引号命令 + 加粗 + 纯文本', () => {
    const segs = detectTokens('see `src/index.ts` for **details**');
    // 应含：蓝色 src/index.ts + 加粗 details
    const blueSeg = segs.find(s => s.text === 'src/index.ts');
    const boldSeg = segs.find(s => s.text === 'details');
    expect(blueSeg?.sgr).toContain('\x1b[34m');
    expect(boldSeg?.sgr).toContain('\x1b[1m');
  });

  it('空字符串 → 空数组', () => {
    expect(detectTokens('')).toEqual([]);
  });
});

describe('highlightLine：拼接 ANSI 串', () => {
  it('纯文本 → 原样返回（无 SGR）', () => {
    expect(highlightLine('hello')).toBe('hello');
  });

  it('蓝色 token → 含 \\x1b[34m + RESET', () => {
    const out = highlightLine('run `npm install`');
    expect(out).toContain('\x1b[34m');
    expect(out).toContain('npm install');
    expect(out).toContain('\x1b[0m'); // RESET
    // 不含反引号
    expect(out).not.toContain('`');
  });

  it('加粗 token → 含 \\x1b[1m + RESET', () => {
    const out = highlightLine('this is **key**');
    expect(out).toContain('\x1b[1m');
    expect(out).toContain('key');
    expect(out).toContain('\x1b[0m');
    expect(out).not.toContain('**');
  });

  it('无 token 时不产生任何 SGR 序列', () => {
    const out = highlightLine('just plain text');
    expect(out).toBe('just plain text');
    expect(out).not.toContain('\x1b[');
  });
});
