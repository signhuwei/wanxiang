// 布局验收：在浏览器里运行，检查当前页面在 1280×720 / 1440×900 下无外层滚动和溢出。
// 用法（Chrome DevTools console 或 MCP evaluate_script）：
//   const m = await import('/tests/layout-check.js'); m.runLayoutChecks('members')
// 返回 {viewport, pass, checks}，同时挂到 window.__LAYOUT_CHECK__。

export function runLayoutChecks(label) {
  const de = document.documentElement
  const body = document.body
  const checks = []
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail })

  add('document-no-horizontal-overflow', de.scrollWidth <= de.clientWidth,
    'scrollWidth=' + de.scrollWidth + ' clientWidth=' + de.clientWidth)
  add('document-no-vertical-overflow', de.scrollHeight <= de.clientHeight + 1,
    'scrollHeight=' + de.scrollHeight + ' clientHeight=' + de.clientHeight)
  add('body-no-horizontal-overflow', body.scrollWidth <= body.clientWidth,
    'scrollWidth=' + body.scrollWidth + ' clientWidth=' + body.clientWidth)

  const top = document.querySelector('.top')
  if (top) {
    const r = top.getBoundingClientRect()
    add('topbar-in-viewport', r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      JSON.stringify({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }))
  } else {
    add('topbar-present', false, 'no .top element')
  }

  const page = document.querySelector('.page') || document.querySelector('.login-wrap')
  add('page-mounted', !!page, page ? page.className : 'none')

  const toolbar = document.querySelector('.toolbar')
  if (toolbar) {
    const r = toolbar.getBoundingClientRect()
    add('toolbar-in-viewport', r.top >= 0 && r.bottom <= innerHeight,
      'top=' + r.top + ' bottom=' + r.bottom)
  }

  const pager = document.querySelector('.pager')
  if (pager) {
    const r = pager.getBoundingClientRect()
    add('pager-fixed-visible', r.bottom <= innerHeight && r.bottom > innerHeight - 80,
      'bottom=' + r.bottom + ' innerHeight=' + innerHeight)
  }

  // 找到所有声称可滚动的容器，确认它们没有超出视口
  for (const sel of ['.table-scroll', '.inline-body', '.list-scroll']) {
    for (const n of document.querySelectorAll(sel)) {
      const r = n.getBoundingClientRect()
      add('scroll-region-in-viewport:' + sel, r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1,
        'bottom=' + Math.round(r.bottom) + ' right=' + Math.round(r.right))
    }
  }

  // 行高约定：32–40px
  const firstCell = document.querySelector('.table-scroll tbody td')
  if (firstCell) {
    const h = firstCell.getBoundingClientRect().height
    add('row-height-32-40', h >= 32 && h <= 40, 'td height=' + Math.round(h))
  }

  const result = {
    label,
    viewport: { width: innerWidth, height: innerHeight },
    pass: checks.every(c => c.pass),
    checks
  }
  window.__LAYOUT_CHECK__ = result
  return result
}
