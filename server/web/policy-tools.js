import { createLedger } from './ledger.js'
import { button, detailPanel, editForm, el } from './panel.js'
import { AGENT_LABELS, formatBytes } from './format.js'
import { idempotencyKey } from './idempotency.js'

const releasePath = '/platform/tool-releases'
const kindLabels = { skill: 'Skill', mcp: 'MCP（stdio）', hook: 'Hook（PostToolUse）', http_search: 'HTTP 搜索' }
const statusLabels = { draft: '草稿', published: '已发布', disabled: '已停用' }
const systemLabels = { macos: 'macOS', windows: 'Windows' }
const optionList = labels => Object.entries(labels).map(([value, label]) => ({ value, label }))
const maxFiles = 256
const maxFileBytes = 16 * 1024 * 1024
const maxBundleBytes = 24 * 1024 * 1024
const reserved = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i
const pathSegment = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/

const fields = [
  { key: 'name', label: '标识', placeholder: '例如 review-notes' }, { key: 'version', label: '版本', placeholder: '例如 1.0.0' },
  { key: 'kind', label: '类型', type: 'select', options: optionList(kindLabels), allowEmpty: false },
  { key: 'os', label: '系统', type: 'select', options: optionList(systemLabels), allowEmpty: false },
  { key: 'arch', label: '架构', type: 'select', options: optionList({ arm64: 'ARM64', x64: 'x64' }), allowEmpty: false },
  { key: 'entrypoint', label: '启动文件', placeholder: '例如 bin/tool.exe', wide: true },
  { key: 'args', label: '启动参数', hint: '每行一个参数，按行原样传入。', type: 'textarea', wide: true },
]
const searchFields = [
  { key: 'endpoint', label: 'HTTPS 搜索接口', wide: true },
  { key: 'secret', label: '上游 Bearer 凭据', type: 'password', wide: true },
]

export const toolKind = row => kindLabels[row.kind] || row.kind
export const toolTarget = row => row.kind === 'http_search' ? 'Server' : row.os ? `${systemLabels[row.os] || row.os} / ${row.arch}` : '各平台'
export const toolAgents = row => (row.agents || []).map(agent => AGENT_LABELS[agent] || agent).join('、')
const toolStatus = row => statusLabels[row.status] || row.status

function portablePath(path) {
  if (path.length > 240 || path.split('/').some(part => !pathSegment.test(part) || part.endsWith('.') || reserved.test(part))) {
    throw new Error(`文件路径无效：${path || '空路径'}。每段须以英文字母、数字或下划线开头，最长 80 字符，并避开系统保留名称。`)
  }
  return path
}

async function fileBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const blocks = []
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    blocks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  }
  return btoa(blocks.join(''))
}

export async function buildToolBundle(record, files, folder = false) {
  const included = folder ? files.filter(file => file.name !== '.DS_Store') : files
  if (!included.length) throw new Error('请选择包含工具文件的目录或单个文件')
  if (included.length > maxFiles) throw new Error('一个工具最多包含 256 个文件')
  if (included.reduce((total, file) => total + file.size, 0) > maxFileBytes) throw new Error('文件总大小超过 16 MiB')
  const paths = included.map(file => portablePath(folder ? (file.webkitRelativePath || '').split('/').slice(1).join('/') : file.name))
  if (new Set(paths.map(path => path.toLowerCase())).size !== paths.length) throw new Error('目录中有重复的文件路径')
  if (record.kind === 'skill' && !paths.includes('SKILL.md')) throw new Error('工具目录的根层必须包含 SKILL.md')
  if (record.kind !== 'skill' && !paths.includes(record.entrypoint)) throw new Error(`所选文件缺少启动文件 ${record.entrypoint}`)

  const entries = []
  for (const [index, file] of included.entries()) {
    entries.push({ path: paths[index], data: await fileBase64(file) })
  }
  const bundle = new Blob([JSON.stringify({ files: entries })], { type: 'application/json' })
  if (bundle.size > maxBundleBytes) throw new Error('合包大小超过 24 MiB')
  return bundle
}

