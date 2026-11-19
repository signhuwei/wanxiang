import { expect, test } from 'bun:test';
import { MemoryPresence, ValkeyPresence, type Presence } from '../src/presence';

async function check(presence: Presence) {
  const device = crypto.randomUUID();
  try {
    expect(await presence.get(device)).toBeNull();
    await presence.claim(device, 'old', 1_000);
    expect(await presence.get(device)).toBe('old');
    await presence.claim(device, 'new', 1_000);
    expect(await presence.refresh(device, 'old', 1_000)).toBe(false);
    await presence.release(device, 'old');
    expect(await presence.get(device)).toBe('new');
    expect(await presence.refresh(device, 'new', 1_000)).toBe(true);
    await presence.release(device, 'new');
    expect(await presence.get(device)).toBeNull();
    await presence.claim(device, 'expires', 30);
    await Bun.sleep(90);
    expect(await presence.get(device)).toBeNull();
    expect(await presence.refresh(device, 'expires', 1_000)).toBe(false);
  } finally {
    await presence.release(device, 'old');
    await presence.release(device, 'new');
    await presence.release(device, 'expires');
  }
}

test('in-memory presence expires and honors connection ownership', async () => {
  const presence = new MemoryPresence();
  try { await check(presence); }
  finally { presence.close(); }
});

const url = process.env.ONEX_TEST_VALKEY_URL;
test.skipIf(!url)('Valkey presence expires and honors connection ownership', async () => {
  const presence = new ValkeyPresence(url!, `onex:test:${crypto.randomUUID()}:`);
  try {
    await presence.connect();
    await check(presence);
  } finally {
    presence.close();
  }
});
