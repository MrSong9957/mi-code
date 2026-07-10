// 路径沙箱实测脚本：对比"旧 bug 逻辑"与"加固后逻辑"
//
// 用法：npx tsx scripts/verify-path-sandbox.mts
//
// 这个脚本不 import 任何 safePath，而是把"旧逻辑"和"新逻辑"内联进来，
// 用真实临时目录 + 真实符号链接（若环境允许）演示四种攻击向量。

import { resolve, isAbsolute, sep, dirname, join } from 'path';
import { realpathSync, mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';

// ── 旧逻辑（修复前，已知 bug）──
function oldSafePath(p: string, workdir: string): string {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(workdir, p);
  if (!resolved.startsWith(workdir)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// ── 新逻辑（修复后，本次实现）──
function realpathExistingAncestor(p: string): string {
  try { return realpathSync(p); }
  catch {
    const parent = dirname(p);
    if (parent === p) return p;
    return realpathExistingAncestor(parent);
  }
}
function isWithin(resolved: string, root: string): boolean {
  if (resolved === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return resolved.startsWith(prefix);
}
function newSafePath(p: string, workdir: string): string {
  const resolved = isAbsolute(p) ? resolve(p) : resolve(workdir, p);
  if (!isWithin(resolved, workdir)) throw new Error(`Path escapes workspace: ${p}`);
  const realRoot = realpathExistingAncestor(workdir);
  const realResolved = realpathExistingAncestor(resolved);
  if (!isWithin(realResolved, realRoot)) throw new Error(`Path escapes workspace (symlink): ${p}`);
  return resolved;
}

// ── 测试工具 ──
function tryFn(label: string, fn: () => void): void {
  let result: string;
  try { fn(); result = '❌ 放行了（没抛错，越界成功！）'; }
  catch (e) { result = `✅ 拦截：${(e as Error).message}`; }
  console.log(`  ${label}\n    ${result}`);
}

function runCase(name: string, workdir: string, cases: Array<[string, (p: string) => void, string]>): void {
  console.log(`\n━━━ ${name} ━━━`);
  for (const [label, fn, path] of cases) tryFn(label, () => fn(path));
}

// ── 主流程 ──
const workdir = mkdtempSync(join(tmpdir(), 'demo-'));
console.log(`workdir = ${workdir}`);

// 攻击向量 1：.. 穿越（新旧都能拦）
runCase('攻击① .. 穿越（基线，新旧都应拦截）', workdir, [
  ['旧逻辑', (p) => oldSafePath(p, workdir), '../evil.txt'],
  ['新逻辑', (p) => newSafePath(p, workdir), '../evil.txt'],
]);

// 攻击向量 2：前缀碰撞（旧 bug 放行，新逻辑拦截）
// 关键：把兄弟目录真实建在磁盘上（否则 realpath 回溯会绕过）
const collisionDir = workdir + '_evil';
mkdirSync(collisionDir, { recursive: true });
runCase('攻击② 前缀碰撞 /a/sub vs /a/sub_evil（旧 bug 放行）', workdir, [
  ['旧逻辑', (p) => oldSafePath(p, workdir), join(collisionDir, 'stolen.txt')],
  ['新逻辑', (p) => newSafePath(p, workdir), join(collisionDir, 'stolen.txt')],
]);

// 攻击向量 3：符号链接逃逸（旧逻辑完全没 realpath，放行；新逻辑拦截）
const outside = mkdtempSync(join(tmpdir(), 'outside-'));
let symlinkOk = false;
try { symlinkSync(outside, join(workdir, 'escape')); symlinkOk = true; }
catch (e) { console.log(`\n━━━ 攻击③ 符号链接逃逸（本环境无法创建软链，跳过）━━━\n  原因：${(e as Error).message}`); }
if (symlinkOk) {
  runCase('攻击③ 符号链接逃逸（工作区内软链指向外部）', workdir, [
    ['旧逻辑', (p) => oldSafePath(p, workdir), 'escape/stolen.txt'],
    ['新逻辑', (p) => newSafePath(p, workdir), 'escape/stolen.txt'],
  ]);
}

// 正向基线：合法内部文件不能被误伤（合法=不抛错，与上面 tryFn 语义相反，单独打印）
console.log('\n━━━ 基线④ 合法内部文件（新旧都应正常返回，不抛错）━━━');
const baselineExpected = join(workdir, 'a/b/c/new.txt');
for (const [label, fn] of [
  ['旧逻辑', (p: string) => oldSafePath(p, workdir)],
  ['新逻辑', (p: string) => newSafePath(p, workdir)],
] as const) {
  try {
    const r = fn('a/b/c/new.txt');
    console.log(`  ${label}: ✅ 正常返回 ${r === baselineExpected ? '(路径正确)' : `(❌ 路径不对: ${r})`}`);
  } catch (e) {
    console.log(`  ${label}: ❌ 误伤抛错：${(e as Error).message}`);
  }
}

// 清理
rmSync(workdir, { recursive: true, force: true });
rmSync(collisionDir, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
console.log('\n（临时目录已清理）');
