// 租户密码登录直接进入租户，个人令牌和验证码登录沿用原有租户选择。

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

const ROLE_TEXT = { owner: '户主', admin: '管理员', group_admin: '组管', member: '成员' }

export function bindTokenLoginTrigger(button, label, open) {
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.addEventListener('dblclick', open)
  button.addEventListener('click', e => {
    if (e.detail === 0) open()
  })
}

export function tenantChoiceList(tenants, select, onError) {
  const list = el('div', 'tenant-list')
  for (const tenant of tenants) {
    const item = el('button', 'tenant-item')
    item.type = 'button'
    item.appendChild(el('span', null, tenant.name))
    if (tenant.role) item.appendChild(el('small', 'muted', '角色：' + (ROLE_TEXT[tenant.role] || tenant.role)))
    item.addEventListener('click', async () => {
      const choices = list.querySelectorAll('button')
      choices.forEach(choice => { choice.disabled = true })
      try {
        await select(tenant)
      } catch (error) {
        choices.forEach(choice => { choice.disabled = false })
        onError(error)
      }
    })
    list.appendChild(item)
  }
  return list
}

export function renderLogin(host, { api, mockOn, signal, setPendingToken, onSession }) {
  const wrap = el('div', 'login-wrap')
  const panel = el('div', 'login-panel')
  wrap.appendChild(panel)
  host.appendChild(wrap)

  const heading = el('h1')
  const title = el('button', 'token-login-trigger', '万象 OneX')
  bindTokenLoginTrigger(title, '万象 OneX，令牌登录', () => switchTab('token'))
  heading.appendChild(title)
  panel.appendChild(heading)
  const defaultHint = '企业 AI Agent 纳管与统一管控平台'
  const sub = el('p', 'sub', defaultHint)
  panel.appendChild(sub)

  let stage = 'form' // 'form' | 'tenants'
  let tab = 'password'

  const tabs = el('div', 'login-tabs')
  const tabCode = el('button', 'selected', '验证码登录')
  const tabInvite = el('button', null, '邀请码登录')
  tabs.append(tabCode, tabInvite)
  const alternate = el('div', 'login-alternate')
  const backToPassword = el('button', 'link', '返回密码登录')
  const useCode = el('button', 'link', '验证码或邀请')
  alternate.append(backToPassword, useCode)

  const fieldsBox = el('div')
  const hint = el('p', 'login-hint')
  hint.setAttribute('aria-live', 'polite')
  const submitBtn = el('button', 'primary submit', '登录')
  const download = el('a', 'login-download', '下载 OneX Desktop')
  download.href = '/download'

  function setHint(text, isError) {
    hint.textContent = text || ''
    hint.className = 'login-hint' + (isError ? ' error' : '')
  }

  function field(labelText, inputEl) {
    const row = el('div', 'login-field')
    if (inputEl.tagName === 'INPUT') inputEl.setAttribute('aria-label', labelText)
    row.appendChild(el('span', null, labelText))
    row.appendChild(inputEl)
    return row
  }

  const tenantInput = el('input')
  tenantInput.type = 'text'
  tenantInput.name = 'tenant'
  tenantInput.placeholder = '租户 ID 或简称'
  tenantInput.autocapitalize = 'off'
  tenantInput.spellcheck = false

  const usernameInput = el('input')
  usernameInput.type = 'text'
  usernameInput.name = 'username'
  usernameInput.placeholder = '用户名'
  usernameInput.autocomplete = 'username'
  usernameInput.autocapitalize = 'off'
  usernameInput.spellcheck = false

  const passwordInput = el('input')
  passwordInput.type = 'password'
  passwordInput.name = 'password'
  passwordInput.placeholder = '密码'
  passwordInput.autocomplete = 'current-password'

  const targetInput = el('input')
  targetInput.type = 'text'
  targetInput.placeholder = '邮箱或手机号'
  targetInput.autocomplete = 'username'

  const tokenInput = el('input')
  tokenInput.type = 'password'
  tokenInput.placeholder = '登录令牌'
  tokenInput.setAttribute('aria-label', '登录令牌')
  tokenInput.autocomplete = 'off'
  tokenInput.spellcheck = false
  const clearCredentials = () => {
    passwordInput.value = ''
    tokenInput.value = ''
  }
  window.addEventListener('pagehide', clearCredentials, { once: true, signal })
  signal?.addEventListener('abort', clearCredentials, { once: true })

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
  signal?.addEventListener('abort', () => clearInterval(countdownTimer), { once: true })

  sendBtn.addEventListener('click', async () => {
    const target = targetInput.value.trim()
    if (!target) {
      setHint('请输入邮箱或手机号', true)
      targetInput.focus()
      return
    }
    sendBtn.disabled = true
    try {
      await api.post('/auth/code', { target }, { signal })
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
    sub.textContent = tab === 'token' ? '使用个人令牌登录' : defaultHint
    tabs.hidden = tab !== 'code' && tab !== 'invite'
    alternate.hidden = tab === 'password'
    useCode.hidden = tab !== 'token'
    if (tab === 'password') {
      fieldsBox.append(field('租户', tenantInput), field('用户名', usernameInput), field('密码', passwordInput))
      return
    }
    if (tab === 'token') {
      fieldsBox.appendChild(field('登录令牌', tokenInput))
      return
    }
    fieldsBox.appendChild(field('账号', targetInput))
    if (tab === 'invite') fieldsBox.appendChild(field('邀请码', inviteInput))
    fieldsBox.appendChild(field('验证码', codeRow))
  }

  function switchTab(next) {
    if (stage !== 'form' || submitBtn.disabled) return
    if (next !== tab) clearCredentials()
    tab = next
    tabCode.classList.toggle('selected', tab === 'code')
    tabInvite.classList.toggle('selected', tab === 'invite')
    setHint('')
    renderFields()
    if (tab === 'token') tokenInput.focus()
    else if (tab === 'password') tenantInput.focus()
    else targetInput.focus()
  }
  tabCode.addEventListener('click', () => switchTab('code'))
  tabInvite.addEventListener('click', () => switchTab('invite'))
  backToPassword.addEventListener('click', () => switchTab('password'))
  useCode.addEventListener('click', () => switchTab('code'))

  // 用全局令牌换租户令牌，再取完整会话
  let globalMe
  let globalToken
  async function finishWithTenant(tenantEntry) {
    const res = await api.post('/auth/select-tenant', { tenant_id: tenantEntry.id }, { signal })
    setPendingToken(res.token)
    const me = await api.get('/me', { signal })
    return { ...me, token: res.token, globalToken, globalActions: globalMe.actions || [], is_platform_admin: globalMe.is_platform_admin === true }
  }

  async function afterLogin(loginRes) {
    setPendingToken(loginRes.token)
    const me = globalMe = await api.get('/me', { signal })
    if (tab === 'password' && !me.tenant) throw new Error('未能进入所选租户，请重新登录')
    if (me.tenant) {
      return { ...me, token: loginRes.token }
    }
    globalToken = loginRes.token
    const tenants = loginRes.tenants || []
    if (me.is_platform_admin === true) {
      return { ...me, globalActions: me.actions || [], token: globalToken, globalToken, tenantChoices: tenants }
    }
    if (tenants.length === 0) {
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
    alternate.hidden = true
    fieldsBox.hidden = true
    submitBtn.hidden = true
    hint.hidden = true
    panel.appendChild(tenantChoiceList(tenants, async tenant => {
      onSession(await finishWithTenant(tenant))
    }, error => {
      hint.hidden = false
      setHint(error.message || '选择租户失败', true)
    }))
  }

  async function submit() {
    if (submitBtn.disabled) return
    let body
    let path
    if (tab === 'password') {
      const tenant = tenantInput.value.trim()
      const username = usernameInput.value.trim()
      const password = passwordInput.value
      if (!tenant || !username || !password) {
        const missing = !tenant ? tenantInput : !username ? usernameInput : passwordInput
        setHint('请输入租户 ID 或简称、用户名和密码', true)
        missing.focus()
        return
      }
      path = '/auth/password-login'
      body = { tenant, username, password, kind: 'web' }
    } else if (tab === 'token') {
      const token = tokenInput.value.trim()
      if (!token) {
        setHint('请输入登录令牌', true)
        return
      }
      path = '/auth/token-login'
      body = { token }
    } else {
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
      path = '/auth/login'
      body = { target, code }
      if (tab === 'invite') {
        const invite = inviteInput.value.trim()
        if (!invite) {
          setHint('请输入邀请码', true)
          return
        }
        body.invite_code = invite
      }
    }
    submitBtn.disabled = true
    submitBtn.textContent = '登录中…'
    setHint('')
    try {
      const loginRes = await api.post(path, body, { signal })
      const session = await afterLogin(loginRes)
      if (session) onSession(session)
    } catch (e) {
      setPendingToken(null)
      setHint(e.message || '登录失败，请重试', true)
    } finally {
      clearCredentials()
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

  panel.append(tabs, fieldsBox, hint, submitBtn, alternate, download)
  renderFields()
  tenantInput.focus()
  return () => switchTab('token')
}
