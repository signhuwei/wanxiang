import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { formatBytes } from './format.js'
import { idempotencyKey } from './idempotency.js'

const path = '/platform/agent-releases'
const options = values => values.map(value => ({ value, label: value }))
const select = (key, label, values) => ({ key, label, type: 'select', allowEmpty: false, options: options(values) })
const source = { key: 'url', label: '厂商源地址（供 Server 拉取）', placeholder: 'https://…' }
const fields = [
  select('agent', 'Agent', ['claude-code','codex','kimi-code']), { key: 'version', label: '版本' },
  select('os', '系统', ['darwin','win32','linux']), select('arch', '架构', ['arm64','x64']), source,
  { key: 'sha256', label: 'SHA-256', wide: true }, { key: 'size', label: '原始大小（字节）', type: 'number' },
]

export function agentReleasesPage(host, api, signal) {
  let list
  const open = detailPanel(host, () => list)
  function show(row) {
    open(row ? row.agent + ' ' + row.version : '登记 Agent 发行', pane => {
      let record = row
      const detail = () => path + '/' + encodeURIComponent(record.id)
      const notice = el('div', 'notice')
      const notify = (message, failure = false) => {
        notice.textContent = message
        notice.className = failure ? 'notice error' : 'notice'
      }
      const update = async (control, operation, message) => {
        control.disabled = true
        try {
          await operation()
          record = await api.get(detail())
          pane.changed()
          notify(message)
          render()
        } catch (error) {
          notify(error?.detail?.reason === 'source_unavailable' ? '厂商地址无法拉取，可以改用手动上传' : error.message, true)
        } finally { control.disabled = false }
      }
      function render() {
        pane.body.classList.remove('child-ledger')
        editForm(pane, { mode: 'view', values: { ...record, size: formatBytes(record.size),
          status_text: record.status === 'active' ? '已启用' : '未启用',
          cache_text: record.artifact_cached ? '已校验并缓存' : '待缓存' }, fields: [
          ...fields, { key: 'status_text', label: '发行状态' }, { key: 'cache_text', label: 'Server 制品' },
        ] })
        pane.body.append(notice)
        if (record.actions.includes('upload_artifact')) {
          const label = el('label', 'field wide', '原始可执行文件或它的 .gz')
          const input = el('input')
          input.type = 'file'
          const upload = button('上传并校验', () => {
            const file = input.files?.[0]
            if (!file) { notify('请选择制品文件', true); return }
            notify('正在上传并校验…')
            return update(upload, () => api.putBinary(detail() + '/artifact', file, {
              contentType: file.name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
            }), 'Server 缓存已就绪')
          })
          label.append(input)
          pane.body.append(label)
          pane.foot.append(upload)
        }
        if (record.actions.includes('pull_artifact')) {
          const pull = button('从官方源拉取', () => {
            notify('正在从官方源拉取…')
            return update(pull, () => api.post(detail() + '/pull', {}), 'Server 缓存已就绪')
          })
          pane.foot.append(pull)
        }
        for (const [action, status, label] of [['activate','active','启用'], ['disable','disabled','停用']]) {
          if (!record.actions.includes(action)) continue
          const control = button(label, () => update(control, () => api.post(detail(), {
            status, revision: record.revision,
          }, { idempotencyKey: idempotencyKey() }), '发行状态已更新'), action === 'activate' ? 'primary' : '')
          pane.foot.append(control)
        }
        if (record.actions.includes('update')) pane.foot.append(button('编辑来源', () => {
          editForm(pane, { mode: 'edit', fields: [source], values: record,
            submit: (value, opts) => api.post(detail(), { ...value, revision: record.revision }, opts),
            done: saved => { record = saved; notify('来源已保存'); render() } })
        }))
      }
      if (row) render()
      else editForm(pane, { mode: 'create', fields, values: { agent: 'claude-code', os:'darwin', arch:'arm64' },
        submit: (value, opts) => api.post(path, { ...value, status: 'disabled' }, opts),
        done: saved => { record = saved; pane.setTitle(record.agent + ' ' + record.version); render() } })
    })
  }
  list = createLedger(host, {
    title: 'Agent 制品', createLabel: '登记发行', createAction: 'create_agent_release',
    onCreate: () => show(null), onOpen: show, signal, searchLabel: '查询 Agent、版本或系统',
    columns: [
      { key: 'agent', title: 'Agent' }, { key: 'version', title: '版本' },
      { title: '系统 / 架构', render: row => row.os + ' / ' + row.arch },
      { title: 'Server 制品', render: row => row.artifact_cached ? '已缓存' : '待缓存' },
      { title: '发行状态', render: row => row.status === 'active' ? '已启用' : '未启用' },
    ],
    fetchPage: ({ q, limit, cursor, signal }) => api.get(path, { params: { q, limit, cursor }, signal }),
  })
}
