import { reasonLabels,targetForm } from './policy-targets.js'
import { commerceAccountPanel } from './commerce.js'
import { createLedger } from './ledger.js'
import { button, detailPanel, el } from './panel.js'
import { formatDateTime } from './format.js'
import { previewPublisher } from './contract-controls.js'
import { policyVersionsPage, versionEntries } from './policy-authoring.js'
import { encode, fetchPolicyPage, hasAction, inputField, mountTabs, platformPolicy, policyValue, previewEntries, refText } from './policy-controls.js'
import { rechargePage } from './policy-recharge.js'

const contracts = platformPolicy + '/contracts'

function signedForm(body, data) {
  body.replaceChildren()
  const info = el('dl', 'policy-facts')
  for (const [name, value] of [
    ['版本', 'v' + data.revision], ['状态', data.current ? '当前生效' : '已归档'], ['签发时间', formatDateTime(data.issued_at)],
    ['签发人', data.issued_by], ['签发原因', data.reason]
  ]) {
    const row = el('div')
    row.append(el('dt', null, name), el('dd', null, value))
    info.append(row)
  }
  const rows = el('dl', 'policy-facts signed-clause-list')
  for (const entry of data.entries) {
    const { definition, display } = entry
    const row = el('div')
    const name = el('dt', null, definition.title)
    name.append(el('small', 'muted', refText(entry.clause_ref)))
    const value = el('dd')
    value.append(el('strong', 'policy-signed-value', policyValue(definition, entry.signed_value, display)))
    const reference = entry.template_ref ? '模板 ' + refText(entry.template_ref) : '直接引用条目库'
    const adjusted = Object.hasOwn(entry, 'adjustment')
      ? ' · 基准 ' + policyValue(definition, entry.base_value, display) + ' · 单独调整' : ' · 继承基准'
    value.append(el('small', 'muted', reference + adjusted))
    row.append(name, value)
    rows.append(row)
  }
  body.append(el('h3', null, '签发信息'), info, el('h3', null, '合约条目'), rows)
}

function drafting(api, base, revisions, signal) {
  const node = el('div', 'policy-editor')
  const reason = el('textarea')
  const entries = versionEntries(api, platformPolicy, base?.entries ?? [], { signal, allowTemplates: true, signed: true })
  node.append(el('p', 'muted', base ? '从 v' + base.revision + ' 起草 · 当前生效 v' + revisions.platform_revision : '首次签发'),
    inputField('签发原因', reason, true), entries.node)
  return {
    node,
    collect() {
      const explanation = reason.value.trim()
      if (!explanation) throw new Error('请填写签发原因')
      return {
        expected_policy_revision: revisions.policy_revision, expected_platform_revision: revisions.platform_revision,
        base_revision: base?.revision ?? null, entries: entries.collect(), reason: explanation
      }
    }
  }
}

function appendImpactList(body, title, moreLabel, page, load, label) {
  if (!page.total) return
  const list = el('ul', null)
  list.setAttribute('aria-label', title)
  const error = el('p', 'error-row')
  error.hidden = true
  const more = button(moreLabel, async () => {
    more.disabled = true
    error.hidden = true
    try { append(await load(page.next_cursor)) }
    catch (failure) {
      error.textContent = failure.message
      error.hidden = false
    } finally { more.disabled = false }
  })
  function append(next) {
    for (const row of next.items) list.append(el('li', null, label(row)))
    page = next
    more.hidden = !page.next_cursor
  }
  body.append(el('h4', null, title), list, more, error)
  append(page)
}

function signaturePreview(value, nextPage) {
  const body = previewEntries(value, 'signed_value')
  if (!value.impact) return body
  const { impact, seats } = value
  body.append(el('h3', null, '签发影响'), el('p', null, `影响 ${impact.member_count} 位成员、${impact.device_count} 台设备；现有 ${seats.active} 席，拟签 ${seats.limit} 席，超出 ${seats.over_limit} 席。`))
  appendImpactList(body, '受影响成员', '查看更多成员', impact.members,
    async member_cursor => (await nextPage({ member_cursor })).impact.members,
    row => `${row.name} · ${row.user_id} · ${row.device_count} 台设备 · ${row.changed_clauses.join('、')}`)
  appendImpactList(body, '受影响设备', '查看更多设备', impact.devices,
    async cursor => (await nextPage({ cursor })).impact.devices,
    row => `${row.device_id} · ${row.user_id} · ${row.os}/${row.arch} · ${row.changed_clauses.join('、')}` +
      row.unavailable.map(item => ' · ' + item.resource_id + ' ' + (reasonLabels[item.reason] ?? item.reason)).join(''))
  return body
}

