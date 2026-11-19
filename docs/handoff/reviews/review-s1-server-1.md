# S1 首轮验收：租户管理、账本租约、管理端 UI

**结论：不可合并（已在 main，含义为当前快照不予验收，不建议据此发布；未改动或回滚分支）。** Server 不接收契约约定的三种断流用量；多 Provider 时管理端无法正确钻取。尚无证据表明本次检查发现了并发超发、重复扣款或后端角色提升；也不能用静态阅读代替这三项运行验收。

- 验收者：sima。单独检出 `main` 的 detached 快照 `ab57d99`。S1-S1 主体 `fb446ac`、后续 `5f34ca4`，S1-S2 `ccd33fa`；Web 截至合入 `2397968`。基准为 `contracts/` 与 `docs/plan/s1-acceptance.md`，仅 W1–W4 的 UI 规则与权限展示属于本轮，W4 的真实数据/SSE 延迟不在本轮。
- 自行运行 `bun test ./server/web/tests`：Bun 1.3.5，**24 pass、0 fail、89 次断言、6 个文件**。不含浏览器布局与真实 API 联调。
- 自行运行 `bun test --no-install ./server/test`：**1 pass、1 skip、2 fail、2 errors**；导入阶段 `Cannot find package 'ulid' from '…/server/src/seed.ts'`，不是账本或权限断言失败。review 工作树未安装依赖；复用外部依赖的环境命令、隔离副本和 Chrome MCP 受权限限制。未在产品目录安装或写入依赖，未调用真实模型。以下复核步骤均以测试夹具为前提；没有把待执行步骤当作实测输出。

## 阻断与复核方法

|编号／结论|操作与期望|快照上的证据与影响|
|---|---|---|
|S2-01 断流用量 **不通过**|对有效测试租约各送一条合法 usage，`status` 分别为 `lease_exhausted`、`lease_expired`、`cutoff`；应持久化并正常推进连续 ACK，不完整用量保留待结算。|`contracts/edge-ws.md:48` 允许这三类，`server/src/ingest.ts:48-52` 的枚举全部排除。`server/src/edge.ts:137-149` 会回错误 ACK 而不写入；包含此项的整个批次无法提交，后续重发原批次仍被拒。静态确认。|
|S1-01 / W2 父对象分页 **不通过**|平台准备 P、Q 各一个模型，各有一条倍率。平台台账钻入 P，再钻入其模型；即使 `limit=1`，两个层级都应 `total=1,next_cursor=null`。|`server/web/catalog.js:52-55` 确实传父 ID；`server/src/platform-management.ts:34-41,83,98` 的总数和分页 SQL 都只有关键字过滤，没有 `provider_id`/`model_id`。API 算的是全库总数；页内夹有另一父项时 UI 显示“服务端尚未支持按上级对象分页”，而非子台账。违反 `contracts/http-api.md:65`；只有一个 Provider 的测试不触发。静态确认。|
|W1 角色选项 **不通过**（权限展示，不等于服务端越权）|以租户 admin 编辑普通成员，或打开生成邀请码表单。预期只提供当前操作者可授予的角色；owner 仍能任免管理员。|`server/web/members.js:18-22,116-122`、`server/web/groups.js:27-31` 对 admin 和 owner 暴露同一组含管理员、组管的选项；`server/src/tenant-management.ts:21,98,179` 则仅允许 admin 管普通成员。页面显示可选、提交会被后端拒绝。建议以服务端返回的可授权角色约束表单，不在页面复制角色策略。静态确认。|
|S2-02 用量模型归属 **不通过**|合同模型 ID `mod_A` 对应上游名 `fixture-model`，合法 usage 同时携带 `model_id=mod_A,model=fixture-model`；库中 `usage.model_id` 应保持 `mod_A`。|`server/src/ingest.ts:54-60,74-77` 只取 `row.model`，将其作为 `model_id` 写库，丢弃真正的 ID；按模型对账或关联倍率时错配。属于落库契约缺陷，**不是**证明重复扣款。静态确认。|

## 逐项结论及证据边界

|检查项|结论|证据／待复测|
|---|---|---|
|S1-S1 入租席位竞争、邀请幂等、revision、租户边界|无法验证（运行）|`server/test/server.test.ts:102-155` 有竞争最后一席、失败不消耗次数、重复邀请码不再显示明文等断言，本轮未加载。`tenant-management.ts:92-116,170-195` 的状态写入位于租户写队列；`management.ts:8-21` 分离租户与平台调用者。测两租户同名、owner/admin/member 在两租户的矩阵，结果须与租户库前后快照一致。|
|S1-S1 admin 不能任免 admin、租户 owner 不能凭租户身份充值|无法验证（运行），静态守卫存在|`tenant-management.ts:95-99,178-183,207-212` 检查请求者及目标角色；`billing.ts:125-135` 要求全局平台管理员。复验普通成员升 admin、admin 改合约、租户令牌充值均应 403 且不产生状态变更；再以获准身份走正例。|
|S1-S2 并发签发与续租不超发、同 op_id 不重扣|无法验证（运行），未见串行化或幂等路径缺口|`store.ts:53-75` 对同一租户的同步写任务串行提交；`billing.ts:45-60,81-100` 在一次事务内读取余额、结清旧租约、预留下一租约并缓存响应。重放前查 `(device_id,op_id)`，不同参数冲突。待跑 `server.test.ts:294-314`：充值 2 毫，两设备各领 1，一设备重发同 op，终态应两笔 settle、余额/预留 0、消耗 2。再加有余款时**重复返回同一新租约 ID**及同键异参不改账的分支。|
|S1-S2 过期预留、离线结算、充值审计|无法验证（运行）|`billing.ts:19-26,93-100,139-152`；复验 100 毫→预留 5→过期仍保留→24h stale→回连报 3→延迟 usage 不重扣。核对 `balance/ledger/leases/usage/audit`，并区分新租约预留。`server.test.ts:316-344` 中的断言本轮未执行。合约修改审计另属 S1-S6，当前 `tenant-management.ts:223-228` 未见写审计，不以充值审计代签。|
|W1–W3 台账、钻取、表单、权限按钮|部分有静态证据，整体不通过|`ledger.js:125-145,175-186` 按对象 `read` 和游标显示本页；`contract.js:18-38` 以 update 决定编辑、Tab 保留草稿；`billing.js:24-34` 以全局 `topup` 控制右侧充值。父项过滤和角色选项有上述缺陷。另注意 `members.js:90` 的分组选项只读第一页 200 项，不能用于证明大租户全量可选择。|
|W4 三级钻取、聊天、采集缺口、mock 标记|静态结构符合；双尺寸无法验证|`observation.js:29-39,40-76` 存在假数据标识、两次 detailPanel、gap 标签；`403` 不触发 mock（仅 404）。未获得本轮独立 1280×720 / 1440×900 浏览器截图、滚动尺寸和状态恢复记录，不能签收布局。S1-S4 到位后另测真实鉴权、SSE、费用和 ≤5s。|

