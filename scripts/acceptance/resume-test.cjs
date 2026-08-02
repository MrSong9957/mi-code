// scripts/acceptance/resume-test.cjs
// 场景 5:resume 已有 session + 输入新消息,验证历史可恢复且状态块不重复。
const pty = require('node-pty');
const { spawn } = require('child_process');
const { Screen } = require('../tty-verify/screen.cjs');
const path = require('path');
const fs = require('fs');

const COLS = 110, ROWS = 36;

async function startMock() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'mock-openai-server.cjs')], {
      env: { ...process.env, MOCK_PORT: '0', MOCK_SCRIPT: 'echo-text' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', d => {
      stdout += d;
      if (!proc._port) { const p = parseInt(stdout.trim(), 10); if (p > 0) { proc._port = p; resolve({ proc, port: p }); } }
    });
    setTimeout(() => { if (!proc._port) reject(new Error('no port')); }, 5000);
  });
}

async function main() {
  const home = process.argv[2];
  const sessionId = process.argv[3];
  if (!home || !sessionId) { console.error('用法: resume-test.cjs <home> <sessionId>'); process.exit(2); }

  const { proc: mock, port } = await startMock();
  // 更新 config 指向新 mock 端口
  const cfgPath = path.join(home, '.micode', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.providers.openai.baseUrl = `http://127.0.0.1:${port}/v1`;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const beforeBlocks = (fs.readFileSync(path.join(home, '.micode', 'sessions', `${sessionId}.jsonl`), 'utf8').match(/当前状态：/g) || []).length;
  const beforeLines = fs.readFileSync(path.join(home, '.micode', 'sessions', `${sessionId}.jsonl`), 'utf8').split('\n').filter(l => l.trim()).length;
  console.log(`[resume] resume 前: ${beforeBlocks} 状态块, ${beforeLines} 行`);

  const p = pty.spawn(process.execPath, [path.join(process.cwd(), 'dist', 'index.js'), '--resume', sessionId], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
    env: { ...process.env, USERPROFILE: home, HOME: home, FORCE_COLOR: '1', CI: '' },
  });
  let raw = '';
  p.onData(d => { raw += d; });

  // 等 resume 加载历史 + 输入新消息
  setTimeout(() => { p.write('继续'); }, 3000);
  setTimeout(() => { p.write('\r'); }, 3500);

  setTimeout(() => {
    try { p.kill(); } catch {}
    mock.kill();
    const screen = new Screen(COLS, ROWS);
    screen.write(raw);
    console.log('\n═══════ resume+新消息后屏幕 ═══════');
    console.log(screen.toString());
    console.log('══════════════════════════════════');

    const afterContent = fs.readFileSync(path.join(home, '.micode', 'sessions', `${sessionId}.jsonl`), 'utf8');
    const afterBlocks = (afterContent.match(/当前状态：/g) || []).length;
    const afterLines = afterContent.split('\n').filter(l => l.trim()).length;
    console.log(`[resume] resume+新消息后: ${afterBlocks} 状态块, ${afterLines} 行`);
    console.log(`[resume] 历史可恢复: ${afterLines >= beforeLines ? 'YES (历史保留)' : 'NO (历史丢失!)'}`);
    console.log(`[resume] 状态块未重复膨胀: ${afterBlocks <= beforeBlocks + 1 ? 'YES' : 'NO (重复膨胀!)'}`);
    process.exit(0);
  }, 9000);
}

main().catch(e => { console.error(e); process.exit(2); });
