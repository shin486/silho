"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  ImagePlus,
  Loader2,
  RefreshCw,
  Scissors,
  Upload,
  X,
} from "lucide-react";
import { addWardrobeItem } from "@/app/closet/actions";
import {
  CATEGORY_LABELS,
  WARDROBE_CATEGORIES,
  type WardrobeCategory,
} from "@/lib/categories";
import { formatPeso } from "@/lib/utils/costPerWear";
import {
  extractErrorMessage,
  isSupportedImageFile,
  normalizeImageToPngBlob,
} from "@/lib/utils/normalizeImage";

interface UploadCutoutModalProps {
  open: boolean;
  onClose: () => void;
}

type ProcessingStage = "idle" | "processing" | "ready" | "error";

const MAX_NORMALIZED_DIMENSION = 1200;
const MAX_OUTPUT_DIMENSION = 960;

/**
 * Resizes and encodes a garment image Blob into a compact data URL
 * while preserving alpha transparency.
 */
async function compressCutoutToDataUrl(blob: Blob): Promise<string> {
  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(new Error("Could not decode the garment image."));
      element.src = objectUrl;
    });

    const scale = Math.min(
      1,
      MAX_OUTPUT_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight)
    );
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Browser canvas is unavailable.");
    }

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    // WebP preserves transparent alpha at a fraction of PNG payload size; fall back to PNG if unsupported.
    const webpDataUrl = canvas.toDataURL("image/webp", 0.86);
    if (webpDataUrl.startsWith("data:image/webp")) {
      return webpDataUrl;
    }

    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function UploadCutoutModal({ open, onClose }: UploadCutoutModalProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const runIdRef = useRef(0);

  const [name, setName] = useState("");
  const [category, setCategory] = useState<WardrobeCategory>("top");
  const [priceInput, setPriceInput] = useState("");

  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [normalizedOriginalBlob, setNormalizedOriginalBlob] =
    useState<Blob | null>(null);
  const [originalPreviewUrl, setOriginalPreviewUrl] = useState<string | null>(
    null
  );
  const [cutoutBlob, setCutoutBlob] = useState<Blob | null>(null);
  const [cutoutPreviewUrl, setCutoutPreviewUrl] = useState<string | null>(null);
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

  const revokePreviews = useCallback(() => {
    setOriginalPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setCutoutPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const resetModal = useCallback(() => {
    runIdRef.current += 1;
    revokePreviews();
    setName("");
    setCategory("top");
    setPriceInput("");
    setSourceFile(null);
    setNormalizedOriginalBlob(null);
    setCutoutBlob(null);
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

  const runBackgroundRemoval = useCallback(async (file: File) => {
    const currentRunId = ++runIdRef.current;

    setError(null);
    setStage("processing");
    setUsingOriginalFallback(false);
    setStatusLabel("Normalizing image for browser cutout…");
    setProgressPercent(null);
    setCutoutBlob(null);
    setCutoutPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    // Step 1: Pre-normalize onto an offscreen canvas (max 1200px, clean PNG Blob)
    let normalizedBlob: Blob;
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

    // Step 2: Run browser-only @imgly/background-removal on the normalized PNG Blob
    setStatusLabel("Loading background removal model (first run)…");

    try {
      const { removeBackground } = await import("@imgly/background-removal");

      const resultBlob = await removeBackground(normalizedBlob, {
        output: {
          format: "image/png",
          quality: 0.9,
        },
        progress: (key, current, total) => {
          if (runIdRef.current !== currentRunId) return;

          if (key.startsWith("fetch:")) {
            setStatusLabel("Downloading WASM/ONNX model (first run)…");
          } else if (key.startsWith("compute:")) {
            setStatusLabel("Isolating garment silhouette…");
          } else {
            setStatusLabel("Refining cutout edges…");
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

      const nextCutoutUrl = URL.createObjectURL(resultBlob);
      setCutoutBlob(resultBlob);
      setCutoutPreviewUrl(nextCutoutUrl);
      setPreviewMode("cutout");
      setStage("ready");
      setProgressPercent(100);
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
    }
  }, []);

  const handleUseOriginalFallback = useCallback(() => {
    if (!normalizedOriginalBlob) return;
    const fallbackUrl = URL.createObjectURL(normalizedOriginalBlob);
    setCutoutBlob(normalizedOriginalBlob);
    setCutoutPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return fallbackUrl;
    });
    setUsingOriginalFallback(true);
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
        const cleanedBaseName = file.name
          .replace(/\.[^.]+$/, "")
          .replace(/[-_]+/g, " ")
          .trim();
        if (cleanedBaseName && cleanedBaseName.length <= 60) {
          setName(cleanedBaseName);
        }
      }

      void runBackgroundRemoval(file);
    },
    [name, runBackgroundRemoval]
  );

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

    if (!cutoutBlob) {
      setError("Upload a garment photo and wait for processing to finish.");
      return;
    }

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Enter a name for this piece.");
      return;
    }

    const trimmedPrice = priceInput.trim();
    const parsedPrice =
      trimmedPrice === "" ? null : Number.parseFloat(trimmedPrice);
    if (
      parsedPrice !== null &&
      (!Number.isFinite(parsedPrice) || parsedPrice < 0)
    ) {
      setError("Enter a valid purchase price in PHP, or leave blank.");
      return;
    }

    setIsSaving(true);

    try {
      // TODO: swap for Neon Object Storage / Cloudinary
      const compressedDataUrl = await compressCutoutToDataUrl(cutoutBlob);

      const result = await addWardrobeItem({
        name: trimmedName,
        category,
        price: parsedPrice,
        imageUrl: compressedDataUrl,
      });

      if (!result.ok) {
        setError(result.error || "Could not save piece. Please try again.");
        setIsSaving(false);
        return;
      }

      resetModal();
      onClose();
      router.refresh();
    } catch (err) {
      console.error("[UploadCutoutModal] save failed:", err);
      setError("Could not encode or save this image. Try again.");
      setIsSaving(false);
    }
  }

  if (!open) return null;

  const parsedPricePreview = Number.parseFloat(priceInput.trim());
  const hasValidPrice =
    priceInput.trim() !== "" &&
    Number.isFinite(parsedPricePreview) &&
    parsedPricePreview > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111111]/45 p-4 backdrop-blur-[2px]"
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
        className="flex max-h-[92vh] w-full max-w-[820px] flex-col overflow-hidden border border-[#E5E5E5] bg-white shadow-[0_24px_60px_rgba(17,17,17,0.16)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#E5E5E5] px-6 py-4">
          <div>
            <h2
              id="add-piece-title"
              className="text-[15px] font-medium text-[#111111]"
            >
              Add Wardrobe Piece
            </h2>
            <p className="mt-0.5 text-[12px] text-[#525252]">
              Images are normalized to 1200px PNG before browser cutout.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            disabled={isSaving}
            aria-label="Close modal"
            className="flex h-8 w-8 items-center justify-center border border-transparent text-[#525252] transition-colors hover:border-[#E5E5E5] hover:text-[#111111] disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 overflow-y-auto md:grid-cols-12"
        >
          {/* Left: Upload & Transparent Cutout Preview */}
          <div className="border-b border-[#E5E5E5] bg-[#FAFAFA] p-6 md:col-span-6 md:border-r md:border-b-0">
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
                className={`flex aspect-[4/5] w-full cursor-pointer flex-col items-center justify-center border border-dashed px-6 text-center transition-colors ${
                  isDragging
                    ? "border-[#111111] bg-[#F4F4F3]"
                    : "border-[#CCCCCC] bg-white hover:border-[#111111]"
                }`}
              >
                <div className="flex h-11 w-11 items-center justify-center border border-[#E5E5E5] bg-[#FAFAFA] text-[#111111]">
                  <Upload className="h-4 w-4" strokeWidth={1.5} />
                </div>
                <p className="mt-4 text-[13px] font-medium text-[#111111]">
                  Upload garment photo
                </p>
                <p className="mt-1 max-w-[24ch] text-[12px] leading-relaxed text-[#525252]">
                  Drop a flat-lay or store photo, or click to browse PNG, JPG,
                  WebP, or AVIF.
                </p>
                <span className="mt-4 inline-flex items-center gap-1.5 border border-[#E5E5E5] px-2.5 py-1 text-[11px] text-[#525252]">
                  <Scissors className="h-3 w-3" />
                  Auto cutout via WASM
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div
                  className={`relative flex aspect-[4/5] w-full items-center justify-center overflow-hidden border border-[#E5E5E5] ${
                    stage === "ready" &&
                    previewMode === "cutout" &&
                    !usingOriginalFallback
                      ? "cutout-checkerboard"
                      : "bg-[#F4F4F3]"
                  }`}
                >
                  {stage === "processing" && (
                    <>
                      {originalPreviewUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={originalPreviewUrl}
                          alt="Original garment upload"
                          className="max-h-full max-w-full object-contain p-6 opacity-35 blur-[2px]"
                        />
                      )}
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/80 px-6 text-center backdrop-blur-[1px]">
                        <Loader2 className="h-5 w-5 animate-spin text-[#111111]" />
                        <p className="mt-3 text-[13px] font-medium text-[#111111]">
                          {statusLabel || "Removing background…"}
                        </p>
                        <div className="mt-3 h-[2px] w-48 overflow-hidden bg-[#E5E5E5]">
                          {progressPercent !== null ? (
                            <div
                              className="h-full bg-[#111111] transition-[width] duration-200"
                              style={{ width: `${progressPercent}%` }}
                            />
                          ) : (
                            <div className="h-full w-1/3 animate-pulse bg-[#111111]" />
                          )}
                        </div>
                        <p className="mt-2 text-[11px] text-[#525252] tabular-nums">
                          {progressPercent !== null
                            ? `${progressPercent}% · First run downloads WASM/ONNX weights`
                            : "First run downloads WASM/ONNX model to browser cache"}
                        </p>
                      </div>
                    </>
                  )}

                  {stage === "ready" && (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      src={
                        previewMode === "cutout" && !usingOriginalFallback
                          ? cutoutPreviewUrl ?? ""
                          : originalPreviewUrl ?? cutoutPreviewUrl ?? ""
                      }
                      alt={
                        previewMode === "cutout" && !usingOriginalFallback
                          ? "Transparent PNG garment cutout"
                          : "Normalized original garment photo"
                      }
                      className={`max-h-full max-w-full object-contain p-5 ${
                        previewMode === "cutout" && !usingOriginalFallback
                          ? "drop-shadow-[0_12px_20px_rgba(17,17,17,0.12)]"
                          : ""
                      }`}
                    />
                  )}

                  {stage === "error" && (
                    <div className="relative flex h-full w-full flex-col items-center justify-center px-6 text-center">
                      {originalPreviewUrl && (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          src={originalPreviewUrl}
                          alt="Normalized garment preview"
                          className="mb-4 max-h-40 object-contain opacity-80"
                        />
                      )}
                      <p className="text-[13px] font-medium text-[#111111]">
                        Background removal failed
                      </p>
                      <p className="mt-1 max-w-[28ch] text-[12px] text-[#525252]">
                        Use the normalized original photo or retry cutout.
                      </p>
                      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                        {normalizedOriginalBlob && (
                          <button
                            type="button"
                            onClick={handleUseOriginalFallback}
                            className="inline-flex h-8 items-center gap-1.5 bg-[#111111] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
                          >
                            <span>Use Original Photo</span>
                          </button>
                        )}
                        {sourceFile && (
                          <button
                            type="button"
                            onClick={() => void runBackgroundRemoval(sourceFile)}
                            className="inline-flex h-8 items-center gap-1.5 border border-[#E5E5E5] bg-white px-3 text-[12px] font-medium text-[#111111] transition-colors hover:border-[#111111]"
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                            <span>Retry cutout</span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Preview toolbar */}
                <div className="flex items-center justify-between gap-2">
                  {stage === "ready" && !usingOriginalFallback ? (
                    <div className="inline-flex border border-[#E5E5E5] bg-white">
                      <button
                        type="button"
                        onClick={() => setPreviewMode("cutout")}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          previewMode === "cutout"
                            ? "bg-[#111111] text-white"
                            : "text-[#525252] hover:text-[#111111]"
                        }`}
                      >
                        Cutout PNG
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewMode("original")}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          previewMode === "original"
                            ? "bg-[#111111] text-white"
                            : "text-[#525252] hover:text-[#111111]"
                        }`}
                      >
                        Original
                      </button>
                    </div>
                  ) : (
                    <span className="truncate text-[11px] text-[#6B6B6B]">
                      {usingOriginalFallback
                        ? "Using normalized original photo"
                        : sourceFile?.name}
                    </span>
                  )}

                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={stage === "processing" || isSaving}
                    className="inline-flex shrink-0 items-center gap-1.5 border border-[#E5E5E5] bg-white px-2.5 py-1 text-[11px] font-medium text-[#111111] transition-colors hover:border-[#111111] disabled:opacity-40"
                  >
                    <ImagePlus className="h-3 w-3" />
                    <span>Replace</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Right: Piece Metadata Form */}
          <div className="flex flex-col justify-between p-6 md:col-span-6">
            <div className="space-y-5">
              <div>
                <label
                  htmlFor="piece-name"
                  className="mb-1.5 block text-[12px] font-medium text-[#111111]"
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
                  className="h-10 w-full border border-[#E5E5E5] bg-white px-3 text-[14px] text-[#111111] placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA]"
                />
              </div>

              <div>
                <span className="mb-1.5 block text-[12px] font-medium text-[#111111]">
                  Category
                </span>
                <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-3">
                  {WARDROBE_CATEGORIES.map((cat) => {
                    const selected = category === cat;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategory(cat)}
                        disabled={isSaving}
                        className={`h-9 border px-2.5 text-[12px] font-medium transition-colors ${
                          selected
                            ? "border-[#111111] bg-[#111111] text-white"
                            : "border-[#E5E5E5] bg-white text-[#525252] hover:border-[#111111] hover:text-[#111111]"
                        }`}
                      >
                        {CATEGORY_LABELS[cat]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <label
                    htmlFor="piece-price"
                    className="block text-[12px] font-medium text-[#111111]"
                  >
                    Purchase price (PHP)
                  </label>
                  <span className="text-[11px] text-[#6B6B6B]">Optional</span>
                </div>
                <div className="relative flex items-center">
                  <span className="pointer-events-none absolute left-3 text-[14px] text-[#525252]">
                    ₱
                  </span>
                  <input
                    id="piece-price"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={priceInput}
                    onChange={(e) => setPriceInput(e.target.value)}
                    placeholder="1490 (leave blank for try-on only)"
                    disabled={isSaving}
                    className="h-10 w-full border border-[#E5E5E5] bg-white py-2 pr-3 pl-7 text-[14px] text-[#111111] tabular-nums placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA]"
                  />
                </div>
              </div>

              <div className="border-t border-[#E5E5E5] pt-4">
                <div className="flex items-baseline justify-between text-[12px]">
                  <span className="text-[#525252]">Initial cost / wear</span>
                  <span className="font-medium text-[#111111] tabular-nums">
                    {hasValidPrice
                      ? `${formatPeso(parsedPricePreview)}/wear`
                      : "Not tracked"}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-[#6B6B6B]">
                  {hasValidPrice
                    ? "Updates automatically each time you log a wear."
                    : "Leave price blank to skip the ₱/wear badge and try on right away."}
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 border border-[#DC2626]/30 bg-[#FEF2F2] px-3 py-2.5 text-[12px] leading-snug text-[#991B1B]"
                >
                  <span>{error}</span>
                  {stage === "error" && normalizedOriginalBlob && (
                    <div>
                      <button
                        type="button"
                        onClick={handleUseOriginalFallback}
                        className="inline-flex h-7 items-center bg-[#111111] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#262626]"
                      >
                        Use Original Photo
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-[#E5E5E5] pt-4">
              <button
                type="button"
                onClick={handleClose}
                disabled={isSaving}
                className="h-9 border border-[#E5E5E5] bg-white px-4 text-[12px] font-medium text-[#525252] transition-colors hover:border-[#111111] hover:text-[#111111] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={stage !== "ready" || isSaving}
                className="inline-flex h-9 items-center gap-2 bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626] disabled:cursor-not-allowed disabled:opacity-40"
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
