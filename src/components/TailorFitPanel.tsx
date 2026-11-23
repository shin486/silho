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
        className="block object-fill object-top mix-blend-multiply"
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
  onActiveGuideChange,
}: TailorFitPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
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
    ? `${fit.tuckMode === "tucked" ? "TUCKED IN" : "UNTUCKED"} · ${
        renderMode === "composite"
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

  return (
    <div className="mt-3 border border-[#E2E0DA] bg-[#F9F8F6]">
      {/* Compact Header Row */}
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-[#4A4945]" />
            <span className="shrink-0 text-[11px] font-medium tracking-[0.04em] text-[#0E0E0E] uppercase">
              Tailor Fit
            </span>
            {isModified && summaryText && (
              <span className="truncate border border-[#E2E0DA] bg-white px-1.5 py-0.5 text-[10px] font-medium text-[#0E0E0E] tabular-nums">
                {summaryText}
              </span>
            )}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-[#4A4945] transition-transform duration-150 ${expanded ? "rotate-180" : ""
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
            className="inline-flex h-6 shrink-0 items-center gap-1 border border-[#E2E0DA] bg-white px-2 text-[10px] font-medium text-[#4A4945] transition-colors hover:border-[#0E0E0E] hover:text-[#0E0E0E] disabled:opacity-40"
          >
            <RotateCcw className="h-2.5 w-2.5" />
            <span>Reset</span>
          </button>
        )}
      </div>

      {/* Collapsible Drawer */}
      {expanded && (
        <div className="space-y-4 border-t border-[#E2E0DA] bg-white px-3.5 py-3.5">
          {!hasAnyPiece ? (
            <p className="text-[11px] leading-relaxed text-[#6C6A64]">
              Select an Upper or Lower garment to customize tuck, length, crop,
              and silhouette width.
            </p>
          ) : (
            <>
              {/* True 1:1 Trimmed 2:3 Live Cut Preview (AI Try-On Mode) */}
              {showMiniPreview && (upperItem || lowerItem) && (
                <div className="flex flex-col items-center border border-[#E2E0DA] bg-[#F9F8F6] px-3 py-3">
                  <div className="mb-2 flex w-full flex-wrap items-center justify-between gap-1.5">
                    <span className="text-[9px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Live Cut Preview · 2:3
                    </span>

                    <div className="flex items-center gap-1.5">
                      {showCleanMaskBadge && (
                        <span
                          title={
                            cleanSwap
                              ? "Clean Swap enabled: masks out original clothes before draping"
                              : "Auto Clean-Mask active for strongly cropped/slim single-top renders"
                          }
                          className="border border-[#0E0E0E]/20 bg-white px-1.5 py-0.5 text-[9px] font-medium text-[#0E0E0E]"
                        >
                          {cleanSwap ? "Clean-Mask ON" : "Auto Clean-Mask ON"}
                        </span>
                      )}

                      {lastCompositeUrl && (
                        <div
                          role="group"
                          aria-label="Toggle live preview or AI input sheet"
                          className="inline-flex border border-[#E2E0DA] bg-white"
                        >
                          <button
                            type="button"
                            onClick={() => setPreviewTab("preview")}
                            className={`px-1.5 py-0.5 text-[9px] font-medium transition-colors ${activePreviewTab === "preview"
                              ? "bg-[#0E0E0E] text-white"
                              : "text-[#4A4945] hover:text-[#0E0E0E]"
                              }`}
                          >
                            Preview
                          </button>
                          <button
                            type="button"
                            onClick={() => setPreviewTab("ai-input")}
                            className={`px-1.5 py-0.5 text-[9px] font-medium transition-colors ${activePreviewTab === "ai-input"
                              ? "bg-[#0E0E0E] text-white"
                              : "text-[#4A4945] hover:text-[#0E0E0E]"
                              }`}
                          >
                            AI Input
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Exact 2:3 Reference Canvas matching backend sharp renderTailoredCanvas */}
                  <div className="relative aspect-[2/3] w-[160px] overflow-hidden border border-[#E2E0DA] bg-[#F2F1ED]">
                    {activePreviewTab === "ai-input" && lastCompositeUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={lastCompositeUrl}
                          alt="Exact 576x864 flat-lay composite sent to AI Try-On"
                          draggable={false}
                          className="h-full w-full bg-white object-contain"
                        />
                        <span className="pointer-events-none absolute bottom-1.5 left-1/2 -translate-x-1/2 whitespace-nowrap border border-[#E2E0DA] bg-white/95 px-1.5 py-0.5 text-[8px] font-medium tracking-[0.06em] text-[#0E0E0E] uppercase">
                          Exact 576×864 AI Sheet
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
                            <div className="w-full border-t border-dashed border-[#0E0E0E]/30" />
                            <span className="absolute right-1 -top-3.5 bg-[#F2F1ED]/90 px-1 text-[8px] font-medium tracking-[0.08em] text-[#6C6A64] uppercase">
                              Waist
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5 text-[9px] font-medium tracking-[0.08em] text-[#4A4945] uppercase tabular-nums">
                    <span>{telemetryText}</span>
                    {formatEngineBadgeLabel(lastEngine) && (
                      <span
                        title={`Last render engine: ${formatEngineBadgeLabel(lastEngine)}`}
                        className="border border-[#E2E0DA] bg-white px-1.5 py-0.5 text-[8px] font-medium tracking-[0.06em] text-[#0E0E0E]"
                      >
                        {formatEngineBadgeLabel(lastEngine)}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Outerwear Layering Style (when both Top + Outerwear are selected) */}
              {hasLayeredOuterwear && (
                <div>
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Outerwear Layer
                    </span>
                    <span className="truncate text-[10px] text-[#4A4945]">
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
                    className="grid grid-cols-3 border border-[#E2E0DA] bg-[#F9F8F6] p-0.5"
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
                          className={`h-7 px-1 text-[10px] font-medium transition-colors disabled:opacity-40 sm:text-[11px] ${active
                            ? "bg-[#0E0E0E] text-white"
                            : "text-[#4A4945] hover:text-[#0E0E0E]"
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
                <div className={hasLayeredOuterwear ? "border-t border-[#E2E0DA] pt-3" : ""}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Waist Style
                    </span>
                    <span className="text-[10px] text-[#4A4945]">
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
                    className="grid grid-cols-2 border border-[#E2E0DA] bg-[#F9F8F6] p-0.5"
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
                          className={`h-7 text-[11px] font-medium transition-colors disabled:opacity-40 ${active
                            ? "bg-[#0E0E0E] text-white"
                            : "text-[#4A4945] hover:text-[#0E0E0E]"
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
                <div className="space-y-3 border-t border-[#E2E0DA] pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Top Cut
                    </span>
                    <span className="text-[10px] text-[#4A4945] tabular-nums">
                      {formatTopLengthValue(fit.topCropPct)} ·{" "}
                      {fit.topWidthScale.toFixed(2)}×
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="text-[11px] text-[#4A4945]">
                        Top Length
                      </span>
                      <div className="flex items-center gap-1">
                        {TOP_LENGTH_PRESETS.map((preset) => {
                          const active = preset.isActive(fit);
                          return (
                            <button
                              key={preset.label}
                              type="button"
                              disabled={disabled}
                              onClick={() => updateFit(preset.patch, "top-crop")}
                              className={`h-6 border px-2 text-[10px] font-medium transition-colors disabled:opacity-40 ${active
                                ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                                : "border-[#E2E0DA] bg-white text-[#4A4945] hover:border-[#0E0E0E] hover:text-[#0E0E0E]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
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
                        className="h-1 flex-1 cursor-pointer appearance-none bg-[#E2E0DA] accent-[#0E0E0E] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-medium text-[#0E0E0E] tabular-nums">
                        {formatTopLengthValue(fit.topCropPct)}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[#4A4945]">
                        Top Width
                      </span>
                      <div className="flex items-center gap-1">
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
                              className={`h-6 border px-2 text-[10px] font-medium transition-colors disabled:opacity-40 ${active
                                ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                                : "border-[#E2E0DA] bg-white text-[#4A4945] hover:border-[#0E0E0E] hover:text-[#0E0E0E]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
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
                        className="h-1 flex-1 cursor-pointer appearance-none bg-[#E2E0DA] accent-[#0E0E0E] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-medium text-[#0E0E0E] tabular-nums">
                        {fit.topWidthScale.toFixed(2)}×
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Bottom Cut Controls */}
              {hasLower && (
                <div className="space-y-3 border-t border-[#E2E0DA] pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Bottom Cut
                    </span>
                    <span className="text-[10px] text-[#4A4945] tabular-nums">
                      {fit.bottomCropPct > 0 ? `-${fit.bottomCropPct}%` : "0%"}{" "}
                      · {fit.bottomWidthScale.toFixed(2)}×
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[#4A4945]">
                        Hem Crop
                      </span>
                      <div className="flex items-center gap-1">
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
                              className={`h-6 border px-2 text-[10px] font-medium transition-colors disabled:opacity-40 ${active
                                ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                                : "border-[#E2E0DA] bg-white text-[#4A4945] hover:border-[#0E0E0E] hover:text-[#0E0E0E]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
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
                        className="h-1 flex-1 cursor-pointer appearance-none bg-[#E2E0DA] accent-[#0E0E0E] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-medium text-[#0E0E0E] tabular-nums">
                        {fit.bottomCropPct > 0 ? `-${fit.bottomCropPct}%` : "0%"}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-[#4A4945]">
                        Leg Width
                      </span>
                      <div className="flex items-center gap-1">
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
                              className={`h-6 border px-2 text-[10px] font-medium transition-colors disabled:opacity-40 ${active
                                ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                                : "border-[#E2E0DA] bg-white text-[#4A4945] hover:border-[#0E0E0E] hover:text-[#0E0E0E]"
                                }`}
                            >
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2.5">
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
                        className="h-1 flex-1 cursor-pointer appearance-none bg-[#E2E0DA] accent-[#0E0E0E] disabled:cursor-not-allowed disabled:opacity-40"
                      />
                      <span className="w-10 text-right text-[11px] font-medium text-[#0E0E0E] tabular-nums">
                        {fit.bottomWidthScale.toFixed(2)}×
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {/* Engine Mode Switch */}
              {hasMultiPiece && onChangeRenderMode && (
                <div className="border-t border-[#E2E0DA] pt-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Engine Mode
                    </span>
                    <span className="text-[10px] text-[#4A4945]">
                      {renderMode === "two-pass"
                        ? hasLayeredOuterwear
                          ? "Bottoms + unified layered jacket/shirt"
                          : "Full-length trousers + tuck order"
                        : "Single pass (fast composite)"}
                    </span>
                  </div>
                  <div
                    role="group"
                    aria-label="Try-On engine mode"
                    className="grid grid-cols-2 border border-[#E2E0DA] bg-[#F9F8F6] p-0.5"
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
                          className={`h-7 text-[11px] font-medium transition-colors disabled:opacity-40 ${active
                            ? "bg-[#0E0E0E] text-white"
                            : "text-[#4A4945] hover:text-[#0E0E0E]"
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
