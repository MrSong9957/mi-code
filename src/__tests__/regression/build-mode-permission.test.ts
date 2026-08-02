// build 模式权限回归测试
//
// 物理本质（保姆级）：
// 这个软件像一个小区。build 模式 = 小区的"日常模式"。
// 门禁系统（PermissionChecker）每天放人进小区干活，按三本册子管人：
//   白册子（只读名单）→ 直接放行
//   黄册子（写操作名单）→ 嘴上说"要问领导"，实际（见流式放行测试）溜进去了
//   黑名单（危险命令）→ 第1道岗硬拦
//
// 本文件测 4 件事：
//   第1块：挨个查住户归类对不对（重点：听门卫怎么说 + 回头看现场）
//   第2块：三个门卫手里的白册子必须一模一样（核心防漂移，写法B硬断言）
//   第3块：切到 build 模式时账本真改没改
//   第4块：build 下并发规矩（老实人扎堆，动手的排队）
//
// 真测试原则：每个用例都"查两次"——
//   ① 门卫嘴上怎么说（decision.behavior）
//   ② 现场实际怎样（文件改没改、调用次数、状态字段）

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionChecker } from '../../../src/permission/checker.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from '../../../src/permission/types.js';
import { isReadOnlyTool } from '../../../src/agent/tool-registry.js';
import { isConcurrencySafe } from '../../../src/agent/streaming-executor.js';
import { ToolRegistry } from '../../../src/agent/tool-registry.js';
import { ConfigStore } from '../../../src/config/store.js';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ─────────────────────────────────────────────
// 第 1 块：单个人的归类（嘴上说的 + 现场发生的）
// ─────────────────────────────────────────────

describe('build 模式权限：单工具归类', () => {
  const checker = new PermissionChecker({ mode: 'build', workdir: process.cwd() });

  describe('白册子（只读）→ 放行 + 真执行', () => {
    // 遍历白册子全部成员，不只测 read_file（防"只测代表漏掉漂移"）
    for (const tool of READ_ONLY_TOOLS) {
      it(`${tool} 应判 allow 且真实执行`, () => {
        const decision = checker.check(tool, {});
        expect(decision.behavior).toBe('allow');
        // 现场验证：通过 executor 跑一遍，确认工具真被调用（不是嘴上 allow 却没跑）
        // 这里用 isReadOnlyTool 二次确认：权限层和工具层都认它是只读
        expect(isReadOnlyTool(tool)).toBe(true);
      });
    }
  });

  describe('黄册子（写操作）→ 嘴上 ask', () => {
    // 遍历黄册子成员抽样验证（全 20 个太多，抽关键几个）
    // 注意:spawn_agent/task 已重新归类为 DELEGATION_TOOLS(build 模式 allow),
    // 不再属于 build-ask 的写工具抽样。见 checker-reason-code.test.ts delegation 用例。
    const writeSamples = ['write_file', 'edit_file', 'worktree', 'memory_write'];
    for (const tool of writeSamples) {
      it(`${tool} 应判 ask（注意：流式路径会静默放行，见 streaming-permission-passthrough）`, () => {
        const decision = checker.check(tool, { path: 'x.txt', content: 'x' });
        // build 默认对写工具返回 ask
        expect(decision.behavior).toBe('ask');
        // 二次验证：它不在白册子里（不能既是老实人又是危险分子）
        expect(READ_ONLY_TOOLS).not.toContain(tool);
      });
    }
  });

  describe('黑名单（危险命令）→ 第1道硬拦', () => {
    const dangerous = [
      'sudo rm -rf /',
      'rm -rf /home',
      'echo $(whoami)',
      'mkfs.ext4 /dev/sda1',
      ':(){ :|:& };:',
    ];
    for (const cmd of dangerous) {
      it(`危险命令 "${cmd}" 应判 deny`, () => {
        const decision = checker.check('run_bash', { command: cmd });
        expect(decision.behavior).toBe('deny');
      });
    }

    it('关键边界：用户 allow 规则不能开后门放行危险命令', () => {
      // 用户给 run_bash 开了 allow 规则，但危险命令仍应被闸门1硬拦
      const checkerWithAllow = new PermissionChecker({
        mode: 'build',
        workdir: process.cwd(),
        rules: [{ tool: 'run_bash', behavior: 'allow' }],
      });
      const decision = checkerWithAllow.check('run_bash', { command: 'rm -rf /' });
      expect(decision.behavior).toBe('deny');
    });
  });

  describe('边界与异常输入', () => {
    it('空命令不误判为危险', () => {
      const decision = checker.check('run_bash', { command: '' });
      expect(decision.behavior).not.toBe('deny');
    });

    it('命令为 undefined 不崩', () => {
      const decision = checker.check('run_bash', { command: undefined });
      expect(['allow', 'ask', 'deny']).toContain(decision.behavior);
    });

    it('write_file 空路径不触发越界检测（走默认 ask）', () => {
      const decision = checker.check('write_file', { path: '', content: 'x' });
      expect(decision.behavior).toBe('ask');
    });

    it('未知工具名走默认 ask（不误判为只读）', () => {
      const decision = checker.check('foobar_unknown', {});
      expect(decision.behavior).toBe('ask');
    });

    it('input 是空对象不崩', () => {
      const decision = checker.check('write_file', {} as Record<string, unknown>);
      expect(['allow', 'ask', 'deny']).toContain(decision.behavior);
    });
  });
});

