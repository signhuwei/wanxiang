// 路由首批（contracts/routing-p0.md）的纯函数：原因码文案、候选资格、池草稿组装。
// 不碰 DOM，便于 bun test 单测；页面只按服务端字段渲染，不推导权限。

const REASONS = {
  model_identity_unverified: '型号身份未核验',
  capability_unverified: '能力未核验',
  contract_provider_excluded: '合约边界排除该 Provider',
  balance_unknown: '余额未知',
  no_eligible_deployment: '没有合格部署',
  deployment_in_use: '仍被活动池或设备配置引用'
}
const CONFLICTS = {
  revision_changed: '模型池已被他人更新，草稿已保留。请基于最新版本重新预览。',
  preview_stale: '预览依据已过期（部署、审核或证据已变化），草稿已保留。请重新预览。',
  idempotency_mismatch: '同一提交键对应的内容已变化，草稿已保留。请重新预览后再发布。',
  quote_deployment_revision_changed: '部署修订已变化，草稿已保留。请刷新报价头并核对部署修订后再发布。'
}
const STATUS = { active: '启用', disabled: '停用', archived: '已归档', draft: '草稿' }

export const reasonLabel = code => REASONS[code] ?? code
export const conflictMessage = reason => CONFLICTS[reason] ?? '数据已变化，草稿已保留。请重新预览。'
export const deploymentStatusLabel = status => STATUS[status] ?? (status || '—')
export const revisionText = rev => Number.isSafeInteger(rev) && rev > 0 ? 'v' + rev : '无活动池'

// 一条原因可能是码、{code,message} 或纯文本；统一成可读文字。
export function reasonText(item) {
  if (item == null) return ''
  if (typeof item === 'string') return reasonLabel(item)
  if (typeof item === 'object') {
    const code = item.code ?? item.reason ?? item.reason_code
    const text = item.message ?? (code ? reasonLabel(code) : '')
    return item.deployment_id ? text + '（' + item.deployment_id + '）' : text
  }
  return String(item)
}

export function capabilityList(value) {
  if (Array.isArray(value)) return value.map(String)
  if (value && typeof value === 'object') {
    return Object.entries(value).filter(([, v]) => v !== false && v != null).map(([k, v]) => v === true ? k : k + ':' + v)
  }
  return []
}

export function shortValue(value) {
  if (value == null || value === '') return '—'
  if (typeof value !== 'object') return String(value)
  return String(value.state ?? value.status ?? value.id ?? value.quote_id ?? JSON.stringify(value))
}

// 候选可选取决于服务端的 select 动作和随行的 approved_match_id/evidence_ids；
// 不可选时列出服务端原因，原因缺失也要显式说出来，不能静默置灰。
export function candidateState(row) {
  const selectable = row?.actions?.includes('select') === true && Boolean(row.deployment_id)
    && Number.isSafeInteger(row.deployment_revision) && Boolean(row.approved_match_id) && Array.isArray(row.evidence_ids)
  if (selectable) return { selectable, reasons: [] }
  const reasons = []
  for (const key of ['reasons', 'blocking']) if (Array.isArray(row?.[key])) reasons.push(...row[key].map(reasonText))
  for (const key of ['reason_code', 'reason', 'ineligible_reason']) if (row?.[key]) reasons.push(reasonText(row[key]))
  if (!row?.deployment_id) reasons.push('尚未登记为部署')
  if (row?.actions?.includes('select') && !row.approved_match_id) reasons.push('缺少已确认的归纳审核')
  // 原因只出现在 match.reason 时也要显示，不能落到“未返回原因”
  if (!reasons.length && row?.match?.reason) reasons.push(reasonText(row.match.reason))
  const unique = [...new Set(reasons.filter(Boolean))]
  return { selectable: false, reasons: unique.length ? unique : ['服务端未返回原因'] }
}

export const memberFrom = (row, priority) => ({
  deployment_id: row.deployment_id, deployment_revision: row.deployment_revision, priority,
  approved_match_id: row.approved_match_id, evidence_ids: [...row.evidence_ids]
})

export const nextPriority = members => members.reduce((max, m) => Math.max(max, m.priority), 0) + 10

