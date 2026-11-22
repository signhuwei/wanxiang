# OneX fake upstream

Run `bun tests/e2e/fake-upstream/index.ts` from the repository root. The default address is `http://127.0.0.1:3456` (`ONEX_FAKE_UPSTREAM_PORT` overrides the port). Tests can use `startFakeUpstream({ port: 0, usage: { input: 10000, output: 2000 } })` for an ephemeral port and specific token counts. Use `server.requestCount(path)` to count received POSTs and `await server.stop()` to shut it down.

- Anthropic: `POST /v1/messages`
- OpenAI Chat Completions: `POST /v1/chat/completions`
- OpenAI Responses: `POST /v1/responses`

Each endpoint accepts a test `model` string and returns `Hello from OneX.` Use a `messages` array for Messages and Chat Completions, and an `input` string or array for Responses. Set `stream: true` for SSE. Chat Completions reports streaming usage when `stream_options.include_usage` is true. The Responses `response.completed` event carries usage. The streaming `disconnect` fault closes the HTTP connection after the first text delta.

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

Run `bun test tests/e2e/fake-upstream` to verify all three endpoints and their fault cases.
