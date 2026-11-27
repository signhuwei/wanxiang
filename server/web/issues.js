import { createLedger } from './ledger.js'
import { openDrill } from './drill.js'
import { formatDateTime } from './format.js'
import { idempotencyKey } from './idempotency.js'

const statuses = { open: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' }

function element(tag, text) {
  const node = document.createElement(tag)
  node.textContent = text
  return node
}

export function issuesPage(host, api, signal) {
  let ledger, detailBody, detail
  const drafts = new Map()
  ledger = createLedger(host, {
    title: '用户反馈', searchLabel: '查询用户、租户或反馈内容', literalSearch: true, signal,
    filters: [{ key: 'status', label: '处理状态', options: [
      { value: '', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))
    ] }],
    columns: [
      { key: 'created_at', title: '时间', render: row => formatDateTime(row.created_at) },
      { key: 'tenant_name', title: '租户' }, { key: 'user_name', title: '用户' },
      { key: 'text', title: '反馈', render: row => row.text.slice(0, 80) },
      { key: 'status', title: '状态', render: row => statuses[row.status] },
      { key: 'image_count', title: '图片' }, { key: 'log_count', title: '日志' }
    ],
    fetchPage: ({ q, filters, cursor, limit, signal }) => api.get('/platform/issues', { params: { q, ...filters, cursor, limit }, signal }),
    async onOpen(row) {
      if (detail?.id === row.id) return
      if (!detailBody) {
        openDrill(host, {
          title: '反馈详情',
          render({ body }) { detailBody = body },
          onClose() {
            detail?.dispose()
            detail = detailBody = null
            host.querySelector('tr.selected button')?.focus({ preventScroll: true })
            ledger.reloadInBackground()
          }
        })
      }
      detail?.dispose()
      const body = detailBody
      body.replaceChildren()
      body.scrollTop = 0
      const local = new AbortController(), urls = []
      let timer
      function dispose() {
        const draft = body.querySelector('.issue-response textarea')?.value
        if (draft === '') drafts.delete(row.id)
        else if (draft !== undefined) drafts.set(row.id, draft)
        local.abort()
        clearInterval(timer)
        urls.forEach(url => URL.revokeObjectURL(url))
        signal.removeEventListener('abort', dispose)
      }
      detail = { id: row.id, dispose }
      signal.addEventListener('abort', dispose, { once: true })
      const path = '/platform/issues/' + encodeURIComponent(row.id)
      try {
        const item = await api.get(path, { signal: local.signal })
        if (local.signal.aborted) return
        const text = element('p', item.text)
        text.className = 'issue-content'
        const attachments = element('div', '')
        body.append(element('small', `${item.tenant_name} · ${item.user_name} · ${formatDateTime(item.created_at)}`), text, attachments)
        timer = issueThread(body, item, path, api, local.signal, drafts.get(row.id))
        for (let i = 0; i < item.image_count; i++) {
          const blob = await api.download(`${path}/images/${i}`, { signal: local.signal })
          if (local.signal.aborted) return
          const url = URL.createObjectURL(blob), img = document.createElement('img')
          urls.push(url)
          img.alt = `反馈图片 ${i + 1}`
          img.className = 'issue-picture'
          img.src = url
          attachments.append(img)
        }
        if (item.logs.length) {
          const details = document.createElement('details')
          details.append(element('summary', `附带日志（${item.logs.length} 条）`))
          for (const log of item.logs) details.append(element('pre', JSON.stringify(log, null, 2)))
          attachments.append(details)
        }
      } catch (error) {
        if (!local.signal.aborted) {
          detail.id = null
          body.append(element('p', error.message || '反馈读取失败'))
        }
      }
    }
  })
  return ledger
}

