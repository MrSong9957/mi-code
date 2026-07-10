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
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, sep } from 'path';
import { safePath, setWorkdir, getWorkdir } from '../../../src/agent/tools/path-sandbox.js';
import { isPathOutsideWorkspace } from '../../../src/permission/patterns.js';

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

  // ── 回归核心：safePath 前缀碰撞已修复 ──
  //
  // 前身是 it.fails 锁定的已知 bug（startsWith 未加尾部分隔符）。
  // 修复后（加 sep + realpath）该测试必须常绿：碰撞路径必须抛错。
  // 若此测试变红，说明 safePath 退化为 startsWith(workdir) 词法比较。
  //
  // 反假测试要点：必须把兄弟目录真实建在磁盘上（mkdirSync）。
  // 否则 realpath 回溯会退化到 workdir 自身，关卡 2 不抛错，
  // 词法关卡（关卡 1）即使被破坏也抓不到——测试会假绿。
  // 兄弟目录存在后，关卡 1 的 startsWith+sep 是唯一防线，
  // 破坏关卡 1（去 sep）本用例必须变红，证明测试真能测它。
  it('前缀碰撞路径（workdir + 兄弟后缀）必须抛错', () => {
    const collisionDir = sandboxDir + '_evil';
    mkdirSync(collisionDir, { recursive: true });
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
      expect(outside);
      // 这些常规逃逸 safePath 已能正确拦截
      expect(() => safePath(p)).toThrow('Path escapes workspace');
    }
  });

  // ── 符号链接逃逸：realpath 防御 ──
  //
  // 物理本质：工作区围墙内挖了一条地道（软链）通到外面。
  // 光看入口（词法路径）发现不了，必须顺着地道走到头（realpath）
  // 看它真正通到哪里——若通到工作区外，就是越界。
  //
  // 注意：Windows 默认无 Developer Mode/Admin 时 symlinkSync 报 EPERM。
  // 这是环境限制而非测试缺陷——软链逃逸在 Linux/macOS CI 上仍真实验证。
  // 本地不可建软链时自动 skip 并标注原因，避免假红/假绿。
  describe('符号链接逃逸防御', () => {
    function tryCreateSymlink(target: string, linkPath: string): boolean {
      try {
        symlinkSync(target, linkPath);
        return true;
      } catch (err) {
        // EPERM/EPERM-ish：Windows 无权限建软链 → 标记本环境不可测
        if (err instanceof Error && /EPERM|EACCES|insufficient|privilege/i.test(err.message)) {
          return false;
        }
        throw err;
      }
    }

    it('指向外部的软链路径必须抛错', ({ skip }) => {
      // Arrange: 外部目录（模拟工作区外敏感数据）+ 工作区内软链指向它
      const outsideDir = mkdtempSync(join(tmpdir(), 'sandbox-outside-'));
      try {
        const ok = tryCreateSymlink(outsideDir, join(sandboxDir, 'escape'));
        if (!ok) {
          skip('本环境不可创建符号链接（Windows 需 Developer Mode/Admin），跳过软链逃逸验证');
          return;
        }
        // Act: 走软链 escape/ 再进入 stolen.txt
        // Assert: realpath 解析后落在 workdir 之外，必须拦截
        expect(() => safePath('escape/stolen.txt')).toThrow('Path escapes workspace');
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it('指向工作区内部的软链不误伤', ({ skip }) => {
      // Arrange: 工作区内子目录 + 内部软链
      const innerTarget = join(sandboxDir, 'inner-target');
      mkdirSync(innerTarget, { recursive: true });
      const ok = tryCreateSymlink(innerTarget, join(sandboxDir, 'inner-link'));
      if (!ok) {
        rmSync(innerTarget, { recursive: true, force: true });
        skip('本环境不可创建符号链接（Windows 需 Developer Mode/Admin），跳过软链验证');
        return;
      }
      // Act: 经内部软链访问文件
      // Assert: realpath 仍在 workdir 内，正常返回（不抛错）
      const result = safePath('inner-link/file.txt');
      expect(result).toBe(join(sandboxDir, 'inner-link', 'file.txt'));
    });
  });

  // ── 未创建文件：realpath 回溯不误伤 ──
  //
  // 写文件常写尚不存在的深层路径（a/b/c/new.txt）。
  // realpath-existing-ancestor 算法回溯到最近存在的祖先（workdir 自身）后判定，
  // 不应因目标不存在而抛错。
  it('工作区内未创建的深层文件路径正常返回', () => {
    // Act: 指向尚不存在的多层深层文件
    // Assert: 回溯到存在的 workdir 后，realpath 自身仍在内部，放行
    const result = safePath('a/b/c/new.txt');
    expect(result).toBe(join(sandboxDir, 'a', 'b', 'c', 'new.txt'));
  });
});
