#!/bin/bash
# 分析员：只读参考仓库，只能写 docs/specs 和 coord/reports
win=$1 name=$2 model=$3 prompt=$4; shift 4
tmux -L onex new-window -t onex -n "$win" -c /Users/HHH/Code/OneX \
 "claude --model $model --name $name --permission-mode dontAsk --settings /Users/HHH/Code/OneX/coord/analyst-settings.json $* \
  --tools Read,Glob,Grep,Write,Edit,Bash \
  --allowedTools Read Glob Grep 'Edit(//Users/HHH/Code/OneX/wanxiang/docs/specs/**)' 'Edit(//Users/HHH/Code/OneX/coord/reports/**)' \
   'Bash(git -C /Users/HHH/Code/OneX/refs/magpie *)' 'Bash(git -C /Users/HHH/Code/SA/SIMA *)' 'Bash(rg *)' 'Bash(wc *)' \
   'Bash(/Users/HHH/Code/OneX/coord/bin/mail-send *)' 'Bash(/Users/HHH/Code/OneX/coord/bin/mail-wait *)' 'Bash(echo * | /Users/HHH/Code/OneX/coord/bin/mail-send *)' \
  -- '$prompt'"
