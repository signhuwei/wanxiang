// 钻取布局：把当前页面内容缩为左列（.drill-context），右侧打开详情面板。
// 可嵌套（在详情 body 里再次 openDrill）。返回时还原 DOM，配合 ledger.suspend/resume 保留列表状态。

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

export function openDrill(host, { title, render, onClose }) {
  const wrap = el('div', 'inline-drill')
  const ctx = el('div', 'drill-context')
  while (host.firstChild) ctx.appendChild(host.firstChild)

  const pane = el('div', 'inline-pane')
  const head = el('div', 'inline-head')
  const backBtn = el('button', 'link back', '← 返回')
  const titleEl = el('h2', null, title)
  const actionsEl = el('div', 'actions')
  head.append(backBtn, titleEl, actionsEl)
  const body = el('div', 'inline-body')
  const foot = el('div', 'inline-foot')
  pane.append(head, body, foot)
  wrap.append(ctx, pane)
  host.appendChild(wrap)

  let closed = false
  function close() {
    if (closed) return
    closed = true
    while (ctx.firstChild) host.appendChild(ctx.firstChild)
    wrap.remove()
    if (onClose) onClose()
  }
  backBtn.addEventListener('click', close)

  render({ body, foot, headActions: actionsEl, setTitle: t => { titleEl.textContent = t }, close })
  return { close, pane }
}
