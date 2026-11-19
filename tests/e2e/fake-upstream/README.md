# OneX fake upstream

Requires Bun; no external dependencies or credentials. From the repository root, run `bun tests/e2e/fake-upstream/index.ts`. The default address is `http://127.0.0.1:3456` (`ONEX_FAKE_UPSTREAM_PORT` overrides the port). Tests can import and await `startFakeUpstream({ port: 0 })` to bind an ephemeral port and call `await server.stop()` to shut it down.

- Anthropic: `POST /v1/messages`
- OpenAI: `POST /v1/chat/completions`

Both accept a test `model` string and a `messages` array and return `Hello from OneX.` Set `stream: true` for SSE. To receive usage in an OpenAI stream set `stream_options: { "include_usage": true }`. Anthropic always reports usage. The streaming `disconnect` fault closes the HTTP connection after the first text delta without a terminal SSE event.

| Header | Values | Model alias (when header omitted) |
| --- | --- | --- |
| `X-Fake-Fault` | `none` (default), `429`, `500`, `disconnect` (streaming only) | `fake-429`, `fake-500`, `fake-disconnect` |
| `X-Fake-Delay-Ms` | `0`–`30000`: before JSON/error response or before each SSE frame | `fake-delay-<ms>` |
| `X-Fake-Input-Tokens` | Nonnegative integer, default `12` | — |
| `X-Fake-Output-Tokens` | Nonnegative integer, default `5` | — |

Example:

```sh
curl -N http://127.0.0.1:3456/v1/messages \
  -H 'content-type: application/json' -H 'x-fake-delay-ms: 100' \
  -d '{"model":"fake-model","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"ping"}]}'
```

Run `bun test tests/e2e/fake-upstream` for both protocols and their fault cases.
