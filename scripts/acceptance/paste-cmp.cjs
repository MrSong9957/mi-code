// 对比脚本:接受 dist 路径参数,跑 bracketed paste,输出 mock 收到的 user message
// 用法: node paste-cmp.cjs <distIndexJsPath> <label>
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const DIST = process.argv[2];
const LABEL = process.argv[3] || 'unknown';
const MULTILINE = '第一行：调查 paste 问题。\n\n第二段：检测顺序和完整性。\n第三行：尾部内容XYZ。';

function startMock(reqLog) {
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cmp-'));
  const reqLog = path.join(home, 'req.log');
  fs.mkdirSync(path.join(home, '.micode'), { recursive: true });
  const server = await startMock(reqLog);
  const port = server.address().port;
  fs.writeFileSync(path.join(home, '.micode', 'config.json'), JSON.stringify({
    defaultProvider: 'openai',
    providers: { openai: { apiKey: 'test', model: 'mock-model', baseUrl: 'http://127.0.0.1:' + port + '/v1' } },
    permissions: { mode: 'auto', rules: [] },
    theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
  }));

  const p = pty.spawn(process.execPath, [DIST], {
    name: 'xterm-256color', cols: 110, rows: 36, cwd: path.dirname(DIST),
    env: { ...process.env, USERPROFILE: home, HOME: home, FORCE_COLOR: '1', CI: '' },
  });
  let raw = '';
  p.onData(d => { raw += d; });

  setTimeout(() => { p.write('\x1b[200~' + MULTILINE + '\x1b[201~'); }, 2500);
  setTimeout(() => { p.write('\r'); }, 3000);
  setTimeout(() => {
    try { p.kill(); } catch {}
    server.close();
    console.log('[' + LABEL + '] 预期 len=' + MULTILINE.length);
    try {
      const content = fs.readFileSync(reqLog, 'utf8');
      const reqs = content.split('===END===').filter(s => s.trim());
      let found = false;
      for (const r of reqs) {
        try {
          const parsed = JSON.parse(r.trim());
          for (const m of (parsed.messages || [])) {
            if (m.role === 'user') {
              found = true;
              const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
              console.log('[' + LABEL + '] mock收到 user len=' + c.length + ' 匹配? ' + (c === MULTILINE ? 'YES' : 'NO'));
              if (c !== MULTILINE) {
                console.log('  实际: ' + JSON.stringify(c.slice(0, 150)));
              }
            }
          }
        } catch {}
      }
      if (!found) console.log('[' + LABEL + '] mock 未收到任何 user message');
    } catch (e) { console.log('[' + LABEL + '] 无请求日志: ' + e.message); }
    process.exit(0);
  }, 5000);
}
main();
