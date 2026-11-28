import { el, button } from './panel.js'
import { agentLabel, AGENT_OPTIONS, formatMilli } from './format.js'

const columns = [['active_people', '活跃人数'], ['sessions', '新会话'], ['events', '会话事件'], ['turns', '对话轮数'], ['requests', '模型请求'],
  ['input_tokens', '输入 token'], ['output_tokens', '输出 token'], ['cached_tokens', '缓存 token'],
  ['cost_milli', '橡皮（粒）'], ['pending_usage', '待结算笔数']]
const snapshotTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' })
const number = new Intl.NumberFormat('zh-CN')
const metric = (key, value) => key === 'cost_milli' ? formatMilli(value ?? 0) : number.format(value ?? 0)

function table(label, dimension, rows, format) {
  const section = el('section', 'statistics-table')
  section.append(el('h2', null, label))
  if (!rows.length) {
    section.append(el('p', 'muted', '此区间暂无活动'))
    return section
  }
  const container = el('div', 'statistics-scroll')
  const grid = el('table')
  const head = el('thead'), header = el('tr')
  for (const title of [dimension, ...columns.map(column => column[1])]) {
    const cell = el('th', null, title)
    cell.scope = 'col'
    header.append(cell)
  }
  head.append(header)
  const body = el('tbody')
  for (const record of rows) {
    const row = el('tr')
    const name = el('th', null, format(record))
    name.scope = 'row'
    row.append(name, ...columns.map(([key]) => el('td', null, metric(key, record[key]))))
    body.append(row)
  }
  grid.append(head, body)
  container.append(grid)
  section.append(container)
  return section
}

export function statisticsPage(host, api, signal) {
  host.classList.add('page')
  host.append(el('h1', null, '监察统计'))
  const form = el('form', 'statistics-filters')
  function input(label) {
    const field = el('label', null, label), control = el('input')
    control.type = 'date'
    field.append(control)
    form.append(field)
    return control
  }
  const from = input('开始日期'), to = input('结束日期')
  const agentLabelField = el('label', null, 'Agent'), agent = el('select')
  agent.setAttribute('aria-label', 'Agent')
  for (const item of [{ value: '', label: '全部 Agent' }, ...AGENT_OPTIONS, { value: 'unknown', label: '未归属' }]) {
    const option = el('option', null, item.label)
    option.value = item.value
    agent.append(option)
  }
  agentLabelField.append(agent)
  const submit = el('button', 'primary', '查询')
  submit.type = 'submit'
  const exportButton = button('导出 Parquet', download)
  exportButton.type = 'button'
  exportButton.hidden = true
  form.append(agentLabelField, submit, exportButton)
  const status = el('p', 'muted')
  status.setAttribute('role', 'status')
  const content = el('div', 'statistics-content')
  host.append(form, status, content)
  let selected
  const filters = () => ({ from: from.value, to: to.value, agent: agent.value })
  form.addEventListener('submit', event => { event.preventDefault(); void load() })
  async function load() {
    submit.disabled = exportButton.disabled = true
    status.textContent = '正在读取统计…'
    try {
      const data = await api.get('/observe/statistics', { params: filters(), signal })
      if (signal.aborted) return
      from.value = data.from
      to.value = data.to
      selected = { from: data.from, to: data.to, agent: data.agent }
      exportButton.hidden = !data.actions.includes('export_parquet')
      const totals = el('dl', 'statistics-totals')
      for (const [key, label] of columns) {
        const item = el('div')
        item.append(el('dt', null, label), el('dd', null, metric(key, data.totals[key])))
        totals.append(item)
      }
      status.textContent = '北京时间 · 数据截至 ' + snapshotTime.format(new Date(data.as_of))
      content.replaceChildren(totals,
        table('每日统计', '日期', data.daily, row => row.day),
        table('按 Agent 统计', 'Agent', data.agents, row => row.agent === 'unknown' ? '未归属' : agentLabel(row.agent)))
    } catch(error) {
      if (!signal.aborted) status.textContent = error.message
    } finally { submit.disabled = exportButton.disabled = false }
  }
  async function download() {
    if (!selected) return
    const original = selected
    exportButton.disabled = true
    try {
      const blob = await api.download('/observe/statistics/parquet', { params: original, signal })
      if (signal.aborted) return
      const url = URL.createObjectURL(blob)
      const link = el('a')
      link.href = url
      link.download = `OneX-statistics-${original.from}-${original.to}.parquet`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch(error) {
      if (!signal.aborted) status.textContent = error.message
    } finally { exportButton.disabled = false }
  }
  void load()
}
