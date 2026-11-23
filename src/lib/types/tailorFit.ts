export type TuckMode = "untucked" | "tucked";

export type OuterwearStyle = "open-front" | "collar-hem-peek" | "collar-only";

export type TryOnRenderMode = "composite" | "two-pass";

export type TailorGuideKind = "top-crop" | "bottom-crop" | "tuck" | null;

export interface TailorFitConfig {
  tuckMode: TuckMode;
  outerwearStyle: OuterwearStyle;
  topCropPct: number; // -12 (Long) to 30 (Cropped), default 0
  topWidthScale: number; // 0.80 to 1.25 (default 1.0)
  bottomCropPct: number; // 0 to 22 (default 0)
  bottomWidthScale: number; // 0.80 to 1.25 (default 1.0)
}

/**
 * Normalized 0..1 layout rectangle on the canonical 576x864 (2:3) reference canvas.
 */
export interface BoxRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Positive percentage cropped from the bottom hem (0 when Regular or Long). */
  cropBottomPct: number;
  zIndex: number;
}

export interface TailorGeometryResult {
  upper?: BoxRect;
  lower?: BoxRect;
  waistLineY: number;
  topHemY?: number;
  bottomHemY?: number;
}

export const TAILOR_FIT_LIMITS = {
  topCropPct: { min: -12, max: 30 },
  topWidthScale: { min: 0.8, max: 1.25 },
  bottomCropPct: { min: 0, max: 22 },
  bottomWidthScale: { min: 0.8, max: 1.25 },
} as const;

export const DEFAULT_TAILOR_FIT: TailorFitConfig = {
  tuckMode: "untucked",
  outerwearStyle: "open-front",
  topCropPct: 0,
  topWidthScale: 1.0,
  bottomCropPct: 0,
  bottomWidthScale: 1.0,
};

/**
 * True Heavyweight Boxy Drop-Shoulder preset (modeled on Elwood Core Boxy,
 * Rue Porter Ultraweight, LA Apparel 1801GD, COS 290gsm): waist-skimming hem
 * paired with wide dropped shoulders (~1.22x) and straight untapered side seams.
 */
export const BOXY_TOP_PRESET = {
  topCropPct: 10,
  topWidthScale: 1.22,
} as const;

const WAIST_LINE_Y = 0.45;
/** Minimum untucked overlap below waistLineY so trouser belt loops stay covered and FASHN doesn't auto-tuck. */
export const MIN_UNTUCKED_WAIST_OVERLAP = 0.012;
const CANVAS_ASPECT_INV = 3 / 2; // 864 / 576

function clampRange(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  decimals: number
): number {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  const clamped = clampRange(numeric, min, max);
  const factor = Math.pow(10, decimals);
  return Math.round(clamped * factor) / factor;
}

function sanitizeOuterwearStyle(raw: unknown): OuterwearStyle {
  if (raw === "collar-hem-peek" || raw === "collar-only" || raw === "open-front") {
    return raw;
  }
  return DEFAULT_TAILOR_FIT.outerwearStyle;
}

export function sanitizeTailorFit(input?: unknown): TailorFitConfig {
  if (!input || typeof input !== "object") {
    return { ...DEFAULT_TAILOR_FIT };
  }

  const raw = input as Partial<Record<keyof TailorFitConfig, unknown>>;

  return {
    tuckMode: raw.tuckMode === "tucked" ? "tucked" : "untucked",
    outerwearStyle: sanitizeOuterwearStyle(raw.outerwearStyle),
    topCropPct: clampNumber(
      raw.topCropPct,
      DEFAULT_TAILOR_FIT.topCropPct,
      TAILOR_FIT_LIMITS.topCropPct.min,
      TAILOR_FIT_LIMITS.topCropPct.max,
      0
    ),
    topWidthScale: clampNumber(
      raw.topWidthScale,
      DEFAULT_TAILOR_FIT.topWidthScale,
      TAILOR_FIT_LIMITS.topWidthScale.min,
      TAILOR_FIT_LIMITS.topWidthScale.max,
      2
    ),
    bottomCropPct: clampNumber(
      raw.bottomCropPct,
      DEFAULT_TAILOR_FIT.bottomCropPct,
      TAILOR_FIT_LIMITS.bottomCropPct.min,
      TAILOR_FIT_LIMITS.bottomCropPct.max,
      0
    ),
    bottomWidthScale: clampNumber(
      raw.bottomWidthScale,
      DEFAULT_TAILOR_FIT.bottomWidthScale,
      TAILOR_FIT_LIMITS.bottomWidthScale.min,
      TAILOR_FIT_LIMITS.bottomWidthScale.max,
      2
    ),
  };
}

