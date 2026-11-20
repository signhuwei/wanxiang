// RustFS（S3 兼容）客户端：诊断日志包的唯一后端。RustFS 只绑回环，不对外；Edge 的上传和调用者的
// 下载都先到 Server 的同源路由（见 diag.ts），Server 再用这里的方法和 RustFS 对话，字节不离开本机。
// 对象读写用 Bun 1.3.5 内置的 Bun.S3Client，不手写 SigV4。它不对空 key（桶本身）签名，所以建桶单独
// 用一段窄范围、只做这一件事的 SigV4 PUT（下面的 createBucket），其余路径都不碰裸签名。
import { createHash, createHmac } from 'node:crypto';
import { S3Client, type S3File } from 'bun';

export type ObjectStorageOptions = { endpoint: string; region?: string; bucket: string; accessKeyId: string; secretAccessKey: string };

export interface ObjectStorage {
  /** 确保桶存在；重复调用是幂等的，已存在时 RustFS 返回的冲突也当作成功。 */
  ensureBucket(): Promise<void>;
  put(key: string, body: Uint8Array, type?: string): Promise<void>;
  /** 对象是否存在，用于保留期届满后核对是否真的已被清理。 */
  exists(key: string): Promise<boolean>;
  /** 拿到可下载的文件引用；调用者负责决定是否转发给调用方。 */
  file(key: string): S3File;
  /** 删除对象，保留期届满后的真清理（不是只在 API 层隐藏）。 */
  delete(key: string): Promise<void>;
}

/** 只给建桶用的最小 SigV4（query 参数签名）PUT，验证过能被真实 RustFS 接受。不用于任何对象操作。 */
async function createBucket(opts: ObjectStorageOptions) {
  const region = opts.region ?? 'us-east-1';
  const host = new URL(opts.endpoint).host;
  const now = new Date();
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const query = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${opts.accessKeyId}/${scope}`],
    ['X-Amz-Date', date],
    ['X-Amz-Expires', '30'],
    ['X-Amz-SignedHeaders', 'host'],
  ].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonicalQuery = query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const path = `/${encodeURIComponent(opts.bucket)}`;
  const canonicalRequest = ['PUT', path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope,
    createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest();
  const signature = hmac(hmac(hmac(hmac(`AWS4${opts.secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const url = `${opts.endpoint}${path}?${canonicalQuery}&X-Amz-Signature=${hmac(signature, stringToSign).toString('hex')}`;
  const response = await fetch(url, { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(5_000) });
  // 409 (BucketAlreadyOwnedByYou / BucketAlreadyExists) 视为已就位；RustFS 单租户部署下两者都安全。
  if (!response.ok && response.status !== 409) {
    throw new Error(`OneX could not create the diagnostics bucket "${opts.bucket}": HTTP ${response.status}`);
  }
}

export class RustfsObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  constructor(private readonly opts: ObjectStorageOptions) {
    this.client = new S3Client({ endpoint: opts.endpoint, region: opts.region ?? 'us-east-1',
      bucket: opts.bucket, accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey });
  }

  async ensureBucket() { await createBucket(this.opts); }

  async put(key: string, body: Uint8Array, type = 'application/x-tar') {
    await this.client.write(key, body, { type });
  }

  exists(key: string) { return this.client.exists(key); }
  file(key: string) { return this.client.file(key); }
  delete(key: string) { return this.client.delete(key); }
}

/** 测试用内存实现：不依赖真实网络，保留和 RustfsObjectStorage 一致的接口。 */
export class MemoryObjectStorage implements ObjectStorage {
  private readonly objects = new Map<string, Uint8Array>();
  async ensureBucket() {}
  async put(key: string, body: Uint8Array) {
    this.objects.set(key, body.slice());
  }
  async exists(key: string) { return this.objects.has(key); }
  file(key: string): S3File {
    const data = this.objects.get(key);
    const blob = new Blob([data ?? new Uint8Array()]);
    // Capture Blob.prototype.stream bound to this instance before Object.assign overwrites
    // `stream` on the same object; closing over `blob.stream` after the assign would recurse forever.
    const originalStream = blob.stream.bind(blob);
    return Object.assign(blob, {
      name: key, bucket: 'memory',
      slice: () => { throw new Error('not implemented'); },
      writer: () => { throw new Error('not implemented'); },
      readable: originalStream(),
      stream: () => originalStream(),
      exists: async () => data !== undefined,
      write: async () => { throw new Error('not implemented'); },
      presign: () => { throw new Error('not implemented'); },
      delete: async () => { this.objects.delete(key); },
      unlink: async () => { this.objects.delete(key); },
      stat: async () => { if (!data) throw new Error('not found'); return { size: data.length, lastModified: new Date(), etag: '', type: 'application/x-tar' }; },
    }) as unknown as S3File;
  }
  async delete(key: string) { this.objects.delete(key); }
}
