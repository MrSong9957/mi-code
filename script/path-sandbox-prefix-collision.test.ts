// 回归测试：路径沙箱前缀碰撞（path-sandbox.ts）
//
// 物理本质：小区门禁刷车牌。
// safePath 用 startsWith(workdir) 判断"是不是本小区的车"，
// 但车牌 "京A123" 会误匹配 "京A1234"——前者只是后者的前缀。
// 对应到这里：workdir=/a/sub 时，/a/sub_evil/x 因前缀相同被误判为"内部"，越界写。
//
// 风险等级：🔴 数据（越界写覆盖工作区外文件）
// 出错后果：write_file/edit_file 的沙箱形同虚设，可写穿到工作区外任意位置。
//
// 测试策略：
//   - 正向基线（.. 穿越、绝对路径外逃、正常内部路径）用普通 it，必须常绿。
//   - 前缀碰撞 bug 用 it.fails 锁定——当前实现放行了它（断言"应抛错"会失败），
//     it.fails 让这个"失败"变成绿色，表示"已知缺口已被记录"。
//     修复后（改用尾部分隔符，与 isPathOutsideWorkspace 对齐）该测试会变红，
//     提醒维护者删掉 .fails、把它转为正式断言。
//
// 对照基准：permission/patterns.ts 的 isPathOutsideWorkspace 是正确实现（用了尾部分隔符），
// 两者行为应对齐——这正是回归要守住的底线。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { safePath, setWorkdir, getWorkdir } from '../src/agent/tools/path-sandbox.js';
import { isPathOutsideWorkspace } from '../src/permission/patterns.js';

describe('path-sandbox 前缀碰撞回归', () => {
  let sandboxDir: string;
  let originalWorkdir: string;

  beforeEach(() => {
    originalWorkdir = getWorkdir();
    // 造一个真实临时目录作为 workdir
    sandboxDir = mkdtempSync(join(tmpdir(), 'sandbox-collision-'));
    setWorkdir(sandboxDir);
  });

  afterEach(() => {
    setWorkdir(originalWorkdir);
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  // ── 正向基线：这些必须常绿 ──

  it('正常内部路径放行', () => {
    const p = safePath('foo.txt');
    expect(p).toBe(join(sandboxDir, 'foo.txt'));
  });

  it('.. 穿越逃逸正确抛错', () => {
    expect(() => safePath('../evil.txt')).toThrow('Path escapes workspace');
  });

  it('绝对路径指向工作区外正确抛错', () => {
    const outside = join(tmpdir(), 'outside-' + Date.now(), 'x.txt');
    expect(() => safePath(outside)).toThrow('Path escapes workspace');
  });

  // ── 对照基准：isPathOutsideWorkspace 是正确实现 ──

  it('isPathOutsideWorkspace 正确识别前缀碰撞为外部', () => {
    // 构造碰撞路径：sandboxDir + "_evil"（前缀相同，实为兄弟目录）
    const collisionDir = sandboxDir + '_evil';
    const collisionPath = join(collisionDir, 'stolen.txt');
    expect(isPathOutsideWorkspace(collisionPath, sandboxDir)).toBe(true);
  });

  // ── 回归核心：safePath 的 bug 锁定 ──
  //
  // 当前 safePath 用 startsWith(workdir) 未加尾部分隔符，
  // 会把 sandboxDir + "_evil/..." 误判为内部、放行越界写。
  // 本测试断言"应抛错"——因 bug 存在，断言会失败；
  // it.fails 把这个失败标绿，表示"缺口已记录"。
  // 修复 safePath 后请删除 .fails。
  it.fails('前缀碰撞路径（workdir + 兄弟后缀）必须抛错 [已知 bug，待修复]', () => {
    const collisionDir = sandboxDir + '_evil';
    const collisionPath = join(collisionDir, 'stolen.txt');
    // 期望：safePath 与 isPathOutsideWorkspace 对齐，判定为越界并抛错
    expect(() => safePath(collisionPath)).toThrow('Path escapes workspace');
  });

  it('safePath 与 isPathOutsideWorkspace 对常见逃逸行为一致', () => {
    // 抽样多个逃逸路径，两个实现都应判定为越界
    const escapes = [
      join(tmpdir(), 'elsewhere', 'a.txt'),
      join(sep, 'etc', 'passwd'),
    ];
    for (const p of escapes) {
      const outside = isPathOutsideWorkspace(p, sandboxDir);
      expect(outside).toBe(true);
      // 这些常规逃逸 safePath 已能正确拦截
      expect(() => safePath(p)).toThrow('Path escapes workspace');
    }
  });
});
