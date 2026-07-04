// 单测：cli.ts —— argv 解析
import { describe, it, expect } from 'vitest';
import { parseCliArgs } from '../cli.js';

describe('parseCliArgs', () => {
  it('无参数 → 空对象（新会话）', () => {
    expect(parseCliArgs([])).toEqual({});
  });

  it('--resume <id> → resume 字段', () => {
    expect(parseCliArgs(['--resume', 'abc-123'])).toEqual({ resume: 'abc-123' });
  });

  it('-r <id> 短格式', () => {
    expect(parseCliArgs(['-r', 'xyz'])).toEqual({ resume: 'xyz' });
  });

  it('--continue → continueLatest: true', () => {
    expect(parseCliArgs(['--continue'])).toEqual({ continueLatest: true });
  });

  it('-c 短格式', () => {
    expect(parseCliArgs(['-c'])).toEqual({ continueLatest: true });
  });

  it('--list → list: true', () => {
    expect(parseCliArgs(['--list'])).toEqual({ list: true });
  });

  it('未知参数忽略（不报错）', () => {
    expect(parseCliArgs(['--unknown', 'value'])).toEqual({});
  });

  it('--resume 没给值 → 降级为新会话（不抛错）', () => {
    // --resume 单独出现没跟值时，parseArgs strict:false 会当 boolean，降级处理
    const opts = parseCliArgs(['--resume']);
    // resume 字段不存在或非 string
    expect(opts.resume).toBeUndefined();
  });

  it('混合参数正常解析', () => {
    expect(parseCliArgs(['--resume', 'sid', '--unknown', 'x'])).toEqual({ resume: 'sid' });
  });
});
