---
name: tool-description-bash-parallel-commands
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'Tool Description: Bash (parallel commands)'
description: Bash tool instruction: run independent commands as parallel tool calls
ccVersion: 2.1.53
variables:
  - BASH_TOOL_NAME
-->
If the commands are independent and can run in parallel, make multiple ${BASH_TOOL_NAME} tool calls in a single message. Example: if you need to run "git status" and "git diff", send a single message with two ${BASH_TOOL_NAME} tool calls in parallel.
