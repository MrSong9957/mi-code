---
name: tool-description-powershell
description: 一句话说明
type: concept
updated: 2026-05-30
tags: [tag1, tag2]
source: https://example.com
---
<!--
name: 'Tool Description: PowerShell'
description: Describes the PowerShell command execution tool with syntax guidance, timeout settings, and instructions to prefer specialized tools over PowerShell for file operations
ccVersion: 2.1.84
variables:
  - MAX_TIMEOUT_MS
  - DEFAULT_TIMEOUT_MS
  - MAX_OUTPUT_CHARS
  - CUSTOM_USAGE_NOTES
  - GLOB_TOOL_NAME
  - GREP_TOOL_NAME
  - READ_TOOL_NAME
  - EDIT_TOOL_NAME
  - WRITE_TOOL_NAME
  - POWERSHELL_TOOL_NAME
  - CUSTOM_GIT_NOTES
-->
Executes a given PowerShell command with optional timeout. Working directory persists between commands; shell state (variables, functions) does not.

IMPORTANT: This tool is for terminal operations via PowerShell: git, npm, docker, and PS cmdlets. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

Before executing the command, please follow these steps:

1. Directory Verification:
   - If the command will create new directories or files, first use `Get-ChildItem` (or `ls`) to verify the parent directory exists and is the correct location

2. Command Execution:
   - Always quote file paths that contain spaces with double quotes
   - Capture the output of the command.

PowerShell Syntax Notes:
   - Variables use $ prefix: $myVar = "value"
   - Escape character is backtick (`), not backslash
   - Use Verb-Noun cmdlet naming: Get-ChildItem, Set-Location, New-Item, Remove-Item
   - Common aliases: ls (Get-ChildItem), cd (Set-Location), cat (Get-Content), rm (Remove-Item)
   - Pipe operator | works similarly to bash but passes objects, not text
   - Use Select-Object, Where-Object, ForEach-Object for filtering and transformation
   - String interpolation: "Hello $name" or "Hello $($obj.Property)"
   - Here-strings for multiline: @"..."@ or @'...'@
   - Chain commands with ; (not && which is bash syntax)

Usage notes:
  - The command argument is required.
  - You can specify an optional timeout in milliseconds (up to ${MAX_TIMEOUT_MS()}ms / ${MAX_TIMEOUT_MS()/60000} minutes). If not specified, commands will timeout after ${DEFAULT_TIMEOUT_MS()}ms (${DEFAULT_TIMEOUT_MS()/60000} minutes).
  - It is very helpful if you write a clear, concise description of what this command does.
  - If the output exceeds ${MAX_OUTPUT_CHARS()} characters, output will be truncated before being returned to you.
${CUSTOM_USAGE_NOTES?CUSTOM_USAGE_NOTES+`
`:""}  - Avoid using PowerShell to run commands that have dedicated tools, unless explicitly instructed:
    - File search: Use ${GLOB_TOOL_NAME} (NOT Get-ChildItem -Recurse)
    - Content search: Use ${GREP_TOOL_NAME} (NOT Select-String)
    - Read files: Use ${READ_TOOL_NAME} (NOT Get-Content)
    - Edit files: Use ${EDIT_TOOL_NAME}
    - Write files: Use ${WRITE_TOOL_NAME} (NOT Set-Content/Out-File)
    - Communication: Output text directly (NOT Write-Output/Write-Host)
  - When issuing multiple commands:
    - If the commands are independent and can run in parallel, make multiple ${POWERSHELL_TOOL_NAME} tool calls in a single message.
    - If the commands depend on each other and must run sequentially, use a single ${POWERSHELL_TOOL_NAME} call with ';' to chain them together.
    - DO NOT use newlines to separate commands (newlines are ok in quoted strings)
  - Do NOT prefix commands with `cd` or `Set-Location` -- the working directory is already set to the correct project directory automatically.
${CUSTOM_GIT_NOTES?CUSTOM_GIT_NOTES+`
`:""}  - For git commands:
    - Prefer to create a new commit rather than amending an existing commit.
    - Before running destructive operations (e.g., git reset --hard, git push --force, git checkout --), consider whether there is a safer alternative that achieves the same goal. Only use destructive operations when they are truly the best approach.
    - Never skip hooks (--no-verify) or bypass signing (--no-gpg-sign, -c commit.gpgsign=false) unless the user has explicitly asked for it. If a hook fails, investigate and fix the underlying issue.
