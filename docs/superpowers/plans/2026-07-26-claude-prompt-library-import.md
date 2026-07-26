# Claude Prompt Library Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy all 250 Claude Code Markdown Prompt assets into a versioned, immutable mi-code vendor snapshot with a deterministic manifest and byte-for-byte verification.

**Architecture:** Treat the upstream Prompt directory as an opaque third-party asset set. Copy it without transformation into `prompts/vendor/claude-code/v2026-07-26/system-prompts/`; keep the shared upstream license and mi-code-generated manifest at the vendor root. No runtime loader, Prompt adaptation, production-code change, or Git operation is part of this plan.

**Tech Stack:** PowerShell, .NET `System.IO`, SHA-256 via `Get-FileHash`, JSON via `ConvertTo-Json`

## Global Constraints

- Source root: `D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts`
- Source Prompt root: `D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts\system-prompts`
- Target vendor root: `D:\Files\Projects\mi-code\prompts\vendor\claude-code`
- Snapshot ID: `v2026-07-26`
- Expected Prompt count: exactly 250 Markdown files.
- Preserve every Prompt file byte-for-byte, including frontmatter, HTML metadata, whitespace, and line endings.
- Preserve every path relative to `system-prompts/`.
- Copy no upstream README, CHANGELOG, CLAUDE.md, or tool script.
- `LICENSE` is shared at the vendor root; it is not part of the 250-file Prompt count.
- `manifest.json` is a mi-code management artifact at the vendor root and uses UTF-8 without BOM.
- Do not modify `src/`, existing runtime Prompt construction, or any file under `docs/superpowers/specs/`.
- Do not create a loader, registry, compiler, evaluator, updater, or permanent maintenance script.
- Do not commit, push, create a branch, or open a pull request.
- If a target path exists with different content, stop immediately; never overwrite it.

## File Map

**Create:**

- `prompts/vendor/claude-code/v2026-07-26/system-prompts/**/*.md` — 250 byte-identical upstream Prompt files.
- `prompts/vendor/claude-code/LICENSE` — byte-identical upstream MIT license.
- `prompts/vendor/claude-code/manifest.json` — deterministic source and integrity metadata.

**Modify:**

- None.

**Protected from change:**

- `src/**`
- `docs/superpowers/specs/**`
- All existing repository files outside `prompts/vendor/claude-code/`

---

### Task 1: Preflight and Immutable-Target Check

**Files:**

- Read: `D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts\system-prompts\**\*.md`
- Read: `D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts\LICENSE`
- Inspect: `D:\Files\Projects\mi-code\prompts\vendor\claude-code\v2026-07-26`
- Create outside repository: `%TEMP%\mi-code-claude-prompt-import-protected-state.json`

**Interfaces:**

- Consumes: frozen design `docs/superpowers/specs/2026-07-26-claude-prompt-library-import-design.md`
- Produces: a validated source inventory, an `absent` or `reuse-identical` target decision, and a protected-tree baseline

- [ ] **Step 1: Establish exact absolute paths**

Run from `D:\Files\Projects\mi-code`:

```powershell
$PromptImportSourceRoot = 'D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts'
$PromptImportSourcePrompts = Join-Path $PromptImportSourceRoot 'system-prompts'
$PromptImportSourceLicense = Join-Path $PromptImportSourceRoot 'LICENSE'
$PromptImportVendorRoot = 'D:\Files\Projects\mi-code\prompts\vendor\claude-code'
$PromptImportSnapshotRoot = Join-Path $PromptImportVendorRoot 'v2026-07-26'
$PromptImportTargetPrompts = Join-Path $PromptImportSnapshotRoot 'system-prompts'
$PromptImportManifest = Join-Path $PromptImportVendorRoot 'manifest.json'
$PromptImportTargetLicense = Join-Path $PromptImportVendorRoot 'LICENSE'
$PromptImportProtectedState = Join-Path $env:TEMP 'mi-code-claude-prompt-import-protected-state.json'

foreach ($requiredPath in @($PromptImportSourceRoot, $PromptImportSourcePrompts, $PromptImportSourceLicense)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
        throw "Required source path does not exist: $requiredPath"
    }
}
```

Expected: no output and exit code 0.

- [ ] **Step 2: Validate the complete source inventory**

