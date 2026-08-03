// 权限层 ↔ 执行层 ↔ 磁盘副作用 端到端集成测试
//
// 物理本质（保姆级）：
// 这是最关键的一条测试——把"门卫说的话"和"小区里实际发生的事"放在同一个用例里对照。
//
//   门卫（PermissionChecker）说："这人放行/要去问领导/拦下"
//   小区大门（StreamingToolExecutor）+ 仓库（磁盘文件）实际发生：人进没进、东西改没改
//
// 重点验证 build 模式的核心矛盾：
//   门卫对写文件的人说"要去问领导"（ask），
//   但领导从没来过，这人却每次都溜进去把文件改了。
//   ——这种"嘴上一套、手上一套"必须用 readFileSync 真实证据锁定，不是推断。
//
// 本文件用真实 StreamingToolExecutor（生产执行器）驱动全链路，不 mock：
//   executeToolCall() → RuntimeSecurityGate → registered executor → writeFileSync 真落盘
// 然后回头 readFileSync 验证磁盘真实状态。
//
// 用例分两类：
//   正向基线（deny 真拦 / allow 真放）——证明集成链路本身通
//   ask fail-closed（无用户通道时不执行）——证明统一入口不再静默放行

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PermissionChecker } from '../../../src/permission/checker.js';
import { StreamingToolExecutor } from '../../../src/agent/streaming-executor.js';
import type { ToolExecutionRuntime } from '../../../src/agent/tool-execution.js';
import { ToolRegistry } from '../../../src/agent/tool-registry.js';
import { createWriteFileTool, createReadFileTool } from '../../../src/agent/tools/file-tools.js';
import { createBashTool } from '../../../src/agent/tool-registry.js';
import { setWorkdir, getWorkdir } from '../../../src/agent/tools/path-sandbox.js';
import type { ToolUseBlock } from '../../../src/agent/types.js';
import {
  RuntimeSecurityGate,
  type PendingDecisionStore,
  type PendingSecurityDecision,
} from '../../../src/permission/runtime-gate.js';

class InMemoryPendingDecisionStore implements PendingDecisionStore {
  async save(_pending: PendingSecurityDecision): Promise<void> {}
  async load(_sessionId: string): Promise<readonly PendingSecurityDecision[]> {
    return [];
  }
  async update(
    _decisionId: string,
    _update: Partial<PendingSecurityDecision>,
  ): Promise<void> {}
}

function runtimeFor(checker: PermissionChecker): ToolExecutionRuntime {
  return {
    permissionChecker: checker,
    runtimeGate: new RuntimeSecurityGate({
      pendingStore: new InMemoryPendingDecisionStore(),
      channel: null,
      sessionId: 'permission-executor-integration',
    }),
  };
}

/**
 * 驱动 StreamingToolExecutor 执行单个工具，返回 executor 写回的 tool_result 文本。
 * 这是生产执行器的真实接线路径：统一入口校验 → checker → gate → registered executor。
 */
