// scripts/acceptance/probe-run.cjs
// 用 --require 注入错误捕获,驱动真实 dist,捕获是否静默失败
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-probe-'));
fs.mkdirSync(path.join(home, '.micode'), { recursive: true });
fs.writeFileSync(path.join(home, '.micode', 'config.json'), JSON.stringify({
  defaultProvider: 'openai',
  providers: { openai: { apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:1/v1' } },
  permissions: { mode: 'build', rules: [] },
  theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
}));
const logFile = path.join(home, 'probe.log');
const probePath = path.join(process.cwd(), 'scripts', 'acceptance', 'probe.cjs');

const p = pty.spawn(process.execPath, ['--require', probePath, path.join(process.cwd(), 'dist', 'index.js')], {
  name: 'xterm-256color', cols: 100, rows: 30, cwd: process.cwd(),
  env: { ...process.env, USERPROFILE: home, HOME: home, PROBE_LOG: logFile, CI: '', FORCE_COLOR: '1' },
});

let raw = '';
const start = Date.now();
p.onData(d => { raw += d; });
p.onExit(({ exitCode }) => {
  console.log('EXIT', exitCode, 't=' + (Date.now() - start) + 'ms');
  console.log('RAW(600):', JSON.stringify(raw.slice(0, 600)));
  console.log('=== PROBE LOG ===');
  try { console.log(fs.readFileSync(logFile, 'utf8')); } catch { console.log('(empty - no errors captured)'); }
  console.log('=== HOME contents ===');
  console.log(fs.readdirSync(path.join(home, '.micode')));
  process.exit(0);
});
setTimeout(() => { try { p.kill(); } catch {} }, 5000);
