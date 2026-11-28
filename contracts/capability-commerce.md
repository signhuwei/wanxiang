# 商业计费协议

## 条款版本和签发

平台通过 `GET /v1/platform/commerce/plans` 分页读取方案，`POST` 发布不可变版本。首次发布传 `{expected_version:0,name,terms}`，后续传系列 `plan_id` 和上一版本号。创建与修改接口使用 `Idempotency-Key`，版本过期返回 409。签发的 `billing.plan` 资源集合可选一个发行 ID（`cmp_…`）。租户协议价和额度不同，可克隆相应配置发布新版本再签发。

| terms 字段 | 单位与结算行为 |
| --- | --- |
| monthly_grant_milli / monthly_fee_fen | 上海自然月发放额度、合同月费（人民币分）。月费作为包月收费记录列示。签发和每月维护幂等发放，同一月只产生一条月包。 |
| model_prices | 每行指定平台模型 ID 和输入、输出、缓存读、缓存写四个 `*_milli_per_mtok` 单价。config.rates 使用协议价，账单保留实际模型与 Token 量。 |
| tiers | 边际阶梯，每段从 `from_milli` 起适用 `ratio_ppm`。第一段之前按全价，多个折扣相乘。 |
| commitment | `{up_to_milli,ratio_ppm}`。月度累计额度内适用承诺系数，超出部分按对应阶梯。 |
| model_budgets | 每行 `{model_id,monthly_milli}`，跨设备共享；0 阻止该模型，未配置的模型受总租约与组织配额控制。 |
| tool_prices | `{release_id,per_call_milli}`。可计费类型为已发布并授权的受管 MCP 与 HTTP 搜索发行。 |

`GET /v1/platform/commerce/model-tiers` 返回 `floor_model_id, revision, models[]`，每行含档位、输出费率和展示倍率。平台 PUT 传 `expected_revision, floor_model_id, models:[{model_id,tier}]`，档位为 floor、standard、pro、advanced、top。倍率按当前模型与基准模型输出费率之比计算，基准费率缺失或为零时返回 null。

## 钱包、租约及工具

平台读取 `GET /v1/platform/commerce/tenants/:tenant_id`，户主读取 `GET /v1/commerce/account`。返回当月及已有月包记录、永久额度和包月可用余额、未结租约、单模型用量与预留、协议档位、最近 100 条工具计费记录。金额字段 `*_milli` 为整数，一粒橡皮为 1,000 毫橡皮。

包月优先预留和抵扣，未使用余额在上海月界到期。旧租约延迟结清仍只支用其预留的原月套餐，原月余额到期后不再发放。原租约总额继续写一次 settle，模型明细仅归属消费。商业租约响应附 `commerce_plan_id`，有月度限制的实际模型附 `model_budgets: {model_id: allowance_milli}`。Edge 将模型的累计支出和按模型计的在途预留限制在已授额度内，实际目标模型 ID 同时用于用量与账目；在途尾差登记已用，耗尽后停止放行。

含子额度的租约在全部在途工作结束后持久化续租快照，发送 `lease_renew.model_used_milli`（每个获授模型都须报告，未用为 0）。重放必须复用 op_id、总金额和子账。服务端在一笔事务中核对、结清旧租约、释放各模型的子额度，再发新租约。缺上报时不释放旧额度。离线设备只可消费其已有、未过期的租约。变更计费方案后，旧方案租约先结清。

受管 MCP 的价格及授权按租约签发时冻结。最小计费凭据独立保留调用身份、调用时间、冻结价格及成功或失败状态，支持会话正文清理后的迟到和乱序上报。设备原生事件的 `tool_call` 和 `tool_result` 以设备、会话、子 Agent、原生调用 ID 配对，名称须匹配 `mcp__发行名称__方法`，成功结果触发按次扣费。内置工具、原生调用失败、没有唯一发行匹配的调用不扣费。余额不足记待补款，维护任务或下一次租约重新尝试。账本金额由服务端读取已签方案产生。

### 独立付费搜索

平台管理员通过现有 `POST /v1/platform/tool-releases` 登记 `kind:"http_search"`、名称、版本、适用 Agent、固定 HTTPS `endpoint` 及上游 Bearer 凭据 `secret`。凭据加密存于 Server，登记后随发行版本固定。平台沿用发布与停用接口，HTTP 搜索发行由 Server 执行，无安装包或设备制品下载地址。成员需通过 `access.tools` 获得对应发行，并在已签商业方案的 `tool_prices` 下持有该发行的单次费率。

设备使用注册时获得的 Bearer 向同一 OneX Server 发送 `POST /v1/edge/tool-search/:release_id`，必填 `Idempotency-Key`，请求体为 `{session_id,query,limit}`。搜索发起方须从受管会话绑定获取 OneX 会话 ID。Server 核验当前设备、成员、活动会话归属、匹配当前签发方案的有效租约、适用 Agent 及网络权限。会话未登记或已结束时拒绝，客户端可在会话登记或接续后重试。同一设备和会话内，相同键必须对应同一发行和同一请求参数。不同参数返回 409。

上游接口接受 `POST {query,limit}` 并返回 `{results:[{url,title,snippet}]}`。Server 使用管理端固定的上游地址，拒绝重定向，限制响应时间和尺寸，按合约限制公网出口。Server 在请求上游前预留费用，优先使用当月月包。只有上游成功且完整响应通过校验后才产生一笔扣款。失败或无法确认结果时释放预留，不再用同一键发起上游请求。有效的空列表属于成功。

首次成功返回 `{receipt,results}`。已结算的同参重放只返回相同 `receipt`。执行中的同参重放返回 202 和等待回执。重放确定失败或过期未确认的调用返回 502 和原调用回执。HTTP 搜索与收费记录只保留请求指纹、服务版本、会话、次数金额、结算状态和账本关联。Agent 的会话正文及原生工具事件依会话留存条款处理。

生效设备快照的 `policy.search_tools` 可含 `{id,name,agents}`，仅列出合约已授权、已发布并在当前商业方案中有单次费率的搜索发行。受管 Claude Code、Codex 和 Kimi Code 将本机搜索装配为 stdio MCP 工具。其启动票据仅用于该受管启动和相应搜索发行，由 onexd 绑定当前原生会话。工具进程只能传查询和数量，设备 Bearer 保留在 onexd，上游地址和凭据保留在 Server。厂商自带的托管搜索继续使用原厂行为。

同一 stdio 连接中重传同一个 MCP 调用 ID 时，onexd 沿用首次的幂等键及原生会话归属。已结算重放只返回原收费回执。新 stdio 连接开辟自己的调用 ID 空间。

月结沿用 `/v1/platform/policy/contracts/:tenant_id/discounts/:month` 和 `/v1/policy/discounts/:month`。折扣基于实际已结清的模型消费按上海自然月累计，在固定比例、阶梯比例和承诺比例相乘后按签约版本汇总向上取整，记录返还明细。

月结报告中 `cash_credit_milli` 为实际退回永久余额的数量，最多等于当月永久橡皮实际扣款。剩余折扣列在 `expired_package_credit_milli`，保留月包有效期。
