# 进程间通信：文件邮箱

不要用 SendMessage，改用文件邮箱。SendMessage 在两个会话权限模式不同时会被扣住，要用户手动放行。

- 角色名：`governor`（总督）、`edge`、`server`、`web`、`magpie`、`sima`、`test`
- 发信：`/Users/HHH/Code/OneX/coord/bin/mail-send <收件人> <你的角色> '<正文>'`
- 收信：`/Users/HHH/Code/OneX/coord/bin/mail-wait <你的角色> 540`。有信就全部打印出来并归档，然后退出；540 秒内没有信就打印 `NO_MAIL` 后退出。

工作循环：
1. 做完一项任务或遇到需要裁决的问题，用 mail-send 发给 `governor`。
2. 然后运行 mail-wait 等回复。打印 `NO_MAIL` 就再运行一次，一直等到收到信为止。不要在等待期间自己结束会话。
3. 收到信后按信里的要求继续工作。

正文写清楚：任务编号、提交号、测试结果、遗留问题或需要裁决的问题。正文里有单引号时，改用标准输入：`echo "..." | mail-send governor <角色>`，这一行算一条命令，允许使用。
