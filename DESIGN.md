---
name: SILHO
description: Pure architectural monochrome wardrobe ledger and virtual fit studio in a Swiss-Japanese hairline grid.
colors:
  sumi-ink: "#0e0e0e"
  sumi-hover: "#2b2b29"
  alabaster-paper: "#f9f8f6"
  chalk-white: "#ffffff"
  chalk-stone: "#f2f1ed"
  stone-deep: "#eae8e3"
  stone-hairline: "#e2e0da"
  stone-mid: "#c8c5bd"
  graphite: "#4a4945"
  stone-muted: "#6c6a64"
  danger-ink: "#8c1d18"
  danger-bg: "#faf2f2"
  danger-border: "#d9b4b2"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "2.375rem"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.625rem"
    fontWeight: 600
    lineHeight: 1.0
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0em"
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0em"
  label:
    fontFamily: "IBM Plex Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "0em"
rounded:
  none: "0px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  2xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.sumi-ink}"
    textColor: "{colors.chalk-white}"
    rounded: "{rounded.none}"
    height: "40px"
    padding: "0 16px"
  button-primary-hover:
    backgroundColor: "{colors.sumi-hover}"
    textColor: "{colors.chalk-white}"
    rounded: "{rounded.none}"
  button-secondary:
    backgroundColor: "{colors.chalk-white}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.none}"
    height: "36px"
    padding: "0 14px"
  button-wear:
    backgroundColor: "{colors.alabaster-paper}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.none}"
    height: "36px"
    padding: "0 12px"
  input-field:
    backgroundColor: "{colors.chalk-white}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.none}"
    height: "56px"
    padding: "0 16px"
  catalog-tile:
    backgroundColor: "{colors.chalk-white}"
    textColor: "{colors.sumi-ink}"
    rounded: "{rounded.none}"
    padding: "16px"
---

# Design System: SILHO

## Overview

**Creative North Star: "The LifeWear Spec Ledger"**

SILHO takes its visual poise from Japanese minimalist apparel retail and Swiss archival cataloging: pure architectural monochrome that earns charisma through decisive typographic scale, warm stone-paper tonal separation, and continuous 1px catalog hairlines rather than color gimmicks or decorative chrome. Garments sit like photographed lookbook objects inside warm chalk-stone wells, anchored below by hangtag-style tabular numerals that make cost-per-wear immediately legible.

Every surface operates as a calm, fast daily utility across desktop and mobile browsers. Navigation, category filters, and studio mode switches drop boxy pill wrappers in favor of crisp full-height underline rails, while a solid 7px sumi-ink square beside the wide-tracked SILHO wordmark acts as the system's quiet signature stamp.

**Key Characteristics:**
- Pure architectural monochrome built on warm alabaster paper, chalk white, warm chalk stone, and deep sumi ink.
- Shared 1px Swiss-Japanese hairline catalog grids (2 columns on mobile, 3 to 4 on desktop) with zero doubled seams and zero empty filler tiles.
- Strong scale contrast between bold tightly-tracked tabular ledger numerals and wide-tracked uppercase specification labels.
- Sharp 0px corners everywhere, letting garment silhouettes carry the only organic curves on screen.

## Colors

A strictly monochrome warm-stone palette where tonal temperature and crisp ink contrast do all the structural work, reserving muted crimson strictly for error alerts.

### Primary
- **Sumi Ink** (`sumi-ink`): Primary text, active 2px underline indicators, primary action fills, selection rings, dead-stock stamps, focus outlines, and the 7px brand square mark.
- **Sumi Charcoal** (`sumi-hover`): Hover state for solid primary buttons, stepping softly upward in luminance without losing contrast.

### Neutral
- **Alabaster Paper** (`alabaster-paper`): Root page ground and opening animation canvas, giving pure white structural strips subtle paper separation.
- **Chalk White** (`chalk-white`): Primary structural surface for the top navigation bar, editorial ledger strips, hangtag tile footers, auth forms, and modal dialogs.
- **Chalk Stone** (`chalk-stone`): Photographic garment cutout wells and model studio stages, lifting white and pale garments off the page without introducing hue.
- **Deep Stone** (`stone-deep`): Recessed studio surround around the Layer Board flat-lay canvas and hover surface accents.
- **Stone Hairline** (`stone-hairline`): Single 1px shared grid dividers, structural borders, and horizontal specification rules.
- **Mid Stone** (`stone-mid`): Dashed upload dropzone borders, inactive switch borders, and scrollbar thumbs.
- **Warm Graphite** (`graphite`): Secondary body copy, form labels, and quiet action labels at high contrast.
- **Stone Muted** (`stone-muted`): Uppercase micro-spec labels, unit suffixes, wear recency, and secondary counters while preserving WCAG AA contrast on white and alabaster grounds.
- **Alert Crimson / Rose Surface** (`danger-ink`, `danger-bg`, `danger-border`): Reserved exclusively for inline error banners (`role="alert"`).

