# S1 Server 第二轮验收：四项修复

**结论：四项后端修复可保留；按“完整套件连续 20 次通过、管理端按授权显示角色”标准，本轮仍不可合并／不予整体验收。** 没有复现此前 SQLite 关闭顺序竞态。20 次中有 4 次失败，全部是另一处心跳测试将合法 `config` 帧当作 `ping`。Web 邀请及成员编辑表单仍未使用新授权字段。两者应分别修，不能把这 4 次失败归咎于账本或关库。

- 2026-11-19，sima，Bun 1.3.5。恢复后先查 `git status`、工作区及暂存区 diff，均无未提交改动。验收检出当时的 `main@5d60116`；包含 `16fd03c`（实际 Server 合并节点 `5b0c5d2`），`git diff 11c44ca..HEAD --stat -- server` 为空，测试前后工作树干净。只写 coord 报告；不启 Chrome，不调用真实模型。**未验未提交的跨租约对账修复。**

|验收项|结论|独立证据|
|---|---|---|
|`close()` 排空再关库|**指定回归通过；20 次未见原故障**|`server/test/server.test.ts:60` 在有活跃 WS 和已排队写入时并发等待两次 `close()`，校验写入成功及 presence 移除；该用例 20/20 未失败。`server/src/server.ts` 先停止接入，再等 sockets、pending 和 store 队列，最后关 presence 和库。这不是所有时序下都无竞态的证明。|
|`usage.model` 与 `model_id` 分存|**通过**|在离线续约 WS 测试中上报 `model=fake`、`model_id=mod_fake`，ACK=2 后直接查租户库；完整和不完整两行分别保留两个字段，结算状态为 reconciled/pending，账本无第二笔扣款。20 次均未在该用例失败（`server/test/server.test.ts:438-448`）。迁移 `004_usage_model.sql` 对旧行复制已有值，无法还原历史中未保存的名字。首轮独立三种断流＋幂等结算夹具另跑 1/1 通过，10 次断言。|
|两级平台父项筛选|**通过（API）**|每次套件真实建立两个 Provider，各有一模型、每模型一倍率。两个列表分别按 `provider_id`、`model_id` 请求 `limit=1`；响应均仅含目标项、`total=1`、`next_cursor=null`，旧的全局总数问题未再出现（`server/test/server.test.ts:214-224`）。`platform-management.ts:34-44` 中 count 与取页共用 WHERE 和参数。|
|`/me.actions` 及角色展示|**后端通过，Web 不通过**|真实 owner 获 `assign_role:admin/group_admin/member` 三项（各自带前缀），租户 admin 只获 `assign_role:member`，admin 创建 admin 邀请被拒 403（`server/test/server.test.ts:130-134,172-185`）。但 `server/web/members.js:18-22,116-122` 与 `server/web/groups.js:27-31` 仍使用固定的三个选项。以 admin 打开普通成员编辑或生成邀请码，应仅能选“成员”，当前源码仍会显示“管理员/组管”。这是可操作选项误导，不是成功越权；不要把只读台账的角色**筛选**选项一起删掉。Web 单测 25/25、96 次断言并未覆盖这个 UI 差异。|

## 20 次串行实跑明细

在同一 detached 快照，从 review 根目录启动 **20 个独立 Bun 进程**，每次均为 `bun test ./server/test`，无并行。每次共 17 个用例，真实 Valkey 因 `ONEX_TEST_VALKEY_URL` 未配置而跳过；下列“通过”指无失败。

|轮次|结果|
|---|---|
|1、2、4、5、6、8、9、10、13、14、15、16、17、18、19、20|每次 16 pass / 1 skip / 0 fail，212 次断言|
|3、7、11、12|每次 15 pass / 1 skip / 1 fail，208 次断言；同一失败位置和输出|

```text
server/test/server.test.ts:311:21
Expected: "ping"
Received: "config"
(fail) new device connection replaces old; heartbeat is correlated and closes after three misses
```

**复验方法：** 重复完整套件。新连接先完成 `welcome/cutoff`，客户端发 ping 并收到匹配的 pong；随后测试用无类型筛选的 `current.next()` 期待服务端心跳。`edge.ts:124-128` 同时安排心跳和配置下发；如果 config 晚于 pong 入队，:311 就会失败。这不证明服务端丢失心跳。建议该用例在 :310、:313 等待 `nextOf('ping')`（现有帮助函数只略过配置/密钥帧），保留 pong 的关联 ID、三次漏答、关闭码及 presence 清理断言，不靠延长超时掩盖。修复后重新串行 20 次；Web 接入授权动作后分别用 admin/owner 验两种表单，再关闭剩余阻断。