export function isDefaultTailorFit(fit: TailorFitConfig): boolean {
  return (
    fit.tuckMode === DEFAULT_TAILOR_FIT.tuckMode &&
    fit.outerwearStyle === DEFAULT_TAILOR_FIT.outerwearStyle &&
    fit.topCropPct === DEFAULT_TAILOR_FIT.topCropPct &&
    Math.abs(fit.topWidthScale - DEFAULT_TAILOR_FIT.topWidthScale) < 0.001 &&
    fit.bottomCropPct === DEFAULT_TAILOR_FIT.bottomCropPct &&
    Math.abs(fit.bottomWidthScale - DEFAULT_TAILOR_FIT.bottomWidthScale) < 0.001
  );
}

/**
 * Returns true ONLY on single-pass `tops`-only renders when strong cropping or
 * slimming is active (`topCropPct >= 18 || topWidthScale <= 0.88`).
 * Never auto-forces `segmentation_free = false` on full-outfit (`one-pieces`)
 * or `bottoms` renders, because masking clips full-length trousers to the user's
 * original shorts.
 */
export function needsAutoCleanMask(
  fit: TailorFitConfig,
  options?: { hasUpper?: boolean; hasLower?: boolean }
): boolean {
  const hasUpper = options?.hasUpper ?? true;
  const hasLower = options?.hasLower ?? false;
  if (!hasUpper || hasLower) {
    return false;
  }
  return fit.topCropPct >= 18 || fit.topWidthScale <= 0.88;
}

/**
 * Computes untucked full-outfit topHemY anchored to waistLineY = 0.45 so the trouser
 * beltline is never fully exposed (preventing FASHN from misinterpreting untucked Boxy/Cropped as tucked-in):
 *   - Long (-10%)    -> ~0.56 (well below waistband/fly)
 *   - Regular (0%)   -> ~0.51 (cleanly covers waistband & upper fly)
 *   - Boxy (10-14%)  -> ~0.48 (waist-skimming, still hides top waistband & belt loops)
 *   - Cropped (24%+) -> ~0.462 (ultra-short right over top edge of waistband, never above waistLineY + 0.012)
 */
function computeUntuckedTopHemY(topCropPct: number, isAi: boolean): number {
  const minHemY = WAIST_LINE_Y + MIN_UNTUCKED_WAIST_OVERLAP; // 0.462
  const regularHemY = 0.51;

  if (topCropPct < 0) {
    const gain = isAi ? 1.1 : 1.0;
    const extraDrop = (Math.abs(topCropPct) / 10) * 0.05 * gain;
    return clampRange(regularHemY + extraDrop, regularHemY, 0.585);
  }

  // Smooth strictly monotonic two-segment curve from 0% -> 12% (0.51 -> 0.48) -> 24..30% (0.48 -> 0.462)
  const effPct = isAi ? Math.min(30, topCropPct * 1.12) : topCropPct;
  let hemY: number;
  if (effPct <= 12) {
    hemY = regularHemY - (effPct / 12) * 0.03; // 0% -> 0.51, 10% -> 0.485, 12% -> 0.48
  } else {
    // 12% -> 0.48, 24% -> 0.4665 (preview) / 0.4624 (ai), 30% -> 0.462 floor
    hemY = 0.48 - ((effPct - 12) / 16) * 0.018;
  }

  return Math.max(minHemY, hemY);
}

/**
 * Single Source of Truth anatomical geometry engine on the canonical 2:3 (576x864) frame.
 * Shared across Live Cut Preview, Layer Board, Save Look export, and backend sharp compositor.
 */