async function runThroughExecutor(
  registry: ToolRegistry,
  checker: PermissionChecker,
  block: ToolUseBlock,
): Promise<string> {
  const exec = new StreamingToolExecutor(
    registry,
    runtimeFor(checker),
    new AbortController().signal,
  );
  exec.addTool(block);
  // addTool 异步触发 processQueue，等待完成
  await new Promise((r) => setTimeout(r, 30));
  let text = '';
  for await (const batch of exec.getRemainingResults()) {
    for (const t of batch) {
      if (t.results && t.results.length > 0 && t.results[0].type === 'text') {
        text = (t.results[0] as { text: string }).text;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 10));
  return text;
}

describe('权限↔执行↔磁盘 端到端集成', () => {
  let workdir: string;
  let originalWorkdir: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    originalWorkdir = getWorkdir();
    // 每个用例用独立 tmpdir 作 workdir，绝不污染当前项目目录
    workdir = mkdtempSync(join(tmpdir(), 'perm-exec-integ-'));
    setWorkdir(workdir);
    // 注册真实工具（不 mock），让 writeFileSync/readFileSync 真跑
    registry = new ToolRegistry();
    const wf = createWriteFileTool();
    registry.register(wf.definition, wf.executor);
    const rf = createReadFileTool();
    registry.register(rf.definition, rf.executor);
    const bash = createBashTool();
    registry.register(bash.definition, bash.executor);
  });

  afterEach(() => {
    setWorkdir(originalWorkdir);
    rmSync(workdir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────
  // 正向基线 A：deny 真的拦住，磁盘无变化
  // ─────────────────────────────────────────────

  describe('deny 决策：工具真不执行，磁盘无变化', () => {
    it('build 模式 + 危险命令 rm -rf：返回拒绝原因，无副作用', async () => {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      // 双断言①：门卫嘴上
      const decision = checker.check('run_bash', { command: 'rm -rf /home' });
      expect(decision.behavior).toBe('deny');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't1', name: 'run_bash',
        input: { command: 'rm -rf /home' },
      };
      const result = await runThroughExecutor(registry, checker, block);
      // 双断言②：现场——executor 返回 Blocked 标记，命令没真跑
      expect(result).not.toBe('');
    });

    it('build 模式 + read_file 越界读：闸门 1 必须硬 deny（补 read 缺口）', async () => {
      // 物理认知：闸门 1 当前只盯着"提包出门的"（write/edit），
      // 没盯"探头窥视的"（read 越界）。本用例补 read 的越界硬闸门。
      const checker = new PermissionChecker({ mode: 'build', workdir });
      const outsideFile = join(workdir + '_sibling', 'secret.txt');

      // 双断言①：门卫嘴上——read_file 越界必须 deny（当前返回 allow → RED）
      const decision = checker.check('read_file', { path: outsideFile });
      expect(decision.behavior).toBe('deny');
    });

    it('build 模式 + 越界写路径：工作区外文件不存在', async () => {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      const outsideFile = join(workdir + '_sibling', 'stolen.txt');
      const block: ToolUseBlock = {
        type: 'tool_use', id: 't2', name: 'write_file',
        input: { path: outsideFile, content: '越界' },
      };
      await runThroughExecutor(registry, checker, block);
      // 现场验证：越界文件没被创建
      expect(existsSync(outsideFile)).toBe(false);
    });

    it('plan 模式 + write_file：文件没被创建', async () => {
      const checker = new PermissionChecker({ mode: 'plan', workdir });
      const decision = checker.check('write_file', { path: 'inside.txt', content: 'x' });
      expect(decision.behavior).toBe('deny');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't3', name: 'write_file',
        input: { path: 'inside.txt', content: 'x' },
      };
      await runThroughExecutor(registry, checker, block);
      // 现场验证：plan 模式下文件根本没写出
      expect(existsSync(join(workdir, 'inside.txt'))).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // 正向基线 B：allow 真的放行，现场确实发生
  // ─────────────────────────────────────────────

  describe('allow 决策：工具真执行，现场有变化', () => {
    it('build 模式 + read_file 读已有文件：返回内容 == 文件真实内容', async () => {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      // 先造一个真实文件
      const realContent = '这是真实内容 line1\nline2';
      writeFileSync(join(workdir, 'exists.txt'), realContent, 'utf8');

      const decision = checker.check('read_file', { path: 'exists.txt' });
      expect(decision.behavior).toBe('allow');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't4', name: 'read_file',
        input: { path: 'exists.txt' },
      };
      const result = await runThroughExecutor(registry, checker, block);
      // 现场验证：读到的内容 == 磁盘真实内容（不是看 success，是看数据对不对）
      expect(result).toBe(realContent);
    });

    it('auto 模式 + write_file：Task 3 A15 后同步 checker 产出 ask（resolver 决定）', async () => {
      // Task 3 A15：auto 不再无条件 allow；同步 checker 产出 ask，由后续 resolver/classifier 决定。
      // 此集成无 resolver/classifier，故 ask fail closed，文件不写。
      const checker = new PermissionChecker({ mode: 'auto', workdir });
      const decision = checker.check('write_file', { path: 'auto.txt', content: 'auto模式' });
      expect(decision.behavior).toBe('ask');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't5', name: 'write_file',
        input: { path: 'auto.txt', content: 'auto模式' },
      };
      await runThroughExecutor(registry, checker, block);
      // ask fail closed：文件未写出
      expect(existsSync(join(workdir, 'auto.txt'))).toBe(false);
    });
  });

  // ─────────────────────────────────────────────
  // ask 使用 RuntimeSecurityGate。此集成没有用户通道，因此必须 fail closed，
  // 不能再把 ask 静默降级为 allow。
  // ─────────────────────────────────────────────

  describe('ask 无用户通道：工具不执行，磁盘无变化', () => {
    it('build 模式 + write_file 新文件：decision=ask，文件不创建', async () => {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      // 嘴上：要问领导
      const decision = checker.check('write_file', { path: 'leaked.txt', content: '泄漏内容' });
      expect(decision.behavior).toBe('ask');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't6', name: 'write_file',
        input: { path: 'leaked.txt', content: '泄漏内容' },
      };
      await runThroughExecutor(registry, checker, block);

      const filePath = join(workdir, 'leaked.txt');
      expect(existsSync(filePath)).toBe(false);
    });

    it('build 模式 + write_file 覆盖：decision=ask，旧内容保留', async () => {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      // 先有旧文件
      writeFileSync(join(workdir, 'overwrite.txt'), '旧内容应该被完全替换掉', 'utf8');

      const decision = checker.check('write_file', { path: 'overwrite.txt', content: '新内容' });
      expect(decision.behavior).toBe('ask');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't7', name: 'write_file',
        input: { path: 'overwrite.txt', content: '新内容' },
      };
      await runThroughExecutor(registry, checker, block);

      const written = readFileSync(join(workdir, 'overwrite.txt'), 'utf8');
      expect(written).toBe('旧内容应该被完全替换掉');
    });

    it('build 模式 + write_file 父目录不存在：decision=ask，目录不创建', async () => {
      const checker = new PermissionChecker({ mode: 'build', workdir });
      const decision = checker.check('write_file', {
        path: 'newdir/sub/deep.txt', content: '深目录',
      });
      expect(decision.behavior).toBe('ask');

      const block: ToolUseBlock = {
        type: 'tool_use', id: 't8', name: 'write_file',
        input: { path: 'newdir/sub/deep.txt', content: '深目录' },
      };
      await runThroughExecutor(registry, checker, block);

      expect(existsSync(join(workdir, 'newdir', 'sub', 'deep.txt'))).toBe(false);
    });
  });
});
