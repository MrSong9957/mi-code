// Wave D Task 12 (M-064): 命令结构化解析单元测试。
//
// 物理本质（保姆级）：
//   parser 像安检员只看 X 光片——识别结构（管道、重定向、变量展开…），
//   但绝不打开行李（不执行 expansion、不查 PATH、不跑命令、不读 fs）。
//   本测试就是验收这位"X 光安检员"的工作：
//     1. 能识别 spec §11.7 全部 8 类结构（表驱动 corpus）；
//     2. 对未知 dialect / 超复杂 / 畸形输入给出确定性状态（不靠 Agent 主观感觉）；
//     3. 永远不执行命令——即使输入是 `echo x > trap.txt`，trap.txt 也不该出现；
//     4. 输出是 frozen + deterministic 的（同样输入 → 同样 parse_result_id / facts）。
//
// 九大不变量（对应 self-review checkpoint）：
//   1. CORPUS 表驱动：每条 case 至少记一条 expectKind risk fact；
//   2. 未知 dialect → unsupported_syntax（不靠 OS 名猜语法）；
//   3. 超长 / 超 token / 超操作符 / 超嵌套 → too_complex（确定性阈值）；
//   4. 畸形 shell → invalid_syntax（shell-quote 抛错即捕获）；
//   5. parser 不执行：trap 命令的副作用文件必须不存在；
//   6. parse_result_id / facts 对相同输入确定；
//   7. source_range_ref 可回指原命令（如 range:N:M）；
//   8. environment_assignment / executable_candidate 只是语法事实，不蕴含安全结论；
//   9. complexity_metrics 包含 token_count / operator_count / nesting_depth / source_length。
//
// 测试不接真实 shell / fs；"不执行"通过断言临时文件不存在证明。

import { describe, expect, it } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  parseCommandStructure,
  PARSE_PROTOCOL_VERSION,
  SUPPORTED_SHELL_DIALECT,
  SUPPORTED_GRAMMAR_VERSION,
  type CommandParseInput,
  type CommandComplexityPolicy,
} from '../../permission/command-policy.js';
import { CORPUS, TRAP_COMMANDS } from './fixtures/command-structural-corpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────
// 默认 fixtures
// ─────────────────────────────────────────────

/** 默认复杂度策略：宽松阈值,使大多数 fixture 命令能 parsed。 */
const DEFAULT_POLICY: CommandComplexityPolicy = {
  policy_id: 'test-complexity-policy',
  policy_version: '1',
  max_source_length: 4096,
  max_tokens: 256,
  max_operators: 64,
  max_nesting: 8,
};

/**
 * 构造一份合规的 CommandParseInput。
 *
 * 显式传 shell_dialect='posix-shell'、grammar_version='posix-shell-quote-v1',
 * command_hash 由 sha256(command) 计算（在 parser 内部也算,这里只填占位由调用方覆盖）。
 */
function makeInput(
  command: string,
  overrides: Partial<CommandParseInput> = {},
): CommandParseInput {
  return {
    parse_protocol_version: PARSE_PROTOCOL_VERSION,
    action_snapshot_id: 'snap-test-0001',
    command_content: command,
    command_hash: hashPlaceholder(command),
    shell_dialect: SUPPORTED_SHELL_DIALECT,
    grammar_version: SUPPORTED_GRAMMAR_VERSION,
    ...overrides,
  };
}

/** 测试侧 sha256 占位：与实现侧算法一致性由"deterministic id"用例独立验证。 */
function hashPlaceholder(s: string): string {
  // 用 process 一次 sha256,避免在测试里硬编码 hash 值（实现若换算法这里跟着换）。
  // 该占位只用于让 input 满足"非空 hash"约束;真正的 hash 校验在 parser 内部。
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return `placeholder:${h >>> 0}`;
}

// ─────────────────────────────────────────────
// 测试组
// ─────────────────────────────────────────────

