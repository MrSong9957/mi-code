// scripts/tty-verify/verify-language.cjs
//
// /language 持久化 + --language override 真实 ConPTY E2E 验收。
//
// 物理本质:用 node-pty 在真实 ConPTY 启动真实 dist/index.js (TUI),
// 用 mock OpenAI server 隔离外部 LLM,用隔离 HOME 隔离用户配置,
// 通过 pty.write 真实键入 /language,捕获 ANSI 还原屏幕,断言:
//   L1 持久化写入(/language en-US → config.json 变 en-US + 英文回显)
//   L2 重启读取持久化(无 flag 重启 → /language 回显 en-US 英文)
//   L3 --language override(临时 zh-CN + 磁盘仍 en-US)
//   L4 override 生命周期(再无 flag 重启 → 恢复 en-US)
//
// 输入驱动规则(根因:Ink 只对独立 \r event 产生 key.return):
//   1. 写入文本(可一次 write)
//   2. 等待屏幕出现该文本(condition-based,不靠固定 sleep)
//   3. 单独 write('\r')(绝不与文本拼成一次 write)
//
// 用法: node scripts/tty-verify/verify-language.cjs

const pty = require('node-pty');
const { spawn } = require('child_process');
const { Screen } = require('./screen.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

const COLS = 110;
const ROWS = 36;
const DIST = path.join(process.cwd(), 'dist', 'index.js');
const MOCK_SERVER = path.join(__dirname, '..', 'acceptance', 'mock-openai-server.cjs');

// ── mock server ──────────────────────────────────────────────────
function startMock() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [MOCK_SERVER], {
      env: { ...process.env, MOCK_PORT: '0', MOCK_SCRIPT: 'echo-text' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
      const port = parseInt(stdout.trim(), 10);
      if (port > 0 && !proc._port) {
        proc._port = port;
        resolve({ proc, port });
      }
    });
    proc.on('error', reject);
    setTimeout(() => { if (!proc._port) reject(new Error('mock no port: ' + stdout)); }, 5000);
  });
}

// ── 隔离 HOME ────────────────────────────────────────────────────
function makeHome(port, language) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'micode-lang-'));
  const mdir = path.join(home, '.micode');
  fs.mkdirSync(mdir, { recursive: true });
  const config = {
    defaultProvider: 'openai',
    providers: { openai: { apiKey: 'test', model: 'mock-model', baseUrl: `http://127.0.0.1:${port}/v1` } },
    permissions: { mode: 'auto', rules: [] },
    theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
  };
  if (language) config.language = language;
  fs.writeFileSync(path.join(mdir, 'config.json'), JSON.stringify(config));
  return home;
}

function readConfigLanguage(home) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.micode', 'config.json'), 'utf8'));
    return j.language ?? null;
  } catch { return null; }
}

// ── Screen 快照(从 raw ANSI 还原当前可见屏幕) ─────────────────
function snapshot(raw) {
  const screen = new Screen(COLS, ROWS);
  screen.write(raw);
  return screen.toString();
}

