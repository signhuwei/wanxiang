// contracts/desktop-releases.md：Desktop 安装包的平台管理端发布流程，和员工无登录下载入口。
// 安装包原始字节不进对象存储（那是诊断日志专用，见 object-storage.ts），而是落在 dataDir 下的私有
// 持久目录；上传完成并校验通过前，草稿的 size/sha256/artifact_path 都不改，失败或中断也不能让旧草稿
// 的已验证状态松动（见下面 putArtifact 的临时文件 + 原子改名）。
import { mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { ulid } from 'ulid';
import { ApiError, field, invalid, json, operation } from './api';
import { iso } from './credentials';
import { receiveArtifact } from './artifact-upload';
import { expectRevision, pagination, platformActor, type ManagementOptions } from './management';
import type { Store, Transaction } from './store';

// 契约只定义这两个平台组合：darwin 配 arm64 的 .pkg，windows 配 x64 的 .exe。迁移里的 CHECK 约束
// 同一件事在数据库层再挡一次（见 005_desktop_releases.sql），这里挡在请求校验，双保险。
const platforms = [['darwin', 'arm64'], ['windows', 'x64']] as const;
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const DESKTOP_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
export const DESKTOP_ARTIFACT_UPLOAD_PATH = /^\/v1\/platform\/desktop-releases\/[^/]+\/artifact$/;
export const DESKTOP_ARTIFACT_DOWNLOAD_PATH = /^\/v1\/desktop-releases\/[^/]+\/download$/;

function platform(body: Record<string, unknown>) {
  const os = field(body.os, 'os', 16);
  const arch = field(body.arch, 'arch', 16);
  if (!platforms.some(([o, a]) => o === os && a === arch)) invalid('os', 'arch');
  return { os: os as 'darwin' | 'windows', arch: arch as 'arm64' | 'x64' };
}
function version(body: Record<string, unknown>) {
  const value = field(body.version, 'version', 64);
  const match = semver.exec(value);
  if (!match || match[1]?.split('.').some(identifier => /^0\d+$/.test(identifier))) invalid('version');
  return value;
}

type ReleaseRow = { id: string; version: string; os: string; arch: string; status: string; size: number | null;
  sha256: string | null; artifact_path: string | null; published_at: string | null; revision: number };

function auditRelease(sql: Transaction, actor: string, action: 'publish' | 'unpublish', row: ReleaseRow, at: string, supersededBy?: string) {
  const { os, arch, version } = row;
  const detail = { os, arch, version, superseded_by: supersededBy };
  sql.run('INSERT INTO platform_audit (id, actor, action, target, detail_json, at) VALUES (?, ?, ?, ?, ?, ?)',
    [`aud_${ulid()}`, actor, `desktop_release.${action}`, row.id, JSON.stringify(detail), at]);
}

function releaseActions(row: Pick<ReleaseRow, 'status'>) {
  if (row.status === 'draft') return ['read', 'upload_artifact'];
  if (row.status === 'unlisted') return ['read'];
  return ['read', 'unpublish'];
}
function view(row: ReleaseRow) {
  return { id: row.id, version: row.version, os: row.os, arch: row.arch, status: row.status, size: row.size,
    sha256: row.sha256, published_at: row.published_at, revision: row.revision,
    actions: row.status === 'draft' && row.size !== null ? ['read', 'upload_artifact', 'publish'] : releaseActions(row) };
}

function artifactDir(dataDir: string) {
  const dir = join(dataDir, 'desktop-releases');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
// 两种格式的关键头部都在文件最开头几十字节内；64 KiB 足够覆盖任何真实的 DOS stub 长度，又远小于
// 整份安装包，所以校验阶段只读这一段，不把 256 MiB 的文件整个读回内存。
const HEADER_PROBE_BYTES = 64 * 1024;

async function readHeader(path: string, length: number) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** macOS installers are XAR archives: 4-byte `xar!` magic, then a fixed 28-byte header (size, version,
 * two TOC lengths, checksum algorithm) whose `toc_length_compressed` must fit inside the rest of the
 * file — a truncated or hand-crafted header would claim a TOC bigger than the upload itself.
 * Windows installers are PE/COFF `.exe` files: the DOS stub's `e_lfanew` field at offset 0x3C points to
 * the real `PE\0\0` header, which must fit in the file with enough room for a minimal COFF header.
 * NSIS's own stub is commonly 32-bit even when the packaged app is x64 — the contract is explicit that
 * this doesn't make the upload wrong, so this only checks the bytes are a well-formed PE, never that the
 * stub's machine type matches `arch`. */
function checkFormat(os: string, header: Uint8Array, size: number) {
  if (os === 'darwin') {
    if (header.length < 28 || header[0] !== 0x78 || header[1] !== 0x61 || header[2] !== 0x72 || header[3] !== 0x21) invalid('artifact');
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const headerSize = view.getUint16(4, false);
    const tocLengthCompressed = view.getBigUint64(8, false);
    if (headerSize < 28 || tocLengthCompressed <= 0n || BigInt(headerSize) + tocLengthCompressed > BigInt(size)) invalid('artifact');
    return;
  }
  if (header.length < 0x40 || header[0] !== 0x4d || header[1] !== 0x5a) invalid('artifact');
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const peOffset = view.getUint32(0x3c, true);
  // e_lfanew 本身也可能被伪造成巨大的数字；+24 (COFF 头大小) 要留在声明的文件长度内才算数。
  if (peOffset < 0x40 || peOffset + 24 > size || peOffset + 24 > header.length
    || header[peOffset] !== 0x50 || header[peOffset + 1] !== 0x45 || header[peOffset + 2] !== 0 || header[peOffset + 3] !== 0) invalid('artifact');
}

export function desktopReleaseRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  const requirePlatform = (sql: Pick<Transaction, 'get'>, userId: string) => {
    if (!sql.get('SELECT 1 FROM platform_admins WHERE user_id = ?', [userId])) throw new ApiError('forbidden');
  };

  app.get('/v1/platform/desktop-releases', (c) => {
    platformActor(store, c, opts.now());
    const p = pagination(c);
    const where = 'WHERE instr(lower(version || \' \' || os || \' \' || arch), lower(?)) > 0';
    const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM desktop_releases ${where}`, [p.query])!;
    const rows = store.system.all<ReleaseRow>(`SELECT * FROM desktop_releases ${where} ORDER BY os, arch, version LIMIT ? OFFSET ?`,
      [p.query, p.limit, p.offset]);
    return c.json(p.page(rows.map(view), n, ['create_desktop_release']));
  });

  // 管理员读详情：上传结果未知（比如连接中断，调用者不确定 PUT 是否落地）时，重新读草稿的当前修订
  // 和摘要再决定要不要重传或发布。这条和下面员工用的公开列表分开，草稿和下架版本也能读。
  app.get('/v1/platform/desktop-releases/:id', (c) => {
    platformActor(store, c, opts.now());
    const id = field(c.req.param('id'), 'id');
    const row = store.system.get<ReleaseRow>('SELECT * FROM desktop_releases WHERE id = ?', [id]);
    if (!row) throw new ApiError('not_found');
    return c.json(view(row));
  });

  app.post('/v1/platform/desktop-releases', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const actor = platformActor(store, c, at);
    const releaseVersion = version(body);
    const { os, arch } = platform(body);
    const op = operation(c, opts.codeSecret, at, actor, [releaseVersion, os, arch]);
    const result = await store.system.write((sql) => {
      requirePlatform(sql, actor);
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      if (sql.get('SELECT 1 FROM desktop_releases WHERE os = ? AND arch = ? AND version = ?', [os, arch, releaseVersion])) throw new ApiError('conflict');
      const row: ReleaseRow = { id: `dsk_${ulid()}`, version: releaseVersion, os, arch, status: 'draft', size: null, sha256: null,
        artifact_path: null, published_at: null, revision: 1 };
      sql.run(`INSERT INTO desktop_releases (id, version, os, arch, status, size, sha256, artifact_path, published_at, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, row.version, row.os, row.arch, row.status, row.size, row.sha256, row.artifact_path, row.published_at, row.revision]);
      return { response: op.complete(sql, { status: 201, payload: view(row) }), changed: true };
    });
    return result.response;
  });

  // 原始字节走 PUT，客户端以当前草稿修订重传。并发尝试各自拥有一个文件，落败的请求只能清理自己的文件。
  app.put('/v1/platform/desktop-releases/:id/artifact', async (c) => {
    const at = opts.now();
    const id = field(c.req.param('id'), 'id');
    const actor = platformActor(store, c, at);
    const rawRevision = c.req.query('revision');
    if (rawRevision === undefined || !/^\d+$/.test(rawRevision)) invalid('revision');
    const revision = Number(rawRevision);
    // Fail fast on a doomed upload (wrong draft, wrong state, stale revision) before spending the time
    // and disk to stream up to 256 MiB; the final write below re-checks the same things for real.
    const claimed = await store.system.write((sql) => {
      requirePlatform(sql, actor);
      const row = sql.get<ReleaseRow>('SELECT * FROM desktop_releases WHERE id = ?', [id]);
      if (!row) throw new ApiError('not_found');
      if (row.status !== 'draft') throw new ApiError('conflict');
      expectRevision(revision, row.revision);
      return row;
    });
    const uploadPath = join(artifactDir(opts.dataDir), `${id}-${ulid()}`);
    const tempPath = `${uploadPath}.part`;
    const finalPath = `${uploadPath}.bin`;
    const { size, sha256 } = await receiveArtifact(c.req.raw, tempPath, DESKTOP_ARTIFACT_MAX_BYTES);
    try {
      checkFormat(claimed.os, await readHeader(tempPath, Math.min(HEADER_PROBE_BYTES, size)), size);
      renameSync(tempPath, finalPath);
    } catch (error) {
      try { unlinkSync(tempPath); } catch {}
      throw error;
    }
    const result = await store.system.write((sql) => {
      requirePlatform(sql, actor);
      const row = sql.get<ReleaseRow>('SELECT * FROM desktop_releases WHERE id = ?', [id]);
      if (!row || row.status !== 'draft') throw new ApiError('conflict');
      expectRevision(revision, row.revision);
      const updated: ReleaseRow = { ...row, size, sha256, artifact_path: finalPath, revision: row.revision + 1 };
      sql.run('UPDATE desktop_releases SET size = ?, sha256 = ?, artifact_path = ?, revision = ? WHERE id = ?',
        [updated.size, updated.sha256, updated.artifact_path, updated.revision, id]);
      return { previousPath: row.artifact_path, payload: view(updated) };
    }).catch((error: unknown) => {
      try { unlinkSync(finalPath); } catch {}
      throw error;
    });
    // SQLite's outer batch transaction has committed when write() resolves.
    if (result.previousPath) {
      try { unlinkSync(result.previousPath); } catch {}
    }
    return c.json(result.payload);
  });

  app.post('/v1/platform/desktop-releases/:id/publish', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const id = field(c.req.param('id'), 'id');
    const actor = platformActor(store, c, at);
    const op = operation(c, opts.codeSecret, at, actor, [id, body.revision]);
    const result = await store.system.write((sql) => {
      requirePlatform(sql, actor);
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      const row = sql.get<ReleaseRow>('SELECT * FROM desktop_releases WHERE id = ?', [id]);
      if (!row) throw new ApiError('not_found');
      if (row.status !== 'draft' || row.size === null || row.sha256 === null) throw new ApiError('conflict');
      expectRevision(body.revision, row.revision);
      const current = sql.get<ReleaseRow>("SELECT * FROM desktop_releases WHERE os = ? AND arch = ? AND status = 'published'", [row.os, row.arch]);
      const published_at = iso(at);
      if (current) {
        sql.run("UPDATE desktop_releases SET status = 'unlisted', revision = revision + 1 WHERE id = ?", [current.id]);
        auditRelease(sql, actor, 'unpublish', current, published_at, id);
      }
      sql.run("UPDATE desktop_releases SET status = 'published', published_at = ?, revision = revision + 1 WHERE id = ?", [published_at, id]);
      const updated: ReleaseRow = { ...row, status: 'published', published_at, revision: row.revision + 1 };
      auditRelease(sql, actor, 'publish', updated, published_at);
      return { response: op.complete(sql, { status: 200, payload: view(updated) }), changed: true };
    });
    return result.response;
  });

  app.post('/v1/platform/desktop-releases/:id/unpublish', async (c) => {
    const body = await json(c);
    const at = opts.now();
    const id = field(c.req.param('id'), 'id');
    const actor = platformActor(store, c, at);
    const op = operation(c, opts.codeSecret, at, actor, [id, body.revision]);
    const result = await store.system.write((sql) => {
      requirePlatform(sql, actor);
      const cached = op.read(sql);
      if (cached) return { response: cached, changed: false };
      const row = sql.get<ReleaseRow>('SELECT * FROM desktop_releases WHERE id = ?', [id]);
      if (!row) throw new ApiError('not_found');
      if (row.status !== 'published') throw new ApiError('conflict');
      expectRevision(body.revision, row.revision);
      sql.run("UPDATE desktop_releases SET status = 'unlisted', revision = revision + 1 WHERE id = ?", [id]);
      const updated: ReleaseRow = { ...row, status: 'unlisted', revision: row.revision + 1 };
      auditRelease(sql, actor, 'unpublish', updated, iso(at));
      return { response: op.complete(sql, { status: 200, payload: view(updated) }), changed: true };
    });
    return result.response;
  });

  // 员工入口：无登录。列表和下载都只能看到当前已发布版本，不回退到历史记录（见 publish 把旧 current
  // 转 unlisted，下架同理）；两处都标 no-store，避免浏览器或中间代理把安装包或版本号缓存在本机之外。
  const publicRow = (row: Pick<ReleaseRow, 'id' | 'version' | 'os' | 'arch' | 'size' | 'sha256' | 'published_at'>) => ({
    id: row.id, version: row.version, os: row.os, arch: row.arch, size: row.size, sha256: row.sha256,
    published_at: row.published_at, download_url: `/v1/desktop-releases/${row.id}/download` });
  app.get('/v1/desktop-releases', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    const rows = store.system.all<ReleaseRow>(`SELECT * FROM desktop_releases WHERE status = 'published' ORDER BY os, arch`);
    return c.json({ items: rows.map(publicRow) });
  });
  app.get('/v1/desktop-releases/:id/download', async (c) => {
    const id = field(c.req.param('id'), 'id');
    const row = store.system.get<ReleaseRow & { artifact_path: string | null }>(
      "SELECT * FROM desktop_releases WHERE id = ? AND status = 'published'", [id]);
    if (!row || !row.artifact_path || row.size === null) throw new ApiError('not_found');
    const file = Bun.file(row.artifact_path);
    // Refuse rather than serve a wrong byte count if the file on disk ever drifted from the record
    // (e.g. hand-edited data dir) — a caller must never receive a shorter or longer download than the
    // size and sha256 it was told to expect.
    const stat = await file.stat().catch(() => null);
    if (!stat || stat.size !== row.size) throw new ApiError('not_found');
    const filename = row.os === 'darwin' ? `OneX-${row.version}-${row.arch}.pkg` : `OneX-${row.version}-${row.arch}.exe`;
    // A raw Response bypasses c.header()'s buffering, so every header this download needs (including
    // the no-store/nosniff pair the public list route sets via c.header()) is set here directly.
    return new Response(file, { status: 200, headers: {
      'content-type': row.os === 'darwin' ? 'application/x-xar' : 'application/x-msdownload',
      'content-length': String(row.size), 'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });

  // GET /download：员工落地页，静态文件由 server/web 的开发线提供；这里只负责同源路由，和
  // 其余静态资源一样走 serveStatic（见 server.ts 顶部那两条 `app.get('/', web)` 的姊妹路由）。
  const page = serveStatic({ root: `${import.meta.dir}/../web`, rewriteRequestPath: () => '/download.html' });
  app.get('/download', (c, next) => { c.header('Cache-Control', 'no-store'); return page(c, next); });
}
