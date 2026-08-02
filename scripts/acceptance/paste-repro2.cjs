// 复现:bracketed paste 多行 → 检查 mock server 收到的 user message
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const COLS = 110, ROWS = 36;
const MULTILINE = '第一行：调查 paste 问题。\n\n第二段：检测顺序和完整性。\n第三行：尾部内容XYZ。';

function startRecordingMock(reqLog) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        try { fs.appendFileSync(reqLog, body + '\n===END===\n'); } catch {}
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'mock', choices: [{ delta: { role: 'assistant', content: '收到' }, finish_reason: null, index: 0 }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ id: 'm', object: 'chat.completion.chunk', model: 'mock', choices: [{ delta: {}, finish_reason: 'stop', index: 0 }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, () => resolve(server));
  });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-paste-'));
  const reqLog = path.join(home, 'req.log');
  fs.mkdirSync(path.join(home, '.micode'), { recursive: true });
  const server = await startRecordingMock(reqLog);
  const port = server.address().port;
  fs.writeFileSync(path.join(home, '.micode', 'config.json'), JSON.stringify({
    defaultProvider: 'openai',
    providers: { openai: { apiKey: 'test', model: 'mock-model', baseUrl: 'http://127.0.0.1:' + port + '/v1' } },
    permissions: { mode: 'auto', rules: [] },
    theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
  }));

  const p = pty.spawn(process.execPath, [path.join(process.cwd(), 'dist', 'index.js')], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
    env: { ...process.env, USERPROFILE: home, HOME: home, FORCE_COLOR: '1', CI: '' },
  });
  let raw = '';
  p.onData(d => { raw += d; });

  setTimeout(() => { p.write('\x1b[200~' + MULTILINE + '\x1b[201~'); }, 2500);
  setTimeout(() => { p.write('\r'); }, 3000);
  setTimeout(() => {
    try { p.kill(); } catch {}
    server.close();

    console.log('=== 预期多行文本 ===');
    console.log('length=' + MULTILINE.length + ' lines=' + MULTILINE.split('\n').length);
    console.log(JSON.stringify(MULTILINE));
    console.log('\n=== 输入框渲染(最后一个 ❯ 之后) ===');
    const idx = raw.lastIndexOf('❯');
    if (idx >= 0) console.log(JSON.stringify(raw.slice(idx, idx + 300)));
    else console.log('(无 ❯)');

    console.log('\n=== mock 收到的 user messages ===');
    try {
      const content = fs.readFileSync(reqLog, 'utf8');
      const reqs = content.split('===END===').filter(s => s.trim());
      for (let i = 0; i < reqs.length; i++) {
        try {
          const parsed = JSON.parse(reqs[i].trim());
          const msgs = parsed.messages || [];
          for (const m of msgs) {
            if (m.role === 'user') {
              const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              console.log('[req' + i + '] user content len=' + c.length);
              console.log('  ' + JSON.stringify(c.slice(0, 250)));
              console.log('  完整匹配预期? ' + (c === MULTILINE || c.includes(MULTILINE) ? 'YES' : 'NO'));
            }
          }
        } catch {}
      }
    } catch (e) { console.log('(无请求日志: ' + e.message + ')'); }
    process.exit(0);
  }, 5000);
}
main();
