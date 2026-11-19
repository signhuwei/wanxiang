// 成员台账：GET /v1/members，行点击钻取成员详情（右侧表单，查看/编辑同一布局）。

import { createLedger } from './ledger.js'
import { openDrill } from './drill.js'
import { renderForm } from './form.js'
import { formatMilli, formatDateTime, roleLabel, memberStatusLabel } from './format.js'
import { showToast } from './toast.js'

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

const ROLE_OPTIONS = [
  { value: 'admin', label: '管理员' },
  { value: 'group_admin', label: '组管' },
  { value: 'member', label: '成员' }
]

export function renderMembersPage(host, { api }) {
  let ledger

  async function fetchPage({ q, filters, cursor, limit, signal }) {
    // CONTRACT-PENDING: role/status 筛选参数待契约确认（契约目前只定义 q/cursor/limit）
    return await api.get('/members', {
      params: { q, cursor, limit, role: filters.role, status: filters.status },
      signal
    })
  }

  function statusCell(item) {
    const ok = item.status === 'active'
    return el('span', 'status ' + (ok ? 'ok' : 'warn'), memberStatusLabel(item.status))
  }

  function nameCell(item) {
    const frag = document.createDocumentFragment()
    frag.appendChild(el('span', 'row-title', item.name))
    frag.appendChild(el('span', 'row-sub', item.target))
    return frag
  }

  let detail = null
  let snap
  let dirty = false
  function openMember(item) {
    snap = ledger.suspend()
    function display() {
      detail.setTitle(item.name)
      // 每次切换成员使用独立容器，旧请求完成时不会覆盖新成员。
      const body = el('div')
      const foot = el('div', 'actions')
      detail.body.replaceChildren(body)
      detail.foot.replaceChildren(foot)
      renderDetail(body, foot, item.user_id, () => { dirty = true })
    }
    if (detail) return display()
    openDrill(host, {
      title: item.name,
      onClose: async () => {
        detail = null
        const state = snap
        ledger.resume(state)
        if (dirty) {
          dirty = false
          await ledger.reload()
          ledger.restoreScroll(state.scrollTop)
        }
      },
      render: pane => {
        detail = pane
        ledger.restoreScroll(snap.scrollTop)
        display()
      }
    })
  }

  async function renderDetail(body, foot, userId, markDirty) {
    body.textContent = ''
    foot.textContent = ''
    body.appendChild(el('p', 'empty', '加载中…'))

    let groupsPromise = null
    function loadGroups() {
      if (!groupsPromise) {
        groupsPromise = api.get('/groups', { params: { limit: 200 } }).then(d => d.items || [])
      }
      return groupsPromise
    }

    let member
    try {
      member = await api.get('/members/' + encodeURIComponent(userId))
    } catch (e) {
      body.textContent = ''
      body.appendChild(el('p', 'error-row', e.message || '加载失败'))
      return
    }

    async function paint(mode) {
      body.textContent = ''
      foot.textContent = ''

      const kv = el('div', 'kv')
      kv.append(
        el('span', null, 'ID'),
        document.createTextNode(member.user_id),
        el('span', null, '最近活动'),
        document.createTextNode(formatDateTime(member.last_active_at))
      )

      const canEditRole = member.role !== 'owner'
      const fields = [
        { key: 'name', label: '姓名', readonly: true },
        { key: 'target', label: '账号', readonly: true },
        canEditRole
          ? { key: 'role', label: '角色', type: 'select', options: ROLE_OPTIONS, allowEmpty: false }
          : { key: 'role', label: '角色', readonly: true, format: roleLabel },
        { key: 'group_id', label: '分组', type: 'select', options: [] },
        { key: 'quota_eraser', label: '橡皮配额', type: 'number', step: 0.001, placeholder: '不限' },
        { key: 'status', label: '状态', readonly: true, format: memberStatusLabel }
      ]

      if (mode !== 'view') {
        try {
          const groups = await loadGroups()
          fields[3].options = groups.map(g => ({ value: g.id, label: g.name }))
          if (member.group_id && !groups.some(g => g.id === member.group_id)) {
            fields[3].options.push({ value: member.group_id, label: member.group_name || member.group_id })
          }
        } catch (e) {
          groupsPromise = null
          await paint('view')
          showToast(e.message || '无法加载分组，请重试', 'error')
          return
        }
      } else {
        // 查看态：分组按名称直接展示
        fields[3] = { key: 'group_name', label: '分组', readonly: true }
      }

      const form = renderForm(body, {
        sections: [{ key: 'base', title: '', fields }],
        values: {
          ...member,
          quota_eraser: member.quota_milli === null ? null : member.quota_milli / 1000
        },
        mode
      })

      body.prepend(kv)
      const actions = member.actions || []
      if (mode === 'view') {
        if (actions.includes('update')) {
          const editBtn = el('button', 'primary', '编辑')
          editBtn.addEventListener('click', () => paint('edit'))
          foot.appendChild(editBtn)
        }
        if (actions.includes('disable')) {
          const isActive = member.status === 'active'
          const toggleBtn = el('button', isActive ? 'danger' : null, isActive ? '禁用' : '启用')
          toggleBtn.addEventListener('click', async () => {
            toggleBtn.disabled = true
            try {
              member = await api.post('/members/' + encodeURIComponent(member.user_id), {
                status: isActive ? 'disabled' : 'active',
                revision: member.revision
              })
              markDirty()
              showToast(isActive ? '已禁用该成员' : '已恢复该成员')
              paint('view')
            } catch (e) {
              toggleBtn.disabled = false
              form.setNotice(e.message || '操作失败', 'error')
            }
          })
          foot.appendChild(toggleBtn)
        }
      } else {
        const saveBtn = el('button', 'primary', '保存')
        const cancelBtn = el('button', 'link', '取消')
        saveBtn.addEventListener('click', async () => {
          const v = form.collect()
          const quotaMilli = v.quota_eraser === null || v.quota_eraser === undefined
            ? null
            : Math.round(Number(v.quota_eraser) * 1000)
          if (quotaMilli !== null && (!Number.isFinite(quotaMilli) || quotaMilli < 0)) {
            form.setNotice('橡皮配额必须是不小于 0 的数字', 'error')
            return
          }
          saveBtn.disabled = true
          try {
            member = await api.post('/members/' + encodeURIComponent(member.user_id), {
              role: v.role,
              group_id: v.group_id,
              quota_milli: quotaMilli,
              revision: member.revision
            }, { idempotencyKey: 'member-' + member.user_id + '-' + Date.now() })
            markDirty()
            showToast('已保存')
            paint('view')
          } catch (e) {
            saveBtn.disabled = false
            if (e.code === 'conflict') {
              form.setNotice(e.message + '。请取消后重新打开编辑。', 'error')
            } else {
              form.setNotice(e.message || '保存失败', 'error')
            }
          }
        })
        cancelBtn.addEventListener('click', () => paint('view'))
        foot.append(cancelBtn, saveBtn)
      }
    }

    paint('view')
  }

  ledger = createLedger(host, {
    title: '成员',
    rowKey: 'user_id',
    fetchPage,
    onOpen: openMember,
    emptyText: '没有成员',
    filters: [
      {
        key: 'role',
        label: '角色',
        options: [
          { value: '', label: '全部角色' },
          { value: 'owner', label: '户主' },
          ...ROLE_OPTIONS
        ]
      },
      {
        key: 'status',
        label: '状态',
        options: [
          { value: '', label: '全部状态' },
          { value: 'active', label: '正常' },
          { value: 'disabled', label: '已禁用' }
        ]
      }
    ],
    columns: [
      { key: 'name', title: '成员', render: nameCell },
      { key: 'role', title: '角色', render: m => roleLabel(m.role) },
      { key: 'group_name', title: '分组', render: m => m.group_name || '—' },
      { key: 'status', title: '状态', render: statusCell },
      { key: 'quota_milli', title: '橡皮配额', render: m => formatMilli(m.quota_milli) },
      { key: 'last_active_at', title: '最近活动', render: m => formatDateTime(m.last_active_at) }
    ]
  })

  return ledger
}
