"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Bookmark,
  Check,
  LayoutGrid,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Shuffle,
  X,
} from "lucide-react";
import { TailorFitPanel } from "@/components/TailorFitPanel";
import {
  CATEGORY_LABELS,
  type WardrobeCategory,
} from "@/lib/categories";
import type { WardrobeItemDTO } from "@/lib/closet";
import {
  computeTailorGeometry,
  type BoxRect,
  type TailorFitConfig,
} from "@/lib/types/tailorFit";
import { calculateCostPerWear, formatPeso } from "@/lib/utils/costPerWear";
import {
  trimGarmentImage,
  useTrimmedGarment,
} from "@/lib/utils/trimGarmentClient";

export type BoardSelection = Partial<Record<WardrobeCategory, string>>;

interface SlotTransform {
  /** For geometry-driven slots (top/bottom), dx & dy are drag offsets in % of board;
   *  for auxiliary slots (outerwear/shoes/accessory), x & y are absolute board %. */
  x: number;
  y: number;
  scale: number;
}

interface SlotPreset {
  x: number;
  y: number;
  baseHeightPct: number;
  zIndex: number;
}

interface LayerBoardProps {
  items: WardrobeItemDTO[];
  itemsById: Map<string, WardrobeItemDTO>;
  itemsByCategory: Record<WardrobeCategory, WardrobeItemDTO[]>;
  selectedBySlot: BoardSelection;
  onTogglePiece: (item: WardrobeItemDTO) => void;
  onClearSlot: (category: WardrobeCategory) => void;
  onClearAll: () => void;
  onShuffle: () => void;
  onSaveBoardLook: (payload: {
    imageUrl: string;
    label: string;
    itemId: string | null;
  }) => Promise<void>;
  boardFeedback: string | null;
  boardError: string | null;
  tailorFit: TailorFitConfig;
  onChangeTailorFit: (next: TailorFitConfig) => void;
  onResetTailorFit: () => void;
}

const SLOT_ORDER: WardrobeCategory[] = [
  "outerwear",
  "top",
  "bottom",
  "shoes",
  "accessory",
];

// Default positions for auxiliary slots; top & bottom are driven 1:1 by computeTailorGeometry
const AUX_SLOT_PRESETS: Record<WardrobeCategory, SlotPreset> = {
  top: { x: 0, y: 0, baseHeightPct: 40, zIndex: 20 },
  bottom: { x: 0, y: 0, baseHeightPct: 48, zIndex: 10 },
  shoes: { x: 50, y: 90, baseHeightPct: 18, zIndex: 8 },
  outerwear: { x: 22, y: 30, baseHeightPct: 38, zIndex: 25 },
  accessory: { x: 80, y: 32, baseHeightPct: 17, zIndex: 30 },
};

// Centered 2:3 reference column inside the 4:5 editorial board (width ratio = (2/3)/(4/5) = 5/6)
const BOARD_REF_COL_W_PCT = (2 / 3 / (4 / 5)) * 100; // 83.3333%
const BOARD_REF_COL_LEFT_PCT = (100 - BOARD_REF_COL_W_PCT) / 2; // 8.3333%

// Centered 2:3 reference column inside the 3:4 (768x1024) Save Look export canvas
const EXPORT_WIDTH = 768;
const EXPORT_HEIGHT = 1024;
const EXPORT_REF_COL_W = Math.round((EXPORT_HEIGHT * 2) / 3); // 683px
const EXPORT_REF_COL_LEFT = Math.round((EXPORT_WIDTH - EXPORT_REF_COL_W) / 2); // 43px

const PAPER_BG = "#F7F7F5";
const MIN_SCALE = 0.55;
const MAX_SCALE = 1.75;

function createInitialTransforms(): Record<WardrobeCategory, SlotTransform> {
  return {
    // Geometry-driven slots store drag offset (dx, dy) from their exact computeTailorGeometry anchor
    top: { x: 0, y: 0, scale: 1 },
    bottom: { x: 0, y: 0, scale: 1 },
    shoes: {
      x: AUX_SLOT_PRESETS.shoes.x,
      y: AUX_SLOT_PRESETS.shoes.y,
      scale: 1,
    },
    outerwear: {
      x: AUX_SLOT_PRESETS.outerwear.x,
      y: AUX_SLOT_PRESETS.outerwear.y,
      scale: 1,
    },
    accessory: {
      x: AUX_SLOT_PRESETS.accessory.x,
      y: AUX_SLOT_PRESETS.accessory.y,
      scale: 1,
    },
  };
}

