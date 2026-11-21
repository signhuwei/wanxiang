/** Probe a signed Codex Desktop release's bundled native app server on an isolated profile. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNativeId, NativeTurnBindings, readNativeTurn, type NativeTurn } from './identity';
import { managedPolicy, providerId, tokenVariable } from './policy';

type Json = Record<string, unknown>;
type Message = { id?: number; method?: string; params?: Json; result?: Json; error?: { code?: number } };
type Match = (message: Message) => boolean;

class AppServer {
  private readonly child;
  private readonly inbox: Message[] = [];
  private nextId = 0;
  private signal?: () => void;
  private streamError?: unknown;
  private closed = false;

  constructor(program: string, cwd: string, env: Record<string, string>, private readonly turns: NativeTurnBindings) {
    this.child = Bun.spawn([program, 'app-server'], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
    void this.read();
  }

  private async read() {
    try {
      const reader = this.child.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const lines = (pending + value).split('\n');
        pending = lines.pop()!;
        for (const line of lines) {
          if (!line) continue;
          const message: Message = JSON.parse(line);
          if (message.method === 'turn/started') {
            this.turns.observe(message.params?.threadId, asObject(message.params?.turn)?.id);
          }
          this.inbox.push(message);
        }
        this.signal?.();
      }
    } catch (error) {
      this.streamError = error;
    } finally {
      this.closed = true;
      this.signal?.();
    }
  }

  private send(message: Message) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
    this.child.stdin.flush();
  }

  private async receive(match: Match, label: string): Promise<Message> {
    const deadline = Date.now() + 20_000;
    while (true) {
      const index = this.inbox.findIndex(match);
      if (index >= 0) return this.inbox.splice(index, 1)[0];
      if (this.streamError || this.closed) throw new Error(`App Server output ended while waiting for ${label}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`App Server timed out waiting for ${label}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, remaining);
        this.signal = finish;
        function finish() { clearTimeout(timer); resolve(); }
      });
      this.signal = undefined;
    }
  }

  async rpc(method: string, params: Json): Promise<Json> {
    const id = ++this.nextId;
    this.send({ id, method, params });
    const reply = await this.receive((message) => message.id === id, method);
    if (!reply.result || reply.error) throw new Error(`App Server rejected ${method} (${reply.error?.code ?? 'no result'})`);
    return reply.result;
  }

  async initialize() {
    await this.rpc('initialize', { clientInfo: { name: 'onex-codex-desktop-qualification', version: '1.0.0' } });
    this.send({ method: 'initialized' });
  }

  async turn(threadId: string, prompt: string) {
    const finish = this.turns.expect(threadId);
    try {
      const result = await this.rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
      const turnId = requiredId(result.turn, 'started turn');
      const completion = await this.receive((message) => message.method === 'turn/completed' &&
        message.params?.threadId === threadId && asObject(message.params?.turn)?.id === turnId, 'turn/completed');
      const status = asObject(completion.params?.turn)?.status;
      assert.equal(status, 'completed', 'Synthetic inference turn must complete');
      const answer = await this.receive((message) => message.method === 'item/completed' &&
        message.params?.threadId === threadId && message.params?.turnId === turnId &&
        asObject(message.params?.item)?.type === 'agentMessage', 'the completed assistant message');
      assert.equal(asObject(answer.params?.item)?.text, 'onex fixture answer');
      return turnId;
    } finally {
      finish();
    }
  }

  async stop() {
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
    try { await this.child.exited; } finally { clearTimeout(timer); }
  }
}

function asObject(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}

function requiredId(value: unknown, label: string): string {
  const id = asObject(value)?.id;
  assert(isNativeId(id), `Missing native UUID for ${label}`);
  return id;
}

function command(argv: string[]): string {
  const { exitCode, stdout, stderr } = Bun.spawnSync(argv, { env: { PATH: '/usr/bin:/bin' } });
  if (exitCode !== 0) throw new Error(`${argv[0]} failed (${exitCode})\n${stderr.toString().trim()}`);
  return stdout.toString().trim();
}

function signedProgram(bundle: string) {
  assert.equal(process.platform, 'darwin', 'This qualification probe requires macOS');
  const info = join(bundle, 'Contents/Info.plist');
  const bundleId = command(['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', info]);
  assert.equal(bundleId, 'com.openai.codex');
  const requirement = 'anchor apple generic and identifier "com.openai.codex" and certificate leaf[subject.OU] = "2DC432GLL2"';
  command(['/usr/bin/codesign', '--verify', '--deep', '--strict', `-R=${requirement}`, bundle]);
  const cliBundle = join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app');
  command(['/usr/bin/codesign', '--verify', '--strict', '-R=anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"', cliBundle]);
  return {
    program: join(cliBundle, 'Contents/MacOS/codex'),
    version: command(['/usr/bin/plutil', '-extract', 'CFBundleShortVersionString', 'raw', info]),
    build: command(['/usr/bin/plutil', '-extract', 'CFBundleVersion', 'raw', info]),
  };
}

function fixtureResponse(index: number, model: string): Response {
  const item = {
    type: 'message', id: `msg_onex_${index}`, role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'onex fixture answer', annotations: [] }],
  };
  const response = { id: `resp_onex_${index}`, object: 'response', model };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'onex fixture answer' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: {
      ...response, status: 'completed', output: [item], usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 },
        output_tokens: 8, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 28 },
    } },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

async function qualify(bundlePath: string, model: string) {
  const bundle = await realpath(bundlePath);
  const { program, version, build } = signedProgram(bundle);
  const root = await mkdtemp(join(tmpdir(), 'onex-codex-desktop-'));
  const codeHome = join(root, 'codex');
  const home = join(root, 'home');
  const project = join(root, 'workspace');
  const token = crypto.randomUUID();
  const turns = new NativeTurnBindings();
  const routed: Array<{ identity: NativeTurn; fixtureHistory: Set<string> }> = [];
  const denied: Array<{ route: string; reason: string }> = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const route = new URL(req.url).pathname;
    if (req.headers.get('authorization') !== `Bearer ${token}`) {
      denied.push({ route, reason: 'wrong bearer' });
      return new Response(null, { status: 401 });
    }
    if (req.method !== 'POST' || route !== '/v1/responses') {
      denied.push({ route, reason: 'wrong protocol' });
      return new Response(null, { status: 404 });
    }
    const body = asObject(await req.json());
    if (body?.model !== model) {
      denied.push({ route, reason: 'wrong model' });
      return new Response(null, { status: 403 });
    }
    const identity = readNativeTurn(req.headers);
    if (!identity || !await turns.admits(identity)) {
      denied.push({ route, reason: 'unbound native turn' });
      return new Response(null, { status: 403 });
    }
    const fixtureHistory = new Set<string>();
    for (const item of Array.isArray(body.input) ? body.input : []) {
      const message = asObject(item);
      if (message?.type !== 'message' || !Array.isArray(message.content)) continue;
      for (const content of message.content) {
        const text = asObject(content)?.text;
        if (typeof text === 'string' && text.startsWith('onex fixture ')) fixtureHistory.add(text);
      }
    }
    routed.push({ identity, fixtureHistory });
    return fixtureResponse(routed.length, model);
  } });

  let child: AppServer | undefined;
  try {
    for (const dir of [codeHome, home, project, join(root, 'tmp')]) await mkdir(dir, { mode: 0o700 });
    const policy = managedPolicy(model, new URL('/v1', server.url));
    await writeFile(join(codeHome, 'config.toml'), policy.config, { flag: 'wx', mode: 0o600 });
    const env = {
      PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codeHome, TMPDIR: join(root, 'tmp'),
      XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
      NO_PROXY: '127.0.0.1,localhost', [tokenVariable]: token,
    };
    child = new AppServer(program, project, env, turns);
    await child.initialize();
    const start = async () => {
      const result = await child!.rpc('thread/start', { cwd: project, model, modelProvider: providerId });
      return requiredId(result.thread, 'started thread');
    };
    const first = await start();
    const second = await start();
    assert.notEqual(first, second);
    const firstTurn = await child.turn(first, 'onex fixture one');
    const secondTurn = await child.turn(second, 'onex fixture two');
    const fork = await child.rpc('thread/fork', { threadId: first, lastTurnId: firstTurn, excludeTurns: true });
    const forkId = requiredId(fork.thread, 'forked thread');
    assert.notEqual(forkId, first);
    assert.notEqual(forkId, second);
    const forkTurn = await child.turn(forkId, 'onex fixture fork');
    await child.stop();
    child = new AppServer(program, project, env, turns);
    await child.initialize();
    const resumed = await child.rpc('thread/resume', { threadId: first, cwd: project, model, modelProvider: providerId });
    assert.equal(requiredId(resumed.thread, 'resumed thread'), first);
    const resumedTurn = await child.turn(first, 'onex fixture resumed');
    assert.deepEqual(denied, [], 'Unexpected request to the local fixture');
    const expected = [
      { threadId: first, turnId: firstTurn }, { threadId: second, turnId: secondTurn },
      { threadId: forkId, turnId: forkTurn }, { threadId: first, turnId: resumedTurn },
    ];
    assert.deepEqual(routed.map((request) => request.identity), expected,
      'Each native turn must make one local Responses request under its own exact identity');
    assert.deepEqual(routed[3].fixtureHistory, new Set(['onex fixture one', 'onex fixture answer', 'onex fixture resumed']),
      'Resumed request must contain only its saved thread history and the new prompt');
    console.log(JSON.stringify({
      probe: 'signed-native-app-server', version, build, model, completedTurns: routed.length,
      nativeThreadResumed: true, nativeForkUsed: true, exactTurnBinding: true,
      guiQualified: false, oneXBillingQualified: false,
    }, null, 2));
  } catch (error) {
    if (denied.length) console.error(JSON.stringify({ denied }));
    throw error;
  } finally {
    await child?.stop();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

const [bundle, model = 'onex-qualification-model'] = process.argv.slice(2);
if (!bundle) throw new Error('Usage: bun tests/e2e/codex-desktop/qualify.ts /absolute/path/Codex.app [model]');
await qualify(bundle, model);
