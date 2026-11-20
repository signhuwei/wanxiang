import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { ApiError, invalid } from './api';

export async function receiveArtifact(request: Pick<Request, 'body' | 'headers'>, path: string, max: number, expected?: number) {
  const header = request.headers.get('content-length');
  const declared = header === null ? null : Number(header);
  if (!request.body || (declared !== null && (!Number.isSafeInteger(declared) || declared <= 0))) invalid('artifact');
  if (declared !== null && declared > max) throw new ApiError('too_large', { max_bytes: max });
  if (expected !== undefined && declared !== null && expected !== declared) invalid('artifact');
  const hash = createHash('sha256');
  const reader = request.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 120_000);
  let created = false;
  try {
    const file = await open(path, 'wx', 0o600);
    created = true;
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (timedOut) throw new ApiError('invalid', { fields: ['artifact'], reason: 'upload_timed_out' });
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > max) throw new ApiError('too_large', { max_bytes: max });
        if (expected !== undefined && size > expected) invalid('artifact');
        hash.update(chunk.value);
        let offset = 0;
        while (offset < chunk.value.byteLength) {
          const { bytesWritten } = await file.write(chunk.value, offset, chunk.value.byteLength - offset);
          if (bytesWritten === 0) throw new Error('Artifact write made no progress');
          offset += bytesWritten;
        }
      }
      if (size === 0 || (declared !== null && size !== declared) || (expected !== undefined && size !== expected)) invalid('artifact');
      await file.sync();
      return { size, sha256: hash.digest('hex') };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (created) await unlink(path).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}