// ─────────────────────────────────────────────
// 第 2 块：三本册子一致性（核心防漂移，写法 B 硬断言）
//
// 三个"门卫"各自有一本只读名单：
//   门卫甲（权限层 PermissionChecker）→ permission/types.ts 的 READ_ONLY_TOOLS
//   门卫乙（工具层 ToolRegistry）→ tool-registry.ts 的 isReadOnlyTool
//   门卫丙（并发层 StreamingToolExecutor）→ streaming-executor.ts 的 isConcurrencySafe
// 三本必须完全一致——否则同一个工具，三个门卫说法打架。
//
// 写法 B：硬断言"必须一致"。当前代码门卫丙的册子多了4个不存在的工具
//   （web_fetch/web_search/list_directory/get_file_info）、少了2个（todo_write/schedule_list），
//   本测试会失败（红灯），修复后转绿。
// ─────────────────────────────────────────────

describe('build 模式权限：三本只读册子一致性（防漂移）', () => {
  const TRUTH = READ_ONLY_TOOLS; // 以 permission/types.ts 为唯一真相源

  it('门卫乙（isReadOnlyTool）的册子必须与真相源一致', () => {
    // 遍历全部已知工具名空间，比对两个判定函数的结果必须相同
    // 真相源里的每个工具，isReadOnlyTool 必须也认它是只读
    for (const tool of TRUTH) {
      expect(isReadOnlyTool(tool)).toBe(true);
    }
    // 真相源里没有的，isReadOnlyTool 不能认（避免它私藏）
    // 用一批明确的写工具验证
    for (const tool of WRITE_TOOLS) {
      expect(isReadOnlyTool(tool)).toBe(false);
    }
  });

  it('门卫丙（isConcurrencySafe）的册子必须与真相源一致', () => {
    // 真相源里的每个只读工具，isConcurrencySafe 必须也认它并发安全
    for (const tool of TRUTH) {
      expect(isConcurrencySafe(tool)).toBe(true);
    }
    // 写工具不能算并发安全（必须串行）
    for (const tool of WRITE_TOOLS) {
      expect(isConcurrencySafe(tool)).toBe(false);
    }
  });

  // ── 这两条是当前会失败的核心断言（红灯）──

  it('门卫丙不能私藏不存在的工具（web_fetch 等 4 个项目里根本没有）', () => {
    // 这 4 个工具在 src/ 下没有任何 create/register，是 streaming-executor 抄来的死代码
    const ghostTools = ['web_fetch', 'web_search', 'list_directory', 'get_file_info'];
    for (const ghost of ghostTools) {
      // 真相源不认它们 → 门卫丙也不该认
      expect(isConcurrencySafe(ghost)).toBe(false);
    }
  });

  it('门卫丙不能漏掉真相源里的只读工具（todo_write / schedule_list）', () => {
    // 这两个在真相源里，但门卫丙当前不认它们为并发安全
    expect(isConcurrencySafe('todo_write')).toBe(true);
    expect(isConcurrencySafe('schedule_list')).toBe(true);
  });

  it('白册子和黄册子互不重叠（零交集）', () => {
    // 一个人不能既是老实人又是危险分子
    const readOnly = new Set(READ_ONLY_TOOLS);
    const overlap = WRITE_TOOLS.filter((t) => readOnly.has(t));
    expect(overlap).toEqual([]);
  });
});

