# 多渠道路由的报价、待签费率与设备暂存

本批沿用[模型池首批协议](routing-p0.md)。边界为平台报价和待签费率的发布、回读，以及设备侧配置暂存联验。实际签发选价、设备生效和请求结算接续完成。

## 采购报价和汇率

所有 HTTP 路径前缀为 `/v1/platform`，继续按实际授权返回 `actions`。写操作用现有 `Idempotency-Key`。验证权限后先读幂等成功记录，再校验当前修订。同键同请求返回原 201，同键异请求返回 409。报价和汇率的历史记录、发布头、审计及回放结果在系统库事务中提交。

| 方法和路径 | 请求及结果 |
| --- | --- |
| `POST /deployments/:deployment_id/quotes` | `{deployment_revision,expected_quote_revision,currency,tariff_scope:{kind:"deployment"},valid_from,valid_until?,source:{kind:"manual",reference?},reason,items:[{dimension,rate_micro,quantity_basis,unit}]}`。发布返回完整不可变报价及 `quote_id,quote_revision`。第一版的范围是明确适用于该部署及其所归账户的固定单价。 |
| `GET /deployments/:deployment_id/quotes` | 沿用 `{items,total,next_cursor,actions}`。额外返回 `deployment_revision`（当前不可变部署修订）和 `head_revision`（报价发布头，无发布头时为 0）。传 `as_of` 时额外返回 `applicable`，命中为该版报价，缺失为 null。集合动作 `publish_quote`。 |
| `GET /deployments/:deployment_id/quotes/:quote_id/revisions/:quote_revision` | 精确回读发布版本，核对路径部署和报价归属。条目动作 `read`。 |
| `POST /procurement/fx-rates` | `{base_currency,quote_currency:"CNY",expected_fx_revision,rate_numerator,rate_denominator,observed_at,valid_from,valid_until,source:{kind:"manual",reference?},reason}`。返回完整版本及 `fx_revision`。 |
| `GET /procurement/fx-rates` | 按 `base_currency` 查询到人民币的发布史。分页、`head_revision`、`as_of` 和 `applicable` 同报价。集合动作 `publish_fx_rate`。 |
| `GET /procurement/fx-rates/:base_currency/CNY/revisions/:fx_revision` | 回读精确汇率版本。条目动作 `read`。 |

- 币种为三位大写 ASCII；价格和汇率整数以规范十进制字符串传输，最多 38 位。价格非负；汇率分子分母为正，方向为原币一单位可换多少人民币。人民币报价直接用 1/1。原报价无需等待汇率即可登记。
- 维度限 `input/output/cache_read/cache_write/request`，每个维度至多一项。数量单位为 `token` 或 `request`，`quantity_basis` 为正安全整数。明确零价和缺项区分；缺项也不计作零价。单位、用途和未知字段在 Server 校验。自动采样、阶梯、分时和多资费适用性后续使用评审稿中保留的结构。
- 期望修订比对同系列最后发布版，包括未来生效版本。有效区间采用 UTC 的左闭右开。按生效时间顺序发布；下一生效时点截断前一版本的有效查找区间，原历史行保持可回读。下一版到期后也不会自动恢复早先报价。报价当前适用性还要求准确的部署修订。Provider 卡片的 `revision` 表示可编辑资料修订，写报价须用报价列表给出的 `deployment_revision`。
- 报价列表和历史、汇率列表和历史均只对有读取采购权限的平台角色开放。渠道卡片增加 `read_quotes` 动作作为报价入口。版本关系从服务端派生。金额、汇率及凭据之外的人工说明也随采购明细留在平台。

## 可签输入倍率

沿用现有 HTTP 评审约定的 `POST /models/:model_id/input-multiplier/preview`、`POST /models/:model_id/input-multiplier/revisions`、`GET /models/:model_id/input-multiplier/revisions/:source_rate_key`。三端沿用 `input_multiplier_basis="cny_1_per_mtok_input"`。台账增加 `current_source_rate_key`（无新版时为 null）和 `input_multiplier_ppm`（无可展示费率时为 null），行上的 `preview_input_multiplier` 动作控制表单入口。版本冲突详情提供当前 `current_pool_revision,current_source_rate_key`，供表单保留草稿后重算。