```powershell
$PromptImportSourceFiles = @(
    Get-ChildItem -LiteralPath $PromptImportSourcePrompts -Recurse -File -Filter '*.md' |
        Sort-Object FullName
)

if ($PromptImportSourceFiles.Count -ne 250) {
    throw "Expected 250 source Prompt files, found $($PromptImportSourceFiles.Count)"
}

$PromptImportUnexpectedSourceFiles = @(
    Get-ChildItem -LiteralPath $PromptImportSourcePrompts -Recurse -File |
        Where-Object { $_.Extension -ne '.md' }
)

if ($PromptImportUnexpectedSourceFiles.Count -ne 0) {
    throw "Unexpected non-Markdown files exist under source system-prompts"
}

"Source Prompt count: $($PromptImportSourceFiles.Count)"
```

Expected:

```text
Source Prompt count: 250
```

- [ ] **Step 3: Record the protected repository state**

```powershell
$PromptImportProtectedRoots = @(
    'D:\Files\Projects\mi-code\src',
    'D:\Files\Projects\mi-code\docs\superpowers\specs'
)

$PromptImportProtectedEntries = @(
    foreach ($root in $PromptImportProtectedRoots) {
        Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
            [ordered]@{
                path = [System.IO.Path]::GetRelativePath(
                    'D:\Files\Projects\mi-code',
                    $_.FullName
                ).Replace('\', '/')
                bytes = [int64]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
) | Sort-Object path

$PromptImportProtectedJson = $PromptImportProtectedEntries | ConvertTo-Json -Depth 4
$PromptImportUtf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText(
    $PromptImportProtectedState,
    $PromptImportProtectedJson + [Environment]::NewLine,
    $PromptImportUtf8NoBom
)

"Protected-state file: $PromptImportProtectedState"
```

Expected: one path under the current Windows temporary directory.

- [ ] **Step 4: Decide whether the snapshot is new or already identical**

```powershell
function Get-PromptImportRelativePath {
    param(
        [Parameter(Mandatory)][string]$BasePath,
        [Parameter(Mandatory)][string]$FullPath
    )
    [System.IO.Path]::GetRelativePath($BasePath, $FullPath).Replace('\', '/')
}

if (-not (Test-Path -LiteralPath $PromptImportSnapshotRoot)) {
    $PromptImportSnapshotMode = 'absent'
} else {
    if (-not (Test-Path -LiteralPath $PromptImportTargetPrompts)) {
        throw "Snapshot root exists without system-prompts: $PromptImportSnapshotRoot"
    }

    $PromptImportTargetFiles = @(
        Get-ChildItem -LiteralPath $PromptImportTargetPrompts -Recurse -File |
            Sort-Object FullName
    )

    if ($PromptImportTargetFiles.Count -ne 250) {
        throw "Existing snapshot must contain exactly 250 files; found $($PromptImportTargetFiles.Count)"
    }

    if (@($PromptImportTargetFiles | Where-Object { $_.Extension -ne '.md' }).Count -ne 0) {
        throw "Existing snapshot contains non-Markdown files"
    }

    $sourceByPath = @{}
    foreach ($sourceFile in $PromptImportSourceFiles) {
        $relativePath = Get-PromptImportRelativePath $PromptImportSourcePrompts $sourceFile.FullName
        $sourceByPath[$relativePath] = $sourceFile
    }

    foreach ($targetFile in $PromptImportTargetFiles) {
        $relativePath = Get-PromptImportRelativePath $PromptImportTargetPrompts $targetFile.FullName
        if (-not $sourceByPath.ContainsKey($relativePath)) {
            throw "Unexpected file in existing snapshot: $relativePath"
        }

        $sourceHash = (Get-FileHash -LiteralPath $sourceByPath[$relativePath].FullName -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $targetFile.FullName -Algorithm SHA256).Hash
        if ($sourceHash -ne $targetHash) {
            throw "Existing target differs from source: $relativePath"
        }
    }

    $PromptImportSnapshotMode = 'reuse-identical'
}

"Snapshot mode: $PromptImportSnapshotMode"
```

Expected exactly one of:

```text
Snapshot mode: absent
```

or:

```text
Snapshot mode: reuse-identical
```

If any check throws, stop the plan and report the exact failure. Do not continue to Task 2.

---

### Task 2: Copy the Snapshot and Create Management Metadata

**Files:**

- Create: `prompts/vendor/claude-code/v2026-07-26/system-prompts/**/*.md`
- Create: `prompts/vendor/claude-code/LICENSE`
- Create: `prompts/vendor/claude-code/manifest.json`

