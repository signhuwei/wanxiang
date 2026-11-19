import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const parts = ['Hello ', 'from OneX.'];
type Protocol = 'anthropic' | 'openai';

function integer(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw new Error('Invalid numeric fake upstream setting');
  return Number(value);
}

function json(res: ServerResponse, payload: object, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 && { 'retry-after': '1' }) });
  res.end(JSON.stringify(payload));
}

function problem(res: ServerResponse, protocol: Protocol, status: number, message: string) {
  const type = status === 429 ? 'rate_limit_error' : status === 500 ? (protocol === 'anthropic' ? 'api_error' : 'server_error') : 'invalid_request_error';
  json(res, protocol === 'anthropic' ? { type: 'error', error: { type, message } } : { error: { type, message, param: null, code: null } }, status);
}

async function sse(res: ServerResponse, frames: string[], delayMs: number, disconnectAfter?: number) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  for (const frame of frames.slice(0, disconnectAfter ?? frames.length)) {
    if (delayMs) await Bun.sleep(delayMs);
    if (res.destroyed) return;
    await new Promise<void>((resolve, reject) => res.write(frame, (error) => error ? reject(error) : resolve()));
  }
  if (disconnectAfter === undefined) res.end();
  else {
    // Give the client time to see the data before destroying the unfinished HTTP response.
    await Bun.sleep(50);
    res.destroy();
  }
}

async function readBody(req: IncomingMessage): Promise<{ model?: unknown; stream?: unknown; messages?: unknown; stream_options?: { include_usage?: unknown } }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 4 * 1024 * 1024) throw new Error('Fake request too large');
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function reply(req: IncomingMessage, res: ServerResponse) {
  const path = req.url?.split('?')[0];
  if (path !== '/v1/messages' && path !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
  const protocol: Protocol = path === '/v1/messages' ? 'anthropic' : 'openai';
  const body = await readBody(req).catch(() => null);
  if (!body || typeof body.model !== 'string' || !body.model || !Array.isArray(body.messages)
    || (body.stream !== undefined && typeof body.stream !== 'boolean')) {
    return problem(res, protocol, 400, 'Expected model, messages and optional stream');
  }
  const { model, stream = false } = body;
  const header = (name: string) => {
    const value = req.headers[name];
    if (Array.isArray(value)) throw new Error('Ambiguous fake upstream setting');
    return value;
  };
  let settings;
  try {
    const fault = header('x-fake-fault') ?? (/^fake-(429|500|disconnect)$/.exec(model)?.[1] ?? 'none');
    if (!['none', '429', '500', 'disconnect'].includes(fault) || (fault === 'disconnect' && !stream)) throw new Error('Invalid fault for request');
    settings = {
      fault,
      delay: integer(header('x-fake-delay-ms') ?? /^fake-delay-(\d+)$/.exec(model)?.[1], 0, 30_000),
      input: integer(header('x-fake-input-tokens'), 12, 1_000_000_000),
      output: integer(header('x-fake-output-tokens'), 5, 1_000_000_000),
    };
  } catch {
    return problem(res, protocol, 400, 'Invalid fake upstream controls');
  }
  const { fault, delay, input, output } = settings;
  if (delay && (!stream || fault === '429' || fault === '500')) await Bun.sleep(delay);
  if (fault === '429' || fault === '500') return problem(res, protocol, Number(fault), `Fake upstream ${fault}`);

  const id = `${protocol === 'anthropic' ? 'msg' : 'chatcmpl'}_${crypto.randomUUID()}`;
  if (protocol === 'anthropic') {
    const usage = { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const msg = { id, type: 'message', role: 'assistant', model, stop_sequence: null };
    if (!stream) return json(res, { ...msg, content: [{ type: 'text', text: parts.join('') }], stop_reason: 'end_turn', usage });
    const event = (type: string, payload: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    return sse(res, [
      event('message_start', { message: { ...msg, content: [], stop_reason: null, usage: { ...usage, output_tokens: 0 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ...parts.map((text) => event('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: output } }),
      event('message_stop'),
    ], delay, fault === 'disconnect' ? 3 : undefined);
  }

  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
  if (!stream) return json(res, { id, object: 'chat.completion', created, model, usage,
    choices: [{ index: 0, message: { role: 'assistant', content: parts.join('') }, finish_reason: 'stop' }],
  });
  const chunk = (choices: object[], extra: object = {}) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices, ...extra })}\n\n`;
  const delta = (data: object, reason: string | null = null) => chunk([{ index: 0, delta: data, finish_reason: reason }]);
  return sse(res, [
    delta({ role: 'assistant', content: '' }),
    ...parts.map((content) => delta({ content })),
    delta({}, 'stop'),
    ...(body.stream_options?.include_usage === true ? [chunk([], { usage })] : []),
    'data: [DONE]\n\n',
  ], delay, fault === 'disconnect' ? 2 : undefined);
}

export async function startFakeUpstream(options: { port?: number } = {}) {
  const hostname = '127.0.0.1';
  const server = createServer((req, res) => { void reply(req, res).catch(() => res.destroy()); });
  server.listen(options.port ?? 3456, hostname);
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No fake upstream listening address');
  return {
    url: new URL(`http://${hostname}:${address.port}`),
    async stop() {
      const stopped = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await stopped;
    },
  };
}

if (import.meta.main) {
  const server = await startFakeUpstream({ port: integer(process.env.ONEX_FAKE_UPSTREAM_PORT, 3456, 65_535) });
  console.info(`OneX fake upstream listening on ${server.url}`);
}
