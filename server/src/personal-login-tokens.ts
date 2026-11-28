import type { Context, Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, json, operation } from './api';
import { authenticate } from './auth';
import { day, hash, iso, randomToken } from './credentials';
import { expectRevision, pagination, tenantActor } from './management';
import type { Store } from './store';

type PersonalToken = {
  id: string; name: string; created_at: string; expires_at: string;
  last_used_at: string | null; revoked_at: string | null; revision: number; tenant_id: string | null;
};
const columns = 'id, name, created_at, expires_at, last_used_at, revoked_at, revision, tenant_id';
const active = 'revoked_at IS NULL AND expires_at > ?';
const activeLimit = 10;
const view = ({ tenant_id, ...row }: PersonalToken, at: string) => ({
  ...row, ...(tenant_id && { tenant_id }),
  actions: row.revoked_at === null && row.expires_at > at ? ['read', 'revoke'] : ['read'],
});

function tokenOwner(store: Store, c: Context, at: number) {
  const session = authenticate(store, c, at);
  if (session.tenant_password_login && session.kind !== 'web') throw new ApiError('forbidden');
  const tenantId = session.tenant_password_login ? tenantActor(store, c, at).id : null;
  const scope = tenantId ? JSON.stringify([session.user_id, tenantId]) : session.user_id;
  return { session, tenantId, scope };
}

export function personalLoginTokenRoutes(app: Hono, store: Store, opts: { codeSecret: string; now: () => number }) {
  const { codeSecret, now } = opts;
  app.get('/v1/auth/personal-tokens', (c) => {
    const at = now();
    const { session, tenantId } = tokenOwner(store, c, at);
    const p = pagination(c);
    const where = 'WHERE user_id = ? AND (? IS NULL OR tenant_id = ?) AND instr(lower(name), lower(?)) > 0';
    const params = [session.user_id, tenantId, tenantId, p.query];
    const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM personal_login_tokens ${where}`, params)!;
    const rows = store.system.all<PersonalToken>(`SELECT ${columns} FROM personal_login_tokens ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => view(row, iso(at))), n, session.kind === 'web' ? ['create_personal_token'] : []));
  });

  app.post('/v1/auth/personal-tokens', async (c) => {
    const body = await json(c);
    return store.system.write((sql) => {
      const at = now();
      const { session, tenantId, scope } = tokenOwner(store, c, at);
      if (session.kind !== 'web') throw new ApiError('forbidden');
      const name = field(body.name, 'name');
      const op = operation(c, codeSecret, at, scope, [name]);
      const cached = op.read(sql);
      if (cached) return cached;
      const created_at = iso(at);
      const { n } = sql.get<{ n: number }>(`SELECT count(*) AS n FROM personal_login_tokens WHERE user_id = ? AND ${active}`,
        [session.user_id, created_at])!;
      if (n >= activeLimit) throw new ApiError('conflict', { limit: activeLimit });
      const parentId = tenantId === null ? null : session.login_token_id;
      let expires_at = iso(at + 7 * day);
      if (parentId) {
        const parent = sql.get<{ expires_at: string }>(`SELECT expires_at FROM personal_login_tokens
          WHERE id = ? AND user_id = ? AND tenant_id = ? AND ${active}`, [parentId, session.user_id, tenantId, created_at]);
        if (!parent) throw new ApiError('unauthenticated');
        if (parent.expires_at < expires_at) expires_at = parent.expires_at;
      }
      const row: PersonalToken = { id: `ltok_${ulid()}`, name, created_at, expires_at,
        last_used_at: null, revoked_at: null, revision: 1, tenant_id: tenantId };
      const token = `onex_login_${randomToken()}`;
      sql.run(`INSERT INTO personal_login_tokens (id, user_id, name, token_hash, created_at, expires_at, tenant_id, parent_token_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [row.id, session.user_id, name, hash(token), created_at, expires_at, tenantId, parentId]);
      const payload = view(row, created_at);
      op.complete(sql, { status: 201, payload });
      return c.json({ ...payload, token }, 201);
    });
  });

  app.post('/v1/auth/personal-tokens/:id/revoke', async (c) => {
    const id = c.req.param('id');
    const { revision } = await json(c);
    return store.system.write((sql) => {
      const at = now();
      const { session, tenantId, scope } = tokenOwner(store, c, at);
      const op = operation(c, codeSecret, at, scope, [revision]);
      const cached = op.read(sql);
      if (cached) return cached;
      const row = sql.get<Pick<PersonalToken, 'revoked_at' | 'revision'>>(
        'SELECT revoked_at, revision FROM personal_login_tokens WHERE id = ? AND user_id = ? AND (? IS NULL OR tenant_id = ?)',
        [id, session.user_id, tenantId, tenantId]);
      if (!row) throw new ApiError('not_found');
      expectRevision(revision, row.revision);
      if (row.revoked_at === null) {
        const revoked = sql.all<{ id: string }>(`WITH RECURSIVE descendants(id) AS (
          SELECT ?
          UNION ALL
          SELECT t.id FROM personal_login_tokens t JOIN descendants d ON t.parent_token_id = d.id
        )
        UPDATE personal_login_tokens SET revoked_at = ?, revision = revision + 1
        WHERE revoked_at IS NULL AND id IN (SELECT id FROM descendants) RETURNING id`, [id, iso(at)]);
        for (const token of revoked) sql.run('DELETE FROM sessions WHERE login_token_id = ?', [token.id]);
      }
      return op.complete(sql, { status: 204 });
    });
  });
}