export function computeTailorGeometry(params: {
  hasUpper: boolean;
  hasLower: boolean;
  upperAspect?: number;
  lowerAspect?: number;
  fit: TailorFitConfig;
  mode: "preview" | "ai";
}): TailorGeometryResult {
  const safeFit = sanitizeTailorFit(params.fit);
  const isAi = params.mode === "ai";

  // Calibrated AI curve: amplifies geometric deltas cleanly while keeping preview 1:1
  const effTopCropSingle = isAi
    ? clampRange(safeFit.topCropPct * 1.25, -15, 38)
    : safeFit.topCropPct;
  const effTopWidth = isAi
    ? clampRange(1 + (safeFit.topWidthScale - 1) * 1.45, 0.74, 1.38)
    : safeFit.topWidthScale;
  const effBottomCrop = isAi
    ? clampRange(safeFit.bottomCropPct * 1.35, 0, 30)
    : safeFit.bottomCropPct;
  const effBottomWidth = isAi
    ? clampRange(1 + (safeFit.bottomWidthScale - 1) * 1.5, 0.72, 1.35)
    : safeFit.bottomWidthScale;

  const upperAspect =
    typeof params.upperAspect === "number" &&
    Number.isFinite(params.upperAspect) &&
    params.upperAspect > 0
      ? clampRange(params.upperAspect, 0.35, 1.8)
      : 0.85;
  const lowerAspect =
    typeof params.lowerAspect === "number" &&
    Number.isFinite(params.lowerAspect) &&
    params.lowerAspect > 0
      ? clampRange(params.lowerAspect, 0.25, 1.4)
      : 0.52;

  const waistLineY = WAIST_LINE_Y;
  let upper: BoxRect | undefined;
  let lower: BoxRect | undefined;
  let topHemY: number | undefined;
  let bottomHemY: number | undefined;

  if (params.hasUpper && params.hasLower) {
    const isTucked = safeFit.tuckMode === "tucked";
    const baseUpperH = 0.4; // Regular top spans 0.11 -> 0.51
    const topY = isTucked ? 0.125 : 0.11;

    const upperBaseW = clampRange(
      baseUpperH * upperAspect * CANVAS_ASPECT_INV,
      0.28,
      0.58
    );
    const upperWidth = clampRange(upperBaseW * effTopWidth, 0.16, 0.94);

    let upperHeight: number;
    let upperCropBottomPct: number;

    if (!isTucked) {
      // Untucked: guarantee waistband coverage (>= waistLineY + 0.012) across Long/Regular/Boxy/Cropped
      const targetHemY = computeUntuckedTopHemY(safeFit.topCropPct, isAi);
      upperHeight = Math.max(0.2, targetHemY - topY);
      upperCropBottomPct =
        safeFit.topCropPct > 0
          ? clampRange((1 - upperHeight / baseUpperH) * 100, 0, 30)
          : 0;
    } else {
      // Tucked: tee sits behind trouser waistband (lower.zIndex > upper.zIndex) with guaranteed no-gap overlap
      const effTuckCrop = isAi
        ? clampRange(safeFit.topCropPct * 1.25, -15, 38)
        : safeFit.topCropPct;
      if (effTuckCrop < 0) {
        upperCropBottomPct = 0;
        upperHeight = baseUpperH * (1 + Math.abs(effTuckCrop) / 100);
      } else {
        upperCropBottomPct = effTuckCrop;
        upperHeight = baseUpperH * (1 - effTuckCrop / 100);
      }
      const minTuckedH = waistLineY + 0.03 - topY;
      if (upperHeight < minTuckedH) {
        upperHeight = minTuckedH;
        upperCropBottomPct = Math.max(0, (1 - minTuckedH / baseUpperH) * 100);
      }
    }

    upper = {
      x: 0.5 - upperWidth / 2,
      y: topY,
      width: upperWidth,
      height: upperHeight,
      cropBottomPct: upperCropBottomPct,
      zIndex: isTucked ? 10 : 20,
    };
    topHemY = upper.y + upper.height;

    // Lower Slot pinned at waistLineY = 0.45 (runs to 0.92 at 0% crop)
    const baseLowerH = 0.47;
    const bottomY = waistLineY;
    const lowerBaseW = clampRange(
      baseLowerH * lowerAspect * CANVAS_ASPECT_INV,
      0.22,
      0.48
    );
    const lowerWidth = clampRange(lowerBaseW * effBottomWidth, 0.14, 0.9);
    const lowerHeight = baseLowerH * (1 - effBottomCrop / 100);

    lower = {
      x: 0.5 - lowerWidth / 2,
      y: bottomY,
      width: lowerWidth,
      height: lowerHeight,
      cropBottomPct: effBottomCrop,
      zIndex: isTucked ? 20 : 10,
    };
    bottomHemY = lower.y + lower.height;
  } else if (params.hasUpper) {
    // Single Upper Slot (2-Pass Separate / top-only): high-resolution studio fill from fixed shoulder anchor
    const baseUpperH = 0.66;
    const topY = 0.14;
    const upperBaseW = clampRange(
      baseUpperH * upperAspect * CANVAS_ASPECT_INV,
      0.38,
      0.74
    );
    const upperWidth = clampRange(upperBaseW * effTopWidth, 0.2, 0.94);
    const upperCropBottomPct = effTopCropSingle > 0 ? effTopCropSingle : 0;
    const upperHeight =
      effTopCropSingle < 0
        ? baseUpperH * (1 + Math.abs(effTopCropSingle) / 100)
        : baseUpperH * (1 - effTopCropSingle / 100);

    upper = {
      x: 0.5 - upperWidth / 2,
      y: topY,
      width: upperWidth,
      height: upperHeight,
      cropBottomPct: upperCropBottomPct,
      zIndex: 20,
    };
    topHemY = upper.y + upper.height;
  } else if (params.hasLower) {
    // Single Lower Slot (2-Pass Separate / bottom-only): high-resolution studio fill so pleats & weave stay sharp
    const baseLowerH = 0.82;
    const bottomY = 0.09;
    const lowerBaseW = clampRange(
      baseLowerH * lowerAspect * CANVAS_ASPECT_INV,
      0.34,
      0.68
    );
    const lowerWidth = clampRange(lowerBaseW * effBottomWidth, 0.18, 0.92);
    const lowerHeight = baseLowerH * (1 - effBottomCrop / 100);

    lower = {
      x: 0.5 - lowerWidth / 2,
      y: bottomY,
      width: lowerWidth,
      height: lowerHeight,
      cropBottomPct: effBottomCrop,
      zIndex: 10,
    };
    bottomHemY = lower.y + lower.height;
  }

  return {
    upper,
    lower,
    waistLineY,
    topHemY,
    bottomHemY,
  };
}

