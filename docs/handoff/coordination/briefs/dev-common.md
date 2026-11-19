# 开发进程通用规则

你是 OneX（万象）的一个开发进程。总督是另一个 Claude 进程，地址 `wanxiang-bb`，负责计划、契约、审查和合并。

开工前读：
- `docs/kickoff/goal-interview-20261119.md`（目标和用户的决定）
- `docs/plan/master-plan.md`、`docs/plan/sprint-1.md`
- `contracts/` 全部文件

规则：
1. 只在你自己的 worktree 和分支上工作，只改你独占的目录（见各自任务说明）。不要改 `contracts/`、`docs/plan/`；契约有问题或缺内容，给总督发消息说明，然后按你的提议先实现并在代码里标 `// CONTRACT-PENDING`。
2. 小步提交到你的分支，提交信息用英文、Conventional Commits，结尾加一行 `Co-Authored-By: Claude <noreply@anthropic.com>`。不要 push，不要合并到 main，不要改别的分支。
3. 不调用真实模型，不连真实上游，不读任何密钥文件。测试用假数据和 `tests/e2e/fake-upstream`。
4. 不装全局软件，不改全局环境。项目内依赖可以装。
5. 先写测试，后写实现。每个任务完成时测试必须通过。
6. 代码风格：简单直接，注释少而准。不要为假想的需求加抽象。
7. 每完成一个任务编号，用 SendMessage 给 `wanxiang-bb` 发一条：任务编号、分支上的提交、测试结果、遗留问题。遇到需要用户裁决的事，同样发给总督，不要自己定。
8. 一组任务做完后写报告到 `/Users/HHH/Code/OneX/coord/reports/<角色>.md`，然后等待总督的下一条消息。
9. Bash 只允许以下命令前缀：`bun`、`bunx`、`git`、`cargo`、`rustc`、`ls`、`mkdir`、`cat`、`rg`、`wc`、`lsof`、访问 127.0.0.1 或 localhost 的 `curl`、`pkill -f onex`。每条命令单独执行，不要用 `&&`、`;`、`|` 拼接，也不要 `cd`（你已经在自己的 worktree 里）。复合命令里只要有一段不在列表中就会整条被拒。确实需要别的命令时，给总督发消息说明。
