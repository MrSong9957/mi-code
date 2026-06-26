// MCP 系统测试
import { describe, it, expect, beforeEach } from 'vitest';
import { MCPClient } from '../mcp/client.js';
import { MCPRouter } from '../mcp/router.js';
import { loadPlugins } from '../mcp/plugin-loader.js';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('MCPClient', () => {
  it('registerTools + listTools', () => {
    const client = new MCPClient('test');
    client.registerTools(
      [{ name: 'echo', description: 'Echo input', parameters: { type: 'object', properties: { msg: { type: 'string' } } } }],
      { echo: (args) => `echo: ${args.msg}` },
    );
    expect(client.listTools()).toHaveLength(1);
    expect(client.listTools()[0].name).toBe('echo');
  });

  it('callTool: 正常调用', async () => {
    const client = new MCPClient('test');
    client.registerTools(
      [{ name: 'add', description: 'Add', parameters: {} }],
      { add: (args) => String((args.a as number) + (args.b as number)) },
    );
    expect(await client.callTool('add', { a: 1, b: 2 })).toBe('3');
  });

  it('callTool: 未知工具返回错误', async () => {
    const client = new MCPClient('test');
    expect(await client.callTool('nope', {})).toContain('unknown tool');
  });

  it('callTool: handler 抛错返回错误', async () => {
    const client = new MCPClient('test');
    client.registerTools(
      [{ name: 'fail', description: 'Fail', parameters: {} }],
      { fail: () => { throw new Error('boom'); } },
    );
    expect(await client.callTool('fail', {})).toContain('MCP execution error');
  });
});

describe('MCPRouter', () => {
  let router: MCPRouter;

  beforeEach(() => {
    router = new MCPRouter();
  });

  it('registerServer + getToolDefinitions', () => {
    const client = new MCPClient('db');
    client.registerTools(
      [{ name: 'query', description: 'Run SQL', parameters: {} }],
      { query: (args) => `result: ${args.sql}` },
    );
    router.registerServer('db', client);
    const defs = router.getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('mcp__db__query');
  });

  it('execute: 路由到正确的 server', async () => {
    const client = new MCPClient('calc');
    client.registerTools(
      [{ name: 'multiply', description: 'Multiply', parameters: {} }],
      { multiply: (args) => String((args.x as number) * (args.y as number)) },
    );
    router.registerServer('calc', client);
    expect(await router.execute('mcp__calc__multiply', { x: 3, y: 4 })).toBe('12');
  });

  it('execute: 不存在的 server 返回错误', async () => {
    expect(await router.execute('mcp__ghost__tool', {})).toContain('not found');
  });

  it('execute: 无效格式返回错误', async () => {
    expect(await router.execute('bad_name', {})).toContain('invalid tool name');
  });

  it('isMCPTool: 判断是否 MCP 工具', () => {
    expect(router.isMCPTool('mcp__db__query')).toBe(true);
    expect(router.isMCPTool('run_bash')).toBe(false);
  });

  it('normalizeName: 特殊字符替换', () => {
    const client = new MCPClient('my@server');
    client.registerTools([{ name: 'tool/v2', description: 'Test', parameters: {} }], { 'tool/v2': () => 'ok' });
    router.registerServer('my@server', client);
    expect(router.getToolDefinitions()[0].name).toBe('mcp__my_server__tool_v2');
  });

  it('多个 server 合并', () => {
    const c1 = new MCPClient('db');
    c1.registerTools([{ name: 'query', description: 'SQL', parameters: {} }], { query: () => 'q' });
    const c2 = new MCPClient('browser');
    c2.registerTools([{ name: 'open', description: 'Open', parameters: {} }], { open: () => 'tab' });
    router.registerServer('db', c1);
    router.registerServer('browser', c2);
    expect(router.getToolDefinitions()).toHaveLength(2);
    expect(router.serverCount).toBe(2);
  });
});

describe('loadPlugins', () => {
  it('从 manifest 加载 server', () => {
    const dir = join(tmpdir(), `plugin-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      name: 'test', version: '1.0.0',
      mcpServers: { postgres: { command: 'npx' }, redis: { command: 'npx' } },
    }));
    const router = new MCPRouter();
    expect(loadPlugins(dir, router)).toBe(2);
    expect(router.serverCount).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('无 manifest 返回 0', () => {
    expect(loadPlugins('/nonexistent', new MCPRouter())).toBe(0);
  });
});
