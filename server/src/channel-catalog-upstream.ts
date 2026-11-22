import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const channelCapabilities = ['text', 'stream', 'function_tools', 'images', 'reasoning', 'json_schema'] as const;
type Protocol = 'openai_chat' | 'openai_responses' | 'anthropic';
export type CatalogTarget = { protocol: Protocol; base_url: string; auth: 'bearer' | 'x_api_key'; secret: string };
export type ChannelCatalogItem = { raw_model: string; context_tokens: number | null; capabilities_claim: string[];
  snapshot_claim: string | null; variant_claim: string | null };
export type CatalogResult = { status: 'succeeded' | 'partial' | 'failed'; reason: string | null; items: ChannelCatalogItem[] };
export type ProviderChannelFetch = (target: URL, headers: Headers, signal: AbortSignal) => Promise<Response>;
const timeoutMs = 25_000;
const maxResponseBytes = 8 * 1024 * 1024;
const maxPages = 100;
const maxModels = 100_000;

function usableAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 127 && !(a === 169 && b === 254) && !(a === 100 && b! >= 64 && b! <= 127) && a! < 224;
  }
  const lower = address.toLowerCase();
  return lower !== '::' && lower !== '::1' && !lower.startsWith('::ffff:') && !/^fe[89ab]/.test(lower) && !lower.startsWith('ff');
}

/** Keep credentials off argv and pin the DNS answer for the same request which sends the header. */
export const readOverHttp: ProviderChannelFetch = async (url, headers, signal) => {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !usableAddress(address))) throw new Error('destination_denied');
  const address = addresses[0]!;
  const pinned = address.family === 6 ? '[' + address.address + ']' : address.address;
  const config = ['url = ' + JSON.stringify(url.href), ...Array.from(headers, ([key, value]) => 'header = ' + JSON.stringify(key + ': ' + value))];
  if (!family) config.push('resolve = ' + JSON.stringify(host + ':' + (url.port || (url.protocol === 'https:' ? '443' : '80')) + ':' + pinned));
  const child = Bun.spawn(['curl', '--disable', '--noproxy', '*', '--proto', '=http,https', '--globoff', '--silent', '--connect-timeout', '5',
    '--max-time', '12', '--max-filesize', String(maxResponseBytes), '--write-out', '\n%{http_code}', '--config', '-'], {
    stdin: new Blob([config.join('\n') + '\n']), stdout: 'pipe', stderr: 'ignore', signal,
  });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    const reader = child.stdout.getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxResponseBytes + 4) throw new Error('response_limit');
      chunks.push(part.value);
    }
    const code = await child.exited;
    if (code === 63) throw new Error('response_limit');
    if (code === 28 || signal.aborted) throw new Error('probe_timeout');
    if (code !== 0) throw new Error('probe_unreachable');
  } finally {
    if (child.exitCode === null) { child.kill(); await child.exited; }
  }
  const bytes = Buffer.concat(chunks);
  const marker = /\n([1-5]\d\d)$/.exec(bytes.subarray(-4).toString());
  if (!marker) throw new Error('probe_unreachable');
  const status = Number(marker[1]);
  return new Response([204, 205, 304].includes(status) ? null : bytes.subarray(0, -4), { status });
};

function asLabel(value: unknown, cap: number, secret: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > cap || /[\u0000-\u001F\u007F]/u.test(value)
    || value === secret || (secret.length >= 8 && value.includes(secret))) return null;
  return value;
}

export async function limitedJson(response: Response, maxBytes = maxResponseBytes) {
  if (!response.body) throw new Error('schema_mismatch');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maxBytes) throw new Error('response_limit');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; }
  catch { throw new Error('schema_mismatch'); }
}

export async function discoverProviderCatalog(target: CatalogTarget, kind: 'connectivity' | 'discovery', send = readOverHttp): Promise<CatalogResult> {
  const catalog = new Map<string, ChannelCatalogItem>();
  const done = (reason: string | null): CatalogResult => ({ status: reason === null ? 'succeeded' : catalog.size ? 'partial' : 'failed', reason, items: [...catalog.values()] });
  const url = URL.parse(target.base_url);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return done('destination_denied');
  if (!target.secret || /[\r\n\u0000]/u.test(target.secret)) return done('missing_credential');
  const base = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  url.pathname = base + '/v1/models';
  const headers = new Headers({ Accept: 'application/json' });
  if (target.auth === 'x_api_key') headers.set('x-api-key', target.secret);
  else headers.set('Authorization', 'Bearer ' + target.secret);
  if (target.protocol === 'anthropic') headers.set('anthropic-version', '2023-06-01');
  const signal = AbortSignal.timeout(timeoutMs);
  const seen = new Set<string>();
  let incomplete = false;
  for (let page = 0; page < maxPages; page++) {
    try {
      const response = await send(url, headers, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 401) return done('credential_rejected');
        if (response.status === 403) return done('permission_denied');
        if (response.status === 404) return done('unsupported_capability');
        return done(response.status >= 300 && response.status < 400 ? 'redirect_denied' : 'upstream_error');
      }
      const body = await limitedJson(response);
      if (!Array.isArray(body?.data)) return done('schema_mismatch');
      if (kind === 'connectivity') return done(null);
      for (const raw of body.data) {
        if (!raw || typeof raw !== 'object') { incomplete = true; continue; }
        const raw_model = asLabel(raw.id, 256, target.secret);
        if (!raw_model) { incomplete = true; continue; }
        if (catalog.has(raw_model)) continue;
        if (catalog.size >= maxModels) return done('catalog_limit');
        const window = raw.context_window ?? raw.context_length ?? raw.max_model_len;
        catalog.set(raw_model, { raw_model, context_tokens: Number.isSafeInteger(window) && window > 0 ? window : null,
          capabilities_claim: Array.isArray(raw.capabilities) ? channelCapabilities.filter((capability) => raw.capabilities.includes(capability)) : [],
          snapshot_claim: asLabel(raw.model_snapshot ?? raw.snapshot, 128, target.secret),
          variant_claim: asLabel(raw.model_variant ?? raw.quantization, 128, target.secret) });
      }
      if (body.has_more !== true) return done(incomplete ? 'malformed_items' : null);
      const cursor = asLabel(body.last_id ?? body.next_cursor, 256, target.secret);
      if (!cursor || seen.has(cursor)) return done('pagination_incomplete');
      seen.add(cursor);
      url.searchParams.set(target.protocol === 'anthropic' ? 'after_id' : 'after', cursor);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      return done(signal.aborted ? 'probe_timeout' : ['probe_timeout', 'destination_denied', 'response_limit', 'schema_mismatch'].includes(reason)
        ? reason : 'probe_unreachable');
    }
  }
  return done('catalog_limit');
}
