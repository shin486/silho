# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Everyday wardrobe owners using desktop and mobile web browsers to organize the clothes they own, track daily outfits and spending, evaluate cost-per-wear, and plan what to wear.

## Product Purpose

SILHO is a personal digital wardrobe, cost-per-wear ledger, and virtual fit studio. It lets users catalog their garments as clean cutouts, log wears to see real value over time (and spot neglected pieces), and preview outfit combinations on themselves or on a layering canvas. Success means users consistently log wears, understand the true cost-per-wear of what they own, and assemble wearable outfits from their existing closet with minimal friction.

## Positioning

SILHO unites wardrobe financial tracking (cost-per-wear and dead-stock visibility) with virtual try-on and outfit composition inside a single workspace—connecting what a piece costs and how often it is worn directly to deciding how to style and wear it next.

## Operating Context

- **Primary routes & workflows:**
  - `/login` and `/register`: Account authentication (email/password via Better Auth) guarding personal wardrobe archives; `/` redirects to `/closet` when signed in or `/login` otherwise.
  - `/closet`: Personal wardrobe archive organized by category (`top`, `bottom`, `outerwear`, `shoes`, `accessory`), with client-side garment cutout creation (`@imgly/background-removal` + crop), single-click wear logging, portfolio value / wear count / average cost-per-wear metrics, sorting by cost-per-wear or wear frequency, and 90-day dead-stock indicators.
  - `/canvas`: Virtual Fit Studio combining four modes—AI Virtual Try-On (with Body Profile height/weight/preferred fit and Tailor Fit proportion controls), Camera Booth capture, interactive 2D Layer Board composition, and a saved Lookbook with one-click outfit wear logging.
- **Usage environments:** Both desktop browsers (extended cataloging, canvas composition, lookbook review) and mobile browsers (quick daily wear logging, garment photography, on-the-go outfit checks).

## Capabilities and Constraints

- **Confirmed capabilities:**
  - Personal wardrobe CRUD with transparent cutout generation performed client-side in the browser.
  - Cost-per-wear ledger (`calculateCostPerWear`, `getDaysSinceLastWorn`, 90-day `isDeadStock` threshold) formatted in Philippine Peso (`PHP` / `₱`, `en-PH`).
  - Multi-engine AI Virtual Try-On (`/api/tryon` supporting FASHN VTON 1.5, local FitDiT server, CatVTON, and WeShopAI fallbacks) with Tailor Fit garment reshaping and per-user daily try-on quota tracking (`tryon_usage`).
  - Offline-capable 2D Layer Board fallback when AI try-on servers are busy or daily quotas are reached.
  - Saved looks and outfit-level wear logging connected back to individual wardrobe items.
- **Confirmed constraints:**
  - Responsive web application targeting desktop and mobile browsers (including notched mobile viewports and touch inputs).
  - Currency is Philippine Peso (`PHP` / `₱`).
  - AI virtual try-on depends on external/GPU inference availability and daily usage quotas; flows must preserve graceful fallback to the Layer Board.
- **Undecided product facts (do not assume):**
  - Whether multi-currency support or international localization will be added later.
  - Whether SILHO will remain personal/invite-only or add public landing, billing, or social sharing surfaces.
  - Storage migration timeline for moving avatar/garment image URLs to external object storage (noted as a `TODO` in `src/db/schema.ts`).

## Brand Commitments

- **Product name:** `SILHO` (uppercase wordmark).
- **Binding restraint:** Minimalistic design identity explicitly requested by the owner; keep interfaces focused and uncluttered rather than adding social-feed noise or decorative bloat.

## Evidence on Hand

- **Working application & domain logic:** `src/app/` routes (`/`, `/login`, `/register`, `/closet`, `/canvas`, `/api/tryon`, `/api/auth/[...all]`), Drizzle schema in `src/db/schema.ts`, unit tests (`src/lib/utils/costPerWear.test.ts`, `src/lib/types/tailorFit.test.ts`), and preset try-on models (`src/lib/presetModels.ts`, `public/`).
- **Absences (do not fabricate):** No published customer testimonials, external press, public user counts, pricing tiers, or third-party benchmark claims exist in the repository.

## Product Principles

1. **Ledger meets studio:** Connect financial clarity (cost-per-wear, dead-stock signals) directly to outfit planning and try-on so insight turns into actual wear.
2. **Everyday speed across devices:** Routine actions—logging a wear, checking a piece, or opening the app on a phone—must stay fast and effortless on both touch and desktop screens.
3. **Resilient try-on experience:** When AI inference is slow, busy, or quota-limited, preserve momentum with transparent states and immediate access to the Layer Board.
4. **Quiet utility over noise:** Keep workflows centered on the user's own garments and decisions rather than gamification, feeds, or unnecessary ornament.
