// 登录页：验证码登录、邀请码登录、租户选择。
// 契约 v0.1：验证码必需，邀请码只用于加入租户；登录返回全局令牌，/me 的 tenant 为 null 时进入租户选择。

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

const ROLE_TEXT = { owner: '户主', admin: '管理员', group_admin: '组管', member: '成员' }

export function renderLogin(host, { api, mockOn, setPendingToken, onSession }) {
  const wrap = el('div', 'login-wrap')
  const panel = el('div', 'login-panel')
  wrap.appendChild(panel)
  host.appendChild(wrap)

  panel.appendChild(el('h1', null, '万象 OneX'))
  const sub = el('p', 'sub', '企业 AI Agent 纳管与统一管控平台')
  panel.appendChild(sub)

  let stage = 'form' // 'form' | 'tenants'
  let tab = 'code' // 'code' | 'invite'

  const tabs = el('div', 'login-tabs')
  const tabCode = el('button', 'selected', '验证码登录')
  const tabInvite = el('button', null, '邀请码登录')
  tabs.append(tabCode, tabInvite)

  const fieldsBox = el('div')
  const hint = el('p', 'login-hint')
  const submitBtn = el('button', 'primary submit', '登录')

  function setHint(text, isError) {
    hint.textContent = text || ''
    hint.className = 'login-hint' + (isError ? ' error' : '')
  }

  function field(labelText, inputEl) {
    const row = el('div', 'login-field')
    row.appendChild(el('span', null, labelText))
    row.appendChild(inputEl)
    return row
  }

  const targetInput = el('input')
  targetInput.type = 'text'
  targetInput.placeholder = '邮箱或手机号'
  targetInput.autocomplete = 'username'

  const inviteInput = el('input')
  inviteInput.type = 'text'
  inviteInput.placeholder = '邀请码'

  const codeInput = el('input')
  codeInput.type = 'text'
  codeInput.placeholder = '6 位验证码'
  codeInput.autocomplete = 'one-time-code'
  codeInput.maxLength = 6
  const sendBtn = el('button', null, '发送验证码')
  const codeRow = el('div', 'code-row')
  codeRow.append(codeInput, sendBtn)

  let countdownTimer = null
  function startCountdown() {
    let countdown = 60
    sendBtn.disabled = true
    sendBtn.textContent = '60 秒后重发'
    countdownTimer = setInterval(() => {
      countdown -= 1
      if (countdown <= 0) {
        clearInterval(countdownTimer)
        sendBtn.disabled = false
        sendBtn.textContent = '发送验证码'
      } else {
        sendBtn.textContent = countdown + ' 秒后重发'
      }
    }, 1000)
  }

  sendBtn.addEventListener('click', async () => {
    const target = targetInput.value.trim()
    if (!target) {
      setHint('请输入邮箱或手机号', true)
      targetInput.focus()
      return
    }
    sendBtn.disabled = true
    try {
      await api.post('/auth/code', { target })
      setHint(mockOn ? '验证码已发送（开发环境固定为 246810）' : '验证码已发送，请查收')
      startCountdown()
      codeInput.focus()
    } catch (e) {
      setHint(e.message || '发送失败，请重试', true)
      sendBtn.disabled = false
    }
  })

  function renderFields() {
    fieldsBox.textContent = ''
    fieldsBox.appendChild(field('账号', targetInput))
    if (tab === 'invite') fieldsBox.appendChild(field('邀请码', inviteInput))
    fieldsBox.appendChild(field('验证码', codeRow))
  }

  function switchTab(next) {
    tab = next
    tabCode.classList.toggle('selected', tab === 'code')
    tabInvite.classList.toggle('selected', tab === 'invite')
    setHint('')
    renderFields()
  }
  tabCode.addEventListener('click', () => switchTab('code'))
  tabInvite.addEventListener('click', () => switchTab('invite'))

  // 用全局令牌换租户令牌，再取完整会话
  let globalMe
  let globalToken
  async function finishWithTenant(tenantEntry) {
    const res = await api.post('/auth/select-tenant', { tenant_id: tenantEntry.id })
    setPendingToken(res.token)
    const me = await api.get('/me')
    return { ...me, token: res.token, globalToken, globalActions: globalMe.actions || [], is_platform_admin: globalMe.is_platform_admin === true }
  }

  async function afterLogin(loginRes) {
    setPendingToken(loginRes.token)
    const me = globalMe = await api.get('/me')
    globalToken = loginRes.token
    if (me.tenant) {
      // 令牌已带租户（例如刚用邀请码加入）
      return { token: loginRes.token, user: me.user, tenant: me.tenant, role: me.role }
    }
    const tenants = loginRes.tenants || []
    if (tenants.length === 0) {
      if (me.is_platform_admin) {
        return { ...me, globalActions: me.actions || [], token: globalToken, globalToken }
      }
      throw new Error('该账号不属于任何租户，请联系管理员获取邀请码')
    }
    if (tenants.length === 1) {
      return await finishWithTenant(tenants[0])
    }
    showTenantSelection(tenants)
    return null // 等用户在列表里点选
  }

  function showTenantSelection(tenants) {
    stage = 'tenants'
    sub.textContent = '该账号属于多个租户，选择一个进入'
    tabs.hidden = true
    fieldsBox.hidden = true
    submitBtn.hidden = true
    hint.hidden = true
    const list = el('div', 'tenant-list')
    for (const t of tenants) {
      const item = el('button', 'tenant-item')
      item.appendChild(el('span', null, t.name))
      item.appendChild(el('small', 'muted', t.role ? '角色：' + (ROLE_TEXT[t.role] || t.role) : ''))
      item.addEventListener('click', async () => {
        item.disabled = true
        try {
          onSession(await finishWithTenant(t))
        } catch (e) {
          item.disabled = false
          hint.hidden = false
          setHint(e.message || '选择租户失败', true)
        }
      })
      list.appendChild(item)
    }
    panel.appendChild(list)
  }

  async function submit() {
    const target = targetInput.value.trim()
    const code = codeInput.value.trim()
    if (!target) {
      setHint('请输入邮箱或手机号', true)
      return
    }
    if (!code) {
      setHint('请输入验证码', true)
      return
    }
    const body = { target, code }
    if (tab === 'invite') {
      const invite = inviteInput.value.trim()
      if (!invite) {
        setHint('请输入邀请码', true)
        return
      }
      body.invite_code = invite
    }
    submitBtn.disabled = true
    submitBtn.textContent = '登录中…'
    setHint('')
    try {
      const loginRes = await api.post('/auth/login', body)
      const session = await afterLogin(loginRes)
      if (session) onSession(session)
    } catch (e) {
      setPendingToken(null)
      setHint(e.message || '登录失败，请重试', true)
    } finally {
      submitBtn.disabled = false
      submitBtn.textContent = '登录'
    }
  }

  submitBtn.addEventListener('click', submit)
  panel.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && stage === 'form' && !submitBtn.disabled) {
      e.preventDefault()
      submit()
    }
  })

  panel.append(tabs, fieldsBox, hint, submitBtn)
  renderFields()
  targetInput.focus()
}
