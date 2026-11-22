import { afterAll, beforeAll, expect, test } from 'bun:test';
import { request } from 'node:http';
import fixture from '../../fixtures/routing/p0-ab.json';
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

  start = performance.now();
  const stream = await call('anthropic', true, { delay: 30 });
  expect(await stream.text()).toContain('event: message_stop');
  // HTTP may buffer multiple frames in one client read. Measure the complete seven-frame stream.
  expect(performance.now() - start).toBeGreaterThanOrEqual(180);
});

test('rejects invalid controls and malformed request bodies', async () => {
  expect((await call('anthropic', false, { fault: 'typo' })).status).toBe(400);
  expect((await call('openai', false, { fault: 'disconnect' })).status).toBe(400);
  const response = await fetch(new URL('/v1/messages', server.url), { method: 'POST', body: '{' });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } });
});

test('Responses reports fixture token usage only after a complete turn', async () => {
  const { input_tokens, output_tokens, deployment_id } = fixture.wire.usage.batch[0]!;
  const model = fixture.wire.config.routes.find(route => route.deployment_id === deployment_id)!.upstream_model;
  const usage = { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens };
  const upstream = await startFakeUpstream({ port: 0, usage: { input: input_tokens, output: output_tokens } });
  const path = '/v1/responses';
  const call = (stream: boolean, fault?: string) => fetch(new URL(path, upstream.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(fault && { 'x-fake-fault': fault }) },
    body: JSON.stringify({ model, input: 'ping', stream }),
  });
  try {
    expect(upstream.requestCount(path)).toBe(0);
    const completion = await call(false);
    expect(completion.status).toBe(200);
    expect(await completion.json()).toMatchObject({ object: 'response', model, status: 'completed',
      output: [{ role: 'assistant', content: [{ type: 'output_text', text: 'Hello from OneX.' }] }],
      usage,
    });
    const streamed = await call(true);
    expect(streamed.headers.get('content-type')).toContain('text/event-stream');
    const frames = (await streamed.text()).trim().split('\n\n').map(frame => JSON.parse(frame.split('\n')[1]!.slice(6)));
    expect(frames.filter(frame => frame.type === 'response.output_text.delta').map(frame => frame.delta).join('')).toBe('Hello from OneX.');
    expect(frames.at(-1)).toMatchObject({ type: 'response.completed', response: { usage } });
    expect(upstream.requestCount(path)).toBe(2);

    // Use a single explicit HTTP connection so the client cannot transparently retry the broken response.
    const { received, failed } = await new Promise<{ received: string; failed: boolean }>((resolve, reject) => {
      const body = JSON.stringify({ model, input: 'ping', stream: true });
      const req = request(new URL(path, upstream.url), { method: 'POST', agent: false, headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-fake-fault': 'disconnect',
      } }, res => {
        let received = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { received += chunk; });
        res.once('end', () => resolve({ received, failed: false }));
        res.once('aborted', () => resolve({ received, failed: true }));
        res.once('error', () => resolve({ received, failed: true }));
      });
      req.once('error', reject);
      req.end(body);
    });
    expect(failed).toBe(true);
    expect(received).toContain('response.output_text.delta');
    expect(received).not.toContain('response.completed');
    expect(upstream.requestCount(path)).toBe(3);
  } finally { await upstream.stop(); }
});
