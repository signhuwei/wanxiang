// 假数据：两个租户、成员与组。确定性生成，方便截图与验收复现。
// Server 接口就绪后整个 mock/ 目录删除。

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SURNAMES = '张王李赵刘陈杨黄周吴徐孙马朱胡郭何林罗高郑梁谢宋唐许韩冯邓曹彭曾萧田董潘袁蔡蒋余'.split('')
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀兰', '霞', '平', '刚', '桂英', '浩宇', '欣怡', '子轩', '雨桐', '梓涵', '一诺', '思远', '若曦', '沐宸', '奕辰', '若汐']

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)]
}

function pad36(n, len) {
  return n.toString(36).padStart(len, '0')
}

function makeMembers(rng, count, tenantId, groups) {
  const members = []
  for (let i = 0; i < count; i++) {
    const name = pick(rng, SURNAMES) + pick(rng, GIVEN)
    const g = groups[Math.floor(rng() * groups.length)]
    const quota = rng() < 0.4 ? null : Math.floor(rng() * 2000 + 50) * 1000 // 50–2050 橡皮，或不限
    const daysAgo = Math.floor(rng() * 7)
    const lastActive = new Date(Date.now() - daysAgo * 86400000 - Math.floor(rng() * 86400000)).toISOString()
    // 本月已用：围绕配额上下浮动，制造部分接近/超出配额的样本；不限配额时用一个较小的随机用量。
    // 已结算 settled + 仍 active 的租约预留 reserved 两部分；台账列和配额口径看两者之和（month_used_milli）。
    const monthUsed = quota === null
      ? Math.floor(rng() * 500) * 1000
      : Math.floor(quota * (rng() * 1.15))
    const reserved = Math.floor(monthUsed * rng() * 0.3) // 预留占已用的 0~30%
    members.push({
      user_id: 'usr_01J' + pad36(i + 1, 10),
      name,
      target: 'user' + (i + 1) + '@example.com',
      role: i % 23 === 7 ? 'group_admin' : i % 29 === 5 ? 'admin' : 'member',
      group_id: g.id,
      group_name: g.name,
      status: rng() < 0.06 ? 'disabled' : 'active',
      quota_milli: quota,
      month_used_milli: monthUsed,
      settled_milli: monthUsed - reserved,
      reserved_milli: reserved,
      last_active_at: lastActive,
      revision: 1 + Math.floor(rng() * 3),
      tenant_id: tenantId
    })
  }
  return members
}

function withGroupQuota(rng, groups, members) {
  return groups.map(g => {
    const quota = rng() < 0.3 ? null : Math.floor(rng() * 8000 + 500) * 1000 // 500–8500 橡皮，或不限
    const own = (members || []).filter(m => m.group_id === g.id)
    const monthUsed = own.reduce((sum, m) => sum + (m.month_used_milli || 0), 0)
    const settled = own.reduce((sum, m) => sum + (m.settled_milli || 0), 0)
    const reserved = own.reduce((sum, m) => sum + (m.reserved_milli || 0), 0)
    return { ...g, quota_milli: quota, month_used_milli: monthUsed, settled_milli: settled, reserved_milli: reserved, revision: 1 }
  })
}

export function buildMockDb() {
  const tenants = [
    { id: 'ten_demo01', name: '万象科技', status: 'active' },
    { id: 'ten_demo02', name: '示例制造', status: 'active' }
  ]

  const groupsA = ['研发组', '产品组', '设计组', '运营组', '数据组', '客服组']
    .map((name, i) => ({ id: 'grp_a' + (i + 1), name, tenant_id: 'ten_demo01' }))
  const groupsB = ['研发组', '业务组']
    .map((name, i) => ({ id: 'grp_b' + (i + 1), name, tenant_id: 'ten_demo02' }))

  const rngA = mulberry32(20261119)
  const rngB = mulberry32(20261120)
  const membersA = makeMembers(rngA, 137, 'ten_demo01', groupsA)
  const membersB = makeMembers(rngB, 23, 'ten_demo02', groupsB)

  // 两个固定演示账号：admin@onex.dev 是平台管理员、万象科技户主、示例制造管理员；
  // demo@onex.dev 是万象科技普通成员。验证码固定 246810；邀请码 ONEX2026 可把账号加入示例制造。
  const users = {
    'admin@onex.dev': { id: 'usr_admin01', name: '万总', target: 'admin@onex.dev', platform_admin: true },
    'demo@onex.dev': { id: 'usr_demo001', name: '小万', target: 'demo@onex.dev', platform_admin: false }
  }

  const ownerRow = {
    user_id: 'usr_admin01', name: '万总', target: 'admin@onex.dev', role: 'owner',
    group_id: null, group_name: null, status: 'active', quota_milli: null,
    month_used_milli: 812000, settled_milli: 760000, reserved_milli: 52000,
    last_active_at: new Date().toISOString(), revision: 1, tenant_id: 'ten_demo01'
  }
  membersA.unshift(ownerRow)
  const demoRow = {
    // 配额 500 橡皮，已用 460 橡皮（92%：已结算 410 + 预留 50），用于验收接近配额的提示状态。
    user_id: 'usr_demo001', name: '小万', target: 'demo@onex.dev', role: 'member',
    group_id: groupsA[0].id, group_name: groupsA[0].name, status: 'active', quota_milli: 500000,
    month_used_milli: 460000, settled_milli: 410000, reserved_milli: 50000,
    last_active_at: new Date().toISOString(), revision: 1, tenant_id: 'ten_demo01'
  }
  membersA.unshift(demoRow)
  const adminInB = {
    user_id: 'usr_admin01', name: '万总', target: 'admin@onex.dev', role: 'admin',
    group_id: null, group_name: null, status: 'active', quota_milli: null,
    month_used_milli: 94000, settled_milli: 84000, reserved_milli: 10000,
    last_active_at: new Date().toISOString(), revision: 1, tenant_id: 'ten_demo02'
  }
  membersB.unshift(adminInB)

  const groupsAWithQuota = withGroupQuota(rngA, groupsA, membersA)
  const groupsBWithQuota = withGroupQuota(rngB, groupsB, membersB)

  return {
    tenants,
    users,
    groups: { ten_demo01: groupsAWithQuota, ten_demo02: groupsBWithQuota },
    members: { ten_demo01: membersA, ten_demo02: membersB },
    // token → {target, tenantId}；tenantId 为 null 表示全局令牌
    tokens: new Map(),
    memberships: {
      // target → [{tenant_id, role}]
      'admin@onex.dev': [
        { tenant_id: 'ten_demo01', role: 'owner' },
        { tenant_id: 'ten_demo02', role: 'admin' }
      ],
      'demo@onex.dev': [{ tenant_id: 'ten_demo01', role: 'member' }]
    },
    inviteCodes: new Set(['ONEX2026'])
  }
}