**Interfaces:**

- Consumes: Task 1 source inventory and target decision
- Produces: immutable Prompt snapshot, shared license, and deterministic manifest

- [ ] **Step 1: Re-establish paths and source inventory**

Run from `D:\Files\Projects\mi-code`:

```powershell
$PromptImportSourceRoot = 'D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts'
$PromptImportSourcePrompts = Join-Path $PromptImportSourceRoot 'system-prompts'
$PromptImportSourceLicense = Join-Path $PromptImportSourceRoot 'LICENSE'
$PromptImportVendorRoot = 'D:\Files\Projects\mi-code\prompts\vendor\claude-code'
$PromptImportSnapshotRoot = Join-Path $PromptImportVendorRoot 'v2026-07-26'
$PromptImportTargetPrompts = Join-Path $PromptImportSnapshotRoot 'system-prompts'
$PromptImportManifest = Join-Path $PromptImportVendorRoot 'manifest.json'
$PromptImportTargetLicense = Join-Path $PromptImportVendorRoot 'LICENSE'
$PromptImportSourceFiles = @(
    Get-ChildItem -LiteralPath $PromptImportSourcePrompts -Recurse -File -Filter '*.md' |
        Sort-Object FullName
)

if ($PromptImportSourceFiles.Count -ne 250) {
    throw "Source changed after preflight; expected 250 files, found $($PromptImportSourceFiles.Count)"
}
```

Expected: no output and exit code 0.

- [ ] **Step 2: Copy the Prompt files only when the snapshot is absent**

```powershell
if (-not (Test-Path -LiteralPath $PromptImportSnapshotRoot)) {
    New-Item -ItemType Directory -Path $PromptImportTargetPrompts -Force | Out-Null

    foreach ($sourceFile in $PromptImportSourceFiles) {
        $relativePath = [System.IO.Path]::GetRelativePath(
            $PromptImportSourcePrompts,
            $sourceFile.FullName
        )
        $targetFile = Join-Path $PromptImportTargetPrompts $relativePath
        $targetDirectory = Split-Path -Parent $targetFile

        if (-not (Test-Path -LiteralPath $targetDirectory)) {
            New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
        }
        if (Test-Path -LiteralPath $targetFile) {
            throw "Refusing to overwrite target file: $targetFile"
        }

        Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetFile
    }
} else {
    if (-not (Test-Path -LiteralPath $PromptImportTargetPrompts)) {
        throw "Existing snapshot has no system-prompts directory"
    }

    $existingTargetFiles = @(
        Get-ChildItem -LiteralPath $PromptImportTargetPrompts -Recurse -File |
            Sort-Object FullName
    )
    if ($existingTargetFiles.Count -ne 250) {
        throw "Existing snapshot must contain exactly 250 files; found $($existingTargetFiles.Count)"
    }
    if (@($existingTargetFiles | Where-Object { $_.Extension -ne '.md' }).Count -ne 0) {
        throw "Existing snapshot contains non-Markdown files"
    }

    $existingTargetByPath = @{}
    foreach ($targetFile in $existingTargetFiles) {
        $relativePath = [System.IO.Path]::GetRelativePath(
            $PromptImportTargetPrompts,
            $targetFile.FullName
        ).Replace('\', '/')
        $existingTargetByPath[$relativePath] = $targetFile
    }

    foreach ($sourceFile in $PromptImportSourceFiles) {
        $relativePath = [System.IO.Path]::GetRelativePath(
            $PromptImportSourcePrompts,
            $sourceFile.FullName
        ).Replace('\', '/')
        if (-not $existingTargetByPath.ContainsKey($relativePath)) {
            throw "Existing snapshot is missing: $relativePath"
        }
        $sourceHash = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash
        $targetHash = (Get-FileHash -LiteralPath $existingTargetByPath[$relativePath].FullName -Algorithm SHA256).Hash
        if ($sourceHash -ne $targetHash) {
            throw "Existing snapshot differs from source: $relativePath"
        }
    }

    "Existing identical snapshot retained; no Prompt file copied."
}
```

Expected for a new snapshot: no output and exit code 0.

Expected for an existing identical snapshot:

```text
Existing identical snapshot retained; no Prompt file copied.
```

- [ ] **Step 3: Copy or validate the shared license**

