---
name: system-reminder-file-shorter-than-offset
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Reminder: File shorter than offset'
description: Warning when file read offset exceeds file length
ccVersion: 2.1.18
variables:
  - RESULT_OBJECT
-->
<system-reminder>Warning: the file exists but is shorter than the provided offset (${RESULT_OBJECT.file.startLine}). The file has ${RESULT_OBJECT.file.totalLines} lines.</system-reminder>
