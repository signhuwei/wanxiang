import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { AGENT_LABELS, formatBytes } from './format.js'
import { idempotencyKey } from './idempotency.js'

const path = '/platform/agent-releases'
const agentLabel = agent => AGENT_LABELS[agent] ?? agent
const cacheText = cached => cached ? '已校验并缓存' : '待缓存'
const options = values => values.map(value => ({ value, label: value }))
const select = (key, label, values) => ({ key, label, type: 'select', allowEmpty: false, options: options(values) })
const source = { key: 'url', label: '厂商源地址（供 Server 拉取）', placeholder: 'https://…' }
const fields = [
  { ...select('agent', 'Agent', Object.keys(AGENT_LABELS)), options: Object.entries(AGENT_LABELS).map(([value,label]) => ({ value, label })) }, { key: 'version', label: '版本' },
  select('os', '系统', ['darwin','win32','linux']), select('arch', '架构', ['arm64','x64']), source,
  { key: 'sha256', label: 'SHA-256', wide: true }, { key: 'size', label: '原始大小（字节）', type: 'number' },
]

export function agentReleasesPage(host, api, signal) {
  let list
  const open = detailPanel(host, () => list)
  function show(row) {
    open(row ? agentLabel(row.agent) + ' ' + row.version : '登记 Agent 发行', pane => {
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
        const runtime = record.runtime
        pane.body.classList.remove('child-ledger')
        editForm(pane, { mode: 'view', values: { ...record, size: formatBytes(record.size),
          status_text: record.qualification_required ? '待原生运行验证' : record.status === 'active' ? '已启用' : '未启用',
          cache_text: cacheText(record.artifact_cached),
          runtime_status: cacheText(runtime?.artifact_cached),
          runtime_size: formatBytes(runtime?.size),
          runtime_sha256: runtime?.sha256 }, fields: [
          ...fields, { key: 'status_text', label: '发行状态' }, { key: 'cache_text', label: 'Server 制品' },
          ...(runtime ? [
            { key: 'runtime_status', label: 'Code 引擎缓存' }, { key: 'runtime_size', label: 'Code 引擎大小' },
            { key: 'runtime_sha256', label: 'Code 引擎 SHA-256', wide: true },
          ] : []),
        ] })
        pane.body.append(notice)
        if (record.actions.includes('upload_artifact')) {
          const label = el('label', 'field wide', record.part_bytes ? '原厂完整安装包' : '原始可执行文件或它的 .gz')
          const input = el('input')
          input.type = 'file'
          const upload = button('上传并校验', () => {
            const file = input.files?.[0]
            if (!file) { notify('请选择制品文件', true); return }
            notify('正在上传并校验…')
            return update(upload, async () => {
              const endpoint = detail() + '/artifact'
              if (!record.part_bytes) return api.putBinary(endpoint, file, {
                contentType: file.name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream',
              })
              if (file.size !== record.size) throw new Error('安装包大小与登记值不符')
              const count = Math.ceil(file.size / record.part_bytes)
              for (let part = 0; part < count; part++) {
                notify(`正在上传第 ${part + 1} / ${count} 段…`)
                const result = await api.putBinary(endpoint, file.slice(part * record.part_bytes, (part + 1) * record.part_bytes),
                  { params: { part, revision: record.revision } })
                if (result.artifact_cached) return
              }
              throw new Error('Server 尚未完成整包校验')
            }, 'Server 缓存已就绪')
          })
          label.append(input)
          pane.body.append(label)
          pane.foot.append(upload)
        }
        if (runtime && record.actions.includes('upload_runtime')) {
          const label = el('label', 'field wide', '原厂 Code 引擎（.tar.zst）')
          const input = el('input')
          input.type = 'file'
          input.accept = '.zst'
          const upload = button('上传 Code 引擎', () => {
            const file = input.files?.[0]
            if (!file) { notify('请选择 Code 引擎制品', true); return }
            if (file.size !== runtime.size) { notify('Code 引擎大小与发行要求不符', true); return }
            notify('正在上传并校验 Code 引擎…')
            return update(upload, async () => {
              const result = await api.putBinary(detail() + '/runtime', file, { params: { revision: record.revision } })
              if (!result?.artifact_cached) throw new Error('Server 尚未完成 Code 引擎校验')
            }, 'Code 引擎已校验并缓存')
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
        done: saved => { record = saved; pane.setTitle(agentLabel(record.agent) + ' ' + record.version); render() } })
    })
  }
  list = createLedger(host, {
    title: 'Agent 制品', createLabel: '登记发行', createAction: 'create_agent_release',
    onCreate: () => show(null), onOpen: show, signal, searchLabel: '查询 Agent、版本或系统',
    columns: [
      { key: 'agent', title: 'Agent', render: row => agentLabel(row.agent) }, { key: 'version', title: '版本' },
      { title: '系统 / 架构', render: row => row.os + ' / ' + row.arch },
      { title: 'Server 制品', render: row => {
        if (!row.runtime) return row.artifact_cached ? '已缓存' : '待缓存'
        const bundle = row.artifact_cached ? '安装包已缓存' : '安装包待缓存'
        const engine = row.runtime.artifact_cached ? '引擎已缓存' : '引擎待缓存'
        return bundle + ' · ' + engine
      } },
      { title: '发行状态', render: row => row.qualification_required ? '待原生运行验证' : row.status === 'active' ? '已启用' : '未启用' },
    ],
    fetchPage: ({ q, limit, cursor, signal }) => api.get(path, { params: { q, limit, cursor }, signal }),
  })
}
