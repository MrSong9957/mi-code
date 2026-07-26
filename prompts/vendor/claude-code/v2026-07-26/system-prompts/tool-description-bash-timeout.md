---
name: tool-description-bash-timeout
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'Tool Description: Bash (timeout)'
description: Bash tool instruction: optional timeout configuration
ccVersion: 2.1.53
variables:
  - GET_MAX_TIMEOUT_MS
  - GET_DEFAULT_TIMEOUT_MS
-->
You may specify an optional timeout in milliseconds (up to ${GET_MAX_TIMEOUT_MS()}ms / ${GET_MAX_TIMEOUT_MS()/60000} minutes). By default, your command will timeout after ${GET_DEFAULT_TIMEOUT_MS()}ms (${GET_DEFAULT_TIMEOUT_MS()/60000} minutes).
