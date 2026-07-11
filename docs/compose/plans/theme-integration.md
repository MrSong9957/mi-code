# Plan: Theme System Integration

Replace all hardcoded colors in the codebase with semantic theme tokens.

## Tasks

### T1: Update StatusBar.tsx — replace hex constants with theme
- Import `getTheme` from `../utils/theme.js`
- Replace `MODE_COLOR`, `MODEL_COLOR`, etc. with `theme.statusMode`, `theme.statusModel`, etc.
- Accept optional `themeName` prop or use store
- Verify: visual comparison of status bar in both themes

### T2: Update colors.ts (inline mode) — use theme SGR resolver
- Import `getTheme`, `resolveSGR`, `RESET` from `../../utils/theme-resolve.js`
- Replace hardcoded SGR constants with theme-based calls
- Update `colorizeStatus()` to use `resolveSGR(theme, 'statusMode')` etc.
- Update `fgToSGR()` to map semantic tokens to theme slots
- Verify: inline mode renders identically to before (dark theme)

### T3: Update types.ts — styleToInkProps consumes theme
- Import `getTheme` from `../utils/theme.js`
- Update `styleToInkProps()` to use `theme.brand`, `theme.success`, `theme.error`, `theme.border`
- Accept theme parameter or read from store
- Verify: component mode renders identically (dark theme)

### T4: Update render-markdown.tsx — theme tokens for markdown
- Replace hardcoded `color="magenta"` with `color={theme.mdHeading}`
- Replace `color="cyan"` with `color={theme.mdCode}`
- Replace `color="blue"` with `color={theme.mdLink}`
- Replace `color="gray"` with `color={theme.mdBlockquote}`
- Verify: markdown rendering unchanged (dark theme)

### T5: Update SelectionText.tsx, Spinner.tsx, Overlay.tsx, SuggestionBar.tsx
- Replace remaining hardcoded colors with theme tokens
- SelectionText: `theme.selectionBg`, `theme.selectionFg`
- Spinner: `theme.spinnerActive`, `theme.spinnerStalled`
- Overlay: `theme.border`, `theme.textMuted`
- SuggestionBar: `theme.brand`, `theme.textMuted`
- Verify: all components render correctly

### T6: Add theme selection to config
- Add `themeName` to zustand store (or read from config)
- Default to 'dark'
- Wire up CLI flag or config file
- Verify: theme can be switched at runtime
