import { Database } from 'bun:sqlite';
import { DuckDBConnection } from '@duckdb/node-api';

type Snapshot = { operation: 'snapshot'; database: string; output: string; start: string; end: string };
type Query = { operation: 'query'; snapshot: string; from: string; to: string; agent: string | null; people: string[] | null; output?: string };
type Fact = { day: string; user_id: string; agent: string } & Record<Metric, number>;
const metrics = ['sessions', 'events', 'turns', 'requests', 'input_tokens', 'output_tokens', 'cached_tokens', 'cost_milli', 'pending_usage'] as const;
type Metric = typeof metrics[number];
const sums = metrics.map(name => `coalesce(sum(${name}), 0)::DOUBLE AS ${name}`).join(', ');
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

function facts(input: Snapshot) {
  const db = new Database(input.database, { readonly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    return db.query(`WITH activity AS (
      SELECT date(s.started_at, '+8 hours') AS day, s.user_id, s.agent, count(*) AS sessions,
        0 AS events, 0 AS turns, 0 AS requests, 0 AS input_tokens, 0 AS output_tokens,
        0 AS cached_tokens, 0 AS cost_milli, 0 AS pending_usage
      FROM agent_sessions s WHERE s.started_at >= ?1 AND s.started_at < ?2 GROUP BY 1, 2, 3
      UNION ALL
      SELECT date(e.at, '+8 hours'), s.user_id, s.agent, 0, count(*),
        sum(CASE WHEN e.kind = 'user_message' AND coalesce(json_extract(e.payload_json, '$.sidechain'), 0) = 0
          AND json_extract(e.payload_json, '$.agent_id') IS NULL
          AND coalesce(json_extract(e.payload_json, '$.system_injected'), 0) = 0 THEN 1 ELSE 0 END), 0, 0, 0, 0, 0, 0
      FROM session_events e JOIN agent_sessions s ON s.id = e.session_id AND s.device_id = e.device_id
      JOIN ingest_cursors c ON c.device_id = e.device_id AND e.seq <= c.ack_seq
      WHERE e.at >= ?1 AND e.at < ?2 GROUP BY 1, 2, 3
      UNION ALL
      SELECT date(u.at, '+8 hours'), d.user_id, coalesce(s.agent, 'unknown'), 0, 0, 0, count(*),
        total(u.input_tokens), total(u.output_tokens), total(u.cache_read_tokens + u.cache_write_tokens),
        total(u.cost_milli), sum(CASE WHEN u.settlement_status <> 'reconciled' THEN 1 ELSE 0 END)
      FROM usage u JOIN devices d ON d.id = u.device_id
      LEFT JOIN agent_sessions s ON s.id = u.session_id AND s.device_id = u.device_id
      WHERE u.at >= ?1 AND u.at < ?2 GROUP BY 1, 2, 3
    ) SELECT day, user_id, agent, ${metrics.map(name => `sum(${name}) AS ${name}`).join(', ')}
      FROM activity WHERE day IS NOT NULL GROUP BY 1, 2, 3`).all(input.start, input.end) as Fact[];
  } finally { db.close(); }
}

async function makeSnapshot(connection: DuckDBConnection, input: Snapshot) {
  await connection.run(`CREATE TABLE facts (day VARCHAR, user_id VARCHAR, agent VARCHAR, ${metrics.map(name => `${name} DOUBLE`).join(', ')})`);
  const appender = await connection.createAppender('facts');
  try {
    for (const row of facts(input)) {
      appender.appendVarchar(row.day);
      appender.appendVarchar(row.user_id);
      appender.appendVarchar(row.agent);
      for (const name of metrics) appender.appendDouble(row[name]);
      appender.endRow();
    }
    appender.flushSync();
  } finally { appender.closeSync(); }
  await connection.run(`COPY facts TO ${sqlString(input.output)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  return {};
}

async function summarize(connection: DuckDBConnection, input: Query) {
  // These values arrive through the private worker invocation. Bind filter values so membership
  // IDs and model labels never become SQL, including when constructing an export.
  await connection.run(`CREATE TEMP TABLE scoped AS SELECT * FROM read_parquet($snapshot)
    WHERE day >= $day_start AND day <= $day_end AND ($agent IS NULL OR agent = $agent)
      AND ($people IS NULL OR user_id IN (SELECT unnest(from_json($people, '["VARCHAR"]'))))`,
    { snapshot: input.snapshot, day_start: input.from, day_end: input.to, agent: input.agent, people: input.people && JSON.stringify(input.people) });
  const aggregate = (by: 'day' | 'agent') => `SELECT ${by}, count(DISTINCT user_id)::DOUBLE AS active_people, ${sums} FROM scoped GROUP BY ${by} ORDER BY ${by}`;
  if (input.output) {
    await connection.run(`COPY (SELECT day, agent, count(DISTINCT user_id)::DOUBLE AS active_people, ${sums}
      FROM scoped GROUP BY day, agent ORDER BY day, agent) TO ${sqlString(input.output)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
    return {};
  }
  const [totals, daily, agents] = [
    `SELECT count(DISTINCT user_id)::DOUBLE AS active_people, ${sums} FROM scoped`, aggregate('day'), aggregate('agent'),
  ];
  const read = async (sql: string) => (await connection.runAndReadAll(sql)).getRowObjectsJson();
  return { totals: (await read(totals))[0], daily: await read(daily), agents: await read(agents) };
}

const command = await Bun.stdin.json() as (Snapshot | Query) & { spillDirectory: string };
const connection = await DuckDBConnection.create();
try {
  await connection.run(`SET threads=2; SET memory_limit='256MB';
    SET temp_directory=${sqlString(command.spillDirectory)}; SET max_temp_directory_size='8GiB'`);
  const result = command.operation === 'snapshot' ? await makeSnapshot(connection, command) : await summarize(connection, command);
  console.log(JSON.stringify(result));
} finally { connection.closeSync(); }
