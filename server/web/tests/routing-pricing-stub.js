// 报价、汇率、可签输入倍率的 fixture 驱动接口桩（contracts/routing-pricing-and-staging.md @2c553cc）。
// 列表游标绑定 as_of：换时点翻页返回 422，与真实 Server 一致。
import fixture from '../../../tests/fixtures/routing/p0-ab.json'

const PAGE = 2
const json = (status, body) => ({ status, json: body })
const conflict = (reason, detail = {}) => json(409, { error: { code: 'conflict', message: '数据已变化', detail: { reason, ...detail } } })
const ceilDiv = (a, b) => (a + b - 1n) / b

export function pricingStub({ pool }) {
  const hour = 3600000
  const iso = t => new Date(t).toISOString()
  const now = () => Date.now()
  const s = {
    deploymentRevision: { dep_a: 4, dep_b: 2 },
    quotes: new Map([['dep_b', [1, 2].map(n => ({ quote_id: 'quote_dep_b', quote_revision: n, deployment_id: 'dep_b', deployment_revision: 2, currency: 'USD',
      tariff_scope: { kind: 'deployment' }, valid_from: iso(now() - (30 - n) * 24 * hour), valid_until: iso(now() - (29 - n) * 24 * hour),
      source: { kind: 'manual', reference: '历史合同' }, reason: '历史报价 ' + n, items: [{ dimension: 'input', rate_micro: '500000', quantity_basis: 1000000, unit: 'token' }],
      published_by: 'owner@example.test', actions: ['read'] }))]]),
    fx: new Map(), rates: new Map(), rateHead: null, rateSeq: 0, keys: new Map(), epoch: 0,
    quotePosts: [], fxPosts: [], ratePreviews: [], ratePosts: [], lastRatePreview: null, secondPages: 0,
    fail5xxNextRate: false, delayNextRatePreview: 0
  }
  const pageOf = (list, url) => {
    const asOf = url.searchParams.get('as_of')
    const cursor = url.searchParams.get('cursor')
    let offset = 0
    if (cursor) {
      const [, off, at] = cursor.match(/^c:(\d+):(.+)$/) ?? []
      if (at !== asOf) return { error: json(422, { error: { code: 'invalid', message: '请求参数无效', detail: { fields: ['cursor'] } } }) }
      offset = Number(off)
      s.secondPages += 1
    }
    return { items: list.slice(offset, offset + PAGE), next_cursor: offset + PAGE < list.length ? `c:${offset + PAGE}:${asOf}` : null }
  }
  const current = (list, at) => [...list].filter(v => v.valid_from <= at).sort((a, b) => b.valid_from.localeCompare(a.valid_from) || b.revision - a.revision)[0]
  const live = (v, at) => v && (!v.valid_until || at < v.valid_until)
  const quoteAt = (dep, at) => {
    const q = current((s.quotes.get(dep) ?? []).map(v => ({ ...v, revision: v.quote_revision })), at)
    return live(q, at) && q.deployment_revision === s.deploymentRevision[dep] ? q : null
  }
  const fxState = (cur, at) => {
    const v = current((s.fx.get(cur) ?? []).map(x => ({ ...x, revision: x.fx_revision })), at)
    return !v ? { reason: 'missing_fx' } : live(v, at) ? { fx: v } : { reason: 'fx_expired' }
  }
  function idem(key, body, make) {
    const seen = s.keys.get(key)
    if (seen) return seen.body === JSON.stringify(body) ? seen.response : conflict('idempotency_mismatch')
    const response = make()
    if (response.status === 201) s.keys.set(key, { body: JSON.stringify(body), response })
    return response
  }

  function preview(req) {
    const at = req.pricing_at ?? iso(now())
    const channels = pool().map(m => {
      const ch = { deployment_id: m.deployment_id, deployment_revision: m.deployment_revision }
      const q = quoteAt(m.deployment_id, at)
      const item = q?.items.find(i => i.dimension === 'input')
      if (!q || !item || q.deployment_revision !== m.deployment_revision) return { ...ch, amount_micro: null, input_cny_micro_per_mtok: null, reason_code: 'missing_input_quote' }
      Object.assign(ch, { quote_id: q.quote_id, quote_revision: q.quote_revision, currency: q.currency, amount_micro: item.rate_micro, quantity_basis: item.quantity_basis })
      let n = 1n, d = 1n
      if (q.currency !== 'CNY') {
        const f = fxState(q.currency, at)
        if (f.reason) return { ...ch, fx_revision: null, input_cny_micro_per_mtok: null, reason_code: f.reason }
        n = BigInt(f.fx.rate_numerator); d = BigInt(f.fx.rate_denominator)
        Object.assign(ch, { fx_revision: f.fx.fx_revision, rate_numerator: f.fx.rate_numerator, rate_denominator: f.fx.rate_denominator })
      } else Object.assign(ch, { fx_revision: null, rate_numerator: '1', rate_denominator: '1' })
      ch.input_cny_micro_per_mtok = ceilDiv(BigInt(item.rate_micro) * n * 1000000n, d * BigInt(item.quantity_basis)).toString()
      return ch
    })
    const ok = channels.filter(c => !c.reason_code)
    const status = ok.length === channels.length ? 'complete' : ok.length ? 'partial' : 'unavailable'
    const max = ok.reduce((m, c) => BigInt(c.input_cny_micro_per_mtok) > m ? BigInt(c.input_cny_micro_per_mtok) : m, -1n)
    const recommended = max < 0n ? null : Number(ceilDiv(max, 1000n) * 1000n)
    const manual = req.manual_input_multiplier_ppm ?? null
    const final = manual ?? recommended
    const needsReason = status !== 'complete' || (manual != null && manual !== recommended) || final === 0
    const publishable = final != null && (!needsReason || Boolean(req.reason))
    const canon = { expected_pool_revision: req.expected_pool_revision, expected_source_rate_key: req.expected_source_rate_key, pricing_at: at,
      manual_input_multiplier_ppm: req.manual_input_multiplier_ppm ?? null, reason: req.reason ?? null }
    const preview_basis = 'pvm_' + Bun.hash(JSON.stringify({ canon, epoch: s.epoch, pool: pool() })).toString(36)
    return { model_id: 'mdl_m', pricing_at: at, input_multiplier_basis: 'cny_1_per_mtok_input', recommended_input_multiplier_ppm: recommended,
      input_multiplier_ppm: final, input_milli_per_mtok: final == null ? null : final / 1000, calculation_status: status, channels, preview_basis,
      actions: publishable ? ['publish_input_multiplier'] : [] }
  }

  function handle(method, url, body, headers, poolRevision) {
    const path = url.pathname
    const key = headers['idempotency-key']
    let m
    if ((m = path.match(/^\/v1\/platform\/deployments\/([^/]+)\/quotes$/))) {
      const dep = m[1]
      const list = [...(s.quotes.get(dep) ?? [])].sort((a, b) => b.quote_revision - a.quote_revision)
      if (method === 'GET') {
        const p = pageOf(list, url)
        if (p.error) return p.error
        const at = url.searchParams.get('as_of')
        return json(200, { items: p.items, total: list.length, next_cursor: p.next_cursor, head_revision: list[0]?.quote_revision ?? 0,
          deployment_revision: s.deploymentRevision[dep] ?? null, applicable: at ? quoteAt(dep, at) : undefined, actions: ['publish_quote'] })
      }
      s.quotePosts.push({ key, body })
      return idem(key, body, () => {
        const head = list[0]?.quote_revision ?? 0
        if (body.expected_quote_revision !== head) return conflict('revision_changed', { current_revision: head })
        if (body.deployment_revision !== s.deploymentRevision[dep]) return conflict('quote_deployment_revision_changed')
        const q = { quote_id: 'quote_' + dep, quote_revision: head + 1, deployment_id: dep, ...body, expected_quote_revision: undefined, published_by: 'owner@example.test', actions: ['read'] }
        delete q.expected_quote_revision
        s.quotes.set(dep, [...list, q])
        s.epoch += 1
        return json(201, q)
      })
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/platform\/deployments\/([^/]+)\/quotes\/([^/]+)\/revisions\/(\d+)$/))) {
      const q = (s.quotes.get(m[1]) ?? []).find(v => v.quote_id === m[2] && v.quote_revision === Number(m[3]))
      return q ? json(200, q) : json(404, { error: { code: 'not_found', message: '不存在' } })
    }
    if (path === '/v1/platform/procurement/fx-rates') {
      if (method === 'GET') {
        const cur = url.searchParams.get('base_currency')
        const list = [...(s.fx.get(cur) ?? [])].sort((a, b) => b.fx_revision - a.fx_revision)
        const p = pageOf(list, url)
        if (p.error) return p.error
        const at = url.searchParams.get('as_of')
        const f = at ? fxState(cur, at) : null
        return json(200, { items: p.items, total: list.length, next_cursor: p.next_cursor, head_revision: list[0]?.fx_revision ?? 0,
          applicable: f?.fx ?? null, actions: ['publish_fx_rate'] })
      }
      s.fxPosts.push({ key, body })
      return idem(key, body, () => {
        const list = s.fx.get(body.base_currency) ?? []
        const head = list.reduce((x, v) => Math.max(x, v.fx_revision), 0)
        if (body.expected_fx_revision !== head) return conflict('revision_changed', { current_revision: head })
        const fx = { ...body, fx_revision: head + 1, published_by: 'owner@example.test', actions: ['read'] }
        delete fx.expected_fx_revision
        s.fx.set(body.base_currency, [...list, fx])
        s.epoch += 1
        return json(201, fx)
      })
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/platform\/procurement\/fx-rates\/([A-Z]{3})\/CNY\/revisions\/(\d+)$/))) {
      const fx = (s.fx.get(m[1]) ?? []).find(v => v.fx_revision === Number(m[2]))
      return fx ? json(200, fx) : json(404, { error: { code: 'not_found', message: '不存在' } })
    }
    if (method === 'POST' && path === '/v1/platform/models/mdl_m/input-multiplier/preview') {
      s.ratePreviews.push(body)
      if (body.expected_pool_revision !== poolRevision() || body.expected_source_rate_key !== s.rateHead) {
        return conflict('revision_changed', { current_pool_revision: poolRevision(), current_source_rate_key: s.rateHead })
      }
      return json(200, s.lastRatePreview = preview(body))
    }
    if (method === 'POST' && path === '/v1/platform/models/mdl_m/input-multiplier/revisions') {
      s.ratePosts.push({ key, body })
      if (s.fail5xxNextRate) { s.fail5xxNextRate = false; return json(502, { error: { code: 'internal', message: '网关超时' } }) }
      return idem(key, body, () => {
        if (body.expected_pool_revision !== poolRevision() || body.expected_source_rate_key !== s.rateHead) {
          return conflict('revision_changed', { current_pool_revision: poolRevision(), current_source_rate_key: s.rateHead })
        }
        const { preview_basis, ...req } = body
        const again = preview(req)
        if (!req.pricing_at || again.preview_basis !== preview_basis || !again.actions.includes('publish_input_multiplier')) return conflict('preview_stale')
        const source_rate_key = 'prate_m_' + (++s.rateSeq)
        s.rates.set(source_rate_key, { ...again, source_rate_key, status: 'available_to_sign', override_reason: req.reason ?? null, published_by: 'owner@example.test', actions: ['read'] })
        s.rateHead = source_rate_key
        return json(201, { model_id: 'mdl_m', source_rate_key, input_multiplier_basis: 'cny_1_per_mtok_input', input_multiplier_ppm: again.input_multiplier_ppm,
          input_milli_per_mtok: again.input_milli_per_mtok, status: 'available_to_sign' })
      })
    }
    if (method === 'GET' && (m = path.match(/^\/v1\/platform\/models\/mdl_m\/input-multiplier\/revisions\/([^/]+)$/))) {
      const r = s.rates.get(decodeURIComponent(m[1]))
      return r ? json(200, r) : json(404, { error: { code: 'not_found', message: '不存在' } })
    }
    return null
  }
  return {
    state: s, handle,
    modelFields: () => ({ current_source_rate_key: s.rateHead, input_multiplier_ppm: s.rateHead ? s.rates.get(s.rateHead).input_multiplier_ppm : null }),
    concurrentRate() {
      const key = 'prate_m_' + (++s.rateSeq)
      s.rates.set(key, { source_rate_key: key, input_multiplier_ppm: 2500000, input_milli_per_mtok: 2500, status: 'available_to_sign', actions: ['read'] })
      s.rateHead = key
      return key
    },
    concurrentFx(rate) {
      const list = s.fx.get('USD') ?? []
      const fx = { base_currency: 'USD', quote_currency: 'CNY', fx_revision: list.length + 1, ...rate, source: { kind: 'manual' }, reason: '另一位管理员', actions: ['read'] }
      s.fx.set('USD', [...list, fx])
      s.epoch += 1
    },
    fixture
  }
}