// 同一部署在一个池中只出现一次：选中替换旧版本成员，取消则移除。
export function toggleMember(members, row, checked) {
  const rest = members.filter(m => m.deployment_id !== row.deployment_id)
  if (!checked) return rest
  const old = members.find(m => m.deployment_id === row.deployment_id)
  return [...rest, memberFrom(row, old?.priority ?? nextPriority(rest))]
}

export const isMemberOf = (members, row) =>
  members.some(m => m.deployment_id === row.deployment_id && m.deployment_revision === row.deployment_revision)

const positive = (value, label, min = 1) => {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(label + '须为不小于 ' + min + ' 的整数')
  return value
}

// 组装与 fixtures/routing/p0-ab.json http.draft 同形的请求体。允许同优先级（由 Server/Edge 稳定破同），
// 请求体按优先级、再按部署 ID 排序，保证同一草稿的规范形不随勾选顺序变化。
export function buildDraft({ expected_pool_revision, members, routing, reason }) {
  const text = String(reason ?? '').trim()
  if (!text) throw new Error('请填写发布原因')
  if (!members.length) throw new Error('请至少选择一个渠道')
  for (const m of members) positive(m.priority, m.deployment_id + ' 优先级', 0)
  return {
    expected_pool_revision,
    members: [...members].sort((a, b) => a.priority - b.priority || (a.deployment_id < b.deployment_id ? -1 : 1))
      .map(m => ({ deployment_id: m.deployment_id, deployment_revision: m.deployment_revision, priority: m.priority,
        approved_match_id: m.approved_match_id, evidence_ids: [...m.evidence_ids] })),
    routing: { strategy: 'ordered', max_attempts: positive(routing.max_attempts, '最多尝试次数'),
      attempt_timeout_ms: positive(routing.attempt_timeout_ms, '单次时限'), total_timeout_ms: positive(routing.total_timeout_ms, '总时限') },
    reason: text
  }
}

export const DEFAULT_ROUTING = { strategy: 'ordered', max_attempts: 2, attempt_timeout_ms: 5000, total_timeout_ms: 12000 }

// —— 采购报价、汇率、可签输入倍率（contracts/routing-pricing-and-staging.md） ——
// 金额与汇率按十进制字符串和 BigInt 处理，不经浮点。

export const DIMENSIONS = [['input', '普通输入', 'token'], ['output', '输出', 'token'], ['cache_read', '缓存读', 'token'],
  ['cache_write', '缓存写', 'token'], ['request', '按次', 'request']]
export const dimensionLabel = key => DIMENSIONS.find(([k]) => k === key)?.[1] ?? key
const PRICING_REASONS = {
  missing_input_quote: '缺输入报价', quote_expired: '报价已过期', invalid_input_unit: '报价单位无效',
  missing_fx_rate: '缺汇率', missing_fx: '缺汇率', fx_expired: '汇率已过期',
  deployment_revision_mismatch: '报价对应的部署修订与池成员不一致', quote_deployment_revision_changed: '报价对应的部署修订已变化'
}
export const pricingReason = code => PRICING_REASONS[code] ?? reasonLabel(code)

// 游标绑定 as_of：无游标（第一页、刷新）开启新一轮并冻结时点，翻页沿用该轮时点。
export function asOfRound(now = () => new Date().toISOString()) {
  let at = null
  return cursor => (cursor && at) ? at : (at = now())
}
export const calculationLabel = status => ({ complete: '完整试算', partial: '部分试算（有缺项）', unavailable: '无法试算' })[status] ?? (status || '—')
const SYMBOL = { CNY: '¥', USD: 'US$' }

// "0.40" → "400000"（百万分之一单位）；空串为缺项返回 null；"0" 为明确零价。
export function parseMicro(text, label = '价格') {
  const s = String(text ?? '').trim()
  if (!s) return null
  const m = s.match(/^(\d+)(?:\.(\d{1,6}))?$/)
  if (!m) throw new Error(label + '须为非负数，最多 6 位小数')
  const value = BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(6, '0'))
  if (value.toString().length > 38) throw new Error(label + '超出范围')
  return value.toString()
}

function decimal(value, scale, minDigits) {
  const neg = value < 0n
  const abs = neg ? -value : value
  const unit = 10n ** BigInt(scale)
  let frac = (abs % unit).toString().padStart(scale, '0').replace(/0+$/, '')
  if (frac.length < minDigits) frac = frac.padEnd(minDigits, '0')
  return (neg ? '-' : '') + (abs / unit).toString() + (frac ? '.' + frac : '')
}