function signaturesPage(host, api, endpoint, tenant, onChange, signal) {
  host.classList.add('policy-signatures')
  let ledger
  const open = detailPanel(host, () => ledger)
  function show(row) {
    open(row ? '合约条目 · v' + row.revision : '首次签发', async pane => {
      let data
      if (row) {
        pane.body.append(el('p', 'muted', '正在读取签发版本…'))
        data = await api.get(endpoint + '/signatures/' + encode(row.revision), { signal })
      }
      if (signal?.aborted) return
      const revisions = { ...(data ?? tenant) }
      function draw() {
        if (signal?.aborted) return
        pane.setTitle('合约条目 · v' + data.revision)
        signedForm(pane.body, data)
        pane.foot.replaceChildren()
        pane.headActions.replaceChildren()
        pane.headActions.append(button('查看当前生效能力',()=>detailPanel(pane.body)('成员生效能力',target=>{
          createLedger(target.body,{title:'选择成员',rowKey:'user_id',signal,
            columns:[{key:'name',title:'成员'},{key:'user_id',title:'标识'}],fetchPage:fetchPolicyPage(api,endpoint+'/targets'),
            onOpen:member=>{target.setTitle(member.name+' · 当前生效能力');targetForm(target.body,api,endpoint+'/targets/'+encode(member.user_id),signal)}
          })
        })))
        if (hasAction(data, 'sign')) pane.headActions.append(button('变更合约', edit, 'primary'))
      }
      function edit() {
        pane.setTitle(data ? '变更合约 · 基于 v' + data.revision : '首次签发')
        pane.body.replaceChildren()
        pane.headActions.replaceChildren()
        let previewBody
        previewPublisher({
          body: pane.body, foot: pane.foot, editor: drafting(api, data, revisions, signal),
          preview: body => { previewBody=body; return api.post(endpoint + '/preview', body, { signal }) },
          publish: (body, key) => api.post(endpoint + '/signatures', body, { signal, idempotencyKey: key }),
          renderPreview: value => {
            const draft = previewBody
            return signaturePreview(value, params => api.post(endpoint + '/preview', draft, { signal, params }))
          },
          reload: async () => {
            const latest = await api.get(endpoint, { signal })
            if (signal?.aborted) return
            Object.assign(revisions, { platform_revision: latest.platform_revision, policy_revision: latest.policy_revision })
          },
          onCancel: () => data ? draw() : pane.close(),
          onPublished: published => {
            if (signal?.aborted) return
            data = published
            Object.assign(revisions, published)
            Object.assign(tenant, { platform_revision: published.platform_revision, policy_revision: published.policy_revision })
            pane.changed()
            ledger.setSelected(String(published.revision))
            ledger.refresh()
            onChange()
            draw()
          }
        })
      }
      if (row) draw()
      else if (hasAction(tenant, 'sign')) edit()
      else pane.body.append(el('p', 'empty', '没有可执行的签发操作'))
    })
  }
  ledger = createLedger(host, {
    title: '签发记录', searchable: false, signal, createAction: 'create', rowKey: 'key', createLabel: '首次签发',
    columns: [
      { title: '版本', render: item => {
        const node = el('span', 'policy-compact-value')
        node.append(hasAction(item, 'read') ? el('button', 'link policy-row-link', 'v' + item.revision) : el('span', null, 'v' + item.revision))
        node.append(el('small', 'muted', item.current ? '当前生效' : '已归档'))
        return node
      } },
      { title: '签发时间', render: item => formatDateTime(item.issued_at) },
      { key: 'issued_by', title: '签发人' },
      { key: 'reason', title: '签发原因' },
      { title: '状态', render: item => item.current ? '当前生效' : '已归档' }
    ],
    fetchPage: async args => {
      const page = await fetchPolicyPage(api, endpoint + '/signatures')(args)
      const actions = page.actions ?? []
      return { ...page, actions: hasAction(tenant, 'sign') && !tenant.platform_revision ? [...actions, 'create'] : actions.filter(action => action !== 'create'),
        items: page.items.map(item => ({ ...item, key: String(item.revision) })) }
    },
    onOpen: show,
    onCreate: () => show()
  })
}

export function platformPolicyContracts(host, api, signal) {
  host.classList.add('policy-contracts')
  let ledger
  const open = detailPanel(host, () => ledger)
  function show(row) {
    open(row.name, async pane => {
      pane.body.append(el('p', 'muted', '正在读取租户合约…'))
      const endpoint = contracts + '/' + encode(row.tenant_id)
      const tenant = await api.get(endpoint, { signal })
      if (signal?.aborted) return
      pane.body.replaceChildren()
      pane.body.classList.add('policy-contract-workspace')
      const tabs = [
        ['recharges', '充值记录', (area, tabSignal) => rechargePage(area, {
          api, endpoint: endpoint + '/recharges', tenantName: tenant.name, balance: tenant.balance, signal: tabSignal,
          getBalance: async () => {
            const result = await api.get(endpoint, { signal: tabSignal })
            tenant.balance = result.balance
            return tenant.balance
          },
          account: accountPane=>commerceAccountPanel(accountPane.body,api,row.tenant_id,tabSignal),
          onChange: pane.changed
        })],
        ['signatures', '签发记录', (area, tabSignal) => signaturesPage(area, api, endpoint, tenant, pane.changed, tabSignal)]
      ]
      mountTabs(pane.body, tabs, signal)
    })
  }
  ledger = createLedger(host, {
    title: '租户台账', signal, rowKey: 'tenant_id', searchLabel: '查询租户',
    columns: [
      { title: '租户', render: item => hasAction(item, 'read') ? el('button', 'link policy-row-link', item.name) : item.name },
      { title: '合约版本', render: item => item.platform_revision ? 'v' + item.platform_revision : '未签发' },
      { title: '状态', render: item => item.platform_revision ? '当前生效' : '待签发' }
    ],
    fetchPage: fetchPolicyPage(api, contracts),
    onOpen: show
  })
}

export function platformPolicyTemplates(host, api, signal) {
  policyVersionsPage(host, api, platformPolicy, { title: '合约模板', signal })
}

export function platformPolicyDefinitions(host, api, signal) {
  policyVersionsPage(host, api, platformPolicy, { title: '条目库', resource: 'definitions', signal })
}