export const OUTERWEAR_STYLE_LABELS: Record<OuterwearStyle, string> = {
  "open-front": "Open Front",
  "collar-hem-peek": "Collar + Hem",
  "collar-only": "Collar Only",
};

export function formatTailorFitSummary(
  fit: TailorFitConfig,
  options?: {
    hasUpper?: boolean;
    hasLower?: boolean;
    hasLayeredOuterwear?: boolean;
  }
): string {
  const showUpper = options?.hasUpper ?? true;
  const showLower = options?.hasLower ?? true;
  const parts: string[] = [];

  if (options?.hasLayeredOuterwear) {
    parts.push(OUTERWEAR_STYLE_LABELS[fit.outerwearStyle]);
  }

  if (fit.tuckMode === "tucked" && showUpper && showLower) {
    parts.push("Tucked");
  }

  if (showUpper) {
    if (fit.topCropPct < 0) {
      parts.push(`Top +${Math.abs(fit.topCropPct)}%`);
    } else if (fit.topCropPct > 0) {
      parts.push(`Top -${fit.topCropPct}%`);
    }
    if (fit.topWidthScale >= 1.15 && fit.topCropPct >= 8) {
      parts.push("Boxy Top");
    } else if (fit.topWidthScale >= 1.1) {
      parts.push("Oversized Top");
    } else if (fit.topWidthScale <= 0.92) {
      parts.push("Slim Top");
    } else if (Math.abs(fit.topWidthScale - 1) >= 0.01) {
      parts.push(`Top ${fit.topWidthScale.toFixed(2)}×`);
    }
  }

  if (showLower) {
    if (fit.bottomCropPct > 0) {
      parts.push(`Hem -${fit.bottomCropPct}%`);
    }
    if (fit.bottomWidthScale >= 1.1) {
      parts.push("Wide Bottom");
    } else if (fit.bottomWidthScale <= 0.92) {
      parts.push("Slim Bottom");
    } else if (Math.abs(fit.bottomWidthScale - 1) >= 0.01) {
      parts.push(`Leg ${fit.bottomWidthScale.toFixed(2)}×`);
    }
  }

  if (parts.length === 0 && !isDefaultTailorFit(fit)) {
    if (fit.tuckMode === "tucked") parts.push("Tucked");
    if (fit.topCropPct < 0) parts.push(`Top +${Math.abs(fit.topCropPct)}%`);
    else if (fit.topCropPct > 0) parts.push(`Top -${fit.topCropPct}%`);
    if (fit.bottomCropPct > 0) parts.push(`Hem -${fit.bottomCropPct}%`);
  }

  return parts.join(" · ");
}
