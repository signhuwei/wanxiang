// 幂等键生成：crypto.randomUUID() 要求安全上下文（HTTPS 或 localhost），
// 211 等内网部署用的是 http://，调用会抛 NotSupportedError。crypto.getRandomValues 没有这个限制，
// 用它拼一个格式随意但足够唯一的键即可——Idempotency-Key 只要求同一请求重试时取值相同。

export function idempotencyKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}
