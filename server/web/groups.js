import { createLedger } from './ledger.js'
import { el, button, editForm, detailPanel } from './panel.js'
import { formatMilli } from './format.js'

const groupFields = [{ key: 'name', label: '组名' }, { key: 'parent_id', label: '上级组 ID' }, { key: 'quota_milli', label: '配额（毫橡皮）', type: 'number', step: 1 }]

export function groupsPage(host, api, actions) {
  let list
  const open = detailPanel(host, () => list)
  function entry(item) {
    open(item?.name || '新建分组', async pane => {
      const group = item && await api.get('/groups/' + encodeURIComponent(item.id))
      function paint(mode) {
        editForm(pane, { fields: groupFields, values: group || {}, mode,
          submit: (v, opts) => api.post('/groups' + (group ? '/' + encodeURIComponent(group.id) : ''), { ...v, revision: group?.revision }, opts) })
        if (mode === 'view' && group.actions.includes('update')) pane.foot.append(button('编辑', () => paint('edit'), 'primary'))
      }
      paint(group ? 'view' : 'create')
    })
  }
  list = createLedger(host, { title: '分组', columns: [{ key: 'name', title: '组名' }, { key: 'parent_id', title: '上级组' },
    { key: 'quota_milli', title: '橡皮配额', render: g => formatMilli(g.quota_milli) }],
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
