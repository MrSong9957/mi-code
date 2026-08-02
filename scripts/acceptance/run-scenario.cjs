// scripts/acceptance/run-scenario.cjs
//
// 真实 CLI/TUI 验收驱动器。
// mock OpenAI server → 真实 dist/index.js (TUI) → node-pty 输入 → 捕获 ANSI 还原屏幕。
//
// 用法: node scripts/acceptance/run-scenario.cjs <script> <input>
// stderr 重定向避免 node-pty AttachConsole 噪音打断驱动器。

const pty = require('node-pty');
const { spawn } = require('child_process');
const { Screen } = require('../tty-verify/screen.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

const COLS = 110;
const ROWS = 36;

// ── mock server ──────────────────────────────────────────────────
function startMock(scriptName) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'mock-openai-server.cjs')], {
      env: { ...process.env, MOCK_PORT: '0', MOCK_SCRIPT: scriptName },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', d => {
      stdout += d;
      if (!proc._port) {
        const port = parseInt(stdout.trim(), 10);
        if (port > 0) { proc._port = port; resolve({ proc, port }); }
      }
    });
    proc.on('error', reject);
    setTimeout(() => { if (!proc._port) reject(new Error('mock no port: ' + stdout)); }, 5000);
  });
}

// ── 隔离 HOME ────────────────────────────────────────────────────
function makeHome(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'micode-acc-'));
  const mdir = path.join(home, '.micode');
  fs.mkdirSync(mdir, { recursive: true });
  fs.writeFileSync(path.join(mdir, 'config.json'), JSON.stringify({
    defaultProvider: 'openai',
    providers: { openai: { apiKey: 'test', model: 'mock-model', baseUrl: `http://127.0.0.1:${port}/v1` } },
    // auto 模式:自动化验收需要工具执行不被权限询问阻塞(spawn_agent/read_file 等)。
    permissions: { mode: 'auto', rules: [] },
    theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
  }));
  return home;
}

// ── 驱动 dist TUI ────────────────────────────────────────────────
function runDist(home, inputText, waitMs = 12000) {
  return new Promise((resolve) => {
    const p = pty.spawn(process.execPath, [path.join(process.cwd(), 'dist', 'index.js')], {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
      env: { ...process.env, USERPROFILE: home, HOME: home, FORCE_COLOR: '1', CI: '' },
    });
    let raw = '';
    p.onData(d => { raw += d; });

    // 等 TUI 初始化后输入
    setTimeout(() => { p.write(inputText); }, 2000);
    setTimeout(() => { p.write('\r'); }, 2500);

    setTimeout(() => {
      try { p.kill(); } catch {}
      const screen = new Screen(COLS, ROWS);
      screen.write(raw);
      resolve({ screen: screen.toString(), raw });
    }, waitMs);
  });
}

// ── 主 ───────────────────────────────────────────────────────────
async function main() {
  const scriptName = process.argv[2];
  const inputText = process.argv[3];
  const waitMs = parseInt(process.argv[4] || '12000', 10);
  if (!scriptName || !inputText) {
    console.error('用法: node run-scenario.cjs <script> <input> [waitMs]');
    process.exit(2);
  }
  console.log(`[run] script=${scriptName} input="${inputText.slice(0, 40)}..." wait=${waitMs}ms`);

  const { proc: mock, port } = await startMock(scriptName);
  console.log(`[run] mock@127.0.0.1:${port}`);
  const home = makeHome(port);
  console.log(`[run] HOME=${home}`);

  const { screen, raw } = await runDist(home, inputText, waitMs);
  mock.kill();

  console.log('\n═══════ 还原屏幕 ═══════');
  console.log(screen);
  console.log('═══════════════════════\n');

  // 落盘证据
  const mdir = path.join(home, '.micode');
  console.log('=== 落盘证据 ===');
  const sessDir = path.join(mdir, 'sessions');
  const subDir = path.join(mdir, 'subagents');
  try {
    if (fs.existsSync(sessDir)) {
      const files = fs.readdirSync(sessDir);
      console.log('sessions/:', files);
      for (const f of files.filter(f => f.endsWith('.jsonl'))) {
        const content = fs.readFileSync(path.join(sessDir, f), 'utf8');
        console.log(`  ${f} (${content.length} bytes, ${content.split('\n').filter(l=>l.trim()).length} lines)`);
      }
    } else { console.log('sessions/: (不存在)'); }
    if (fs.existsSync(subDir)) {
      console.log('subagents/:', JSON.stringify(listTree(subDir)));
      for (const jf of findFiles(subDir, '.jsonl')) {
        const content = fs.readFileSync(jf, 'utf8');
        console.log(`  ${path.relative(subDir, jf)} (${content.length} bytes, ${content.split('\n').filter(l=>l.trim()).length} lines)`);
      }
    } else { console.log('subagents/: (不存在)'); }
  } catch (e) { console.log('  读取失败:', e.message); }

  // 输出 home 路径供外部核对
  console.log(`\n[run] HOME=${home}`);
  console.log(`[run] mock calls: ${mockCallCount()}`);
  process.exit(0);
}

function listTree(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    out[e.name] = e.isDirectory() ? listTree(path.join(dir, e.name)) : 'file';
  }
  return out;
}
function findFiles(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...findFiles(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}
let _mockCalls = 0;
function mockCallCount() { return _mockCalls; }

main().catch(e => { console.error('[run] error:', e); process.exit(2); });
