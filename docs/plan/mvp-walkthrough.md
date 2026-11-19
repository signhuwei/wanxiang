# OneX MVP 人工验收步骤

目标：管理员在 211 核对真实租户配置；员工在 Mac 上用 OneX 启动受管 Claude Code，经 local qwen 完成三轮对话；管理员看到新增正文和橡皮费用；在独立小余额租户验证耗尽后的下一次模型请求被拒。范围以 `docs/plan/mvp.md` 为准。本文是待执行手册，不是通过报告。

## 0. 准备与健康检查

总督部署后提供实际管理端 URL、部署提交、匹配的 Mac 版 `onexd`/`onex-cli` 和测试账号：具平台权限的管理员、MVP 租户 owner、已加入租户的员工。前两个角色可由同一账号担任，但员工应是独立账号。另备第 5 步的小余额租户，不消耗主演示租户的 1000 橡皮。Mac 须有 `claude`，并能访问 211 和 `192.168.3.212:11516`。下文 `18700` 是部署约定默认端口，以实配协议和端口为准。

在 Mac 执行：

```sh
export ONEX_URL=http://192.168.3.211:18700
curl -fsS --max-time 10 "$ONEX_URL/v1/healthz"
command -v onexd onex-cli claude
claude --version
```

**期望：** 健康接口成功，提交号匹配；记录三个命令的实际路径、Claude Code 版本。新 CLI 的命令名暂按 MVP 计划。若只装了旧 `onex login <device_token>` 调试入口，记未就绪，不拿它替代交互登录。

**失败去哪看：** 网络或健康接口失败，请有权限的运维只读查 OneX，勿动同机 SIMA：

```sh
ssh root@192.168.3.211 'systemctl status onex-server --no-pager'
ssh root@192.168.3.211 'journalctl -u onex-server -n 80 --no-pager'
```

日志可能含开发验证码，只在受信终端查看，不转发原日志或保存验证码、令牌、密钥。

## 1. 管理员登录，确认租户、Provider 和额度

1. 浏览器打开 `http://192.168.3.211:18700/#/login`（用实际地址），不加 mock 参数，不应显示「假数据」。输入平台管理员测试账号，点「发送验证码」，用实际收到的验证码登录。若 211 使用开发验证码发送器，请运维在 Server 日志查看该账号最新的 `onex-dev` 验证码；不用 mock 固定码。
2. 到「平台」核对 MVP 租户；「Provider」→ `local qwen` →「模型目录」→「倍率记录」。应为 `openai_chat`、`http://192.168.3.212:11516/v1`、上游模型 `Qwen3.8-27B`。记 `model_id` 及已生效的输入、输出、缓存读取和缓存写入费率。上游免 API Key，但 OneX MVP 仍按契约下发加密占位密钥。
3. 用 owner 身份选 MVP 租户（账号不同则用独立浏览器会话）。在「租户 → 成员」查测试员工；在「合约」确认允许 `claude-code` 及该模型 ID；到「橡皮」记录可用余额、已预留、本月消耗与 seed 的 1000 橡皮充值记录。打开「监察」备用。

**期望：** 身份、租户、员工、模型和费率匹配。1000 橡皮指 seed 的充值额；已发租约时可用余额不一定仍是 1000。

**失败去哪看：** 验证码/登录失败查 211 的 `onex-server` 日志；缺「平台」先核对平台权限。浏览器 Network 看 `/v1/me`、`/v1/platform/providers`、`/v1/contract`、`/v1/balance` 的状态码和错误。不导出含认证头的 HAR。

## 2. 员工登录并注册 Mac Edge

终端 A 启动专用 daemon（已启动同一验收实例则不再启动第二份）。HTTPS 部署使用匹配的 `wss://` 地址。

```sh
export ONEX_HOME="$HOME/Library/Application Support/OneX-MVP"
export ONEX_SERVER=ws://192.168.3.211:18700/v1/edge/ws
onexd
```

终端 B 使用相同数据目录：

```sh
export ONEX_HOME="$HOME/Library/Application Support/OneX-MVP"
onex-cli login
```

按候选 CLI 提示或交付说明设置 Server 的 **HTTP 基址**（不是 WS 地址），输入已入租员工账号及其新验证码，按需选 MVP 租户。最终 CLI 的 URL 参数/环境变量尚未冻结，不猜选项；不要在命令行放设备令牌。管理员同时到「租户 → 设备」核对这台 Mac 和所属员工。

**期望：** 登录、注册、WS `welcome`、配置应用、Provider 密钥就绪、有效正额租约依次出现；密钥只看状态，不打印值。设备显示在线并不单独证明可请求模型。

**失败去哪看：** 先看 CLI stderr，核对两个终端的 `ONEX_HOME`；再看 Mac `$ONEX_HOME/logs/onexd.*.log` 与 211 `onex-server` 日志。没有 `welcome` 查 WS 地址/设备鉴权；有 `welcome` 无路由，查模型合约、费率及 Chat 路由下发；有路由无密钥，查注册公钥和 secret 解密状态；无租约查「橡皮」及 Server 发放日志。只收集时间、结果和关联 ID。

