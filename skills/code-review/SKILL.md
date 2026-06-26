---
name: code-review
description: Checklist for reviewing code changes
---

## Code Review Checklist

### Security
- No hardcoded secrets (API keys, passwords, tokens)
- All user inputs validated
- SQL injection prevention (parameterized queries)
- XSS prevention (sanitized HTML)

### Code Quality
- Functions are focused (<50 lines)
- Files are cohesive (<800 lines)
- No deep nesting (>4 levels)
- Errors are handled explicitly
- No console.log or debug statements

### Testing
- Tests exist for new functionality
- Test coverage meets 80% minimum
- Test names are descriptive
