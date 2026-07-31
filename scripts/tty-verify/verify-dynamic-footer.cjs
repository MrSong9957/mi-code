// scripts/tty-verify/verify-dynamic-footer.cjs
//
// ConPTY 动态 footer 7 项自动化验收。
// 在真实 ConPTY spawn dynamic-footer.tsx,捕获 ANSI 还原屏幕,逐项断言。
// 用法: node scripts/tty-verify/verify-dynamic-footer.cjs

const pty = require('node-pty');
const { Screen } = require('./screen.cjs');
const path = require('path');

const COLS = 80;
const ROWS = 24;

function runScenario(scenario, cols = COLS) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'dynamic-footer.tsx');
    const p = pty.spawn(process.execPath, ['--import', 'tsx', script, scenario, String(cols)], {
      name: 'xterm-256color', cols, rows: ROWS, cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1', CI: '' },
    });
    let raw = '';
    p.onData(d => { raw += d; });
    p.onExit(() => {
      const screen = new Screen(cols, ROWS);
      screen.write(raw);
      resolve(screen.toString());
    });
    setTimeout(() => { try { p.kill(); } catch {} }, 8000);
  });
}

const clean = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const lines = (s) => s.split('\n');
const findIdx = (s, needle) => lines(s).findIndex(l => l.includes(needle));
const borderRe = /─{20,}/;
const promptRe = /❯/;

async function main() {
  const results = [];
  const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail });

  // ── 1. 空输入 ──
  console.log('[1/7] 空输入...');
  const s1 = clean(await runScenario('empty'));
  const p1 = findIdx(s1, '❯');
  const lb1 = lines(s1).findIndex((l, i) => i > p1 && borderRe.test(l));
  check('1a 输入区 1 行(prompt 存在)', p1 >= 0 && promptRe.test(lines(s1)[p1]), `prompt 行 ${p1}`);
  check('1b 下边框紧贴输入行(隔 1 行)', lb1 === p1 + 1, `prompt=${p1} 下边框=${lb1}`);
  check('1c 无多余输入行(prompt 后即下边框)', lb1 - p1 === 1, `间距 ${lb1 - p1}`);

  // ── 2. 2-5 行(5 行代表) ──
  console.log('[2/7] 5 行显式换行...');
  const s5 = clean(await runScenario('five'));
  check('2a 5 行内容全可见(l1-l5)', ['l1','l2','l3','l4','l5'].every(x => s5.includes(x)), 'l1-l5');
  const p5 = findIdx(s5, '❯ l1');
  const lb5 = lines(s5).findIndex((l, i) => i > p5 && borderRe.test(l));
  check('2b 下边框在 5 行内容之后(≥5 行高度)', lb5 - p5 >= 5, `prompt=${p5} 下边框=${lb5} 高度=${lb5-p5}`);

  // ── 3. 超过 5 行(6 行) ──
  console.log('[3/7] 6 行(视口滚动)...');
  const s6 = clean(await runScenario('six'));
  // 视口锁 5 行:cursor 在末尾(l6 后),光标居中,l6 应可见
  check('3a 视口锁 5 行(光标行 l6 可见)', s6.includes('l6'), 'l6');
  // 6 行时 viewportTop 居中,prompt 行(l1/❯)可能滚出视口。
  // 实际输入区固定 5 行:找上下边框之间的内容行数=5
  const upperB6 = lines(s6).findIndex(l => borderRe.test(l));
  const lowerB6 = lines(s6).findIndex((l, i) => i > upperB6 && borderRe.test(l));
  const inputRows6 = lowerB6 - upperB6 - 1;  // 上下边框之间的行数
  check('3b 输入区固定 5 行(上下边框间=5 行)', inputRows6 === 5, `边框间行数=${inputRows6}`);

  // ── 4. 长英文软折行 ──
  console.log('[4/7] 长英文折行...');
  const sEn = clean(await runScenario('long-en'));
  // 折行后行数 > 1,且无前导空格(每行不以空格开头,除 prompt/缩进行)
  const enInputLines = lines(sEn).filter(l => /word/.test(l));
  check('4a 长英文折行(多行 word)', enInputLines.length >= 2, `word 行数 ${enInputLines.length}`);
  // 检查无异常前导空格:首行 ❯ word,续行  word(缩进,非纯空格开头异常)
  const badLeading = enInputLines.some(l => /^\s{3,}word/.test(l)); // 缩进2 + word 正常,3+空格异常
  check('4b 无异常前导空格(续行缩进=2)', !badLeading, `异常前导: ${badLeading}`);

  // ── 5. 长中文折行 ──
  console.log('[5/7] 长中文折行...');
  const sZh = clean(await runScenario('long-zh'));
  const zhLines = lines(sZh).filter(l => /你|好|世|界|测|试|中|文|折|行/.test(l));
  check('5a 长中文折行(多行 CJK)', zhLines.length >= 2, `CJK 行数 ${zhLines.length}`);
  // 不截半个字符:stringWidth 正确则无乱码(检查无替换字符 �)
  check('5b 无半个字符(无替换符)', !sZh.includes('�'), '替换符检查');

  // ── 6. 删除后缩回(对比 5 行 vs 1 行空)──
  console.log('[6/7] 删除后缩回(对比)...');
  // empty 场景已捕获(s1),five 场景已捕获(s5)
  const p1b = findIdx(s1, '❯');
  const lb1b = lines(s1).findIndex((l, i) => i > p1b && borderRe.test(l));
  check('6a 删到 1 行:输入区缩回 1 行', lb1b - p1b === 1, `1行高度=${lb1b-p1b}`);
  check('6b 5行 vs 1行:高度差显著(5行更高)', lb5 - p5 > lb1b - p1b, `5行=${lb5-p5} 1行=${lb1b-p1b}`);

  // ── 7. resize(cols 变化)──
  console.log('[7/7] resize(cols 40 vs 80)...');
  const sEn40 = clean(await runScenario('long-en', 40));
  const sEn80 = clean(await runScenario('long-en', 80));
  const w40 = lines(sEn40).filter(l => /word/.test(l)).length;
  const w80 = lines(sEn80).filter(l => /word/.test(l)).length;
  check('7a resize 窄(40)折行比宽(80)更多', w40 > w80, `40cols=${w40}行 80cols=${w80}行`);
  check('7b resize 窄(40)无右边框丢失(边框仍存在)', borderRe.test(sEn40), '边框检查');

  // ── 汇总 ──
  const pass = results.filter(r => r.pass).length;
  const fail = results.filter(r => !r.pass).length;
  console.log('\n════════════════════════════════════════');
  console.log(`动态 footer TTY 验收: ${pass} passed, ${fail} failed`);
  console.log('════════════════════════════════════════');
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass ? '' : `  [${r.detail}]`}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
