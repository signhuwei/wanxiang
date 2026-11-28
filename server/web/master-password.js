import { renderForm } from './form.js'
import { button, el } from './panel.js'
import { idempotencyKey } from './idempotency.js'

const path = '/auth/master-password'

export async function masterPasswordPage(host, api, signal) {
  host.classList.add('page')
  host.append(el('h2', null, 'Master 登录设置'))
  const body = el('div', 'page')
  host.append(body)
  try {
    let account = await api.get(path, { signal })
    if (signal.aborted) return
    const canSet = account.actions.includes('set_master_password')
    const form = renderForm(body, { mode: canSet ? 'edit' : 'view', values: account, sections: [{ fields: [
      { key: 'username', label: 'Master 用户名' },
      ...(canSet ? [
        { key: 'password', type: 'password', label: '新密码', hint: '至少 12 个字符' },
        { key: 'confirm', type: 'password', label: '确认密码' }
      ] : [])
    ] }] })
    if (!canSet) return
    const clearPasswords = () => {
      for (const input of body.querySelectorAll('input[type="password"]')) input.value = ''
    }
    window.addEventListener('pagehide', clearPasswords, { once: true, signal })
    signal.addEventListener('abort', clearPasswords, { once: true })
    const save = button('保存 Master 登录', async () => {
      const { username, password, confirm } = form.collect()
      if (!username.trim() || Array.from(password).length < 12 || password !== confirm) {
        form.setNotice('请输入用户名和至少 12 个字符的密码，两次密码须一致。', 'error')
        return
      }
      save.disabled = true
      try {
        account = await api.put(path, { username, password, revision: account.revision }, { idempotencyKey: idempotencyKey(), signal })
        form.setNotice('Master 登录已保存。')
      } catch (error) {
        if (!signal.aborted) form.setNotice(error.status === 409 ? '用户名已使用或设置已变更，请重新打开本页核对。' : error.message, 'error')
      } finally {
        clearPasswords()
        save.disabled = false
      }
    }, 'primary')
    const actions = el('div', 'inline-foot')
    actions.append(save)
    host.append(actions)
  } catch (error) {
    if (!signal.aborted) body.replaceChildren(el('p', 'error-row', error.message))
  }
}
