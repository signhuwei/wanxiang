import { iso } from './credentials';
import { readPolicyHot } from './policy-data';
import type { PolicyReader } from './policy-types';
import type { Transaction } from './store';

export function sessionPermissions(sql: PolicyReader, user: string) {
  const rules = JSON.parse(readPolicyHot(sql, user)?.runtime_rules_json ?? '{}');
  return { share: rules['session.share'] === true, export: rules['session.export'] === true };
}
export function purgeExpiredContent(sql: Transaction, at: number, id?: string) {
  const clause = id === undefined ? '' : ' AND s.id=?';
  const params = id === undefined ? [iso(at)] : [iso(at), id];
  const due = sql.all<{ id: string }>(`SELECT s.id FROM agent_sessions s
    JOIN policy_effective p ON p.scope='member' AND p.subject_id=s.user_id
    WHERE s.ended_at IS NOT NULL AND s.content_purged_at IS NULL AND
    julianday(s.ended_at)+json_extract(json_extract(p.document_json,'$.hot.runtime_rules_json'),'$."session.retention_days"')
      <=julianday(?) ${clause}`, params);
  for (const row of due) {
    sql.run('DELETE FROM session_events WHERE session_id=?', [row.id]);
    sql.run('DELETE FROM session_shares WHERE session_id=?', [row.id]);
    sql.run('UPDATE agent_sessions SET content_purged_at=?,revision=revision+1 WHERE id=?', [iso(at), row.id]);
  }
  return due.length;
}