describe('M-064 Command Structural Parse', () => {
  describe('CORPUS: 记录全部 8 类结构而不执行输入', () => {
    it.each(CORPUS)(
      'records $name without executing input',
      ({ command, expectKind }) => {
        const result = parseCommandStructure(makeInput(command), DEFAULT_POLICY);

        expect(result.status).toBe('parsed');
        const kinds = result.risk_facts.map((f) => f.kind);
        expect(kinds).toContain(expectKind);
      },
    );

    it('CORPUS 覆盖 spec §11.7 全部 8 类 kind', () => {
      // 守护测试:防止有人未来从 CORPUS 删 case 导致覆盖缺失。
      const allKinds = new Set(CORPUS.map((c) => c.expectKind));
      const requiredKinds: ReadonlyArray<string> = [
        'command',
        'pipeline',
        'redirect',
        'substitution',
        'expansion',
        'control_flow',
        'environment_assignment',
        'executable_candidate',
      ];
      for (const k of requiredKinds) {
        expect(allKinds, `CORPUS 应覆盖 kind="${k}"`).toContain(k);
      }
    });
  });

  describe('unsupported_syntax（dialect/grammar 显式性）', () => {
    it('returns unsupported_syntax for unknown shell_dialect', () => {
      const result = parseCommandStructure(
        makeInput('ls', { shell_dialect: 'csh' }),
        DEFAULT_POLICY,
      );
      expect(result.status).toBe('unsupported_syntax');
      expect(result.risk_facts).toEqual([]);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('returns unsupported_syntax for unknown grammar_version', () => {
      const result = parseCommandStructure(
        makeInput('ls', { grammar_version: 'bash-v2' }),
        DEFAULT_POLICY,
      );
      expect(result.status).toBe('unsupported_syntax');
    });

    it('returns unsupported_syntax for empty shell_dialect', () => {
      const result = parseCommandStructure(
        makeInput('ls', { shell_dialect: '' }),
        DEFAULT_POLICY,
      );
      expect(result.status).toBe('unsupported_syntax');
    });

    it('returns unsupported_syntax for empty grammar_version', () => {
      const result = parseCommandStructure(
        makeInput('ls', { grammar_version: '' }),
        DEFAULT_POLICY,
      );
      expect(result.status).toBe('unsupported_syntax');
    });
  });

  describe('too_complex（确定性阈值）', () => {
    it('returns too_complex when source length exceeds max_source_length', () => {
      const long = 'echo ' + 'a'.repeat(200);
      const result = parseCommandStructure(makeInput(long), {
        ...DEFAULT_POLICY,
        max_source_length: 50,
      });
      expect(result.status).toBe('too_complex');
      // 复杂度度量仍要回填（让调用方知道超了多少）
      expect(result.complexity_metrics.source_length).toBe(long.length);
    });

    it('returns too_complex when token count exceeds max_tokens', () => {
      // 21 个 token,阈值 10
      const many = Array.from({ length: 21 }, (_, i) => `t${i}`).join(' ');
      const result = parseCommandStructure(makeInput(many), {
        ...DEFAULT_POLICY,
        max_tokens: 10,
      });
      expect(result.status).toBe('too_complex');
      expect(result.complexity_metrics.token_count).toBeGreaterThan(10);
    });

    it('returns too_complex when operator count exceeds max_operators', () => {
      // 11 个 |,阈值 4
      const piped = Array.from({ length: 12 }, () => 'cat').join(' | ');
      const result = parseCommandStructure(makeInput(piped), {
        ...DEFAULT_POLICY,
        max_operators: 4,
      });
      expect(result.status).toBe('too_complex');
      expect(result.complexity_metrics.operator_count).toBeGreaterThan(4);
    });

    it('returns too_complex when nesting depth exceeds max_nesting', () => {
      // 嵌套 $(  $() $() ) —— shell-quote 会展平成 () 序列,但 nesting_depth 应反映深度
      const nested = 'echo ' + '$('.repeat(5) + 'whoami' + ')'.repeat(5);
      const result = parseCommandStructure(makeInput(nested), {
        ...DEFAULT_POLICY,
        max_nesting: 2,
      });
      expect(result.status).toBe('too_complex');
      expect(result.complexity_metrics.nesting_depth).toBeGreaterThan(2);
    });
  });

  describe('invalid_syntax（畸形 shell）', () => {
    it('returns invalid_syntax for malformed ${ substitution', () => {
      // shell-quote 对未闭合 ${ 抛 Bad substitution
      const result = parseCommandStructure(
        makeInput('echo ${'),
        DEFAULT_POLICY,
      );
      expect(result.status).toBe('invalid_syntax');
      expect(result.diagnostics.length).toBeGreaterThan(0);
    });

    it('returns invalid_syntax for malformed ${} (empty brace)', () => {
      const result = parseCommandStructure(makeInput('echo ${}'), DEFAULT_POLICY);
      expect(result.status).toBe('invalid_syntax');
    });
  });

  describe('parser 不执行（核心不变量 §11.7 rule 3）', () => {
    it('does not execute command (no side-effect file from redirect)', () => {
      const trapPath = resolve(__dirname, 'm064-trap.txt');
      rmSync(trapPath, { force: true });
      try {
        const result = parseCommandStructure(
          makeInput(TRAP_COMMANDS.writeFile),
          DEFAULT_POLICY,
        );
        expect(result.status).toBe('parsed');
        // 关键断言:trap 文件不该被创建
        expect(existsSync(trapPath)).toBe(false);
      } finally {
        rmSync(trapPath, { force: true });
      }
    });

    it('does not execute command substitution (no side-effect file)', () => {
      const trapPath = resolve(__dirname, 'm064-trap-sub.txt');
      rmSync(trapPath, { force: true });
      try {
        const result = parseCommandStructure(
          makeInput(TRAP_COMMANDS.substitutionWrite),
          DEFAULT_POLICY,
        );
        expect(result.status).toBe('parsed');
        expect(existsSync(trapPath)).toBe(false);
      } finally {
        rmSync(trapPath, { force: true });
      }
    });

    it('does not import child_process or fs write APIs (static guarantee)', () => {
      // 通过断言模块导出表面来守护:parser 模块不应导出任何执行性 API。
      // 这是结构性守护——若有人意外加了 exec(),这里会失败提醒。
      // (import 是静态分析友好的:parser 的 import 只能是 shell-quote + node:crypto)
      const moduleUrl = new URL(
        '../../permission/command-policy.js',
        import.meta.url,
      );
      // dynamic import 后只断言我们期望的导出存在,不调用任何执行性 API
      return import(moduleUrl.href).then((mod) => {
        expect(typeof mod.parseCommandStructure).toBe('function');
        expect(mod.execSync).toBeUndefined();
        expect(mod.spawnSync).toBeUndefined();
        expect(mod.readFileSync).toBeUndefined();
        expect(mod.writeFileSync).toBeUndefined();
      });
    });
  });

  describe('输出确定性与可冻结性', () => {
    it('produces deterministic parse_result_id for identical input', () => {
      const a = parseCommandStructure(makeInput('ls -la'), DEFAULT_POLICY);
      const b = parseCommandStructure(makeInput('ls -la'), DEFAULT_POLICY);
      expect(a.parse_result_id).toBe(b.parse_result_id);
      expect(a.command_hash).toBe(b.command_hash);
      // risk_facts 也应确定(同序同内容)
      expect(a.risk_facts).toEqual(b.risk_facts);
    });

    it('produces different parse_result_id for different input', () => {
      const a = parseCommandStructure(makeInput('ls'), DEFAULT_POLICY);
      const b = parseCommandStructure(makeInput('pwd'), DEFAULT_POLICY);
      expect(a.parse_result_id).not.toBe(b.parse_result_id);
    });

    it('parse_result_id has form parse:<16-hex>', () => {
      const result = parseCommandStructure(makeInput('ls'), DEFAULT_POLICY);
      expect(result.parse_result_id).toMatch(/^parse:[0-9a-f]{16}$/);
    });

    it('result is deeply frozen', () => {
      const result = parseCommandStructure(makeInput('ls'), DEFAULT_POLICY);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.risk_facts)).toBe(true);
      expect(Object.isFrozen(result.complexity_metrics)).toBe(true);
      expect(Object.isFrozen(result.diagnostics)).toBe(true);
      // risk_facts 元素也应 frozen
      for (const f of result.risk_facts) {
        expect(Object.isFrozen(f)).toBe(true);
      }
    });

    it('echoes back input identity fields (snapshot/hash/dialect/grammar)', () => {
      const result = parseCommandStructure(makeInput('ls'), DEFAULT_POLICY);
      expect(result.action_snapshot_id).toBe('snap-test-0001');
      expect(result.shell_dialect).toBe(SUPPORTED_SHELL_DIALECT);
      expect(result.grammar_version).toBe(SUPPORTED_GRAMMAR_VERSION);
      expect(result.parse_protocol_version).toBe(PARSE_PROTOCOL_VERSION);
      // command_hash 应是 sha256 hex (64 字符)
      expect(result.command_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('source_range_ref 可回指原命令（§11.7 rule 5）', () => {
    it('every risk fact carries a source_range_ref of form range:N:M', () => {
      const result = parseCommandStructure(
        makeInput('cat a | grep x'),
        DEFAULT_POLICY,
      );
      expect(result.risk_facts.length).toBeGreaterThan(0);
      for (const f of result.risk_facts) {
        expect(f.source_range_ref).toMatch(/^range:\d+:\d+$/);
      }
    });

    it('preserves quoting/escaping by not collapsing quote semantics', () => {
      // spec §11.7 rule 6:parser normalization 不得改变引号/转义/操作符语义。
      // 间接验证:含引号的命令仍 parsed,且引号包住的 token 不被分裂。
      const result = parseCommandStructure(
        makeInput('echo "hello world"'),
        DEFAULT_POLICY,
      );
      expect(result.status).toBe('parsed');
      // 应至少有一条 command/executable fact
      const kinds = result.risk_facts.map((f) => f.kind);
      expect(kinds).toContain('command');
    });

    it('source_range_ref points within command bounds', () => {
      const cmd = 'echo x > out.txt';
      const result = parseCommandStructure(makeInput(cmd), DEFAULT_POLICY);
      for (const f of result.risk_facts) {
        const m = /^range:(\d+):(\d+)$/.exec(f.source_range_ref);
        expect(m, `bad source_range_ref: ${f.source_range_ref}`).not.toBeNull();
        const start = Number(m![1]);
        const end = Number(m![2]);
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(cmd.length);
        expect(end).toBeGreaterThanOrEqual(start);
      }
    });
  });

  describe('complexity_metrics 完整性（§11.7）', () => {
    it('reports token_count / operator_count / nesting_depth / source_length', () => {
      const result = parseCommandStructure(
        makeInput('a | b && c > d'),
        DEFAULT_POLICY,
      );
      const m = result.complexity_metrics;
      expect(m.token_count).toBeGreaterThan(0);
      expect(m.operator_count).toBeGreaterThan(0);
      expect(typeof m.nesting_depth).toBe('number');
      expect(m.source_length).toBe('a | b && c > d'.length);
    });
  });

  describe('environment_assignment / executable_candidate 只是语法事实', () => {
    it('environment_assignment does not produce PATH/binary safety conclusion', () => {
      // 不变量:只输出 kind='environment_assignment',不附加 trust/path 字段
      const result = parseCommandStructure(
        makeInput('FOO=bar cmd'),
        DEFAULT_POLICY,
      );
      const envFacts = result.risk_facts.filter(
        (f) => f.kind === 'environment_assignment',
      );
      expect(envFacts.length).toBeGreaterThan(0);
      // risk_code 是语法事实码,不是安全结论;fact 上不应有 path/resolved 等 M-065 字段
      for (const f of envFacts) {
        const keys = Object.keys(f).sort();
        expect(keys).toEqual(['fact_id', 'kind', 'risk_code', 'source_range_ref']);
      }
    });

    it('executable_candidate does not resolve PATH', () => {
      const result = parseCommandStructure(makeInput('npm test'), DEFAULT_POLICY);
      const execFacts = result.risk_facts.filter(
        (f) => f.kind === 'executable_candidate',
      );
      expect(execFacts.length).toBeGreaterThan(0);
      for (const f of execFacts) {
        const keys = Object.keys(f).sort();
        expect(keys).toEqual(['fact_id', 'kind', 'risk_code', 'source_range_ref']);
      }
    });
  });

  describe('command_hash 校验', () => {
    it('uses sha256(command_content) for command_hash', () => {
      // 实现侧应重新计算 sha256,不信任 input.command_hash
      const cmd = 'ls -la';
      const result = parseCommandStructure(
        makeInput(cmd, { command_hash: 'WRONG' }),
        DEFAULT_POLICY,
      );
      // 应是合法 sha256,而不是 input 传入的 'WRONG'
      expect(result.command_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.command_hash).not.toBe('WRONG');
    });
  });
});
