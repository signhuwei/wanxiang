// 池版本的设备目标（contracts/routing-projection.md「管理端」）：发布任务汇总与目标分页。
// 目标配置与已应用配置分列；任务完成、目标已生成都不等于设备已应用。本批目标行无写操作。
import { createLedger } from './ledger.js'
import { button, el } from './panel.js'
import { formatDateTime } from './format.js'
import { TARGET_STATES, jobStatusLabel, rolloutCounts, targetReasonLabel, targetStateLabel } from './routing-format.js'

const enc = encodeURIComponent
const revisionCell = (value, missing) => Number.isSafeInteger(value) ? String(value) : missing
const timeCell = value => value ? formatDateTime(value) : '—'

export function rolloutSection(host, api, rollout, signal) {
  const node = el('section', 'rollout-targets')
  host.append(node)
  node.append(el('h3', null, '设备目标'))
  if (!rollout?.rollout_id) {
    node.append(el('p', 'empty', '该版本没有设备发布任务'))
    return
  }
  const base = '/platform/model-pool-rollouts/' + enc(rollout.rollout_id)
  const summary = el('div', 'rollout-summary'), notice = el('p', 'notice'), list = el('div')
  notice.setAttribute('role', 'status')
  node.append(summary, notice, list)
  let ledger = null, filter = null, resetting = false

  function drawSummary(data) {
    summary.replaceChildren(
      el('p', null, '池 v' + data.pool_revision + ' · 发布任务 ' + data.rollout_id + ' · 任务状态 ' + jobStatusLabel(data.job_status)
        + ' · 名册设备 ' + (Number.isSafeInteger(data.total) ? data.total : 0) + ' 台'),
      el('p', 'muted', '任务完成不等于设备已应用；已应用只看设备回执。'))
    const counts = el('div', 'rollout-counts')
    counts.setAttribute('aria-label', '目标状态计数')
    for (const [key, label, count] of rolloutCounts(data)) {
      counts.append(button(label + ' ' + count, () => setState(key), 'link'))
    }
    counts.append(button('全部', () => setState(''), 'link'))
    summary.append(counts)
  }
  function setState(state) {
    if (!filter) return
    filter.value = state
    filter.dispatchEvent(new Event('change'))
  }
  async function load() {
    summary.replaceChildren(el('p', 'muted', '正在读取发布任务…'))
    let data
    try { data = await api.get(base, { signal }) }
    catch (e) {
      if (signal?.aborted) return
      if (e.status === 404) { summary.replaceChildren(el('p', 'empty', '设备目标台账尚未开放')); return }
      summary.replaceChildren(el('p', 'error-row', e.message), button('重试', load))
      return
    }
    if (signal?.aborted) return
    drawSummary(data)
    if (ledger) { ledger.refresh(); return }
    ledger = createLedger(list, {
      title: '目标设备', searchable: false, signal, rowKey: 'key', emptyText: '没有符合条件的目标设备',
      filters: [{ key: 'state', label: '目标状态', options: [{ value: '', label: '全部状态' }, ...TARGET_STATES.map(([value, label]) => ({ value, label }))] }],
      columns: [
        { key: 'tenant_id', title: '租户' }, { key: 'user_id', title: '成员' }, { key: 'device_id', title: '设备' },
        { title: '目标配置', render: r => revisionCell(r.target_config_revision, '尚未生成') },
        { title: '已应用配置', render: r => revisionCell(r.applied_config_revision, '未应用') },
        { title: '状态', render: r => targetStateLabel(r.state) },
        { title: '原因', render: r => targetReasonLabel(r.reason) },
        { title: '最近在线', render: r => timeCell(r.last_seen_at) },
        { title: '本目标回执', render: r => timeCell(r.last_receipt_at) }
      ],
      fetchPage: async ({ filters, cursor, limit, signal: s }) => {
        try {
          const page = await api.get(base + '/targets', { params: { state: filters.state, cursor, limit }, signal: s })
          if (resetting) resetting = false
          else notice.textContent = ''
          return { ...page, items: (page.items ?? []).map(r => ({ ...r, key: r.tenant_id + '/' + r.device_id })) }
        } catch (e) {
          // 游标绑定 rollout、筛选与操作者；失效时回到第一页。
          if (cursor && e.status >= 400 && e.status < 500) {
            notice.textContent = '分页游标已失效，已回到第一页。'
            resetting = true
            setTimeout(() => ledger?.refresh(), 0)
          }
          throw e
        }
      }
    })
    filter = list.querySelector('select[aria-label="目标状态"]')
  }
  node.querySelector('h3').append(' ', button('刷新', load, 'link'))
  load()
}
