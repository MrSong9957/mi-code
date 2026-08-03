// Task 4 fix: 真实 DirectProviderTextClient adapter 接线
//
// 设计输入：§7.3 PermissionClassifierProvider 边界。
// 计划 Task 4 Step 6：现有 Anthropic/OpenAI/Google adapter 必须实现 completeText，
// 提供 adapter-owned 静态 classifier capability，不经过 streamingQuery/Agent/tool registry。
//
// 本测试验证三个 stream-client 真实实现了 DirectProviderTextClient.completeText
// 并提供静态 classifier capabilities。使用 SDK mock 验证：
//   - completeText 发一次非流式底层请求（不经 streamingQuery）；
//   - request 不含 tools；
//   - 返回 raw text（不 trim、不解析 ALLOW/FLAG）；
//   - 传 reasoning/maxOutputTokens/temperature（capability 支持时）；
//   - signal 贯穿底层请求；
//   - classifierProviderFromClass 真实包装 adapter 成 PermissionClassifierProvider。
import { describe, test, expect, vi } from 'vitest';
import type { DirectProviderTextClient } from '../../permission/classifier-provider.js';

// ─── helpers：构造 mock SDK response ────────────────────────────────────────────

/**
 * 动态导入 stream-client（避免在未配置 API key 时构造失败）。
 * 构造时注入 mock SDK client。
 */

describe('Anthropic stream-client implements DirectProviderTextClient', () => {
  test('completeText sends one non-streaming messages.create without tools and returns raw text', async () => {
    const { AnthropicStreamClient } = await import('../../agent/anthropic-stream-client.js');
    // mock SDK: messages.create 返回非流式 response
    const mockCreate = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ALLOW\nextra' }],
    });
    const client = new AnthropicStreamClient({
      apiKey: 'test-key',
      model: 'claude-test',
    });
    // 替换底层 SDK client 的 messages.create
    (client as unknown as { client: { messages: { create: typeof mockCreate } } }).client.messages.create = mockCreate;

    // AnthropicStreamClient 必须实现 DirectProviderTextClient
    const textClient: DirectProviderTextClient = client as unknown as DirectProviderTextClient;
    expect(typeof textClient.completeText).toBe('function');

    const controller = new AbortController();
    const raw = await textClient.completeText({
      model: { providerId: 'anthropic', modelId: 'claude-test' },
      systemPrompt: 'sys',
      prompt: 'p',
      signal: controller.signal,
    });
    // 返回 raw text（含额外文本，不 trim/不解析）
    expect(raw).toBe('ALLOW\nextra');
    // 发了一次底层请求
    expect(mockCreate).toHaveBeenCalledOnce();
    const callArg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    // 不含 tools
    expect(callArg.tools).toBeUndefined();
    // 非流式
    expect(callArg.stream).toBe(false);
    // signal 贯穿（第二参数）
    const callOpts = mockCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(callOpts.signal).toBe(controller.signal);
  });

  test('completeText passes reasoning/maxOutputTokens when supported', async () => {
    const { AnthropicStreamClient } = await import('../../agent/anthropic-stream-client.js');
    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'FLAG' }] });
    const client = new AnthropicStreamClient({ apiKey: 'k', model: 'm' });
    (client as unknown as { client: { messages: { create: typeof mockCreate } } }).client.messages.create = mockCreate;
    const textClient = client as unknown as DirectProviderTextClient;
    await textClient.completeText({
      model: { providerId: 'anthropic', modelId: 'm' },
      systemPrompt: 's',
      prompt: 'p',
      signal: new AbortController().signal,
      reasoning: 'disabled',
      maxOutputTokens: 2,
      temperature: 0,
    });
    const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.max_tokens).toBe(2);
    expect(arg.temperature).toBe(0);
  });

  test('provides static classifier capabilities', async () => {
    const { AnthropicStreamClient } = await import('../../agent/anthropic-stream-client.js');
    const client = new AnthropicStreamClient({ apiKey: 'k', model: 'm' });
    const caps = (client as unknown as { classifierCapabilities(): unknown }).classifierCapabilities();
    expect(caps).toMatchObject({ reasoningControl: expect.any(Boolean), decodingControl: expect.any(Boolean) });
  });
});

describe('OpenAI stream-client implements DirectProviderTextClient', () => {
  test('completeText sends one non-streaming chat.completions.create and returns raw text', async () => {
    const { OpenAIStreamClient } = await import('../../agent/openai-stream-client.js');
    const mockCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'DENY' } }],
    });
    const client = new OpenAIStreamClient({ apiKey: 'test-key', model: 'gpt-test' });
    (client as unknown as { client: { chat: { completions: { create: typeof mockCreate } } } }).client.chat.completions.create = mockCreate;
    const textClient = client as unknown as DirectProviderTextClient;
    const raw = await textClient.completeText({
      model: { providerId: 'openai', modelId: 'gpt-test' },
      systemPrompt: 's',
      prompt: 'p',
      signal: new AbortController().signal,
    });
    expect(raw).toBe('DENY');
    expect(mockCreate).toHaveBeenCalledOnce();
    const arg = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.stream).toBe(false);
    expect(arg.tools).toBeUndefined();
  });
});

describe('Google stream-client implements DirectProviderTextClient', () => {
  test('completeText sends one non-streaming generateContent and returns raw text', async () => {
    const { GoogleStreamClient } = await import('../../agent/google-stream-client.js');
    const mockGenerate = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'ALLOW' }] } }],
    });
    const client = new GoogleStreamClient({ apiKey: 'test-key', model: 'gemini-test' });
    (client as unknown as { client: { models: { generateContent: typeof mockGenerate } } }).client.models.generateContent = mockGenerate;
    const textClient = client as unknown as DirectProviderTextClient;
    const raw = await textClient.completeText({
      model: { providerId: 'google', modelId: 'gemini-test' },
      systemPrompt: 's',
      prompt: 'p',
      signal: new AbortController().signal,
    });
    expect(raw).toBe('ALLOW');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });
});

// ─── classifierProviderFromClass：真实包装 adapter 成 PermissionClassifierProvider ─

describe('classifierProviderFromClass wraps real adapter', () => {
  test('wraps an adapter implementing DirectProviderTextClient into PermissionClassifierProvider', async () => {
    const { classifierProviderFromTextClient } = await import('../../permission/classifier-provider.js');
    const { AnthropicStreamClient } = await import('../../agent/anthropic-stream-client.js');
    const mockCreate = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ALLOW' }] });
    const client = new AnthropicStreamClient({ apiKey: 'k', model: 'm' });
    (client as unknown as { client: { messages: { create: typeof mockCreate } } }).client.messages.create = mockCreate;
    const provider = classifierProviderFromTextClient(client as unknown as DirectProviderTextClient);
    expect(provider.capabilities).toBeDefined();
    const raw = await provider.invoke({
      stage: 1,
      model: { providerId: 'anthropic', modelId: 'm' },
      prefix: 'p',
      instruction: 's',
      signal: new AbortController().signal,
    });
    expect(raw).toBe('ALLOW');
    // 真实调用底层 SDK（mockCreate 被调用）
    expect(mockCreate).toHaveBeenCalledOnce();
  });
});
