// Provider 右栏「渠道模型」卡片：只读首批。服务端分页和查询；
// 编辑、新增、归档写入另批开放，这里不渲染对应按钮，只展示服务端给出的占用原因。

import { el } from './panel.js'
import { createPager } from './pager.js'
import { capabilityList, deploymentStatusLabel, reasonText } from './routing-format.js'

const PAGE = 50

function card(row, onQuotes) {
  const node = el('article', 'deployment-card')
  node.dataset.key = row.id
  node.setAttribute('aria-label', '渠道模型 ' + (row.display_name || row.raw_model))
  const head = el('div', 'deployment-card-head')
  head.append(el('strong', null, row.display_name || row.raw_model || row.id),
    el('span', 'status-tag status-' + (row.status || 'unknown'), deploymentStatusLabel(row.status)))
  const raw = el('code', 'deployment-raw', row.raw_model ?? '—')
  raw.title = '原始型号（区分大小写）'
  const facts = el('small', 'muted', [row.id + (Number.isSafeInteger(row.revision) ? ' · 修订 ' + row.revision : ''),
    '账号 ' + (row.account_id ?? '—'), '端点 ' + (row.endpoint_id ?? '—')].join(' · '))
  const caps = el('div', 'capability-tags')
  for (const cap of capabilityList(row.capabilities)) caps.append(el('span', 'capability-tag', cap))
  if (!caps.childElementCount) caps.append(el('span', 'muted', '能力未声明'))
  node.append(head, raw, facts, caps)
  const blockers = Array.isArray(row.archive_blockers) ? row.archive_blockers.map(reasonText).filter(Boolean) : []
  if (blockers.length) {
    const list = el('ul', 'deployment-blockers')
    list.setAttribute('aria-label', '占用原因')
    for (const text of blockers) list.append(el('li', null, text))
    node.append(el('small', 'blocker-title', '占用中，暂不可归档'), list)
  }
  if (onQuotes && row.actions?.includes('read_quotes')) {
    const open = el('button', 'link', '采购报价')
    open.setAttribute('aria-label', '采购报价 ' + row.id)
    open.onclick = () => onQuotes(row)
    node.append(open)
  }
  return node
}

export function deploymentCards(host, api, provider, signal, { onQuotes } = {}) {
  const section = el('section', 'deployment-section')
  const bar = el('div', 'deployment-toolbar')
  const title = el('h3', null, '渠道模型')
  const count = el('span', 'muted')
  const search = el('input', 'search')
  search.type = 'search'
  search.placeholder = '查询展示名或原始型号'
  search.setAttribute('aria-label', '查询渠道模型')
  bar.append(title, count, search)
  const grid = el('div', 'deployment-grid')
  const nav = el('div', 'card-pager')
  const prev = el('button', null, '上一页')
  const next = el('button', null, '下一页')
  const info = el('span', 'muted')
  nav.append(prev, next, info)
  section.append(bar, grid, nav)
  host.append(section)

  let pager = createPager(), q = '', abort, timer
  async function load() {
    abort?.abort()
    const ctrl = abort = new AbortController()
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
    prev.disabled = next.disabled = true
    grid.replaceChildren(el('p', 'muted', '加载中…'))
    try {
      const data = await api.get('/platform/providers/' + encodeURIComponent(provider.id) + '/deployments',
        { params: { q, cursor: pager.cursor(), limit: PAGE }, signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      pager.applyResult(data.next_cursor ?? null)
      const items = data.items ?? []
      count.textContent = '共 ' + (data.total ?? items.length) + ' 个'
      grid.replaceChildren(...(items.length ? items.map(row => card(row, onQuotes)) : [el('p', 'muted', q ? '没有匹配的渠道模型' : '该 Provider 暂无渠道模型')]))
    } catch (e) {
      if (ctrl.signal.aborted || e?.name === 'AbortError') return
      count.textContent = ''
      const retry = el('button', 'link', '重试')
      retry.onclick = load
      const row = el('p', 'error-row', '渠道模型读取失败：' + e.message + ' ')
      row.append(retry)
      grid.replaceChildren(row)
    } finally {
      if (abort === ctrl) {
        prev.disabled = !pager.canPrev()
        next.disabled = !pager.canNext()
        info.textContent = '第 ' + (pager.page + 1) + ' 页'
      }
    }
  }
  search.addEventListener('input', () => {
    clearTimeout(timer)
    timer = setTimeout(() => { q = search.value; pager = createPager(); load() }, 300)
  })
  prev.onclick = () => { if (pager.prev()) load() }
  next.onclick = () => { if (pager.next()) load() }
  load()
  return { reload: load }
}
