---
name: tool-description-bash-sandbox-tmpdir
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'Tool Description: Bash (sandbox — tmpdir)'
description: Use $TMPDIR for temporary files in sandbox mode
ccVersion: 2.1.53
variables:
  - SANDBOX_TMPDIR_FN
-->
For temporary files, always use the `$TMPDIR` environment variable (or `${SANDBOX_TMPDIR_FN()}` as a fallback). TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` or `${SANDBOX_TMPDIR_FN()}` instead.
