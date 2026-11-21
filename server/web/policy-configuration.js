import { targetForm } from './policy-targets.js'
import { upstreamPage } from './policy-upstreams.js'
import { createLedger } from './ledger.js'
import { el, button, detailPanel } from './panel.js'
import { formatDateTime, formatMilli } from './format.js'
import { previewPublisher } from './contract-controls.js'
import { policyVersionsPage, versionPicker } from './policy-authoring.js'
import { encode, fetchPolicyPage, hasAction, inputField, mountTabs, optionSelect, policyValue, previewEntries, refKey, refText, scopeLabel, tenantPolicy, valueField } from './policy-controls.js'

export const policyConfigurationPath = (scope, id) => tenantPolicy + '/configurations/' + encode(scope) + '/' + encode(id)

function effectiveProfile(body, record) {
  body.replaceChildren()
  body.append(el('p', 'muted', '平台签发 v' + record.platform_revision + ' · 配置修订 ' + record.revision))
  if (record.template_ref) body.append(el('p', null, '配置模板 ' + refText(record.template_ref)))
  if (!record.entries.length) {
    body.append(el('p', 'empty', record.platform_revision ? '没有可展示的能力条目' : '此租户尚未签发合约'))
    return
  }
  const rows = el('dl', 'policy-facts')
  for (const entry of record.entries) {
    const { definition, source, display } = entry
    const row = el('div')
    const label = el('dt', null, definition.title)
    label.append(el('small', 'muted', refText(entry.clause_ref)))
    const val = el('dd', null, policyValue(definition, entry.effective_value, display))
    if (source) val.append(el('small', 'muted', '来源 ' + (scopeLabel[source.scope] ?? source.scope) + ' · v' + source.revision))
    if (entry.parent_value !== undefined) val.append(el('small', 'muted', '上级边界 ' + policyValue(definition, entry.parent_value, display)))
    row.append(label, val)
    rows.append(row)
  }
  body.append(rows)
}

function editProfile(api, record, revisions, signal) {
  const node = el('div', 'policy-editor')
  let templateRef = record.template_ref
  if (record.scope !== 'tenant') {
    const chosen = el('p', 'muted')
    function sync() {
      chosen.textContent = templateRef ? '已选模板 ' + refText(templateRef) : '不使用配置模板'
    }
    function setTemplate(ref) {
      templateRef = ref
      sync()
      node.dispatchEvent(new Event('change', { bubbles: true }))
    }
    sync()
    node.append(chosen, versionPicker('选择配置模板', api, tenantPolicy + '/configuration-templates', ref => {
      setTemplate({ id: ref.id, version: ref.version })
    }, { signal, params: { scope: record.scope }, accept: row => row.scope === record.scope }),
    button('不使用模板', () => setTemplate(null), 'link'))
  }
  const explicit = new Map(record.selections.map(item => [refKey(item.clause_ref), item.value]))
  const editors = []
  for (const entry of record.entries) {
    const { clause_ref, definition } = entry
    if (definition.merge === 'fixed' || !definition.scopes.includes(record.scope)) continue
    const key = refKey(clause_ref)
    const card = el('section', 'policy-entry')
    const mode = optionSelect([['inherit', '继承'], ['set', '单独调整']], explicit.has(key) ? 'set' : 'inherit')
    const editBox = el('div')
    const current = explicit.has(key) ? explicit.get(key) : entry.effective_value
    let field
    function refresh() {
      if (mode.value === 'inherit') {
        field = null
        editBox.replaceChildren()
      } else {
        field = valueField(api, tenantPolicy, definition, current, { display: entry.display, signal })
        editBox.replaceChildren(field.node)
      }
    }
    mode.addEventListener('change', refresh)
    const title = el('div', 'policy-entry-head')
    title.append(el('strong', null, definition.title), el('small', 'muted', refText(clause_ref)))
    card.append(title, inputField('配置方式', mode), el('small', 'muted', '上级边界 ' + policyValue(definition, entry.parent_value, entry.display)), editBox)
    node.append(card)
    editors.push({ clause_ref, collect: () => field?.collect() })
    refresh()
  }
  if (!editors.length && record.scope === 'tenant') node.append(el('p', 'muted', '本合约没有开放给租户调整的条目'))
  return {
    node,
    collect: () => ({
      expected_policy_revision: revisions.policy_revision, expected_platform_revision: revisions.platform_revision,
      template_ref: templateRef ?? null,
      selections: editors.flatMap(item => {
        const value = item.collect()
        return value === undefined ? [] : [{ clause_ref: item.clause_ref, value }]
      })
    })
  }
}