### Named Rules
**The Pure Monochrome Rule.** Do not introduce chromatic accent hues into navigation, badges, or garment chrome; visual emphasis comes strictly from weight, scale, negative space, and full Sumi Ink inversion.
**The Warm Stone Well Rule.** Garment cutouts and 3:4 model stages always sit inside Chalk Stone (`chalk-stone`) wells rather than flat white, giving silhouettes quiet photographic depth.

## Typography

**Display Font:** Inter (with system sans-serif fallback, OpenType features `"cv02", "cv03", "cv04", "cv11"`)
**Body Font:** Inter (with system sans-serif fallback)
**Label / Mono Font:** IBM Plex Mono (`400`, `500`) with `font-variant-numeric: tabular-nums`

**Character:** A geometric workhorse grotesque paired with IBM Plex Mono for field indexes, sentence-case micro-labels, tabular numerals, and ledger equations—creating quiet Swiss-Japanese archival discipline without uppercase tracking clichés or decorative display faces.

### Hierarchy
- **Display / Auth Heading** (`500`, `24px–28px`, `1.15` line-height, `-0.025em` tracking): Ruled hangtag headers (`Sign in`, `Start an archive`).
- **Headline / Ledger Figure** (`600`, `20px–26px`, `1.0` line-height, `-0.03em` tracking, `tabular-nums`): Archive ledger KPIs (`Total Archive`, `Avg. Cost / Wear`, `Logged Wears`, `Unworn 90d+`) and prominent card CPW figures (`15px–17px`).
- **Title** (`500`, `13px–16px`, `1.35` line-height, `-0.01em` tracking): Garment titles, modal headers, and panel section names.
- **Body** (`400`, `13px–16px`, `1.55` line-height, `65–75ch` max prose measure): Explanatory copy, empty-state guidance, and `16px` touch-safe form inputs.
- **Label / Spec (Mono)** (`400`–`500`, `11px–12px`, `1.35` line-height, `0em` tracking, `tabular-nums`, sentence case): Hangtag row indexes (`01`, `02`, `03`), sentence-case field labels (`Name`, `Email`, `Password`), inline controls (`Show`/`Hide`), ledger specimen equations, and colophon metadata.

### Named Rules
**The Tabular Ledger Rule.** Every currency amount (`₱`), wear count, dimension (`cm`/`kg`), row index, and percentage uses `tabular-nums` so numbers align cleanly across grids and never jitter during optimistic wear updates.

## Layout

SILHO uses a `1440px` centered maximum container (`1200px` on Auth) with responsive horizontal gutters (`16px` mobile, `24px`–`32px` tablet, `40px` desktop). Routine app navigation sits in a sticky `60px` top bar, followed by full-width hairline-bordered ledger or mode strips on pure Chalk White (`chalk-white`) so working content sits immediately below with zero wasted hero padding.

### Auth Surface (`/login` & `/register` — Light-Only Archival Slip)
Authentication routes stay strictly light-only (`#FAFAFA` paper ground, `#FFFFFF` ruled slip, `#0A0A0A` carbon ink, `#666666` muted graphite, `#E5E5E5` `1px` hairlines) with no theme toggle, keeping the first `56px` input row immediately accessible near the top of mobile viewports. On desktop (`>= 1024px`), a 12-column editorial grid anchors the 420px Hangtag slip on columns 2–6 beside a quiet left-ruled cost-per-wear equation (`₱ 2,400 ÷ 18 wears = ₱ 133 / wear`) on columns 8–11.

Catalog galleries (`Closet`, `Lookbook`, and `Canvas` garment pickers) use a **shared 1px hairline grid**: the container draws `border-top` and `border-left` (`stone-hairline`), and each tile draws `border-right` and `border-bottom`. This guarantees crisp single-pixel architectural seams across all columns without doubled borders or gray empty cells on partial final rows. On mobile (`< 640px`), Closet and Lookbook switch to a 2-column lookbook grid (`grid-cols-2`) and horizontal category/mode tabs scroll smoothly in a single row without wrapping.

## Elevation & Depth

SILHO is flat by default and communicates hierarchy through crisp 1px hairlines and warm tonal stepping (`alabaster-paper` → `chalk-white` → `chalk-stone`) rather than card drop shadows. Elevation appears only in two disciplined places: subtle natural floor drop shadows beneath isolated transparent garment cutouts so clothing reads as physical fabric, and a diffused ambient shadow beneath modal dialogs over a `45%` dimmed backdrop.

### Named Rules
**The Flat-By-Default Rule.** Navigation bars, ledger panels, and catalog tiles carry zero box-shadow at rest or hover; depth belongs solely to transparent garment silhouettes and modal overlays.

## Shapes

Every button, input, toggle, tile, modal, and badge uses strictly sharp `0px` corners (`rounded.none`). This architectural discipline lets garment silhouettes and human portraits provide the only soft organic curves on the screen. The brand lockup echoes this geometry with a solid `7px × 7px` Sumi Ink square stamp paired beside the wide-tracked uppercase `SILHO` wordmark (`0.28em` tracking).

## Components

Every interactive component shares sharp 0px geometry, crisp 1px hairline borders, fast `150ms–200ms` state transitions, and consistent Sumi Ink (`sumi-ink`) active inversion.

