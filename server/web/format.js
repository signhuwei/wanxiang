// 展示格式化：橡皮金额、时间、角色与状态的中文标签。

export function formatMilli(milli) {
  if (milli === null || milli === undefined) return '不限'
  const digits = String(Math.abs(milli)).padStart(4, '0')
  const fraction = digits.slice(-3).replace(/0+$/, '')
  return (milli < 0 ? '-' : '') + digits.slice(0, -3) + (fraction ? '.' + fraction : '')
}

export function parseEraserMilli(value) {
  const match = /^(\d+)(?:\.(\d{1,3})0*)?$/.exec(String(value).trim())
  if (!match) return null
  const milli = Number(match[1] + (match[2] ?? '').padEnd(3, '0'))
  return Number.isSafeInteger(milli) ? milli : null
}

// 配额用量：quotaMilli 为 null 表示不限，只显示已用，不判定状态。
// 否则按用量占比分三档：ok（<80%）、warn（80%~100%）、error（已到或超出）。
export function quotaUsageLevel(usedMilli, quotaMilli) {
  if (quotaMilli === null || quotaMilli === undefined) return 'ok'
  const used = usedMilli || 0
  if (used >= quotaMilli) return 'error'
  if (quotaMilli > 0 && used >= quotaMilli * 0.8) return 'warn'
  return 'ok'
}

export function formatQuotaUsage(usedMilli, quotaMilli) {
  const used = formatMilli(usedMilli ?? 0)
  const quota = quotaMilli === null || quotaMilli === undefined ? '不限' : formatMilli(quotaMilli)
  return used + ' / ' + quota
}

export const QUOTA_HINT = '按北京时间自然月重置，留空为不限'
export const QUOTA_INVALID_MESSAGE = '橡皮配额须为不小于 0 的粒数，精确到 0.001 粒'

// 配额表单输入是橡皮，最多三位小数；换算成毫橡皮（契约字段 quota_milli，非负整数）后再校验。
export function parseQuotaEraserInput(value) {
  if (value === null || value === undefined || value === '') return { quotaMilli: null }
  const quotaMilli = parseEraserMilli(value)
  if (quotaMilli === null) return { error: QUOTA_INVALID_MESSAGE }
  return { quotaMilli }
}

export function formatDateTime(rfc3339) {
  if (!rfc3339) return '—'
  const d = new Date(rfc3339)
  if (Number.isNaN(d.getTime())) return '—'
  const pad = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return (Math.round(v * 10) / 10) + ' ' + units[i]
}

const ROLE_LABELS = { owner: '户主', admin: '管理员', group_admin: '组管', member: '成员' }
const MEMBER_STATUS = { active: '正常', disabled: '已禁用' }
const TENANT_STATUS = { active: '正常', suspended: '已暂停' }
export const DESKTOP_RELEASE_STATUS = { draft: '草稿', published: '已发布', unlisted: '已下架' }
export const DESKTOP_OS_LABELS = { darwin: 'macOS', windows: 'Windows' }
export const AGENT_LABELS = { 'claude-code': 'Claude Code', codex: 'Codex', 'kimi-code': 'Kimi Code', workbuddy: 'WorkBuddy', 'deepseek-desktop': 'DeepSeek Harness Desktop', 'claude-desktop': 'Claude Desktop', 'codex-desktop': 'Codex Desktop' }
export const AGENT_OPTIONS = Object.entries(AGENT_LABELS).map(([value, label]) => ({ value, label }))

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role ?? '—'
}

export function memberStatusLabel(status) {
  return MEMBER_STATUS[status] ?? status ?? '—'
}

export function tenantStatusLabel(status) {
  return TENANT_STATUS[status] ?? status ?? '—'
}

export function agentLabel(agent) {
  return AGENT_LABELS[agent] ?? agent ?? '未知 Agent'
}
