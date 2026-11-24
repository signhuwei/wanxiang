import { createLedger } from './ledger.js'
import { detailPanel, editForm, el } from './panel.js'

const capabilityNames = {
  text: '文本', images: '图片', function_tools: '函数工具', json_schema: '结构化输出', reasoning: '推理'
}
const makerLabels = { alibaba: '阿里巴巴', anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google',
  minimax: 'MiniMax', moonshotai: '月之暗面', openai: 'OpenAI', zhipuai: '智谱' }
const nameOf = id => makerLabels[id] ?? id
const capabilities = row => row.capabilities_claim.map(id => capabilityNames[id] ?? id).join('、') || '上游未声明'

export async function modelReferencesPage(host, api, signal) {
  host.replaceChildren(el('p', 'muted', '正在加载型号码表…'))
  let makers
  try {
    ({ makers } = await api.get('/platform/model-references', { params: { limit: 1 }, signal }))
  } catch (error) {
    if (!signal.aborted) host.replaceChildren(el('p', 'error-row', error.message))
    return
  }
  if (signal.aborted) return
  host.replaceChildren()
  let table
  const open = detailPanel(host, () => table)
  table = createLedger(host, {
    title: '型号码表', searchLabel: '查询型号或别名', signal,
    filters: [{ key: 'maker_id', label: '按原厂筛选', options: [
      { value: '', label: '全部原厂' }, ...makers.map(id => ({ value: id, label: nameOf(id) }))
    ] }],
    columns: [
      { title: '原厂', render: row => nameOf(row.maker_id) },
      { key: 'display_name', title: '参考型号' },
      { key: 'model_variant', title: '变体' },
      { key: 'context_tokens', title: '参考上下文 Token' },
      { title: '参考能力', render: capabilities }
    ],
    fetchPage: opts => api.get('/platform/model-references', {
      params: { q: opts.q, maker_id: opts.filters.maker_id, cursor: opts.cursor, limit: opts.limit }, signal: opts.signal
    }),
    onOpen: row => open(row.display_name, pane => {
      editForm(pane, { mode: 'view', values: { ...row, maker_id: nameOf(row.maker_id),
        capabilities: capabilities(row), aliases: row.aliases.join('、'), scope: row.provider_names.join('、') || '通用参考' }, fields: [
        { key: 'maker_id', label: '原厂' }, { key: 'model_family', label: '系列' },
        { key: 'model_variant', label: '变体' }, { key: 'model_snapshot', label: '原厂快照' },
        { key: 'aliases', label: '精确别名' }, { key: 'scope', label: '别名适用渠道' },
        { key: 'context_tokens', label: '参考上下文 Token' }, { key: 'output_tokens', label: '参考最大输出 Token' },
        { key: 'capabilities', label: '参考能力' }
      ] })
      const source = el('a', 'link', '查看来源 · ' + row.source)
      source.href = row.source_url
      source.target = '_blank'
      source.rel = 'noopener noreferrer'
      pane.body.append(source)
    })
  })
}
