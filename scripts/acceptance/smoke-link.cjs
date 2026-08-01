// scripts/acceptance/smoke-link.cjs
//
// 最小链路验证:mock OpenAI server → 真实 dist/index.js (TUI) → pty 输入 → 捕获输出。
//
// 目标:证明 provider 可控、PTY 可驱动、最终屏幕内容可读取。
// 只跑最简单的 echo-text 场景(单轮纯文本)。

const pty = require('node-pty');
const { spawn } = require('child_process');
const { Screen } = require('../tty-verify/screen.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

const COLS = 100;
const ROWS = 30;

// ── 1. 启动 mock server,拿端口 ────────────────────────────────
function startMockServer(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, 'mock-openai-server.cjs')], {
      env: { ...process.env, MOCK_PORT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      stdout += d;
      // mock server 第一行输出端口
      if (!proc._portResolved) {
        proc._portResolved = true;
        const port = parseInt(stdout.trim(), 10);
        if (port > 0) {
          resolve({ proc, port });
        }
      }
    });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('error', reject);
    setTimeout(() => {
      if (!proc._portResolved) {
        reject(new Error(`mock server no port. stdout=${stdout} stderr=${stderr}`));
      }
    }, 5000);
  });
}

// ── 2. 准备隔离 HOME(含 config.json) ─────────────────────────
function makeIsolatedHome(mockPort, script) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'micode-acc-'));
  const micodeDir = path.join(home, '.micode');
  fs.mkdirSync(micodeDir, { recursive: true });

  // config.json:openai provider 指向 mock
  const config = {
    defaultProvider: 'openai',
    providers: {
      openai: {
        apiKey: 'test-key-not-real',
        model: 'mock-model',
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      },
    },
    permissions: { mode: 'build', rules: [] },
    theme: 'dark',
    spinnerVerbs: { mode: 'append', verbs: [] },
  };
  fs.writeFileSync(path.join(micodeDir, 'config.json'), JSON.stringify(config, null, 2));

  return home;
}

// ── 3. 在 ConPTY 跑真实 dist/index.js ──────────────────────────
function runTui(home, mockPort, script, inputText, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      USERPROFILE: home,           // Windows homedir() 读这个
      HOME: home,                  // 兜底
      OPENAI_API_KEY: 'test-key-not-real',
      MOCK_SCRIPT_HEADER: script,  // 信息记录(实际通过 OpenAI SDK 传不出自定义头)
      FORCE_COLOR: '1',
      CI: '',
      MICODE_MOCK_SCRIPT: script,  // 驱动器自用记录
    };

    // 注意:OpenAI SDK 默认不传自定义头。mock server 默认用 echo-text 剧本。
    // 复杂剧本(多轮 spawn_agent)需要 server 能区分请求来源(主/子代理)。
    // 当前 smoke 只验证 echo-text(默认剧本),所以不需要自定义头。

    const p = pty.spawn(process.execPath, [path.join(process.cwd(), 'dist', 'index.js')], {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: process.cwd(),
      env,
    });

    let raw = '';
    p.onData(d => { raw += d; });

    // 等待 TUI 初始化后发送输入
    setTimeout(() => {
      p.write(inputText);
      p.write('\r');
    }, 2500);

    // 超时收集结果
    setTimeout(() => {
      try { p.kill(); } catch {}
      const screen = new Screen(COLS, ROWS);
      screen.write(raw);
      resolve({ screen: screen.toString(), rawLen: raw.length, raw });
    }, timeoutMs);
  });
}

// ── 主流程 ─────────────────────────────────────────────────────
async function main() {
  const script = process.argv[2] || 'echo-text';
  const inputText = process.argv[3] || '你好';
  console.log(`[smoke] 剧本=${script} 输入="${inputText}"`);

  // 1. 启动 mock
  console.log('[smoke] 启动 mock OpenAI server...');
  const { proc: mockProc, port } = await startMockServer(script);
  console.log(`[smoke] mock server 监听 127.0.0.1:${port}`);

  // 2. 隔离 HOME
  const home = makeIsolatedHome(port, script);
  console.log(`[smoke] 隔离 HOME=${home}`);

  // 3. 跑 TUI
  console.log('[smoke] 启动 dist/index.js (真实 TUI)...');
  const result = await runTui(home, port, script, inputText);

  // 4. 关闭 mock
  mockProc.kill();

  // 5. 输出结果
  console.log('\n════════════════════════════════════════');
  console.log(`[smoke] 原始 ANSI 长度: ${result.rawLen}`);
  console.log('════════════════════════════════════════');
  console.log('[smoke] 最终可见屏幕(还原后):');
  console.log('────────────────────────────────────────');
  console.log(result.screen);
  console.log('────────────────────────────────────────');

  // 6. 基本判断:屏幕里是否出现输入文本或 mock 回复
  const hasInput = result.screen.includes(inputText) || result.raw.includes(inputText);
  // mock echo-text 回复 "你好，验收链路已打通。"
  const mockReply = '验收链路已打通';
  const hasReply = result.screen.includes(mockReply) || result.raw.includes(mockReply);

  console.log(`\n[smoke] 屏幕含输入文本"${inputText}": ${hasInput ? 'YES' : 'NO'}`);
  console.log(`[smoke] 屏幕含 mock 回复"${mockReply}": ${hasReply ? 'YES' : 'NO'}`);
  console.log(`[smoke] HOME 目录内容:`);
  try {
    console.log(fs.readdirSync(path.join(home, '.micode')));
    const sessDir = path.join(home, '.micode', 'sessions');
    if (fs.existsSync(sessDir)) {
      console.log('  sessions:', fs.readdirSync(sessDir));
    }
  } catch (e) { console.log('  (读取失败)', e.message); }

  console.log(`\n[smoke] 链路判定: ${hasReply ? 'PASS (provider 可控 + TUI 渲染)' : 'FAIL 或需进一步排查'}`);

  process.exit(hasReply ? 0 : 1);
}

main().catch(e => { console.error('[smoke] 异常:', e); process.exit(2); });
