# DESIGN.md — MiCode Theme System

## 1. Objective

A theme system that makes a terminal IDE feel like a *designed product*, not a colored config file. Every color must answer a question: "What is this telling the user?" The dark theme is the primary experience — confident, legible, low-fatigue for 8-hour sessions. The light theme is the same product seen in daylight — not inverted, not washed out, but a deliberate warm-cool shift that respects ambient light. The system must survive both 256-color and 16-color terminals without degradation.

Quality bar: every color slot must pass a "squint test" — if you blur your eyes, can you still distinguish success from error from info? If not, the contrast ratio is wrong.

## 2. Product Context

- **What the product does:** A CLI coding assistant that renders rich TUI interfaces (markdown, code, status bars, spinners) in the terminal.
- **Who it's for:** Developers spending 4-8 hours/day in the terminal. They're tired, their eyes are dry, and they need color to *work for them*, not against them.
- **Adjacent brands (feel like these):** VS Code's Dark+ / Light+ themes (semantic clarity), Warp (terminal-native color), Helix (minimalist terminal aesthetics).
- **Distant brand (do not feel like this):** Dracula — too saturated, too much purple, exhausting over long sessions.
- **Cultural register:** Technical and restrained. Color is functional, not decorative. Every hue earns its slot through utility.

## 3. Visual Foundations

### 3a. Color — Dark Theme

The dark theme uses a **neutral-gray base** (not pure black, not blue-black) with **desaturated accents** to minimize eye strain.

**Neutral scale (background hierarchy):**
```
--bg-base:       rgb(30, 30, 34)      // terminal background
--bg-surface:    rgb(36, 36, 42)      // elevated surfaces (overlay bg)
--bg-muted:      rgb(48, 48, 56)      // subtle backgrounds (input bg, code bg)
--border:        rgb(68, 68, 78)      // borders, separators
--border-muted:  rgb(56, 56, 64)      // subtle borders (hr, blockquote)
--text-primary:  rgb(220, 220, 226)   // primary text (high contrast)
--text-secondary:rgb(160, 160, 170)   // secondary text (dimmed)
--text-muted:    rgb(110, 110, 120)   // muted text (placeholders, comments)
```

**Semantic accent scale (functional colors):**
```
--brand:         rgb(180, 130, 255)   // magenta-purple — brand identity, headings
--success:       rgb(100, 200, 80)    // green — user input prompt, positive states
--error:         rgb(255, 90, 90)     // red — errors, stalled spinner
--warning:       rgb(255, 200, 60)    // yellow — warnings, directory path
--info:          rgb(100, 200, 240)   // cyan — mode indicator, code blocks
--suggestion:    rgb(120, 140, 255)   // blue — links, context progress
```

**Status bar field colors (high-distinction set):**
```
--status-mode:       rgb(100, 200, 240)   // cyan — permission mode
--status-model:      rgb(180, 130, 255)   // magenta-purple — model name
--status-dir:        rgb(200, 160, 255)   // lavender — directory
--status-branch:     rgb(255, 210, 80)    // warm yellow — git branch
--status-fill:       rgb(100, 200, 240)   // cyan — progress bar filled
--status-empty:      rgb(100, 100, 112)   // neutral gray — progress bar empty
--status-separator:  rgb(100, 100, 112)   // neutral gray — pipe separators
```

**Markdown render colors:**
```
--md-heading:    rgb(180, 130, 255)   // magenta-purple — H1-H6 (bold)
--md-code:       rgb(100, 200, 240)   // cyan — inline code, code blocks
--md-link:       rgb(120, 140, 255)   // blue — links (underline)
--md-blockquote: rgb(110, 110, 120)   // muted gray — │ prefix, <hr>
--md-strikethrough: rgb(110, 110, 120) // muted gray — ~~del~~
```

**Selection highlight:**
```
--selection-bg:  rgb(100, 200, 240)   // cyan background
--selection-fg:  rgb(30, 30, 34)      // dark text on selection
```

**Spinner states:**
```
--spinner-active:   rgb(100, 200, 240)   // cyan — spinning
--spinner-stalled:  rgb(255, 90, 90)     // red — stalled/error
```