## 3. 启动受管 Claude Code，做三轮对话

在终端 B 新建一个空工作目录，不在真实项目中演示：

```sh
DEMO_DIR="$(mktemp -d)"
cd "$DEMO_DIR"
onex-cli run claude-code
```

把下方 `MVP-1530` 换成本次唯一标记。每轮等到回复后再发下一轮：

1. `本次标记是 MVP-1530。只回复「收到 MVP-1530」，不要调用工具。`
2. `上一轮的标记是什么？只回复标记。`
3. 等管理员按第 4 步打开这条会话，不刷新阅读页，发 `最后一轮。请用一句话说出标记，不要调用工具。`

**期望：** CLI 使用已安装的 `claude` 打开受管终端，无需个人 Claude 登录；三轮都有回复，同一会话承接标记。Edge 记录对应会话、路由和用量，路径为 Claude Code → 本机 router → Chat `/v1/chat/completions` → local qwen，而非 OneX Server 中继。不要直接运行裸 `claude` 代签。

**失败去哪看：** 未打开界面查 CLI stderr、`command -v claude`、Edge 启动日志。首轮失败查 `$ONEX_HOME/logs/onexd.*.log` 的路由、租约、上游分类。只需判定可达性时，Mac 可执行 `curl -fsS --max-time 5 http://192.168.3.212:11516/v1/models`，不发送生成请求；这不能替代转换联验。若模型已有回复但监察为空，不重发成功请求，查第 4 步。

## 4. 管理员核对实时正文与橡皮费用

1. 前两轮完成后，同一租户打开「监察 → 员工 → 最新 Claude Code 会话」，用开始时间和标记核对。保持阅读页打开，等员工发第 3 轮。
2. 不手动刷新；看「实时更新已连接」，记录第三轮输入和输出、轮数以及费用摘要首次可见的时间。三轮正文按序、只出现一次。核对输入/输出/两类缓存 token 与橡皮费用；用已生效费率复算，`1 橡皮 = 1000 毫橡皮`。费用显示「待结算」不等于免费或已扣账；「橡皮」页的预留和结算也不是同一笔消费。

**期望：** 有权限的 owner 能读同一场会话的正文和费用；最后一轮不用手刷即可出现。记录实际延迟，不拿本次 MVP 演示代签完整 S1 指标。

**失败去哪看：** 浏览器 Network 查 `/v1/observe/people`、`/v1/observe/sessions`、`/v1/observe/sessions/:id/events` 和 `/v1/observe/stream`。仅见摘要或读正文 403 时检查会话 `actions` 是否含 `read_content`，核对角色/合约，不关闭授权。没有会话或费用时，用 `device_id`、`session_id`、`request_id` 对照 Mac 的采集/outbox、WS 确认，再查 211 写入日志。只留合成对话、脱敏 ID 与时间。

## 5. 独立小余额租户：真耗尽后拒绝下一次模型请求

请有权限的操作者备新租户、已入租员工、同上游的独立测试模型记录，无历史未结租约。建议夹具：初始为 0，平台管理员在「橡皮 → 充值」加 `0.001` 橡皮（1 毫橡皮）；测试模型输入、输出各 `1` 毫橡皮/Mtok，缓存费率 0，确保首次请求预留可放进 1 毫橡皮，真实非零用量整笔向上取整到 1。不要改变主演示模型费率；若夹具不能满足首轮成功，先换等价的小额度夹具，否则本项标「无法验证」。不要设合约额度为零、停设备或直接改 DB 来模拟耗尽。

1. 用独立 `ONEX_HOME` 和该员工重复第 2 步、运行 `onex-cli run claude-code`。如要关掉旧测试实例，在启动它的专用终端按 Ctrl+C，不按进程名批量停止。发送一轮短文本，例如 `只回复「余额首轮」`，确认有回复和费用。
2. 核对该租约用量/续租结算，余额及可用本地额度确实耗尽。**页面可用余额为 0、但还有可花预留时，不算耗尽。** 在同一会话发送 `只回复「余额次轮」`，记录拒绝。
3. 对照本机 router、上游请求计数或运维可查的对应请求记录以及 Server 流水。下一轮不得发上游或新增扣款，应返回 Anthropic 格式 HTTP 402 `balance_exhausted`，Claude Code 可见明确的额度原因及联系管理员充值提示。首轮预留过大、租约过期、设备被停用、上游掉线都不能代签。没有拒绝轮零出站证据，单列缺证。

**失败去哪看：** Mac `onexd.*.log` 对照首轮 usage、续租/`cutoff` 和本机拒绝，211 `journalctl -u onex-server` 查对应设备；在「橡皮」核对已预留、结算、可用余额，勿只凭 Claude Code 的通用错误文案判定。

## 结束记录

按第 1–5 步标「通过／不通过／无法验证」。附部署提交、Edge/Claude Code 版本、脱敏租户/设备/会话 ID、最后一轮出现时间及费用、余额前后与拒绝证据。失败记录首个异常和日志位置，不含凭据。Tauri、Mac 安装包、Claude Code 下载校验、长稳与完整断网、跨进程续租复验不在本轮范围。
