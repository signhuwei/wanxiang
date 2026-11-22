import { button, editForm, el } from './panel.js'
import { createPager } from './pager.js'
import { formatDateTime } from './format.js'
import { hasAction } from './policy-controls.js'
import { idempotencyKey } from './idempotency.js'
import { formatMicro } from './routing-format.js'

const adapterNames = { new_api: 'New API', sub2api: 'Sub2API' }
const statusNames = { ok: '成功', exhausted: '已用尽', unknown: '未取得读数', stale: '已失效' }
const reasons = {
  account_scope_mismatch: '上游账户与已登记账户不符', credential_scope_changed: '渠道地址或授权范围已变更，请更新查询凭据',
  profile_scope_changed: '查询配置在请求期间已变更', credential_rejected: '上游拒绝查询凭据',
  permission_denied: '查询凭据缺少账户查看权限', unsupported_capability: '上游账户接口不可用',
  upstream_error: '上游账户接口返回错误', redirect_denied: '上游返回重定向', probe_timeout: '上游查询超时',
  probe_unreachable: '上游账户接口暂不可达', destination_denied: '地址不允许用于账户查询',
  schema_mismatch: '无法识别上游余额格式', response_limit: '上游响应超出读取限制', probe_refused: '上游拒绝本次查询',
  wallet_changed: '渠道资金账户已变更', wallet_currency_mismatch: '上游余额与渠道台账币种不同',
  shared_wallet_requires_verification: '共享资金账户须先核对归属', not_prepaid_wallet: '该渠道账户采用人工台账',
  account_wallet_already_bound: '此上游账户已关联到其他自动同步台账', observation_expired: '上游读数已过期',
  missing_credential: '尚未配置余额查询凭据', credential_unavailable: '已保存的查询凭据无法读取，请重新配置', provider_inactive: '渠道已停用',
  probe_in_progress: '已有查询正在进行', balance_endpoint_unavailable: '此渠道未配置支持的 HTTPS 账户接口',
  management_key_unavailable: '服务当前无法保存余额查询凭据', separate_management_credential_required: '请填写独立的余额查询凭据'
}
const enc = encodeURIComponent
const path = (provider, account) => '/platform/providers/' + enc(provider.id) + '/accounts/' + enc(account.account_id)
const time = stamp => stamp ? formatDateTime(stamp) : '—'

function sampleText(sample) {
  if (!sample) return '—'
  const money = formatMicro(sample.amount_micro, sample.currency)
  if (sample.scope !== 'account_quota') return money
  if (!Number.isSafeInteger(sample.quota_units)) return '—'
  return sample.quota_units.toLocaleString('zh-CN') + ' 额度单位' + (sample.amount_micro == null ? '' : ' · 配置折算 ' + money)
}

function resultText(sample) {
  if (!sample) return '尚未查询'
  return [statusNames[sample.status] ?? '待确认', sample.reason_code ? (reasons[sample.reason_code] ?? '上游读数待核对') : null,
    sample.wallet_synced ? '已同步台账' : null].filter(Boolean).join(' · ')
}

function credentialText(profile) {
  if (!profile?.credential_configured) return '未配置'
  return profile.credential_usable ? '已配置' : '待更新凭据'
}

function problem(error, fallback) {
  const reason = reasons[error?.detail?.reason]
  if (reason) return reason
  if (error?.status === 409) return '配置版本已变更，请返回后读取最新配置。'
  if (error?.status === 403) return '当前账号没有权限执行此操作。'
  return fallback
}

function facts(host, rows) {
  const list = el('dl', 'policy-facts')
  for (const [label, value] of rows) {
    const row = el('div')
    row.append(el('dt', null, label), el('dd', null, value ?? '—'))
    list.append(row)
  }
  host.append(list)
}

