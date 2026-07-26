---
name: system-prompt-team-memory-content-display
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'System Prompt: Team memory content display'
description: Renders shared team memory file contents with path and content for injection into the conversation context
ccVersion: 2.1.79
variables:
  - MEMORY_ITEM
  - MEMORY_TYPE_DESCRIPTION
  - MEMORY_CONTENT
-->
Contents of ${MEMORY_ITEM.path}${MEMORY_TYPE_DESCRIPTION}:

<team-memory-content source="shared">
${MEMORY_CONTENT}
</team-memory-content>
