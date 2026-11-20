# S2B lease 交接（总督代写）

lease 线收尾时模型网关返回 429（额度用完），没能发出交接信。以下由总督按分支和测试结果整理。

- 分支 `dev/s2b-lease`：`5fb0db8`（v0.13 断流恢复）、`6d0169d`（按 61f66ac、2aad299 修正：收到 settled cutoff 时 `used -= 快照`，不清零；cutoff 且无待处理续租就发 `lease_request`，不论是否持有租约）。工作树干净。
- 已合入 `main`（`c552431`）。总督去掉了 `e2e_lease_server.rs` 里恢复用例的 `#[ignore]`（`68b0572`），对真实 Bun Server 跑通：余额耗尽 → 续租回 settled cutoff → 充值 → `lease_request` 拿到新租约。Edge 全量 246 通过 1 跳过。
- 未做：主动 `cutoff{disabled}` 且未花钱 → 启用 → 恢复，以及配额耗尽 → 调高 → 恢复这两条，对真实 Server 的端到端还没写（单测已覆盖逻辑）。独立验收的 C1 端到端复验也还没做。
