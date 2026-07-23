// scripts/tty-verify/run-verify.cjs
//
// ConPTY 真实终端验收运行器。
//
// 物理本质:用 node-pty 在 Windows ConPTY 里 spawn 渲染驱动脚本,
// 驱动脚本用真实 Ink render 输出 ANSI 到 PTY,本运行器捕获该 ANSI 流,
// 喂给 Screen 模拟器还原成"最终可见屏幕",再断言 Issue 1/2/3 的渲染契约。
//
// 这是比 ink-testing-library 更高的证据:验证真实终端的 ANSI 处理
// (光标定位/清屏/CJK 宽度)与 Ink 输出的兼容性。
//
// 用法: node scripts/tty-verify/run-verify.cjs
//
// 注意:stderr 可能出现 "AttachConsole failed" 噪音 —— 这是 node-pty 在非交互
// (无真实控制台)环境下 fork conpty_console_list_agent 辅助进程失败,属已知限制,
// 不影响 PTY 数据捕获(屏幕还原完整、断言准确、exit code 0)。
// 可用 `node scripts/tty-verify/run-verify.cjs 2>/dev/null` 抑制。

const pty = require('node-pty');
const { Screen } = require('./screen.cjs');
const path = require('path');

const COLS = 80;
const ROWS = 24;

/** 在 ConPTY 跑一个场景,返回还原后的屏幕文本 */
function runScenario(scenario, cols = COLS) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'render-scenarios.tsx');
    // 用 tsx 跑 .tsx(项目有 tsx 依赖)
    const p = pty.spawn(process.execPath, ['--import', 'tsx', script, scenario, String(cols)], {
      name: 'xterm-256color',
      cols,
      rows: ROWS,
      cwd: process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1', CI: '' },
    });
    let raw = '';
    p.onData(d => { raw += d; });
    p.onExit(({ exitCode }) => {
      if (exitCode !== 0) {
        // 即使非 0 也尝试还原(可能 Ink unmount 导致 exit code)
      }
      const screen = new Screen(cols, ROWS);
      screen.write(raw);
      resolve({ screen: screen.toString(), rawLen: raw.length });
    });
    // 超时保护
    setTimeout(() => { try { p.kill(); } catch {} }, 8000);
  });
}

// 简单的行匹配辅助:在屏幕文本里找含关键字的行
function findLine(screenText, needle) {
  return screenText.split('\n').find(l => l.includes(needle));
}

async function main() {
  const results = { pass: 0, fail: 0, details: [] };

  function check(name, cond, detail) {
    results.details.push({ name, pass: !!cond, detail });
    if (cond) results.pass++; else results.fail++;
  }

  // ── Issue 1:ask_user_question 父子结构 ──
  console.log('\n[1/4] ask-answered (Issue 1: 父子结构)...');
  const r1 = await runScenario('ask-answered');
  const s1 = r1.screen;
  check('Issue1: 含父标题 ● Answered 2 questions',
    /\bAnswered 2 questions/.test(s1) && findLine(s1, 'Answered')?.trimStart().startsWith('●'),
    `父标题行: ${JSON.stringify(findLine(s1, 'Answered'))}`);
  check('Issue1: 子项 日志库 → winston 含 ⎿',
    /⎿ 日志库 → winston/.test(s1) || /⎿.*日志库.*winston/.test(s1),
    `日志库行: ${JSON.stringify(findLine(s1, '日志库'))}`);
  check('Issue1: 子项 日志级别 → debug 含 ⎿',
    /⎿ 日志级别 → debug/.test(s1) || /⎿.*日志级别.*debug/.test(s1),
    `日志级别行: ${JSON.stringify(findLine(s1, '日志级别'))}`);

  // ── Issue 2:assistant 续行缩进 ──
  console.log('[2/4] assistant-cont (Issue 2: 续行缩进)...');
  const r2 = await runScenario('assistant-cont');
  const s2 = r2.screen;
  const contLine = findLine(s2, '第二段内容');
  check('Issue2: 续行"第二段内容"存在',
    !!contLine, `续行: ${JSON.stringify(contLine)}`);
  check('Issue2: 续行 2 空格缩进(非顶格)',
    !!contLine && contLine.startsWith('  ') && !contLine.startsWith('●'),
    `续行缩进: ${JSON.stringify(contLine)}`);

  // ── Issue 3:连续 agent-completion 间距 ──
  console.log('[3/4] agent-spacing (Issue 3: 消息间距)...');
  const r3 = await runScenario('agent-spacing');
  const s3 = r3.screen;
  const lines3 = s3.split('\n');
  const idxExpl = lines3.findIndex(l => l.includes('探索'));
  const idxPlan = lines3.findIndex(l => l.includes('规划'));
  check('Issue3: 两条 agent 行都存在',
    idxExpl >= 0 && idxPlan >= 0, `探索@${idxExpl} 规划@${idxPlan}`);
  check('Issue3: 两条 agent 之间有空行(idx 差 2)',
    idxExpl >= 0 && idxPlan === idxExpl + 2,
    `间距: idxExpl=${idxExpl} idxPlan=${idxPlan} (期望差2)`);
  if (idxExpl >= 0) {
    check('Issue3: 中间是空行',
      lines3[idxExpl + 1]?.trim() === '', `中间行: ${JSON.stringify(lines3[idxExpl + 1])}`);
  }

  // ── Issue 3 加固:超长标签截断 ──
  console.log('[4/4] truncate (Issue 3: 截断契约)...');
  const r4 = await runScenario('truncate', 24);  // 窄终端
  const s4 = r4.screen;
  const agentLine4 = findLine(s4, 'Agent');
  check('Trunc: agent 行存在', !!agentLine4, `agent行: ${JSON.stringify(agentLine4)}`);
  check('Trunc: 含截断符 …', !!agentLine4 && agentLine4.includes('…'), `含…: ${JSON.stringify(agentLine4)}`);
  check('Trunc: 不含完整长标签',
    !agentLine4 || !agentLine4.includes('用于测试截断'), `不含原文: ${JSON.stringify(agentLine4)}`);
  // display width 检查(粗略:行字符数 <= cols + 少量容差)
  if (agentLine4) {
    const w = [...agentLine4].reduce((sum, ch) => {
      const cp = ch.codePointAt(0);
      const wide = cp >= 0x1100 && ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xff60));
      return sum + (wide ? 2 : 1);
    }, 0);
    check('Trunc: 行宽 <= cols(24)', w <= 24, `行宽=${w} (cols=24)`);
  }

  // ── 汇报 ──
  console.log('\n════════════════════════════════════════');
  console.log(`ConPTY 验收结果: ${results.pass} passed, ${results.fail} failed`);
  console.log('════════════════════════════════════════');
  for (const d of results.details) {
    console.log(`  ${d.pass ? '✓' : '✗'} ${d.name}`);
    if (!d.pass) console.log(`      ${d.detail}`);
  }

  // 失败时 dump 屏幕(供调试)
  if (results.fail > 0) {
    console.log('\n=== 屏幕 dump(ask-answered)===');
    console.log(r1.screen);
    console.log('\n=== 屏幕 dump(agent-spacing)===');
    console.log(r3.screen);
    console.log('\n=== 屏幕 dump(truncate, cols=24)===');
    console.log(r4.screen);
  }

  process.exit(results.fail > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(2); });
