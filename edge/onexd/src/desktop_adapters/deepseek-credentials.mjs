// Extend the vendor's public credential provider, keeping connection secrets
// and ordinary credential storage in the original isolated native profile.
import { AsyncLocalStorage } from 'node:async_hooks'

export const name = 'onex-session-credentials'
export async function apply(ctx) {
  const { LocalCredentialProvider } = await ctx.loader.import('@deepseek-ai/dsh-credentials-local')
  const owner = new AsyncLocalStorage()
  const ref = 'ONEX_NATIVE_SESSION'
  class SessionCredentials extends LocalCredentialProvider {
    withSession(token, fn) { return owner.run(token, fn) }
    async resolve(key) {
      if (key === ref) return { value:owner.getStore() ?? 'unbound', source:'onex' }
      return super.resolve(key)
    }
    async describe(key) {
      if (key === ref) return { configured:true, source:'onex', writable:false }
      return super.describe(key)
    }
    async set(key, value) {
      if (key === ref) throw new Error('OneX supplies this session credential')
      return super.set(key, value)
    }
    async unset(key) {
      if (key === ref) throw new Error('OneX supplies this session credential')
      return super.unset(key)
    }
  }
  ctx.plugin(SessionCredentials, { dshHome:process.env.DSH_HOME })
}