export async function configurationView(pane, api, scope, id, signal, openEditor) {
  const endpoint = policyConfigurationPath(scope, id)
  pane.body.replaceChildren(el('p', 'muted', '正在读取能力配置…'))
  let record
  async function load() {
    try {
      record = await api.get(endpoint, { signal })
      if (!signal?.aborted) draw()
    } catch (error) {
      if (!signal?.aborted) pane.body.replaceChildren(el('p', 'error-row', error.message), button('重试', load))
    }
  }
  function draw() {
    effectiveProfile(pane.body, record)
    pane.foot.replaceChildren()
    const controls = pane.headActions ?? pane.foot
    controls.replaceChildren()
    if (scope==='member') controls.append(button('查看生效能力',()=>detailPanel(pane.body)('成员生效能力',target=>{
      targetForm(target.body,api,tenantPolicy+'/targets/'+encode(id),signal)
    })))
    if (openEditor && hasAction(record,'update')) controls.append(button('配置版本', () => openEditor('配置版本', target => {
      createLedger(target.body, {
        title: '配置版本', rowKey:'revision', searchable:false, signal,
        columns:[{title:'版本',render:row=>'v'+row.revision},{title:'更新时间',render:row=>formatDateTime(row.updated_at)},
          {title:'操作人',key:'updated_by'},{title:'恢复来源',render:row=>row.restored_from_revision?'v'+row.restored_from_revision:'—'}],
        fetchPage:async args=>{
          const data=await fetchPolicyPage(api,endpoint+'/history')(args)
          return {...data,items:data.items.map(row=>({...row,actions:['read']}))}
        },
        onOpen:row=>{
          target.setTitle('恢复配置 · v'+row.revision)
          target.body.replaceChildren()
          const revisions={expected_platform_revision:record.platform_revision,expected_policy_revision:record.policy_revision}
          previewPublisher({body:target.body,foot:target.foot,
            editor:{node:el('p',null,'按当前签发合约校验 v'+row.revision+' 的配置。发布将创建新的配置版本。'),
              collect:()=>({...revisions,restore_revision:row.revision})},
            preview:body=>api.post(endpoint+'/preview',body,{signal}), publish:(body,key)=>api.put(endpoint,body,{signal,idempotencyKey:key}),
            renderPreview:value=>previewEntries(value,'effective_value'),onCancel:target.close,
            reload:async()=>{record=await api.get(endpoint,{signal});Object.assign(revisions,{expected_platform_revision:record.platform_revision,expected_policy_revision:record.policy_revision})},
            onPublished:saved=>{record=saved;target.close();draw()}})
        }
      })
    })))
    if (hasAction(record, 'update')) controls.append(button('编辑配置', () =>
      openEditor ? openEditor('编辑配置', target => edit(target, target.close)) : edit(pane, draw), 'primary'))
  }
  function edit(target, leave) {
    const revisions = { platform_revision: record.platform_revision, policy_revision: record.policy_revision }
    target.body.replaceChildren()
    target.headActions?.replaceChildren()
    previewPublisher({
      body: target.body, foot: target.foot, editor: editProfile(api, record, revisions, signal),
      preview: body => api.post(endpoint + '/preview', body, { signal }),
      publish: (body, key) => api.put(endpoint, body, { signal, idempotencyKey: key }),
      renderPreview: value => previewEntries(value, 'effective_value'),
      onCancel: leave,
      reload: async () => {
        const latest = await api.get(endpoint, { signal })
        if (signal?.aborted) return
        if (!hasAction(latest, 'update')) {
          record = latest
          if (openEditor) leave()
          draw()
        } else Object.assign(revisions, { platform_revision: latest.platform_revision, policy_revision: latest.policy_revision })
      },
      onPublished: saved => {
        if (signal?.aborted) return
        record = saved
        pane.changed?.()
        if (openEditor) leave()
        draw()
      }
    })
  }
  await load()
}

