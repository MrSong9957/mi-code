// scripts/tty-verify/verify-ctrl-j.cjs
//
// ConPTY Ctrl+J 端到端回归验收。
// 在真实 ConPTY 启动 ctrl-j-interactive.tsx,发送按键序列(AAA → \n → BBB),
// 捕获最终屏幕,断言两行渲染(❯ AAA /   BBB)且未提交。
//
// 用法: node scripts/tty-verify/verify-ctrl-j.cjs

const pty = require('node-pty');
const { Screen } = require('./screen.cjs');
const path = require('path');

const COLS = 80;
const ROWS = 24;

function runCtrlJ() {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'ctrl-j-interactive.tsx');
    const p = pty.spawn(process.execPath, ['--import', 'tsx', script, String(COLS)], {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1', CI: '' },
    });
    let raw = '';
    p.onData(d => { raw += d; });

    // 时序:启动后等 500ms(渲染稳定),发送按键序列,等屏幕更新,kill 捕获
    setTimeout(() => {
      p.write('AAA');        // 输入 AAA
    }, 500);
    setTimeout(() => {
      p.write('\n');         // Ctrl+J(=0x0a=\n)
    }, 800);
    setTimeout(() => {
      p.write('BBB');        // 输入 BBB
    }, 1100);

    p.onExit(() => {
      const screen = new Screen(COLS, ROWS);
      screen.write(raw);
      resolve(screen.toString());
    });
    setTimeout(() => { try { p.kill(); } catch {} }, 3000);
  });
}

const clean = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

async function main() {
  const results = [];
  const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

  console.log('[Ctrl+J] 启动 ConPTY,发送 AAA → Ctrl+J → BBB...');
  const screen = clean(await runCtrlJ());
  const lines = screen.split('\n');

  // 找含 AAA 和 BBB 的行
  const aaaLine = lines.find(l => l.includes('AAA'));
  const bbbLine = lines.find(l => l.includes('BBB'));

  console.log('=== 屏幕dump(关键行) ===');
  lines.forEach((l, i) => { if (/AAA|BBB|❯/.test(l)) console.log(`  [${i}] ${JSON.stringify(l)}`); });

  check('AAA 在输入区(prompt 行)', !!aaaLine && /❯.*AAA/.test(aaaLine), `AAA行: ${JSON.stringify(aaaLine)}`);
  check('BBB 在输入区(续行,缩进)', !!bbbLine && /^\s+.*BBB/.test(bbbLine), `BBB行: ${JSON.stringify(bbbLine)}`);
  check('AAA 与 BBB 在不同行(两行渲染)', !!aaaLine && !!bbbLine && lines.indexOf(aaaLine) !== lines.indexOf(bbbLine),
    `AAA行号=${aaaLine ? lines.indexOf(aaaLine) : -1} BBB行号=${bbbLine ? lines.indexOf(bbbLine) : -1}`);
  check('BBB 在 AAA 之后(顺序)', !!aaaLine && !!bbbLine && lines.indexOf(bbbLine) > lines.indexOf(aaaLine),
    `顺序: AAA=${lines.indexOf(aaaLine)} BBB=${lines.indexOf(bbbLine)}`);

  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => !r.pass).length;
  console.log('\n════════════════════════════════════════');
  console.log(`Ctrl+J ConPTY 验收: ${pass} passed, ${fail} failed`);
  console.log('════════════════════════════════════════');
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
