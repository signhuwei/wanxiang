import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../src/desktop_adapters/deepseek-credentials.mjs'

test('overlapping native model calls resolve only their own grant', async () => {
  class LocalCredentialProvider {
    async resolve(key) { return { value:'vendor connection secret', source:key } }
  }
  let service
  const ctx = {
    loader: { async import(name) { assert.equal(name, '@deepseek-ai/dsh-credentials-local'); return { LocalCredentialProvider } } },
    plugin(Provider) { service = new Provider() },
  }
  await apply(ctx)
  const ref = 'ONEX_NATIVE_SESSION'
  let started = 0
  const gates = Promise.withResolvers()
  const resolveTurn = async token => service.withSession(token, async () => {
    if (++started === 2) gates.resolve()
    await gates.promise
    return (await service.resolve(ref)).value
  })
  assert.deepEqual(await Promise.all([resolveTurn('session-A'), resolveTurn('session-B')]), ['session-A','session-B'])
  assert.equal((await service.resolve(ref)).value, 'unbound')
  assert.deepEqual(await service.resolve('browser-connection'), { value:'vendor connection secret', source:'browser-connection' })
  await assert.rejects(service.set(ref, 'replacement'))
})