// ── condition-based wait:轮询 raw 还原屏幕,直到谓词为真或超时 ──
function waitFor(rawRef, predicate, { timeout = 8000, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const screen = snapshot(rawRef.value);
      if (predicate(screen)) return resolve(screen);
      if (Date.now() - start >= timeout) {
        return reject(new Error(
          `waitFor 超时(${timeout}ms): ${label}\n` +
          `--- 最终屏幕末 12 行 ---\n${screen.split('\n').slice(-12).join('\n')}\n` +
          `--- raw ANSI 尾部 hex ---\n${Buffer.from(rawRef.value.slice(-60), 'utf8').toString('hex')}`
        ));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

// ── 真实 PTY 会话 ────────────────────────────────────────────────
class TtySession {
  constructor({ home, cliArgs = [] }) {
    this.home = home;
    this.raw = '';
    this.rawRef = { get value() { return this.raw; } };
    this._bindRawRef();
  }
  _bindRawRef() {
    const self = this;
    this.rawRef = { get value() { return self.raw; } };
  }
  start(cliArgs = []) {
    this.p = pty.spawn(process.execPath, [DIST, ...cliArgs], {
      name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
      // CI 必须显式置 'false'(非空串)。is-in-ci@2.x 的 check 只排除 '0'/'false',
      // 空串 CI='' 反被判为"在 CI 中" → Ink interactive=false → 活动区延迟到 unmount 才 flush。
      // PTY E2E 要模拟真实 interactive terminal,即使父进程在 CI 也不能降级。
      env: { ...process.env, USERPROFILE: this.home, HOME: this.home, FORCE_COLOR: '1', CI: 'false', CONTINUOUS_INTEGRATION: 'false' },
    });
    this.p.onData((d) => { this.raw += d; });
  }
  // condition-based 输入:写文本 → 等文本可见 → 单独写 \r → 等目标 anchor
  async typeAndSubmit(text, anchor, anchorTimeout = 8000) {
    // 1. 写文本(整块可接受:可打印字符不触发 submit)
    this.p.write(text);
    // 2. 等待文本在输入区可见(证明字符已进入输入 store)
    await waitFor(this.rawRef,
      (s) => s.includes(text),
      { timeout: 5000, label: `输入文本可见: "${text}"` });
    // 3. 单独写 \r(绝不与文本同一次 write)
    this.p.write('\r');
    // 4. 等提交后的目标 anchor
    if (anchor) {
      return waitFor(this.rawRef, (s) => s.includes(anchor),
        { timeout: anchorTimeout, label: `提交后 anchor: "${anchor}"` });
    }
  }
  kill() { try { this.p.kill(); } catch {} }
}

// ── 断言辅助 ─────────────────────────────────────────────────────
const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `  [${detail}]`}`);
}

// 去除 SGR/CSI 控制序列,便于文本匹配
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

async function main() {
  const mock = await startMock();
  console.log(`[setup] mock@127.0.0.1:${mock.proc._port}`);

  try {
    // ════════ L1:持久化写入 ════════
    console.log('\n[L1] 持久化 /language en-US ...');
    const homeL1 = makeHome(mock.proc._port, null); // 初始无 language
    const s1 = new TtySession({ home: homeL1 });
    s1.start();
    try {
      // 等待 TUI 就绪(prompt 可见)
      await waitFor(s1.rawRef, (scr) => scr.includes('❯') || scr.includes('MiCode'),
        { timeout: 8000, label: 'TUI 就绪' });
      await s1.typeAndSubmit('/language en-US', 'Language switched to en-US');
      const lang = readConfigLanguage(homeL1);
      check('L1a: config.json language=en-US', lang === 'en-US', `实际=${lang}`);
      check('L1b: 屏幕含英文回显 Language switched to en-US', snapshot(s1.raw).includes('Language switched to en-US'), '回显缺失');
    } finally { s1.kill(); }

    // ════════ L2:重启读取持久化 ════════
    console.log('\n[L2] 无 flag 重启,/language 回显 en-US ...');
    const s2 = new TtySession({ home: homeL1 });
    s2.start();
    try {
      await waitFor(s2.rawRef, (scr) => scr.includes('❯') || scr.includes('MiCode'),
        { timeout: 8000, label: 'TUI 就绪' });
      // /language 无参 → 只读,无 submit 需求,但走同一 typeAndSubmit(Enter 触发命令执行)
      await s2.typeAndSubmit('/language', 'Current language: en-US');
      const screen2 = clean(snapshot(s2.raw));
      check('L2a: 屏幕含 Current language: en-US', screen2.includes('Current language: en-US'), '回显缺失');
      check('L2b: 不含默认中文(证明读持久化非默认)', !screen2.includes('当前语言'), '仍为中文');
    } finally { s2.kill(); }

    // ════════ L3:--language override ════════
    console.log('\n[L3] --language zh-CN override ...');
    const s3 = new TtySession({ home: homeL1 });
    s3.start(['--language', 'zh-CN']);
    try {
      await waitFor(s3.rawRef, (scr) => scr.includes('❯') || scr.includes('MiCode'),
        { timeout: 8000, label: 'TUI 就绪' });
      await s3.typeAndSubmit('/language', '当前语言：zh-CN');
      const screen3 = clean(snapshot(s3.raw));
      check('L3a: 屏幕中文回显 当前语言：zh-CN', screen3.includes('当前语言：zh-CN'), '回显缺失');
      const lang3 = readConfigLanguage(homeL1);
      check('L3b: 磁盘 config 仍 en-US(override 不写盘)', lang3 === 'en-US', `实际=${lang3}`);
    } finally { s3.kill(); }

    // ════════ L4:override 生命周期 ════════
    console.log('\n[L4] 再无 flag 重启,恢复 en-US ...');
    const s4 = new TtySession({ home: homeL1 });
    s4.start();
    try {
      await waitFor(s4.rawRef, (scr) => scr.includes('❯') || scr.includes('MiCode'),
        { timeout: 8000, label: 'TUI 就绪' });
      await s4.typeAndSubmit('/language', 'Current language: en-US');
      const screen4 = clean(snapshot(s4.raw));
      check('L4a: 屏幕恢复英文 Current language: en-US', screen4.includes('Current language: en-US'), '回显缺失');
      check('L4b: 不含中文(override 已失效)', !screen4.includes('当前语言'), '仍为中文');
    } finally { s4.kill(); }

    // 清理隔离 HOME
    try { fs.rmSync(homeL1, { recursive: true, force: true }); } catch {}
  } finally {
    mock.proc.kill();
  }

  // ── 汇总 ──
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass).length;
  console.log('\n════════════════════════════════════════');
  console.log(`/language ConPTY E2E: ${pass} passed, ${fail} failed`);
  console.log('════════════════════════════════════════');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[fatal]', e.message);
  // 失败时输出诊断
  results.forEach((r) => { if (!r.pass) console.log(`  FAIL: ${r.name} — ${r.detail}`); });
  process.exit(2);
});
