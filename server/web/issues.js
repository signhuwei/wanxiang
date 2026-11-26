import { createLedger } from './ledger.js'
import { openDrill } from './drill.js'
import { formatDateTime } from './format.js'

function element(tag, text) {
  const node = document.createElement(tag)
  node.textContent = text
  return node
}

export function issuesPage(host, api, signal) {
  let ledger
  ledger = createLedger(host, {
    title: '用户反馈', searchLabel: '查询用户、租户或反馈内容', literalSearch: true, signal,
    columns: [
      { key: 'created_at', title: '时间', render: row => formatDateTime(row.created_at) },
      { key: 'tenant_name', title: '租户' }, { key: 'user_name', title: '用户' },
      { key: 'text', title: '反馈', render: row => row.text.slice(0, 80) },
      { key: 'image_count', title: '图片' }, { key: 'log_count', title: '日志' }
    ],
    fetchPage: ({ q, cursor, limit, signal }) => api.get('/platform/issues', { params: { q, cursor, limit }, signal }),
    onOpen(row) {
      const snapshot = ledger.suspend()
      const local = new AbortController(), urls = []
      function dispose() {
        local.abort()
        urls.forEach(url => URL.revokeObjectURL(url))
        signal.removeEventListener('abort', dispose)
      }
      signal.addEventListener('abort', dispose, { once: true })
      openDrill(host, { title: '反馈详情', onClose() { dispose(); ledger.resume(snapshot) }, async render({ body }) {
        const path = '/platform/issues/' + encodeURIComponent(row.id)
        try {
          const item = await api.get(path, { signal: local.signal })
          if (local.signal.aborted) return
          const text = element('p', item.text)
          text.className = 'issue-content'
          body.append(element('small', `${item.tenant_name} · ${item.user_name} · ${formatDateTime(item.created_at)}`), text)
          for (let i = 0; i < item.image_count; i++) {
            const blob = await api.download(`${path}/images/${i}`, { signal: local.signal })
            if (local.signal.aborted) return
            const url = URL.createObjectURL(blob), img = document.createElement('img')
            urls.push(url)
            img.alt = `反馈图片 ${i + 1}`
            img.className = 'issue-picture'
            img.src = url
            body.append(img)
          }
          if (item.logs.length) {
            const details = document.createElement('details')
            details.append(element('summary', `附带日志（${item.logs.length} 条）`))
            for (const log of item.logs) details.append(element('pre', JSON.stringify(log, null, 2)))
            body.append(details)
          }
        } catch (error) {
          if (!local.signal.aborted) body.append(element('p', error.message || '反馈读取失败'))
        }
      } })
    }
  })
  return ledger
}
