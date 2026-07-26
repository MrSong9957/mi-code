---
name: system-reminder-nested-memory-contents
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Reminder: Nested memory contents'
description: Contents of a nested memory file
ccVersion: 2.1.18
variables:
  - ATTACHMENT_OBJECT
-->
Contents of ${ATTACHMENT_OBJECT.content.path}:

${ATTACHMENT_OBJECT.content.content}
