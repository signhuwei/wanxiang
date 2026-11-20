import { createLedger } from './ledger.js'
import { formatDateTime } from './format.js'

export function auditPage(host, api, signal) {
  return createLedger(host, {
    title: '审计台账',
    columns: [
      { key: 'at', title: '时间', render: row => formatDateTime(row.at) },
      { key: 'actor', title: '操作者' },
      { key: 'action', title: '动作' },
      { key: 'target', title: '目标' }
    ],
    filters: [{ key: 'action', label: '精确动作' }],
    searchLabel: '查询动作、操作者或目标',
    literalSearch: true,
    emptyText: '没有符合条件的审计记录',
    signal,
    fetchPage: ({ q, filters, cursor, limit, signal }) =>
      api.get('/audit', { params: { action: filters.action, q, cursor, limit }, signal })
  })
}
