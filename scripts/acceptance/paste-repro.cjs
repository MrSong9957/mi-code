// 复现:发送 bracketed paste 多行内容,探测 dist 各边界收到的文本
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

const COLS = 110, ROWS = 36;
const MULTILINE = '先暂停收尾和其他手动验收。按 systematic-debugging 调查这个问题。\n\n真实 TTY 复现：一次性粘贴多行提示词后，用户消息只显示部分内容且顺序异常。\n\n第二段内容用于检测顺序。';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-paste-'));
fs.mkdirSync(path.join(home, '.micode'), { recursive: true });
fs.writeFileSync(path.join(home, '.micode', 'config.json'), JSON.stringify({
  defaultProvider: 'openai',
  providers: { openai: { apiKey: 'test', model: 'mock-model', baseUrl: 'http://127.0.0.1:1/v1' } },
  permissions: { mode: 'auto', rules: [] },
  theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
}));

// probe:捕获 handleUserSubmit 的入参 + splitSubmitTracks 的输出
const probePath = path.join(process.cwd(), 'scripts', 'acceptance', 'paste-probe.cjs');
const logFile = path.join(home, 'paste.log');

const p = pty.spawn(process.execPath, ['--require', probePath, path.join(process.cwd(), 'dist', 'index.js')], {
  name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
  env: { ...process.env, USERPROFILE: home, HOME: home, FORCE_COLOR: '1', CI: '', PASTE_LOG: logFile, PASTE_EXPECTED: MULTILINE },
});
let raw = '';
p.onData(d => { raw += d; });

// 等 TUI 启动 + bracketed paste 模式开启(Ink 会发 ?2004h)
setTimeout(() => {
  // 发送 bracketed paste: \x1b[200~ <内容> \x1b[201~
  const pasteSeq = `\x1b[200~${MULTILINE}\x1b[201~`;
  p.write(pasteSeq);
}, 2500);
// 然后回车提交
setTimeout(() => { p.write('\r'); }, 3000);
setTimeout(() => {
  try { p.kill(); } catch {}
  console.log('=== RAW 末尾(看输入框渲染) ===');
  // 找最后一个输入框区域
  const idx = raw.lastIndexOf('❯');
  console.log(JSON.stringify(raw.slice(idx, idx + 400)));
  console.log('\n=== PROBE LOG(各边界文本) ===');
  try { console.log(fs.readFileSync(logFile, 'utf8')); } catch { console.log('(无 probe 日志)'); }
  process.exit(0);
}, 4500);
