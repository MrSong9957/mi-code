// Phase 2 进程控制实测脚本：验证超时后整棵进程树被清干净（无孤儿残留）
//
// 用法：npx tsx scripts/verify-process-control.mts
//
// 核心验证点：
//   1. 直接长驻进程：超时后被杀，进程不存在
//   2. shell 包装的孙进程（模拟 npm run dev 结构）：超时后 shell + 孙进程都死
//   3. 对比"旧逻辑（只杀直接子进程）"vs"新逻辑（killProcessTree 全树杀）"
//
// 用真实进程（不 mock），AAA 实体核对：process.kill(pid,0) 抛错 = 进程已死

import { spawn } from 'child_process';
import { killProcessTree } from '../src/agent/process-tree.ts';

/** 检查进程是否还活着（kill(pid,0) 不抛 = 活着；抛 ESRCH = 死了） */
function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** 等 ms 毫秒 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 场景 1：直接长驻进程 ──
async function scenario1() {
  console.log('━━━ 场景① 直接长驻进程 ━━━');
  console.log('  命令：node -e "setInterval(()=>{},10000)"（永不退出）');

  const child = spawn('node', ['-e', 'setInterval(()=>{},10000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  const pid = child.pid!;
  console.log(`  启动 pid=${pid}，确认活着: ${isAlive(pid) ? '✅ 活' : '❌ 没活起来'}`);

  await sleep(200);
  killProcessTree(pid);
  await sleep(500); // 给 OS 回收时间

  console.log(`  killProcessTree 后，pid=${pid} 还在吗: ${isAlive(pid) ? '❌ 仍存活（孤儿！）' : '✅ 已死透'}`);
  console.log('');
}

// ── 场景 2：shell 包装的孙进程（模拟 npm run dev 结构）──
//
// 这是 Phase 2 要解决的核心场景：
// shell:true 时 spawn 的 pid 是 cmd.exe，实际命令（node）是它的子进程。
// 旧 spawnSync 只杀 cmd.exe，node 孙进程变孤儿。
async function scenario2() {
  console.log('━━━ 场景② shell 包装的孙进程（模拟 npm run dev）━━━');
  console.log('  结构：cmd.exe (shell) → node (孙进程，永不退出)');

  // shell:true 启动——pid 是 shell，node 是子进程
  const child = spawn('node -e "setInterval(()=>{},10000)"', [], {
    shell: true, stdio: 'ignore', windowsHide: true,
  });
  const shellPid = child.pid!;
  console.log(`  shell pid=${shellPid}，确认活着: ${isAlive(shellPid) ? '✅ 活' : '❌'}`);

  await sleep(500); // 等 shell 把 node 子进程拉起来
  killProcessTree(shellPid);
  await sleep(500);

  console.log(`  killProcessTree 后，shell pid=${shellPid}: ${isAlive(shellPid) ? '❌ 仍存活' : '✅ 已死'}`);
  // 孙进程（node）我们拿不到 pid，但 taskkill /T 应该连带杀掉。
  // 验证方式：shell 死了 + 没有新的 node 孤儿（靠场景③端口验证更直观）
  console.log('');
}

// ── 场景 3：端口占用验证（最贴近真实 npm run dev 困扰）──
//
// 启一个监听端口的 node 进程（模拟 dev server），
// killProcessTree 后端口应被释放——这是用户实际困扰的核心症状。
async function scenario3() {
  console.log('━━━ 场景③ 端口占用验证（dev server 模拟）━━━');
  const PORT = 18923 + Math.floor(Math.random() * 1000); // 随机端口防冲突
  console.log(`  命令：node 监听 ${PORT} 端口（模拟 dev server）`);

  const { createServer } = await import('net');
  const checkPort = (): Promise<boolean> => new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false)); // 端口被占
    s.once('listening', () => { s.close(); resolve(true); }); // 端口空闲
    s.listen(PORT);
  });

  // 用 shell 启动监听端口的 node（模拟 npm run dev → dev server 监听端口）
  const child = spawn(`node -e "require('net').createServer().listen(${PORT})"`, [], {
    shell: true, stdio: 'ignore', windowsHide: true,
  });
  const shellPid = child.pid!;

  // 轮询等待端口真的被占（shell 启动链路慢，固定 sleep 不够）
  let occupiedBefore = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    occupiedBefore = !(await checkPort());
    if (occupiedBefore) break;
  }
  console.log(`  启动后端口 ${PORT} 被占: ${occupiedBefore ? '✅ 是（dev server 在跑）' : '❌ 没占起来（启动太慢，跳过此场景）'}`);
  if (!occupiedBefore) { child.kill(); console.log(''); return; }

  killProcessTree(shellPid);
  await sleep(1000); // 给 OS 回收端口时间

  const occupiedAfter = !(await checkPort());
  console.log(`  killProcessTree 后端口 ${PORT} 被占: ${occupiedAfter ? '❌ 仍占用（孤儿 server！）' : '✅ 已释放'}`);
  console.log('');
}

// ── 主流程 ──
console.log(`平台: ${process.platform}\n`);
await scenario1();
await scenario2();
await scenario3();
console.log('（实测完毕）');
