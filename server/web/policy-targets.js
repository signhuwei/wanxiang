import { button, el } from './panel.js'
import { formatMilli } from './format.js'
import { inputField, optionSelect } from './policy-controls.js'
export const reasonLabels = {
  model_inactive: '模型已停用', provider_inactive: 'Provider 已停用', rate_missing: '缺少生效费率', provider_denied: '出口策略未授权',
  device_key_missing: '缺少设备密钥', protocol_unsupported: '不支持此协议', lease_budget_zero: '租约额度为零', scope_denied: '租户或下级配置已关闭', release_disabled: '固定发行已停用', release_unavailable: '固定发行包不可用',
  balance_restricted: '当前余额策略限制此模型', desktop_release_unqualified: '没有可用的受管桌面发行', agent_release_unavailable: '没有兼容的 Agent 发行', tool_release_unavailable: '没有兼容的工具发行',
  tool_release_disabled: '工具发行已停用', tool_agent_denied: '当前合约未允许工具适用的 Agent',
  tool_platform_mismatch: '工具发行不适用于当前系统或架构', tool_artifact_missing: '工具制品缓存缺失',
  tool_price_missing: '当前商业方案未配置搜索单价'
}
export function targetSummary(target) {
  const section = el('section')
  section.append(el('h3', null, '当前生效能力'), el('p', 'muted', '按 ' + target.os + ' / ' + target.arch + ' 与当前配置计算。设备实际应用情况见下发回执。'))
  for (const [label, rows] of [
    ['模型与费率', target.models.map(m => m.name + ' · ' + m.provider_id + (m.rate ? ' · 输入 ' + formatMilli(m.rate.input_milli_per_mtok) + '，输出 ' + formatMilli(m.rate.output_milli_per_mtok) + ' 粒/百万 token' : ''))],
    ['上游顺序', (target.routes ?? []).map(r => r.model_id + ' · ' + r.candidates.map(c => c.provider_id).join(' → '))],
    ['Agent 发行', target.releases.map(r => r.agent + ' ' + r.version)],
    ['工具发行', target.tools.map(t => t.name + ' ' + t.version)],
    ['不可用原因', target.unavailable.map(r => r.resource_id + ' · ' + (reasonLabels[r.reason] ?? r.reason))]
  ]) {
    section.append(el('h4', null, label))
    if (!rows.length) section.append(el('p', 'muted', '无'))
    else { const list = el('ul'); for (const value of rows) list.append(el('li', null, value)); section.append(list) }
  }
  return section
}
export function targetForm(host, api, path, signal) {
  const os = optionSelect([['darwin', 'macOS'], ['win32', 'Windows'], ['linux', 'Linux']], 'darwin')
  const arch = optionSelect([['arm64', 'ARM64'], ['x64', 'x64']], 'arm64')
  const result = el('div')
  const preview = button('查看生效能力', async () => {
    preview.disabled = true
    try {
      const target = await api.get(path, { params: { os: os.value, arch: arch.value }, signal })
      if (!signal.aborted) result.replaceChildren(targetSummary(target))
    } catch (error) { if (!signal.aborted) result.textContent = error.message }
    finally { preview.disabled = false }
  })
  host.replaceChildren(inputField('系统', os), inputField('架构', arch), preview, result)
  preview.click()
}
