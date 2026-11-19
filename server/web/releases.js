// 安装包发布：平台管理员台账 + 钻取。契约见 contracts/desktop-releases.md。
// 草稿 → 上传安装包校验（服务端算 SHA-256、查字节数与格式）→ 发布；同平台发布新版本会把原当前版本转为已下架。

import { createLedger } from './ledger.js'
import { detailPanel, editForm, el, button } from './panel.js'
import { ApiError } from './api.js'
import { formatDateTime, formatBytes, DESKTOP_RELEASE_STATUS, DESKTOP_OS_LABELS } from './format.js'
import { idempotencyKey } from './idempotency.js'

const PATH = '/platform/desktop-releases'
export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024 // 契约 S2 单包上限

// 契约 S2 阶段每个平台只对应一种架构，新建时按平台直接派生架构，不给出可能拼出无效组合的架构下拉。
const OS_OPTIONS = [{ value: 'darwin', label: 'macOS' }, { value: 'windows', label: 'Windows' }]
const ARCH_FOR_OS = { darwin: 'arm64', windows: 'x64' }

export function statusLabel(status) {
  return DESKTOP_RELEASE_STATUS[status] ?? status ?? '—'
}
export function platformLabel(item) {
  return (DESKTOP_OS_LABELS[item.os] ?? item.os) + ' / ' + item.arch
}
export function shortSha256(sha256) {
  if (!sha256) return '—'
  return sha256.slice(0, 12) + '…'
}

// 文件名在页面层做一次形状检查（扩展名、大小），服务端才是权威校验（XAR/PE 格式、容量上限、SHA-256）。
export function validateArtifactFile(os, file) {
  if (!file) return '请选择安装包文件'
  if (file.size > MAX_ARTIFACT_BYTES) return '文件超过单包上限 256 MiB'
  const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase()
  if (os === 'darwin' && ext !== '.pkg') return 'macOS 安装包须为 .pkg'
  if (os === 'windows' && ext !== '.exe') return 'Windows 安装器须为 .exe'
  return null
}

const createFields = [
  { key: 'version', label: '版本号', placeholder: '如 1.4.0 或 1.4.0-beta.1' },
  { key: 'os', label: '平台', type: 'select', allowEmpty: false, options: OS_OPTIONS }
]

export function releasesPage(host, api, actions) {
  let list
  const open = detailPanel(host, () => list)

  function show(row) {
    open(row ? row.version + ' · ' + platformLabel(row) : '新建安装包发布', pane => {
      let record = row
      function renderDetail(message) {
        pane.body.replaceChildren()
        pane.foot.replaceChildren()
        const kv = el('div', 'kv')
        kv.append(
          kvItem('平台', platformLabel(record)),
          kvItem('状态', statusLabel(record.status)),
          kvItem('大小', formatBytes(record.size)),
          kvItem('SHA-256', record.sha256 || '—'),
          kvItem('发布时间', formatDateTime(record.published_at))
        )
        pane.body.appendChild(kv)
        const notice = el('div', 'notice')
        if (message) { notice.textContent = message.text; notice.className = 'notice ' + (message.kind || '') }
        pane.body.appendChild(notice)

        if (record.actions.includes('upload_artifact')) renderUpload(notice)
        const footButtons = []
        if (record.actions.includes('publish')) footButtons.push(button('发布', () => runAction('publish'), 'primary'))
        if (record.actions.includes('unpublish')) footButtons.push(button('下架', () => runAction('unpublish')))
        pane.foot.append(...footButtons)
      }

      function kvItem(label, value) {
        const wrap = el('span')
        wrap.append(el('span', null, label), document.createTextNode(String(value)))
        return wrap
      }

      function renderUpload(notice) {
        const row = el('div', 'field wide')
        const input = el('input')
        input.type = 'file'
        input.setAttribute('aria-label', '安装包文件')
        const upload = button(record.size == null ? '上传' : '重新上传', async () => {
          const file = input.files && input.files[0]
          const invalid = validateArtifactFile(record.os, file)
          if (invalid) { notice.textContent = invalid; notice.className = 'notice error'; return }
          upload.disabled = true
          notice.textContent = '正在上传…'
          notice.className = 'notice'
          try {
            // 直接把 File 交给 fetch 做请求体，不先 arrayBuffer()，避免把最大 256 MiB 的包整体复制进内存。
            record = await api.putBinary(PATH + '/' + encodeURIComponent(record.id) + '/artifact', file, { params: { revision: record.revision } })
            pane.changed()
            renderDetail({ text: '上传完成，已通过校验' })
          } catch (e) {
            // 上传中断或失败时结果未知：重新读取草稿当前修订与摘要，不假设已验证。
            await refetchAfterFailure()
            renderDetail({ text: describeError(e), kind: 'error' })
          }
        }, 'primary')
        row.append(input, upload)
        pane.body.appendChild(row)
      }

      async function runAction(verb) {
        try {
          record = await api.post(PATH + '/' + encodeURIComponent(record.id) + '/' + verb, { revision: record.revision }, { idempotencyKey: idempotencyKey() })
          pane.changed()
          renderDetail()
        } catch (e) {
          let message = describeError(e)
          if (e instanceof ApiError && e.code === 'conflict') {
            // 修订已过期：重新读取当前记录再展示，同时让列表在关闭详情后刷新这一行。
            await refetchAfterFailure()
            message = describeError(e)
          }
          renderDetail({ text: message, kind: 'error' })
        }
      }

      async function refetchAfterFailure() {
        try { record = await api.get(PATH + '/' + encodeURIComponent(record.id)) } catch { /* 保留旧记录展示 */ }
        pane.changed()
      }

      function describeError(e) {
        if (e instanceof ApiError && e.code === 'conflict') return '该记录已被更新（修订已过期），已刷新为最新状态，请核对后重试'
        return (e && e.message) || '操作失败'
      }

      if (record) { renderDetail(); return }

      // 新建：先建草稿，成功后立即展示上传入口
      editForm(pane, { mode: 'create', label: '新建草稿', fields: createFields,
        submit: (v, opts) => api.post(PATH, { ...v, arch: ARCH_FOR_OS[v.os] }, opts),
        done: res => { record = res; renderDetail() } })
    })
  }

  list = createLedger(host, {
    title: '安装包发布',
    columns: [
      { key: 'version', title: '版本号' },
      { key: 'platform', title: '平台', render: platformLabel },
      { key: 'status', title: '状态', render: i => statusLabel(i.status) },
      { key: 'size', title: '大小', render: i => formatBytes(i.size) },
      { key: 'sha256', title: 'SHA-256', render: i => shortSha256(i.sha256) },
      { key: 'published_at', title: '发布时间', render: i => formatDateTime(i.published_at) }
    ],
    createLabel: '新建发布',
    onCreate: actions.includes('create_desktop_release') ? () => show(null) : null,
    onOpen: show,
    openAction: 'read',
    fetchPage: ({ q, cursor, limit, signal }) => api.get(PATH, { params: { q, cursor, limit }, signal })
  })
}
