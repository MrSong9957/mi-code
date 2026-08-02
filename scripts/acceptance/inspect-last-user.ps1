# scripts/acceptance/inspect-last-user.ps1
# Read the first plain user message from the latest session JSONL.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\acceptance\inspect-last-user.ps1

$ErrorActionPreference = 'Stop'
$LF = [char]10
$CR = [char]13
$TAB = [char]9
$ESC = [char]27
$sessionsDir = Join-Path $env:USERPROFILE '.micode\sessions'

$latest = Get-ChildItem -Path $sessionsDir -Filter '*.jsonl' -File |
    Where-Object { $_.Name -notmatch '\.(pending-decisions|meta-lifecycle|reconstruction)\.jsonl$' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $latest) {
    Write-Output "NO_SESSION_FILE_FOUND in $sessionsDir"
    exit 1
}

Write-Output "=== LATEST SESSION FILE ==="
Write-Output $latest.FullName
Write-Output ("LastWrite: " + $latest.LastWriteTime)
Write-Output ""

$lines = Get-Content -Path $latest.FullName -Encoding UTF8
foreach ($line in $lines) {
    if (-not $line.Trim()) { continue }
    try { $rec = $line | ConvertFrom-Json } catch { continue }
    if ($rec.role -ne 'user') { continue }

    $content = $rec.content
    $isToolResult = $false
    if ($content -is [array]) {
        foreach ($block in $content) {
            if ($block.type -eq 'tool_result') { $isToolResult = $true; break }
        }
    }
    if ($isToolResult) { continue }

    if ($content -is [string]) { $text = $content }
    else {
        $parts = @()
        foreach ($b in $content) { if ($b.text) { $parts += $b.text } }
        $text = $parts -join ''
    }

    Write-Output "=== FIRST USER MESSAGE (role=user, not tool_result) ==="
    Write-Output ("char_length: " + $text.Length)
    Write-Output ("line_count_by_LF: " + ($text.Split($LF)).Count)
    Write-Output ""

    Write-Output "=== FULL RAW (as-is) ==="
    Write-Output $text
    Write-Output "=== END FULL RAW ==="
    Write-Output ""

    # char-by-char dump: show every char with its index and codepoint (reveal invisible chars)
    Write-Output "=== CHAR-BY-CHAR DUMP (index : codepoint : visible-or-name) ==="
    $idx = 0
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        $name = $ch
        if ($code -eq 10) { $name = '<LF>' }
        elseif ($code -eq 13) { $name = '<CR>' }
        elseif ($code -eq 9) { $name = '<TAB>' }
        elseif ($code -eq 27) { $name = '<ESC>' }
        elseif ($code -eq 32) { $name = '<SPACE>' }
        elseif ($code -ge 0 -and $code -le 31) { $name = ('<CTRL' + $code + '>') }
        $hex = '{0:X4}' -f $code
        Write-Output ("  [" + $idx + "] U+" + $hex + " (" + $code + ") " + $name)
        $idx++
    }
    Write-Output "=== END CHAR DUMP ==="
    Write-Output ""

    Write-Output "=== DIAGNOSTIC FLAGS ==="
    Write-Output ("contains_LF(0x0A): " + $text.Contains($LF))
    Write-Output ("contains_CR(0x0D): " + $text.Contains($CR))
    Write-Output ("contains_TAB(0x09): " + $text.Contains($TAB))
    Write-Output ("contains_paste_placeholder: " + ($text -match '\[Pasted text #'))
    Write-Output ("contains_bracketed_paste_start: " + $text.Contains(($ESC + '[200~')))
    exit 0
}

Write-Output "NO_PLAIN_USER_MESSAGE_FOUND"
exit 2
