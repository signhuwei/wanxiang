import { describe, expect, test } from 'bun:test';
import { NativeTurnBindings, readNativeTurn } from './identity';

const root = '00000000-0000-0000-0000-000000000001';
const threadId = '00000000-0000-0000-0000-000000000002';
const turnId = '00000000-0000-0000-0000-000000000003';
const otherTurn = '00000000-0000-0000-0000-000000000004';
const metadata = (fields: Record<string, unknown>) =>
  new Headers({ 'x-codex-turn-metadata': JSON.stringify(fields) });

describe('Codex desktop native turn identity', () => {
  test('takes a fork thread and its turn exactly, ignoring root session and root turn identity', () => {
    const headers = metadata({ thread_id: threadId, turn_id: turnId, session_id: root, root_turn_id: otherTurn });
    headers.set('thread-id', threadId);
    expect(readNativeTurn(headers)).toEqual({ threadId, turnId });
    headers.set('thread-id', root);
    expect(readNativeTurn(headers)).toBeUndefined();
  });

  test('rejects missing or malformed metadata with no plain header or root fallback', () => {
    const invalid = [
      new Headers({ 'thread-id': threadId, 'session-id': root }),
      metadata({ session_id: threadId, turn_id: turnId }),
      metadata({ thread_id: threadId, root_turn_id: turnId }),
      metadata({ thread_id: threadId, turn_id: [turnId] }),
      metadata({ thread_id: threadId + ' ', turn_id: turnId }),
      metadata({ thread_id: threadId, turn_id: turnId, other: 'x'.repeat(4096) }),
      new Headers({ 'x-codex-turn-metadata': '{broken' }),
    ];
    for (const headers of invalid) expect(readNativeTurn(headers)).toBeUndefined();
  });

  test('requires an exact trusted turn at the same pending thread and rejects a retired binding', async () => {
    const bindings = new NativeTurnBindings();
    expect(await bindings.admits({ threadId, turnId })).toBe(false);
    const finish = bindings.expect(threadId);
    const request = bindings.admits({ threadId, turnId });
    bindings.observe(root, turnId);
    bindings.observe(threadId, turnId);
    expect(await request).toBe(true);
    expect(await bindings.admits({ threadId, turnId: otherTurn })).toBe(false);
    finish();
    expect(await bindings.admits({ threadId, turnId })).toBe(false);
  });

  test('bounds waiting for native evidence and permits a new turn independently', async () => {
    const bindings = new NativeTurnBindings();
    const finish = bindings.expect(threadId);
    expect(await bindings.admits({ threadId, turnId }, 10)).toBe(false);
    const pending = bindings.admits({ threadId, turnId });
    finish();
    const next = bindings.expect(threadId);
    bindings.observe(threadId, otherTurn);
    expect(await pending).toBe(false);
    expect(await bindings.admits({ threadId, turnId: otherTurn })).toBe(true);
    next();
  });
});
