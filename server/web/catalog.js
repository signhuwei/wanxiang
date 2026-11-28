import { createLedger } from './ledger.js'
import { detailPanel, editForm, el, button } from './panel.js'
import { formatMilli } from './format.js'
import { eraserMilli } from './contract-controls.js'
import { deploymentCards } from './routing-deployments.js'
import { quotePanel } from './routing-pricing.js'
import { channelOperations, modelTestsPanel, reviewDiscoveredModel } from './provider-channel.js'
import { channelFunding, fundingOverview } from './provider-funding.js'

const text = (key, label, extra = {}) => ({ key, label, ...extra })
export const modelTokenFields = [
  text('context_window', '上下文窗口', { type: 'number', hint: '单位为 Token。' }),
  text('max_output_tokens', '最大输出 Token', { type: 'number', nullText: '未设置',
    hint: '可留空。填写时须为正整数，且不得超过上下文窗口。' })
]
const types = {
  provider: { path: 'providers', label: 'Provider', title: 'Provider', name: 'name', child: 'model', drill: '模型目录',
    fields: [text('name','名称'), text('protocol','协议',{ type:'select', allowEmpty:false, options:['anthropic','openai_chat','openai_responses'].map(value => ({value,label:value})) }),
      text('base_url','服务地址'), text('secret','上游密钥',{type:'password'}), text('status', '状态', { type: 'select', allowEmpty: false,
        options: [{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }] })], defaults:{protocol:'anthropic', status:'active'} },
  model: { path:'models', label:'模型', title:'模型目录', name:'display_name', parent:'provider_id', child:'rate', drill:'倍率记录',
    fields:[text('display_name','名称'),text('upstream_name','上游模型名'), ...modelTokenFields] },
  rate: { path:'rates', label:'倍率', title:'倍率记录', name:'effective_from', parent:'model_id', fields:[text('effective_from','生效时间（UTC）'),
    ...[['input','输入'],['output','输出'],['cache_read','缓存读取'],['cache_write','缓存写入']].map(([k,label]) => text(k+'_milli_per_mtok',label+'（粒/百万 token）'))] }
}

export function catalog(host, api, actions, kind = 'provider', parent = null, signal) {
  const cfg = types[kind], path = '/platform/'+cfg.path
  let list
  const open = detailPanel(host, () => list)
  function show(row) {
    open(row?.[cfg.name] || '新建'+cfg.label, pane => {
      let controller
      pane.signal.addEventListener('abort', () => controller?.abort(), { once: true })
      function switchView(draw) {
        controller?.abort()
        controller = new AbortController()
        pane.body.classList.remove('child-ledger')
        pane.headActions.replaceChildren()
        draw(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
      }
      const back = () => paint('view')
      function paint(mode) {
        switchView(signal => paintView(mode, signal))
      }
      function paintView(mode, signal) {
        pane.setTitle(row?.[cfg.name] || '新建'+cfg.label)
        const values = row || (kind === 'rate' ? { effective_from: new Date().toISOString(), ...Object.fromEntries(cfg.fields.slice(1).map(f => [f.key,0])) } : cfg.defaults || {})
        const fields = cfg.fields.map(f => {
          if (f.key === 'secret' && mode === 'view') return {key:'secret_state', label:'上游密钥'}
          if (f.key === 'effective_from' && row) return {...f, readonly:true}
          return f
        })
        const display = kind === 'rate'
          ? Object.fromEntries(cfg.fields.slice(1).map(field => [field.key, formatMilli(values[field.key])]))
          : {}
        editForm(pane, { fields, values:{...values,...display,secret_state:'已设置'}, mode,
          submit(v, opts) {
            if (kind === 'provider' && !v.secret && row) delete v.secret
            if (kind === 'rate') {
              for (const field of cfg.fields.slice(1)) v[field.key] = eraserMilli(v[field.key], field.label)
            }
            if (parent) v[cfg.parent] = parent.id
            if (row) v.revision = row.revision
            return api.post(path+(row && kind !== 'rate' ? '/'+encodeURIComponent(row.id) : ''), v, { ...opts, signal })
          } })
        if (mode === 'view') {
          if (kind === 'provider') {
            const openFunding = () => switchView(next => channelFunding(pane, api, row, next, back))
            channelOperations(pane.body, api, row, signal, discovered => {
              switchView(next => reviewDiscoveredModel(pane, api, row, discovered, next, back))
            }, (discovered, writable) => {
              switchView(next => modelTestsPanel(pane, api, discovered, writable, next, back))
            })
            deploymentCards(pane.body, api, row, signal, { onQuotes: card => switchView(next => {
              pane.headActions.append(button('返回渠道', back))
              quotePanel(pane, api, card, next)
            }) })
            fundingOverview(pane.body, api, row, signal, openFunding)
            pane.headActions.append(button('渠道资金', openFunding))
          }
          if (row.actions.includes('update')) pane.foot.append(button('编辑', () => paint('edit'), 'primary'))
          if (cfg.child) pane.foot.append(button(cfg.drill, () => {
            switchView(next => {
              pane.body.replaceChildren(); pane.foot.replaceChildren()
              pane.body.classList.add('child-ledger')
              pane.setTitle(row[cfg.name]+' / '+cfg.drill)
              pane.headActions.append(button('返回' + cfg.label, back))
              catalog(pane.body, api, actions, cfg.child, row, next)
            })
          }))
        }
      }
      paint(row ? 'view' : 'create')
    })
  }
  const fields = cfg.fields.filter(f => f.type !== 'password')
  list = createLedger(host, { title:cfg.title, signal, rowKey:kind === 'rate' ? 'effective_from' : 'id',
    columns:fields.map(f => ({ key:f.key, title:f.label,
      ...(f.key.endsWith('_milli_per_mtok') && { render: row => formatMilli(row[f.key]) }),
      ...(f.key === 'status' && { render: row => row.status === 'active' ? '启用' : row.status === 'disabled' ? '停用' : row.status }) })),
    createLabel:'新建'+(kind === 'provider' ? ' ' : '')+cfg.label,
    ...(actions == null && { createAction: 'create_' + kind }),
    onCreate: actions == null || actions.includes('create_'+kind) ? () => show(null) : null, onOpen:show,
    fetchPage:async ({q,cursor,limit,signal}) => {
      const data = await api.get(path,{params:{q,cursor,limit,...(parent ? {[cfg.parent]:parent.id} : {})},signal})
      if (parent && data.items.some(item => item[cfg.parent] !== parent.id)) throw new Error('服务端尚未支持按上级对象分页，无法安全展示目录')
      return data
    } })
}
