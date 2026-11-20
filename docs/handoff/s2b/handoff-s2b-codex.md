# S2B codex 交接（总督代为落盘，原文来自邮件）

ONEX_WORKER_STOP 收到，收尾汇报（未能写 coord/reports/s2/handoff-s2b-codex.md，Write/Bash 对 coord/ 路径的权限对这个 worktree 是拒绝的，交接内容直接写在这封信里，请总督代为落盘或告知正确写入方式）。

git status：干净提交 3 个（869bcdf、0b488a9、cda2c16），工作树里有未提交、未测试的改动：onexd/src/capture.rs、onexd/src/ipc.rs、onexd/src/lib.rs 的修改，以及新文件 onexd/src/codex_capture.rs（未加入 git）。按规则不提交未测通的东西，原样留在工作树，没有 git add。

cargo test -p onexd 用新的独立 CARGO_TARGET_DIR 重跑过，三个已提交的步骤全过（125 lib + 19 + 1 + 2 + 8 + 3 ignored1 + 12 responses + 42 router + 23 ws）。

��完成（已提交）：
1. 869bcdf 按 agent 分派受管启动（governor 已审，结构可以）。
2. 0b488a9 Codex 受管启动 config.toml——已被独立验收退回（codex-review.md「验收一」）：X-H1 高危，没用 -c 固定路由字段，项目 .codex/config.toml 能让员工绕过 router 不计费；X-H2 高危，本机令牌经环境变量会被 shell 工具子进程继承；X-M1 config.toml 写在持久目录多窗口互相覆盖、PROVIDER_ID 写死和注释不符；X-M2 配置键没出处（check_updates 应为 check_for_update_on_startup 等）；X-M3 session_id 还是随机 v4，契约 61f66ac 已改成 UUID v5(设备,"codex:<thread id>")；X-L1 XDG 没重定向。
3. cda2c16 router /v1/responses——同样被退回（codex-review.md「验收二」）：R-H1/R-H2 高危，预留缺省按 0 算（应按 4096 不超租约剩余）、流式期间两条路径都不按已收输出估算实时花费，租约上限在 Responses 入口基本不起作用，中断时花费记 0 应按已收部分算；R-H3/R-H4 高危待实物验证，转 Chat 流的 output_item.done 缺字段导致 Codex 可能解析不进历史，Codex 常发的 custom/local_shell/web_search 工具和 reasoning input 项会被整条拒绝，MVP 上游是 openai_chat 这条路径很可能第一轮就失败；另有 R-M1~M7、R-L1~L3 一串中低问题（错误体 type 丢弃 block_error 的 kind、HTTP 状态码不对、previous_response_id 该只在转 Chat 时拒绝、URL 拼出两个 /v1、转发了客户端全部头等）。报告末尾列了 6 条该补的 Responses 测试、4 条该补的受管启动测试。

两次契约修订要对齐（这个 worktree 上 main 看不到，需要 git show <hash>:contracts/edge-ws.md）：cfeb824（v0.13，Responses 入口补充）、61f66ac（session_id 改 UUID v5 规则、Responses 预留默认 4096）、d8371d3（又补了计量、转 Chat 工具与条目、输出条目、同协议转发四条）。

进行中未提交：codex_capture.rs（步骤4 rollout 采集半成品）+ capture.rs/ipc.rs/lib.rs 的配套改动。按 CODEX_HOME/sessions 下 mtime 发现 rollout-*.jsonl，解析 response_item（message/function_call/function_call_output/custom_tool_call*），event_msg 跳过，compacted 记 gap(compact)。只做到 cargo build -p onexd 能过（一个未用常量警告），没写任何测试，没验证事件计数/半行/压缩/同文两轮不折叠，session_id 规则也还是旧的。不建议在这个基础上继续加功能，建议先定 session_id 规则（这会改游标 key 设计，也会牵动 launch.rs::prepare_codex 和 ipc.rs 里 session_id 怎么生成，不止 capture 这一层）。

未开始：按 X-H1/H2/M1/M2/M3/L1 重写受管启动；按 R-H1~L3 重写 responses.rs 计费和转换；edge/onexd/tests/fixtures/codex-rollout/ 合成样本（SIMA 没有现成样本文件，只有解析器 edge/src/journal/codex.rs:95-245 和测试 edge/src/journal/codex_tests.rs 可参考，这两处在 SIMA 仓库不在这个 worktree，需要新接手人去读）。

下一步建议：1) 先定 session_id 规则再续写采集；2) 受管启动和 router 的高危项优先修（能跑但不安全/不计费，不是风格问题）；3) 受管启动改完后要重新核对 codex_capture.rs 的文件发现逻辑是否受影响；4) 测试基调参照 onexd/tests/responses.rs 和 onexd/tests/chat.rs，假上游+真实 Router/Ledger，不 mock 计价逻辑。

现在停下，等待关窗口。
