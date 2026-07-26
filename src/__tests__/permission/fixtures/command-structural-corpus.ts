// Wave D Task 12 (M-064): 命令结构化解析测试语料。
//
// 物理本质（保姆级）：
//   parser 像安检员只看行李 X 光片——能识别"这是管道"、"那是重定向"、
//   "这是变量展开"，但绝不打开行李（不执行 expansion / 不查 PATH / 不跑命令）。
//   本语料就是给安检员看的一沓 X 光片样张：每张标注"应识别出哪种结构"。
//
// 用途：供 command-structural-parse.test.ts 通过 it.each 表驱动复用。
//   每条 case = { name, command, expectKind }——name 是 it 标题,
//   command 是原始命令文本,expectKind 是该命令必须至少被记一条 risk fact 的 kind。
//
// 注意（不变量）：
//   1. expectKind 只是"结构识别"——不蕴含安全结论（M-065 才做安全结论）。
//   2. 语料覆盖 spec §11.7 全部 8 类结构识别（command / pipeline / redirect /
//      substitution / expansion / control_flow / environment_assignment /
//      executable_candidate）。
//   3. 这些命令永远不应被 parser 执行——它们只是字符串。

import type { CommandRiskFactKind } from '../../../../permission/command-policy.js';

export interface CommandCorpusCase {
  /** it 标题简短名,用于 it.each('records $name ...') */
  name: string;
  /** 原始命令文本(parser 输入 command_content) */
  command: string;
  /** parser 必须至少记录一条此 kind 的 risk fact */
  expectKind: CommandRiskFactKind;
}

/**
 * 命令结构化解析测试语料。
 *
 * 覆盖 spec §11.7 要求的全部结构类别,每条 case 都对应一种"应识别"的语法事实。
 * 排序按 kind 分组便于人类阅读,顺序对测试无影响(it.each 表驱动)。
 */
export const CORPUS: readonly CommandCorpusCase[] = [
  // ── command sequence / executable candidate ──
  {
    name: 'executable_candidate (single command)',
    command: 'npm test',
    expectKind: 'executable_candidate',
  },
  {
    name: 'command (with arguments)',
    command: 'git commit -m fix',
    expectKind: 'command',
  },

  // ── pipeline ──
  {
    name: 'pipeline (single pipe)',
    command: 'cat a | grep x',
    expectKind: 'pipeline',
  },
  {
    name: 'pipeline (multi-stage)',
    command: 'ps aux | grep node | head -n 5',
    expectKind: 'pipeline',
  },

  // ── redirect ──
  {
    name: 'redirect (output >)',
    command: 'echo x > out.txt',
    expectKind: 'redirect',
  },
  {
    name: 'redirect (append >>)',
    command: 'echo y >> log.txt',
    expectKind: 'redirect',
  },
  {
    name: 'redirect (input <)',
    command: 'wc -l < input.txt',
    expectKind: 'redirect',
  },

  // ── command substitution ──
  {
    name: 'substitution ($(...))',
    command: 'echo $(whoami)',
    expectKind: 'substitution',
  },
  {
    name: 'substitution (backtick)',
    command: 'echo `whoami`',
    expectKind: 'substitution',
  },

  // ── variable / parameter expansion ──
  {
    name: 'expansion ($VAR)',
    command: 'echo $HOME',
    expectKind: 'expansion',
  },
  {
    name: 'expansion (${VAR})',
    command: 'echo "${HOME}/dir"',
    expectKind: 'expansion',
  },

  // ── control flow ──
  {
    name: 'control_flow (&&)',
    command: 'test -f a && echo yes',
    expectKind: 'control_flow',
  },
  {
    name: 'control_flow (||)',
    command: 'false || echo fallback',
    expectKind: 'control_flow',
  },
  {
    name: 'control_flow (;)',
    command: 'echo first ; echo second',
    expectKind: 'control_flow',
  },

  // ── leading environment assignment ──
  {
    name: 'environment_assignment (single leading)',
    command: 'NODE_ENV=test npm test',
    expectKind: 'environment_assignment',
  },
  {
    name: 'environment_assignment (multiple leading)',
    command: 'FOO=bar BAZ=qux node script.js',
    expectKind: 'environment_assignment',
  },
] as const;

/**
 * 用于"不执行"测试的陷阱命令——若 parser 真的去执行了 shell,
 * 这些命令会在测试环境留下可观测副作用(临时文件)。
 *
 * 测试通过断言"该文件不存在"来证明 parser 没执行命令。
 * 文件路径使用项目 test 临时目录约定,绝对不指向真实系统位置。
 */
export const TRAP_COMMANDS = {
  /** 写入文件——若被执行会在 ./tmp 下产生 m064-trap.txt */
  writeFile: 'echo trapped > m064-trap.txt',
  /** 命令替换里再写文件——双重陷阱 */
  substitutionWrite: 'echo $(echo x > m064-trap-sub.txt)',
} as const;
