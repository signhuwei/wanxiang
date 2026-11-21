import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type SearchInput = { query: string; limit: number };
export type SearchResult = { url: string; title: string; snippet: string };
type Target = { endpoint: string; secret: string; publicNetwork: boolean };
export type RunSearch = (target: Target, input: SearchInput) => Promise<SearchResult[]>;
const timeoutMs = 8_000;
const maxResponse = 256 * 1024;

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
  }
  const lower = address.toLowerCase();
  if (lower === '::1' || /^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(lower);
  if (mapped) {
    const a = Number.parseInt(mapped[1]!, 16), b = Number.parseInt(mapped[2]!, 16);
    return privateAddress([a >> 8, a & 255, b >> 8, b & 255].join('.'));
  }
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4 && privateAddress(lower.slice(7));
}

export function searchResults(body: unknown, limit: number): SearchResult[] {
  if (!body || typeof body !== 'object') throw new Error('invalid search result');
  const rows = (body as { results?: unknown }).results;
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('invalid search result');
  return rows.map(row => {
    if (!row || typeof row !== 'object' || typeof row.url !== 'string' || row.url.length > 2048
      || typeof row.title !== 'string' || row.title.length > 512
      || typeof row.snippet !== 'string' || row.snippet.length > 4000) throw new Error('invalid search result');
    const url = URL.parse(row.url);
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid search result URL');
    return { url: url.href, title: row.title, snippet: row.snippet };
  });
}

export class UnconfirmedSearch extends Error {}

export const runHttpSearch: RunSearch = async (target, input) => {
  const url = new URL(target.endpoint);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid search endpoint');
  const signal = AbortSignal.timeout(timeoutMs);
  const addresses = await new Promise<Awaited<ReturnType<typeof resolve>>>((ok, fail) => {
    signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    void resolve(host).then(ok, fail);
  });
  if (!addresses.length || (!target.publicNetwork && addresses.some(a => !privateAddress(a.address)))) {
    throw new Error('search egress denied');
  }

  // The supported Bun runtime's HTTP client inherits the system proxy. Use the
  // existing system curl with an explicit direct connection and pinned DNS result.
  const address = addresses[0]!;
  const pinned = address.family === 6 ? '[' + address.address + ']' : address.address;
  const config = [
    'url = ' + JSON.stringify(url.href),
    'header = ' + JSON.stringify('Authorization: Bearer ' + target.secret),
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    'data-binary = ' + JSON.stringify(JSON.stringify(input)),
  ];
  if (!isIP(host)) config.unshift('resolve = ' + JSON.stringify(host + ':' + (url.port || '443') + ':' + pinned));
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const child = Bun.spawn(['curl', '--disable', '--noproxy', '*', '--proto', '=https', '--globoff', '--silent',
    '--max-time', String(timeoutMs / 1000), '--max-filesize', String(maxResponse), '--write-out', '\n%{http_code}\n%{content_type}',
    '--config', '-'], {
    stdin: new Blob([config.join('\n') + '\n']), stdout: 'pipe', stderr: 'ignore', signal, env,
  });
  const reader = child.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > maxResponse + 512) throw new Error('search response too large');
      chunks.push(part.value);
    }
    const code = await child.exited;
    if (signal.aborted || [28, 52, 55, 56].includes(code)) throw new UnconfirmedSearch('search outcome unconfirmed');
    if (code !== 0) throw new Error('search transport failed');
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await child.exited;
    }
  }

  const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const marker = /\n([0-9]{3})\n([^\r\n]*)$/.exec(raw);
  const status = Number(marker?.[1]);
  if (!marker || status < 200 || status >= 300 || !/^application\/json(?:\s*;|$)/i.test(marker[2]!)) {
    throw new Error('search upstream failed');
  }
  const body = raw.slice(0, marker.index);
  if (Buffer.byteLength(body) > maxResponse) throw new Error('search response too large');
  return searchResults(JSON.parse(body), input.limit);
};

async function resolve(host: string) {
  const family = isIP(host);
  return family ? [{ address: host, family }] : lookup(host, { all: true });
}
