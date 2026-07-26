---
name: system-reminder-hook-stopped-continuation
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Reminder: Hook stopped continuation'
description: Message when a hook stops continuation
ccVersion: 2.1.18
variables:
  - ATTACHMENT_OBJECT
-->
${ATTACHMENT_OBJECT.hookName} hook stopped continuation: ${ATTACHMENT_OBJECT.message}
