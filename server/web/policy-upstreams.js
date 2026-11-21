import { createLedger } from './ledger.js'
import { detailPanel, editForm } from './panel.js'
import { fetchPolicyPage, tenantPolicy } from './policy-controls.js'

export function upstreamPage(host, api, signal) {
  const endpoint = tenantPolicy + '/upstreams'
  let ledger
  const open = detailPanel(host, () => ledger)
  function show(row) {
    open(row?.name ?? '新建自有上游', async pane => {
      const models = []
      let cursor
      do {
        const page = await api.get(tenantPolicy + '/catalog/models', { params: { cursor, limit: 200 }, signal })
        models.push(...page.items.map(item => ({ value: item.id, label: item.label })))
        cursor = page.next_cursor
      } while (cursor && !signal.aborted)
      if (row && !models.some(model => model.value === row.model_id)) models.push({ value: row.model_id, label: row.model_id })
      const mode = row && !row.actions.includes('update') ? 'view' : row ? 'edit' : 'create'
      editForm(pane, {
        mode, values: row ?? { priority: 0, status: 'active' }, fields: [
          { key: 'name', label: '上游名称' }, { key: 'model_id', label: '签约模型', type: 'select', options: models, allowEmpty: false },
          { key: 'upstream_name', label: '上游模型名' }, { key: 'base_url', label: 'HTTPS 服务地址' },
          { key: 'priority', label: '优先级', type: 'number', hint: '数值小的优先。平台上游为 100，同值时平台优先。' },
          { key: 'status', label: '状态', type: 'select', allowEmpty: false, options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }] },
          { key: 'secret', label: row ? '更换密钥（留空保留原密钥）' : '上游密钥', type: 'password' }],
        submit: (body, options) => {
          if (row && !body.secret) delete body.secret
          body.expected_revision = row?.revision ?? 0
          return row ? api.put(endpoint + '/' + encodeURIComponent(row.id), body, { ...options, signal }) : api.post(endpoint, body, { ...options, signal })
        }
      })
    })
  }
  ledger = createLedger(host, {
    title: '自有上游', rowKey: 'id', createAction: 'create', createLabel: '新建上游', signal,
    columns: [{ key: 'name', title: '上游' }, { key: 'model_id', title: '签约模型' }, { key: 'upstream_name', title: '原生模型名' },
    { key: 'priority', title: '优先级' }, { title: '状态', render: row => row.status === 'active' ? '启用' : '停用' }],
    fetchPage: fetchPolicyPage(api, endpoint), onCreate: () => show(null), onOpen: show
  })
}
