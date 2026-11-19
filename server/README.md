# OneX Server — S0

Run from the repository root with Bun 1.3.5 or newer. Seed the data directory **before** starting the Server; S0 supports only one SQLite writer process per data directory.

```sh
bun install --cwd server --frozen-lockfile
bun run --cwd server seed owner@example.test 10 "Local OneX"
bun run --cwd server start
bun test server/test
bun run --cwd server typecheck
```

Seed prints one owner, tenant ID and invite code. Request a code with `POST /v1/auth/code`; read the six-digit code in the Server log. `POST /v1/auth/login` requires the code even when joining via invitation. Call `POST /v1/auth/select-tenant` to obtain the token used for `POST /v1/devices`. Device tokens authenticate `GET /v1/edge/ws` upgrades only. See `/v1/openapi.json` for request and response shapes.

| Environment variable | Default / use |
| --- | --- |
| `ONEX_HOST` | `127.0.0.1`; keep development login on a trusted interface |
| `ONEX_PORT` | `3000` |
| `ONEX_DATA_DIR` | `.local` relative to the Server working directory (same for seed and start) |
| `ONEX_TENANT_CACHE_SIZE` | `16` idle/active tenant database handles; pending writes can temporarily exceed it |
| `ONEX_COMMIT` | `unknown`; set the build SHA to surface it in `/v1/healthz` |
| `ONEX_AUTH_SECRET` | At least 32 characters; if unset in development, generated per process |
| `ONEX_VALKEY_URL` | `redis://127.0.0.1:6379` if running local Valkey; otherwise dev/test use in-memory presence |

Bun's built-in `RedisClient` avoids another dependency and supports the RESP commands needed here. Valkey stores one TTL-bound connection ID per device. Refresh and release only affect that connection's own record. Set `ONEX_TEST_VALKEY_URL` to an isolated Valkey instance to enable the optional test in `server/test/presence.test.ts`. `NODE_ENV=production` requires explicit Valkey and auth secret configuration and disables code issuance: email/SMS delivery is not part of S0. Do not expose the development code logger to an untrusted network.

Session and device tokens are stored as hashes. For successful `Idempotency-Key` retries the Server rebuilds the original token from a random nonce and the auth secret, without storing the plaintext token. Keep the secret stable across process restarts if retries should survive them. Records expire after 10 minutes on the OTP endpoints and one day otherwise. Codes expire after 10 minutes, allow five attempts and can be requested once per target per minute. Web sessions last one day and desktop sessions seven days. Accepted device handshakes and ongoing heartbeats slide the device token's 30-day expiry.

S0's WS gateway implements `hello` / `welcome`, replacement and heartbeats. `ack_seq` is `0` until S1 implements ingestion; no configuration, secrets or leases are sent in S0.
