import { test, expect } from 'bun:test'
import fixture from '../../../tests/fixtures/routing/p0-ab.json'
import {
  buildDraft, candidateState, conflictMessage, isMemberOf, memberChanges, nextPriority, reasonText, revisionText, toggleMember, DEFAULT_ROUTING
} from '../routing-format.js'

const [a, b] = fixture.http.draft.members
const row = (m, extra = {}) => ({ candidate_id: 'cand_' + m.deployment_id, deployment_id: m.deployment_id, deployment_revision: m.deployment_revision,
  raw_model: 'x', approved_match_id: m.approved_match_id, evidence_ids: m.evidence_ids, actions: ['read', 'select'], ...extra })

test('selecting fixture candidates reproduces the shared draft byte for byte', () => {
  let members = toggleMember([], row(a), true)
  members = toggleMember(members, row(b), true)
  const draft = buildDraft({ expected_pool_revision: 6, members, routing: DEFAULT_ROUTING, reason: fixture.http.draft.reason })
  expect(draft).toEqual(fixture.http.draft)
})

test('one deployment appears once; a newer revision replaces the old member and keeps its priority', () => {
  let members = toggleMember([], row(a), true)
  members = toggleMember(members, row({ ...a, deployment_revision: 4, approved_match_id: 'mt_a2' }), true)
  expect(members).toEqual([{ ...a, deployment_revision: 4, approved_match_id: 'mt_a2' }])
  expect(isMemberOf(members, row(a))).toBe(false)
  expect(toggleMember(members, row(a), false)).toEqual([])
  expect(nextPriority([a, b])).toBe(30)
})

test('candidates without select or match evidence are not selectable and always carry a reason', () => {
  const quant = { candidate_id: 'c_q', deployment_id: fixture.http.ineligible_candidate.deployment_id, deployment_revision: 1,
    raw_model: 'm-int4', reason_code: fixture.http.ineligible_candidate.reason, actions: ['read'] }
  expect(candidateState(quant)).toEqual({ selectable: false, reasons: ['型号身份未核验'] })
  expect(candidateState({ deployment_id: null, actions: ['read'] }).reasons).toEqual(['尚未登记为部署'])
  expect(candidateState({ deployment_id: 'd', deployment_revision: 1, actions: ['read'] }).reasons).toEqual(['服务端未返回原因'])
  expect(candidateState({ deployment_id: 'd', deployment_revision: 1, actions: ['select'] }).reasons).toEqual(['缺少已确认的归纳审核'])
  expect(candidateState({ deployment_id: 'd', deployment_revision: 1, match: { reason: 'capability_unverified' }, actions: ['read'] }).reasons)
    .toEqual(['能力未核验'])
  expect(candidateState(row(b)).selectable).toBe(true)
})

test('draft validation rejects missing reason, empty pool and bad numbers but allows equal priority', () => {
  expect(() => buildDraft({ expected_pool_revision: 6, members: [a], routing: DEFAULT_ROUTING, reason: ' ' })).toThrow('发布原因')
  expect(() => buildDraft({ expected_pool_revision: 6, members: [], routing: DEFAULT_ROUTING, reason: 'r' })).toThrow('至少选择')
  expect(() => buildDraft({ expected_pool_revision: 6, members: [a], routing: { ...DEFAULT_ROUTING, max_attempts: 0 }, reason: 'r' })).toThrow('最多尝试次数')
  expect(() => buildDraft({ expected_pool_revision: 6, members: [{ ...a, priority: -1 }], routing: DEFAULT_ROUTING, reason: 'r' })).toThrow('优先级')
  const tied = buildDraft({ expected_pool_revision: 6, members: [{ ...b, priority: 10 }, a], routing: DEFAULT_ROUTING, reason: 'r' })
  expect(tied.members.map(m => [m.deployment_id, m.priority])).toEqual([['dep_a', 10], ['dep_b', 10]])
})

test('member reconciliation reports revision, match and evidence changes and unusable candidates', () => {
  expect(memberChanges(a, row(a))).toBeNull()
  const changed = memberChanges(a, row({ ...a, deployment_revision: 4, approved_match_id: 'mt_a2', evidence_ids: ['ev_a2'] }))
  expect(changed.kind).toBe('changed')
  expect(changed.diffs).toEqual([['部署修订', 'v3', 'v4'], ['归纳审核', 'mt_a', 'mt_a2'], ['证据', 'ev_a', 'ev_a2']])
  expect(memberChanges(a, undefined)).toEqual({ kind: 'gone', reasons: ['候选列表中已找不到该部署'] })
  expect(memberChanges(a, { ...row(a), actions: ['read'], reason_code: 'capability_unverified' })).toEqual({ kind: 'gone', reasons: ['能力未核验'] })
})

test('labels for revisions, reasons and conflicts', () => {
  expect(revisionText(0)).toBe('无活动池')
  expect(revisionText(7)).toBe('v7')
  expect(reasonText({ code: 'capability_unverified', deployment_id: 'dep_b' })).toBe('能力未核验（dep_b）')
  expect(reasonText({ code: 'x', message: '服务端文案' })).toBe('服务端文案')
  expect(reasonText('unknown_code')).toBe('unknown_code')
  for (const reason of fixture.http.conflicts) expect(conflictMessage(reason)).toContain('草稿已保留')
})
