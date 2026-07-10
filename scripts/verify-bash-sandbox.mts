// run_bash 路径沙箱实测脚本：对比"修复前"与"修复后"
//
// 用法：npx tsx scripts/verify-bash-sandbox.mts
//
// 直接调 dist 的 PermissionChecker（与 micode 运行时同一份代码），
// 用真实临时 workdir 演示各类攻击向量与合法命令。

import { PermissionChecker } from '../dist/permission/checker.js';
import { setWorkdir, getWorkdir } from '../dist/agent/tools/path-sandbox.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// 模拟"修复前"：直接构造一个只有 isDangerousBash、无路径检查的简化 checker
// （用 auto 模式 + 临时把 paths 强制为空，近似修复前的行为）
function oldCheck(_command: string): { behavior: string; reason: string } {
  // 修复前：run_bash 只过 isDangerousBash，路径完全不管
  // 用 auto 模式（非危险命令一律 allow）近似
  const checker = new PermissionChecker({ mode: 'auto', workdir: getWorkdir() });
  const d = checker.check('run_bash', { command: _command });
  // 修复前没有路径检查——这里我们用"如果 decision 不是 deny-on-path 就算放行"
  // 为对比清晰，单独标出是否因 path 被拦
  const blockedByPath = /outside workspace/.test(d.reason);
  return {
    behavior: blockedByPath ? 'would-allow(old)' : d.behavior,
    reason: blockedByPath ? '（旧逻辑无路径检查，会放行）' : d.reason,
  };
}

function newCheck(command: string): { behavior: string; reason: string } {
  const checker = new PermissionChecker({ mode: 'auto', workdir: getWorkdir() });
  return checker.check('run_bash', { command });
}

// ── 主流程 ──
const workdir = mkdtempSync(join(tmpdir(), 'bash-verify-'));
setWorkdir(workdir);
console.log(`workdir = ${workdir}\n`);

const cases: Array<[string, string, 'attack' | 'legit' | 'uncertain']> = [
  // 攻击向量（越界读）
  ['cat /etc/passwd', '越界读：绝对路径', 'attack'],
  ['cat ../secret.txt', '越界读：相对 .. ', 'attack'],
  ['less ~/.ssh/id_rsa', '越界读：~ 家目录', 'attack'],
  // 攻击向量（越界写）
  ['cp x /tmp/leak', '越界写：cp 到 /tmp', 'attack'],
  ['echo x > /tmp/y', '越界写：重定向到 /tmp', 'attack'],
  ['cat .env | tee ../leak', '越界写：tee 管道', 'attack'],
  // 合法命令（不应误拦）
  ['cat README.md', '合法：读工作区内文件', 'legit'],
  ['ls -la', '合法：无路径参数', 'legit'],
  ['git commit -m "fix / path"', '合法：flag 内含 /', 'legit'],
  ['curl https://example.com/a/b', '合法：URL 不当路径', 'legit'],
  // 不确定（解析失败/变量）
  ['echo ${', '解析失败：畸形替换', 'uncertain'],
  ['cat $STOLEN', '变量未知：$VAR', 'uncertain'],
];

for (const [cmd, desc, kind] of cases) {
  const old_ = oldCheck(cmd);
  const new_ = newCheck(cmd);
  const expected = kind === 'attack' ? 'deny' : kind === 'legit' ? 'allow' : 'ask';

  const oldMark = old_.behavior === expected ? '  ' : '⚠️';
  const newMark = new_.behavior === expected ? '✅' : '❌';

  console.log(`━━━ ${desc} ━━━`);
  console.log(`  命令: ${cmd}`);
  console.log(`  期望: ${expected}`);
  console.log(`  旧逻辑: ${oldMark} ${old_.behavior}  ${old_.reason}`);
  console.log(`  新逻辑: ${newMark} ${new_.behavior}  ${new_.reason}`);
  console.log('');
}

rmSync(workdir, { recursive: true, force: true });
console.log('（临时目录已清理）');