function loadImageForExport(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (src.startsWith("http://") || src.startsWith("https://")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode garment image."));
    img.src = src;
  });
}

function isGeometrySlot(slot: WardrobeCategory): slot is "top" | "bottom" {
  return slot === "top" || slot === "bottom";
}

export function LayerBoard({
  itemsById,
  itemsByCategory,
  selectedBySlot,
  onTogglePiece,
  onClearSlot,
  onClearAll,
  onShuffle,
  onSaveBoardLook,
  boardFeedback,
  boardError,
  tailorFit,
  onChangeTailorFit,
  onResetTailorFit,
}: LayerBoardProps) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    slot: WardrobeCategory;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);

  const [activePickerSlot, setActivePickerSlot] =
    useState<WardrobeCategory>("top");
  const [selectedCanvasSlot, setSelectedCanvasSlot] =
    useState<WardrobeCategory | null>(null);
  const [transforms, setTransforms] = useState<
    Record<WardrobeCategory, SlotTransform>
  >(() => createInitialTransforms());

  const [isSavingLook, setIsSavingLook] = useState(false);
  const [justSavedLook, setJustSavedLook] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const topItem = selectedBySlot.top
    ? itemsById.get(selectedBySlot.top) ?? null
    : null;
  const bottomItem = selectedBySlot.bottom
    ? itemsById.get(selectedBySlot.bottom) ?? null
    : null;
  const hasTopOnBoard = Boolean(topItem);
  const hasBottomOnBoard = Boolean(bottomItem);
  const hasUpperOnBoard = Boolean(
    selectedBySlot.top || selectedBySlot.outerwear
  );

  // Use the exact same trimmed silhouettes & tight aspect ratios as Live Cut Preview & AI Try-On
  const topTrim = useTrimmedGarment(topItem?.imageUrl);
  const bottomTrim = useTrimmedGarment(bottomItem?.imageUrl);

  // Single Source of Truth geometry matching Live Cut Preview and AI Try-On 1:1
  const boardGeometry = useMemo(
    () =>
      computeTailorGeometry({
        hasUpper: hasTopOnBoard,
        hasLower: hasBottomOnBoard,
        upperAspect: topTrim.aspect,
        lowerAspect: bottomTrim.aspect,
        fit: tailorFit,
        mode: "preview",
      }),
    [hasTopOnBoard, hasBottomOnBoard, topTrim.aspect, bottomTrim.aspect, tailorFit]
  );

  const placedPieces = useMemo(() => {
    const entries: Array<{
      slot: WardrobeCategory;
      item: WardrobeItemDTO;
      preset: SlotPreset;
      transform: SlotTransform;
      geoRect?: BoxRect;
      effectiveZIndex: number;
      cropBottomPct: number;
      widthScale: number;
    }> = [];

    for (const slot of SLOT_ORDER) {
      const id = selectedBySlot[slot];
      const item = id ? itemsById.get(id) : undefined;
      if (!item) continue;

      const preset = AUX_SLOT_PRESETS[slot];
      const transform = transforms[slot];

      if (slot === "top" && boardGeometry.upper) {
        entries.push({
          slot,
          item,
          preset,
          transform,
          geoRect: boardGeometry.upper,
          effectiveZIndex: boardGeometry.upper.zIndex,
          cropBottomPct: boardGeometry.upper.cropBottomPct,
          widthScale: 1, // already baked into geoRect.width
        });
        continue;
      }

      if (slot === "bottom" && boardGeometry.lower) {
        entries.push({
          slot,
          item,
          preset,
          transform,
          geoRect: boardGeometry.lower,
          effectiveZIndex: boardGeometry.lower.zIndex,
          cropBottomPct: boardGeometry.lower.cropBottomPct,
          widthScale: 1, // already baked into geoRect.width
        });
        continue;
      }

      const applyUpperFitToOuterwear = slot === "outerwear" && !hasTopOnBoard;
      entries.push({
        slot,
        item,
        preset,
        transform,
        effectiveZIndex: preset.zIndex,
        cropBottomPct:
          applyUpperFitToOuterwear && tailorFit.topCropPct > 0
            ? tailorFit.topCropPct
            : 0,
        widthScale: applyUpperFitToOuterwear ? tailorFit.topWidthScale : 1,
      });
    }

    return entries.sort((a, b) => a.effectiveZIndex - b.effectiveZIndex);
  }, [
    selectedBySlot,
    itemsById,
    transforms,
    boardGeometry,
    tailorFit,
    hasTopOnBoard,
  ]);

  const fitValue = useMemo(
    () => placedPieces.reduce((sum, entry) => sum + entry.item.price, 0),
    [placedPieces]
  );

  const fitCostPerWear = useMemo(
    () =>
      placedPieces.reduce(
        (sum, entry) =>
          sum + calculateCostPerWear(entry.item.price, entry.item.wearCount),
        0
      ),
    [placedPieces]
  );

  const handleResetLayout = useCallback(() => {
    setTransforms(createInitialTransforms());
    setSelectedCanvasSlot(null);
  }, []);

  function adjustScale(slot: WardrobeCategory, delta: number) {
    setTransforms((prev) => {
      const current = prev[slot];
      const nextScale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.round((current.scale + delta) * 100) / 100)
      );
      return {
        ...prev,
        [slot]: { ...current, scale: nextScale },
      };
    });
  }

  function handlePiecePointerDown(
    slot: WardrobeCategory,
    event: ReactPointerEvent<HTMLDivElement>
  ) {
    if ((event.target as HTMLElement).closest("button")) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);

    setSelectedCanvasSlot(slot);
    dragStateRef.current = {
      slot,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      originX: transforms[slot].x,
      originY: transforms[slot].y,
    };
  }

  function handlePiecePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    const board = boardRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !board) return;

    const rect = board.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const dxPct = ((event.clientX - drag.startClientX) / rect.width) * 100;
    const dyPct = ((event.clientY - drag.startClientY) / rect.height) * 100;

    const isGeo = isGeometrySlot(drag.slot);
    const nextX = isGeo
      ? Math.min(45, Math.max(-45, drag.originX + dxPct))
      : Math.min(94, Math.max(6, drag.originX + dxPct));
    const nextY = isGeo
      ? Math.min(45, Math.max(-45, drag.originY + dyPct))
      : Math.min(94, Math.max(6, drag.originY + dyPct));

    setTransforms((prev) => ({
      ...prev,
      [drag.slot]: {
        ...prev[drag.slot],
        x: nextX,
        y: nextY,
      },
    }));
  }

  function handlePiecePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore if pointer capture already released
    }
    dragStateRef.current = null;
  }

  async function handleSaveLook() {
    if (placedPieces.length === 0 || isSavingLook) return;
    setExportError(null);
    setIsSavingLook(true);

    try {
      const canvas = document.createElement("canvas");
      canvas.width = EXPORT_WIDTH;
      canvas.height = EXPORT_HEIGHT;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Browser canvas unavailable.");

      ctx.fillStyle = PAPER_BG;
      ctx.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);

      // Trim top & bottom identically to live board / Live Cut Preview before decoding for export
      const loadedImages = new Map<string, HTMLImageElement>();
      const trimmedAspects = new Map<string, number>();
      await Promise.all(
        placedPieces.map(async (entry) => {
          if (entry.slot === "top" || entry.slot === "bottom") {
            const trimmed = await trimGarmentImage(entry.item.imageUrl);
            const img = await loadImageForExport(trimmed.dataUrl);
            loadedImages.set(entry.slot, img);
            trimmedAspects.set(entry.slot, trimmed.aspect);
          } else {
            const img = await loadImageForExport(entry.item.imageUrl);
            loadedImages.set(entry.slot, img);
          }
        })
      );

      const topImg = loadedImages.get("top");
      const bottomImg = loadedImages.get("bottom");
      const exportGeo = computeTailorGeometry({
        hasUpper: Boolean(topImg),
        hasLower: Boolean(bottomImg),
        upperAspect: trimmedAspects.get("top"),
        lowerAspect: trimmedAspects.get("bottom"),
        fit: tailorFit,
        mode: "preview",
      });

      // Composite each garment in exact z-order matching live board & Live Cut Preview
      for (const entry of placedPieces) {
        const img = loadedImages.get(entry.slot);
        if (!img) continue;

        ctx.save();
        ctx.globalCompositeOperation = "multiply";
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        if (entry.slot === "top" && exportGeo.upper) {
          const rect = exportGeo.upper;
          const keepRatio = Math.max(0.2, 1 - rect.cropBottomPct / 100);
          const srcH = Math.max(1, Math.round(img.naturalHeight * keepRatio));

          const baseW = rect.width * EXPORT_REF_COL_W * entry.transform.scale;
          const baseH = rect.height * EXPORT_HEIGHT * entry.transform.scale;
          const baseCenterX =
            EXPORT_REF_COL_LEFT +
            (rect.x + rect.width / 2) * EXPORT_REF_COL_W +
            (entry.transform.x / 100) * EXPORT_WIDTH;
          const baseTopY =
            rect.y * EXPORT_HEIGHT +
            (entry.transform.y / 100) * EXPORT_HEIGHT +
            (rect.height * EXPORT_HEIGHT * (1 - entry.transform.scale)) / 2;

          // Subtle untucked cast hem shadow across trousers directly below tee hem
          if (tailorFit.tuckMode === "untucked" && exportGeo.lower) {
            const bRect = exportGeo.lower;
            const bT = transforms.bottom;
            const bW = bRect.width * EXPORT_REF_COL_W * bT.scale;
            const bH = bRect.height * EXPORT_HEIGHT * bT.scale;
            const bCenterX =
              EXPORT_REF_COL_LEFT +
              (bRect.x + bRect.width / 2) * EXPORT_REF_COL_W +
              (bT.x / 100) * EXPORT_WIDTH;
            const bTopY =
              bRect.y * EXPORT_HEIGHT +
              (bT.y / 100) * EXPORT_HEIGHT +
              (bRect.height * EXPORT_HEIGHT * (1 - bT.scale)) / 2;

            const shadowTop = baseTopY + baseH;
            const sLeft = Math.max(baseCenterX - baseW / 2, bCenterX - bW / 2);
            const sRight = Math.min(baseCenterX + baseW / 2, bCenterX + bW / 2);
            if (
              sRight > sLeft &&
              shadowTop >= bTopY &&
              shadowTop <= bTopY + bH
            ) {
              ctx.save();
              ctx.globalCompositeOperation = "source-over";
              const grad = ctx.createLinearGradient(
                0,
                shadowTop,
                0,
                shadowTop + 10
              );
              grad.addColorStop(0, "rgba(0, 0, 0, 0.2)");
              grad.addColorStop(1, "rgba(0, 0, 0, 0)");
              ctx.fillStyle = grad;
              ctx.fillRect(sLeft, shadowTop, sRight - sLeft, 10);
              ctx.restore();
            }
          }

          ctx.drawImage(
            img,
            0,
            0,
            img.naturalWidth,
            srcH,
            baseCenterX - baseW / 2,
            baseTopY,
            baseW,
            baseH
          );
          ctx.restore();
          continue;
        }

        if (entry.slot === "bottom" && exportGeo.lower) {
          const rect = exportGeo.lower;
          const keepRatio = Math.max(0.2, 1 - rect.cropBottomPct / 100);
          const srcH = Math.max(1, Math.round(img.naturalHeight * keepRatio));

          const baseW = rect.width * EXPORT_REF_COL_W * entry.transform.scale;
          const baseH = rect.height * EXPORT_HEIGHT * entry.transform.scale;
          const baseCenterX =
            EXPORT_REF_COL_LEFT +
            (rect.x + rect.width / 2) * EXPORT_REF_COL_W +
            (entry.transform.x / 100) * EXPORT_WIDTH;
          const baseTopY =
            rect.y * EXPORT_HEIGHT +
            (entry.transform.y / 100) * EXPORT_HEIGHT +
            (rect.height * EXPORT_HEIGHT * (1 - entry.transform.scale)) / 2;

          ctx.drawImage(
            img,
            0,
            0,
            img.naturalWidth,
            srcH,
            baseCenterX - baseW / 2,
            baseTopY,
            baseW,
            baseH
          );
          ctx.restore();
          continue;
        }

        // Auxiliary slots (outerwear, shoes, accessory)
        const aspect =
          Math.max(1, img.naturalWidth) / Math.max(1, img.naturalHeight);
        const targetH =
          (EXPORT_HEIGHT * entry.preset.baseHeightPct * entry.transform.scale) /
          100;
        const maxW = EXPORT_WIDTH * 0.72 * entry.transform.scale;
        let drawH = targetH;
        let drawW = drawH * aspect;
        if (drawW > maxW) {
          drawW = maxW;
          drawH = drawW / Math.max(0.1, aspect);
        }

        const keepRatio = Math.max(0.2, 1 - entry.cropBottomPct / 100);
        const srcH = Math.max(1, Math.round(img.naturalHeight * keepRatio));
        const visibleDrawH = drawH * keepRatio;
        const scaledDrawW = drawW * entry.widthScale;

        const cx = (EXPORT_WIDTH * entry.transform.x) / 100;
        const cy = (EXPORT_HEIGHT * entry.transform.y) / 100;

        ctx.drawImage(
          img,
          0,
          0,
          img.naturalWidth,
          srcH,
          cx - scaledDrawW / 2,
          cy - drawH / 2,
          scaledDrawW,
          visibleDrawH
        );
        ctx.restore();
      }

      const imageUrl = canvas.toDataURL("image/jpeg", 0.9);
      const rawLabel = placedPieces
        .map((p) => p.item.name.trim())
        .filter(Boolean)
        .join(" + ");
      const label =
        rawLabel.length > 120
          ? `${rawLabel.slice(0, 117)}…`
          : rawLabel || "Layer Board Look";
      const primaryItemId =
        selectedBySlot.outerwear ??
        selectedBySlot.top ??
        selectedBySlot.bottom ??
        placedPieces[0]?.item.id ??
        null;

      await onSaveBoardLook({ imageUrl, label, itemId: primaryItemId });
      setJustSavedLook(true);
      window.setTimeout(() => setJustSavedLook(false), 1800);
    } catch (err) {
      console.error("[LayerBoard] Save Look export failed:", err);
      setExportError("Could not export this flat-lay look. Try again.");
    } finally {
      setIsSavingLook(false);
    }
  }

  const slotItems = itemsByCategory[activePickerSlot];

  return (
    <div className="grid grid-cols-1 border border-[#E2E0DA] bg-white lg:grid-cols-12">
      {/* Editorial Studio Flat-Lay Canvas */}
      <section className="flex flex-col border-b border-[#E2E0DA] bg-white lg:col-span-7 lg:border-r lg:border-b-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E0DA] px-5 py-3.5">
          <div className="flex items-baseline gap-3">
            <h1 className="text-[11px] font-semibold tracking-[0.14em] text-[#0E0E0E] uppercase">
              Layer Board
            </h1>
            <span className="text-[11px] text-[#6C6A64] tabular-nums">
              {placedPieces.length} / {SLOT_ORDER.length} slots
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={onShuffle}
              className="inline-flex h-8 items-center gap-1.5 border border-[#E2E0DA] bg-white px-2.5 text-[11px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E]"
            >
              <Shuffle className="h-3 w-3" />
              <span>Shuffle</span>
            </button>
            <button
              type="button"
              onClick={handleResetLayout}
              disabled={placedPieces.length === 0}
              className="inline-flex h-8 items-center gap-1.5 border border-[#E2E0DA] bg-white px-2.5 text-[11px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E] disabled:opacity-40"
            >
              <LayoutGrid className="h-3 w-3" />
              <span>Reset</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onClearAll();
                setSelectedCanvasSlot(null);
              }}
              disabled={placedPieces.length === 0}
              className="inline-flex h-8 items-center gap-1.5 border border-[#E2E0DA] bg-white px-2.5 text-[11px] text-[#4A4945] transition-colors hover:border-[#0E0E0E] hover:text-[#0E0E0E] disabled:opacity-40"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Clear</span>
            </button>
            <button
              type="button"
              onClick={() => void handleSaveLook()}
              disabled={placedPieces.length === 0 || isSavingLook}
              className="inline-flex h-8 items-center gap-1.5 border border-[#0E0E0E] bg-[#0E0E0E] px-3 text-[11px] font-medium text-white transition-colors hover:bg-[#2B2B29] disabled:opacity-40"
            >
              {isSavingLook ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : justSavedLook ? (
                <Check className="h-3 w-3" />
              ) : (
                <Bookmark className="h-3 w-3" />
              )}
              <span>{justSavedLook ? "Saved" : "Save Look"}</span>
            </button>
          </div>
        </div>

        {/* Fixed-Proportion Editorial Paper Surface */}
        <div className="flex flex-1 flex-col items-center justify-center bg-[#EAE8E3] p-4 sm:p-6">
          <div
            ref={boardRef}
            onPointerDown={() => setSelectedCanvasSlot(null)}
            className="relative aspect-[4/5] w-full max-w-[540px] select-none overflow-hidden border border-[#E2E0DA] bg-[#F7F7F5] sm:min-h-[520px]"
          >
            {placedPieces.length === 0 ? (
              <div className="flex h-full w-full flex-col items-center justify-center px-6 text-center">
                <p className="text-[15px] font-medium tracking-[-0.015em] text-[#0E0E0E]">
                  Compose an editorial flat-lay
                </p>
                <p className="mt-1.5 max-w-[30ch] text-[12px] leading-relaxed text-[#4A4945]">
                  Pick pieces from your wardrobe on the right, or press Shuffle.
                  Drag any garment to fine-tune overlap and scale.
                </p>
              </div>
            ) : (
              placedPieces.map(
                ({
                  slot,
                  item,
                  preset,
                  transform,
                  geoRect,
                  effectiveZIndex,
                  cropBottomPct,
                  widthScale,
                }) => {
                  const isSelected = selectedCanvasSlot === slot;

                  if (geoRect) {
                    const boxW =
                      geoRect.width * BOARD_REF_COL_W_PCT * transform.scale;
                    const boxH = geoRect.height * 100 * transform.scale;
                    const centerX =
                      BOARD_REF_COL_LEFT_PCT +
                      (geoRect.x + geoRect.width / 2) * BOARD_REF_COL_W_PCT +
                      transform.x;
                    const centerY =
                      (geoRect.y + geoRect.height / 2) * 100 + transform.y;
                    const uncroppedHeightRatioPct =
                      100 / Math.max(0.25, 1 - cropBottomPct / 100);

                    return (
                      <div
                        key={slot}
                        onPointerDown={(e) => handlePiecePointerDown(slot, e)}
                        onPointerMove={handlePiecePointerMove}
                        onPointerUp={handlePiecePointerUp}
                        onPointerCancel={handlePiecePointerUp}
                        style={{
                          left: `${centerX}%`,
                          top: `${centerY}%`,
                          width: `${boxW}%`,
                          height: `${boxH}%`,
                          zIndex: isSelected ? 40 : effectiveZIndex,
                        }}
                        className={`group absolute -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none active:cursor-grabbing ${
                          isSelected
                            ? "outline outline-1 outline-dashed outline-[#0E0E0E]/45 outline-offset-4"
                            : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-[#0E0E0E]/25 hover:outline-offset-4"
                        }`}
                      >
                        <div className="pointer-events-none h-full w-full overflow-hidden">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={
                              slot === "top"
                                ? topTrim.src || item.imageUrl
                                : bottomTrim.src || item.imageUrl
                            }
                            alt={item.name}
                            draggable={false}
                            style={{
                              width: "100%",
                              height: `${uncroppedHeightRatioPct}%`,
                            }}
                            className="block object-fill object-top mix-blend-multiply"
                          />
                        </div>

                        <div
                          className={`absolute -top-9 left-1/2 flex -translate-x-1/2 items-center border border-[#E2E0DA] bg-white/95 backdrop-blur-[2px] transition-opacity ${
                            isSelected
                              ? "opacity-100"
                              : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => adjustScale(slot, -0.1)}
                            aria-label={`Shrink ${item.name}`}
                            title="Decrease scale"
                            className="flex h-6 w-6 items-center justify-center text-[#4A4945] transition-colors hover:bg-[#F9F8F6] hover:text-[#0E0E0E]"
                          >
                            <Minus className="h-3 w-3" />
                          </button>
                          <span className="border-x border-[#E2E0DA] px-1.5 text-[10px] font-medium text-[#4A4945] tabular-nums">
                            {Math.round(transform.scale * 100)}%
                          </span>
                          <button
                            type="button"
                            onClick={() => adjustScale(slot, 0.1)}
                            aria-label={`Enlarge ${item.name}`}
                            title="Increase scale"
                            className="flex h-6 w-6 items-center justify-center text-[#4A4945] transition-colors hover:bg-[#F9F8F6] hover:text-[#0E0E0E]"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              onClearSlot(slot);
                              if (selectedCanvasSlot === slot) {
                                setSelectedCanvasSlot(null);
                              }
                            }}
                            aria-label={`Remove ${item.name} from board`}
                            title="Remove"
                            className="flex h-6 w-6 items-center justify-center border-l border-[#E2E0DA] text-[#4A4945] transition-colors hover:bg-[#0E0E0E] hover:text-white"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    );
                  }

                  const heightPct = preset.baseHeightPct * transform.scale;

                  return (
                    <div
                      key={slot}
                      onPointerDown={(e) => handlePiecePointerDown(slot, e)}
                      onPointerMove={handlePiecePointerMove}
                      onPointerUp={handlePiecePointerUp}
                      onPointerCancel={handlePiecePointerUp}
                      style={{
                        left: `${transform.x}%`,
                        top: `${transform.y}%`,
                        height: `${heightPct}%`,
                        zIndex: isSelected ? 40 : effectiveZIndex,
                      }}
                      className={`group absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none items-center justify-center active:cursor-grabbing ${
                        isSelected
                          ? "outline outline-1 outline-dashed outline-[#0E0E0E]/45 outline-offset-4"
                          : "hover:outline hover:outline-1 hover:outline-dashed hover:outline-[#0E0E0E]/25 hover:outline-offset-4"
                      }`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        draggable={false}
                        style={{
                          clipPath:
                            cropBottomPct > 0
                              ? `inset(0 0 ${cropBottomPct}% 0)`
                              : undefined,
                          transform:
                            Math.abs(widthScale - 1) > 0.001
                              ? `scaleX(${widthScale})`
                              : undefined,
                          transformOrigin: "center center",
                        }}
                        className="pointer-events-none h-full w-auto max-w-none object-contain mix-blend-multiply"
                      />

                      <div
                        className={`absolute -top-9 left-1/2 flex -translate-x-1/2 items-center border border-[#E2E0DA] bg-white/95 backdrop-blur-[2px] transition-opacity ${
                          isSelected
                            ? "opacity-100"
                            : "pointer-events-none opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => adjustScale(slot, -0.1)}
                          aria-label={`Shrink ${item.name}`}
                          title="Decrease scale"
                          className="flex h-6 w-6 items-center justify-center text-[#4A4945] transition-colors hover:bg-[#F9F8F6] hover:text-[#0E0E0E]"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="border-x border-[#E2E0DA] px-1.5 text-[10px] font-medium text-[#4A4945] tabular-nums">
                          {Math.round(transform.scale * 100)}%
                        </span>
                        <button
                          type="button"
                          onClick={() => adjustScale(slot, 0.1)}
                          aria-label={`Enlarge ${item.name}`}
                          title="Increase scale"
                          className="flex h-6 w-6 items-center justify-center text-[#4A4945] transition-colors hover:bg-[#F9F8F6] hover:text-[#0E0E0E]"
                        >
                          <Plus className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            onClearSlot(slot);
                            if (selectedCanvasSlot === slot) {
                              setSelectedCanvasSlot(null);
                            }
                          }}
                          aria-label={`Remove ${item.name} from board`}
                          title="Remove"
                          className="flex h-6 w-6 items-center justify-center border-l border-[#E2E0DA] text-[#4A4945] transition-colors hover:bg-[#0E0E0E] hover:text-white"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  );
                }
              )
            )}

            {/* Subtle Untucked Cast Hem Shadow across trousers on live Layer Board */}
            {tailorFit.tuckMode === "untucked" &&
              boardGeometry.upper &&
              boardGeometry.lower && (() => {
                const uRect = boardGeometry.upper;
                const bRect = boardGeometry.lower;
                const uT = transforms.top;
                const bT = transforms.bottom;

                const uW = uRect.width * BOARD_REF_COL_W_PCT * uT.scale;
                const uH = uRect.height * 100 * uT.scale;
                const uCx =
                  BOARD_REF_COL_LEFT_PCT +
                  (uRect.x + uRect.width / 2) * BOARD_REF_COL_W_PCT +
                  uT.x;
                const uCy = (uRect.y + uRect.height / 2) * 100 + uT.y;

                const bW = bRect.width * BOARD_REF_COL_W_PCT * bT.scale;
                const bH = bRect.height * 100 * bT.scale;
                const bCx =
                  BOARD_REF_COL_LEFT_PCT +
                  (bRect.x + bRect.width / 2) * BOARD_REF_COL_W_PCT +
                  bT.x;
                const bCy = (bRect.y + bRect.height / 2) * 100 + bT.y;

                const shadowTop = uCy + uH / 2;
                const sLeft = Math.max(uCx - uW / 2, bCx - bW / 2);
                const sRight = Math.min(uCx + uW / 2, bCx + bW / 2);

                if (
                  sRight <= sLeft ||
                  shadowTop < bCy - bH / 2 ||
                  shadowTop > bCy + bH / 2
                ) {
                  return null;
                }

                return (
                  <div
                    aria-hidden="true"
                    style={{
                      left: `${sLeft}%`,
                      top: `${shadowTop}%`,
                      width: `${sRight - sLeft}%`,
                      height: "8px",
                      zIndex: 15,
                      background:
                        "linear-gradient(to bottom, rgba(0,0,0,0.18), rgba(0,0,0,0))",
                    }}
                    className="pointer-events-none absolute"
                  />
                );
              })()}
          </div>

          {(boardFeedback || boardError || exportError) && (
            <div
              role={boardError || exportError ? "alert" : "status"}
              className={`mt-4 w-full max-w-[540px] border px-3.5 py-2.5 text-[12px] ${
                boardError || exportError
                  ? "border-[#D9B4B2] bg-[#FAF2F2] text-[#8C1D18]"
                  : "border-[#E2E0DA] bg-white text-[#0E0E0E]"
              }`}
            >
              {exportError || boardError || boardFeedback}
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 divide-x divide-[#E2E0DA] border-t border-[#E2E0DA] bg-white">
          <div className="px-5 py-4">
            <div className="text-[10px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
              Combined Value
            </div>
            <div className="mt-1 text-[18px] leading-none font-semibold tracking-[-0.025em] text-[#0E0E0E] tabular-nums sm:text-[20px]">
              {formatPeso(fitValue)}
            </div>
          </div>
          <div className="px-5 py-4">
            <div className="text-[10px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
              Combined Cost / Wear
            </div>
            <div className="mt-1 text-[18px] leading-none font-semibold tracking-[-0.025em] text-[#0E0E0E] tabular-nums sm:text-[20px]">
              {formatPeso(fitCostPerWear)}
            </div>
          </div>
        </div>
      </section>

      {/* Right Wardrobe Selector */}
      <section className="flex flex-col bg-white lg:col-span-5">
        <div className="border-b border-[#E2E0DA] px-5 pt-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[11px] font-semibold tracking-[0.14em] text-[#0E0E0E] uppercase">
              Wardrobe Pieces
            </h2>
            <span className="text-[11px] text-[#6C6A64]">
              Drag pieces on canvas
            </span>
          </div>

          <TailorFitPanel
            fit={tailorFit}
            onChange={onChangeTailorFit}
            onReset={onResetTailorFit}
            hasUpper={hasUpperOnBoard}
            hasLower={hasBottomOnBoard}
            showMiniPreview={false}
            defaultExpanded={false}
          />

          <div
            role="tablist"
            aria-label="Filter layer board slots"
            className="no-scrollbar mt-3 flex items-stretch gap-5 overflow-x-auto border-t border-[#E2E0DA]"
          >
            {SLOT_ORDER.map((category) => {
              const isActive = activePickerSlot === category;
              const hasSelected = Boolean(selectedBySlot[category]);
              return (
                <button
                  key={category}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActivePickerSlot(category)}
                  className={`relative inline-flex h-10 shrink-0 items-center gap-1.5 text-[12px] tracking-[0.02em] transition-colors ${
                    isActive
                      ? "font-medium text-[#0E0E0E]"
                      : "text-[#6C6A64] hover:text-[#0E0E0E]"
                  }`}
                >
                  <span>{CATEGORY_LABELS[category]}</span>
                  <span
                    className={`text-[11px] tabular-nums ${
                      isActive ? "text-[#0E0E0E]" : "text-[#6C6A64]"
                    }`}
                  >
                    {itemsByCategory[category].length}
                  </span>
                  {hasSelected && (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 bg-[#0E0E0E]"
                    />
                  )}
                  {isActive && (
                    <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {slotItems.length === 0 ? (
            <p className="py-12 text-center text-[13px] text-[#6C6A64]">
              No {CATEGORY_LABELS[activePickerSlot].toLowerCase()} pieces in
              your closet yet.
            </p>
          ) : (
            <div className="grid grid-cols-2 border-t border-l border-[#E2E0DA]">
              {slotItems.map((item) => {
                const isSelected = selectedBySlot[item.category] === item.id;
                const cpw = calculateCostPerWear(item.price, item.wearCount);
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onTogglePiece(item)}
                    className="group relative flex flex-col border-r border-b border-[#E2E0DA] bg-white text-left transition-colors hover:bg-[#F9F8F6]"
                  >
                    {isSelected && (
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0 z-10 border-[1.5px] border-[#0E0E0E]"
                      />
                    )}
                    <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-[#F2F1ED] p-3.5">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.imageUrl}
                        alt={item.name}
                        className="max-h-full max-w-full object-contain mix-blend-multiply transition-transform duration-300 ease-out group-hover:scale-[1.04]"
                      />
                      {isSelected && (
                        <span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center bg-[#0E0E0E] text-white">
                          <Check className="h-3 w-3" />
                        </span>
                      )}
                    </div>
                    <div className="border-t border-[#E2E0DA] p-2.5 sm:p-3">
                      <div className="truncate text-[12px] font-medium text-[#0E0E0E]">
                        {item.name}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#6C6A64] tabular-nums">
                        {item.price > 0
                          ? `${formatPeso(cpw)}/wear`
                          : `${item.wearCount} ${
                              item.wearCount === 1 ? "wear" : "wears"
                            }`}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