- 预览请求 `{expected_pool_revision,expected_source_rate_key,pricing_at?,manual_input_multiplier_ppm?,reason?}`；响应含 `pricing_at,input_multiplier_basis,recommended_input_multiplier_ppm,input_multiplier_ppm,input_milli_per_mtok,calculation_status,channels,preview_basis,actions`。渠道项保留部署及其修订、报价引用、原币及金额、数量单位、汇率引用和展示换算，未得到有效值时带 `reason_code`。池资格由 Server 判断，短时冷却和余额变化不挪走仍合格的定价样本。
- 建议取合格样本的最高普通输入价，以人民币 1 元／百万为基价，用整数或有理数计算并只在最终向上取整一次。A/B 公用样例得到 3×。手调 4× 为 `4000000` ppm、`4000` 毫橡皮／百万输入 Token。缺报价、缺汇率和过期汇率按渠道显示；存在缺项、偏离建议、手调零须附理由。输出、缓存读写保持各自独立的费率。
- 发布沿用同一草稿和不透明的 `preview_basis`，明确回传预览的 `pricing_at`。事务重验池、平台可签费率头、报价和 FX 区间与版本。给当前报价出具的预览在相关版本变更或有效期跨界后不可提交。发布成功得到 201 和 `{model_id,source_rate_key,input_multiplier_basis,input_multiplier_ppm,input_milli_per_mtok,status:"available_to_sign"}`。详细依据按 `source_rate_key` 回读。采购或待签价发布不直接修改历史签发、设备配置、租约或账本。
- WebUI 供应商渠道卡片进入采购报价、平台侧登记汇率、签约型号进入倍率表单，均用台账左缩和右侧同一表单。分别显示报价已发布、完整／部分试算和可签倍率。流程使用服务端动作，错误保留表单，冲突要求重算。

## 设备暂存接口

- Server 和 Edge 继续使用设备协议的 `config` 完整形状，分别实现封装与暂存解封。X25519 发送方的临时公钥仍用 `key_id`，信封留在 `route_pool.secrets`。用 RFC 4648 标准 base64、空 HKDF salt、32 字节 HKDF SHA-256 输出、24 字节 nonce、尾附 16 字节认证标签。新版 info 为 UTF-8 `onex-edge-route-secret-v1`。AAD 为无空格的 UTF-8 JSON 数组 `["onex-edge-route-secret-v1",tenant_id,device_id,projection_id,revision,credential_id,credential_version]`；ID 限 ASCII 字母、数字、下划线、连字符和点。
- 暂存输入包括认证会话的租户、成员及设备、可信当前时间、设备私钥、当前配置修订及已知撤销修订；在读运行态前完成快照引用、绑定、费率窗口、推理信封和有效期校验。暂存结果和诊断脱敏。信封密钥按 `(credential_id,credential_version)` 精确匹配。重复引用同一密钥允许，每个精确引用仅有一个信封，额外、缺失或解封失败皆拒绝。密钥限在内存，管理凭据和采购数据不入帧。平台封装函数拒绝管理用途。测试使用固定公私钥和动态 nonce。
- 同一设备配置身份沿用 `(device_id,config_revision,projection_id)`。比较投影有效内容时排除传输帧 `id` 和信封的 `key_id,nonce,ciphertext`，保留所有凭据 ID 和版本。至少用相同语义快照重封、同修订异投影、同身份改绑定或费率、撤销倒退、不同设备解封五组负正例。摘要本批在各端内部比较，不加新传输字段。
- 暂存阶段从测试入口调用，验证拒绝不更新路由、模型标签、租约和应用游标。现网路径暂不声明或选中该能力，暂存也不发 `config_applied` 成功。后续由 Server 持久化目标、Edge 原子应用、Server 验回执和新租约入口组成实际生效联验。

跨语言合成向量采用接收私钥 `0x07` 重复 32 字节、发送私钥 `0x08` 重复 32 字节、nonce 为 0 至 23 的递增字节及明文 `fixture-inference-key`。AAD 为 `["onex-edge-route-secret-v1","ten_demo","dev_lin","prj_91",91,"cred_a",1]`；期望 `key_id=MdSras7slhE3kXA3k25gcW+sVzr+lNnahKgCBEjfwRI=`、`nonce=AAECAwQFBgcICQoLDA0ODxAREhMUFRYX`、`ciphertext=fp1Fke4jFdKim93jA03oMTHhmAJmfFP4SJR5swErN1Rsv1DzXg==`。

## 联合验收

使用共用样例，实际管理 API 发布 A/B 采购价和恰当有效的 15/2 USD→CNY 汇率，Chrome 预览 3× 并发布手调 4×。查看临近生效边界、过期报价和过期汇率、平台权限、回读与幂等冲突。用相同样例由 Server 封装有效信封，Rust 验证凭据、绑定与 4× 价窗，并复用同一密钥版本进行重封检查。所有旧连接继续走原收到的协议。
