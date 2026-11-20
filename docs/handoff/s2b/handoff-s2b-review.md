# s2b-review 交接说明（2026-11-20 11:15）

review 线只读，没有提交。worktree `/Users/HHH/Code/OneX/wt/s2b-review` 停在 detached `9ea17be`，`git status` 干净。所有产出都放在 `coord/reports/s2/`。

## 已完成

| 报告 | 对象 | 结论 |
| --- | --- | --- |
| `review-plan.md` | 契约 v0.12 | 列出疑点 C1–C15，验收用例 Q1–Q30、X1–X30、K1–K22、R1–R18。C1–C15 已由 v0.13（`cfeb824`）处理 |
| `contract-v013-check.md` | v0.13 `cfeb824` | 列出遗漏 V1–V6，已由 `61f66ac` 处理 |
| `quota-review.md` | 配额 Server `68132c7`；C1 的 Server 一半 `9ea17be` | 配额裁决通过。D2（`/balance` 改上海月份）已修。D3–D6 已由契约裁决。D7（主动推送 cutoff 后没花钱的设备无法恢复）已由 `2aad299` 处理，Edge 侧待做 |
| `quota-review.test.ts` | 反例测试草稿 | 在 `9ea17be` 上 21 条 × 3 = 63 通过。运行：`bun --no-env-file test /Users/HHH/Code/OneX/coord/reports/s2/quota-review.test.ts`。它引用 worktree 里的 Server 源码 |
| `kimi-capture-review.md` | `dev/s2b-kimi` `7e32dd6`、`eeccba1` | 不能合并：字段名是猜出来的，跑真实样本得到 0 条发言。K-B1–B5、K-C1–C3、C5、C6、K-S1、S2 已退回本批修；K-C4、K-S3、K-S4 列为已知缺口 |
| `codex-review.md` 第一部分 | `dev/s2b-codex` `0b488a9` 受管启动 | X-H1（项目配置可绕过 router）、X-H2（令牌被工具子进程继承）等已转 codex 线；X-L2 转 quota-api（S2B-Q5） |
| `codex-review.md` 第二部分 | `cda2c16` `/v1/responses` | 已回报，还没有裁决和分派：R-H1（预留为 0，流式期间不估算，额度不起作用）、R-H2（流中断时花费记 0）、R-H3（转 Chat 的 output_item.done 缺内容）、R-H4（custom、local_shell 工具和 reasoning 项被整条拒绝）、R-M1–M7、R-L1–L3 |

## 进行中

没有。最后一封回报信（`20261120T111302`）发出后，没有做到一半的工作。

## 尚未复验（下一步怎么接）

1. **C1 端到端**：等 lease 线 L1 和 quota-api Q3 交付后，用真实 onexd 加真实 Server 验证四条路径：续租回 cutoff（带 settled_lease_id）后，Edge 丢掉租约，`used` 减去快照值、不清零；`lease_request` 恢复（调高配额、跨月、充值各一次）；主动推送的 cutoff 在 `used=0` 时靠 `lease_request` 重申恢复（D7）；cutoff 期间结束的流，其花费带入新租约（V1）。Server 一半可以直接用 `quota-review.test.ts`。
2. **Kimi 复验**：用 `edge/onexd/tests/fixtures/kimi-wire/observed-1.5.synthetic.jsonl` 断言 4/3/8/8、0 条 gap、没有空的 assistant 发言；26 种顶层类型和 `step.begin`、`step.end`、`content.part` 的忽略清单有测试；K-C1、C2、C3、C5、C6、K-S1、K-S2 逐条核对。
3. **Codex 复验**：对照 `tests/fixtures/codex-rollout/` 合成样本复核采集器（X1–X30）；X-H1、X-H2、X-M1–M3、X-L1 的修复；Responses 的 R-H1–H4（先等总督裁决）。按 `codex-review.md` 两部分末尾的测试清单逐条检查。
4. **Edge 侧 quota_exhausted**（Q30）：三种 Agent 在配额耗尽时都报 `quota_exhausted`。按 C2 的裁决，以续租之后的提示为准。
5. **onex run 支持三个 Agent**（S2B-Q5），交付后再验。

## 已知问题

- 当前 worktree 看不到 `dev/s2b-*` 分支的文件，只能用 `git show <分支>:<路径>` 读，也跑不了这些分支的测试。所以 Kimi 和 Codex 的结论都来自静态审查，没有运行。
- 草稿用例在固定时钟下推进时间时，不要一次跳过半个月以上，否则网页会话会过期，返回 401。
- 每条 Bash 只能跑一条命令，不能用管道。
