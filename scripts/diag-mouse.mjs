// scripts/diag-mouse.mjs
// 鼠标事件最小诊断（纯 Node，不加载 Ink / 自研渲染器）。
//
// 用途：定位「字符级选区无法选取」的根因。
//   - 若日志里有 \x1b[<...M 字节 → 终端回了鼠标事件，问题在 Ink/ScrollBox 接线
//   - 若点击时日志无任何新字节 → 终端没开鼠标模式，问题在模式启用
//   - 若字节格式和 SGR_RE 不匹配 → 解析器要调整
//
// 跑法：node scripts/diag-mouse.mjs   然后在终端里点几下/拖一下，15s 自动退出。
// 日志：mouse-diag.log（项目根）。

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logPath = path.join(__dirname, '..', 'mouse-diag.log');

const log = (msg) => {
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
};

// 重置日志
fs.writeFileSync(logPath, `=== Mouse diagnostic ${new Date().toISOString()} ===\n`);
log(`platform=${process.platform}  TERM=${process.env.TERM ?? '(unset)'}  TERM_PROGRAM=${process.env.TERM_PROGRAM ?? '(unset)'}`);
log(`stdin.isTTY=${process.stdin.isTTY}  stdout.isTTY=${process.stdout.isTTY}  SSH_CONNECTION=${process.env.SSH_CONNECTION ? 'set' : 'unset'}  TMUX=${process.env.TMUX ? 'set' : 'unset'}`);

if (!process.stdin.isTTY) {
  log('!! stdin 不是 TTY —— 在管道/CI 环境跑的？鼠标诊断无法进行。');
  console.error('stdin 不是 TTY，请直接在终端跑：node scripts/diag-mouse.mjs');
  process.exit(1);
}

// 原始模式 + utf8
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

// 进 alt screen（与 micode 一致，排除主屏/备屏差异）
process.stdout.write('\x1b[?1049h');
log('entered alt screen (?1049h)');

// 开启鼠标追踪 —— 与 src/tui/components/ScrollBox.tsx 完全相同的序列
const enableSeq = '\x1b[?1003h\x1b[?1006h';
process.stdout.write(enableSeq);
log(`wrote mouse-enable: bytes=${JSON.stringify(enableSeq)}`);

// 屏幕提示
process.stdout.write('\r\n=== 鼠标诊断已启动 ===\r\n');
process.stdout.write('请在终端里：\r\n');
process.stdout.write('  1) 左键点一下\r\n');
process.stdout.write('  2) 左键拖一段\r\n');
process.stdout.write('  3) 右键点一下\r\n');
process.stdout.write('  4) 滚轮滚一下\r\n');
process.stdout.write('所有字节实时记录到 mouse-diag.log\r\n');
process.stdout.write('15 秒后自动退出，或按 Ctrl+C 立即退出\r\n\r\n');

// 记录每个 chunk
let chunkCount = 0;
process.stdin.on('data', (chunk) => {
  chunkCount++;
  const hex = [...chunk].map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  log(`RECV #${chunkCount} len=${chunk.length} hex=${hex}`);
  log(`     str=${JSON.stringify(chunk)}`);
  // Ctrl+C 立即退出
  if (chunk === '\x03') {
    log('received Ctrl+C, exiting early');
    cleanup();
  }
});

function cleanup() {
  process.stdout.write('\r\n=== 退出，恢复终端 ===\r\n');
  // 反序关闭
  process.stdout.write('\x1b[?1003l\x1b[?1006l'); // 关鼠标
  process.stdout.write('\x1b[?1049l');             // 退 alt screen
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  log(`=== exited, received ${chunkCount} chunks total ===`);
  process.exit(0);
}

// 15s 自动退出
setTimeout(() => {
  log('15s timeout, auto-exit');
  cleanup();
}, 15000);

// 进程异常退出兜底
process.on('SIGINT', cleanup);
process.on('exit', () => {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?1003l\x1b[?1006l\x1b[?1049l');
  } catch { /* ignore */ }
});
