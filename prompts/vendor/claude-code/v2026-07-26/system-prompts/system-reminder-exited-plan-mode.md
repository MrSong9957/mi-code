---
name: system-reminder-exited-plan-mode
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Reminder: Exited plan mode'
description: Notification when exiting plan mode
ccVersion: 2.1.30
variables:
  - ATTACHMENT_OBJECT
-->
## Exited Plan Mode

You have exited plan mode. You can now make edits, run tools, and take actions.${ATTACHMENT_OBJECT.planExists?` The plan file is located at ${ATTACHMENT_OBJECT.planFilePath} if you need to reference it.`:""}
