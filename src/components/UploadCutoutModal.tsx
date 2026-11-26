"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  Eraser,
  FlipHorizontal2,
  ImagePlus,
  Loader2,
  Paintbrush,
  RefreshCw,
  RotateCcw,
  Scissors,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { addWardrobeItem } from "@/app/closet/actions";
import {
  CATEGORY_LABELS,
  WARDROBE_CATEGORIES,
  type WardrobeCategory,
} from "@/lib/categories";
import {
  cleanGarmentName,
} from "@/lib/utils/garmentName";
import {
  analyzeForegroundSemantics,
  cropAndPadTransparentCanvas,
  isolateGarmentCutout,
  type SemanticParseMap,
} from "@/lib/utils/garmentIsolator";
import {
  analyzeGarmentSymmetry,
  buildHighContrastAnalysisRgba,
  computeBrightStudioRescueMask,
  detectBrightStudioBackground,
  detectExistingTransparentCutout,
  EDGE_SENSITIVITY_CUTOFFS,
  isSymmetryEligibleCategory,
  mirrorGarmentViaCanvas,
  recombineOriginalRgbWithAlphaMatte,
  type EdgeSensitivityPreset,
  type GarmentSymmetryAnalysis,
  type MirrorDirection,
  type StudioBorderStats,
} from "@/lib/utils/garmentSymmetry";
import {
  extractErrorMessage,
  isSupportedImageFile,
  normalizeImageToPngBlob,
} from "@/lib/utils/normalizeImage";
import { parseGarmentSemanticsInBrowser } from "@/lib/utils/semanticClothesParser";

interface UploadCutoutModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type ProcessingStage = "idle" | "processing" | "ready" | "error";
type IsolationMode = "category" | "full";
type BrushMode = "none" | "erase" | "restore";
type BrushSizePreset = "sm" | "md" | "lg";

interface ParsedSubjectAsset {
  /** Original unmodified normalized RGB pixels at working resolution (<= 960px). */
  originalRgba: Uint8ClampedArray;
  /** Raw continuous 0..255 foreground alpha matte returned by @imgly/background-removal. */
  rawMatteAlpha: Uint8Array;
  /** Current edge-sensitivity-recombined RGBA (original RGB + feathered alpha). */
  /** Validated border-flood-fill rescue mask for bright `#FFFFFF` studio flat-lays (null on non-white scenes). */
  studioRescueMask: Uint8Array | null;
  /** Current edge-sensitivity-recombined RGBA (original RGB + solid interior + 1.5px feathered edge). */
  sourceRgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Cached 18-class SegFormer-B2-Clothes semantic probability map (null if offline/failed). */
  semanticMap: SemanticParseMap | null;
  hasHumanOrOtherClothes: boolean;
  /** True when a bright white studio background triggered pre-segmentation contrast boost. */
  usedStudioContrastBoost: boolean;
  /** True when the uploaded PNG/WebP already carried clean transparent background alpha. */
  usedExistingAlpha: boolean;
}

interface WorkingCutoutBuffer {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  cropOriginX: number;
  cropOriginY: number;
}

const MAX_NORMALIZED_DIMENSION = 1200;
const MAX_OUTPUT_DIMENSION = 960;
const MAX_UNDO_STEPS = 15;

const BRUSH_SIZE_RATIOS: Record<BrushSizePreset, number> = {
  sm: 0.022,
  md: 0.044,
  lg: 0.075,
};

function decodeBlobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode the garment image."));
    };
    img.src = url;
  });
}

function drawImageToRgba(
  img: HTMLImageElement,
  targetWidth: number,
  targetHeight: number
): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Browser canvas is unavailable.");
  }

  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
  return new Uint8ClampedArray(
    ctx.getImageData(0, 0, targetWidth, targetHeight).data
  );
}

function drawImageToWorkingRgba(
  img: HTMLImageElement,
  maxDimension: number
): { rgba: Uint8ClampedArray; width: number; height: number } {
  const natW = Math.max(1, img.naturalWidth);
  const natH = Math.max(1, img.naturalHeight);
  const scale = Math.min(1, maxDimension / Math.max(natW, natH));
  const width = Math.max(1, Math.round(natW * scale));
  const height = Math.max(1, Math.round(natH * scale));
  return {
    rgba: drawImageToRgba(img, width, height),
    width,
    height,
  };
}

function rgbaToPngBlob(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return Promise.reject(new Error("Browser canvas is unavailable."));
  }
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(rgba), width, height),
    0,
    0
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode analysis image."));
    }, "image/png");
  });
}

/**
 * Encodes an RGBA cutout buffer into a compact alpha-preserving data URL (WebP with PNG fallback).
 */
function encodeRgbaBufferToDataUrl(
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): string {
  const scale = Math.min(1, MAX_OUTPUT_DIMENSION / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) {
    throw new Error("Browser canvas is unavailable.");
  }
  const imgData = new ImageData(new Uint8ClampedArray(rgba), width, height);
  srcCtx.putImageData(imgData, 0, 0);

  let targetCanvas = srcCanvas;
  if (outW !== width || outH !== height) {
    const scaledCanvas = document.createElement("canvas");
    scaledCanvas.width = outW;
    scaledCanvas.height = outH;
    const scaledCtx = scaledCanvas.getContext("2d");
    if (!scaledCtx) {
      throw new Error("Browser canvas is unavailable.");
    }
    scaledCtx.clearRect(0, 0, outW, outH);
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = "high";
    scaledCtx.drawImage(srcCanvas, 0, 0, outW, outH);
    targetCanvas = scaledCanvas;
  }

  const webpDataUrl = targetCanvas.toDataURL("image/webp", 0.88);
  if (webpDataUrl.startsWith("data:image/webp")) {
    return webpDataUrl;
  }
  return targetCanvas.toDataURL("image/png");
}

/**
 * Fallback encoder for when the user explicitly chooses the normalized original photo.
 */
async function compressBlobToDataUrl(blob: Blob): Promise<string> {
  const img = await decodeBlobToImage(blob);
  const { rgba, width, height } = drawImageToWorkingRgba(
    img,
    MAX_OUTPUT_DIMENSION
  );
  return encodeRgbaBufferToDataUrl(rgba, width, height);
}

function cloneWorkingBuffer(buf: WorkingCutoutBuffer): WorkingCutoutBuffer {
  return {
    rgba: new Uint8ClampedArray(buf.rgba),
    width: buf.width,
    height: buf.height,
    cropOriginX: buf.cropOriginX,
    cropOriginY: buf.cropOriginY,
  };
}

