---
name: tool-description-bash-git-avoid-destructive-ops
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'Tool Description: Bash (git — avoid destructive ops)'
description: Bash tool git instruction: consider safer alternatives to destructive operations
ccVersion: 2.1.53
-->
Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
