#!/bin/bash
# git-workflow 辅助脚本
# 用法：./helper.sh <command>
#
# 命令：
#   new-feat <name>  创建功能分支
#   squash           squash 当前分支所有提交

new_feat() {
    local name="$1"
    git checkout main
    git pull origin main
    git checkout -b "feat/$name"
    echo "已创建分支 feat/$name"
}

squash() {
    local branch=$(git branch --show-current)
    local count=$(git rev-list --count main..HEAD)
    if [ "$count" -eq 0 ]; then
        echo "没有需要 squash 的提交"
        return 1
    fi
    git reset --soft $(git merge-base main "$branch")
    git commit -m "feat($branch): squash $count commits"
    echo "已 squash $count 个提交"
}

case "${1:-}" in
    new-feat) new_feat "$2" ;;
    squash)   squash ;;
    *)        echo "用法：$0 {new-feat|squash}" ;;
esac
