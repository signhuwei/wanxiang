#!/bin/bash
# 验收监督员：可读所有 worktree，只能写自己的 review worktree、验收清单和 coord/reports；可以运行测试
win=$1 name=$2 model=$3 role=$4 prompt=$5
wd=/Users/HHH/Code/OneX/wt/review-$role
tmux -L onex new-window -t onex -n "$win" -c "$wd" \
 "claude --model $model --name $name ${RESUME:+--resume $RESUME} --permission-mode dontAsk --settings /Users/HHH/Code/OneX/coord/analyst-settings.json \
  --add-dir /Users/HHH/Code/OneX/coord /Users/HHH/Code/OneX/refs /Users/HHH/Code/OneX/wanxiang /Users/HHH/Code/OneX/wt /Users/HHH/Code/SA/SIMA \
  --disallowedTools 'Bash(git push*)' 'Bash(git commit*)' 'Bash(git merge*)' 'Bash(git rebase*)' 'Bash(git reset*)' 'Bash(rm -rf*)' 'Bash(pkill -f*)' 'Bash(killall*)' 'Bash(kill *)' 'Bash(sudo*)' 'Bash(brew*)' \
  --allowedTools Read Glob Grep \
    'Edit(/$wd/**)' 'Edit(//Users/HHH/Code/OneX/coord/reports/**)' 'Edit(//Users/HHH/Code/OneX/wanxiang/docs/plan/s1-acceptance.md)' \
    'Bash(cargo *)' 'Bash(bun *)' 'Bash(bunx *)' 'Bash(git checkout *)' 'Bash(git fetch *)' 'Bash(git log *)' 'Bash(git show *)' 'Bash(git diff *)' 'Bash(git status*)' 'Bash(git -C *)' \
    'Bash(ls *)' 'Bash(cat *)' 'Bash(rg *)' 'Bash(wc *)' 'Bash(curl *127.0.0.1*)' 'Bash(curl *localhost*)' 'Bash(lsof *)' \
    'Bash(/Users/HHH/Code/OneX/coord/bin/mail-send *)' 'Bash(/Users/HHH/Code/OneX/coord/bin/mail-wait *)' 'Bash(echo * | /Users/HHH/Code/OneX/coord/bin/mail-send *)' \
  -- '$prompt'"
