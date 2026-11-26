"use client";

import { useMemo, useState } from "react";
import { ChevronDown, RotateCcw, SlidersHorizontal } from "lucide-react";
import type { WardrobeItemDTO } from "@/lib/closet";
import {
  BOXY_TOP_PRESET,
  computeTailorGeometry,
  formatTailorFitSummary,
  isDefaultTailorFit,
  needsAutoCleanMask,
  OUTERWEAR_STYLE_LABELS,
  sanitizeTailorFit,
  TAILOR_FIT_LIMITS,
  type BoxRect,
  type OuterwearStyle,
  type TailorFitConfig,
  type TailorGuideKind,
  type TryOnRenderMode,
  type TuckMode,
} from "@/lib/types/tailorFit";
import {
  useLayeredOuterwearPreview,
  useTrimmedGarment,
} from "@/lib/utils/trimGarmentClient";

interface TailorFitPanelProps {
  fit: TailorFitConfig;
  onChange: (next: TailorFitConfig) => void;
  onReset: () => void;
  hasUpper: boolean;
  hasLower: boolean;
  upperItem?: WardrobeItemDTO | null;
  outerwearItem?: WardrobeItemDTO | null;
  lowerItem?: WardrobeItemDTO | null;
  cleanSwap?: boolean;
  renderMode?: TryOnRenderMode;
  onChangeRenderMode?: (mode: TryOnRenderMode) => void;
  lastCompositeUrl?: string | null;
  lastEngine?: string | null;
  showMiniPreview?: boolean;
  disabled?: boolean;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  hideHeader?: boolean;
  hideOuterwearStyle?: boolean;
  onActiveGuideChange?: (guide: TailorGuideKind) => void;
}

const TOP_LENGTH_PRESETS: readonly {
  label: string;
  patch: Partial<TailorFitConfig>;
  isActive: (fit: TailorFitConfig) => boolean;
}[] = [
    {
      label: "Long",
      patch: { topCropPct: -10 },
      isActive: (f) => f.topCropPct === -10,
    },
    {
      label: "Regular",
      patch: { topCropPct: 0 },
      isActive: (f) => f.topCropPct === 0,
    },
    {
      label: "Boxy",
      patch: {
        topCropPct: BOXY_TOP_PRESET.topCropPct,
        topWidthScale: BOXY_TOP_PRESET.topWidthScale,
      },
      isActive: (f) =>
        f.topCropPct === BOXY_TOP_PRESET.topCropPct &&
        Math.abs(f.topWidthScale - BOXY_TOP_PRESET.topWidthScale) < 0.015,
    },
    {
      label: "Cropped",
      patch: { topCropPct: 24 },
      isActive: (f) => f.topCropPct === 24,
    },
  ];

const TOP_WIDTH_PRESETS = [
  { label: "Slim", value: 0.85 },
  { label: "Regular", value: 1.0 },
  { label: "Oversized", value: 1.2 },
] as const;

const BOTTOM_CROP_PRESETS = [
  { label: "Full", value: 0 },
  { label: "Ankle", value: 10 },
  { label: "Cropped", value: 18 },
] as const;

const BOTTOM_WIDTH_PRESETS = [
  { label: "Slim", value: 0.84 },
  { label: "Straight", value: 1.0 },
  { label: "Wide", value: 1.2 },
] as const;

const OUTERWEAR_STYLE_OPTIONS: readonly {
  id: OuterwearStyle;
  label: string;
  hint: string;
}[] = [
    {
      id: "open-front",
      label: "Open Front",
      hint: "Unzipped · exposes shirt front & hem",
    },
    {
      id: "collar-hem-peek",
      label: "Collar + Hem",
      hint: "Zipped · crewneck collar + hem peek",
    },
    {
      id: "collar-only",
      label: "Collar Only",
      hint: "Zipped · crewneck only (tucked waist)",
    },
  ];

function formatTopLengthValue(topCropPct: number): string {
  if (topCropPct < 0) return `+${Math.abs(topCropPct)}%`;
  if (topCropPct > 0) return `-${topCropPct}%`;
  return "0%";
}

function formatEngineBadgeLabel(engine?: string | null): string | null {
  if (!engine) return null;
  if (engine === "weshop") return "WeShopAI HD";
  if (engine === "fitdit-api") return "FitDiT HD";
  if (engine === "vton-api") return "FASHN GPU";
  if (engine === "fashn-vton-1.5") return "FASHN Space";
  if (engine === "catvton") return "CatVTON";
  return engine;
}

