// 跨平台进程树终止
//
// 物理本质（保姆级）：
// 普通的 child.kill() 只杀"门面的接待员"（直接子进程），
// 里面的"客人"（孙进程）变孤儿继续跑。
// 本模块做"全楼清场"：把整棵进程树（父+所有子孙）都请走。
//
// 平台策略：
// - Windows：taskkill /PID X /T /F（/T 递归树，/F 强制；数组参数无 shell，零注入）
// - Unix/macOS：递归枚举子进程（ps），自顶向下 SIGKILL
//
// 已知局限（Windows 固有）：
// - TOCTOU 竞态：枚举后、终止前新派生的孙进程可能逃脱（95% 场景覆盖）
// - breakaway 进程不受 /T 管辖（需 Job Object，属 Phase 4）
//
// 研究结论：tree-kill npm 包在 Windows 上就是本模块的一行包装，无引入价值。

import { spawnSync } from 'child_process';

/**
 * 杀掉整棵进程树（父 + 所有子孙进程）
 *
 * @param pid 根进程 PID（通常是 spawn 返回的 child.pid）
 * @param _signal Unix 信号（Windows 忽略，固定 /F 强制）
 */
export function killProcessTree(pid: number, _signal: string = 'SIGKILL'): void {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    // Windows：taskkill /T 递归树 /F 强制。数组参数不走 shell，零命令注入风险。
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    // Unix/macOS：递归收集所有后代 PID，自顶向下杀（先父后子，防父死后子被 reparent）
    const allPids = collectDescendants(pid);
    allPids.push(pid);
    for (const p of allPids) {
      try {
        process.kill(p, _signal);
      } catch {
        // 进程可能已退出，忽略
      }
    }
  }
}

/**
 * 递归收集 pid 的所有后代 PID（Unix/macOS）
 *
 * 用 ps 枚举父子关系。返回顺序：孙子→子（自底向上），
 * 调用方需自行 append 根 pid 后自顶向下杀。
 */
function collectDescendants(pid: number): number[] {
  const result: number[] = [];
  const queue = [pid];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    // ps 列出 current 的直接子进程
    try {
      const out = spawnSync('ps', ['-o', 'pid', '--ppid', String(current), '--noheaders'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out.stdout) {
        for (const line of out.stdout.trim().split('\n')) {
          const childPid = parseInt(line.trim(), 10);
          if (!Number.isNaN(childPid) && !visited.has(childPid)) {
            result.push(childPid);
            queue.push(childPid);
          }
        }
      }
    } catch {
      // ps 失败（进程已退出或权限不足），跳过
    }
  }

  return result;
}
