import { createLedger } from './ledger.js'
import { button, detailPanel, el } from './panel.js'
import { formatBytes, formatDateTime } from './format.js'
import { idempotencyKey } from './idempotency.js'

const releases = '/platform/server-releases'
const deployment = '/platform/maintenance'
const state = { queued: '待执行', running: '部署中', succeeded: '已通过健康检查', failed: '失败' }

function field(label, value) {
  const row = el('span')
  row.append(el('span', null, label), document.createTextNode(String(value ?? '—')))
  return row
}
function fileField(label, accept) {
  const row = el('label', 'field wide')
  const input = el('input')
  input.type = 'file'
  input.accept = accept
  row.append(el('span', null, label), input)
  return { row, input }
}

export function serverReleasesPage(host, api, signal) {
  const tools = el('div', 'toolbar')
  const current = el('span', 'muted', '正在读取当前版本…')
  const edge = el('a', 'keep', 'Edge 安装包')
  edge.href = '#/platform/releases'
  const schema = el('a', 'keep', 'API')
  schema.href = '/v1/openapi.json'
  schema.target = '_blank'
  schema.rel = 'noopener'
  tools.append(current, el('span', 'grow'), edge, schema)
  host.append(tools)
  let list
  const open = detailPanel(host, () => list)
  const updateSummary = async () => {
    try {
      const info = await api.get(deployment, { signal })
      current.textContent = '运行版本 ' + info.active_commit + (info.runner_ready ? ' · 升级服务就绪' : ' · 升级服务暂不可用')
      return info
    } catch (error) {
      if (!signal?.aborted) current.textContent = '无法读取当前版本'
      throw error
    }
  }
  function show(row) {
    open(row ? 'Server 版本 ' + row.commit.slice(0, 12) : '上传 Server 发布包', pane => {
      let retry
      const detailPath = commit => releases + '/' + encodeURIComponent(commit)
      const message = el('div', 'notice')
      const showError = error => {
        message.className = 'notice error'
        message.textContent = error?.message || '操作失败'
      }
      function render(record) {
        pane.body.replaceChildren()
        pane.foot.replaceChildren()
        const data = el('div', 'kv')
        data.append(field('提交', record.commit), field('SHA-256', record.sha256), field('大小', formatBytes(record.size)),
          field('制品', record.uploaded_at ? '已校验' : '等待上传'), field('上传时间', formatDateTime(record.uploaded_at)))
        if (record.last_rollout) {
          const job = record.last_rollout
          data.append(field('最近部署', state[job.status]), field('任务 ID', job.id), field('检测到的版本', job.observed_commit))
          if (job.error_code) data.append(field('失败原因', job.error_code))
        }
        pane.body.append(data, message)
        if (record.actions.includes('upload_artifact')) upload(record)
        if (record.actions.includes('deploy')) {
          const submit = button(record.active ? '验证当前版本' : '部署到 Server', async () => {
            submit.disabled = true
            try {
              const info = await updateSummary()
              retry ??= { expected_commit: info.active_commit, key: idempotencyKey() }
              const job = await api.post(detailPath(record.commit) + '/deploy',
                { expected_commit: retry.expected_commit }, { idempotencyKey: retry.key })
              retry = null
              pane.changed()
              render({ ...record, actions: ['read'], last_rollout: job })
            } catch (error) {
              if (error?.status === 409) retry = null
              showError(error)
            } finally {
              submit.disabled = false
            }
          }, 'primary')
          pane.foot.append(submit)
        }
        if (record.last_rollout && ['queued', 'running'].includes(record.last_rollout.status)) {
          setTimeout(async () => {
            if (signal?.aborted || !pane.body.isConnected) return
            try {
              const fresh = await api.get(detailPath(record.commit), { signal })
              if (pane.body.isConnected) {
                render(fresh)
                pane.changed()
              }
              void updateSummary().catch(() => {})
            } catch {
              if (pane.body.isConnected) render(record)
            }
          }, 3000)
        }
      }
      function upload(record) {
        const archive = fileField('Server 制品（.tar.gz）', '.gz,application/gzip')
        const send = button('上传并校验', async () => {
          if (!archive.input.files?.[0]) return showError(new Error('请选择 Server 制品'))
          await sendFile(record, archive.input.files[0], send)
        }, 'primary')
        pane.body.append(archive.row)
        pane.foot.append(send)
      }
      async function sendFile(record, file, control) {
        control.disabled = true
        message.className = 'notice'
        message.textContent = '正在上传…'
        try {
          const saved = await api.putBinary(detailPath(record.commit) + '/artifact', file)
          message.textContent = '上传完成，大小及 SHA-256 校验通过'
          pane.changed()
          render(saved)
        } catch (error) {
          render(record)
          showError(error)
        } finally {
          control.disabled = false
        }
      }
      if (row) {
        render(row)
        return
      }
      const manifest = fileField('签名清单（.json）', '.json,application/json')
      const archive = fileField('Server 制品（.tar.gz）', '.gz,application/gzip')
      const send = button('上传并校验', async () => {
        const metadata = manifest.input.files?.[0]
        const file = archive.input.files?.[0]
        if (!metadata || !file || metadata.size > 8192) return showError(new Error('请选择签名清单和 Server 制品'))
        send.disabled = true
        try {
          const signed = JSON.parse(await metadata.text())
          const record = await api.post(releases, signed)
          pane.changed()
          await sendFile(record, file, send)
        } catch (error) {
          showError(error)
        } finally {
          send.disabled = false
        }
      }, 'primary')
      pane.body.append(manifest.row, archive.row, message)
      pane.foot.append(send)
    })
  }
  list = createLedger(host, {
    title: 'Server 升级',
    columns: [
      { title: '提交', render: row => row.commit.slice(0, 12) },
      { title: '制品', render: row => row.uploaded_at ? '已校验' : '等待上传' },
      { title: '部署状态', render: row => row.active ? '运行中' : state[row.last_rollout?.status] ?? '—' },
      { title: '上传时间', render: row => formatDateTime(row.uploaded_at) }
    ],
    fetchPage: ({ q, limit, cursor, signal }) => api.get(releases, { params: { q, limit, cursor }, signal }),
    onOpen: show, onCreate: () => show(null), createAction: 'create_server_release', createLabel: '上传发布包',
    searchLabel: '按提交查询', signal
  })
  void updateSummary().catch(() => {})
}
