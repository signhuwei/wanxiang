# 渠道型号采纳与管理员实测

## 调研结论

- OpenAI 的组织费用接口是 `GET /v1/organization/costs`，模型用量从 `GET /v1/organization/usage/completions` 等按能力分开的接口读取。组织接口用 Admin API Key。组织支出上限和费用统计各有口径。OneX 以费用观测和对账引用存放这些数据，预付余额另用明确支持余额的接口或凭证登记。 [OpenAI 组织接口](https://developers.openai.com/api/reference/typescript/resources/admin/subresources/organization#usage) · [OpenAI Admin API](https://developers.openai.com/api/docs/guides/admin-apis)
- OpenRouter 目录提供规范 ID、展示名、上下文、输入和输出模态、参数及价格参考。Hugging Face 模型卡和仓库配置用于核对开源权重、大小和变体。Models.dev 可补充厂商、上下文、输出限制、工具、推理和模态等字段。价格参考保留来源及单位。 [OpenRouter 模型目录](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties) · [Hugging Face 模型元数据](https://huggingface.co/docs/huggingface_hub/main/package_reference/cli#hf-models-list) · [Models.dev](https://models.dev/)
- CC Switch 先读渠道的模型列表，用户选中后才以渠道预设和 Models.dev 补空字段，并标示来源。Magpie 在本地目录维护同型号匹配和不同来源的快照。OneX 沿用目录候选、真实渠道观测和人工确认三个不同用途。 [CC Switch 模型列表](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.6-aggregation.md#fill-model-information-automatically)

## 实施顺序

1. 发布按厂商组织、可检索的参考码表。存展示名、原始参考 ID、厂商、系列、变体、快照、上下文、输出上限、参考模态和来源。精确匹配优先。渠道实报字段优先于公共参考。来源缺失显示未知，运营可选来源或填入人工核实值。公共价格只作为报价参考。
2. 在 Provider 原始模型卡右栏显示渠道实报值、参考码表及采用值。「以此渠道新建」直接引用当前目录项和渠道 revision，原始 ID 自动绑定。「归并到已有」显示目标身份和差异。新建、型号身份及渠道关联原子保存，重复操作复用已有同渠道型号。卡片显示实测、采纳和已发布池，原有签发及设备回执继续使用各自的版本。
3. 平台管理员测试钱包按管理员和上海自然月分配。新版限额从明确分配开始，不占用租户余额。对当前渠道原始模型发送单条固定文本，限制输出和超时，关闭工具及自动重试。发前按可追溯测试费率预留，返回有效用量后只扣一次；送达或用量不明保留待核对状态。平台管理员操作、预算、上游响应状态及证据关联同一测试 ID。
4. 在隔离环境验证参数优先级、重复采纳、真实请求、用量、额度、权限、失败状态和签发前后可追溯性。发布后核对 211 四个渠道的当前目录，刷新旧渠道修订的目录，用实测和资料建立现有型号或逐项登记待补字段。发布模型池及倍率须有真实采购价和与目标入口兼容的协议。扩大租户授权仍走对应租户签发。

## 验收条件

- 从渠道卡选型号就能看懂填写依据，且重拉目录后仍能看到原型号的处理记录。
- 可按厂商浏览同期参考码表。某部署的身份、能力和实际成本有独立渠道证据。
- 管理员有独立的测试橡皮配额和流水。同一笔已发送测试重放不重复调用或扣费。
- 211 的所有当前目录项都有可查的签约型号关系或逐项阻塞原因。签发和下发继续使用已验证且支持当前入口协议的渠道。