```powershell
$sourceLicenseHash = (Get-FileHash -LiteralPath $PromptImportSourceLicense -Algorithm SHA256).Hash

if (Test-Path -LiteralPath $PromptImportTargetLicense) {
    $targetLicenseHash = (Get-FileHash -LiteralPath $PromptImportTargetLicense -Algorithm SHA256).Hash
    if ($sourceLicenseHash -ne $targetLicenseHash) {
        throw "Existing shared LICENSE differs from source; do not overwrite it"
    }
} else {
    if (-not (Test-Path -LiteralPath $PromptImportVendorRoot)) {
        New-Item -ItemType Directory -Path $PromptImportVendorRoot -Force | Out-Null
    }
    Copy-Item -LiteralPath $PromptImportSourceLicense -Destination $PromptImportTargetLicense
}
```

Expected: no output and exit code 0.

- [ ] **Step 4: Build the deterministic manifest object**

```powershell
$manifestEntries = @(
    foreach ($sourceFile in $PromptImportSourceFiles) {
        $relativeToPromptRoot = [System.IO.Path]::GetRelativePath(
            $PromptImportSourcePrompts,
            $sourceFile.FullName
        ).Replace('\', '/')

        [ordered]@{
            path = "v2026-07-26/system-prompts/$relativeToPromptRoot"
            bytes = [int64]$sourceFile.Length
            sha256 = (Get-FileHash -LiteralPath $sourceFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
) | Sort-Object path

if ($manifestEntries.Count -ne 250) {
    throw "Manifest entry count must be 250; found $($manifestEntries.Count)"
}

$manifestObject = [ordered]@{
    schema_version = 1
    library = 'claude-code-system-prompts'
    snapshot_id = 'v2026-07-26'
    source = [ordered]@{
        local_path = 'D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts'
        git_tag = $null
        git_commit = $null
        captured_on = Get-Date -Format 'yyyy-MM-dd'
        license = 'MIT'
    }
    content = [ordered]@{
        root = 'v2026-07-26/system-prompts'
        file_count = 250
    }
    files = $manifestEntries
}
```

Expected: no output and exit code 0.

- [ ] **Step 5: Write manifest.json without BOM and without overwriting different metadata**

```powershell
$manifestJson = $manifestObject | ConvertTo-Json -Depth 6
$manifestBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(
    $manifestJson + [Environment]::NewLine
)

if (Test-Path -LiteralPath $PromptImportManifest) {
    $existingManifestBytes = [System.IO.File]::ReadAllBytes($PromptImportManifest)
    $existingManifestText = [System.Text.UTF8Encoding]::new($false, $true).GetString(
        $existingManifestBytes
    )
    $existingManifest = $existingManifestText | ConvertFrom-Json

    if (
        $existingManifest.schema_version -ne 1 -or
        $existingManifest.library -ne 'claude-code-system-prompts' -or
        $existingManifest.snapshot_id -ne 'v2026-07-26' -or
        $existingManifest.content.file_count -ne 250 -or
        @($existingManifest.files).Count -ne 250
    ) {
        throw "Existing manifest metadata is incompatible; do not overwrite it"
    }

    if (@($existingManifest.files.path | Group-Object | Where-Object Count -gt 1).Count -ne 0) {
        throw "Existing manifest contains duplicate paths; do not overwrite it"
    }

    $existingByPath = @{}
    foreach ($entry in $existingManifest.files) {
        $existingByPath[$entry.path] = $entry
    }
    foreach ($entry in $manifestEntries) {
        if (-not $existingByPath.ContainsKey($entry.path)) {
            throw "Existing manifest is missing: $($entry.path)"
        }
        if (
            [int64]$existingByPath[$entry.path].bytes -ne $entry.bytes -or
            $existingByPath[$entry.path].sha256 -ne $entry.sha256
        ) {
            throw "Existing manifest differs for: $($entry.path)"
        }
    }

    "Existing compatible manifest retained; no overwrite performed."
} else {
    [System.IO.File]::WriteAllBytes($PromptImportManifest, $manifestBytes)
}
```

Expected for a new manifest: no output and exit code 0.

Expected for an existing compatible manifest:

```text
Existing compatible manifest retained; no overwrite performed.
```

---

### Task 3: Full Integrity Verification and Handoff

**Files:**

- Verify: `prompts/vendor/claude-code/v2026-07-26/system-prompts/**/*.md`
- Verify: `prompts/vendor/claude-code/LICENSE`
- Verify: `prompts/vendor/claude-code/manifest.json`
- Read and remove: `%TEMP%\mi-code-claude-prompt-import-protected-state.json`