export function formatMicro(micro, currency, minDigits = 2) {
  if (micro == null || micro === '') return '未知'
  const text = decimal(BigInt(micro), 6, minDigits)
  return SYMBOL[currency] ? SYMBOL[currency] + text : text + ' ' + (currency ?? '')
}

export function unitPriceText(item, currency) {
  if (!item) return '缺项'
  const basis = Number(item.quantity_basis).toLocaleString('en-US')
  return formatMicro(item.rate_micro ?? item.amount_micro, currency) + ' / ' + basis + ' ' + (item.unit ?? 'token')
}

const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a }

// "7.50" → {rate_numerator:"15", rate_denominator:"2"}：1 单位原币可换的人民币，约成最简分数。
export function parseRatio(text) {
  const m = String(text ?? '').trim().match(/^(\d+)(?:\.(\d{1,12}))?$/)
  if (!m) throw new Error('汇率须为正数，最多 12 位小数')
  const scale = 10n ** BigInt((m[2] ?? '').length)
  const num = BigInt(m[1] + (m[2] ?? ''))
  if (num === 0n) throw new Error('汇率须大于 0')
  const g = gcd(num, scale)
  return { rate_numerator: (num / g).toString(), rate_denominator: (scale / g).toString() }
}

export function formatRatio(numerator, denominator) {
  if (numerator == null || denominator == null) return '—'
  const n = BigInt(numerator), d = BigInt(denominator)
  const scaled = n * 1000000n
  const exact = scaled % d === 0n
  return (exact ? '' : '≈') + decimal(scaled / d, 6, 0)
}

export function formatMultiplier(ppm) {
  if (!Number.isSafeInteger(ppm)) return '—'
  return decimal(BigInt(ppm), 6, 0) + '×'
}

// "4" → 4000000；最多三位小数，存储值是 1000 的整数倍。
export function parseMultiplier(text) {
  const m = String(text ?? '').trim().match(/^(\d+)(?:\.(\d{1,3}))?$/)
  if (!m) throw new Error('倍率须为非负数，最多 3 位小数')
  const ppm = Number(BigInt(m[1]) * 1000000n + BigInt((m[2] ?? '').padEnd(3, '0')) * 1000n)
  if (!Number.isSafeInteger(ppm)) throw new Error('倍率超出范围')
  return ppm
}

export function isoInput(text, label, required = true) {
  const s = String(text ?? '').trim()
  if (!s) { if (required) throw new Error('请填写' + label); return null }
  const t = Date.parse(s)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,3})?)?Z$/.test(s) || !Number.isFinite(t)) throw new Error(label + '须为 UTC 时间，如 2026-11-22T00:00:00Z')
  return new Date(t).toISOString()
}

// 写入键：同一请求体在网络失败后重试复用原键；体变化或服务端已应答的失败后换新键。
export function submissionKeys(make) {
  let key = null, print = null
  return {
    for(body) { const p = JSON.stringify(body); if (p !== print) { key = make(); print = p } return key },
    answered() { key = null; print = null }
  }
}

// 预览过期后逐个核对已选成员与最新候选：返回 null 表示一致；
// {kind:'gone'} 表示已不可入池；{kind:'changed'} 列出修订、审核、证据的新旧值，需用户显式采用。
export function memberChanges(member, row) {
  if (!row) return { kind: 'gone', reasons: ['候选列表中已找不到该部署'] }
  const state = candidateState(row)
  if (!state.selectable) return { kind: 'gone', reasons: state.reasons }
  const diffs = []
  if (row.deployment_revision !== member.deployment_revision) diffs.push(['部署修订', 'v' + member.deployment_revision, 'v' + row.deployment_revision])
  if (row.approved_match_id !== member.approved_match_id) diffs.push(['归纳审核', member.approved_match_id, row.approved_match_id])
  const before = (member.evidence_ids ?? []).join('、'), after = row.evidence_ids.join('、')
  if (before !== after) diffs.push(['证据', before || '无', after || '无'])
  return diffs.length ? { kind: 'changed', row, diffs } : null
}
