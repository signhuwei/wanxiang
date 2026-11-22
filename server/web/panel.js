import { openDrill } from './drill.js'
import { renderForm } from './form.js'
import { idempotencyKey } from './idempotency.js'

export function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}
export function button(text, fn, cls) {
  const n = el('button', cls, text)
  n.onclick = fn
  return n
}

// 同级选择替换右栏，嵌套台账可以在自己的 host 上另开一层。
export function detailPanel(host, ledger = () => null) {
  let active, dirty = false
  return (title, draw) => {
    const list = ledger(), snap = list?.suspend()
    if (active) active.close()
    const controller = new AbortController()
    active = openDrill(host, { title, onClose() {
      controller.abort()
      active = null
      if (list && snap) {
        list.resume(snap)
        if (dirty) list.reload().then(() => list.restoreScroll(snap.scrollTop))
      }
      dirty = false
    }, render(pane) {
      const tools = { ...pane, signal: controller.signal, changed: () => { dirty = true } }
      Promise.resolve(draw(tools)).catch(e => {
        if (!controller.signal.aborted) pane.body.replaceChildren(el('p', 'error-row', e.message))
      })
    } })
  }
}

export function editForm(pane, { fields, values = {}, submit, mode = 'edit', label = '保存', done = () => pane.close() }) {
  const form = renderForm(pane.body, { sections: [{ fields }], values, mode })
  pane.foot.replaceChildren()
  if (mode === 'view') return
  let key = idempotencyKey(), previous
  const save = button(label, async () => {
    const values = form.collect(), fingerprint = JSON.stringify(values)
    if (previous !== fingerprint) key = idempotencyKey()
    previous = fingerprint
    save.disabled = true
    try {
      const res = await submit(values, { idempotencyKey: key })
      pane.changed()
      done(res)
    } catch (e) { form.setNotice(e.message, 'error'); save.disabled = false }
  }, 'primary')
  pane.foot.append(save)
}