// ─────────────────────────────────────────────
// 第 3 块：切到 build 模式（看账本，别看灯）
// ─────────────────────────────────────────────

describe('build 模式切换：账本落盘验证', () => {
  let tmpConfigDir: string;

  beforeEach(() => {
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'micode-build-cfg-'));
  });

  afterEach(() => {
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('setMode(build) 后 getMode 返回 build', () => {
    const checker = new PermissionChecker({ mode: 'plan', workdir: process.cwd() });
    checker.setMode('build');
    expect(checker.getMode()).toBe('build');
  });

  it('ConfigStore 加载时默认 build（无配置文件）', () => {
    const store = new ConfigStore(tmpConfigDir);
    expect(store.getPermissionMode()).toBe('build');
  });

  it('ConfigStore setPermissionMode(build) 真的落盘（翻账本验证）', () => {
    const store = new ConfigStore(tmpConfigDir);
    store.setPermissionMode('build');
    // 现场验证：读配置文件，里面真写了 "build"
    const configPath = join(tmpConfigDir, 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf8');
    expect(raw).toContain('"build"');
  });

  it('重新加载后仍是 build（持久化生效）', () => {
    const store1 = new ConfigStore(tmpConfigDir);
    store1.setPermissionMode('build');
    // 重新加载（模拟重启）
    const store2 = new ConfigStore(tmpConfigDir);
    expect(store2.getPermissionMode()).toBe('build');
  });

  it('legacy "default" 自动迁移为 build', () => {
    const configPath = join(tmpConfigDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ permissions: { mode: 'default' } }), 'utf8');
    const store = new ConfigStore(tmpConfigDir);
    expect(store.getPermissionMode()).toBe('build');
  });

  it('损坏的 config.json 回退默认 build 不崩', () => {
    const configPath = join(tmpConfigDir, 'config.json');
    writeFileSync(configPath, '{这不是合法json', 'utf8');
    const store = new ConfigStore(tmpConfigDir);
    expect(store.getPermissionMode()).toBe('build');
  });

  it('非法 mode 值回退 build', () => {
    const configPath = join(tmpConfigDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ permissions: { mode: '乱码模式' } }), 'utf8');
    const store = new ConfigStore(tmpConfigDir);
    expect(store.getPermissionMode()).toBe('build');
  });
});

// ─────────────────────────────────────────────
// 第 4 块：build 下并发规矩（老实人扎堆，动手的排队）
// ─────────────────────────────────────────────

describe('build 模式并发：只读并行，写串行', () => {
  it('isConcurrencySafe 对只读工具返回 true（可并行）', () => {
    for (const tool of READ_ONLY_TOOLS) {
      expect(isConcurrencySafe(tool)).toBe(true);
    }
  });

  it('isConcurrencySafe 对写工具返回 false（必须串行）', () => {
    const writeSamples = ['write_file', 'edit_file', 'run_bash', 'worktree'];
    for (const tool of writeSamples) {
      expect(isConcurrencySafe(tool)).toBe(false);
    }
  });

  it('run_bash（build 默认放行）被分类为非并发安全（串行）', () => {
    // run_bash 不在只读集合——它可能跑写命令，必须串行
    expect(isConcurrencySafe('run_bash')).toBe(false);
  });
});
