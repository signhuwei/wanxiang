#!/bin/bash
# 用法：launch.sh <窗口名> <会话名> <模型> <工作目录> <初始提示> [额外 add-dir...]
# 文件写入权限规则用 Edit(...)（同时覆盖 Write 工具）；Write(...) 不是有效的权限规则名。
set -e
win=$1 name=$2 model=$3 wd=$4 prompt=$5; shift 5
extra="$*"
tmux -L onex new-window -t onex -n "$win" -c "$wd" \
 "claude --model $model --name $name ${RESUME:+--resume $RESUME} --permission-mode dontAsk --settings /Users/HHH/Code/OneX/coord/analyst-settings.json \
  --add-dir /Users/HHH/Code/OneX/coord /Users/HHH/Code/OneX/refs $extra \
  --disallowedTools 'Bash(git push*)' 'Bash(git -C * push*)' 'Bash(git checkout main*)' 'Bash(rm -rf*)' 'Bash(pkill -f*)' 'Bash(killall*)' 'Bash(kill *)' 'Bash(sudo*)' 'Bash(brew*)' \
  --allowedTools Read Glob Grep SendMessage ListAgents \
    'Edit(/$wd/**)' 'Edit(//Users/HHH/Code/OneX/coord/reports/**)' \
    'Bash(cargo *)' 'Bash(rustc *)' 'Bash(bun *)' 'Bash(bunx *)' 'Bash(git *)' 'Bash(ls *)' 'Bash(mkdir *)' 'Bash(cat *)' 'Bash(rg *)' 'Bash(wc *)' 'Bash(curl *127.0.0.1*)' 'Bash(curl *localhost*)' 'Bash(lsof *)' 'Bash(/Users/HHH/Code/OneX/coord/bin/mail-send *)' 'Bash(/Users/HHH/Code/OneX/coord/bin/mail-wait *)' 'Bash(echo * | /Users/HHH/Code/OneX/coord/bin/mail-send *)' 'Bash(pkill -x onexd)' 'Bash(pkill -x onex-cli)' \
  -- '$prompt'"
