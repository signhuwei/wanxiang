// 轻提示：底部居中，自动消失。

let timer = null

export function showToast(text, kind = 'info') {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = text
  el.className = kind === 'error' ? 'error' : ''
  el.hidden = false
  clearTimeout(timer)
  timer = setTimeout(() => { el.hidden = true }, 3500)
}
