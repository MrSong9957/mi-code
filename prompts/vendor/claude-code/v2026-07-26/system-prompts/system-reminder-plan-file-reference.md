---
name: system-reminder-plan-file-reference
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Reminder: Plan file reference'
description: Reference to an existing plan file
ccVersion: 2.1.18
variables:
  - ATTACHMENT_OBJECT
-->
A plan file exists from plan mode at: ${ATTACHMENT_OBJECT.planFilePath}

Plan contents:

${ATTACHMENT_OBJECT.planContent}

If this plan is relevant to the current work and not already complete, continue working on it.
