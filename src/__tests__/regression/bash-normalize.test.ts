// 回归测试：归一化检测（Phase 3：防引号拼接混淆攻击）
//
// 物理本质（保姆级）：
// isDangerousBash 用正则找 "rm -rf" 这种关键词，像安检员看行李标签。
// AI 可以用引号把标签撕开重贴——'r''m' -rf ——正则看到的是三个独立片段
// 'r'、'm'、-rf，找不到连续的 "rm"，于是放行。
//
// 归一化检测 = 安检员先把行李里的东西拼回原样再看。
// shell-quote 的 tokenizer 会把 'r''m' 合并成 "rm"，
// 再对合并后的命令跑正则，混淆就被拆穿了。
//
// 真实威胁面（调研结论）：四种"混淆攻击"里只有引号拼接是真缺口，
// 其余（$VAR、$()）已被 Phase 1-2 拦。本测试聚焦这个唯一缺口 + 不误伤正常引号。

import { describe, it, expect } from 'vitest';
import { normalizeBashForCheck } from '../../../src/permission/bash-normalize.js';
import { isDangerousBash } from '../../../src/permission/patterns.js';

describe('归一化检测（Phase 3：防引号拼接混淆）', () => {
  // ─────────────────────────────────────────────
  // 归一化器单元：normalizeBashForCheck
  // ─────────────────────────────────────────────
  describe('normalizeBashForCheck 归一化器', () => {
    it('单引号拼接合并：\'r\'\'m\' → rm', () => {
      const result = normalizeBashForCheck("'r''m' -rf /");
      expect(result).toContain('rm');
    });

    it('混合引号拼接合并：r\'m\' → rm', () => {
      const result = normalizeBashForCheck("r'm' -rf /");
      expect(result).toContain('rm');
    });

    it('双引号拼接合并："r""m" → rm', () => {
      const result = normalizeBashForCheck('"r""m" -rf /');
      expect(result).toContain('rm');
    });

    it('多段引号拼接：\'s\'\'u\'\'d\'\'o\' → sudo', () => {
      const result = normalizeBashForCheck("'s''u''d''o' whoami");
      expect(result).toContain('sudo');
    });

    it('正常引号包参数不改变命令名', () => {
      // 引号包的是参数（hello world），不是拼命令名——归一化后命令名仍是 echo
      const result = normalizeBashForCheck('echo "hello world"');
      expect(result.startsWith('echo')).toBe(true);
      expect(result).toContain('hello world');
    });

    it('含重定向 operator 还原', () => {
      // > 是 operator 对象，重拼应还原成 > 字符
      const result = normalizeBashForCheck('echo x > /tmp/y');
      expect(result).toContain('>');
      expect(result).toContain('/tmp/y');
    });

    it('parse 失败（畸形 ${}）返回原始字符串，不抛错', () => {
      // shell-quote 对畸形 ${} 抛 Bad substitution——归一化器应保守返回原文
      const malformed = 'echo ${';
      const result = normalizeBashForCheck(malformed);
      expect(result).toBe(malformed);
    });
  });

  // ─────────────────────────────────────────────
  // 集成层：isDangerousBash 经归一化后抓引号拼接
  // ─────────────────────────────────────────────
  describe('isDangerousBash 抓引号拼接攻击', () => {
    it('\'r\'\'m\' -rf / → dangerous（rm 被正则抓到）', () => {
      // 核心缺口：原始字符串正则看不到 "rm"，归一化后看到
      expect(isDangerousBash("'r''m' -rf /")).toBe(true);
    });

    it('r\'m\' -rf / → dangerous', () => {
      expect(isDangerousBash("r'm' -rf /")).toBe(true);
    });

    it('"r""m" -rf / → dangerous', () => {
      expect(isDangerousBash('"r""m" -rf /')).toBe(true);
    });

    it('\'s\'\'u\'\'d\'\'o\' whoami → dangerous（sudo 被抓）', () => {
      expect(isDangerousBash("'s''u''d''o' whoami")).toBe(true);
    });
  });

  // ─────────────────────────────────────────────
  // 基线：正常命令不被误判（不破坏现有行为）
  // ─────────────────────────────────────────────
  describe('正常命令不被误判', () => {
    it('echo "hello world" → safe（引号包参数不拼命令名）', () => {
      expect(isDangerousBash('echo "hello world"')).toBe(false);
    });

    it('git commit -m "fix" → safe', () => {
      expect(isDangerousBash('git commit -m "fix"')).toBe(false);
    });

    it('ls -la → safe（无引号无危险词）', () => {
      expect(isDangerousBash('ls -la')).toBe(false);
    });

    it('原有 rm -rf / 仍被直接抓到（不依赖归一化）', () => {
      // 回归保护：原始字符串的 rm -rf 仍被正则直接抓（归一化是叠加，非替代）
      expect(isDangerousBash('rm -rf /')).toBe(true);
    });

    it('原有 sudo 仍被直接抓到', () => {
      expect(isDangerousBash('sudo apt-get install x')).toBe(true);
    });
  });
});