function PreviewCutLayer({
  src,
  alt,
  rect,
}: {
  src: string;
  alt: string;
  rect: BoxRect;
}) {
  const uncroppedHeightRatioPct =
    100 / Math.max(0.25, 1 - rect.cropBottomPct / 100);

  return (
    <div
      style={{
        left: `${rect.x * 100}%`,
        top: `${rect.y * 100}%`,
        width: `${rect.width * 100}%`,
        height: `${rect.height * 100}%`,
        zIndex: rect.zIndex,
      }}
      className="pointer-events-none absolute overflow-hidden"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          width: "100%",
          height: `${uncroppedHeightRatioPct}%`,
        }}
        className="block object-fill object-top mix-blend-multiply dark:mix-blend-normal"
      />
    </div>
  );
}

export function TailorFitPanel({
  fit,
  onChange,
  onReset,
  hasUpper,
  hasLower,
  upperItem,
  outerwearItem,
  lowerItem,
  cleanSwap = false,
  renderMode = "two-pass",
  onChangeRenderMode,
  lastCompositeUrl = null,
  lastEngine = null,
  showMiniPreview = false,
  disabled = false,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  hideHeader = false,
  hideOuterwearStyle = false,
  onActiveGuideChange,
}: TailorFitPanelProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] =
    useState(defaultExpanded);
  const expanded =
    controlledExpanded !== undefined
      ? controlledExpanded
      : uncontrolledExpanded;
  const setExpanded = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === "function" ? next(expanded) : next;
    if (controlledExpanded === undefined) {
      setUncontrolledExpanded(resolved);
    }
    onExpandedChange?.(resolved);
  };
  const [previewTab, setPreviewTab] = useState<"preview" | "ai-input">(
    "preview"
  );

  const hasLayeredOuterwear = Boolean(upperItem && outerwearItem);
  const suppressLayeredHemPeek = Boolean(lowerItem) && fit.tuckMode === "tucked";

  const upperTrim = useTrimmedGarment(
    showMiniPreview ? upperItem?.imageUrl : null
  );
  const outerwearTrim = useTrimmedGarment(
    showMiniPreview ? outerwearItem?.imageUrl : null
  );
  const layeredUpperPreview = useLayeredOuterwearPreview({
    topUrl: showMiniPreview && hasLayeredOuterwear ? upperItem?.imageUrl : null,
    outerwearUrl:
      showMiniPreview && hasLayeredOuterwear ? outerwearItem?.imageUrl : null,
    style: fit.outerwearStyle,
    suppressHemPeek: suppressLayeredHemPeek,
  });
  const lowerTrim = useTrimmedGarment(
    showMiniPreview ? lowerItem?.imageUrl : null
  );

  const isModified = !isDefaultTailorFit(fit);
  const autoCleanMaskActive = needsAutoCleanMask(fit, { hasUpper, hasLower });
  const showCleanMaskBadge = autoCleanMaskActive || cleanSwap;
  const summaryText = formatTailorFitSummary(fit, {
    hasUpper,
    hasLower,
    hasLayeredOuterwear,
  });
  const hasAnyPiece = hasUpper || hasLower;
  const hasBoth = hasUpper && hasLower;
  const hasMultiPiece = hasBoth;

  const activePreviewTab =
    previewTab === "ai-input" && lastCompositeUrl ? "ai-input" : "preview";

  const effectiveUpperAspect =
    hasLayeredOuterwear && layeredUpperPreview.ready
      ? layeredUpperPreview.aspect
      : upperTrim.aspect;

  const previewGeometry = useMemo(
    () =>
      computeTailorGeometry({
        hasUpper: Boolean(upperItem),
        hasLower: Boolean(lowerItem),
        upperAspect: effectiveUpperAspect,
        lowerAspect: lowerTrim.aspect,
        fit,
        mode: "preview",
      }),
    [upperItem, lowerItem, effectiveUpperAspect, lowerTrim.aspect, fit]
  );

  function updateFit(
    patch: Partial<TailorFitConfig>,
    guide?: TailorGuideKind
  ) {
    setPreviewTab("preview");
    onChange(sanitizeTailorFit({ ...fit, ...patch }));
    if (guide !== undefined) {
      onActiveGuideChange?.(guide);
    }
  }

  function handleTuckMode(mode: TuckMode) {
    updateFit({ tuckMode: mode }, "tuck");
  }

  const telemetryText = hasBoth
    ? `${fit.tuckMode === "tucked" ? "TUCKED IN" : "UNTUCKED"} · ${renderMode === "composite"
      ? "1-PASS COMPOSITE"
      : hasLayeredOuterwear
        ? `2-PASS · ${OUTERWEAR_STYLE_LABELS[fit.outerwearStyle].toUpperCase()}`
        : "2-PASS SEPARATE"
    }`
    : hasLayeredOuterwear
      ? `LAYERED · ${OUTERWEAR_STYLE_LABELS[fit.outerwearStyle].toUpperCase()}`
      : hasUpper
        ? "TOP · 1:1 TRIMMED"
        : "BOTTOM · 1:1 TRIMMED";

  if (hideHeader && !expanded) {
    return null;
  }

  return (
    <div
      className={
        hideHeader
          ? "mt-4 border-t border-[var(--border-hairline)] pt-4"
          : "mt-4 overflow-hidden rounded-[16px] border border-[var(--border-hairline)] bg-[var(--bg-well)]"
      }
    >
      {/* Compact Header Row (shown when standalone, e.g. Layer Board) */}
      {!hideHeader && (
        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
          >
            <span className="flex min-w-0 items-center gap-2">
              <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)]" />
              <span className="shrink-0 text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-primary)] uppercase">
                Tailor Fit
              </span>
              {isModified && summaryText && (
                <span className="truncate text-[10px] font-medium text-[var(--ink-muted)] tabular-nums">
                  · {summaryText}
                </span>
              )}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={`h-3.5 w-3.5 shrink-0 text-[var(--ink-muted)] transition-transform duration-150 ${expanded ? "rotate-180" : ""
                }`}
            />
          </button>

          {isModified && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setPreviewTab("preview");
                onReset();
                onActiveGuideChange?.(null);
              }}
              className="inline-flex h-6 shrink-0 items-center gap-1 text-[10px] font-semibold tracking-[0.12em] text-[var(--ink-muted)] uppercase transition-colors hover:text-[var(--ink-primary)] disabled:opacity-40"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              <span>Reset</span>
            </button>
          )}
        </div>
      )}

      {/* Collapsible Drawer */}
      {expanded && (
        <div
          className={
            hideHeader
              ? "space-y-4"
              : "space-y-4 border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-4"
          }
        >
          {hideHeader && isModified && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium tracking-[0.14em] text-[var(--ink-muted)] uppercase tabular-nums">
                {summaryText}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => {
                  setPreviewTab("preview");
                  onReset();
                  onActiveGuideChange?.(null);
                }}
                className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase transition-colors hover:text-[var(--ink-primary)] disabled:opacity-40"
              >
                <RotateCcw className="h-2.5 w-2.5" />
                <span>Reset Fit</span>
              </button>
            </div>
          )}

          {!hasAnyPiece ? (
            <p className="text-[12px] leading-relaxed text-[var(--ink-muted)]">
              Select an Upper or Lower garment to customize tuck, length, crop,
              and silhouette width.
            </p>
          ) : (
            <>
              {/* True 1:1 Trimmed 2:3 Live Cut Preview (AI Try-On Mode) */}
              {showMiniPreview && (upperItem || lowerItem) && (
                <div className="flex flex-col items-center rounded-[16px] bg-[var(--bg-well)] px-3.5 py-3.5">
                  <div className="mb-2.5 flex w-full flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[10px] font-medium tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Live Cut · 2:3
                    </span>

                    <div className="flex items-center gap-2.5">
                      {showCleanMaskBadge && (
                        <span
                          title={
                            cleanSwap
                              ? "Clean Swap enabled: masks out original clothes before draping"
                              : "Auto Clean-Mask active for strongly cropped/slim single-top renders"
                          }
                          className="text-[10px] font-medium tracking-[0.1em] text-[var(--ink-primary)] uppercase"
                        >
                          {cleanSwap ? "Clean-Mask" : "Auto Mask"}
                        </span>
                      )}

                      {lastCompositeUrl && (
                        <div
                          role="group"
                          aria-label="Toggle live preview or AI input sheet"
                          className="inline-flex items-center gap-2.5"
                        >
                          <button
                            type="button"
                            onClick={() => setPreviewTab("preview")}
                            className={`text-[10px] font-semibold tracking-[0.12em] uppercase transition-colors ${activePreviewTab === "preview"
                              ? "border-b border-[var(--ink-primary)] text-[var(--ink-primary)]"
                              : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                              }`}
                          >
                            Preview
                          </button>
                          <button
                            type="button"
                            onClick={() => setPreviewTab("ai-input")}
                            className={`text-[10px] font-semibold tracking-[0.12em] uppercase transition-colors ${activePreviewTab === "ai-input"
                              ? "border-b border-[var(--ink-primary)] text-[var(--ink-primary)]"
                              : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                              }`}
                          >
                            Input Sheet
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Exact 2:3 Reference Canvas matching backend sharp renderTailoredCanvas */}
                  <div className="relative aspect-[2/3] w-[156px] overflow-hidden rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-tile)]">
                    {activePreviewTab === "ai-input" && lastCompositeUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={lastCompositeUrl}
                          alt="Exact 576x864 flat-lay composite sent to AI Try-On"
                          draggable={false}
                          className="h-full w-full bg-white object-contain"
                        />
                        <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-[6px] bg-[#141415] px-2 py-0.5 text-[8px] font-medium tracking-[0.08em] text-white uppercase">
                          576×864 Sheet
                        </span>
                      </>
                    ) : (
                      <>
                        {hasLayeredOuterwear &&
                          layeredUpperPreview.ready &&
                          previewGeometry.upper ? (
                          <PreviewCutLayer
                            src={layeredUpperPreview.src}
                            alt={`${outerwearItem!.name} over ${upperItem!.name}`}
                            rect={previewGeometry.upper}
                          />
                        ) : (
                          <>
                            {upperItem && previewGeometry.upper && (
                              <PreviewCutLayer
                                src={upperTrim.src || upperItem.imageUrl}
                                alt={upperItem.name}
                                rect={previewGeometry.upper}
                              />
                            )}
                            {outerwearItem && previewGeometry.upper && (
                              <PreviewCutLayer
                                src={
                                  outerwearTrim.src || outerwearItem.imageUrl
                                }
                                alt={outerwearItem.name}
                                rect={{
                                  ...previewGeometry.upper,
                                  width: Math.min(
                                    0.94,
                                    previewGeometry.upper.width * 1.12
                                  ),
                                  x: Math.max(
                                    0.03,
                                    previewGeometry.upper.x -
                                    previewGeometry.upper.width * 0.06
                                  ),
                                  y: Math.max(
                                    0.02,
                                    previewGeometry.upper.y - 0.01
                                  ),
                                  height: Math.min(
                                    0.62,
                                    previewGeometry.upper.height * 1.05
                                  ),
                                  cropBottomPct: 0,
                                  zIndex: 26,
                                }}
                              />
                            )}
                          </>
                        )}
                        {lowerItem && previewGeometry.lower && (
                          <PreviewCutLayer
                            src={lowerTrim.src || lowerItem.imageUrl}
                            alt={lowerItem.name}
                            rect={previewGeometry.lower}
                          />
                        )}

                        {hasBoth &&
                          fit.tuckMode === "untucked" &&
                          previewGeometry.upper &&
                          previewGeometry.lower && (() => {
                            const sLeft = Math.max(
                              previewGeometry.upper.x,
                              previewGeometry.lower.x
                            );
                            const sRight = Math.min(
                              previewGeometry.upper.x + previewGeometry.upper.width,
                              previewGeometry.lower.x + previewGeometry.lower.width
                            );
                            const sWidth = Math.max(0, sRight - sLeft);
                            const sTop =
                              previewGeometry.upper.y + previewGeometry.upper.height;
                            if (sWidth <= 0) return null;
                            return (
                              <div
                                aria-hidden="true"
                                style={{
                                  left: `${sLeft * 100}%`,
                                  top: `${sTop * 100}%`,
                                  width: `${sWidth * 100}%`,
                                  height: "6px",
                                  zIndex: 15,
                                  background:
                                    "linear-gradient(to bottom, rgba(0,0,0,0.22), rgba(0,0,0,0))",
                                }}
                                className="pointer-events-none absolute"
                              />
                            );
                          })()}

                        {hasBoth && (
                          <div
                            aria-hidden="true"
                            style={{
                              top: `${previewGeometry.waistLineY * 100}%`,
                            }}
                            className="pointer-events-none absolute inset-x-0 z-30 -translate-y-1/2"
                          >
                            <div className="w-full border-t border-dashed border-[var(--ink-primary)]/35" />
                            <span className="absolute right-1 -top-3.5 bg-[var(--bg-tile)] px-1 text-[8px] font-medium tracking-[0.1em] text-[var(--ink-muted)] uppercase">
                              Waist
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2 text-[9px] font-medium tracking-[0.12em] text-[var(--ink-muted)] uppercase tabular-nums">
                    <span>{telemetryText}</span>
                    {formatEngineBadgeLabel(lastEngine) && (
                      <span className="text-[var(--ink-primary)]">
                        · {formatEngineBadgeLabel(lastEngine)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Outerwear Layering Style (when both Top + Outerwear are selected) */}
              {hasLayeredOuterwear && !hideOuterwearStyle && (
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Outerwear Layer
                    </span>
                    <span className="truncate text-[10px] text-[var(--ink-muted)]">
                      {
                        OUTERWEAR_STYLE_OPTIONS.find(
                          (o) => o.id === fit.outerwearStyle
                        )?.hint
                      }
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-label="Outerwear layering style"
                    className="grid grid-cols-3 rounded-[10px] bg-[var(--bg-well)] p-1"
                  >
                    {OUTERWEAR_STYLE_OPTIONS.map((option) => {
                      const active = fit.outerwearStyle === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            updateFit({ outerwearStyle: option.id })
                          }
                          className={`h-7 rounded-[8px] px-1 text-[10px] font-medium transition-colors duration-150 disabled:opacity-40 sm:text-[11px] ${active
                            ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                            : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                            }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Waist Style */}
              {hasBoth && (
                <div
                  className={
                    hasLayeredOuterwear && !hideOuterwearStyle
                      ? "border-t border-[var(--border-hairline)] pt-3.5"
                      : ""
                  }
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Waist Style
                    </span>
                    <span className="text-[10px] text-[var(--ink-muted)]">
                      {renderMode === "composite"
                        ? "1-Pass Composite"
                        : fit.tuckMode === "tucked"
                          ? hasLayeredOuterwear
                            ? "Layered Jacket → Bottoms"
                            : "Top → Bottoms pass"
                          : hasLayeredOuterwear
                            ? "Bottoms → Layered Jacket"
                            : "Bottoms → Top pass"}
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-label="Waist tuck style"
                    className="grid grid-cols-2 rounded-[10px] bg-[var(--bg-well)] p-1"
                  >
                    {(
                      [
                        { id: "untucked", label: "Untucked" },
                        { id: "tucked", label: "Tucked In" },
                      ] as const
                    ).map((option) => {
                      const active = fit.tuckMode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => handleTuckMode(option.id)}
                          className={`h-7 rounded-[8px] text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 ${active
                            ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                            : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                            }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top Cut Controls */}
              {hasUpper && (
                <div className="space-y-3 border-t border-[var(--border-hairline)] pt-3.5 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Top Cut
                    </span>
                    <span className="text-[10px] text-[var(--ink-muted)] tabular-nums">
                      {formatTopLengthValue(fit.topCropPct)} ·{" "}
                      {fit.topWidthScale.toFixed(2)}×
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] text-[var(--ink-secondary)]">
                        Top Length
                      </span>
                      <div className="flex items-center gap-3">
                        {TOP_LENGTH_PRESETS.map((preset) => {
                          const active = preset.isActive(fit);
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              disabled={disabled}
                              onClick={() => updateFit(preset.patch, "top-crop")}
                              className={`pb-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 disabled:opacity-40 ${active
                                ? "border-b-[1.5px] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        aria-label="Top length and crop percentage"
                        min={TAILOR_FIT_LIMITS.topCropPct.min}
                        max={TAILOR_FIT_LIMITS.topCropPct.max}
                        step={1}
                        disabled={disabled}
                        value={fit.topCropPct}
                        onPointerDown={() => onActiveGuideChange?.("top-crop")}
                        onChange={(e) =>
                          updateFit(
                            { topCropPct: Number(e.target.value) },
                            "top-crop"
                          )
                        }
                        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--border-hairline)] accent-[var(--ink-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {formatTopLengthValue(fit.topCropPct)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[var(--ink-secondary)]">
                        Top Width
                      </span>
                      <div className="flex items-center gap-3">
                        {TOP_WIDTH_PRESETS.map((preset) => {
                          const active =
                            Math.abs(fit.topWidthScale - preset.value) < 0.005;
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              disabled={disabled}
                              onClick={() =>
                                updateFit({ topWidthScale: preset.value })
                              }
                              className={`pb-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 disabled:opacity-40 ${active
                                ? "border-b-[1.5px] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        aria-label="Top width scale"
                        min={TAILOR_FIT_LIMITS.topWidthScale.min}
                        max={TAILOR_FIT_LIMITS.topWidthScale.max}
                        step={0.01}
                        disabled={disabled}
                        value={fit.topWidthScale}
                        onChange={(e) =>
                          updateFit({ topWidthScale: Number(e.target.value) })
                        }
                        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--border-hairline)] accent-[var(--ink-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {fit.topWidthScale.toFixed(2)}×
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Bottom Cut Controls */}
              {hasLower && (
                <div className="space-y-3 border-t border-[var(--border-hairline)] pt-3.5 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Bottom Cut
                    </span>
                    <span className="text-[10px] text-[var(--ink-muted)] tabular-nums">
                      {fit.bottomCropPct > 0 ? `-${fit.bottomCropPct}%` : "0%"}{" "}
                      · {fit.bottomWidthScale.toFixed(2)}×
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[var(--ink-secondary)]">
                        Hem Crop
                      </span>
                      <div className="flex items-center gap-3">
                        {BOTTOM_CROP_PRESETS.map((preset) => {
                          const active = fit.bottomCropPct === preset.value;
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              disabled={disabled}
                              onClick={() =>
                                updateFit(
                                  { bottomCropPct: preset.value },
                                  "bottom-crop"
                                )
                              }
                              className={`pb-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 disabled:opacity-40 ${active
                                ? "border-b-[1.5px] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        aria-label="Bottom hem crop percentage"
                        min={TAILOR_FIT_LIMITS.bottomCropPct.min}
                        max={TAILOR_FIT_LIMITS.bottomCropPct.max}
                        step={1}
                        disabled={disabled}
                        value={fit.bottomCropPct}
                        onPointerDown={() =>
                          onActiveGuideChange?.("bottom-crop")
                        }
                        onChange={(e) =>
                          updateFit(
                            { bottomCropPct: Number(e.target.value) },
                            "bottom-crop"
                          )
                        }
                        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--border-hairline)] accent-[var(--ink-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {fit.bottomCropPct > 0 ? `-${fit.bottomCropPct}%` : "0%"}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[var(--ink-secondary)]">
                        Leg Width
                      </span>
                      <div className="flex items-center gap-3">
                        {BOTTOM_WIDTH_PRESETS.map((preset) => {
                          const active =
                            Math.abs(fit.bottomWidthScale - preset.value) <
                            0.005;
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              disabled={disabled}
                              onClick={() =>
                                updateFit({ bottomWidthScale: preset.value })
                              }
                              className={`pb-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase transition-colors duration-150 disabled:opacity-40 ${active
                                ? "border-b-[1.5px] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        aria-label="Bottom leg width scale"
                        min={TAILOR_FIT_LIMITS.bottomWidthScale.min}
                        max={TAILOR_FIT_LIMITS.bottomWidthScale.max}
                        step={0.01}
                        disabled={disabled}
                        value={fit.bottomWidthScale}
                        onChange={(e) =>
                          updateFit({
                            bottomWidthScale: Number(e.target.value),
                          })
                        }
                        className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--border-hairline)] accent-[var(--ink-primary)] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-semibold text-[var(--ink-primary)] tabular-nums">
                        {fit.bottomWidthScale.toFixed(2)}×
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Engine Mode Switch */}
              {hasMultiPiece && onChangeRenderMode && (
                <div className="border-t border-[var(--border-hairline)] pt-3.5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Render Chain
                    </span>
                    <span className="text-[10px] text-[var(--ink-muted)]">
                      {renderMode === "two-pass"
                        ? hasLayeredOuterwear
                          ? "Bottoms + layered jacket/shirt"
                          : "Full-length trousers + tuck order"
                        : "Single pass (fast composite)"}
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-label="Try-On engine mode"
                    className="grid grid-cols-2 rounded-[10px] bg-[var(--bg-well)] p-1"
                  >
                    {(
                      [
                        {
                          id: "two-pass",
                          label: hasLayeredOuterwear
                            ? "2-Pass Layered"
                            : "2-Pass Separate",
                        },
                        { id: "composite", label: "1-Pass Composite" },
                      ] as const
                    ).map((option) => {
                      const active = renderMode === option.id;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          disabled={disabled}
                          onClick={() => onChangeRenderMode(option.id)}
                          className={`h-7 rounded-[8px] text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 ${active
                            ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                            : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                            }`}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