function localPane(host) {
  const body = el('div', 'inline-body'), foot = el('div', 'inline-foot')
  host.append(body, foot)
  return { body, foot }
}

export function tenantPolicyPage(host, api, session, signal) {
  host.classList.add('policy-tabs-root')
  const tenantScope = session.role === 'owner' || session.role === 'admin'
  const profile = ['profile', tenantScope ? '合约条目' : '我的配置', (area, local) => {
    const scope = tenantScope ? 'tenant' : 'member'
    void configurationView(localPane(area), api, scope, (tenantScope ? session.tenant : session.user).id, local, detailPanel(area))
  }]
  const tabs = [profile]
  if (session.role==='owner') tabs.push(['upstreams','自有上游',(area,local)=>upstreamPage(area,api,local)])
  if (tenantScope) tabs.push(['templates', '组及个人模板', (area, local) =>
    policyVersionsPage(area, api, tenantPolicy, {
      title: '配置模板', resource: 'configuration-templates', scopes: ['group', 'member'], signal: local,
      loadDefinitions: async () => (await api.get(policyConfigurationPath('tenant', session.tenant.id), { signal: local })).entries
    })])
  if (tenantScope) tabs.push(['signatures', '签发记录', (area, local) => {
    createLedger(area, {
      title: '签发记录', signal: local, searchable: false,
      columns: [
        { title: '版本', render: item => 'v' + item.revision },
        { title: '签发时间', render: item => formatDateTime(item.issued_at) },
        { key: 'issued_by', title: '签发人' }, { key: 'reason', title: '签发原因' },
        { title: '状态', render: item => item.current ? '当前生效' : '已归档' }
      ],
      fetchPage: fetchPolicyPage(api, tenantPolicy + '/signatures')
    })
  }])
  mountTabs(host, tabs, signal)
}

async function quotaUsageView(body, api, scope, id, signal) {
  body.replaceChildren(el('p', 'muted', '正在读取本月配额…'))
  try {
    const data = await api.get('/quota/usage', { params: { scope, id }, signal })
    if (signal?.aborted) return
    const facts = el('dl', 'policy-facts')
    for (const [title, key] of [['本月配额', 'quota_milli'], ['已结算', 'used_milli'], ['已预留', 'reserved_milli'], ['剩余', 'remaining_milli']]) {
      const row = el('div')
      const amount = data[key]
      row.append(el('dt', null, title), el('dd', null, amount == null ? '不限' : formatMilli(amount) + ' 块'))
      facts.append(row)
    }
    body.replaceChildren(el('h3', null, '本月配额'), facts)
  } catch (error) {
    if (!signal?.aborted) body.replaceChildren(el('p', 'error-row', error.message),
      button('重试', () => quotaUsageView(body, api, scope, id, signal)))
  }
}

export function quotaPolicyPage(host, api, session, signal) {
  if (session.role === 'group_admin') {
    host.classList.add('policy-tabs-root')
    mountTabs(host, [
      ['group', '组内配额', (area, local) => organizationPolicyPage(area, api, 'group', local, { quotaOnly: true })],
      ['member', '成员配额', (area, local) => organizationPolicyPage(area, api, 'member', local, { quotaOnly: true })]
    ], signal)
  } else {
    const pane = localPane(host)
    void quotaUsageView(pane.body, api, 'member', session.user.id, signal)
  }
}

export function organizationPolicyPage(host, api, scope, signal, { quotaOnly = false } = {}) {
  const member = scope === 'member'
  let list
  const open = detailPanel(host, () => list)
  list = createLedger(host, {
    title: quotaOnly ? (member ? '成员配额' : '组内配额') : (member ? '个人配置' : '组配置'),
    rowKey: 'id', signal,
    columns: [
      { title: member ? '成员' : '分组', render: item => hasAction(item, 'read') ? el('button', 'link policy-row-link', item.name) : item.name },
      { title: member ? '分组' : '上级组', key: member ? 'group_id' : 'parent_id' }
    ],
    fetchPage: fetchPolicyPage(api, tenantPolicy + '/configurations/' + encode(scope)),
    onOpen: item => open(item.name, pane => quotaOnly
      ? quotaUsageView(pane.body, api, scope, item.id, signal)
      : configurationView(pane, api, scope, item.id, signal))
  })
}