function freshness(sample, profile) {
  if (!sample) return '—'
  if (sample.profile_revision !== profile?.profile_revision || sample.reason_code === 'profile_scope_changed') return '历史配置 v' + sample.profile_revision
  if (!profile.credential_usable) return '查询凭据待更新'
  if (!sample.valid_until) return '—'
  return (sample.reason_code === 'observation_expired' ? '已过期 · 原有效期至 ' : '有效至 ') + time(sample.valid_until)
}

export async function balanceOverview(host, api, provider, account, signal, open) {
  host.replaceChildren(el('h3', null, '上游账户查询'))
  const body = el('div')
  host.append(body)
  try {
    const base = path(provider, account)
    const [config, observations] = await Promise.all([
      api.get(base + '/balance-profile', { signal }), api.get(base + '/balance-observations', { params: { limit: 1 }, signal })
    ])
    if (signal.aborted || !host.isConnected) return
    const latest = observations.last_success
    const label = latest?.scope === 'account_quota' ? '最近上游账户额度' : '最近上游账户余额'
    facts(body, [[label, sampleText(latest)], ['上游读数时间', time(latest?.observed_at)], ['读数有效性', freshness(latest, config.profile)],
      ['最近查询', resultText(observations.latest)]])
    if (hasAction(config, 'read')) body.append(button('查看上游账户查询', open, 'link'))
  } catch (error) {
    if (!signal.aborted && host.isConnected) body.append(el('p', 'error-row', problem(error, '上游账户查询状态读取失败。')),
      button('重试读取', () => balanceOverview(host, api, provider, account, signal, open), 'link'))
  }
}

function profileForm(pane, api, base, config, signal, done, back) {
  const profile = config.profile
  const adapters = (config.adapters ?? []).filter(adapter => Object.hasOwn(adapterNames, adapter))
  editForm(pane, {
    mode: 'edit', label: '保存查询配置', done,
    values: { adapter: profile?.adapter ?? adapters[0], expected_user_id: profile?.expected_user_id, quota_per_unit: profile?.quota_per_unit,
      currency: profile?.currency ?? 'CNY', sync_wallet: profile?.sync_wallet ? 'on' : 'off' },
    fields: [
      { key: 'adapter', label: '余额接口', type: 'select', allowEmpty: false, options: adapters.map(value => ({ value, label: adapterNames[value] })) },
      { key: 'expected_user_id', label: '上游账户 ID', hint: '使用上游账户资料中的数字 ID' },
      { key: 'currency', label: '币种', hint: 'New API 额度折算使用三位币种代码。Sub2API 使用 USD。' },
      { key: 'quota_per_unit', label: '每币种单位对应额度', type: 'number', step: 1, hint: '使用供应商提供的折算比例' },
      { key: 'sync_wallet', label: '同步到账面余额', type: 'select', allowEmpty: false, options: [
        { value: 'off', label: '只记录上游查询' }, { value: 'on', label: '同步已核验余额' }
      ] },
      { key: 'credential', label: '余额查询凭据', type: 'password', wide: true, hint: '填写独立的账户访问令牌，省略 Bearer 前缀。同一账户和接口保留已配置凭据时留空。' }
    ],
    async submit(values, options) {
      const adapter = values.adapter
      const expected_user_id = values.expected_user_id?.trim() ?? ''
      const currency = adapter === 'sub2api' ? 'USD' : values.currency?.trim().toUpperCase() ?? ''
      const quota_per_unit = values.quota_per_unit
      if (!adapters.includes(adapter)) throw new Error('请选择余额接口')
      if (!/^[1-9][0-9]{0,18}$/.test(expected_user_id)) throw new Error('请填写有效的上游账户 ID')
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error('请填写三位币种代码')
      if (adapter === 'new_api' && (!Number.isSafeInteger(quota_per_unit) || quota_per_unit < 1)) throw new Error('请填写正整数额度折算比例')
      const credential = values.credential?.trim()
      if (!credential && (!profile?.credential_usable || adapter !== profile.adapter || expected_user_id !== profile.expected_user_id)) {
        throw new Error('请填写余额查询凭据')
      }
      const payload = { expected_profile_revision: profile?.profile_revision ?? 0, adapter, expected_user_id, currency,
        sync_wallet: adapter === 'sub2api' && values.sync_wallet === 'on',
        ...(adapter === 'new_api' ? { quota_per_unit } : {}), ...(credential ? { credential } : {}) }
      try { return await api.post(base + '/balance-profile', payload, { ...options, signal }) }
      catch (error) { throw new Error(problem(error, '余额查询配置保存失败，请核对表单。')) }
    }
  })
  const adapter = pane.body.querySelector('[data-field="adapter"]')
  const currency = pane.body.querySelector('[data-field="currency"]')
  const quota = pane.body.querySelector('[data-field="quota_per_unit"]')
  const sync = pane.body.querySelector('[data-field="sync_wallet"]')
  let newApiCurrency = profile?.adapter === 'new_api' ? profile.currency : 'CNY'
  function updateFields() {
    const sub2api = adapter.value === 'sub2api'
    currency.readOnly = sub2api
    currency.value = sub2api ? 'USD' : newApiCurrency
    quota.closest('.field').hidden = sub2api
    sync.closest('.field').hidden = !sub2api
  }
  currency.addEventListener('input', () => { if (!currency.readOnly) newApiCurrency = currency.value })
  adapter.addEventListener('change', updateFields)
  updateFields()
  pane.foot.prepend(button('取消编辑', back))
}