export function UploadCutoutModal({
  open,
  onClose,
  onSaved,
}: UploadCutoutModalProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const cutoutCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const runIdRef = useRef(0);

  // Live pixel buffer & full-buffer undo stack (supports both brush strokes & Mirror L ↔ R)
  const workingBufferRef = useRef<WorkingCutoutBuffer | null>(null);
  const activeSourceRgbaRef = useRef<Uint8ClampedArray | null>(null);
  const undoStackRef = useRef<WorkingCutoutBuffer[]>([]);
  const isPaintingRef = useRef(false);
  const lastBrushPointRef = useRef<{ x: number; y: number } | null>(null);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<WardrobeCategory>("top");
  const categoryRef = useRef<WardrobeCategory>("top");

  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [normalizedOriginalBlob, setNormalizedOriginalBlob] =
    useState<Blob | null>(null);
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(
    null
  );

  const [parsedAsset, setParsedAsset] = useState<ParsedSubjectAsset | null>(
    null
  );
  const [isolationMode, setIsolationMode] = useState<IsolationMode>("category");
  const [edgeSensitivity, setEdgeSensitivity] =
    useState<EdgeSensitivityPreset>("soft");
  const [targetMissing, setTargetMissing] = useState(false);
  const [parserUnavailable, setParserUnavailable] = useState(false);
  const [canvasDims, setCanvasDims] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [canvasRenderVersion, setCanvasRenderVersion] = useState(0);

  // Symmetry detection & 1-click Mirror L ↔ R state
  const [symmetryInfo, setSymmetryInfo] =
    useState<GarmentSymmetryAnalysis | null>(null);
  const [mirrorDirection, setMirrorDirection] =
    useState<MirrorDirection>("left-to-right");

  // Interactive brush touch-up state
  const [brushMode, setBrushMode] = useState<BrushMode>("none");
  const [brushSize, setBrushSize] = useState<BrushSizePreset>("md");
  const [undoCount, setUndoCount] = useState(0);
  const [hasManualEdits, setHasManualEdits] = useState(false);
  const [cursorOverlay, setCursorOverlay] = useState<{
    x: number;
    y: number;
    diameterPx: number;
    visible: boolean;
  }>({ x: 0, y: 0, diameterPx: 28, visible: false });

  const [usingOriginalFallback, setUsingOriginalFallback] = useState(false);
  const [previewMode, setPreviewMode] = useState<"cutout" | "original">(
    "cutout"
  );

  const [stage, setStage] = useState<ProcessingStage>("idle");
  const [statusLabel, setStatusLabel] = useState("");
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    categoryRef.current = category;
  }, [category]);

  const paintWorkingBufferToCanvas = useCallback(() => {
    const canvas = cutoutCanvasRef.current;
    const buffer = workingBufferRef.current;
    if (!canvas || !buffer) return;

    if (canvas.width !== buffer.width || canvas.height !== buffer.height) {
      canvas.width = buffer.width;
      canvas.height = buffer.height;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const imgData = new ImageData(
      new Uint8ClampedArray(buffer.rgba),
      buffer.width,
      buffer.height
    );
    ctx.clearRect(0, 0, buffer.width, buffer.height);
    ctx.putImageData(imgData, 0, 0);
  }, []);

  const refreshSymmetryFromWorkingBuffer = useCallback(
    (targetCategory: WardrobeCategory, syncRecommendedDirection: boolean) => {
      const buffer = workingBufferRef.current;
      if (!buffer) {
        setSymmetryInfo(null);
        return;
      }
      const nextSym = analyzeGarmentSymmetry(
        buffer.rgba,
        buffer.width,
        buffer.height,
        targetCategory
      );
      setSymmetryInfo(nextSym);
      if (syncRecommendedDirection) {
        setMirrorDirection(nextSym.recommendedDirection);
      }
    },
    []
  );

  // Recompute isolated cutout synchronously (<15–30ms) whenever asset, category, mode, or edge sensitivity changes
  const applyIsolationFromCache = useCallback(
    (
      asset: ParsedSubjectAsset,
      targetCategory: WardrobeCategory,
      mode: IsolationMode,
      sensitivity: EdgeSensitivityPreset
    ) => {
      const recombinedSource =
        asset.usedExistingAlpha && sensitivity === "soft"
          ? new Uint8ClampedArray(asset.originalRgba)
          : recombineOriginalRgbWithAlphaMatte({
            originalRgba: asset.originalRgba,
            rawMatteAlpha: asset.rawMatteAlpha,
            width: asset.width,
            height: asset.height,
            alphaCutoff: EDGE_SENSITIVITY_CUTOFFS[sensitivity],
            // Apply bright-studio flood-fill rescue in Soft (default) & Max; Crisp uses strict neural matte
            studioRescueMask:
              sensitivity === "crisp" ? null : asset.studioRescueMask,
            // Never auto-fill intentional transparent gaps on already-cutout PNG uploads
            fillInteriorHoles: !asset.usedExistingAlpha,
          });
      activeSourceRgbaRef.current = recombinedSource;

      const effectiveMode: IsolationMode = asset.semanticMap ? mode : "full";
      const result = isolateGarmentCutout({
        sourceRgba: recombinedSource,
        width: asset.width,
        height: asset.height,
        semanticMap: asset.semanticMap,
        category: targetCategory,
        mode: effectiveMode,
        editorialPaddingRatio: 0.06,
      });

      workingBufferRef.current = {
        rgba: result.rgba,
        width: result.width,
        height: result.height,
        cropOriginX: result.cropOriginX,
        cropOriginY: result.cropOriginY,
      };
      undoStackRef.current = [];
      setUndoCount(0);
      setHasManualEdits(false);
      setTargetMissing(result.targetMissing);
      setCanvasDims({ width: result.width, height: result.height });
      refreshSymmetryFromWorkingBuffer(targetCategory, true);
      setCanvasRenderVersion((v) => v + 1);
    },
    [refreshSymmetryFromWorkingBuffer]
  );

  // Reactive <50ms category / mode / edge-sensitivity re-cut effect
  useEffect(() => {
    if (!parsedAsset || usingOriginalFallback) return;
    applyIsolationFromCache(
      parsedAsset,
      category,
      isolationMode,
      edgeSensitivity
    );
  }, [
    parsedAsset,
    category,
    isolationMode,
    edgeSensitivity,
    usingOriginalFallback,
    applyIsolationFromCache,
  ]);

  // Synchronize live RGBA buffer onto the visible canvas after every render or preview toggle
  useEffect(() => {
    if (
      stage === "ready" &&
      previewMode === "cutout" &&
      !usingOriginalFallback
    ) {
      paintWorkingBufferToCanvas();
    }
  }, [
    stage,
    previewMode,
    usingOriginalFallback,
    canvasRenderVersion,
    paintWorkingBufferToCanvas,
  ]);

  const revokePreviews = useCallback(() => {
    setOriginalPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const resetModal = useCallback(() => {
    runIdRef.current += 1;
    revokePreviews();
    workingBufferRef.current = null;
    activeSourceRgbaRef.current = null;
    undoStackRef.current = [];
    isPaintingRef.current = false;
    lastBrushPointRef.current = null;

    setName("");
    setCategory("top");
    setSourceFile(null);
    setNormalizedOriginalBlob(null);
    setParsedAsset(null);
    setIsolationMode("category");
    setEdgeSensitivity("soft");
    setTargetMissing(false);
    setParserUnavailable(false);
    setCanvasDims(null);
    setSymmetryInfo(null);
    setMirrorDirection("left-to-right");
    setBrushMode("none");
    setBrushSize("md");
    setUndoCount(0);
    setHasManualEdits(false);
    setCursorOverlay({ x: 0, y: 0, diameterPx: 28, visible: false });
    setUsingOriginalFallback(false);
    setPreviewMode("cutout");
    setStage("idle");
    setStatusLabel("");
    setProgressPercent(null);
    setIsDragging(false);
    setIsSaving(false);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [revokePreviews]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    resetModal();
    onClose();
  }, [isSaving, onClose, resetModal]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isSaving) {
        handleClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, isSaving, handleClose]);

  useEffect(() => {
    return () => {
      revokePreviews();
    };
  }, [revokePreviews]);

  const runGarmentPipeline = useCallback(async (file: File) => {
    const currentRunId = ++runIdRef.current;

    setError(null);
    setStage("processing");
    setUsingOriginalFallback(false);
    setParsedAsset(null);
    setParserUnavailable(false);
    setTargetMissing(false);
    setSymmetryInfo(null);
    setEdgeSensitivity("soft");
    setBrushMode("none");
    setHasManualEdits(false);
    setUndoCount(0);
    workingBufferRef.current = null;
    activeSourceRgbaRef.current = null;
    undoStackRef.current = [];
    setStatusLabel("Normalizing image to 1200px PNG…");
    setProgressPercent(null);

    // Step 1: Pre-normalize onto an offscreen canvas (max 1200px, clean PNG Blob)
    let normalizedBlob: Blob;
    let normalizedImg: HTMLImageElement;
    try {
      normalizedBlob = await normalizeImageToPngBlob(
        file,
        MAX_NORMALIZED_DIMENSION
      );
      if (runIdRef.current !== currentRunId) return;

      setNormalizedOriginalBlob(normalizedBlob);
      const normalizedPreview = URL.createObjectURL(normalizedBlob);
      setOriginalPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return normalizedPreview;
      });
      normalizedImg = await decodeBlobToImage(normalizedBlob);
      if (runIdRef.current !== currentRunId) return;
    } catch (normErr) {
      if (runIdRef.current !== currentRunId) return;
      console.error(
        "[UploadCutoutModal] Image pre-normalization failed:",
        normErr
      );
      setStage("error");
      setError(
        `Could not read this image (${extractErrorMessage(normErr)}). Try another PNG, JPG, or WebP photo.`
      );
      return;
    }

    // Step 1b: Check whether the uploaded PNG/WebP already carries a clean transparent cutout.
    // Skipping destructive `@imgly/background-removal` re-matting on transparent cutouts avoids
    // black-backdrop edge erosion on dark leather jackets, coats, and crisp product PNGs.
    let usedStudioContrastBoost = false;
    let usedExistingAlpha = false;
    let detectedBorderStats: StudioBorderStats | null = null;
    let originalRgba: Uint8ClampedArray;
    let rawMatteAlpha: Uint8Array;
    let studioRescueMask: Uint8Array | null = null;
    let sourceRgba: Uint8ClampedArray;
    let width: number;
    let height: number;

    const normW = Math.max(1, normalizedImg.naturalWidth);
    const normH = Math.max(1, normalizedImg.naturalHeight);
    const fullNormRgba = drawImageToRgba(normalizedImg, normW, normH);
    const existingCutout = detectExistingTransparentCutout(
      fullNormRgba,
      normW,
      normH
    );

    if (existingCutout.hasExistingTransparency) {
      setStatusLabel("Preserving existing PNG transparency…");
      const working = drawImageToWorkingRgba(normalizedImg, MAX_OUTPUT_DIMENSION);
      originalRgba = working.rgba;
      width = working.width;
      height = working.height;
      rawMatteAlpha = new Uint8Array(width * height);
      for (let i = 0; i < rawMatteAlpha.length; i++) {
        rawMatteAlpha[i] = originalRgba[i * 4 + 3];
      }
      sourceRgba = new Uint8ClampedArray(originalRgba);
      usedExistingAlpha = true;
    } else {
      // Detect bright white studio background (16px border ring: mean > 235 & stdDev < 18)
      // and build a temporary high-contrast CLAHE + unsharp + gamma 1.35 analysis copy so
      // white-on-white cotton sleeves and edges stand out clearly before segmentation.
      let segmentationInputBlob: Blob = normalizedBlob;

      try {
        const borderStats = detectBrightStudioBackground(
          fullNormRgba,
          normW,
          normH
        );
        detectedBorderStats = borderStats;

        if (borderStats.isBrightStudio) {
          setStatusLabel("Boosting low-contrast studio edges…");
          const boostedRgba = buildHighContrastAnalysisRgba(
            fullNormRgba,
            normW,
            normH,
            borderStats
          );
          segmentationInputBlob = await rgbaToPngBlob(boostedRgba, normW, normH);
          if (runIdRef.current !== currentRunId) return;
          usedStudioContrastBoost = true;
        }
      } catch (boostErr) {
        console.warn(
          "[UploadCutoutModal] Pre-segmentation contrast boost skipped:",
          boostErr
        );
        segmentationInputBlob = normalizedBlob;
        usedStudioContrastBoost = false;
      }

      // Step 2: Run browser-only @imgly/background-removal on the analysis copy
      setStatusLabel("Loading background removal model (first run)…");

      let cutoutImg: HTMLImageElement;
      try {
        const { removeBackground } = await import("@imgly/background-removal");

        const resultBlob = await removeBackground(segmentationInputBlob, {
          output: {
            format: "image/png",
            quality: 0.9,
          },
          progress: (key, current, total) => {
            if (runIdRef.current !== currentRunId) return;

            if (key.startsWith("fetch:")) {
              setStatusLabel("Downloading background cutout model (first run)…");
            } else if (key.startsWith("compute:")) {
              setStatusLabel("Separating foreground subject…");
            } else {
              setStatusLabel("Refining silhouette matte…");
            }

            if (total > 0) {
              const pct = Math.min(
                100,
                Math.max(0, Math.round((current / total) * 100))
              );
              setProgressPercent(pct);
            } else {
              setProgressPercent(null);
            }
          },
        });

        if (runIdRef.current !== currentRunId) return;
        cutoutImg = await decodeBlobToImage(resultBlob);
        if (runIdRef.current !== currentRunId) return;
      } catch (err) {
        if (runIdRef.current !== currentRunId) return;
        console.error(
          "[UploadCutoutModal] @imgly/background-removal failed:",
          err
        );
        const detail = extractErrorMessage(err);
        setStage("error");
        setError(
          `Background removal failed (${detail}). You can retry or proceed with the normalized original photo.`
        );
        return;
      }

      // Extract raw soft alpha matte and re-apply strictly onto the ORIGINAL unmodified RGB pixels
      const rawCutout = drawImageToWorkingRgba(cutoutImg, MAX_OUTPUT_DIMENSION);
      width = rawCutout.width;
      height = rawCutout.height;
      originalRgba = drawImageToRgba(normalizedImg, width, height);
      rawMatteAlpha = new Uint8Array(width * height);
      for (let i = 0; i < rawMatteAlpha.length; i++) {
        rawMatteAlpha[i] = rawCutout.rgba[i * 4 + 3];
      }

      studioRescueMask = detectedBorderStats?.isBrightStudio
        ? computeBrightStudioRescueMask({
          originalRgba,
          rawMatteAlpha,
          width,
          height,
          borderStats: detectedBorderStats,
        })
        : null;

      sourceRgba = recombineOriginalRgbWithAlphaMatte({
        originalRgba,
        rawMatteAlpha,
        width,
        height,
        alphaCutoff: EDGE_SENSITIVITY_CUTOFFS.soft,
        studioRescueMask,
      });
    }

    // Step 3: Run SegFormer-B2-Clothes semantic human/clothes parsing in browser (WASM, cached)
    // Always feed natural unmodified sRGB (`normalizedImg`, composited onto #FFFFFF inside parser)
    // so CLAHE/gamma studio boosting never shifts dark leather/fabric colors out of distribution.
    setStatusLabel("Isolating target garment regions…");
    setProgressPercent(null);

    let semanticMap: SemanticParseMap | null = null;
    let hasHumanOrOtherClothes = false;

    try {
      semanticMap = await parseGarmentSemanticsInBrowser(
        normalizedImg,
        (evt) => {
          if (runIdRef.current !== currentRunId) return;
          if (evt.phase === "download") {
            setStatusLabel("Downloading garment parser model (first run)…");
            setProgressPercent(evt.percent);
          } else if (evt.phase === "init") {
            setStatusLabel("Initializing garment parser…");
            setProgressPercent(null);
          } else {
            setStatusLabel(
              `Isolating ${CATEGORY_LABELS[categoryRef.current]}…`
            );
            setProgressPercent(null);
          }
        }
      );

      if (runIdRef.current !== currentRunId) return;

      const summary = analyzeForegroundSemantics(
        sourceRgba,
        width,
        height,
        semanticMap
      );
      hasHumanOrOtherClothes = summary.hasHumanOrOtherClothes;
    } catch (parseErr) {
      if (runIdRef.current !== currentRunId) return;
      console.warn(
        "[UploadCutoutModal] Semantic clothes parsing unavailable, using full subject cutout:",
        parseErr
      );
      semanticMap = null;
      hasHumanOrOtherClothes = false;
      setParserUnavailable(true);
    }

    if (runIdRef.current !== currentRunId) return;

    const defaultMode: IsolationMode =
      semanticMap && hasHumanOrOtherClothes ? "category" : "full";
    const asset: ParsedSubjectAsset = {
      originalRgba,
      rawMatteAlpha,
      studioRescueMask,
      sourceRgba,
      width,
      height,
      semanticMap,
      hasHumanOrOtherClothes,
      usedStudioContrastBoost,
      usedExistingAlpha,
    };

    setIsolationMode(defaultMode);
    setParsedAsset(asset);
    setPreviewMode("cutout");
    setStage("ready");
    setProgressPercent(100);
  }, []);

  const handleUseOriginalFallback = useCallback(() => {
    if (!normalizedOriginalBlob) return;
    setUsingOriginalFallback(true);
    setBrushMode("none");
    setPreviewMode("original");
    setStage("ready");
    setError(null);
  }, [normalizedOriginalBlob]);

  const handleFileSelected = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;

      if (!isSupportedImageFile(file)) {
        setError("Select a PNG, JPG, WebP, or AVIF garment photo.");
        return;
      }

      if (file.size > 20 * 1024 * 1024) {
        setError("Image is larger than 20 MB. Choose a smaller photo.");
        return;
      }

      setSourceFile(file);
      setOriginalPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });

      if (!name.trim()) {
        const cleanedBaseName = cleanGarmentName(file.name, category);
        if (cleanedBaseName && cleanedBaseName !== "Untitled Piece") {
          setName(cleanedBaseName);
        }
      }

      void runGarmentPipeline(file);
    },
    [name, runGarmentPipeline]
  );

  const pushUndoSnapshot = useCallback(() => {
    const buffer = workingBufferRef.current;
    if (!buffer) return;
    const stack = undoStackRef.current;
    stack.push(cloneWorkingBuffer(buffer));
    if (stack.length > MAX_UNDO_STEPS) {
      stack.shift();
    }
    setUndoCount(stack.length);
    setHasManualEdits(true);
  }, []);

  // 1-click Mirror L ↔ R symmetry recovery (< 15ms pure HTML5 Canvas)
  const handleMirrorSymmetry = useCallback(
    (overrideDirection?: MirrorDirection) => {
      const buffer = workingBufferRef.current;
      if (!buffer || isSaving) return;

      const direction = overrideDirection ?? mirrorDirection;
      pushUndoSnapshot();

      const mirrored = mirrorGarmentViaCanvas({
        rgba: buffer.rgba,
        width: buffer.width,
        height: buffer.height,
        category,
        direction,
        cropOriginX: buffer.cropOriginX,
        cropOriginY: buffer.cropOriginY,
      });

      workingBufferRef.current = {
        rgba: mirrored.rgba,
        width: mirrored.width,
        height: mirrored.height,
        cropOriginX: mirrored.cropOriginX,
        cropOriginY: mirrored.cropOriginY,
      };
      setCanvasDims({ width: mirrored.width, height: mirrored.height });
      refreshSymmetryFromWorkingBuffer(category, false);
      setCanvasRenderVersion((v) => v + 1);
    },
    [
      category,
      isSaving,
      mirrorDirection,
      pushUndoSnapshot,
      refreshSymmetryFromWorkingBuffer,
    ]
  );

  // Brush painting helper: applies a soft circular Erase or smart Restore stamp
  const applyBrushStamp = useCallback(
    (
      cx: number,
      cy: number,
      radius: number,
      mode: "erase" | "restore"
    ): { minX: number; minY: number; maxX: number; maxY: number } | null => {
      const buffer = workingBufferRef.current;
      const asset = parsedAsset;
      if (!buffer || !asset) return null;

      const { rgba, width, height, cropOriginX, cropOriginY } = buffer;
      const minX = Math.max(0, Math.floor(cx - radius));
      const maxX = Math.min(width - 1, Math.ceil(cx + radius));
      const minY = Math.max(0, Math.floor(cy - radius));
      const maxY = Math.min(height - 1, Math.ceil(cy + radius));
      if (maxX < minX || maxY < minY) return null;

      const r2 = radius * radius;
      const softStart = radius * 0.65;
      const softSpan = Math.max(1e-3, radius - softStart);
      const srcRgba = activeSourceRgbaRef.current ?? asset.sourceRgba;
      const origRgba = asset.originalRgba;
      const allowOriginalFallback =
        isolationMode === "full" || !asset.hasHumanOrOtherClothes;
      const srcW = asset.width;
      const srcH = asset.height;

      for (let y = minY; y <= maxY; y++) {
        const dy = y - cy;
        const dy2 = dy * dy;
        const rowOff = y * width;
        const srcY = y + cropOriginY;

        for (let x = minX; x <= maxX; x++) {
          const dx = x - cx;
          const dist2 = dx * dx + dy2;
          if (dist2 > r2) continue;

          const dist = Math.sqrt(dist2);
          const strength =
            dist <= softStart
              ? 1
              : 0.5 * (1 + Math.cos(Math.PI * ((dist - softStart) / softSpan)));
          if (strength <= 0.005) continue;

          const dstOff = (rowOff + x) * 4;

          if (mode === "erase") {
            const curA = rgba[dstOff + 3];
            if (curA === 0) continue;
            const nextA = Math.round(curA * (1 - strength));
            rgba[dstOff + 3] = nextA < 6 ? 0 : nextA;
          } else {
            const srcX = x + cropOriginX;
            if (srcX < 0 || srcX >= srcW || srcY < 0 || srcY >= srcH) continue;
            const srcOff = (srcY * srcW + srcX) * 4;
            const matteA = srcRgba[srcOff + 3];

            let targetR: number;
            let targetG: number;
            let targetB: number;
            let targetA: number;

            if (matteA >= 10) {
              targetR = srcRgba[srcOff];
              targetG = srcRgba[srcOff + 1];
              targetB = srcRgba[srcOff + 2];
              targetA = matteA;
            } else if (allowOriginalFallback && !asset.usedExistingAlpha) {
              // On opaque flat-lays / Full Subject mode, allow painting back dropped low-contrast garment pixels
              targetR = origRgba[srcOff];
              targetG = origRgba[srcOff + 1];
              targetB = origRgba[srcOff + 2];
              targetA = 255;
            } else if (asset.usedExistingAlpha && origRgba[srcOff + 3] >= 10) {
              targetR = origRgba[srcOff];
              targetG = origRgba[srcOff + 1];
              targetB = origRgba[srcOff + 2];
              targetA = origRgba[srcOff + 3];
            } else {
              continue;
            }

            const curA = rgba[dstOff + 3];
            const nextA = Math.min(
              targetA,
              Math.round(curA + (targetA - curA) * strength)
            );
            if (curA < 12) {
              rgba[dstOff] = targetR;
              rgba[dstOff + 1] = targetG;
              rgba[dstOff + 2] = targetB;
            } else {
              rgba[dstOff] = Math.round(
                rgba[dstOff] + (targetR - rgba[dstOff]) * strength
              );
              rgba[dstOff + 1] = Math.round(
                rgba[dstOff + 1] + (targetG - rgba[dstOff + 1]) * strength
              );
              rgba[dstOff + 2] = Math.round(
                rgba[dstOff + 2] + (targetB - rgba[dstOff + 2]) * strength
              );
            }
            rgba[dstOff + 3] = nextA;
          }
        }
      }

      return { minX, minY, maxX, maxY };
    },
    [isolationMode, parsedAsset]
  );

  const paintStrokeSegment = useCallback(
    (
      from: { x: number; y: number },
      to: { x: number; y: number },
      mode: "erase" | "restore"
    ) => {
      const buffer = workingBufferRef.current;
      const canvas = cutoutCanvasRef.current;
      if (!buffer || !canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const radius = Math.max(
        6,
        Math.round(
          Math.max(buffer.width, buffer.height) * BRUSH_SIZE_RATIOS[brushSize]
        )
      );
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const step = Math.max(1, radius * 0.25);
      const steps = Math.max(1, Math.ceil(dist / step));

      let dirtyMinX = buffer.width;
      let dirtyMinY = buffer.height;
      let dirtyMaxX = -1;
      let dirtyMaxY = -1;

      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const sx = from.x + (to.x - from.x) * t;
        const sy = from.y + (to.y - from.y) * t;
        const dirty = applyBrushStamp(sx, sy, radius, mode);
        if (dirty) {
          if (dirty.minX < dirtyMinX) dirtyMinX = dirty.minX;
          if (dirty.minY < dirtyMinY) dirtyMinY = dirty.minY;
          if (dirty.maxX > dirtyMaxX) dirtyMaxX = dirty.maxX;
          if (dirty.maxY > dirtyMaxY) dirtyMaxY = dirty.maxY;
        }
      }

      if (dirtyMaxX >= dirtyMinX && dirtyMaxY >= dirtyMinY) {
        const imgData = new ImageData(
          new Uint8ClampedArray(buffer.rgba),
          buffer.width,
          buffer.height
        );
        ctx.putImageData(
          imgData,
          0,
          0,
          dirtyMinX,
          dirtyMinY,
          dirtyMaxX - dirtyMinX + 1,
          dirtyMaxY - dirtyMinY + 1
        );
      }
    },
    [applyBrushStamp, brushSize]
  );

  const mapPointerToCanvasCoords = useCallback(
    (
      event: ReactPointerEvent<HTMLCanvasElement>
    ): {
      canvasPoint: { x: number; y: number };
      stagePoint: { x: number; y: number };
      brushDiameterCss: number;
    } | null => {
      const canvas = cutoutCanvasRef.current;
      const stageEl = stageRef.current;
      const buffer = workingBufferRef.current;
      if (!canvas || !stageEl || !buffer) return null;

      const rect = canvas.getBoundingClientRect();
      const stageRect = stageEl.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;

      const scaleX = buffer.width / rect.width;
      const scaleY = buffer.height / rect.height;
      const radiusCanvas = Math.max(
        6,
        Math.round(
          Math.max(buffer.width, buffer.height) * BRUSH_SIZE_RATIOS[brushSize]
        )
      );

      return {
        canvasPoint: {
          x: (event.clientX - rect.left) * scaleX,
          y: (event.clientY - rect.top) * scaleY,
        },
        stagePoint: {
          x: event.clientX - stageRect.left,
          y: event.clientY - stageRect.top,
        },
        brushDiameterCss: Math.max(10, (radiusCanvas * 2) / scaleX),
      };
    },
    [brushSize]
  );

  const handleCanvasPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (brushMode === "none" || isSaving) return;
      const mapped = mapPointerToCanvasCoords(event);
      if (!workingBufferRef.current || !mapped) return;

      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);

      pushUndoSnapshot();

      isPaintingRef.current = true;
      lastBrushPointRef.current = mapped.canvasPoint;
      paintStrokeSegment(mapped.canvasPoint, mapped.canvasPoint, brushMode);
      setCursorOverlay({
        x: mapped.stagePoint.x,
        y: mapped.stagePoint.y,
        diameterPx: mapped.brushDiameterCss,
        visible: true,
      });
    },
    [
      brushMode,
      isSaving,
      mapPointerToCanvasCoords,
      paintStrokeSegment,
      pushUndoSnapshot,
    ]
  );

  const handleCanvasPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (brushMode === "none") return;
      const mapped = mapPointerToCanvasCoords(event);
      if (!mapped) return;

      setCursorOverlay({
        x: mapped.stagePoint.x,
        y: mapped.stagePoint.y,
        diameterPx: mapped.brushDiameterCss,
        visible: true,
      });

      if (!isPaintingRef.current || !lastBrushPointRef.current) return;
      event.preventDefault();
      paintStrokeSegment(
        lastBrushPointRef.current,
        mapped.canvasPoint,
        brushMode
      );
      lastBrushPointRef.current = mapped.canvasPoint;
    },
    [brushMode, mapPointerToCanvasCoords, paintStrokeSegment]
  );

  const handleCanvasPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (isPaintingRef.current) {
        isPaintingRef.current = false;
        lastBrushPointRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        refreshSymmetryFromWorkingBuffer(category, false);
      }
    },
    [category, refreshSymmetryFromWorkingBuffer]
  );

  const handleUndoEdit = useCallback(() => {
    const prevBuffer = undoStackRef.current.pop();
    if (!prevBuffer) return;
    workingBufferRef.current = prevBuffer;
    setUndoCount(undoStackRef.current.length);
    if (undoStackRef.current.length === 0) {
      setHasManualEdits(false);
    }
    setCanvasDims({ width: prevBuffer.width, height: prevBuffer.height });
    refreshSymmetryFromWorkingBuffer(category, false);
    setCanvasRenderVersion((v) => v + 1);
  }, [category, refreshSymmetryFromWorkingBuffer]);

  const handleResetEdits = useCallback(() => {
    if (!parsedAsset) return;
    applyIsolationFromCache(
      parsedAsset,
      category,
      isolationMode,
      edgeSensitivity
    );
  }, [
    parsedAsset,
    category,
    isolationMode,
    edgeSensitivity,
    applyIsolationFromCache,
  ]);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleFileSelected(event.target.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    handleFileSelected(event.dataTransfer.files?.[0]);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (
      stage !== "ready" ||
      (!usingOriginalFallback && !workingBufferRef.current) ||
      (usingOriginalFallback && !normalizedOriginalBlob)
    ) {
      setError("Upload a garment photo and wait for processing to finish.");
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a name for this piece.");
      return;
    }

    setIsSaving(true);

    try {
      // TODO: swap for Neon Object Storage / Cloudinary
      let compressedDataUrl: string;
      if (usingOriginalFallback && normalizedOriginalBlob) {
        compressedDataUrl = await compressBlobToDataUrl(normalizedOriginalBlob);
      } else if (workingBufferRef.current) {
        const buf = workingBufferRef.current;
        const finalCutout = hasManualEdits
          ? cropAndPadTransparentCanvas(buf.rgba, buf.width, buf.height, 0.06)
          : buf;
        compressedDataUrl = encodeRgbaBufferToDataUrl(
          finalCutout.rgba,
          finalCutout.width,
          finalCutout.height
        );
      } else {
        throw new Error("Cutout buffer is empty.");
      }

      const result = await addWardrobeItem({
        name: trimmedName,
        category,
        price: null,
        imageUrl: compressedDataUrl,
      });

      if (!result.ok) {
        setError(result.error || "Could not save piece. Please try again.");
        setIsSaving(false);
        return;
      }

      resetModal();
      onSaved?.();
      onClose();
      router.refresh();
    } catch (err) {
      console.error("[UploadCutoutModal] save failed:", err);
      setError("Could not encode or save this image. Try again.");
      setIsSaving(false);
    }
  }

  if (!open) return null;

  const activeCategoryLabel = CATEGORY_LABELS[category];
  const canShowIsolationControls =
    stage === "ready" && !usingOriginalFallback && previewMode === "cutout";
  const semanticReady = Boolean(parsedAsset?.semanticMap);
  const canMirrorCategory = isSymmetryEligibleCategory(category);
  const showAsymmetryHint =
    canShowIsolationControls &&
    canMirrorCategory &&
    Boolean(symmetryInfo?.isAsymmetric);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isSaving) {
          handleClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-piece-title"
        className="flex max-h-[92vh] w-full max-w-[860px] flex-col overflow-hidden rounded-[28px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] shadow-[0_28px_72px_rgba(0,0,0,0.22)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-6 py-5 sm:px-7">
          <div>
            <h2
              id="add-piece-title"
              className="text-[17px] font-semibold tracking-[-0.03em] text-[var(--ink-primary)]"
            >
              Add Wardrobe Piece
            </h2>
            <p className="mt-0.5 text-[12px] text-[var(--ink-muted)]">
              Normalized to 1200px PNG and isolated by category in your browser.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSaving}
            aria-label="Close modal"
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--ink-muted)] transition-colors duration-150 hover:bg-[var(--bg-well)] hover:text-[var(--ink-primary)] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 overflow-y-auto md:grid-cols-12"
        >
          {/* Left: Upload, Category-Isolated Cutout Preview, Symmetry & Touch-Up */}
          <div className="border-b border-[var(--border-hairline)] bg-[var(--bg-well)] p-6 md:col-span-6 md:border-r md:border-b-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleInputChange}
              className="hidden"
            />

            {stage === "idle" ? (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fileInputRef.current?.click();
                  }
                }}
                className={`flex aspect-[4/5] w-full cursor-pointer flex-col items-center justify-center rounded-[20px] border border-dashed px-6 text-center transition-colors duration-150 ${isDragging
                  ? "border-[var(--ink-primary)] bg-[var(--bg-tile)]"
                  : "border-[var(--border-mid)] bg-[var(--bg-surface)] hover:border-[var(--ink-primary)]"
                  }`}
              >
                <div className="flex h-11 w-11 items-center justify-center rounded-[14px] border border-[var(--border-hairline)] bg-[var(--bg-well)] text-[var(--ink-primary)]">
                  <Upload className="h-4 w-4" strokeWidth={1.5} />
                </div>
                <p className="mt-4 text-[13px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                  Upload garment photo
                </p>
                <p className="mt-1 max-w-[26ch] text-[12px] leading-relaxed text-[var(--ink-muted)]">
                  Drop a flat-lay, store photo, or full-body outfit shot. PNG,
                  JPG, WebP, or AVIF.
                </p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-[10px] font-medium tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                  <Scissors className="h-3 w-3" />
                  Category-aware cutout
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div
                  ref={stageRef}
                  className={`relative flex aspect-[4/5] w-full items-center justify-center overflow-hidden rounded-[20px] border border-[var(--border-hairline)] p-5 ${stage === "ready" &&
                    previewMode === "cutout" &&
                    !usingOriginalFallback
                    ? "cutout-checkerboard"
                    : "bg-[var(--bg-tile)]"
                    }`}
                >
                  {stage === "processing" && (
                    <>
                      {originalPreviewUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={originalPreviewUrl}
                          alt="Original garment upload"
                          className="max-h-full max-w-full object-contain opacity-30"
                        />
                      )}
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-[var(--bg-surface)]/92 px-6 text-center">
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-primary)]" />
                        <p className="mt-3 text-[13px] font-medium text-[var(--ink-primary)]">
                          {statusLabel || "Removing background…"}
                        </p>
                        <div className="mt-3 h-[2px] w-48 overflow-hidden rounded-full bg-[var(--border-hairline)]">
                          {progressPercent !== null ? (
                            <div
                              className="h-full bg-[var(--ink-primary)] transition-[width] duration-200"
                              style={{ width: `${progressPercent}%` }}
                            />
                          ) : (
                            <div className="h-full w-1/3 animate-pulse bg-[var(--ink-primary)]" />
                          )}
                        </div>
                        <p className="mt-2 text-[11px] text-[var(--ink-muted)] tabular-nums">
                          {progressPercent !== null
                            ? `${progressPercent}% · First run caches ONNX weights locally`
                            : "First run downloads WASM/ONNX models to browser cache"}
                        </p>
                      </div>
                    </>
                  )}

                  {stage === "ready" &&
                    previewMode === "cutout" &&
                    !usingOriginalFallback && (
                      <>
                        <canvas
                          ref={cutoutCanvasRef}
                          width={canvasDims?.width ?? 1}
                          height={canvasDims?.height ?? 1}
                          aria-label="Isolated transparent PNG garment cutout"
                          onPointerDown={handleCanvasPointerDown}
                          onPointerMove={handleCanvasPointerMove}
                          onPointerUp={handleCanvasPointerUp}
                          onPointerCancel={handleCanvasPointerUp}
                          onPointerLeave={() => {
                            setCursorOverlay((prev) =>
                              prev.visible ? { ...prev, visible: false } : prev
                            );
                          }}
                          style={
                            canvasDims
                              ? {
                                aspectRatio: `${canvasDims.width} / ${canvasDims.height}`,
                              }
                              : undefined
                          }
                          className={`max-h-full max-w-full h-auto w-auto select-none drop-shadow-[0_12px_20px_rgba(0,0,0,0.14)] ${brushMode !== "none"
                            ? "cursor-none touch-none"
                            : ""
                            }`}
                        />

                        {brushMode !== "none" && cursorOverlay.visible && (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute border border-[#111111] shadow-[0_0_0_1.5px_rgba(255,255,255,0.92)]"
                            style={{
                              width: `${cursorOverlay.diameterPx}px`,
                              height: `${cursorOverlay.diameterPx}px`,
                              borderRadius: "9999px",
                              left: `${cursorOverlay.x - cursorOverlay.diameterPx / 2}px`,
                              top: `${cursorOverlay.y - cursorOverlay.diameterPx / 2}px`,
                            }}
                          />
                        )}
                      </>
                    )}

                  {stage === "ready" &&
                    (previewMode === "original" || usingOriginalFallback) && (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        src={originalPreviewUrl ?? ""}
                        alt="Normalized original garment photo"
                        className="max-h-full max-w-full object-contain"
                      />
                    )}

                  {stage === "error" && (
                    <div className="relative flex h-full w-full flex-col items-center justify-center px-2 text-center">
                      {originalPreviewUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={originalPreviewUrl}
                          alt="Normalized garment preview"
                          className="mb-4 max-h-40 object-contain opacity-80"
                        />
                      )}
                      <p className="text-[13px] font-semibold text-[var(--ink-primary)]">
                        Background removal failed
                      </p>
                      <p className="mt-1 max-w-[28ch] text-[12px] text-[var(--ink-muted)]">
                        Use the normalized original photo or retry cutout.
                      </p>
                      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                        {normalizedOriginalBlob && (
                          <button
                            type="button"
                            onClick={handleUseOriginalFallback}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[10px] bg-[var(--btn-primary-bg)] px-3 text-[12px] font-medium text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)]"
                          >
                            <span>Use Original Photo</span>
                          </button>
                        )}
                        {sourceFile && (
                          <button
                            type="button"
                            onClick={() => void runGarmentPipeline(sourceFile)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 text-[12px] font-medium text-[var(--ink-primary)] transition-colors duration-150 hover:border-[var(--ink-primary)]"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            <span>Retry cutout</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Subtle Asymmetry Recovery Hint Chip (above toolbar when width asymmetry > 22%) */}
                {showAsymmetryHint && symmetryInfo && (
                  <button
                    type="button"
                    onClick={() =>
                      handleMirrorSymmetry(symmetryInfo.recommendedDirection)
                    }
                    disabled={isSaving}
                    className="flex w-full items-center justify-between gap-2 rounded-[12px] border border-[var(--border-mid)] bg-[var(--bg-surface)] px-3 py-2 text-left text-[11px] text-[var(--ink-secondary)] transition-colors duration-150 hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)] disabled:opacity-40"
                  >
                    <span className="inline-flex items-center gap-1.5 truncate">
                      <FlipHorizontal2 className="h-3 w-3 shrink-0 text-[var(--ink-primary)]" />
                      <span>Uneven sleeve/edge detected</span>
                    </span>
                    <span className="shrink-0 font-semibold text-[var(--ink-primary)]">
                      Mirror L ↔ R
                    </span>
                  </button>
                )}

                {/* Preview toolbar */}
                <div className="flex items-center justify-between gap-2 px-0.5">
                  {stage === "ready" && !usingOriginalFallback ? (
                    <div className="inline-flex items-center gap-4">
                      <button
                        type="button"
                        onClick={() => setPreviewMode("cutout")}
                        className={`relative pb-1 text-[11px] font-medium tracking-[0.12em] uppercase transition-colors duration-150 ${previewMode === "cutout"
                          ? "text-[var(--ink-primary)]"
                          : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                          }`}
                      >
                        Cutout PNG
                        {previewMode === "cutout" && (
                          <span className="absolute inset-x-0 bottom-0 h-[1.5px] bg-[var(--ink-primary)]" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setBrushMode("none");
                          setPreviewMode("original");
                        }}
                        className={`relative pb-1 text-[11px] font-medium tracking-[0.12em] uppercase transition-colors duration-150 ${previewMode === "original"
                          ? "text-[var(--ink-primary)]"
                          : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                          }`}
                      >
                        Original
                        {previewMode === "original" && (
                          <span className="absolute inset-x-0 bottom-0 h-[1.5px] bg-[var(--ink-primary)]" />
                        )}
                      </button>
                    </div>
                  ) : (
                    <span className="truncate text-[11px] text-[var(--ink-muted)]">
                      {usingOriginalFallback
                        ? "Using normalized original photo"
                        : sourceFile?.name}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={stage === "processing" || isSaving}
                    className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-[0.1em] text-[var(--ink-secondary)] uppercase transition-colors duration-150 hover:text-[var(--ink-primary)] disabled:opacity-40"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    <span>Replace</span>
                  </button>
                </div>

                {/* Stage B: Category Isolation, Edge Sensitivity, Mirror L ↔ R & Touch-Up Brush */}
                {canShowIsolationControls && (
                  <div className="divide-y divide-[var(--border-hairline)] overflow-hidden rounded-[16px] border border-[var(--border-hairline)] bg-[var(--bg-surface)]">
                    {/* Isolation Scope Toggle */}
                    {semanticReady && (
                      <div className="p-2.5">
                        <div
                          role="group"
                          aria-label="Cutout isolation scope"
                          className="grid grid-cols-2 rounded-[10px] bg-[var(--bg-well)] p-0.5"
                        >
                          <button
                            type="button"
                            onClick={() => setIsolationMode("category")}
                            disabled={isSaving}
                            className={`h-7 rounded-[8px] px-2 text-[11px] font-medium transition-colors duration-150 ${isolationMode === "category"
                              ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                              : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                              }`}
                          >
                            Isolate {activeCategoryLabel} Only
                          </button>
                          <button
                            type="button"
                            onClick={() => setIsolationMode("full")}
                            disabled={isSaving}
                            className={`h-7 rounded-[8px] px-2 text-[11px] font-medium transition-colors duration-150 ${isolationMode === "full"
                              ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                              : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                              }`}
                          >
                            Full Subject
                          </button>
                        </div>

                        {isolationMode === "category" && targetMissing && (
                          <p className="mt-1.5 text-[11px] leading-snug text-[var(--ink-muted)]">
                            No {activeCategoryLabel.toLowerCase()} region
                            detected — showing full subject.
                          </p>
                        )}
                      </div>
                    )}

                    {parserUnavailable && (
                      <div className="px-3 py-2 text-[11px] text-[var(--ink-muted)]">
                        Category parser unavailable offline — use Erase /
                        Restore or Mirror L ↔ R to refine edges.
                      </div>
                    )}

                    {/* Edge Sensitivity Recovery Strip (< 15ms pure Canvas remapping) */}
                    <div className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-medium tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                          Edge
                        </span>
                        {parsedAsset?.usedStudioContrastBoost && (
                          <span className="text-[9px] font-medium tracking-[0.1em] text-[var(--ink-secondary)] uppercase">
                            · White-bg boost
                          </span>
                        )}
                        {parsedAsset?.usedExistingAlpha && (
                          <span className="text-[9px] font-medium tracking-[0.1em] text-[var(--ink-secondary)] uppercase">
                            · PNG alpha kept
                          </span>
                        )}
                      </div>
                      <div
                        role="group"
                        aria-label="Edge sensitivity"
                        className="inline-flex rounded-[8px] bg-[var(--bg-well)] p-0.5"
                      >
                        {(
                          [
                            ["crisp", "Crisp"],
                            ["soft", "Soft"],
                            ["max", "Max"],
                          ] as const
                        ).map(([preset, label]) => (
                          <button
                            key={preset}
                            type="button"
                            onClick={() => setEdgeSensitivity(preset)}
                            disabled={isSaving}
                            title={`Alpha edge cutoff ${EDGE_SENSITIVITY_CUTOFFS[preset].toFixed(2)}`}
                            className={`h-6 rounded-[6px] px-2.5 text-[10px] font-medium transition-colors duration-150 ${edgeSensitivity === preset
                              ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                              : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                              }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Manual Brush Touch-Up + 1-Click Mirror L ↔ R Bar */}
                    <div className="flex flex-wrap items-center justify-between gap-1.5 p-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setBrushMode((prev) =>
                              prev === "erase" ? "none" : "erase"
                            )
                          }
                          disabled={isSaving}
                          aria-pressed={brushMode === "erase"}
                          className={`inline-flex h-7 items-center gap-1 rounded-[8px] px-2.5 text-[11px] font-medium transition-colors duration-150 ${brushMode === "erase"
                            ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                            : "bg-[var(--bg-well)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                            }`}
                        >
                          <Eraser className="h-3 w-3" />
                          <span>Erase</span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setBrushMode((prev) =>
                              prev === "restore" ? "none" : "restore"
                            )
                          }
                          disabled={isSaving}
                          aria-pressed={brushMode === "restore"}
                          className={`inline-flex h-7 items-center gap-1 rounded-[8px] px-2.5 text-[11px] font-medium transition-colors duration-150 ${brushMode === "restore"
                            ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                            : "bg-[var(--bg-well)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                            }`}
                        >
                          <Paintbrush className="h-3 w-3" />
                          <span>Restore</span>
                        </button>

                        {/* 1-Click Mirror L ↔ R Symmetry Control */}
                        {canMirrorCategory && (
                          <div className="inline-flex items-stretch overflow-hidden rounded-[8px] border border-[var(--border-hairline)]">
                            <button
                              type="button"
                              onClick={() => handleMirrorSymmetry()}
                              disabled={isSaving}
                              title={`Mirror ${mirrorDirection === "left-to-right"
                                ? "Left → Right"
                                : "Right → Left"
                                } across garment center axis`}
                              className="inline-flex h-7 items-center gap-1 bg-[var(--bg-well)] px-2 text-[11px] font-medium text-[var(--ink-primary)] transition-colors duration-150 hover:bg-[var(--btn-primary-bg)] hover:text-[var(--btn-primary-fg)] disabled:opacity-40"
                            >
                              <FlipHorizontal2 className="h-3 w-3" />
                              <span>Mirror L ↔ R</span>
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                setMirrorDirection((prev) =>
                                  prev === "left-to-right"
                                    ? "right-to-left"
                                    : "left-to-right"
                                )
                              }
                              disabled={isSaving}
                              aria-label="Toggle mirror direction"
                              title="Switch mirror direction (Left → Right vs Right → Left)"
                              className="inline-flex h-7 items-center border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] px-1.5 text-[10px] font-medium text-[var(--ink-secondary)] tabular-nums transition-colors duration-150 hover:text-[var(--ink-primary)] disabled:opacity-40"
                            >
                              {mirrorDirection === "left-to-right"
                                ? "L→R"
                                : "R→L"}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1">
                        {brushMode !== "none" && (
                          <div
                            role="group"
                            aria-label="Brush size"
                            className="inline-flex rounded-[8px] bg-[var(--bg-well)] p-0.5"
                          >
                            {(
                              [
                                ["sm", "S"],
                                ["md", "M"],
                                ["lg", "L"],
                              ] as const
                            ).map(([preset, label]) => (
                              <button
                                key={preset}
                                type="button"
                                onClick={() => setBrushSize(preset)}
                                className={`h-6 w-6 rounded-[6px] text-[10px] font-medium transition-colors duration-150 ${brushSize === preset
                                  ? "bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                                  : "text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
                                  }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}

                        {undoCount > 0 && (
                          <button
                            type="button"
                            onClick={handleUndoEdit}
                            disabled={isSaving}
                            title="Undo last edit"
                            aria-label="Undo last edit"
                            className="inline-flex h-7 w-7 items-center justify-center rounded-[8px] bg-[var(--bg-well)] text-[var(--ink-secondary)] transition-colors duration-150 hover:text-[var(--ink-primary)]"
                          >
                            <Undo2 className="h-3 w-3" />
                          </button>
                        )}

                        {hasManualEdits && (
                          <button
                            type="button"
                            onClick={handleResetEdits}
                            disabled={isSaving}
                            title="Reset cutout edits"
                            aria-label="Reset cutout edits"
                            className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-[var(--bg-well)] px-2 text-[10px] font-medium tracking-[0.06em] text-[var(--ink-secondary)] uppercase transition-colors duration-150 hover:text-[var(--ink-primary)]"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>Reset</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: Piece Metadata Form */}
          <div className="flex flex-col justify-between p-6 sm:p-7 md:col-span-6">
            <div className="space-y-5">
              <div>
                <label
                  htmlFor="piece-name"
                  className="mb-2 block text-[10px] font-medium tracking-[0.14em] text-[var(--ink-muted)] uppercase"
                >
                  Piece name
                </label>
                <input
                  id="piece-name"
                  type="text"
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Heavyweight Boxy Tee"
                  disabled={isSaving}
                  className="h-11 w-full rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3.5 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-colors duration-150 focus:border-[var(--ink-primary)] focus:bg-[var(--bg-surface)] disabled:opacity-50"
                />
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="block text-[10px] font-medium tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                    Category
                  </span>
                  {semanticReady && !usingOriginalFallback && (
                    <span className="text-[10px] tracking-[0.1em] text-[var(--ink-muted)] uppercase">
                      Instant re-cut
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-1.5">
                  {WARDROBE_CATEGORIES.map((cat) => {
                    const selected = category === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategory(cat)}
                        disabled={isSaving}
                        className={`h-9 rounded-[10px] border px-2.5 text-[12px] font-medium transition-colors duration-150 disabled:opacity-40 ${selected
                          ? "border-[var(--btn-primary-bg)] bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                          : "border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--ink-secondary)] hover:border-[var(--ink-primary)] hover:text-[var(--ink-primary)]"
                          }`}
                      >
                        {CATEGORY_LABELS[cat]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 rounded-[12px] border border-[var(--status-danger-border)] bg-[var(--status-danger-bg)] px-3.5 py-2.5 text-[12px] leading-snug text-[var(--status-danger-ink)]"
                >
                  <span>{error}</span>
                  {stage === "error" && normalizedOriginalBlob && (
                    <div>
                      <button
                        type="button"
                        onClick={handleUseOriginalFallback}
                        className="inline-flex h-7 items-center rounded-[8px] bg-[var(--btn-primary-bg)] px-2.5 text-[11px] font-medium text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)]"
                      >
                        Use Original Photo
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-[var(--border-hairline)] pt-4">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSaving}
                className="h-10 rounded-[12px] px-4 text-[12px] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:bg-[var(--bg-well)] hover:text-[var(--ink-primary)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={stage !== "ready" || isSaving}
                className="inline-flex h-10 items-center gap-2 rounded-[12px] bg-[var(--btn-primary-bg)] px-5 text-[12px] font-medium text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Saving…</span>
                  </>
                ) : (
                  <span>Save to Closet</span>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
