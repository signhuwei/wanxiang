# Server 批次完成报告

- S1-S1 `fb446ac`：租户、成员、组、邀约、合约以及平台目录。写入带 revision 和幂等，Provider 凭据 AES-256-GCM 落库，邀请码仅首次返回。
- S1-S2 `ccd33fa`、`1dacd06`：事务内橡皮预留与结算、独立平台充值、离线保留，续租重放恢复同一新租约，用量按设备汇总对账。
- S1-S3 `0aaf85c`：持久单调配置 revision，按许可下发路由和加密到设备 X25519 公钥的凭据。
- S1-S4 `8550a45`、`e8b07dc`：事件和用量共享连续 ACK；正文读取审计、按租户/角色/所有者约束，SSE 只推摘要；拒绝和记录跨设备会话事件。本机 50 台假设备 × 20 条/秒 × 60 秒共 60,000 条，ACK p50 10.679 ms、p99 43.009 ms，无 SQLITE_BUSY。
- 审查与联调 `5f34ca4`、`16fd03c`、`dddf169`：成员筛选/actions、关闭排队写入、模型与倍率筛选、用量保留模型名和 ID、监察月费用/轮次；完整 Server 测试串行 30 轮通过。
- MVP `894d659`、`2e207ae`、`535d348`：安装/部署/回退脚本和同源 Web、会话 `read_content`、本地 Qwen seed 及 OpenAI Chat 路由下发。

最终本机 `bun test server/test tests/e2e/fake-upstream`：27 通过、1 跳过（未配置测试 Valkey）、0 失败；`bun run --cwd server typecheck` 通过。未调用真实上游或连接 211。总督验证了五个 Shell 脚本语法、固定版本安装、第二次运行幂等、三个进程启停，以及接真实 Valkey 后该快照 Server 测试 19/19 通过。`a41dfda` 按反馈为下载失败添加 `HTTPS_PROXY` 提示。211 由总督部署；操作命令见 `deploy/README.md`。