function issueThread(host, item, path, api, signal, draft = '') {
  const status = element('p', '')
  const list = element('ol', '')
  list.setAttribute('aria-label', '处理动态')
  const more = element('button', '更早的动态')
  const hint = element('p', '')
  hint.setAttribute('role', 'status')
  const form = document.createElement('form')
  form.className = 'issue-response'
  const stateLabel = element('label', '处理状态')
  const state = document.createElement('select')
  for (const [value, label] of Object.entries(statuses)) {
    const option = element('option', label)
    option.value = value
    state.append(option)
  }
  stateLabel.append(state)
  const textLabel = element('label', '公开回复')
  const reply = document.createElement('textarea')
  reply.value = draft
  reply.maxLength = 1200
  reply.rows = 3
  textLabel.append(reply)
  const submit = element('button', '发布更新')
  submit.className = 'primary'
  if (item.actions.includes('set_status')) form.append(stateLabel)
  if (item.actions.includes('comment')) form.append(textLabel)
  form.append(submit)
  host.append(status, element('h3', '处理动态'), list, more, hint)
  if (item.actions.includes('set_status') || item.actions.includes('comment')) host.append(form)

  const activities = new Map()
  let current = item, before = item.next_before_revision, busy = false, reading = false, attempt
  function paint(page, older = false) {
    if (older || !activities.size) before = page.next_before_revision
    for (const event of page.activities) activities.set(event.revision, event)
    more.hidden = !before
    if (!older) {
      if (current.status !== page.status) {
        if (state.value !== current.status && state.value !== page.status) hint.textContent = '状态已有更新，请重新选择'
        state.value = page.status
      }
      current = page
      status.textContent = '当前状态 · ' + statuses[page.status]
    }
    const rows = [...activities.values()].sort((a, b) => b.revision - a.revision).map(event => {
      const row = element('li', '')
      row.append(element('small', `${event.role === 'platform' ? '平台管理员' : item.user_name} · ${formatDateTime(event.created_at)}`))
      if (event.status) row.append(element('p', '状态改为 ' + statuses[event.status]))
      if (event.text) {
        const text = element('p', event.text)
        text.className = 'issue-content'
        row.append(text)
      }
      return row
    })
    list.replaceChildren(...(rows.length ? rows : [element('li', '暂无处理动态')]))
  }
  state.value = item.status
  paint(item)
  async function load(older = false, force = false) {
    if (reading || (!force && busy) || (older && !before)) return
    reading = more.disabled = true
    try {
      const page = await api.get(path, { params: older ? { before_revision: before } : {}, signal })
      if (!signal.aborted && (older || page.revision !== current.revision || force)) {
        if (!older && page.activities.length && !activities.has(page.activities.at(-1).revision) && page.activities.at(-1).revision > current.revision + 1) {
          activities.clear()
          before = null
        }
        paint(page, older)
      }
    } catch (error) {
      if (!signal.aborted && (force || older)) hint.textContent = error.message
    } finally { reading = more.disabled = false }
  }
  more.onclick = () => load(true)
  form.onsubmit = async event => {
    event.preventDefault()
    if (busy || reading) return
    const text = reply.value.trim()
    if (attempt?.text !== text || attempt.status !== state.value) {
      const body = { revision: current.revision, ...(text && { text }),
        ...(item.actions.includes('set_status') && state.value !== current.status && { status: state.value }) }
      if (!body.text && !body.status) { hint.textContent = '请选择新状态或填写回复'; return }
      attempt = { text, status: state.value, body, key: idempotencyKey() }
    }
    busy = submit.disabled = reply.disabled = state.disabled = true
    hint.textContent = '正在发布…'
    try {
      await api.post(path + '/activities', attempt.body, { signal, idempotencyKey: attempt.key })
      if (signal.aborted) return
      reply.value = ''
      attempt = null
      hint.textContent = '已发布'
      await load(false, true)
    } catch (error) {
      if (signal.aborted) return
      hint.textContent = error.status === 409 ? '反馈已有更新，请确认后重新提交' : error.message
      if (error.status === 409) {
        attempt = null
        await load(false, true)
      }
    } finally { busy = submit.disabled = reply.disabled = state.disabled = false }
  }
  return setInterval(() => { if (!document.hidden) load() }, 15000)
}
