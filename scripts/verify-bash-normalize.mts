// 归一化检测实测脚本：对比"修复前"与"修复后"对引号拼接攻击的拦截
//
// 用法：npx tsx scripts/verify-bash-normalize.mts
//
// 直接调 dist 的 isDangerousBash（与 micode 运行时同一份代码）。
// "旧逻辑"= 只对原始字符串跑正则（模拟修复前）；
// "新逻辑"= isDangerousBash（原始 + 归一化双查）。

import { isDangerousBash } from '../dist/permission/patterns.js';
import { normalizeBashForCheck } from '../dist/permission/bash-normalize.js';

// 旧逻辑：只查原始字符串（修复前的行为）
function oldCheck(command: string): boolean {
  const patterns = [
    /sudo\s/, /rm\s+-rf/, /\$\(/, /`[^`]+`/, />\s*\/etc\//,
    /mkfs/, /dd\s+/, /:\(\)\{ :\|:& \};/,
  ];
  return patterns.some((p) => p.test(command));
}

// 新逻辑：isDangerousBash（原始 + 归一化双查）
function newCheck(command: string): boolean {
  return isDangerousBash(command);
}

const cases: Array<[string, string, 'attack' | 'legit']> = [
  // 引号拼接攻击（核心缺口）
  ["'r''m' -rf /", "引号拼接 rm（单引号断开）", 'attack'],
  ['r\'m\' -rf /', "混合引号 rm（r'm'）", 'attack'],
  ['"r""m" -rf /', "双引号拼接 rm", 'attack'],
  ["'s''u''d''o' whoami", "引号拼接 sudo（四段）", 'attack'],
  // 正常命令（不应误拦）
  ['rm -rf /', "原始 rm -rf（应一直被拦）", 'attack'],
  ['sudo apt install x', "原始 sudo（应一直被拦）", 'attack'],
  ['echo "hello world"', "正常引号包参数", 'legit'],
  ['git commit -m "fix / path"', "git commit flag 含 /", 'legit'],
  ['ls -la', "无引号无危险词", 'legit'],
];

console.log('命令归一化演示（shell-quote 合并引号拼接）：\n');
for (const [cmd, label] of cases) {
  const norm = normalizeBashForCheck(cmd);
  const changed = norm !== cmd;
  if (changed) {
    console.log(`  ${label}`);
    console.log(`    原始: ${cmd}`);
    console.log(`    归一化: ${norm}  ← 引号被合并\n`);
  }
}

console.log('拦截对比：\n');
for (const [cmd, label, kind] of cases) {
  const old_ = oldCheck(cmd);
  const new_ = newCheck(cmd);
  const expected = kind === 'attack';
  const oldMark = old_ === expected ? '  ' : '⚠️';
  const newMark = new_ === expected ? '✅' : '❌';
  const oldTag = old_ ? 'dangerous' : 'safe';
  const newTag = new_ ? 'dangerous' : 'safe';
  console.log(`━━━ ${label} ━━━`);
  console.log(`  命令: ${cmd}`);
  console.log(`  期望: ${expected ? 'dangerous' : 'safe'}`);
  console.log(`  旧逻辑(只查原始): ${oldMark} ${oldTag}`);
  console.log(`  新逻辑(双查归一化): ${newMark} ${newTag}`);
  if (old_ !== new_) {
    console.log(`  >>> ${old_ ? '原拦→现仍拦' : '原放行→现拦截（修复生效！）'}`);
  }
  console.log('');
}