**Diff colors (for tool output):**
```
--diff-added:    rgb(100, 200, 80)    // green — added lines
--diff-removed:  rgb(255, 90, 90)     // red — removed lines
--diff-header:   rgb(180, 130, 255)   // magenta-purple — hunk headers
--diff-context:  rgb(110, 110, 120)   // muted gray — context lines
```

**Usage rules:**
- `--brand` appears on headings and the LOGO — it is the product's signature, not a general-purpose color
- `--success` is reserved for the input prompt (`❯`) and positive state indicators — never for decorative purposes
- `--error` appears only on actual errors or stalled states — never for emphasis
- `--info` is for code and mode indicators — it is the "reading" color, optimized for prolonged exposure
- `--suggestion` is for interactive elements (links, progress) — it signals "you can act on this"
- All status bar colors must be distinguishable when adjacent — no two fields share a hue family

### 3b. Color — Light Theme

The light theme is **not** a simple inversion. It uses a warm-neutral base with shifted accent temperatures to maintain the same semantic relationships under ambient light.

**Neutral scale (background hierarchy):**
```
--bg-base:       rgb(250, 249, 246)   // warm white — terminal background
--bg-surface:    rgb(242, 240, 236)   // slightly warmer — elevated surfaces
--bg-muted:      rgb(230, 228, 224)   // subtle backgrounds (input bg, code bg)
--border:        rgb(200, 198, 194)   // borders, separators
--border-muted:  rgb(216, 214, 210)   // subtle borders (hr, blockquote)
--text-primary:  rgb(40, 40, 46)      // near-black — primary text
--text-secondary:rgb(100, 100, 108)   // secondary text
--text-muted:    rgb(148, 148, 156)   // muted text
```

**Semantic accent scale (shifted for light backgrounds):**
```
--brand:         rgb(140, 70, 220)    // deeper purple — higher contrast on white
--success:       rgb(40, 160, 50)     // deeper green — 4.5:1 on white
--error:         rgb(220, 50, 50)     // deeper red — 4.5:1 on white
--warning:       rgb(180, 130, 0)     // darker amber — visible on light
--info:          rgb(0, 140, 190)     // deeper cyan — visible on light
--suggestion:    rgb(60, 80, 200)     // deeper blue — visible on light
```

**Status bar field colors (shifted for light):**
```
--status-mode:       rgb(0, 140, 190)     // deeper cyan
--status-model:      rgb(140, 70, 220)    // deeper purple
--status-dir:        rgb(120, 60, 180)    // deeper lavender
--status-branch:     rgb(170, 120, 0)     // darker amber
--status-fill:       rgb(0, 140, 190)     // deeper cyan
--status-empty:      rgb(180, 178, 174)   // light gray
--status-separator:  rgb(180, 178, 174)   // light gray
```

**Markdown render colors (shifted for light):**
```
--md-heading:    rgb(140, 70, 220)    // deeper purple (bold)
--md-code:       rgb(0, 140, 190)     // deeper cyan
--md-link:       rgb(60, 80, 200)     // deeper blue (underline)
--md-blockquote: rgb(148, 148, 156)   // muted gray
--md-strikethrough: rgb(148, 148, 156) // muted gray
```

**Selection highlight:**
```
--selection-bg:  rgb(0, 140, 190)     // cyan background
--selection-fg:  rgb(250, 249, 246)   // white text on selection
```

**Spinner states:**
```
--spinner-active:   rgb(0, 140, 190)     // deeper cyan
--spinner-stalled:  rgb(220, 50, 50)     // deeper red
```

**Diff colors (shifted for light):**
```
--diff-added:    rgb(40, 160, 50)     // deeper green
--diff-removed:  rgb(220, 50, 50)     // deeper red
--diff-header:   rgb(140, 70, 220)    // deeper purple
--diff-context:  rgb(148, 148, 156)   // muted gray
```

### 3c. Typography

Terminal application — no custom fonts. The type system is defined by **ANSI attributes**:
- `bold` (SGR 1): headings, emphasis, input prompt, status bar fields
- `dim` (SGR 2): secondary content, thinking summaries, nested results
- `italic` (SGR 3): markdown emphasis, code language tags
- `underline` (SGR 4): links
- `inverse` (SGR 7): selection highlight, active suggestion

### 3d. Spacing & Rhythm

