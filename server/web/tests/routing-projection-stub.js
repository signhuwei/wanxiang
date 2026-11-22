// 设备目标接口桩（contracts/routing-projection.md「管理端」）：Server 落地前在浏览器拦截应答。
// 名册与状态由测试脚本推进；分页总数为过滤后总数，游标绑定 rollout 与 state，失配返回 422。
import fixture from '../../../tests/fixtures/routing/p0-ab.json'

export const STATES = ['pending', 'applied', 'rejected', 'offline', 'needs_upgrade', 'superseded']

export function rolloutStub({ rolloutId = 'rol_stub_7', poolRevision = 7, tenantId = 'ten_demo', pageSize = 2 } = {}) {
  const device = (id, extra = {}) => ({ tenant_id: tenantId, user_id: 'usr_' + id, device_id: 'dev_' + id,
    target_config_revision: 91, applied_config_revision: 90, state: 'pending', reason: null,
    last_seen_at: fixture.clock_utc, last_receipt_at: null, actions: [], ...extra })
  const state = {
    jobStatus: 'done', requests: [],
    roster: [device('lin'), device('wu', { state: 'offline', last_seen_at: '2026-11-21T22:00:00Z' }),
      device('old', { state: 'needs_upgrade', applied_config_revision: 88 }),
      device('new', { target_config_revision: null, applied_config_revision: null })]
  }
  const counts = () => Object.fromEntries(STATES.map(s => [s, state.roster.filter(r => r.state === s).length]))
  const invalid = () => ({ status: 422, json: { error: { code: 'invalid', message: '分页游标与筛选不一致', detail: { fields: ['cursor'] } } } })
  function handle(method, url) {
    const base = '/v1/platform/model-pool-rollouts/' + rolloutId
    if (method !== 'GET' || !url.pathname.startsWith('/v1/platform/model-pool-rollouts/')) return null
    if (!url.pathname.startsWith(base)) return { status: 404, json: { error: { code: 'not_found', message: '不存在' } } }
    if (url.pathname === base) {
      return { json: { rollout_id: rolloutId, model_id: 'mdl_m', pool_revision: poolRevision, total: state.roster.length, counts: counts(),
        job_status: state.jobStatus, actions: ['read'] } }
    }
    if (url.pathname !== base + '/targets') return null
    const filter = url.searchParams.get('state') ?? ''
    const cursor = url.searchParams.get('cursor')
    state.requests.push({ state: filter, cursor })
    const hits = state.roster.filter(r => !filter || r.state === filter)
    let start = 0
    if (cursor) {
      const m = cursor.match(/^c:(.*):(\d+)$/)
      if (!m || m[1] !== filter || state.breakNextCursor) { state.breakNextCursor = false; return invalid() }
      start = Number(m[2])
    }
    const end = start + pageSize
    return { json: { items: hits.slice(start, end), total: hits.length, next_cursor: end < hits.length ? 'c:' + filter + ':' + end : null, actions: [] } }
  }
  return {
    state, handle,
    // 合法成功回执：已应用推进到目标
    applied(id) { Object.assign(state.roster.find(r => r.device_id === id), { state: 'applied', applied_config_revision: 91, last_receipt_at: fixture.clock_utc }) },
    // 设备拒绝：reason 取已脱敏的 error.detail.reason，已应用保持原值
    rejected(id) {
      Object.assign(state.roster.find(r => r.device_id === id), { state: 'rejected', reason: fixture.wire.config_applied_rejected.error.detail.reason,
        last_receipt_at: fixture.clock_utc })
    },
    superseded(id) { Object.assign(state.roster.find(r => r.device_id === id), { state: 'superseded', reason: null }) }
  }
}
