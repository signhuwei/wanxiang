import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startFakeUpstream } from './index';

let server: Awaited<ReturnType<typeof startFakeUpstream>>;
beforeAll(async () => { server = await startFakeUpstream({ port: 0 }); });
afterAll(async () => { await server.stop(); });

type Protocol = 'anthropic' | 'openai';
function call(protocol: Protocol, stream = false, options: { model?: string; fault?: string; delay?: number; tokens?: number } = {}) {
  const path = protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  return fetch(new URL(path, server.url), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.fault && { 'x-fake-fault': options.fault }),
      ...(options.delay !== undefined && { 'x-fake-delay-ms': String(options.delay) }),
      ...(options.tokens !== undefined && { 'x-fake-input-tokens': String(options.tokens) }),
    },
    body: JSON.stringify({ model: options.model ?? 'fake-model', stream, stream_options: { include_usage: true },
      max_tokens: 100, messages: [{ role: 'user', content: 'ping' }] }),
  });
}

for (const protocol of ['anthropic', 'openai'] as const) {
  test(`${protocol} JSON has normal completion and deterministic usage`, async () => {
    const res = await call(protocol, false, { tokens: 31 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject(protocol === 'anthropic' ? {
      type: 'message', model: 'fake-model', content: [{ type: 'text', text: 'Hello from OneX.' }],
      stop_reason: 'end_turn', usage: { input_tokens: 31, output_tokens: 5 },
    } : {
      object: 'chat.completion', model: 'fake-model', choices: [{ message: { role: 'assistant', content: 'Hello from OneX.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36 },
    });
  });

  test(`${protocol} SSE has incremental content, usage and terminal frames`, async () => {
    const res = await call(protocol, true);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const data = await res.text();
    const frames = data.trim().split('\n\n');
    const payloads = frames.map((frame) => frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
    if (protocol === 'anthropic') {
      expect(frames.map((frame) => frame.split('\n')[0])).toEqual(['message_start', 'content_block_start', 'content_block_delta',
        'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'].map((event) => `event: ${event}`));
      expect(JSON.parse(payloads[0]).message.usage.input_tokens).toBe(12);
      expect(JSON.parse(payloads[5]).usage.output_tokens).toBe(5);
    } else {
      expect(payloads.at(-1)).toBe('[DONE]');
      expect(JSON.parse(payloads.at(-2)!).usage.total_tokens).toBe(17);
    }
    expect(data).toContain('Hello ');
    expect(data).toContain('from OneX.');
  });

  test(`${protocol} fault controls yield 429/500 and a partial stream with no terminal event`, async () => {
    const limited = await call(protocol, false, { model: 'fake-429' });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await limited.json()).toMatchObject({ error: { type: 'rate_limit_error' } });
    const broken = await call(protocol, true, { model: 'fake-429', fault: '500' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ error: { type: protocol === 'anthropic' ? 'api_error' : 'server_error' } });
    const partial = await call(protocol, true, { fault: 'disconnect' });
    expect(partial.status).toBe(200);
    const reader = partial.body!.getReader();
    let received = '';
    let disconnected = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += new TextDecoder().decode(value);
      }
    } catch { disconnected = true; }
    expect(disconnected).toBe(true);
    expect(received).toContain('Hello ');
    expect(received).not.toMatch(/message_stop|\[DONE\]/);
  });
}

test('delay can be set via model name or request header and applied between frames', async () => {
  let start = performance.now();
  const json = await call('openai', false, { model: 'fake-delay-70' });
  await json.text();
  expect(performance.now() - start).toBeGreaterThanOrEqual(60);
  const stream = await call('anthropic', true, { delay: 30 });
  const reader = stream.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  start = performance.now();
  expect((await reader.read()).done).toBe(false);
  expect(performance.now() - start).toBeGreaterThanOrEqual(20);
  await reader.cancel();
});

test('rejects invalid controls and malformed request bodies', async () => {
  expect((await call('anthropic', false, { fault: 'typo' })).status).toBe(400);
  expect((await call('openai', false, { fault: 'disconnect' })).status).toBe(400);
  const response = await fetch(new URL('/v1/messages', server.url), { method: 'POST', body: '{' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
});
