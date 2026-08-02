// scripts/acceptance/mock-openai-server.cjs
//
// 最小 OpenAI 兼容 mock server,用于 CLI 用户级验收。
//
// 物理本质:一个"按剧本念台词的假 LLM"。真实 CLI (dist/index.js) 通过 OpenAI SDK
// 发 POST /v1/chat/completions (stream:true),本 server 按 SSE 协议返回 chunk,
// 让 OpenAIStreamClient 翻译成 StreamEvent,驱动真实的 streamingQuery + 工具执行 +
// SessionStore 落盘 + TUI 渲染。
//
// 关键:只替代外部 LLM provider,不 mock Agent/工具/SessionStore/渲染层。
//
// 响应剧本:每个剧本是一组"轮次",每轮返回若干 SSE chunk。
// 通过 X-MOCK-SCRIPT 请求头选择剧本(由验收驱动器在配置里写死)。
// 当前剧本:
//   - "echo-text":单轮纯文本回复(最小链路验证)
//   - 后续场景在驱动器里扩展

const http = require('http');

const PORT = parseInt(process.env.MOCK_PORT || '0', 10) || 0;

// ── 剧本定义 ──────────────────────────────────────────────────
// 每个剧本是 round[]:每个 round 是本轮要发的所有 SSE chunk。
// server 维护 per-call 计数(按 connection / 请求顺序),第 N 次请求返回第 N 个 round。
const SCRIPTS = {
  // 最小链路:单轮纯文本
  'echo-text': [
    [
      { delta: { role: 'assistant', content: '你好' }, finish: null },
      { delta: { content: '，验收链路已打通。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ],
  ],
  // spawn_agent 正常完成:主代理调 spawn_agent 工具 → 子代理(也指向本 mock)返回文本
  // 第 1 轮(主代理):调 spawn_agent
  // 第 2 轮(子代理):纯文本总结(子代理 final turn 无工具)
  // 注意:子代理 reserveFinalTextTurn 会在 maxTurns 最后一轮强制无工具;
  //       主代理没有 reserveFinalTextTurn。需要精确控制。
  'spawn-normal': [
    // 第 1 轮(主代理):调用 spawn_agent
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'spawn_agent', arguments: '{"role":"explore","prompt":"读取文件 a.txt 的内容并总结"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    // 第 2 轮(子代理 第1轮):调 read_file
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    // 第 3 轮(子代理 第2轮 = final turn,maxSteps=2):纯文本总结
    [
      { delta: { role: 'assistant', content: '文件内容已读取：这是测试文件 a.txt。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ],
    // 第 4 轮(主代理):基于子代理总结给出最终回复
    [
      { delta: { role: 'assistant', content: '子代理已完成探索：文件内容已读取。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    ],
  ],
  // 场景 2:子代理工具成功后 provider 失败
  // 第 1 轮(主代理):调 spawn_agent
  // 第 2 轮(子代理):调 read_file(成功)
  // 第 3 轮(子代理 final turn):provider 抛 500 错误 → 触发 runSubagent catch → journal 恢复
  // 第 4 轮(主代理):基于子代理恢复的工作给出回复
  'spawn-fail-after-tool': [
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'spawn_agent', arguments: '{"role":"explore","prompt":"读取文件 a.txt 的内容并总结"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    // 第 3 轮:provider 失败(返回 HTTP 400 —— OpenAI SDK 不重试 4xx,确保失败不被重试打乱剧本)
    { error: { status: 400, body: '{"error":{"message":"provider exploded on final turn","type":"invalid_request_error"}}' } },
    // 第 4 轮(主代理):基于子代理恢复的工作回复
    [
      { delta: { role: 'assistant', content: '子代理遇到错误但已恢复部分工作：文件内容已读取。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    ],
  ],
  // 场景 4:task 工具正常完成(验证 task 路径也走 journal + envelope)
  // task 用 general 角色,默认 maxSteps=10。主代理调 task 工具。
  'task-normal': [
    // 第 1 轮(主代理):调 task 工具
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'task', arguments: '{"prompt":"读取文件 a.txt 的内容并总结"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    // 第 2 轮(task 子代理):调 read_file
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    // 第 3 轮(task 子代理):纯文本总结(end_turn)
    [
      { delta: { role: 'assistant', content: 'task 完成：文件内容是 MiCode 入口。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 10 } },
    ],
    // 第 4 轮(主代理):基于 task 结果回复
    [
      { delta: { role: 'assistant', content: '任务已通过 task 完成：文件内容已读取。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    ],
  ],
  // 场景 3:子代理工具成功但 final summary 为空
  // 第 3 轮(子代理 final turn):返回空内容(stop 但无 content)→ finalTurnSynthesized=false
  'spawn-empty-summary': [
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_1', function: { name: 'spawn_agent', arguments: '{"role":"explore","prompt":"读取文件 a.txt 的内容并总结"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    [
      {
        delta: {
          tool_calls: [{ index: 0, id: 'call_2', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
        },
        finish: null,
      },
      { delta: {}, finish: 'tool_calls' },
    ],
    // 第 3 轮:空内容(stop 但无 delta.content)→ finalTurnSynthesized=false → 触发 journal 恢复
    [
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 20, completion_tokens: 0 } },
    ],
    // 第 4 轮(主代理):基于恢复工作回复
    [
      { delta: { role: 'assistant', content: '子代理未产出总结但已恢复工作：文件内容已读取。' }, finish: null },
      { delta: {}, finish: 'stop', usage: { prompt_tokens: 30, completion_tokens: 8 } },
    ],
  ],
};

// ── SSE chunk 编码 ──────────────────────────────────────────────
function chunkToSSE(chunk) {
  const choice = {
    delta: chunk.delta || {},
    finish_reason: chunk.finish ?? null,
    index: 0,
  };
  const payload = {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    model: 'mock-model',
    choices: [choice],
  };
  if (chunk.usage) {
    payload.usage = {
      prompt_tokens: chunk.usage.prompt_tokens || 0,
      completion_tokens: chunk.usage.completion_tokens || 0,
      total_tokens: (chunk.usage.prompt_tokens || 0) + (chunk.usage.completion_tokens || 0),
    };
  }
  return `data: ${JSON.stringify(payload)}\n\n`;
}

// ── 调用计数(per-script):用于多轮剧本 ────────────────────────
const callCounters = new Map(); // scriptName -> count

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }

  // 收集 body(虽然我们按剧本顺序返回,但读 body 避免 ECONNRESET)
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    // 选剧本:进程级环境变量 MOCK_SCRIPT(由驱动器启动时传入)。
    // 主代理和子代理用同一 mock 进程,按请求顺序消费剧本的 rounds。
    const scriptName = process.env.MOCK_SCRIPT || 'echo-text';
    const rounds = SCRIPTS[scriptName] || SCRIPTS['echo-text'];

    const count = (callCounters.get(scriptName) || 0);
    callCounters.set(scriptName, count + 1);
    // 诊断日志:写文件(避免 stderr 噪音/缓冲问题)
    try { require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'mock-req.log'), `[mock] req#${count} script=${scriptName} round=${count}${(round && round.error) ? ' ERROR' : ''}\n`); } catch {}

    // 第 N 次请求返回第 N 个 round;超出则返回空 stop(兜底)
    const round = rounds[count] || [{ delta: {}, finish: 'stop' }];

    // error round:返回 HTTP 错误(模拟 provider 失败),不发 SSE
    if (round && typeof round === 'object' && !Array.isArray(round) && round.error) {
      res.writeHead(round.error.status || 500, { 'Content-Type': 'application/json' });
      res.end(round.error.body || '{"error":{"message":"mock provider failed"}}');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 逐个发 chunk(模拟流式),每个间隔 10ms
    let i = 0;
    const sendNext = () => {
      if (i >= round.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.write(chunkToSSE(round[i]));
      i++;
      setTimeout(sendNext, 10);
    };
    sendNext();
  });
});

server.listen(PORT, () => {
  const addr = server.address();
  // 输出实际端口到 stdout 供驱动器读取
  process.stdout.write(String(addr.port));
});