**Interfaces:**

- Consumes: Task 2 snapshot, license, manifest, and Task 1 protected-state baseline
- Produces: a pass/fail evidence report; no additional repository artifact

- [ ] **Step 1: Verify target count, file types, and relative path set**

```powershell
$PromptImportSourcePrompts = 'D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts\system-prompts'
$PromptImportTargetPrompts = 'D:\Files\Projects\mi-code\prompts\vendor\claude-code\v2026-07-26\system-prompts'

$sourceFiles = @(Get-ChildItem -LiteralPath $PromptImportSourcePrompts -Recurse -File -Filter '*.md')
$targetFiles = @(Get-ChildItem -LiteralPath $PromptImportTargetPrompts -Recurse -File)

if ($sourceFiles.Count -ne 250) {
    throw "Source count changed: $($sourceFiles.Count)"
}
if ($targetFiles.Count -ne 250) {
    throw "Target must contain exactly 250 files; found $($targetFiles.Count)"
}
if (@($targetFiles | Where-Object { $_.Extension -ne '.md' }).Count -ne 0) {
    throw "Target snapshot contains non-Markdown files"
}

$sourcePaths = @(
    $sourceFiles | ForEach-Object {
        [System.IO.Path]::GetRelativePath($PromptImportSourcePrompts, $_.FullName).Replace('\', '/')
    } | Sort-Object
)
$targetPaths = @(
    $targetFiles | ForEach-Object {
        [System.IO.Path]::GetRelativePath($PromptImportTargetPrompts, $_.FullName).Replace('\', '/')
    } | Sort-Object
)

if (($sourcePaths -join "`n") -cne ($targetPaths -join "`n")) {
    throw "Source and target relative path sets differ"
}
```

Expected: no output and exit code 0.

- [ ] **Step 2: Verify all 250 Prompt hashes**

```powershell
foreach ($relativePath in $sourcePaths) {
    $sourceFile = Join-Path $PromptImportSourcePrompts $relativePath
    $targetFile = Join-Path $PromptImportTargetPrompts $relativePath
    $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
    $targetHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash

    if ($sourceHash -ne $targetHash) {
        throw "Prompt hash mismatch: $relativePath"
    }
}

"Prompt hashes verified: 250"
```

Expected:

```text
Prompt hashes verified: 250
```

- [ ] **Step 3: Verify license integrity**

```powershell
$sourceLicense = 'D:\Files\Obsidian\sources\claude-code\claude-code-system-prompts\LICENSE'
$targetLicense = 'D:\Files\Projects\mi-code\prompts\vendor\claude-code\LICENSE'
$sourceLicenseHash = (Get-FileHash -LiteralPath $sourceLicense -Algorithm SHA256).Hash
$targetLicenseHash = (Get-FileHash -LiteralPath $targetLicense -Algorithm SHA256).Hash

if ($sourceLicenseHash -ne $targetLicenseHash) {
    throw "LICENSE hash mismatch"
}

"LICENSE hash verified."
```

Expected:

```text
LICENSE hash verified.
```

- [ ] **Step 4: Verify manifest encoding, schema, ordering, sizes, and hashes**