function createDraft(pane, api, signal, done) {
  const agents = el('fieldset', 'tool-agents')
  agents.append(el('legend', null, '适用 Agent'))
  const selectedAgents = el('input')
  selectedAgents.type = 'hidden'
  selectedAgents.dataset.field = 'selected_agents'
  agents.append(selectedAgents)
  for (const agent of ['claude-code', 'codex', 'kimi-code']) {
    const label = el('label')
    const box = el('input')
    box.type = 'checkbox'
    box.value = agent
    label.append(box, document.createTextNode(AGENT_LABELS[agent]))
    agents.append(label)
  }
  agents.addEventListener('change', () => {
    selectedAgents.value = [...agents.querySelectorAll('input:checked')].map(box => box.value).join(',')
  })
  const createFields = [...fields, ...searchFields]
  editForm(pane, {
    mode: 'create', label: '新建草稿', fields: createFields, values: { kind: 'skill', os: 'macos', arch: 'arm64' },
    submit(value, options) {
      if (!value.selected_agents) throw new Error('请至少选择一个适用 Agent')
      const body = { name: value.name?.trim(), version: value.version?.trim(), kind: value.kind, agents: value.selected_agents.split(',') }
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(body.name ?? '') || reserved.test(body.name)) {
        throw new Error('工具标识使用小写字母、数字和短横线，最多 48 字符，并以字母或数字开头。')
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.version ?? '')) {
        throw new Error('版本使用字母、数字、点、下划线或短横线，最多 64 字符，并以字母或数字开头。')
      }
      if (body.kind === 'http_search') {
        const endpoint = URL.parse(value.endpoint?.trim() ?? '')
        if (!endpoint || endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
          throw new Error('请填写固定 HTTPS 搜索接口地址')
        }
        if (!/^[\x21-\x7e]{1,8192}$/.test(value.secret ?? '')) throw new Error('请填写上游 Bearer 凭据')
        Object.assign(body, { endpoint: endpoint.href, secret: value.secret })
      } else if (body.kind !== 'skill') {
        if (body.kind==='hook' && (value.os!=='macos'||body.agents.length!==1||body.agents[0]!=='claude-code')) throw new Error('Hook 需要选择 macOS 和 Claude Code')
        const entrypoint = value.entrypoint?.trim()
        if (!entrypoint) throw new Error('请填写 工具启动文件的相对路径')
        portablePath(entrypoint)
        if (value.os === 'windows' && !entrypoint.toLowerCase().endsWith('.exe')) throw new Error('Windows 工具启动文件须为 .exe')
        const args = (value.args || '').split(/\r?\n/).filter(arg => arg.length > 0)
        Object.assign(body, { os: value.os, arch: value.arch, entrypoint, args })
      }
      return api.post(releasePath, body, { ...options, signal })
    },
    done,
  })
  for (const { key, label } of createFields) pane.body.querySelector(`[name="${key}"]`).setAttribute('aria-label', label)
  const kind = pane.body.querySelector('[name="kind"]')
  const toggleFields = keys => keys.map(key => {
    const field = pane.body.querySelector(`[name="${key}"]`).closest('.field')
    field.classList.add('tool-draft-field')
    return field
  })
  const mcpFields = toggleFields(['os', 'arch', 'entrypoint', 'args'])
  const hostedFields = toggleFields(searchFields.map(field => field.key))
  function selectKind() {
    for (const field of mcpFields) field.hidden = ['skill', 'http_search'].includes(kind.value)
    for (const field of hostedFields) field.hidden = kind.value !== 'http_search'
  }
  kind.addEventListener('change', selectKind)
  selectKind()
  pane.body.append(agents)
}

