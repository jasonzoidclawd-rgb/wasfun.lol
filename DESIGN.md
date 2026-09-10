---
version: alpha
name: "Mayhem Oracle / wasfun.lol"
description: "A clear, evidence-backed ARAM Mayhem companion for League players across research, quick-answer, and glanceable overlay contexts."
colors:
  canvas: "#0a0e17"
  surface: "#111827"
  surface-card: "#1a1f2e"
  surface-hover: "#222839"
  surface-elevated: "#252b3b"
  text-primary: "#f1f5f9"
  text-secondary: "#94a3b8"
  text-muted: "#64748b"
  border-default: "rgba(148, 163, 184, 0.12)"
  border-strong: "rgba(148, 163, 184, 0.25)"
  accent-cyan: "#00d4ff"
  accent-purple: "#7c3aed"
  accent-member: "#fbbf24"
  tier-god: "#ff4655"
  tier-strong: "#ff8c00"
  tier-good: "#3b82f6"
  tier-average: "#22c55e"
  tier-weak: "#6b7280"
  rarity-prismatic: "#c896ff"
  rarity-gold: "#ffd700"
  rarity-silver: "#94a3b8"
  state-success: "#22c55e"
  state-warning: "#eab308"
  state-danger: "#ef4444"
  state-info: "#38bdf8"
typography:
  display-md:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
  heading-sm:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
  body-md:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label-sm:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.25
  data-xs:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  card: "14px"
  xl: "16px"
  full: "9999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  6: "24px"
  8: "32px"
  12: "48px"
  gutter: "24px"
  max-content: "1280px"
components:
  card: "surface-card / card radius / border-default"
  control: "surface-elevated / md radius / 44px mobile minimum height"
  badge: "full radius for status; sm radius for data labels"
  overlay-panel: "#080c14 at 97% opacity / lg radius / accent-cyan edge"
---
# Mayhem Oracle / wasfun.lol

## Overview

Mayhem Oracle is the product name. `wasfun.lol` is the canonical domain and sharing identity. The approved lockup is “Mayhem Oracle at wasfun.lol” until a deliberate product rename is approved. Do not alternate between “The Oracle,” “Mayhem Advisor,” “Companion,” and “Advisor” as if they were separate brands.

The product helps League players make better ARAM Mayhem decisions. It has three distinct contexts:

- Research: editorial pages, patch truth, tables, and provenance on desktop.
- Quick answer: a focused, touch-first decision flow on mobile.
- Glanceable overlay: a transparent, bounded in-game aid with no automation or hidden information.

Design principles:

1. Answer first; evidence on demand. Put the recommended action and confidence before the explanation.
2. Dense, never cryptic. Information density is welcome when labels, grouping, and hierarchy remain explicit.
3. Patch truth stays visible. Patch, update time, source, and methodology are part of the interface, not footnotes.
4. Separate action from explanation. Amber membership actions, cyan navigation, and evidence surfaces must not compete.
5. Competitive clarity without casino urgency. Avoid flashing timers, fake scarcity, streak pressure, and celebratory reward language.
6. League flavor without Riot impersonation. Use original UI, icons, and copy; never present the product as an official Riot service.
7. Every semantic cue survives without color. Pair color with text, shape, position, icon, or pattern.

The design document is normative for new work and a migration target for existing work. It does not silently rename routes, components, or APIs.

## Colors

The existing CSS variables in `src/styles/globals.css` are the source of truth for the web. Overlay variables in `overlay/src/App.css` must map to the same semantic roles. Use the frontmatter values above when adding a token; do not introduce a near-duplicate hex value for an existing role.

The frontmatter uses semantic role names; the implementation uses the existing variable names. This mapping is normative — reuse it, do not rename variables or add duplicates:

