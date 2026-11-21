/** Native identity checks for the Codex Desktop qualification gateway. */
const maxTurnMetadataBytes = 4096;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function isNativeId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export interface NativeTurn {
  threadId: string;
  turnId: string;
}

export function readNativeTurn(headers: Headers): NativeTurn | undefined {
  const raw = headers.get('x-codex-turn-metadata');
  if (raw === null || Buffer.byteLength(raw) > maxTurnMetadataBytes) return;
  let metadata: unknown;
  try {
    metadata = JSON.parse(raw);
  } catch {
    return;
  }
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return;
  const { thread_id: threadId, turn_id: turnId } = metadata as Record<string, unknown>;
  if (!isNativeId(threadId) || !isNativeId(turnId)) return;
  const explicitThread = headers.get('thread-id');
  if (explicitThread !== null && explicitThread !== threadId) return;
  // The native `session_id` identifies the root of a fork. Only the actual thread may be billed.
  return { threadId, turnId };
}

type ExpectedTurn = { started: Promise<string | undefined>; resolve: (turnId?: string) => void };

export class NativeTurnBindings {
  private readonly pending = new Map<string, ExpectedTurn>();

  expect(threadId: string): () => void {
    if (!isNativeId(threadId) || this.pending.has(threadId)) throw new Error('Invalid pending native thread');
    const { promise: started, resolve } = Promise.withResolvers<string | undefined>();
    this.pending.set(threadId, { started, resolve });
    return () => {
      this.pending.delete(threadId);
      resolve(undefined);
    };
  }

  observe(threadId: unknown, turnId: unknown) {
    if (isNativeId(threadId) && isNativeId(turnId)) this.pending.get(threadId)?.resolve(turnId);
  }

  async admits(turn: NativeTurn, timeoutMs = 2_000): Promise<boolean> {
    const expected = this.pending.get(turn.threadId);
    if (!expected) return false;
    const { promise: timedOut, resolve } = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    try {
      const actual = await Promise.race([expected.started, timedOut]);
      return this.pending.get(turn.threadId) === expected && actual === turn.turnId;
    } finally {
      clearTimeout(timer);
    }
  }
}
