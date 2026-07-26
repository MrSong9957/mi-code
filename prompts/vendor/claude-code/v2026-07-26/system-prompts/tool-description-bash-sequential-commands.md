---
name: tool-description-bash-sequential-commands
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'Tool Description: Bash (sequential commands)'
description: Bash tool instruction: chain dependent commands with &&
ccVersion: 2.1.53
variables:
  - BASH_TOOL_NAME
-->
If the commands depend on each other and must run sequentially, use a single ${BASH_TOOL_NAME} call with '&&' to chain them together.