**复验退出条件：** 在固定修复提交独立跑服务端测试和上表的账本、角色矩阵；给出两个 Provider/两个模型的分页响应、三种断流使用记录和 ACK、不同模型名/ID 的库行；两个视口保留台账、深层钻取和表单的截图与实测尺寸。开发者自测不能替代这些证据。

## 首轮补验（2026-11-19；分开记录两个快照）

**更新结论：仍不予整体验收。S2-01 断流状态、S2-02 模型 ID 落库两项在 `bf93824` 的持久化层已通过复验，可关闭首轮对应缺陷。** 父对象过滤及 admin 角色选项仍待修复复测。下面的数据取代首轮对应的“无法验证”，不追溯修改首轮结果。

|快照与命令（review worktree 根目录）|本次独立运行结果|能证明什么|
|---|---|---|
|`ab57d99`：`bun test ./server/test`|13 pass，1 skip，0 fail；168 次断言|含真实 HTTP/WS 的双设备争用 2 毫、同 op 重发、离线结算及迟到用量、邀请争最后一席、普通成员不能读成员台账或改合约、非平台身份不能充值。每设备 1 毫的用例最终共 2 笔 settle，余额/预留均 0，消耗 2。跳过的是外部 Valkey 测试；不代表所有角色组合均已覆盖。|
|`ab57d99` / `bf93824`：`bun test ./server/web/tests`|分别 24/24（89 次断言）、25/25（96 次断言）|JS 单测。后一快照包含合入的 `0aaf85c`；不把两版测试数相加。|
|`bf93824`：`bun test ./server/test`|4 pass，1 skip，1 fail、1 error；21 次断言。`server.test.ts` 导入时缺 `@noble/ciphers/chacha.js`|新版 HTTP/WS 套件未跑完；已请总督按新版依赖锁同步。`close()` 间歇竞态为总督另报，不用旧版一次成功证明消失。|
|`bf93824`：`bun test /Users/HHH/Code/OneX/coord/reports/review-s1-server-1-ingest.test.ts`|独立夹具 1 pass，0 fail；10 次断言。使用生产 `usageItems/ingestUsage/renewLease`、迁移与租户写队列，两个内存 SQLite 库，不模拟 SQL，也不启动 HTTP/WS。|三个断流状态一次入批；连续提交同批两次均 ACK=3，回读刚好三行，全部 `pending`，`model='display-name'` 与 `model_id='mod_A'` 不同，三行均保存 `mod_A`。说明 `usage.model_id` 覆盖问题也已在此版本修复，不必重复开发。|

**有余款的并发重放算例也通过。** 同一独立夹具充值 20,000 毫，签 1,000 毫旧租约，同设备并发提交两次 `used_milli=300`、同一 op。响应完全一致（含新租约 ID）；同键改报 301 被拒 `conflict`。租户库只有一笔 settle=300、一笔 release=700；新预留 985，可用 18,715，本月消耗 300，合计等于充值额。与原套件的余额耗尽分支互补。

**双尺寸截图核读，不冒充独立浏览器实测。** 实看 `s1-web/{1280x720,1440x900}-{groups,pricing,contract,billing}-real.png` 八张：可见分组台账页脚、三级左缩倍率台账、合约四个 Tab/无弹窗保存、2.075 橡皮余额与流水。倍率中栏查询框在两张图中均被压得几乎读不出占位文字，建议收缩态隐藏查询或提供可用宽度。另看两张 `*-observe.png`：人员→会话→对话三级与醒目缺口可见，明确标有“假数据”。截图只证明所示状态，不证明服务端分页、滚动还原、DOM 无外层溢出或实时 ≤5s；单 Provider 截图不推翻多 Provider 缺陷。

### 依赖同步后：`main@764e674`

在干净的 detached review worktree 重跑：`bun test ./server/test` **14 通过、1 跳过、0 失败**（194 次断言，跳过未配置的外部 Valkey）；`bun test ./server/web/tests` **25 通过、0 失败**（96 次断言）；本报告的 `review-s1-server-1-ingest.test.ts` **1 通过、0 失败**（10 次断言）。新版服务端套件不再因 `@noble/ciphers` 装载失败。独立夹具再次验证三种断流状态与模型 ID 的持久化、ACK 及幂等结算，首轮报告中的模型名覆盖 ID 缺陷在该正常双字段输入下未复现。单次全绿不能排除间歇性 `close()` 竞态。此次为首轮补跑，未对平台双筛选或权限显示新实现作第二轮签收。