Terminal cells are the unit. No pixel spacing — everything is character-width and line-height:
- Status bar fields: ` │ ` (space-pipe-space) separator
- Indentation: 2-space standard, 4-space for nested blocks
- LOGO: 3 lines fixed height
- Footer: 4 lines fixed (border + input + border + status)

## 4. Accessibility

- **Text contrast:** All semantic colors pass WCAG AA (4.5:1 for body text, 3:1 for large text) against their respective backgrounds in both themes
- **Color independence:** Every semantic meaning is reinforced by position or text content, not color alone (e.g., `❯` prefix for input, `●` for headings, `│` for separators)
- **16-color fallback:** When terminal doesn't support 256 colors, the theme maps to the closest SGR color codes (30-37, 90-97) without losing semantic distinction
- **Dim text:** `dim` attribute provides a second visual channel that doesn't rely on hue — useful for colorblind users

## 5. Voice & Tone

- **Register:** Technical, precise. Color names are semantic (`--brand`, `--success`), not decorative (`--coral`, `--sky`)
- **Naming convention:** Prefix all tokens with their category (`--status-`, `--md-`, `--diff-`, `--spinner-`)
- **Contrast budget:** Dark theme favors cool-on-dark (low fatigue). Light theme favors warm-on-light (natural reading).

## 6. Implementation Practices

- **Token format:** TypeScript object with named properties, exported as `Theme` type. Both dark and light themes conform to the same interface.
- **Dual rendering path:** Two resolver functions:
  - `resolveInkProps(token)` → Ink `<Text>` props (color, backgroundColor, bold, dim)
  - `resolveSGR(token)` → SGR escape sequence string (for inline mode)
- **Theme selection:** Runtime config key `theme: 'dark' | 'light'`, defaulting to `'dark'`
- **No CSS variables:** Terminal has no CSS. Tokens are TS objects consumed by renderer functions.
- **Fallback chain:** Theme value → default value → SGR fallback → no color (plain text)

## 7. Anti-Patterns

- **No pure black (#000) backgrounds.** True black creates harsh contrast on OLED and looks wrong on LCD. Use `rgb(30, 30, 34)` — dark enough to recede, soft enough to survive 8 hours.
- **No saturated accents in large areas.** A bright cyan status bar is fine; a bright cyan background is eye-destroying. Semantic accents appear on *text*, never on *surfaces*.
- **No color-only status indicators.** Every colored element must also carry a positional or textual cue (prefix character, position in layout, bold vs dim).
- **No "theme = invert dark".** Light theme is not `255 - dark`. It's a separate palette with shifted temperatures and adjusted contrast ratios.
- **No magic numbers in component files.** Every `rgb()` or hex value lives in the theme object. Components reference `theme.brand`, never `rgb(180, 130, 255)`.

## 8. Decision-Making

1. **Legibility over aesthetics.** If a color looks beautiful but fails the squint test (can't distinguish from adjacent slot), replace it. Beauty is a consequence of clarity, not a goal.
2. **Dark theme first.** This is a terminal tool — dark is the default environment. Light theme adapts dark's semantic relationships, not the other way around.
3. **Desaturated over saturated.** Long sessions demand low chroma. Every accent is pulled toward gray by 20-30% compared to its "pure" hue.
4. **Consistency across rendering paths.** The Ink component path and the raw ANSI path must produce visually identical output. If they diverge, the theme definition is wrong.
5. **16-color degradation is graceful, not catastrophic.** When forced to SGR basics, the system falls back to hue families (red/green/blue/yellow/cyan/magenta) — less refined but still semantically distinguishable.

## 9. Workflow

1. Define the `Theme` TypeScript interface with all semantic slots (see §3 for the full list)
2. Implement `darkTheme` and `lightTheme` objects conforming to the interface
3. Implement `resolveInkProps(slot: keyof Theme)` → Ink-compatible props
4. Implement `resolveSGR(slot: keyof Theme)` → SGR escape sequence
5. Replace all hardcoded color values in component files with theme references
6. Update `styleToInkProps()` and `fgToSGR()` to consume the theme object
7. Add theme selection to config (CLI flag `--theme` or config file)
8. Run contrast tests: verify all semantic pairs pass WCAG AA in both themes