### Buttons
- **Shape:** Strictly sharp corners (`0px`).
- **Primary:** Solid Sumi Ink (`sumi-ink`) fill with Chalk White (`chalk-white`) medium text (`h-9` to `h-11`, `0 16px` padding); transitions smoothly to Sumi Charcoal (`sumi-hover`) on hover and `40%–55%` opacity when disabled.
- **Secondary:** Chalk White (`chalk-white`) fill with `1px` Stone Hairline (`stone-hairline`) border and Sumi Ink text; border snaps cleanly to Sumi Ink on hover.
- **Quick-Log Wear Button:** Alabaster Paper (`alabaster-paper`) ground with `1px` Stone Hairline border and uppercase `11px–12px` label (`+ Worn Today`), inverting completely to solid Sumi Ink with a white check icon on hover and confirmation.

### Navigation & Underline Rails
- **Style:** Full-height (`60px` top bar, `48px` mode/category strips, `40px` picker filters) horizontal rails with zero pill borders.
- **States:** Inactive items use Stone Muted (`stone-muted`); hover transitions to Sumi Ink; active items lock to Sumi Ink medium weight with a crisp `2px` bottom rule anchored directly onto the bar's `1px` hairline border.

### Catalog Tiles
- **Corner Style:** Sharp (`0px`), participating in the shared `1px` Stone Hairline grid.
- **Structure:** Top `4:5` Chalk Stone (`chalk-stone`) studio stage (garment scales `1.035×` over `300ms ease-out` on hover; discreet top-left category stamp; solid Sumi Ink `90D+ UNWORN` tag only when dead-stock) over a Chalk White hangtag footer showing item title, wear recency, prominent bold `₱/wear`, quiet retail price, and quick-log trigger.
- **Selection (Studio Pickers):** Selected garments highlight via an overlaid `1.5px` Sumi Ink frame (`pointer-events-none absolute inset-0 border-[1.5px]`) painting cleanly above opaque image wells, paired with a top-right solid Sumi Ink slot badge (`UPPER` / `LOWER` / `STYLED`).

### Inputs / Fields
- **Auth Hangtag Rows:** Flush `56px` (`h-14`) ruled rows inside a `#FFFFFF` `1px` `#E5E5E5` container (`0px` radius). Each row pairs a fixed `116px`–`128px` right-ruled `IBM Plex Mono` index and sentence-case label cell (`01 Email`, `02 Password` on sign-in; `01 Name`, `02 Email`, `03 Password` on register) with a borderless `16px` `Inter` input cell (zero placeholders), inline `Show`/`Hide` mono password toggle, and a full-width `56px` solid `#0A0A0A` submit row.
- **Standard Studio Inputs:** `44px` (`h-11`) tall Chalk White fields with `1px` Stone Hairline borders, `0px` radius, and `14px` Sumi Ink text.
- **Focus:** Auth hangtag rows apply a crisp `1px` inset `#0A0A0A` focus frame (`focus-within:shadow-[inset_0_0_0_1px_#0A0A0A]`) with zero layout shift and `#0A0A0A` text caret; standard fields shift border to Sumi Ink with a `1.5px` `:focus-visible` outline (`2px` offset).
- **Error / Disabled:** Validation errors display in dedicated `role="alert"` banners (`danger-bg` / `danger-border` / `danger-ink`); disabled fields step down to `#FAFAFA`.

### Opening Wordmark (`OpeningAnimation` + `StrokeText`)
- Full-viewport `100dvh` Alabaster Paper (`alabaster-paper`) opening veil drawing `SILHO` in Sumi Ink hairline strokes (`Inter` 500) followed by a left-to-right ink wipe and synchronized `1px` architectural hairline rule. Scale, stroke weight, tracking, and duration adapt across six screen profiles (compact mobile through ultrawide and short landscape) with a `44×44px` bottom-safe `Skip` control, `Escape` dismissal, and calm opacity-only `prefers-reduced-motion` path.

## Do's and Don'ts

### Do:
- **Do** preserve the shared 1px hairline catalog grid (`border-t border-l` on container, `border-r border-b` on tiles) and 2-column mobile grid on Closet and Lookbook.
- **Do** lead garment cards and archive strips with bold `tabular-nums` PHP cost-per-wear figures paired with `10px–11px` uppercase tracked spec labels.
- **Do** keep navigation, category filters, and Canvas studio modes on clean horizontal underline rails with a `2px` Sumi Ink active rule.
- **Do** keep primary actions, inputs, and navigation touch-accessible (`36px–44px` target heights, with compact `24px–32px` precision micro-controls reserved for dense studio toolbars) and apply safe-area padding on notched mobile viewports.

### Don't:
- **Don't** introduce chromatic accent colors, gradients, rounded pills, or soft box shadows onto cards, buttons, or badges.
- **Don't** duplicate status readouts (such as try-on quotas) across multiple headers on the same screen.
- **Don't** crowd garment image wells with 4-corner floating pills or eyebrow kickers above section headings.
- **Don't** regress Closet or Lookbook on mobile back to giant single-column stacked cards.
