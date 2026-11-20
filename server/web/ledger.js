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
  columns,          // [{key, title, render?(item), width?}]
  fetchPage,        // async ({q, filters, cursor, limit, signal}) => {items, next_cursor, total}
  rowKey = 'id',
  filters = [],     // [{key, label, options:[{value,label}], value}]
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
  searchInput.placeholder = '查询'
  searchInput.setAttribute('aria-label', '查询')
  const filterSelects = {}
  for (const f of filters) {
    const sel = el('select')
    sel.setAttribute('aria-label', f.label)
    for (const o of f.options) {
      const opt = el('option', null, o.label)
      opt.value = o.value
      sel.appendChild(opt)
    }
    sel.value = f.value ?? ''
    filterSelects[f.key] = sel
    toolbar.appendChild(sel)
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

  function renderRows() {
    tbody.textContent = ''
    if (loading) {
      tbody.appendChild(statusRow('empty', td => { td.textContent = '加载中…' }))
      return
    }
    if (loadError) {
      tbody.appendChild(statusRow('error-row', td => {
        td.appendChild(el('span', null, loadError))
        td.appendChild(document.createTextNode(' '))
        const retry = el('button', 'link', '重试')
        retry.addEventListener('click', () => load())
        td.appendChild(retry)
      }))
      return
    }
    if (!items.length) {
      tbody.appendChild(statusRow('empty', td => { td.textContent = emptyText }))
      return
    }
    for (const item of items) {
      const canRead = onOpen && Array.isArray(item.actions) && item.actions.includes(openAction)
      const tr = el('tr', canRead ? 'clickable' : null)
      tr.dataset.key = item[rowKey]
      if (selectedKey === item[rowKey]) tr.classList.add('selected')
      for (const c of columns) {
        const td = el('td')
        const out = c.render ? c.render(item) : item[c.key]
        if (out instanceof Node) td.appendChild(out)
        else td.textContent = out ?? '—'
        tr.appendChild(td)
      }
      if (onOpen) {
        const action = el('td')
        if (canRead) {
          action.appendChild(el('button', 'link', '查看'))
          tr.addEventListener('click', () => {
            selectedKey = item[rowKey]
            markSelected()
            onOpen(item)
          })
        } else if (noOpenText) {
          action.appendChild(el('span', 'muted', noOpenText))
        }
        tr.appendChild(action)
      }
      tbody.appendChild(tr)
    }
  }

  function markSelected() {
    for (const tr of tbody.querySelectorAll('tr')) {
      tr.classList.toggle('selected', tr.dataset.key === selectedKey)
    }
  }

  function renderPager() {
    prevBtn.disabled = loading || !pager.canPrev()
    nextBtn.disabled = loading || !pager.canNext()
    pageInfo.textContent = '第 ' + (pager.page + 1) + ' 页'
    totalEl.textContent = '共 ' + total + ' 条'
    countEl.textContent = total ? total + ' 条' : ''
  }

  async function load() {
    if (abort) abort.abort()
    const ctrl = new AbortController()
    abort = ctrl
    loading = true
    loadError = null
    renderRows()
    renderPager()
    try {
      const data = await fetchPage({
        q,
        filters: { ...filterVals },
        cursor: pager.cursor(),
        limit: pageSize,
        signal: ctrl.signal
      })
      if (ctrl.signal.aborted) return
      if (createBtn && createAction) {
        createBtn.hidden = !(Array.isArray(data.actions) && data.actions.includes(createAction))
      }
      items = data.items || []
      total = data.total ?? items.length
      pager.applyResult(data.next_cursor ?? null)
    } catch (e) {
      if (e && e.name === 'AbortError') return
      if (ctrl.signal.aborted) return
      if (createBtn && createAction) createBtn.hidden = true
      items = []
      total = 0
      loadError = (e && e.message) || '加载失败'
    } finally {
      if (abort === ctrl) {
        loading = false
        abort = null
        renderRows()
        renderPager()
      }
    }
  }

  function refresh() {
    pager.reset()
    load()
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      q = searchInput.value.trim()
      pager.reset()
      load()
    }, 300)
  })
  for (const [key, sel] of Object.entries(filterSelects)) {
    sel.addEventListener('change', () => {
      filterVals[key] = sel.value
      pager.reset()
      load()
    })
  }
  prevBtn.addEventListener('click', () => { if (pager.prev()) load() })
  nextBtn.addEventListener('click', () => { if (pager.next()) load() })

  load()

  return {
    reload: load,
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
