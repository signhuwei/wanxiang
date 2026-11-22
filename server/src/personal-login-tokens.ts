import type { Hono } from 'hono';
import { ulid } from 'ulid';
import { ApiError, field, json, operation } from './api';
import { authenticate } from './auth';
import { day, hash, iso, randomToken } from './credentials';
import { expectRevision, pagination } from './management';
import type { Store } from './store';

type PersonalToken = {
  id: string; name: string; created_at: string; expires_at: string;
  last_used_at: string | null; revoked_at: string | null; revision: number;
};
const columns = 'id, name, created_at, expires_at, last_used_at, revoked_at, revision';
const active = 'revoked_at IS NULL AND expires_at > ?';
const activeLimit = 10;
const view = (row: PersonalToken, at: string) => ({
  ...row, actions: row.revoked_at === null && row.expires_at > at ? ['read', 'revoke'] : ['read'],
});

export function personalLoginTokenRoutes(app: Hono, store: Store, opts: { codeSecret: string; now: () => number }) {
  const { codeSecret, now } = opts;
  app.get('/v1/auth/personal-tokens', (c) => {
    const at = now();
    const s = authenticate(store, c, at);
    if (s.tenant_password_login) throw new ApiError('forbidden');
    const p = pagination(c);
    const where = 'WHERE user_id = ? AND instr(lower(name), lower(?)) > 0';
    const params = [s.user_id, p.query];
    const { n } = store.system.get<{ n: number }>(`SELECT count(*) AS n FROM personal_login_tokens ${where}`, params)!;
    const rows = store.system.all<PersonalToken>(`SELECT ${columns} FROM personal_login_tokens ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...params, p.limit, p.offset]);
    return c.json(p.page(rows.map((row) => view(row, iso(at))), n, s.kind === 'web' ? ['create_personal_token'] : []));
  });

  app.post('/v1/auth/personal-tokens', async (c) => {
    const body = await json(c);
    return store.system.write((sql) => {
      const at = now();
      const s = authenticate(store, c, at);
      if (s.kind !== 'web' || s.tenant_password_login) throw new ApiError('forbidden');
      const name = field(body.name, 'name');
      const op = operation(c, codeSecret, at, s.user_id, [name]);
      const cached = op.read(sql);
      if (cached) return cached;
      const created_at = iso(at);
      const { n } = sql.get<{ n: number }>(`SELECT count(*) AS n FROM personal_login_tokens WHERE user_id = ? AND ${active}`,
        [s.user_id, created_at])!;
      if (n >= activeLimit) throw new ApiError('conflict', { limit: activeLimit });
      const row: PersonalToken = { id: `ltok_${ulid()}`, name, created_at, expires_at: iso(at + 7 * day),
        last_used_at: null, revoked_at: null, revision: 1 };
      const token = `onex_login_${randomToken()}`;
      sql.run('INSERT INTO personal_login_tokens (id, user_id, name, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, s.user_id, name, hash(token), created_at, row.expires_at]);
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
      const s = authenticate(store, c, at);
      if (s.tenant_password_login) throw new ApiError('forbidden');
      const op = operation(c, codeSecret, at, s.user_id, [revision]);
      const cached = op.read(sql);
      if (cached) return cached;
      const row = sql.get<Pick<PersonalToken, 'revoked_at' | 'revision'>>(
        'SELECT revoked_at, revision FROM personal_login_tokens WHERE id = ? AND user_id = ?', [id, s.user_id]);
      if (!row) throw new ApiError('not_found');
      expectRevision(revision, row.revision);
      if (row.revoked_at === null) {
        sql.run('UPDATE personal_login_tokens SET revoked_at = ?, revision = revision + 1 WHERE id = ?', [iso(at), id]);
        sql.run('DELETE FROM sessions WHERE login_token_id = ?', [id]);
      }
      return op.complete(sql, { status: 204 });
    });
  });
}
