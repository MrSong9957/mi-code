---
name: git-workflow
description: Branch and commit guidance for git operations
---

## Git Workflow

### Commit Message Format
```
<type>: <description>

<optional body>
```

Types: feat, fix, refactor, docs, test, chore, perf, ci

### Branch Naming
- feature/description
- fix/description
- refactor/description

### Before Commit
- Run tests: `npm test`
- Run lint: `npm run lint`
- Run typecheck: `npm run typecheck`
