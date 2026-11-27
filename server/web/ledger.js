// 台账组件：一行工具栏（标题、数量、查询、筛选、新建）+ 表格 + 固定页码。
// 服务端分页（cursor），只渲染当前页；suspend/resume 供钻取返回时还原查询、页码、选中项和滚动位置。

import { createPager } from './pager.js'

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

export function createLedger(host, {
  title,
  columns,          // [{key, title, render?(item), update?(current, next), width?}]
  fetchPage,        // async ({q, filters, cursor, limit, signal}) => {items, next_cursor, total}
  rowKey = 'id',
  filters = [],     // [{key, label, options?:[{value,label}], value}]；缺省 options 时用文本筛选
  searchLabel = '查询',
  literalSearch = false,
  signal: routeSignal,
  onOpen,           // (item) => void；有对应 action 时行可点击
  openAction = 'read',
  noOpenText = '',
  onCreate,         // () => void；提供后工具栏出现“新建”
  createLabel = '新建',
  createAction,
  searchable = true,
  pageSize = 50,
  emptyText = '暂无数据'
}) {
  host.classList.add('page')

  // 工具栏
  const toolbar = el('div', 'toolbar')
  const titleEl = el('h1', null, title)
  const countEl = el('span', 'count', '')
  toolbar.append(titleEl, countEl)
  const searchInput = el('input', 'search')
  searchInput.type = 'search'
  searchInput.placeholder = searchLabel
  searchInput.setAttribute('aria-label', searchLabel)
  const filterSelects = {}
  for (const f of filters) {
    const control = f.options ? el('select') : el('input', 'filter-search')
    control.setAttribute('aria-label', f.label)
    if (f.options) {
      for (const o of f.options) {
        const opt = el('option', null, o.label)
        opt.value = o.value
        control.appendChild(opt)
      }
    } else {
      control.type = 'search'
      control.placeholder = f.label
    }
    control.value = f.value ?? ''
    filterSelects[f.key] = control
    toolbar.appendChild(control)
  }
  if (searchable) toolbar.appendChild(searchInput)
  const createBtn = onCreate ? el('button', 'primary keep', createLabel) : null
  if (createBtn) {
    createBtn.hidden = Boolean(createAction)
    createBtn.addEventListener('click', () => onCreate())
    toolbar.appendChild(createBtn)
  }

  // 表格
  const scroll = el('div', 'table-scroll')
  const table = el('table')
  const thead = el('thead')
  const headRow = el('tr')
  for (const c of columns) {
    const th = el('th', null, c.title)
    if (c.width) th.style.width = c.width
    headRow.appendChild(th)
  }
  if (onOpen) headRow.appendChild(el('th', null, '操作'))
  thead.appendChild(headRow)
  const tbody = el('tbody')
  table.append(thead, tbody)
  scroll.appendChild(table)

  // 页码
  const pagerBar = el('div', 'pager')
  const prevBtn = el('button', null, '上一页')
  const nextBtn = el('button', null, '下一页')
  const pageInfo = el('span', 'page-info muted')
  const totalEl = el('span', 'muted')
  pagerBar.append(prevBtn, nextBtn, pageInfo)
  pagerBar.appendChild(el('span', 'grow'))
  pagerBar.appendChild(totalEl)

  host.append(toolbar, scroll, pagerBar)

  // 状态
  let pager = createPager()
  let q = ''
  let filterVals = Object.fromEntries(filters.map(f => [f.key, f.value ?? '']))
  let items = []
  let total = 0
  let selectedKey = null
  let loading = false
  let loadError = null
  let abort = null
  let debounceTimer = null

  function statusRow(className, build) {
    const tr = el('tr')
    const td = el('td', className)
    td.colSpan = columns.length + (onOpen ? 1 : 0)
    build(td)
    tr.appendChild(td)
    return tr
  }

  function renderCell(td, column, item, previous) {
    if (!column.render && previous && item[column.key] === previous[column.key]) return
    const out = column.render ? column.render(item) : item[column.key]
    if (out instanceof Node) {
      const current = td.firstChild
      if (column.update && current?.nodeType === Node.ELEMENT_NODE) column.update(current, out)
      else td.replaceChildren(out)
    } else if (td.textContent !== String(out ?? '—') || td.childElementCount) td.textContent = out ?? '—'
  }

  function updateRow(tr, item) {
    const canRead = onOpen && Array.isArray(item.actions) && item.actions.includes(openAction)
    tr.classList.toggle('clickable', Boolean(canRead))
    if (tr.dataset.key !== String(item[rowKey])) tr.dataset.key = item[rowKey]
    const previous = tr._ledgerItem
    tr._ledgerItem = item
    columns.forEach((column, index) => renderCell(tr.children[index], column, item, previous))
    if (!onOpen) return
    const action = tr.children[columns.length]
    if (previous && Boolean(previous.actions?.includes?.(openAction)) === Boolean(canRead)) return
    action.replaceChildren()
    if (canRead) action.appendChild(el('button', 'link', '查看'))
    else if (noOpenText) action.appendChild(el('span', 'muted', noOpenText))
  }

  function createRow() {
    const tr = el('tr')
    for (const column of columns) tr.appendChild(el('td'))
    if (onOpen) tr.appendChild(el('td'))
    tr.addEventListener('click', () => {
      const current = tr._ledgerItem
      if (!onOpen || !current || !Array.isArray(current.actions) || !current.actions.includes(openAction)) return
      selectedKey = current[rowKey]
      markSelected()
      onOpen(current)
    })
    return tr
  }

  function renderRows(background = false) {
    if (loading && !background) {
      tbody.replaceChildren(statusRow('empty', td => { td.textContent = '加载中…' }))
      return
    }
    if (loadError) {
      tbody.replaceChildren(statusRow('error-row', td => {
        td.appendChild(el('span', null, loadError))
        td.appendChild(document.createTextNode(' '))
        const retry = el('button', 'link', '重试')
        retry.addEventListener('click', () => load())
        td.appendChild(retry)
      }))
      return
    }
    if (!items.length) {
      if (tbody.querySelector('td.empty')?.textContent !== emptyText) {
        tbody.replaceChildren(statusRow('empty', td => { td.textContent = emptyText }))
      }
      return
    }

    if (!background) tbody.replaceChildren()
    const existing = new Map([...tbody.querySelectorAll('tr[data-key]')].map(row => [row.dataset.key, row]))
    const rows = items.map(item => {
      const key = String(item[rowKey])
      const row = existing.get(key) || createRow()
      updateRow(row, item)
      row.classList.toggle('selected', selectedKey === item[rowKey])
      return row
    })
    const focused = tbody.contains(document.activeElement) ? document.activeElement : null
    const keep = new Set(rows)
    for (const row of [...tbody.children]) if (!keep.has(row)) row.remove()
    let cursor = tbody.firstElementChild
    for (const row of rows) {
      if (row === cursor) cursor = cursor.nextElementSibling
      else if (tbody.moveBefore && row.parentNode === tbody) tbody.moveBefore(row, cursor)
      else tbody.insertBefore(row, cursor)
    }
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
  }

  function markSelected() {
    for (const tr of tbody.querySelectorAll('tr')) {
      tr.classList.toggle('selected', tr._ledgerItem?.[rowKey] === selectedKey)
    }
  }

  function renderPager() {
    prevBtn.disabled = loading || !pager.canPrev()
    nextBtn.disabled = loading || !pager.canNext()
    const labels = [[pageInfo, '第 ' + (pager.page + 1) + ' 页'], [totalEl, '共 ' + total + ' 条'], [countEl, total ? total + ' 条' : '']]
    for (const [node, text] of labels) if (node.textContent !== text) node.textContent = text
  }

  let backgroundPending = false
  let pointer
  tbody.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || pointer) return
    pointer = new AbortController()
    const release = e => {
      if (e.type !== 'blur' && e.pointerId !== event.pointerId) return
      pointer?.abort()
      // Keep the guard through the click dispatched after pointerup.
      setTimeout(() => { pointer = null; flushBackground() }, 0)
    }
    for (const name of ['pointerup', 'pointercancel', 'blur']) {
      window.addEventListener(name, release, { capture: true, signal: pointer.signal })
    }
  })
  function flushBackground() {
    if (!backgroundPending || loading || pointer || routeSignal?.aborted || !host.isConnected) return
    backgroundPending = false
    void load(true)
  }

  async function load(background = false) {
    if (routeSignal?.aborted) return
    if (abort) abort.abort()
    const ctrl = new AbortController()
    abort = ctrl
    loading = true
    if (!background) {
      loadError = null
      renderRows()
      renderPager()
    }
    try {
      const data = await fetchPage({
        q,
        filters: { ...filterVals },
        cursor: pager.cursor(),
        limit: pageSize,
        signal: ctrl.signal
      })
      if (ctrl.signal.aborted) return
      if (background && pointer) {
        backgroundPending = true
        return
      }
      if (createBtn && createAction) {
        createBtn.hidden = !(Array.isArray(data.actions) && data.actions.includes(createAction))
      }
      loadError = null
      items = data.items || []
      total = data.total ?? items.length
      pager.applyResult(data.next_cursor ?? null)
      if (background) {
        loading = false
        renderRows(true)
        renderPager()
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return
      if (ctrl.signal.aborted || background) return
      if (createBtn && createAction) createBtn.hidden = true
      items = []
      total = 0
      loadError = (e && e.message) || '加载失败'
    } finally {
      if (abort === ctrl) {
        loading = false
        abort = null
        if (!background && !ctrl.signal.aborted) { renderRows(); renderPager() }
        flushBackground()
      }
    }
  }

  function refresh() {
    pager.reset()
    load()
  }

  function applyFilters() {
    clearTimeout(debounceTimer)
    q = literalSearch ? searchInput.value : searchInput.value.trim()
    for (const [key, control] of Object.entries(filterSelects)) filterVals[key] = control.value
    refresh()
  }

  function queueFilters() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(applyFilters, 300)
  }

  searchInput.addEventListener('input', queueFilters)
  for (const control of Object.values(filterSelects)) {
    if (control.tagName === 'SELECT') control.addEventListener('change', applyFilters)
    else control.addEventListener('input', queueFilters)
  }
  routeSignal?.addEventListener('abort', () => {
    clearTimeout(debounceTimer)
    abort?.abort()
    pointer?.abort()
  }, { once: true })
  prevBtn.addEventListener('click', () => { if (pager.prev()) load() })
  nextBtn.addEventListener('click', () => { if (pager.next()) load() })

  load()

  return {
    reload: () => load(),
    reloadInBackground() { backgroundPending = true; flushBackground() },
    restoreScroll(top) { scroll.scrollTop = top },
    refresh,
    setSelected(key) {
      selectedKey = key
      markSelected()
    },
    // 钻取前挂起：保存全部列表状态，返回时恢复，不重新请求
    suspend() {
      return {
        q,
        filterVals: { ...filterVals },
        pagerSnap: pager.snapshot(),
        items,
        total,
        selectedKey,
        scrollTop: scroll.scrollTop
      }
    },
    resume(snap) {
      q = snap.q
      filterVals = { ...snap.filterVals }
      pager = createPager(snap.pagerSnap)
      items = snap.items
      total = snap.total
      selectedKey = snap.selectedKey
      searchInput.value = q
      for (const [key, sel] of Object.entries(filterSelects)) sel.value = filterVals[key]
      loadError = null
      renderRows()
      renderPager()
      scroll.scrollTop = snap.scrollTop
    }
  }
}
