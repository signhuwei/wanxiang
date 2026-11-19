import { RedisClient } from 'bun';

export interface Presence {
  claim(deviceId: string, connectionId: string, ttlMs: number): Promise<void>;
  refresh(deviceId: string, connectionId: string, ttlMs: number): Promise<boolean>;
  release(deviceId: string, connectionId: string): Promise<void>;
  get(deviceId: string): Promise<string | null>;
  close?(): void;
}

export class MemoryPresence implements Presence {
  private entries = new Map<string, { connectionId: string; expires: number; timer: ReturnType<typeof setTimeout> }>();

  async claim(deviceId: string, connectionId: string, ttlMs: number) {
    const current = this.entries.get(deviceId);
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(() => { this.entries.delete(deviceId); }, ttlMs);
    timer.unref();
    this.entries.set(deviceId, { connectionId, expires: Date.now() + ttlMs, timer });
  }
  async refresh(deviceId: string, connectionId: string, ttlMs: number) {
    const current = this.entries.get(deviceId);
    if (!current || current.expires <= Date.now() || current.connectionId !== connectionId) return false;
    await this.claim(deviceId, connectionId, ttlMs);
    return true;
  }
  async release(deviceId: string, connectionId: string) {
    const current = this.entries.get(deviceId);
    if (current?.connectionId !== connectionId) return;
    clearTimeout(current.timer);
    this.entries.delete(deviceId);
  }
  async get(deviceId: string) {
    const current = this.entries.get(deviceId);
    return current && current.expires > Date.now() ? current.connectionId : null;
  }
  close() {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
  }
}

export class ValkeyPresence implements Presence {
  private client: RedisClient;
  constructor(url: string, private prefix = 'onex:presence:') {
    this.client = new RedisClient(url, { connectionTimeout: 2_000, enableOfflineQueue: false });
  }
  async connect() { await this.client.connect(); }
  async claim(deviceId: string, connectionId: string, ttlMs: number) {
    await this.client.set(this.prefix + deviceId, connectionId, 'PX', ttlMs);
  }
  async refresh(deviceId: string, connectionId: string, ttlMs: number) {
    const result = await this.client.send('EVAL', [
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
      '1', this.prefix + deviceId, connectionId, String(ttlMs),
    ]);
    return Number(result) === 1;
  }
  async release(deviceId: string, connectionId: string) {
    await this.client.send('EVAL', [
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
      '1', this.prefix + deviceId, connectionId,
    ]);
  }
  get(deviceId: string) { return this.client.get(this.prefix + deviceId); }
  close() { this.client.close(); }
}
