# Atimo T3 UI — design spec for ported views

Ported views live in `src/t3/views/` and replace the legacy views one-for-one.
Old files stay untouched. This spec is the law for every ported view.

## Hard rules

1. Never edit any file outside `src/t3/views/<YourView>.tsx`.
2. Keep ALL behavior identical: same store selectors, same actions, same
   props, same names. Change presentation only.
3. Exported component name stays the same (e.g. `ProjectsView`).
4. TypeScript strict + `noUnusedLocals` + `noUnusedParameters`. Zero unused imports.
   Verify: `bunx tsc --noEmit` from repo root must pass.
5. Reuse these freely: `@/components/ui/Icon`, `@/components/ui/primitives`
   (`Button`, `Kbd`, `ProviderSigil`, `Empty`), `@/components/ui/scroll-area`,
   `@/lib/*`, `@/lib/store`, HugeIcons icons.
6. Import shared atoms from `@/t3/primitives`: `T3Section`, `T3Row`, `T3Card`
   (via CSS class only), `T3ChevronValue`, `projectTileStyle`,
   `projectTileText`, `relativeTime`.

## Visual language (ESNext, t3code-inspired)

- Canvas is `var(--bg)` (#000). Raised surfaces `var(--bg-raised)` with
  `1px solid var(--border)` (white-alpha 8%). Radius 8–12px.
- Typography: 13px base UI, 11px meta, 11px labels. **Sentence case always** —
  never `uppercase`. Tracking `-0.008em` body, `-0.03em` display.
- Neutral foreground `var(--fg)` / `--fg-dim` / `--fg-faint`. **No other hues**
  except the four semantics: `--accent` (selection/primary), `--green` (ok),
  `--red` (fail), `--magenta` (model). `--amber` only for attention.
- Buttons: primary = `bg-accent text-white rounded-lg h-8 px-3.5 text-[12.5px]`;
  secondary = `border border-border bg-bg-surface hover:bg-bg-hover`; press
  feedback `.pressable` (already scales on :active).
- Cards: `.t3-card`. Section labels: `.t3-section-label`. Shortcuts: `.t3-kbd`.
- Thread/list rows: `.t3-thread-row` (+ `[data-active="true"]` when selected).
- Empty states: icon in 40px rounded tile + one sentence + one action. No
  clipart.
- Motion: 150–250ms `--ease-out` on hover/color/transform only
  (transform+opacity only). Never animate layout properties.
- Selection/highlight uses accent at ~17%: `color-mix(in srgb, var(--accent) 17%, transparent)`.
- Hover effects only behind `@media (hover: hover) and (pointer: fine)` or rely
  on `.pressable`/existing utilities.
- `--shadow-panel` for floating layers; menus/popovers `.dialog-glass`.

## Layout idioms (from t3.codes)

- One 46rem max content column for reading surfaces; cards instead of nested
  borders for grouped controls; hairline 1px dividers (`border-border`).
- Quiet chrome: 36px rows, 24px icon buttons, no zebra backgrounds, no drop
  shadows on cards.
- Errors explain + offer the fix inline (see TurnError). Empty states invite.

## Icons (verified to exist as `@hugeicons/core-free-icons`)

AiBrain01Icon, Alert02Icon, Archive01Icon, ArrowRight01Icon,
ArrowUp01Icon, ArtificialIntelligenceIcon, ChatAdd01Icon, CheckmarkCircle02Icon,
Copy01Icon, Delete02Icon, GitCompareIcon, GitForkIcon, Home01Icon, Layers01Icon,
Folder01Icon, PuzzleIcon, RefreshIcon, SearchIcon, SparklesIcon, StopIcon,
TimelineIcon, Tick02Icon, MoreHorizontalIcon, GridViewIcon, TimelineIcon,
Settings02Icon, Database01Icon, GitCompareArrowsIcon, Note01Icon.
Use `<Icon icon={X} size={14} strokeWidth={1.75} />`.

## Deliverable

One new file `src/t3/views/<Name>View.tsx`, compiles clean with the rest of the
app, and reads visually as its t3 counterpart, not as the Codex original.
