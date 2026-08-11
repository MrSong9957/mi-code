// ConPTY regression: parent Anthropic stream emits spawn_agent, remains open,
// child provider starts, then ESC aborts both requests.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { Screen } = require('./screen.cjs');

const COLS = 160;
const ROWS = 40;
const prompt = 'Use spawn_agent only. Start one explore subagent and wait for it.';
const parentOnly = process.argv.includes('--parent-only');
const skipChild = process.argv.includes('--skip-child');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timeout waiting for ${label}`);
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function main() {
  const calls = [];
  const closedModels = [];
  let childStarted = false;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const model = payload.model;
      calls.push({ model, at: Date.now() });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.on('close', () => { closedModels.push(model); });

      sse(res, 'message_start', {
        type: 'message_start',
        message: { id: `msg-${calls.length}`, model, usage: { input_tokens: 1, output_tokens: 0 } },
      });

      if (model === 'mock-parent') {
        if (parentOnly || skipChild) return; // Keep a parent-only provider request open until ESC.
        sse(res, 'content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: {} },
        });
        sse(res, 'content_block_delta', {
          type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"role":"explore","prompt":"wait for cancellation"}' },
        });
        sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        return; // Keep the parent provider request open until ESC.
      }

      if (model === 'mock-child') childStarted = true;
      // Keep the child provider request open as well. The parent and child
      // streams must both be in flight when the harness sends ESC.
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'micode-esc-subagent-'));
  fs.mkdirSync(path.join(home, '.micode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.micode', 'config.json'), JSON.stringify({
    defaultProvider: 'anthropic',
    providers: {
      anthropic: {
        apiKey: 'test-key', model: 'mock-parent', smallModel: 'mock-child', baseUrl: `http://127.0.0.1:${port}`,
      },
    },
    permissions: { mode: 'auto', rules: [{ tool: 'spawn_agent', behavior: 'allow' }] },
    language: 'en-US', theme: 'dark', spinnerVerbs: { mode: 'append', verbs: [] },
  }));

  const terminal = pty.spawn(process.execPath, [path.join(process.cwd(), 'dist', 'index.js')], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: process.cwd(),
    env: { ...process.env, USERPROFILE: home, HOME: home, FORCE_COLOR: '1', CI: 'false', CONTINUOUS_INTEGRATION: 'false' },
  });
  let raw = '';
  const screen = new Screen(COLS, ROWS);
  terminal.onData((data) => { raw += data; screen.write(data); });

  try {
    await waitFor(() => raw.includes('[Hook] Session started'), 15_000, 'TUI startup');
    terminal.write(prompt);
    await waitFor(() => raw.includes(prompt), 5_000, 'typed prompt');
    terminal.write('\r');
    if (parentOnly) {
      await waitFor(() => calls.some((call) => call.model === 'mock-parent'), 8_000, 'parent provider request');
    } else {
      await waitFor(() => childStarted, 8_000, 'child provider request');
    }
    await sleep(100);
    const callsBeforeAbort = calls.length;
    terminal.write('\x1b');
    await waitFor(
      () => closedModels.includes('mock-parent') && (parentOnly || closedModels.includes('mock-child')),
      8_000,
      parentOnly ? 'parent provider request to close' : 'both provider requests to close',
    );
    await sleep(250);
    const visible = screen.toString();
    const result = {
      callsBeforeAbort,
      callsAfterAbort: calls.length,
      closedModels,
      visible,
    };
    console.log(JSON.stringify(result, null, 2));

    const expectedCalls = parentOnly ? 1 : 2;
    if (callsBeforeAbort !== expectedCalls || calls.length !== callsBeforeAbort) throw new Error('provider calls continued after abort');
    if (visible.includes('API error') || visible.includes('Request was aborted')) throw new Error('abort rendered as API error');
    if (visible.includes('Current status: Failed')) throw new Error('abort rendered as Failed');
    if (!visible.includes('cancelled')) throw new Error('missing cancelled tool state');
    if (!visible.includes('Current status: Partially completed')) throw new Error('missing incomplete user-facing status');
  } finally {
    try { terminal.kill(); } catch {}
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
