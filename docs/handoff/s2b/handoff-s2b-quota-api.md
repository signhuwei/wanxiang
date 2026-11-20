# S2B quota-api 交接（总督代为落盘，原文来自邮件）

ONEX_WORKER_STOP 收尾。写 coord/reports/s2/handoff-s2b-quota-api.md 被工具拒绝（权限只到 edge/onex-cli/ 和 worktree 内，没有 coord/ 写权限），交接内容写在这封信里，请总督代为落盘或告知怎么补权限。

工作树状态：/Users/HHH/Code/OneX/wt/s2b-quota-api，分支 dev/s2b-quota-api，git status 干净（nothing to commit, working tree clean），HEAD 在 31e2f1f。

已完成（提交号，均在本分支；前五项已被总督合入 main 并快进回本分支）：
- S2B-Q1 c7544b5（合入 68132c7）：配额裁决 issue()、/quota/usage、/me.quota、台账 month_used_milli。补充 978bcc8：负数 remaining_milli 不钳制。
- S2B-Q2 61d35ab（合入 351eb06）：配额剩 1 签发 1 毫橡皮租约、换组后用量随当前归属实时计算，两条都是补测试锁定既有正确行为。
- S2B-Q3 83bd315（合入 9ea17be）：cutoff 带 settled_lease_id、新增 lease_request/requestLease()、/balance 改 Asia/Shanghai（独立验收缺陷 C5）、断流优先级和 limited_by 平局核对。续篇 7b01fe9（合入 86e731e）：/quota/usage 无权和不存在一律 404，外加复核独立验收草稿里 Server 相关用例。
- S2B-Q4 7ff0659（合入 edf7d79）：/members /groups 本月已用从逐行 N+1 改成 monthUsageByUser()/monthUsageByGroup() 固定数量聚合查询，200 成员 10 组测试对比逐行结果一致。
- S2B-Q5 31e2f1f（本分支最新提交，还没发给总督审阅，是被 STOP 打断前刚提交完的）：edge/onex-cli/src/main.rs，onex run 从只认 claude-code 改成 onex run <claude-code|codex|kimi-code>，未知 agent 报错列可选项，非 --managed 时按 agent 去 PATH 找对应可执行文件（claude-code→claude、codex→codex、kimi-code→kimi），Request::Launch.agent 传实际请求的 agent。cargo test -p onex-cli：11 通过（8 新增，3 原有）。

进行中：无。S2B-Q5 提交后立即被移交打断，还没来得及发完成回报信。

未开始：S2B-Q5 没有碰 edge/onexd/，LAUNCHABLE_AGENTS 仍只有 claude-code，codex/kimi 的受管启动要等那两条线接入后才能用 --managed 跑通；不带 --managed 的 PATH 查找现在就能用。

已知问题：
1. codex→codex、kimi-code→kimi 的 PATH 可执行文件名是按总督任务描述原话实现的，docs/specs/agents 里没有明确写个人安装场景的可执行文件名，如验收发现不对只需要改 main.rs 顶部 AGENTS 常量。
2. S2B-Q3 独立验收标 DEFECT C1 的两条（续租回 cutoff 后 Edge 真实重连路径仍重放旧 lease_id/op_id，充值/调额/跨月都不能恢复）在 edge/onexd/src/lease.rs，不在我的写入范围，Server 侧已经把 settled_lease_id 和 lease_request 做好，Edge 怎么用需要排给 lease 线。
3. coord/reports/s2/quota-review.test.ts 是独立验收的只读参考草稿，S2B-Q3/Q4 的测试补充很大程度上照它重放确认，里面的两条 DEFECT C1 没有在我范围内处理。

Server 侧最后一次全量回归（7ff0659 时点）：bun --no-env-file test server/test tests/e2e/fake-upstream 83 测试 82 pass 1 skip 0 fail；bunx tsc --noEmit -p server 无错误。S2B-Q5 之后没碰 Server 代码，没有重新跑。

下一步：1）先审 S2B-Q5（31e2f1f），cargo test -p onex-cli 应该在独立编译缓存下直接跑通。2）Edge 侧对接 v0.13 恢复协议（settled_lease_id 删租约、lease_request 定时+连上即发）排给 lease 线。3）codex/kimi 两条线接入 LAUNCHABLE_AGENTS 后 S2B-Q5 的 --managed 路径才完整。4）review 线复核 S2B-Q5 时关注未知 agent 报错、--model/--managed 任意顺序解析、三个 agent 的 PATH 查找、Launch.agent 字段是否传了真实请求的 agent。

停止领信，等待处理。
