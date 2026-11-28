import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { formatDateTime } from './format.js'
import { idempotencyKey } from './idempotency.js'

const PATH = '/auth/personal-tokens'
const action = (record, verb) => Array.isArray(record.actions) && record.actions.includes(verb)
const dateField = (key, title) => ({ key, title, render: row => formatDateTime(row[key]) })
const tokenScope = row => row.tenant_id ? '绑定租户' : '全局账号'

function tokenStatus(row) {
  if (row.revoked_at) return '已撤销'
  return Date.parse(row.expires_at) <= Date.now() ? '已过期' : '有效'
}

function revealToken(pane, result, signal) {
  if (signal.aborted || !pane.body.isConnected) return
  pane.foot.replaceChildren(button('完成', pane.close))
  if (result.token_returned === false || !result.token) {
    pane.body.replaceChildren(el('p', 'notice warn', '令牌已生成，明文无法再次显示。请撤销该令牌后重新生成。'))
    return
  }

  const notice = el('p', 'notice warn', '令牌仅显示一次，请现在复制并妥善保管。')
  const value = el('input', 'personal-token-value mono')
  value.type = 'text'
  value.value = result.token
  value.readOnly = true
  value.autocomplete = 'off'
  value.spellcheck = false
  value.setAttribute('aria-label', '个人登录令牌')
  const status = el('p', 'muted')
  status.setAttribute('role', 'status')
  const copy = button('复制令牌', async () => {
    try {
      await navigator.clipboard.writeText(value.value)
      status.textContent = '令牌已复制'
    } catch {
      value.focus()
      value.select()
      status.textContent = '已选中令牌，请用系统的复制命令复制'
    }
  }, 'primary')
  const clear = () => {
    value.value = ''
    copy.disabled = true
  }
  window.addEventListener('pagehide', clear, { once: true, signal })
  signal.addEventListener('abort', clear, { once: true })
  pane.body.replaceChildren(notice, value, status)
  pane.foot.prepend(copy)
  value.focus()
}

export function personalTokensPage(host, api, signal) {
  let list
  const open = detailPanel(host, () => list)

  function createToken() {
    open('生成令牌', pane => {
      editForm(pane, {
        mode: 'create',
        label: '生成令牌',
        fields: [{ key: 'name', label: '令牌名称', wide: true }],
        submit: (values, opts) => {
          const name = values.name?.trim()
          if (!name) throw new Error('请输入令牌名称')
          return api.post(PATH, { name }, { ...opts, signal })
        },
        done: result => revealToken(pane, result, signal)
      })
      const name = pane.body.querySelector('input[name="name"]')
      name.setAttribute('aria-label', '令牌名称')
      name.focus()
    })
  }

  function showToken(row) {
    open(row.name, pane => {
      editForm(pane, {
        mode: 'view',
        values: { ...row, status: tokenStatus(row), scope: row.tenant_id ?? tokenScope(row) },
        fields: [
          { key: 'name', label: '令牌名称' },
          { key: 'status', label: '状态' },
          { key: 'scope', label: '权限范围' },
          { key: 'created_at', label: '创建时间', format: formatDateTime },
          { key: 'expires_at', label: '到期时间', format: formatDateTime },
          { key: 'last_used_at', label: '最近使用', format: formatDateTime },
          { key: 'revoked_at', label: '撤销时间', format: formatDateTime }
        ]
      })
      if (!action(row, 'revoke')) return

      const notice = el('p', 'notice error')
      notice.setAttribute('role', 'status')
      pane.body.prepend(notice)
      const key = idempotencyKey()
      const revoke = button('撤销令牌', async () => {
        revoke.disabled = true
        try {
          await api.post(PATH + '/' + encodeURIComponent(row.id) + '/revoke', { revision: row.revision },
            { idempotencyKey: key, signal })
          if (signal.aborted || !pane.body.isConnected) return
          pane.changed()
          pane.close()
        } catch (error) {
          if (signal.aborted || !pane.body.isConnected) return
          if (error.code === 'conflict') {
            pane.changed()
            notice.textContent = '令牌状态已变化，请返回列表查看最新状态'
            return
          }
          notice.textContent = error.message || '撤销令牌失败'
          revoke.disabled = false
        }
      })
      pane.foot.append(revoke)
    })
  }

  list = createLedger(host, {
    title: '令牌管理',
    columns: [
      { key: 'name', title: '令牌名称' },
      { key: 'scope', title: '权限范围', render: tokenScope },
      { key: 'status', title: '状态', render: tokenStatus },
      dateField('created_at', '创建时间'),
      dateField('expires_at', '到期时间'),
      dateField('last_used_at', '最近使用')
    ],
    createLabel: '生成令牌',
    createAction: 'create_personal_token',
    onCreate: createToken,
    onOpen: showToken,
    searchable: false,
    emptyText: '暂无个人登录令牌',
    fetchPage: ({ cursor, limit, signal: listSignal }) =>
      api.get(PATH, { params: { cursor, limit }, signal: AbortSignal.any([signal, listSignal]) })
  })
  return list
}
