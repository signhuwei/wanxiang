# 渠道到租户的单链路联验

沿用[模型池](routing-p0.md)、[投影回执](routing-projection.md)和[租约门禁](routing-lease-gate.md)。验收使用两个本地测试上游，同一签约型号对应两个真实目录中的原始型号。平台与租户分别持有自己的账本。

1. 平台从 Provider 右栏用渠道凭据检查目录端点连通性，再逐页拉取该凭据可见的全部原始模型。目录中可以包含未签约的型号。拉特定页失败时记录部分结果并保留前次完整目录。人工核实原始型号和签约型号的关系后，候选才可进入模型池。
2. 在签约型号中勾选两个精确部署并预览、发布。按部署登记采购报价，在待签倍率中回看原币、折算和采用的价格。签发引用稳定型号和明确的池选择，历史签发固定售价。用户侧只用租户账本。
3. 渠道账户按 `funding_id` 归属资金。同一钱包的多个账户共享一份流水。平台可记录上游实际余额、已完成的充值和已确认费用。币种和整数微元贯穿记录，`balance_micro` 是最近一次余额观测加上之后的已确认充值、减去之后的费用。缺有效观测时用 `null`。充值按钮仅登记已有凭证，外部资金操作由供应商处理。
4. 设备应用已签投影并确认回执。独立联验使用受管 Codex 的非流式 Responses 入口。主渠道开始传输前确认为连接被拒绝时，同一个请求才会试下一条已签渠道。送达情况不明时保留本地待核对状态。终态回执的 `attempts` 按顺序记录 `attempt_id`、`deployment_id`、`deployment_revision` 和 `outcome`。允许前置尝试为 `connect_refused`，末次为 `completed`，后者须与实际用量的部署和尝试一致。Server 根据已应用投影和池上限逐条验证，随用量保存尝试清单。
5. 销售扣款按原租约与冻结售价结清，供应商账本按末次尝试的采购报价，以渠道原币入账。平台采购明细同时记录该报价时的汇率版本与折算金额 `amount_cny_micro`。同一笔实际用量补传时沿用原凭证。

平台资金接口为 `GET /v1/platform/providers/:provider_id/channel-ledger` 及其 `POST /recharges`、`/observations`、`/expenses`。提交包含 `account_id,currency,reference,note`，充值与费用用 `amount_micro`，余额观测用 `balance_micro`。账本只允许追加，幂等重放返回同一记录，凭证异参报冲突。真实调用的渠道费用凭证使用该次尝试与报价版本的组合标识。

联验使用独立实例配置中的 `executionTest`，Server、Edge 和两家测试上游均绑定本机回环地址。平台表单可用 `bun --no-env-file server/web/tests/channel-workspace-check.js` 验证。设备用量与双账本由 `edge/onexd/tests/route_apply_server.rs` 联验。