```powershell
$manifestPath = 'D:\Files\Projects\mi-code\prompts\vendor\claude-code\manifest.json'
$manifestBytes = [System.IO.File]::ReadAllBytes($manifestPath)

if (
    $manifestBytes.Length -ge 3 -and
    $manifestBytes[0] -eq 0xEF -and
    $manifestBytes[1] -eq 0xBB -and
    $manifestBytes[2] -eq 0xBF
) {
    throw "manifest.json must be UTF-8 without BOM"
}

$manifestText = [System.Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes)
$manifest = $manifestText | ConvertFrom-Json

if ($manifest.schema_version -ne 1) { throw "Invalid schema_version" }
if ($manifest.library -ne 'claude-code-system-prompts') { throw "Invalid library" }
if ($manifest.snapshot_id -ne 'v2026-07-26') { throw "Invalid snapshot_id" }
if ($manifest.source.git_tag -ne $null) { throw "git_tag must be null" }
if ($manifest.source.git_commit -ne $null) { throw "git_commit must be null" }
if ($manifest.source.captured_on -notmatch '^\d{4}-\d{2}-\d{2}$') { throw "Invalid captured_on" }
if ($manifest.content.root -ne 'v2026-07-26/system-prompts') { throw "Invalid content.root" }
if ($manifest.content.file_count -ne 250) { throw "Invalid content.file_count" }
if (@($manifest.files).Count -ne 250) { throw "Manifest must contain 250 file entries" }

$manifestPaths = @($manifest.files | ForEach-Object { $_.path })
$sortedManifestPaths = @($manifestPaths | Sort-Object)
if (($manifestPaths -join "`n") -cne ($sortedManifestPaths -join "`n")) {
    throw "Manifest entries are not sorted by path"
}
if (@($manifestPaths | Group-Object | Where-Object Count -gt 1).Count -ne 0) {
    throw "Manifest contains duplicate paths"
}

foreach ($entry in $manifest.files) {
    if ([System.IO.Path]::IsPathRooted($entry.path)) {
        throw "Manifest path must be relative: $($entry.path)"
    }
    $targetFile = Join-Path 'D:\Files\Projects\mi-code\prompts\vendor\claude-code' $entry.path
    if (-not (Test-Path -LiteralPath $targetFile)) {
        throw "Manifest target missing: $($entry.path)"
    }
    $targetItem = Get-Item -LiteralPath $targetFile
    $targetHash = (Get-FileHash -LiteralPath $targetFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([int64]$entry.bytes -ne [int64]$targetItem.Length) {
        throw "Manifest byte count mismatch: $($entry.path)"
    }
    if ($entry.sha256 -cne $targetHash) {
        throw "Manifest hash mismatch: $($entry.path)"
    }
}

"Manifest verified: 250 entries, UTF-8 without BOM."
```

Expected:

```text
Manifest verified: 250 entries, UTF-8 without BOM.
```

- [ ] **Step 5: Verify protected repository files did not change**

```powershell
$protectedStatePath = Join-Path $env:TEMP 'mi-code-claude-prompt-import-protected-state.json'
if (-not (Test-Path -LiteralPath $protectedStatePath)) {
    throw "Protected-state baseline is missing: $protectedStatePath"
}

$protectedBefore = Get-Content -Raw -Encoding utf8 -LiteralPath $protectedStatePath | ConvertFrom-Json
$protectedRoots = @(
    'D:\Files\Projects\mi-code\src',
    'D:\Files\Projects\mi-code\docs\superpowers\specs'
)
$protectedAfter = @(
    foreach ($root in $protectedRoots) {
        Get-ChildItem -LiteralPath $root -Recurse -File | ForEach-Object {
            [ordered]@{
                path = [System.IO.Path]::GetRelativePath(
                    'D:\Files\Projects\mi-code',
                    $_.FullName
                ).Replace('\', '/')
                bytes = [int64]$_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    }
) | Sort-Object path

$beforeComparable = $protectedBefore | ConvertTo-Json -Depth 4 -Compress
$afterComparable = $protectedAfter | ConvertTo-Json -Depth 4 -Compress
if ($beforeComparable -cne $afterComparable) {
    throw "Protected repository files changed during Prompt import"
}

$resolvedTempRoot = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')
$resolvedStatePath = [System.IO.Path]::GetFullPath($protectedStatePath)
if (-not $resolvedStatePath.StartsWith($resolvedTempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove non-temporary path: $resolvedStatePath"
}
Remove-Item -LiteralPath $resolvedStatePath

"Protected repository state unchanged."
```

Expected:

```text
Protected repository state unchanged.
```

- [ ] **Step 6: Inspect the final repository change scope**

```powershell
git status --short -- prompts/vendor/claude-code src docs/superpowers/specs
```

Expected:

- New files appear only under `prompts/vendor/claude-code/`.
- No new modification appears under `src/`.
- No execution-time modification appears under `docs/superpowers/specs/`.
- Existing pre-task untracked planning documents may still appear and must not be staged or committed.

- [ ] **Step 7: Produce the execution report and stop**

Report exactly:

```text
Snapshot: v2026-07-26
Prompt files: 250
Relative paths: matched
Prompt SHA-256: 250/250 matched
LICENSE SHA-256: matched
Manifest: 250 entries, sorted, UTF-8 without BOM
Protected paths: unchanged
Runtime integration: not performed
Git commit/push/PR: not performed
```

Do not run tests or builds: no production code, package metadata, or runtime configuration changed. Do not stage or commit the imported assets.
