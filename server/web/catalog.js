import { createLedger } from './ledger.js'
import { detailPanel, editForm, el, button } from './panel.js'

const text = (key, label, extra = {}) => ({ key, label, ...extra })
const number = (key, label) => text(key, label, { type: 'number' })
const types = {
  provider: { path: 'providers', label: 'Provider', title: 'Provider', name: 'name', child: 'model', drill: '模型目录',
    fields: [text('name','名称'), text('protocol','协议',{ type:'select', allowEmpty:false, options:['anthropic','openai_chat','openai_responses'].map(value => ({value,label:value})) }), text('base_url','服务地址'), text('secret','上游密钥',{type:'password'})], defaults:{protocol:'anthropic'} },
  model: { path:'models', label:'模型', title:'模型目录', name:'display_name', parent:'provider_id', child:'rate', drill:'倍率记录',
    fields:[text('display_name','名称'),text('upstream_name','上游模型名'),number('context_window','上下文窗口')] },
  rate: { path:'rates', label:'倍率', title:'倍率记录', name:'effective_from', parent:'model_id', fields:[text('effective_from','生效时间（UTC）'),
    ...[['input','输入'],['output','输出'],['cache_read','缓存读取'],['cache_write','缓存写入']].map(([k,label]) => number(k+'_milli_per_mtok',label+'（毫橡皮/Mtok）'))] }
}

export function catalog(host, api, actions, kind = 'provider', parent = null) {
  const cfg = types[kind], path = '/platform/'+cfg.path
  let list
  const open = detailPanel(host, () => list)
  function show(row) {
    open(row?.[cfg.name] || '新建'+cfg.label, pane => {
      function paint(mode) {
        const values = row || (kind === 'rate' ? { effective_from: new Date().toISOString(), ...Object.fromEntries(cfg.fields.slice(1).map(f => [f.key,0])) } : cfg.defaults || {})
        const fields = cfg.fields.map(f => {
          if (f.key === 'secret' && mode === 'view') return {key:'secret_state', label:'上游密钥'}
          if (f.key === 'effective_from' && row) return {...f, readonly:true}
          return f
        })
        editForm(pane, { fields, values:{...values,secret_state:'已设置'}, mode,
          submit(v, opts) {
            if (kind === 'provider' && !v.secret && row) delete v.secret
            if (parent) v[cfg.parent] = parent.id
            if (row) v.revision = row.revision
            return api.post(path+(row && kind !== 'rate' ? '/'+encodeURIComponent(row.id) : ''), v, opts)
          } })
        if (mode === 'view') {
          if (row.actions.includes('update')) pane.foot.append(button('编辑', () => paint('edit'), 'primary'))
          if (cfg.child) pane.foot.append(button(cfg.drill, () => {
            pane.body.replaceChildren(); pane.foot.replaceChildren()
            pane.body.classList.add('child-ledger')
            pane.setTitle(row[cfg.name]+' / '+cfg.drill)
            catalog(pane.body, api, actions, cfg.child, row)
          }))
        }
      }
      paint(row ? 'view' : 'create')
    })
  }
  const fields = cfg.fields.filter(f => f.type !== 'password')
  list = createLedger(host, { title:cfg.title, rowKey:kind === 'rate' ? 'effective_from' : 'id', columns:fields.map(f => ({key:f.key,title:f.label})),
    createLabel:'新建'+(kind === 'provider' ? ' ' : '')+cfg.label,
    onCreate: actions.includes('create_'+kind) ? () => show(null) : null, onOpen:show,
    fetchPage:async ({q,cursor,limit,signal}) => {
      const data = await api.get(path,{params:{q,cursor,limit,...(parent ? {[cfg.parent]:parent.id} : {})},signal})
      if (parent && data.items.some(item => item[cfg.parent] !== parent.id)) throw new Error('服务端尚未支持按上级对象分页，无法安全展示目录')
      return data
    } })
}