| Spec token | `globals.css` variable |
| --- | --- |
| `canvas` | `--color-bg-primary` |
| `surface` | `--color-bg-secondary` |
| `surface-card` | `--color-bg-card` |
| `surface-hover` | `--color-bg-card-hover` |
| `surface-elevated` | `--color-bg-elevated` |
| `text-primary` / `text-secondary` / `text-muted` | `--color-text-primary` / `-secondary` / `-muted` |
| `border-default` | `--color-border-default` |
| `border-strong` | `--color-border-hover` |
| `accent-cyan` | `--color-neon-primary` |
| `accent-purple` | `--color-neon-secondary` |
| `accent-member` | none yet — see below |
| `tier-god` / `tier-strong` / `tier-good` / `tier-average` / `tier-weak` | `--color-accent-god` / `-strong` / `-good` / `-average` / `-weak` |
| `rarity-prismatic` / `rarity-gold` / `rarity-silver` | `--color-rarity-prismatic` / `-gold` / `-silver` |
| `state-success` / `state-warning` / `state-danger` | `--color-wr-high` / `--color-wr-mid` / `--color-wr-low` |
| `state-info` | none yet — see below |

`accent-member` (#fbbf24) and `state-info` (#38bdf8) are not yet `globals.css` variables: today they appear as Tailwind amber/sky utility classes in the membership components and as literal values in `overlay/src/App.css`. They are migration targets — the first change that touches those styles should introduce `--color-accent-member` and `--color-state-info` and consume them, rather than adding new literal values.

Surface hierarchy:

- `canvas` is the page background and the deepest overlay backdrop.
- `surface` is a section or navigation surface.
- `surface-card` is a data card, result card, or table row group.
- `surface-hover` is the interactive hover/selected treatment.
- `surface-elevated` is for menus, drawers, focused controls, and member prompts.

Text hierarchy is primary for essential content, secondary for supporting context, and muted only for metadata that remains understandable when de-emphasized. Do not use muted text for a required label, error, price, recommendation, or freshness state.

Semantic mapping:

| Role | Token | Required non-color cue |
| --- | --- | --- |
| God / S+ tier | `tier-god` | S+ label and tier badge shape |
| Strong / S tier | `tier-strong` | S label and tier badge shape |
| Good / A tier | `tier-good` | A label and tier badge shape |
| Average / B tier | `tier-average` | B label and tier badge shape |
| Weak / C tier | `tier-weak` | C label and tier badge shape |
| Prismatic rarity | `rarity-prismatic` | “Prismatic” text and gem icon |
| Gold rarity | `rarity-gold` | “Gold” text and rarity icon |
| Silver rarity | `rarity-silver` | “Silver” text and rarity icon |
| Success / selected | `state-success` | check icon, selected state, and text |
| Warning / review | `state-warning` | warning icon and explicit label |
| Danger / invalid | `state-danger` | error icon and actionable message |
| Info / evidence | `state-info` | info icon or “why” label |

Tier, rarity, grade, confidence, and membership are separate dimensions. Never reuse a rarity color for a membership CTA, or a tier color for a warning. Member actions use `accent-member`; navigation and evidence use `accent-cyan`; secondary emphasis may use `accent-purple`.

Do not place white text on a saturated tier color unless contrast is verified. Prefer a tinted surface, a border, and a dark text treatment when the semantic color is not contrast-safe. Gradients and glows are decorative only; they never carry meaning.

## Typography

Use local Inter for Latin text and the existing platform CJK fallback stack: PingFang TC/SC, Microsoft JhengHei/YaHei, Hiragino Sans, Noto Sans CJK, then `sans-serif`. Do not add a CJK webfont without a measured performance and licensing decision.

The scale is intentionally compact for game data but readable for a rushed decision:

- `display-md` is for page titles and one primary result, not repeated cards.
- `heading-sm` is for card and section titles.
- `body-md` is the default explanatory and form text.
- `body-sm` is supporting copy and table content.
- `label-sm` is for badges, filters, and metadata labels.
- `data-xs` is for secondary overlay metrics only; it is never the sole presentation of a recommendation.

Use sentence case. All-caps is limited to short Latin labels and must not be applied to CJK. Use tabular numerals for scores, probabilities, win rates, and timestamps so columns do not jitter. Keep a visible text label beside icons when a value affects a decision.

On web and mobile, essential text is at least `body-sm`; primary touch-flow instructions use `body-md`. The overlay may use `data-xs` for secondary metadata, but its recommendation, champion, and action remain `body-sm` or larger. Test long English and CJK strings for wrapping; never truncate a champion, augment, warning, or member requirement with an ellipsis that hides meaning.

## Layout

Use the existing `max-w-7xl` content boundary and a 4px base rhythm. Default page gutters are 24px desktop, 16px mobile, and safe-area aware in the mobile tab bar. Prefer one strong column for a decision; add supporting columns only when comparison is the user’s explicit task.

| Context | Breakpoint / surface | Layout contract |
| --- | --- | --- |
| Research desktop | 1200px and wider, opaque page | 12-column grid; editorial rail plus data region; tables may scroll horizontally with a visible affordance |
| Compact desktop | 768–1199px, opaque page | 8-column grid; collapse secondary rail before shrinking the answer card |
| Quick answer mobile | 320–767px, PWA | One column; recommendation and next action appear in the first viewport; bottom navigation respects safe area |
| Glanceable overlay | Transparent fullscreen | Keep the game visible; show only the current decision, confidence, and one next action; visual badges are click-through by default |
| Overlay controls | Bounded consent/collector/coach windows | Controls are separate from click-through visual surfaces; focus, keyboard navigation, and close behavior are explicit |

Responsive behavior is a change in priority, not a smaller desktop. On mobile, hide or move provenance only after the recommendation is complete. On overlay, omit editorial paragraphs and expose “why” through a bounded panel or the web companion.

The web shell keeps the fixed navbar, footer, mobile tab bar, and consent surface from `src/app/[locale]/layout.tsx`. New screens must preserve their main-content top padding and mobile safe-area inset. Avoid nested fixed bars that trap scroll.

## Elevation & Depth

Depth is tonal first, border second, blur third. Use `surface-card` over `surface`, a subtle border, and a restrained shadow before adding a glow. Glass cards may use the existing 12px backdrop blur and 14px radius when content remains readable over the canvas.

The maximum visual hierarchy is:

1. Canvas and section surface.
2. Card or table group.
3. Focused control, menu, drawer, or member gate.
4. Temporary alert or consent dialog.

Do not stack more than two translucent layers. Do not use a cyan or purple glow to imply a better tier, higher probability, or membership status. Overlay panels use the existing near-black 97% surface and cyan edge so the game remains visible without making text float.

## Shapes

Cards use `card` (14px). Controls use `md` (8px), large panels use `lg` (12px), and data badges use `sm` (6px). Use `full` only for pills, avatars, progress tracks, and compact status dots. Do not mix arbitrary 10px, 18px, and 20px radii within one flow.

Maintain a clear hit-area boundary even when the visual shape is small. A 6px badge may sit inside a 44px button; it must not become the button’s only hit target. Rounded corners should support grouping, not turn every row into a pill.

## Components

Component contracts:

- Every data card has a stable title, canonical entity name, patch/freshness context when relevant, and an accessible action or static status.
- Every icon has a real source asset or the project icon library. Emoji are not final brand marks or data icons.
- Every selected, disabled, loading, stale, locked, and error state has a text or screen-reader equivalent.
- Shared web and overlay concepts use the same semantic token and label, even when density differs.

### Navigation and filters

`Navbar` keeps the current desktop links and mobile tab bar. The logo lockup uses an owned asset or icon component; the literal lightning emoji is a temporary fallback, not a final brand mark. Locale selection is always available without hiding account or consent status.

Use the existing segmented filter pattern: 4px internal padding, `lg` outer radius, `md` item radius, and 6px/14px item padding. A filter chip exposes its selected state in text and focus styling. Search results preserve the canonical entity slug so a localized label never breaks a link.

### Advisor recommendation

The advisor result is the primary component in `AdvisorMemberClient`:

1. Recommendation: entity name, tier/grade, and one clear action.
2. Confidence: high/medium/low label with a numeric value only when meaningful.
3. Why: two or three evidence bullets, ordered by decision impact.
4. Constraints: round, rarity, rerolls, and warnings.
5. Provenance: patch and update/source link.

The member gate in `MembershipGate` explains the locked capability before the CTA. The CTA uses `accent-member` and a member label; it must never look like a tier upgrade or a limited-time purchase. Exploration and competitive modes are visually distinct by label and helper text, not by an unexplained color shift.

### Entity cards and tier badges

Champion, item, and augment cards share image, name, compact metadata, and a link or selection affordance. Preserve aspect ratio and use a neutral placeholder only for a genuinely missing asset. `GradeBadge` owns grade labels and exposes `role="status"` where appropriate.

Tier badges use S+/S/A/B/C text, a consistent badge shape, and an optional icon. Rarity badges use Prismatic/Gold/Silver text and their own icon. Never show a color swatch without its semantic label.

### Freshness and provenance

`DataProvenance` is a visible, compact row: “Updated [time] · Patch [version] · Source [link] · Methodology.” The source link is keyboard reachable. Stale or partial data uses an explicit stale/partial label and an explanation of what is safe to use. A timestamp without a source is incomplete.

### Patch notes and tables

Patch rows lead with the changed entity and impact summary, then show details and source. Use a changed/buff/nerf label plus icon or sign; do not rely on green/red alone. Tables align numeric columns, keep headers visible when useful, and provide a mobile row/card alternative when horizontal scrolling would hide the decision.

### Overlay

The overlay has three visual states: disconnected, connected/collecting, and decision ready. Status dots are paired with words. The bottom-left HUD is compact; the bounded coach panel is the only place for multi-line explanation. Keep the current champion, recommendation, confidence, and one action within a glance. Controls such as consent, collector settings, and close/focus behavior remain in their bounded windows.

Overlay behavior must remain compliant: no client injection, automation, screenshots, chat capture, PUUID/player-name capture, or hidden-information guidance. The collector is anonymous and consented. Device-code/token auth is explicit; browser cookies are not assumed to be shared with Tauri.

### Loading, empty, error, stale, and locked states

- Loading: preserve the final layout shape and announce progress without an infinite shimmer.
- Empty: say what is missing and provide the next useful action.
- Error: name the failed operation, preserve any safe cached context, and offer retry.
- Stale: show age and source status; do not silently present old values as live.
- Locked: explain the entitlement boundary and show a non-deceptive member action.

## Interaction & Motion

Use the existing 480ms reveal easing (`cubic-bezier(.16, 1, .3, 1)`) only for page entry and meaningful section reveal. Hover may raise contrast and shadow, but never be the only way to discover an action or explanation. Focus-visible styles must use a two-pixel high-contrast outline with an offset on every interactive control.

Respect `prefers-reduced-motion`. In reduced motion, remove parallax, pulsing glows, auto-advancing transitions, and scroll-triggered movement; retain an immediate state change. Do not animate scores, win rates, or tier colors in a way that implies a change in truth.

Keyboard order follows the visual decision order. Escape closes drawers and bounded overlay panels. A menu or dialog returns focus to its trigger. Touch controls meet the 44px minimum on mobile and have 8px separation where accidental activation would be harmful.

## Do’s and Don’ts

Do:

- Put the recommended action, confidence, and patch context before deep evidence.
- Reuse the existing token names and semantic roles.
- Show source, freshness, methodology, and entitlement boundaries at the point of use.
- Pair tier, rarity, warning, and change colors with labels/icons/shapes.
- Test en, zh-TW, zh-CN, ja, and ko before calling a shared component complete.
- Keep overlay visual surfaces glanceable and controls bounded.

Don’t:

- Copy arammayhem.com, Blitz, Riot, or other competitor trade dress, icons, wording, or layouts.
- Use emoji as the final logo, tier icon, or data status icon.
- Hide a recommendation behind a long editorial preamble, modal, or login wall when a safe public answer exists.
- Use rarity colors for membership, tier colors for warnings, or red/green as the sole signal.
- Add casino-like urgency, fake scarcity, flashing timers, or reward confetti.
- Put private/member/internal data in public routes, public JSON, page metadata, or overlay fixtures.
- Add a new token when an existing semantic token can express the state.

## Accessibility

Target WCAG 2.2 AA for public web and member surfaces. Verify normal-text contrast, focus visibility, keyboard operation, reflow at 200% text size, and content at narrow widths. A contrast pass does not excuse a missing label or a color-only state.

Every input has a visible label or an equivalent accessible name. Every icon-only button has a tooltip or accessible name that is available without hover. Tables expose headers; dialogs expose a name and a focus trap; status changes use an appropriate live region without interrupting typing.

Use 44px minimum touch targets on mobile and overlay controls. Keep primary text at 14px or larger on web/mobile. At the overlay’s 11px data scale, limit content to secondary metrics and provide a larger readable coach panel for explanations.

Support keyboard, screen readers, high-contrast settings, browser zoom, and reduced motion. Preserve the user’s locale and direction assumptions. CJK text must wrap naturally, retain appropriate line height, and never be clipped by a fixed-height badge or panel.

## Content, Data & Localization

All user-facing copy belongs in the five locale message files (`en`, `zh-TW`, `zh-CN`, `ja`, `ko`). This includes overlay labels, status dots, button text, warnings, membership copy, empty states, and provenance labels. Hardcoded English in `overlay/src/components/CoachPanel.tsx` is a follow-up migration item, not a reason to invent a second copy system.

Use canonical data slugs for links and localized display names for labels. Render patch and update values from the public metadata pipeline. Keep `DataProvenance` adjacent to claims that can change. Public pages may describe methodology and safe aggregate summaries; member decision APIs and signed packs remain entitlement-gated; internal data never crosses the public boundary.

The interface must never expose hidden information or imply certainty the data cannot support. Show confidence and limitations. Keep the Riot fan-project attribution and disclaimer in the global footer or the relevant legal surface; do not imply endorsement.

## Governance & QA

`src/styles/globals.css` is the web token implementation. `overlay/src/App.css` is the overlay implementation. When a token changes, inspect both and update any shared mapping before adding component-specific overrides. Component contracts live beside their implementation in `src/components/ui`, `src/components/advisor`, `src/components/membership`, and `overlay/src`.

Before merging a UI change, verify:

- all five locales render without clipped or missing decision copy;
- keyboard and focus-visible paths complete the primary flow;
- tier/rarity/state cues remain understandable in grayscale;
- stale, error, empty, locked, and disconnected states are truthful;
- desktop, mobile quick answer, and overlay density contracts hold;
- provenance, patch, source, and entitlement boundaries are visible;
- the scoped diff contains no public-data or unrelated Markdown edits.

For code changes, use the repository gates from `CLAUDE.md` (`npm test`, `npx eslint src scripts`, `npm run build`, and the overlay build when overlay code changes). This document-only change requires structural Markdown/YAML validation and `git diff --check`; runtime gates are not a substitute for visual QA.

## References

This document follows the information architecture and token/frontmatter conventions of the official [Google Labs DESIGN.md specification](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md), with structural cues from its [Totality Festival example](https://github.com/google-labs-code/design.md/blob/main/examples/totality-festival/DESIGN.md) and restrained surface guidance from its [Atmospheric Glass example](https://github.com/google-labs-code/design.md/blob/main/examples/atmospheric-glass/DESIGN.md). Accessibility requirements are aligned to [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Gaming accessibility patterns were cross-checked against the [Xbox Accessibility Guidelines](https://learn.microsoft.com/en-us/xbox/accessibility/guidelines). The original UI, assets, and copy remain owned by wasfun.lol; Riot attribution follows [Riot Games legal guidance](https://www.riotgames.com/en/legal).
