import { appendFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [dir, service] = Bun.argv.slice(2);
if (!dir || !/^(server|valkey|rustfs)$/.test(service ?? '')) throw new Error('Invalid log target');
const limit = Math.floor(1_000_000_000 / 3);
let day = '';
let part = 0;
let size = 0;
let path = '';
function rotate(newDay: string) {
  const prefix = `${service}-${newDay}-`;
  const files = readdirSync(dir).filter((name) => name.startsWith(prefix) && /^\d{8}\.log$/.test(name.slice(prefix.length))).sort();
  const last = files.at(-1);
  part = last ? Number(last.slice(prefix.length, -4)) : 0;
  path = join(dir, `${prefix}${String(part).padStart(8, '0')}.log`);
  size = last ? statSync(path).size : 0;
  day = newDay;
}
function trim(incoming: number) {
  const files = readdirSync(dir).filter((name) => new RegExp(`^${service}-\\d{4}-\\d{2}-\\d{2}-\\d{8}\\.log$`).test(name)).sort()
    .map((name) => { const file = join(dir, name); return { file, bytes: statSync(file).size }; });
  let count = files.reduce((total, row) => total + row.bytes, incoming);
  for (const row of files) {
    if (count <= limit) break;
    if (row.file === path) continue;
    unlinkSync(row.file);
    count -= row.bytes;
  }
}
for await (const chunk of Bun.stdin.stream()) {
  const current = new Date().toISOString().slice(0, 10);
  if (current !== day) rotate(current);
  if (size + chunk.length > 16 * 1024 * 1024) {
    part++;
    path = join(dir, `${service}-${day}-${String(part).padStart(8, '0')}.log`);
    size = 0;
  }
  trim(chunk.length);
  appendFileSync(path, chunk, { mode: 0o600 });
  size += chunk.length;
}
