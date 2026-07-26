---
name: system-reminder-hook-blocking-error
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Reminder: Hook blocking error'
description: Error from a blocking hook command
ccVersion: 2.1.18
variables:
  - ATTACHMENT_OBJECT
-->
${ATTACHMENT_OBJECT.hookName} hook blocking error from command: "${ATTACHMENT_OBJECT.blockingError.command}": ${ATTACHMENT_OBJECT.blockingError.blockingError}
