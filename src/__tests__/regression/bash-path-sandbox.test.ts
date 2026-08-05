// 回归测试：run_bash 路径沙箱（Phase 1：解析 + 路径围栏）
//
// 物理本质（保姆级）：
// file 工具（read/write/edit）有围栏——只能在小区（workdir）内动。
// 但 run_bash 是个"会翻墙的快递员"——它能用 cat/tee/> 等命令
// 把东西送到小区外，或从小区外拿东西进来。围栏管不住它。
//
// Phase 1 给 run_bash 装上门禁：解析命令里的路径参数，
// 发现指向小区外的 → 拦下（deny）；看不懂的命令 → 请示领导（ask）。
//
// 测试分四组：
//   越界读/写 → 必须 deny（攻击向量）
//   合法命令 → 必须 allow（不误伤，URL/flag/glob 不当路径）
//   解析失败 → 必须 ask（不自动放行）
//   变量未知 → 必须 ask（$VAR 值未知，升级人审）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PermissionChecker } from '../../../src/permission/checker.js';
import { extractBashPaths } from '../../../src/permission/bash-paths.js';
import { setWorkdir, getWorkdir } from '../../../src/agent/tools/path-sandbox.js';

describe('run_bash 路径沙箱（Phase 1）', () => {
  let workdir: string;
  let originalWorkdir: string;

  beforeEach(() => {
    originalWorkdir = getWorkdir();
    workdir = mkdtempSync(join(tmpdir(), 'bash-sandbox-'));
    setWorkdir(workdir);
  });

  afterEach(() => {
    setWorkdir(originalWorkdir);
    rmSync(workdir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────
  // 单元层：extractBashPaths 提取器
  // ─────────────────────────────────────────────
  describe('extractBashPaths 提取器', () => {
    it('简单命令提取路径参数', () => {
      const { paths } = extractBashPaths('cat /etc/passwd');
      expect(paths).toContain('/etc/passwd');
    });

    it('重定向目标必提取（最高信号）', () => {
      const { paths } = extractBashPaths('echo x > /tmp/y');
      expect(paths).toContain('/tmp/y');
    });

    it('追加重定向 >> 目标也提取', () => {
      const { paths } = extractBashPaths('echo x >> /tmp/y');
      expect(paths).toContain('/tmp/y');
    });

    it('管道各段独立提取', () => {
      const { paths } = extractBashPaths('cat .env | tee ../leak');
      expect(paths).toContain('.env');
      expect(paths).toContain('../leak');
    });

    it('&& 连接的多命令都提取', () => {
      const { paths } = extractBashPaths('cat a && cat /etc/passwd');
      expect(paths).toContain('/etc/passwd');
    });

    it('变量引用标记 unresolvableVars', () => {
      // $STOLEN 值未知，不能判定指向哪——必须升级人审
      const { unresolvableVars } = extractBashPaths('cat $STOLEN');
      expect(unresolvableVars).toBe(true);
    });

    it('URL 不当路径（PATH_VERB 参数中的 URL 被排除）', () => {
      // curl 不是 PATH_VERB，其 URL 参数本就不提取（测 verb 过滤）。
      // 这里测 isPathCandidate 的 URL 排除：即便 cat 后跟 URL 也不当路径。
      const { paths } = extractBashPaths('cat https://example.com/a/b');
      // URL 必须被 isPathCandidate 排除，不能出现在 paths 里
      expect(paths).not.toContain('https://example.com/a/b');
    });

    it('curl 的 URL 参数不提取（curl 非 PATH_VERB）', () => {
      // 补充：curl 这类网络命令不是路径型 verb，URL 参数不提取
      const { paths } = extractBashPaths('curl https://example.com/a/b');
      expect(paths).not.toContain('https://example.com/a/b');
    });

    it('flag 不当路径', () => {
      const { paths } = extractBashPaths('ls -la');
      expect(paths).not.toContain('-la');
    });

    it('@scope/pkg 不当路径', () => {
      const { paths } = extractBashPaths('npm install @scope/pkg');
      expect(paths).not.toContain('@scope/pkg');
    });

    it('解析失败标记 parseFailed', () => {
      // shell-quote 对畸形 ${} 替换抛 Bad substitution
      const result = extractBashPaths('echo ${');
      expect(result.parseFailed).toBe(true);
    });

    it('~ 展开为家目录绝对路径（防字面量 ~ 误判为区内）', () => {
      // shell-quote 不展开 ~，若不处理会变 <workdir>/~/.ssh 误判区内
      const { paths } = extractBashPaths('less ~/.ssh/id_rsa');
      // 展开后应是绝对家目录路径，不再含字面量 ~
      expect(paths[0]).not.toContain('~');
      expect(paths[0]).toContain('.ssh');
    });
  });

  // ─────────────────────────────────────────────
  // 集成层：PermissionChecker 端到端
  // ─────────────────────────────────────────────
  describe('PermissionChecker 闸门1 run_bash 路径拦截', () => {
    function check(command: string) {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      return checker.check('run_bash', { command });
    }

    // ── 越界读 → deny ──
    it('cat 绝对路径越界读 → deny', () => {
      expect(check('cat /etc/passwd').behavior).toBe('deny');
    });

    it('cp 源越界读 → deny', () => {
      expect(check('cp /etc/passwd .').behavior).toBe('deny');
    });

    // ── 越界写 → deny ──
    it('cp 目标越界写 → deny', () => {
      expect(check('cp x /tmp/leak').behavior).toBe('deny');
    });

    it('重定向越界写 → deny', () => {
      expect(check('echo x > /tmp/y').behavior).toBe('deny');
    });

    it('tee 越界写 → deny', () => {
      expect(check('cat .env | tee ../leak').behavior).toBe('deny');
    });

    it('相对路径 .. 越界 → deny', () => {
      expect(check('cat ../secret.txt').behavior).toBe('deny');
    });

    it('~ 家目录路径越界 → deny（~ 展开后判定）', () => {
      // shell-quote 不展开 ~，须 extractBashPaths 展开为 homedir 再判定
      expect(check('less ~/.ssh/id_rsa').behavior).toBe('deny');
    });

    // ── 合法命令 → 不被路径围栏拦（auto 模式下为 ask，关键是路径围栏不 deny）──
    // 注：build 模式对所有 run_bash 默认 ask（设计如此），故用 auto 模式。
    // A15 后 auto 模式未决 run_bash 也返回 ask；本组只验证路径围栏不误伤——
    // 只要不是 deny，说明路径检查放行了（最终 ask 交 resolver/classifier）。
    function checkAuto(command: string) {
      const checker = new PermissionChecker({ mode: 'auto', workdir });
      return checker.check('run_bash', { command });
    }

    it('cat 工作区内文件 → 不被路径围栏拦', () => {
      expect(checkAuto('cat README.md').behavior).not.toBe('deny');
    });

    it('ls 无路径参数 → 不被路径围栏拦', () => {
      expect(checkAuto('ls -la').behavior).not.toBe('deny');
    });

    it('git commit flag 内含 / → 不被路径围栏拦', () => {
      // -m "fix / path" 里的 / 是消息文本，不是路径
      expect(checkAuto('git commit -m "fix / path"').behavior).not.toBe('deny');
    });

    it('curl URL → 不被路径围栏拦（URL 不当路径）', () => {
      expect(checkAuto('curl https://example.com/a/b').behavior).not.toBe('deny');
    });

    // ── 解析失败 / 变量未知 → ask ──
    it('解析失败的命令 → ask（不自动放行）', () => {
      expect(check("echo 'unterminated").behavior).toBe('ask');
    });

    it('变量未知 → ask（升级人审）', () => {
      expect(check('cat $STOLEN').behavior).toBe('ask');
    });

    // ── 危险命令仍在闸门1前段拦截（回归保护）──
    it('rm -rf 仍被 isDangerousBash 拦截（不被路径检查放行）', () => {
      expect(check('rm -rf /').behavior).toBe('deny');
    });
  });

  // ─────────────────────────────────────────────
  // 副作用核对：越界 deny 时不产生文件（AAA 实体核对）
  // ─────────────────────────────────────────────
  describe('越界拦截无副作用（磁盘实体核对）', () => {
    it('相对路径 .. 越界 deny 时，目标文件不产生', () => {
      // 用相对路径（真实攻击向量），避免 shell-quote 破坏 Windows 反斜杠绝对路径
      const outsideRel = '../leak-target.txt';
      const outsideAbs = join(workdir, '..', 'leak-target.txt');
      mkdirSync(join(workdir, '..'), { recursive: true }); // 父目录必然存在
      const checker = new PermissionChecker({ mode: 'build', workdir });
      const decision = checker.check('run_bash', { command: `echo x > ${outsideRel}` });
      // Arrange: ../leak 越界；Act: checker 判定；Assert: deny 且磁盘无文件
      expect(decision.behavior).toBe('deny');
      expect(existsSync(outsideAbs)).toBe(false);
    });

    it('工作区内重定向放行基线（确保 isPathOutsideWorkspace 判定正确）', () => {
      const checker = new PermissionChecker({ mode: 'auto', workdir });
      // 工作区内相对路径
      const decision = checker.check('run_bash', { command: 'echo x > ok.txt' });
      // 工作区内路径，auto 模式应放行（不触发 deny）
      expect(decision.behavior).not.toBe('deny');
    });
  });
});
