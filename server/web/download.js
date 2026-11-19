// 员工下载入口：独立于管理端，不登录、不触碰 onex.session* 存储，只读 GET /v1/desktop-releases。
// 页面本身只拿摘要（id、版本、大小、sha256、published_at、download_url），点击下载走浏览器原生跳转，
// 脚本不持有安装包字节。契约见 contracts/desktop-releases.md「员工入口」。

import { formatBytes, DESKTOP_OS_LABELS } from './format.js'

function el(tag, className, text) {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

// 粗略识别当前系统，仅用于默认选中；用户始终可以手动切换。
export function detectOs(userAgent) {
  const ua = String(userAgent || '')
  if (/Mac OS X|Macintosh/i.test(ua)) return 'darwin'
  if (/Windows/i.test(ua)) return 'windows'
  return null
}

// 识别到的系统即使当前没有发布版本也应作为默认选中项（展示该平台的空态），
// 不能静默换成另一个平台——用户要能清楚看到“识别到 Windows 但只有 Mac 包”，再自己切换。
const KNOWN_OS = ['darwin', 'windows']
export function pickDefault(items, os) {
  if (os && KNOWN_OS.includes(os)) return os
  return items[0]?.os ?? KNOWN_OS[0]
}

// 只接受同源、指向本资源真实下载路由的链接，不接受外部地址或携带凭据的 URL。
export function sameOriginDownloadUrl(value, id, base) {
  if (typeof value !== 'string' || !value.trim()) return null
  let u
  try { u = new URL(value, base) } catch { return null }
  if (u.origin !== new URL(base).origin || u.username || u.password || u.search || u.hash) return null
  const expected = new URL('/v1/desktop-releases/' + encodeURIComponent(id) + '/download', base)
  return u.pathname === expected.pathname ? u.href : null
}

export async function render(host, { fetchImpl = globalThis.fetch, userAgent = globalThis.navigator?.userAgent } = {}) {
  host.textContent = ''
  const panel = el('div', 'download-panel')
  panel.append(el('h1', null, '万象 OneX 桌面安装包'))
  const status = el('p', 'muted', '正在加载可用版本…')
  panel.appendChild(status)
  host.appendChild(panel)

  let items = []
  try {
    const res = await fetchImpl('/v1/desktop-releases')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    items = data.items || []
  } catch {
    status.textContent = '加载失败，请刷新页面重试'
    status.className = 'error-row'
    return
  }

  if (!items.length) {
    status.textContent = '暂无已发布的安装包'
    status.className = 'empty'
    return
  }
  status.remove()

  const detected = detectOs(userAgent)
  // 平台选项固定为两个已知平台，不只是当前有发布的平台：识别到 Windows 但只有 Mac 包时，
  // 仍要默认停在 Windows 标签上显示“暂无”，而不是悄悄换到 Mac。
  const platforms = KNOWN_OS.filter(os => os === detected || items.some(i => i.os === os))
  let selectedOs = pickDefault(items, detected)
  if (!platforms.includes(selectedOs)) selectedOs = platforms[0]

  const osRow = el('div', 'download-os-row')
  const osButtons = {}
  for (const os of platforms) {
    const btn = el('button', os === selectedOs ? 'active' : '', DESKTOP_OS_LABELS[os] || os)
    btn.addEventListener('click', () => { selectedOs = os; paint() })
    osButtons[os] = btn
    osRow.appendChild(btn)
  }
  panel.appendChild(osRow)

  const card = el('div', 'download-card')
  panel.appendChild(card)
  if (!detected) panel.appendChild(el('p', 'muted', '未能识别你的系统，请手动选择平台'))

  function paint() {
    for (const [os, btn] of Object.entries(osButtons)) btn.classList.toggle('active', os === selectedOs)
    const candidates = items.filter(i => i.os === selectedOs)
    card.textContent = ''
    if (!candidates.length) {
      card.appendChild(el('p', 'empty', '该平台暂无已发布的安装包'))
      return
    }
    const item = candidates[0]
    const href = sameOriginDownloadUrl(item.download_url, item.id, location.href)
    card.appendChild(el('div', 'row-title', item.version + ' · ' + (item.arch || '')))
    card.appendChild(el('p', 'muted', formatBytes(item.size) + ' · SHA-256 ' + (item.sha256 ? item.sha256.slice(0, 16) + '…' : '—')))
    if (!href) {
      card.appendChild(el('p', 'error-row', '下载地址无效，请刷新页面重试'))
      return
    }
    const link = el('a', 'primary button-like', '下载')
    link.href = href
    card.appendChild(link)
  }
  paint()
}
