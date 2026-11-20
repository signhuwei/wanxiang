import { createLedger } from './ledger.js'
import { el, button, editForm, detailPanel } from './panel.js'
import { formatMilli, formatQuotaUsage, quotaUsageLevel, QUOTA_HINT, QUOTA_INVALID_MESSAGE, parseQuotaEraserInput } from './format.js'

const viewFields = [
  { key: 'name', label: '组名', readonly: true },
  { key: 'parent_id', label: '上级组 ID', readonly: true, nullText: '—' },
  { key: 'quota_eraser', label: '橡皮配额', readonly: true, nullText: '不限' }
]
const editFields = [
  { key: 'name', label: '组名' },
  { key: 'parent_id', label: '上级组 ID' },
  { key: 'quota_eraser', label: '橡皮配额', type: 'number', step: 1, placeholder: '不限', hint: QUOTA_HINT }
]

function quotaUsageCell(item) {
  const level = quotaUsageLevel(item.month_used_milli, item.quota_milli)
  return el('span', 'status ' + level, formatQuotaUsage(item.month_used_milli, item.quota_milli))
}

export function groupsPage(host, api, actions) {
  let list
  const open = detailPanel(host, () => list)
  function entry(item) {
    open(item?.name || '新建分组', async pane => {
      const group = item && await api.get('/groups/' + encodeURIComponent(item.id))
      const usage = group && await api.get('/quota/usage', { params: { scope: 'group', id: group.id } }).catch(() => null)
      function kvBlock() {
        if (!usage) return null
        const kv = el('div', 'kv')
        kv.append(
          el('span', null, '本月已结算'), document.createTextNode(formatMilli(usage.used_milli)),
          el('span', null, '预留'), document.createTextNode(formatMilli(usage.reserved_milli)),
          el('span', null, '剩余'), document.createTextNode(usage.remaining_milli === null ? '不限' : formatMilli(usage.remaining_milli))
        )
        return kv
      }
      function paint(mode) {
        const values = group ? { ...group, quota_eraser: group.quota_milli === null ? null : group.quota_milli / 1000 } : {}
        editForm(pane, {
          fields: mode === 'view' ? viewFields : editFields,
          values,
          mode,
          submit: (v, opts) => {
            const parsed = parseQuotaEraserInput(v.quota_eraser)
            if (parsed.error) throw new Error(QUOTA_INVALID_MESSAGE)
            return api.post('/groups' + (group ? '/' + encodeURIComponent(group.id) : ''),
              { ...v, quota_milli: parsed.quotaMilli, quota_eraser: undefined, revision: group?.revision }, opts)
          }
        })
        const kv = kvBlock()
        if (kv) pane.body.prepend(kv)
        if (mode === 'view' && group.actions.includes('update')) pane.foot.append(button('编辑', () => paint('edit'), 'primary'))
      }
      paint(group ? 'view' : 'create')
    })
  }
  list = createLedger(host, { title: '分组', columns: [{ key: 'name', title: '组名' }, { key: 'parent_id', title: '上级组' },
    { key: 'month_used_milli', title: '本月已用 / 配额', render: quotaUsageCell }],
    fetchPage: ({ q, cursor, limit, signal }) => api.get('/groups', { params: { q, cursor, limit }, signal }),
    onOpen: entry, createLabel: '新建分组', onCreate: actions.includes('create_group') ? () => entry(null) : null })
}

export function invitePanel(pane, api, grantable) {
  const role = grantable.find(o => o.value === 'member') || grantable[0]
  editForm(pane, { mode: 'create', label: '生成', values: { role: role.value, max_uses: 1, days: 7 },
    fields: [{ key: 'role', label: '邀请角色', type: 'select', allowEmpty: false, options: grantable },
    { key: 'group_id', label: '分组 ID' }, { key: 'max_uses', label: '使用次数', type: 'number' }, { key: 'days', label: '有效天数', type: 'number' }],
    submit: ({ days, ...v }, opts) => api.post('/invites', { ...v, expires_in_ms: days * 86400000 }, opts),
    done(res) {
      pane.foot.replaceChildren()
      pane.body.replaceChildren(el('p', 'notice', res.code_returned ? '请现在复制邀请码。离开后不能再次查看。' : '邀请已创建，此次重试不再返回明文。'))
      if (!res.code_returned) return
      const output = el('input')
      output.setAttribute('aria-label', '一次性邀请码')
      output.readOnly = true
      output.value = res.invite_code
      pane.body.append(output, button('复制', async () => {
        try { await navigator.clipboard.writeText(output.value) } catch { output.select() }
      }))
    } })
}
