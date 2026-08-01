// src/__tests__/tui/paste-handler.test.ts
// 粘贴占位符：存储 + 展开 + 截断

import { describe, it, expect, beforeEach } from 'vitest';
import { storePastedContent, expandPastedTextRefs, resetPasteState } from '../../tui/input/paste-handler.js';

describe('paste-handler', () => {
  beforeEach(() => {
    resetPasteState();
  });

  it('storePastedContent 返回占位符（含行数）', () => {
    const content = 'line1\nline2\nline3';
    const placeholder = storePastedContent(content);
    expect(placeholder).toBe('[Pasted text #1 +3 lines]');
  });

  it('多次粘贴 ID 递增', () => {
    const p1 = storePastedContent('a\nb');
    const p2 = storePastedContent('c\nd');
    expect(p1).toBe('[Pasted text #1 +2 lines]');
    expect(p2).toBe('[Pasted text #2 +2 lines]');
  });

  it('expandPastedTextRefs 还原原始内容', () => {
    const content = 'hello\nworld';
    const placeholder = storePastedContent(content);
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe(content);
  });

  it('expandPastedTextRefs 处理多个占位符', () => {
    const p1 = storePastedContent('aaa');
    const p2 = storePastedContent('bbb');
    const text = `before ${p1} middle ${p2} after`;
    const expanded = expandPastedTextRefs(text);
    expect(expanded).toBe('before aaa middle bbb after');
  });

  it('expandPastedTextRefs 不改变无占位符文本', () => {
    const expanded = expandPastedTextRefs('no placeholders here');
    expect(expanded).toBe('no placeholders here');
  });

  it('长内容（>10000字符）占位符显示截断 + 前后500字符预览', () => {
    const longContent = 'x'.repeat(12000);
    const placeholder = storePastedContent(longContent);
    // 新格式：[<前500字符>...Truncated text #N +M lines...<后500字符>]
    expect(placeholder).toMatch(/^\[x{500}\.\.\.Truncated text #1 \+1 lines\.\.\.x{500}\]$/);
  });

  it('长内容展开后为完整原文', () => {
    const longContent = 'x'.repeat(12000);
    const placeholder = storePastedContent(longContent);
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe(longContent);
    expect(expanded.length).toBe(12000);
  });

  it('resetPasteState 清空所有存储', () => {
    storePastedContent('aaa\nbbb');
    storePastedContent('ccc\nddd');
    resetPasteState();
    const p = storePastedContent('eee\nfff');
    expect(p).toBe('[Pasted text #1 +2 lines]');
  });

  it('多行内容显示 +N lines', () => {
    const placeholder = storePastedContent('line one\nline two');
    expect(placeholder).toBe('[Pasted text #1 +2 lines]');
  });

  it('expandPastedTextRefs 保留占位符周围的文本', () => {
    const p1 = storePastedContent('code snippet');
    const text = `Please review this:\n${p1}\nThanks`;
    const expanded = expandPastedTextRefs(text);
    expect(expanded).toBe('Please review this:\ncode snippet\nThanks');
  });

  it('expandPastedTextRefs 处理空输入', () => {
    expect(expandPastedTextRefs('')).toBe('');
  });

  // ── 边界值 ──

  it('截断阈值：9999 字符不截断', () => {
    const content = 'x'.repeat(9999);
    const placeholder = storePastedContent(content);
    expect(placeholder).toBe('[Pasted text #1 +1 lines]');
  });

  it('截断阈值：10000 字符不截断（> 不含等于）', () => {
    const content = 'x'.repeat(10000);
    const placeholder = storePastedContent(content);
    expect(placeholder).toBe('[Pasted text #1 +1 lines]');
  });

  it('截断阈值：10001 字符触发截断（含前后预览）', () => {
    const content = 'x'.repeat(10001);
    const placeholder = storePastedContent(content);
    expect(placeholder).toMatch(/^\[x{500}\.\.\.Truncated text #1 \+1 lines\.\.\.x{500}\]$/);
  });

  it('空内容粘贴：直显空串（单行 0 字符，不折叠）', () => {
    // 空内容直显，不产生占位符噪音
    const placeholder = storePastedContent('');
    expect(placeholder).toBe('');
  });

  it('多行内容首行空：折叠 + 行数正确', () => {
    const placeholder = storePastedContent('\nsecond');
    expect(placeholder).toBe('[Pasted text #1 +2 lines]');
  });

  it('纯换行内容：行数正确', () => {
    // "\n\n\n".split('\n') → ["", "", "", ""] → length=4
    const placeholder = storePastedContent('\n\n\n');
    expect(placeholder).toBe('[Pasted text #1 +4 lines]');
  });

  it('截断内容跨多行：行数正确 + 前后预览', () => {
    const content = 'a\n'.repeat(6000); // 12000 chars, 6001 lines (末尾 \n 多拆一行)
    const placeholder = storePastedContent(content);
    expect(placeholder).toMatch(/\+6001 lines/);
    // 含前后预览（前500字符是 'a\na\n...'，后500字符是 'a\na\n...'）。
    // 用 [\s\S] 匹配含换行的任意字符（. 不匹配 \n）。
    expect(placeholder).toMatch(/^\[[\s\S]{500}\.\.\.Truncated text #1 \+6001 lines\.\.\.[\s\S]{500}\]$/);
  });

  // ── 异常与非法输入 ──

  it('expandPastedTextRefs：不存在的 ID 保留占位符原样', () => {
    const result = expandPastedTextRefs('[Pasted text #999 +1 lines]');
    expect(result).toBe('[Pasted text #999 +1 lines]');
  });

  it('expandPastedTextRefs：不存在的截断 ID 保留原样', () => {
    // 新格式含前后预览，不存在的 ID 原样返回
    const fake = '[aaa...Truncated text #999 +1 lines...bbb]';
    const result = expandPastedTextRefs(fake);
    expect(result).toBe(fake);
  });

  it('expandPastedTextRefs：缺少右方括号不匹配', () => {
    const result = expandPastedTextRefs('[Pasted text #1 +1 lines');
    expect(result).toBe('[Pasted text #1 +1 lines');
  });

  it('expandPastedTextRefs：非数字 ID 不匹配', () => {
    const result = expandPastedTextRefs('[Pasted text #abc +1 lines]');
    expect(result).toBe('[Pasted text #abc +1 lines]');
  });

  it('expandPastedTextRefs：少 s 不匹配', () => {
    const result = expandPastedTextRefs('[Pasted text #1 +1 line]');
    expect(result).toBe('[Pasted text #1 +1 line]');
  });

  it('expandPastedTextRefs：双括号不匹配', () => {
    const result = expandPastedTextRefs('[[Pasted text #1 +1 lines]]');
    expect(result).toBe('[[Pasted text #1 +1 lines]]');
  });

  it('resetPasteState 后旧 ID 指向新内容', () => {
    const p1 = storePastedContent('old\ncontent');
    resetPasteState();
    const p2 = storePastedContent('new\ncontent');
    // p1 的 ID=1 现在指向 'new\ncontent'，不是 'old\ncontent'
    expect(expandPastedTextRefs(p1)).toBe('new\ncontent');
    expect(expandPastedTextRefs(p2)).toBe('new\ncontent');
  });
});

describe('图片占位符 [Image #N] 不展开（走单独 content block）', () => {
  beforeEach(() => {
    resetPasteState();
  });

  it('图片占位符原样保留，不展开', () => {
    expect.hasAssertions();
    expect(expandPastedTextRefs('[Image #1]')).toBe('[Image #1]');
  });

  it('图片占位符与粘贴占位符混存：仅展开粘贴占位符', () => {
    expect.hasAssertions();
    // 用多行内容确保触发折叠（短文本现在直显，不生成占位符）
    const pasted = storePastedContent('文本内容\n第二行');
    const result = expandPastedTextRefs(`${pasted} 配图 [Image #1]`);
    expect(result).toContain('文本内容\n第二行');
    expect(result).not.toContain('[Pasted text #');
    expect(result).toContain('[Image #1]');
  });
});

describe('短文本直显阈值（单行且 ≤80 字符不折叠）', () => {
  beforeEach(() => {
    resetPasteState();
  });

  it('短单行文本：原样返回，不生成占位符', () => {
    expect.hasAssertions();
    const result = storePastedContent('hello world');
    expect(result).toBe('hello world');
    expect(result).not.toContain('[Pasted text');
  });

  it('短单行中文：原样返回', () => {
    expect.hasAssertions();
    const result = storePastedContent('你好世界');
    expect(result).toBe('你好世界');
  });

  it('恰好 80 字符单行：直显（边界，≤ 阈值）', () => {
    expect.hasAssertions();
    const content = 'x'.repeat(80);
    const result = storePastedContent(content);
    expect(result).toBe(content);
    expect(result).not.toContain('[Pasted text');
  });

  it('81 字符单行：折叠（> 阈值）', () => {
    expect.hasAssertions();
    const content = 'x'.repeat(81);
    const result = storePastedContent(content);
    expect(result).toBe('[Pasted text #1 +1 lines]');
  });

  it('多行文本（即使每行很短）：折叠', () => {
    expect.hasAssertions();
    const result = storePastedContent('a\nb');
    expect(result).toBe('[Pasted text #1 +2 lines]');
  });

  it('空字符串：直显（单行 0 字符，不折叠）', () => {
    expect.hasAssertions();
    const result = storePastedContent('');
    // 空字符串直显——粘贴空内容无意义，不应产生占位符噪音
    expect(result).toBe('');
  });

  it('短文本不进 pastedContents Map：不影响后续 ID 自增', () => {
    expect.hasAssertions();
    // 第一个短文本不进 Map（不消耗 ID）
    storePastedContent('short');
    // 第二个长文本（多行）应该是 #1，不是 #2
    const p2 = storePastedContent('line1\nline2');
    expect(p2).toBe('[Pasted text #1 +2 lines]');
  });
});

// ── 换行符归一化(修复真实终端 bracketed paste 的 \r / \r\n 问题)──
//
// 物理本质:真实终端(Windows Terminal 等)粘贴多行内容时,bracketed paste 把
// 换行编码成 \r(0x0D)而非 \n(0x0A)。若 paste 入口不归一化,下游所有环节
// (占位符行数统计、输入框渲染、历史渲染、落盘)都拿到 \r,而渲染层对纯 \r
// 的处理不当,造成"只显示部分内容且顺序异常"的视觉假象。
//
// 归一化边界:storePastedContent —— paste 内容进入系统的唯一入口。在这里归一化,
// 短文本直显分支和长文本 Map 分支都拿到 \n。
describe('换行符归一化(CR/CRLF → LF)', () => {
  beforeEach(() => {
    resetPasteState();
  });

  it('CR-only 换行归一化为 LF(真实终端 paste 的典型场景)', () => {
    expect.hasAssertions();
    // 真实终端 paste:换行是 \r(0x0D),不是 \n
    const crContent = '第一段\r第二段\r第三段';
    const placeholder = storePastedContent(crContent);
    expect(placeholder).toBe('[Pasted text #1 +3 lines]');
    // 展开后换行必须是 \n,不能残留 \r
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe('第一段\n第二段\n第三段');
    expect(expanded).not.toContain('\r');
  });

  it('CRLF 归一化为单个 LF(不能变成两个换行)', () => {
    expect.hasAssertions();
    const crlfContent = 'line1\r\nline2\r\nline3';
    const placeholder = storePastedContent(crlfContent);
    // 应是 3 行,不是 5 行(\r\n 不能拆成两个换行)
    expect(placeholder).toBe('[Pasted text #1 +3 lines]');
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe('line1\nline2\nline3');
    expect(expanded).not.toContain('\r');
  });

  it('普通 LF 保持不变(不误伤已是 \\n 的内容)', () => {
    expect.hasAssertions();
    const lfContent = 'line1\nline2';
    const placeholder = storePastedContent(lfContent);
    expect(placeholder).toBe('[Pasted text #1 +2 lines]');
    expect(expandPastedTextRefs(placeholder)).toBe('line1\nline2');
  });

  it('多行 paste 内容和顺序保持完整(CR-only,模拟真实复现案例)', () => {
    expect.hasAssertions();
    // 模拟真实终端粘贴的多行编号文本(换行全是 \r)
    const realWorldPaste = '请派 explore 子代理查日志系统：\r1. 找出日志库\r2. 找出初始化入口\r3. 找出日志级别配置\r4. 返回路径和结论\r不要修改代码。';
    const placeholder = storePastedContent(realWorldPaste);
    const expanded = expandPastedTextRefs(placeholder);
    // 顺序完整:每段都按原顺序保留
    expect(expanded.indexOf('请派')).toBeLessThan(expanded.indexOf('1. 找出日志库'));
    expect(expanded.indexOf('1. 找出日志库')).toBeLessThan(expanded.indexOf('2. 找出'));
    expect(expanded.indexOf('4. 返回')).toBeLessThan(expanded.indexOf('不要修改代码'));
    // 全部换行归一化为 \n,无 \r 残留
    expect(expanded).not.toContain('\r');
    expect(expanded.split('\n')).toHaveLength(6);
  });

  it('CR-only 短文本(原会被误判单行直显)现在正确识别为多行', () => {
    expect.hasAssertions();
    // 含 \r 的多行短文本:归一化后应识别为多行,折叠为占位符
    // (而非因不含 \n 被误判单行走直显分支,导致 \r 泄漏到渲染)
    const shortMultilineCR = 'a\rb\rc';
    const placeholder = storePastedContent(shortMultilineCR);
    expect(placeholder).toBe('[Pasted text #1 +3 lines]');
    expect(expandPastedTextRefs(placeholder)).toBe('a\nb\nc');
  });

  it('混合换行(CR + CRLF + LF)全部归一化为 LF', () => {
    expect.hasAssertions();
    const mixed = 'a\nb\r\nc\rd';
    const placeholder = storePastedContent(mixed);
    const expanded = expandPastedTextRefs(placeholder);
    expect(expanded).toBe('a\nb\nc\nd');
    expect(expanded).not.toContain('\r');
    // 4 行
    expect(expanded.split('\n')).toHaveLength(4);
  });
});