export function platformToolsPage(host, api, signal) {
  let list
  const open = detailPanel(host, () => list)

  function show(row) {
    open(row ? `${row.name} · ${row.version}` : '新建工具发行', async pane => {
      let record = row
      let pending = false
      const endpoint = () => `${releasePath}/${encodeURIComponent(record.id)}`
      const notice = el('p', 'notice')
      notice.setAttribute('role', 'status')
      function notify(message, error = false) {
        notice.textContent = message
        notice.className = error ? 'notice error' : 'notice'
      }

      async function mutate(operation, working, complete) {
        if (pending) return
        pending = true
        const controls = [...pane.foot.querySelectorAll('button'), ...pane.body.querySelectorAll('input')]
        controls.forEach(control => { control.disabled = true })
        notify(working)
        try {
          const saved = await operation()
          record = saved?.id === record.id ? saved : await api.get(endpoint(), { signal })
          pane.changed()
          if (pane.body.isConnected) render(complete)
        } catch (error) {
          if (signal.aborted || !pane.body.isConnected) return
          if (error.status === 409 || error.status === 0) {
            try {
              const latest = await api.get(endpoint(), { signal })
              if (latest.revision !== record.revision) {
                record = latest
                pane.changed()
                render('已重新读取当前发行，请核对状态。')
                return
              }
            } catch { /* Keep the current form and report the original error. */ }
          }
          notify(error.message, true)
        } finally {
          pending = false
          controls.forEach(control => { control.disabled = false })
        }
      }

      function uploadControls() {
        const inputs = el('div', 'form-grid')
        const selection = el('p', 'muted')
        function input(labelText, folder) {
          const label = el('label', 'field wide', labelText)
          const picker = el('input')
          picker.type = 'file'
          if (folder) picker.setAttribute('webkitdirectory', '')
          label.append(picker)
          inputs.append(label)
          return picker
        }
        const fileInput = input('单个文件', false)
        const folderInput = input('工具目录', true)
        for (const [picker, other] of [[fileInput, folderInput], [folderInput, fileInput]]) {
          picker.addEventListener('change', () => {
            if (picker.files.length) other.value = ''
            const ignored = [...folderInput.files].filter(file => file.name === '.DS_Store').length
            const count = fileInput.files.length + folderInput.files.length - ignored
            selection.textContent = (count ? `已选择 ${count} 个工具文件。` : '') + (ignored ? `已排除 ${ignored} 个 .DS_Store 系统文件。` : '')
          })
        }
        pane.body.append(el('h3', null, '工具文件'), el('p', 'muted', record.kind === 'skill'
          ? '选择 SKILL.md，或选择以 SKILL.md 为根层文件的目录。'
          : '选择启动文件，或选择包含启动文件及其依赖的目录。'), inputs, selection)
        pane.foot.append(button('上传并校验', () => mutate(async () => {
          const folder = folderInput.files.length > 0
          const bundle = await buildToolBundle(record, [...(folder ? folderInput.files : fileInput.files)], folder)
          return api.putBinary(`${endpoint()}/artifact`, bundle, { contentType: 'application/json', params: { revision: record.revision }, signal })
        }, '正在合包并上传…', '工具文件已校验。')))
      }

      function render(message = '') {
        editForm(pane, {
          mode: 'view',
          fields: [
            ...fields.filter(field => !['skill', 'http_search'].includes(record.kind) || ['name', 'version', 'kind'].includes(field.key)),
            { key: 'agentLabels', label: '适用 Agent', wide: true }, { key: 'statusLabel', label: '状态' },
            ...(record.kind === 'http_search'
              ? [searchFields[0], { key: 'keyStatus', label: '凭据' }]
              : [{ key: 'sizeLabel', label: '制品大小' }, { key: 'sha256', label: 'SHA-256', wide: true }]),
          ],
          values: { ...record, args: record.args?.join('、'), agentLabels: toolAgents(record), statusLabel: toolStatus(record),
            sizeLabel: formatBytes(record.size), keyStatus: record.has_key ? '已配置' : '待配置' },
        })
        notify(message)
        pane.body.append(notice)
        if (record.actions.includes('upload')) uploadControls()
        for (const [action, label, complete] of [['publish', '发布', '工具已发布。'], ['disable', '停用', '工具已停用。']]) {
          if (!record.actions.includes(action)) continue
          pane.foot.append(button(label, () => mutate(() => api.post(`${endpoint()}/${action}`, { revision: record.revision }, {
            idempotencyKey: idempotencyKey(), signal,
          }), '正在保存…', complete), action === 'publish' ? 'primary' : null))
        }
      }

      if (record) {
        pane.body.append(el('p', 'muted', '正在读取发行…'))
        record = await api.get(endpoint(), { signal })
        if (pane.body.isConnected) render()
      } else createDraft(pane, api, signal, saved => {
        if (!pane.body.isConnected) return
        record = saved
        pane.setTitle(`${record.name} · ${record.version}`)
        render()
      })
    })
  }

  list = createLedger(host, {
    title: '工具发行', createAction: 'create_tool_release', createLabel: '新建工具发行', onCreate: () => show(null),
    onOpen: show, signal, searchLabel: '查询工具名称或版本',
    columns: [
      { key: 'name', title: '工具' }, { key: 'version', title: '版本' },
      { title: '类型', render: toolKind }, { title: '适用 Agent', render: toolAgents },
      { title: '平台', render: toolTarget }, { title: '状态', render: toolStatus },
    ],
    fetchPage: ({ q, limit, cursor, signal }) => api.get(releasePath, { params: { q, limit, cursor }, signal }),
  })
}