function observationTable(items) {
  const wrap = el('div', 'routing-table')
  const table = el('table')
  table.setAttribute('aria-label', '上游余额查询记录')
  const thead = el('thead'), headings = el('tr'), tbody = el('tbody')
  for (const title of ['查询时间', '来源', '配置修订', '上游读数', '结果']) headings.append(el('th', null, title))
  thead.append(headings)
  for (const sample of items) {
    const row = el('tr')
    const source = adapterNames[sample.source?.adapter] ?? '—'
    for (const value of [time(sample.observed_at), source, 'v' + sample.profile_revision, sampleText(sample), resultText(sample)]) row.append(el('td', null, value))
    tbody.append(row)
  }
  table.append(thead, tbody)
  wrap.append(table)
  return wrap
}

export function channelBalance(pane, api, provider, account, signal, back) {
  const base = path(provider, account)
  const title = account.label + ' / 上游账户查询'
  let view
  function enter(suffix) {
    view?.abort()
    view = new AbortController()
    pane.setTitle(suffix ? title + ' / ' + suffix : title)
    pane.headActions.replaceChildren(button('返回渠道资金', () => { view.abort(); back() }))
    pane.body.replaceChildren()
    pane.foot.replaceChildren()
    return AbortSignal.any([signal, view.signal])
  }

  function clear(config) {
    const current = enter('清除配置')
    const notice = el('p', 'notice')
    const submit = button('确认清除配置', async () => {
      submit.disabled = true
      try {
        await api.post(base + '/balance-profile/clear', { expected_profile_revision: config.profile.profile_revision }, { signal: current, idempotencyKey: key })
        if (!current.aborted) display('已清除余额查询配置。')
      } catch (error) {
        if (!current.aborted) { notice.textContent = problem(error, '清除余额查询配置失败。'); notice.className = 'notice error' }
      } finally { submit.disabled = false }
    }, 'primary')
    const key = idempotencyKey()
    pane.body.append(el('p', null, '清除将移除已保存的余额查询凭据和配置。历史查询记录可继续在台账查看。'), notice)
    pane.foot.append(button('取消清除', () => display()), submit)
  }

  function display(message) {
    const current = enter()
    const notice = el('p', 'notice', message)
    notice.setAttribute('role', 'status')
    const summary = el('section')
    summary.setAttribute('aria-label', '上游余额状态')
    const history = el('div')
    const paging = el('div', 'card-pager')
    const pager = createPager()
    let busy = false, pending, reading
    const prev = button('上一页查询', () => { if (pager.prev()) load() })
    const next = button('下一页查询', () => { if (pager.next()) load() })
    paging.append(prev, next)
    pane.body.append(notice, summary, el('h3', null, '上游余额查询记录'), history, paging)

    function draw(config, data) {
      const profile = config.profile
      const latest = data.last_success
      summary.replaceChildren()
      facts(summary, [['余额接口', adapterNames[profile?.adapter]], ['查询来源', profile?.source_origin], ['查询凭据', credentialText(profile)],
        ['上游账户 ID', profile?.expected_user_id], ['台账同步', profile && (profile.sync_wallet ? '同步已核验余额' : '仅查询记录')],
        [latest?.scope === 'account_quota' ? '最近上游账户额度' : '最近上游账户余额', sampleText(latest)],
        ['上游读数时间', time(latest?.observed_at)], ['读数有效性', freshness(latest, profile)],
        ['最近查询', resultText(data.latest)], ['最近查询时间', time(data.latest?.observed_at)]])
      if (profile?.adapter === 'new_api') summary.append(el('p', 'muted', 'New API 返回账户额度。显示的金额按配置折算。'))
      if (!profile && !hasAction(config, 'configure')) summary.append(el('p', 'muted', '此渠道当前未开放余额接口配置。'))
      const controls = []
      if (hasAction(config, 'configure')) controls.push(button('编辑余额查询配置', () => {
        const editing = enter('编辑配置')
        profileForm(pane, api, base, config, editing, () => {
          if (!editing.aborted) display('已保存余额查询配置。')
        }, () => display())
      }))
      if (hasAction(config, 'clear_balance_profile')) controls.push(button('清除余额查询配置', () => clear(config)))
      if (hasAction(config, 'probe_balance')) controls.push(button('查询上游余额', () => probe(profile), 'primary'))
      pane.foot.replaceChildren(...controls)
      history.replaceChildren(data.items?.length ? observationTable(data.items) : el('p', 'muted', '暂无上游查询记录'))
    }

    async function load() {
      reading?.abort()
      const request = reading = new AbortController()
      const requestSignal = AbortSignal.any([current, request.signal])
      prev.disabled = next.disabled = true
      history.replaceChildren(el('p', 'muted', '正在读取查询记录…'))
      try {
        const [config, data] = await Promise.all([api.get(base + '/balance-profile', { signal: requestSignal }),
          api.get(base + '/balance-observations', { params: { limit: 15, cursor: pager.cursor() }, signal: requestSignal })])
        if (requestSignal.aborted) return
        pager.applyResult(data.next_cursor ?? null)
        draw(config, data)
      } catch (error) {
        if (!requestSignal.aborted) history.replaceChildren(el('p', 'error-row', problem(error, '查询记录读取失败。')), button('重新读取', load))
      } finally {
        if (reading === request) { prev.disabled = !pager.canPrev(); next.disabled = !pager.canNext() }
      }
    }

    async function probe(profile) {
      if (busy || current.aborted) return
      busy = true
      for (const control of pane.foot.children) control.disabled = true
      notice.textContent = '正在查询上游账户…'
      notice.className = 'notice'
      const revision = profile.profile_revision
      if (pending?.revision !== revision) pending = { revision, key: idempotencyKey() }
      try {
        const sample = await api.post(base + '/balance-probes', { profile_revision: revision }, { signal: current, idempotencyKey: pending.key })
        if (current.aborted) return
        pending = undefined
        pager.reset()
        notice.textContent = '已记录上游查询 · ' + resultText(sample)
        if (sample.status === 'unknown' || sample.status === 'stale') notice.className = 'notice warn'
        await load()
      } catch (error) {
        if (current.aborted) return
        if (error?.status > 0 && error.status < 500) pending = undefined
        notice.textContent = problem(error, '上游余额查询未完成，请重试。')
        notice.className = 'notice error'
      } finally {
        busy = false
        if (!current.aborted) for (const control of pane.foot.children) control.disabled = false
      }
    }
    load()
  }
  display()
}
