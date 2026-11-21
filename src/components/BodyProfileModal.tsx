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
import Cropper, { type Area, type Point } from "react-easy-crop";
import "react-easy-crop/react-easy-crop.css";
import {
  Check,
  ImagePlus,
  Loader2,
  Scissors,
  Upload,
  UserRound,
  X,
  ZoomIn,
} from "lucide-react";
import { upsertBodyProfile } from "@/app/canvas/actions";
import type { BodyProfileDTO } from "@/lib/canvas";
import {
  PREFERRED_FITS,
  PREFERRED_FIT_LABELS,
  type PreferredFit,
} from "@/lib/fitPreferences";
import {
  PRESET_MODELS,
  isPresetModelUrl,
  type PresetModel,
} from "@/lib/presetModels";
import {
  extractErrorMessage,
  isSupportedImageFile,
  normalizeImageToPngBlob,
} from "@/lib/utils/normalizeImage";

interface BodyProfileModalProps {
  open: boolean;
  initialProfile: BodyProfileDTO | null;
  onClose: () => void;
  onSaved: (profile: BodyProfileDTO) => void;
}

type ModalTab = "upload" | "presets";
type BackgroundMode = "original" | "cutout";

const STUDIO_WIDTH = 768;
const STUDIO_HEIGHT = 1024;
const STUDIO_BG = "#FAFAFA";
const VERTICAL_MARGIN_RATIO = 0.09;
const HORIZONTAL_MARGIN_RATIO = 0.08;
const ALPHA_THRESHOLD = 16;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = src;
  });
}

/**
 * Crops the source image using react-easy-crop pixel coordinates onto an
 * offscreen 768x1024 (3:4) HTML canvas.
 */
async function renderCroppedCanvas(
  imageSrc: string,
  cropPixels: Area
): Promise<HTMLCanvasElement> {
  const img = await loadImage(imageSrc);
  const canvas = document.createElement("canvas");
  canvas.width = STUDIO_WIDTH;
  canvas.height = STUDIO_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Browser canvas is unavailable.");
  }

  ctx.fillStyle = STUDIO_BG;
  ctx.fillRect(0, 0, STUDIO_WIDTH, STUDIO_HEIGHT);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(
    img,
    cropPixels.x,
    cropPixels.y,
    cropPixels.width,
    cropPixels.height,
    0,
    0,
    STUDIO_WIDTH,
    STUDIO_HEIGHT
  );

  return canvas;
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Could not encode cropped image."));
        }
      },
      mimeType,
      quality
    );
  });
}

/**
 * Auto-trims transparent padding from a cutout Blob and composites it centered
 * onto a clean 768x1024 (3:4) #FAFAFA studio canvas as a 0.9 quality JPEG.
 */
async function composeStudioCutoutAvatar(cutoutBlob: Blob): Promise<string> {
  const objectUrl = URL.createObjectURL(cutoutBlob);

  try {
    const img = await loadImage(objectUrl);
    const srcW = Math.max(1, img.naturalWidth);
    const srcH = Math.max(1, img.naturalHeight);

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = srcW;
    tmpCanvas.height = srcH;
    const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
    if (!tmpCtx) {
      throw new Error("Browser canvas is unavailable.");
    }

    tmpCtx.clearRect(0, 0, srcW, srcH);
    tmpCtx.drawImage(img, 0, 0, srcW, srcH);

    const { data } = tmpCtx.getImageData(0, 0, srcW, srcH);
    let minX = srcW;
    let minY = srcH;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < srcH; y++) {
      const rowOffset = y * srcW * 4;
      for (let x = 0; x < srcW; x++) {
        if (data[rowOffset + x * 4 + 3] > ALPHA_THRESHOLD) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    if (maxX < minX || maxY < minY) {
      minX = 0;
      minY = 0;
      maxX = srcW - 1;
      maxY = srcH - 1;
    }

    const cropW = maxX - minX + 1;
    const cropH = maxY - minY + 1;

    const studioCanvas = document.createElement("canvas");
    studioCanvas.width = STUDIO_WIDTH;
    studioCanvas.height = STUDIO_HEIGHT;
    const studioCtx = studioCanvas.getContext("2d");
    if (!studioCtx) {
      throw new Error("Browser canvas is unavailable.");
    }

    studioCtx.fillStyle = STUDIO_BG;
    studioCtx.fillRect(0, 0, STUDIO_WIDTH, STUDIO_HEIGHT);

    const maxDrawW = STUDIO_WIDTH * (1 - HORIZONTAL_MARGIN_RATIO * 2);
    const maxDrawH = STUDIO_HEIGHT * (1 - VERTICAL_MARGIN_RATIO * 2);
    const scale = Math.min(maxDrawW / cropW, maxDrawH / cropH);

    const drawW = Math.max(1, Math.round(cropW * scale));
    const drawH = Math.max(1, Math.round(cropH * scale));
    const drawX = Math.round((STUDIO_WIDTH - drawW) / 2);
    const drawY = Math.round((STUDIO_HEIGHT - drawH) / 2);

    studioCtx.imageSmoothingEnabled = true;
    studioCtx.imageSmoothingQuality = "high";
    studioCtx.drawImage(
      tmpCanvas,
      minX,
      minY,
      cropW,
      cropH,
      drawX,
      drawY,
      drawW,
      drawH
    );

    // TODO: swap for Cloudinary/Object Storage
    return studioCanvas.toDataURL("image/jpeg", 0.9);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function BodyProfileModal({
  open,
  initialProfile,
  onClose,
  onSaved,
}: BodyProfileModalProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [activeTab, setActiveTab] = useState<ModalTab>("upload");

  // Tab A (Upload + Cropper) state
  const [savedCustomAvatarUrl, setSavedCustomAvatarUrl] = useState<string>("");
  const [cropSourceUrl, setCropSourceUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null);
  const [backgroundMode, setBackgroundMode] =
    useState<BackgroundMode>("original");
  const [isDragging, setIsDragging] = useState(false);

  // Tab B (Preset Models) state
  const [selectedPresetUrl, setSelectedPresetUrl] = useState<string>(
    PRESET_MODELS[0].avatarUrl
  );

  // Shared measurements
  const [heightInput, setHeightInput] = useState("");
  const [weightInput, setWeightInput] = useState("");
  const [preferredFit, setPreferredFit] = useState<PreferredFit>("regular");

  // Save / processing status
  const [isSaving, setIsSaving] = useState(false);
  const [processingLabel, setProcessingLabel] = useState("");
  const [processingPercent, setProcessingPercent] = useState<number | null>(
    null
  );
  const [fallbackAvatarDataUrl, setFallbackAvatarDataUrl] = useState<
    string | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const revokeCropSource = useCallback(() => {
    setCropSourceUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    revokeCropSource();
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setCroppedAreaPixels(null);
    setBackgroundMode("original");
    setIsDragging(false);
    setIsSaving(false);
    setProcessingLabel("");
    setProcessingPercent(null);
    setFallbackAvatarDataUrl(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    const existingUrl = initialProfile?.avatarUrl ?? "";
    const existingIsPreset = isPresetModelUrl(existingUrl);

    if (existingIsPreset) {
      setActiveTab("presets");
      setSelectedPresetUrl(existingUrl);
      setSavedCustomAvatarUrl("");
    } else {
      setActiveTab("upload");
      setSelectedPresetUrl(PRESET_MODELS[0].avatarUrl);
      setSavedCustomAvatarUrl(existingUrl);
    }

    setHeightInput(initialProfile ? String(initialProfile.heightCm) : "");
    setWeightInput(initialProfile ? String(initialProfile.weightKg) : "");
    setPreferredFit(initialProfile?.preferredFit ?? "regular");
  }, [open, initialProfile, revokeCropSource]);

  useEffect(() => {
    return () => {
      revokeCropSource();
    };
  }, [revokeCropSource]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    revokeCropSource();
    onClose();
  }, [isSaving, onClose, revokeCropSource]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        handleClose();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, handleClose]);

  const handleFileSelected = useCallback((file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    setFallbackAvatarDataUrl(null);

    if (!isSupportedImageFile(file)) {
      setError("Choose a PNG, JPG, WebP, or AVIF full-body photo.");
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      setError("Photo exceeds 20 MB. Choose a smaller image.");
      return;
    }

    void (async () => {
      try {
        // Pre-normalize dragged/selected files (handles .avif/.webp and huge phone photos cleanly)
        const normalizedPngBlob = await normalizeImageToPngBlob(file, 1200);
        const nextObjectUrl = URL.createObjectURL(normalizedPngBlob);
        setCropSourceUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextObjectUrl;
        });
        setCrop({ x: 0, y: 0 });
        setZoom(1);
        setCroppedAreaPixels(null);
      } catch (normErr) {
        console.error(
          "[BodyProfileModal] Image pre-normalization failed:",
          normErr
        );
        setError(
          `Could not read this photo (${extractErrorMessage(normErr)}). Try another PNG, JPG, or WebP.`
        );
      }
    })();
  }, []);

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    handleFileSelected(event.target.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    handleFileSelected(event.dataTransfer.files?.[0]);
  }

  function handleSelectPreset(model: PresetModel) {
    setError(null);
    setSelectedPresetUrl(model.avatarUrl);
    setHeightInput(String(model.heightCm));
    setWeightInput(String(model.weightKg));
    setPreferredFit(model.preferredFit);
  }

  function handleSwitchTab(tab: ModalTab) {
    if (isSaving) return;
    setError(null);
    setActiveTab(tab);

    if (tab === "presets" && !heightInput && !weightInput) {
      const currentPreset =
        PRESET_MODELS.find((m) => m.avatarUrl === selectedPresetUrl) ??
        PRESET_MODELS[0];
      setHeightInput(String(currentPreset.heightCm));
      setWeightInput(String(currentPreset.weightKg));
      setPreferredFit(currentPreset.preferredFit);
    }
  }

  async function persistProfile(
    avatarUrlToSave: string,
    heightCm: number,
    weightKg: number
  ) {
    setProcessingLabel("Saving profile…");
    const result = await upsertBodyProfile({
      avatarUrl: avatarUrlToSave,
      heightCm,
      weightKg,
      preferredFit,
    });

    if (!result.ok || !result.data) {
      setError(result.error || "Could not save your Body Profile.");
      setIsSaving(false);
      setProcessingLabel("");
      return;
    }

    setFallbackAvatarDataUrl(null);
    revokeCropSource();
    onSaved(result.data);
    onClose();
    router.refresh();
  }

  async function handleUseOriginalFallback() {
    if (!fallbackAvatarDataUrl || isSaving) return;
    setError(null);

    const heightCm = Number.parseInt(heightInput, 10);
    const weightKg = Number.parseInt(weightInput, 10);
    if (
      !Number.isFinite(heightCm) ||
      heightCm < 100 ||
      heightCm > 250 ||
      !Number.isFinite(weightKg) ||
      weightKg < 30 ||
      weightKg > 250
    ) {
      setError("Enter valid height (100–250 cm) and weight (30–250 kg).");
      return;
    }

    setBackgroundMode("original");
    setIsSaving(true);
    try {
      await persistProfile(fallbackAvatarDataUrl, heightCm, weightKg);
    } catch (err) {
      console.error("[BodyProfileModal] fallback save failed:", err);
      setError(
        `Could not save your photo (${extractErrorMessage(err)}). Please try again.`
      );
      setIsSaving(false);
      setProcessingLabel("");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFallbackAvatarDataUrl(null);

    const heightCm = Number.parseInt(heightInput, 10);
    if (!Number.isFinite(heightCm) || heightCm < 100 || heightCm > 250) {
      setError("Enter a height between 100 and 250 cm.");
      return;
    }

    const weightKg = Number.parseInt(weightInput, 10);
    if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 250) {
      setError("Enter a weight between 30 and 250 kg.");
      return;
    }

    let finalAvatarUrl = "";

    if (activeTab === "presets") {
      if (!isPresetModelUrl(selectedPresetUrl)) {
        setError("Select one of the preset studio models.");
        return;
      }
      finalAvatarUrl = selectedPresetUrl;
    } else if (!cropSourceUrl && !savedCustomAvatarUrl) {
      setError("Upload a full-body photo or switch to Preset Models.");
      return;
    }

    setIsSaving(true);
    setProcessingPercent(null);

    let croppedOriginalJpeg: string | null = null;

    try {
      if (activeTab === "upload") {
        if (cropSourceUrl && croppedAreaPixels) {
          setProcessingLabel("Framing 3:4 portrait (768×1024)…");
          const croppedCanvas = await renderCroppedCanvas(
            cropSourceUrl,
            croppedAreaPixels
          );
          // TODO: swap for Cloudinary/Object Storage
          croppedOriginalJpeg = croppedCanvas.toDataURL("image/jpeg", 0.9);

          if (backgroundMode === "cutout") {
            setProcessingLabel("Normalizing portrait for cutout…");
            const croppedPngBlob = await canvasToBlob(
              croppedCanvas,
              "image/png"
            );
            const normalizedPngBlob = await normalizeImageToPngBlob(
              croppedPngBlob,
              1200
            );

            setProcessingLabel("Creating your Studio Avatar…");

            // Strictly browser-only dynamic import so SSR never touches WASM/ONNX.
            const { removeBackground } = await import(
              "@imgly/background-removal"
            );

            const cutoutBlob = await removeBackground(normalizedPngBlob, {
              output: { format: "image/png", quality: 0.9 },
              progress: (key, current, total) => {
                if (key.startsWith("fetch:")) {
                  setProcessingLabel(
                    "Downloading cutout model (first run)…"
                  );
                } else if (key.startsWith("compute:")) {
                  setProcessingLabel("Creating your Studio Avatar…");
                }

                if (total > 0) {
                  setProcessingPercent(
                    Math.min(100, Math.max(0, Math.round((current / total) * 100)))
                  );
                } else {
                  setProcessingPercent(null);
                }
              },
            });

            setProcessingLabel("Compositing #FAFAFA studio backdrop…");
            finalAvatarUrl = await composeStudioCutoutAvatar(cutoutBlob);
          } else {
            finalAvatarUrl = croppedOriginalJpeg;
          }
        } else {
          finalAvatarUrl = savedCustomAvatarUrl;
        }
      }

      await persistProfile(finalAvatarUrl, heightCm, weightKg);
    } catch (err) {
      console.error(
        "[BodyProfileModal] @imgly/background-removal or save failed:",
        err
      );
      const detail = extractErrorMessage(err);
      if (backgroundMode === "cutout" && croppedOriginalJpeg) {
        setFallbackAvatarDataUrl(croppedOriginalJpeg);
        setError(
          `Studio Cutout failed (${detail}). Retry or continue with your cropped original photo.`
        );
      } else {
        setError(`Could not process or save your photo (${detail}).`);
      }
      setIsSaving(false);
      setProcessingLabel("");
      setProcessingPercent(null);
    }
  }

  if (!open) return null;

  const canSubmit =
    !isSaving &&
    (activeTab === "presets"
      ? Boolean(selectedPresetUrl)
      : Boolean(cropSourceUrl && croppedAreaPixels) ||
        Boolean(savedCustomAvatarUrl));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#111111]/45 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          handleClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="body-profile-title"
        className="flex max-h-[92vh] w-full max-w-[840px] flex-col overflow-hidden border border-[#E5E5E5] bg-white shadow-[0_24px_60px_rgba(17,17,17,0.16)]"
      >
        {/* Header + Tabs */}
        <div className="border-b border-[#E5E5E5] px-6 pt-4">
          <div className="flex items-start justify-between gap-4 pb-3.5">
            <div>
              <h2
                id="body-profile-title"
                className="text-[15px] font-medium text-[#111111]"
              >
                {initialProfile ? "Edit Body Profile" : "Set Up Body Profile"}
              </h2>
              <p className="mt-0.5 text-[12px] text-[#525252]">
                Frame your own 3:4 portrait or choose a preset studio model.
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

          <div
            role="tablist"
            aria-label="Model source"
            className="flex items-center gap-6"
          >
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "upload"}
              onClick={() => handleSwitchTab("upload")}
              disabled={isSaving}
              className={`relative pb-2.5 text-[12px] font-medium transition-colors ${
                activeTab === "upload"
                  ? "text-[#111111]"
                  : "text-[#6B6B6B] hover:text-[#111111]"
              }`}
            >
              Upload My Photo
              {activeTab === "upload" && (
                <span className="absolute inset-x-0 bottom-0 h-[1.5px] bg-[#111111]" />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "presets"}
              onClick={() => handleSwitchTab("presets")}
              disabled={isSaving}
              className={`relative pb-2.5 text-[12px] font-medium transition-colors ${
                activeTab === "presets"
                  ? "text-[#111111]"
                  : "text-[#6B6B6B] hover:text-[#111111]"
              }`}
            >
              Preset Models
              {activeTab === "presets" && (
                <span className="absolute inset-x-0 bottom-0 h-[1.5px] bg-[#111111]" />
              )}
            </button>
          </div>
        </div>

        {/* Body */}
        <form
          onSubmit={handleSubmit}
          className="grid grid-cols-1 overflow-y-auto md:grid-cols-12"
        >
          {/* Left Panel: Upload Cropper OR Preset Models */}
          <div className="border-b border-[#E5E5E5] bg-[#FAFAFA] p-6 md:col-span-7 md:border-r md:border-b-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleInputChange}
              className="hidden"
            />

            {activeTab === "upload" ? (
              cropSourceUrl ? (
                <div className="flex flex-col gap-3.5">
                  {/* 3:4 Interactive Crop Container + Ghost Silhouette SVG */}
                  <div className="relative mx-auto aspect-[3/4] w-full max-w-[330px] overflow-hidden border border-[#E5E5E5] bg-[#1A1A1A]">
                    <Cropper
                      image={cropSourceUrl}
                      crop={crop}
                      zoom={zoom}
                      minZoom={1}
                      maxZoom={3}
                      aspect={3 / 4}
                      showGrid={false}
                      onCropChange={setCrop}
                      onZoomChange={setZoom}
                      onCropComplete={(_area, pixels) =>
                        setCroppedAreaPixels(pixels)
                      }
                    />

                    {/* Faint non-interactive Ghost Silhouette guide aligned 1:1 with the 3:4 crop frame */}
                    <GhostSilhouetteOverlay />

                    {isSaving && (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-white/85 px-6 text-center backdrop-blur-[2px]">
                        <Loader2 className="h-5 w-5 animate-spin text-[#111111]" />
                        <p className="mt-3 text-[13px] font-medium text-[#111111]">
                          {processingLabel || "Processing portrait…"}
                        </p>
                        {processingPercent !== null && (
                          <div className="mt-3 w-40">
                            <div className="h-[2px] w-full overflow-hidden bg-[#E5E5E5]">
                              <div
                                className="h-full bg-[#111111] transition-[width] duration-200"
                                style={{ width: `${processingPercent}%` }}
                              />
                            </div>
                            <p className="mt-1.5 text-[11px] text-[#525252] tabular-nums">
                              {processingPercent}%
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Zoom Slider + Replace */}
                  <div className="mx-auto flex w-full max-w-[330px] items-center gap-3">
                    <ZoomIn className="h-3.5 w-3.5 shrink-0 text-[#525252]" />
                    <input
                      type="range"
                      aria-label="Zoom photo"
                      min={1}
                      max={3}
                      step={0.05}
                      value={zoom}
                      disabled={isSaving}
                      onChange={(e) =>
                        setZoom(Number.parseFloat(e.target.value))
                      }
                      className="h-1 flex-1 cursor-pointer appearance-none bg-[#D4D4D4] accent-[#111111] disabled:opacity-40"
                    />
                    <span className="w-9 text-right text-[11px] text-[#525252] tabular-nums">
                      {zoom.toFixed(1)}×
                    </span>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isSaving}
                      className="inline-flex h-7 items-center gap-1 border border-[#E5E5E5] bg-white px-2 text-[11px] font-medium text-[#111111] transition-colors hover:border-[#111111] disabled:opacity-40"
                    >
                      <ImagePlus className="h-3 w-3" />
                      <span>Replace</span>
                    </button>
                  </div>

                  {/* Background Processing Toggle */}
                  <div className="mx-auto w-full max-w-[330px]">
                    <span className="mb-1.5 block text-[11px] font-medium text-[#525252]">
                      Background handling on save
                    </span>
                    <div
                      role="group"
                      aria-label="Background mode"
                      className="grid grid-cols-2 border border-[#E5E5E5] bg-white p-0.5"
                    >
                      <button
                        type="button"
                        onClick={() => setBackgroundMode("original")}
                        disabled={isSaving}
                        className={`flex h-8 items-center justify-center px-2 text-[11px] font-medium transition-colors ${
                          backgroundMode === "original"
                            ? "bg-[#111111] text-white"
                            : "text-[#525252] hover:text-[#111111]"
                        }`}
                      >
                        Keep Original Background
                      </button>
                      <button
                        type="button"
                        onClick={() => setBackgroundMode("cutout")}
                        disabled={isSaving}
                        className={`flex h-8 items-center justify-center gap-1 px-2 text-[11px] font-medium transition-colors ${
                          backgroundMode === "cutout"
                            ? "bg-[#111111] text-white"
                            : "text-[#525252] hover:text-[#111111]"
                        }`}
                      >
                        <Scissors className="h-3 w-3" />
                        <span>Studio Cutout (#FAFAFA)</span>
                      </button>
                    </div>
                  </div>
                </div>
              ) : savedCustomAvatarUrl ? (
                <div className="mx-auto flex w-full max-w-[330px] flex-col gap-3">
                  <div className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden border border-[#E5E5E5] bg-[#FAFAFA]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={savedCustomAvatarUrl}
                      alt="Current saved Body Profile portrait"
                      className="h-full w-full object-contain"
                    />
                    <span className="absolute top-2.5 left-2.5 border border-[#E5E5E5] bg-white/95 px-2 py-0.5 text-[10px] font-medium tracking-[0.06em] text-[#525252] uppercase">
                      Current 3:4 Portrait
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isSaving}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 border border-[#E5E5E5] bg-white px-3 text-[12px] font-medium text-[#111111] transition-colors hover:border-[#111111] disabled:opacity-40"
                  >
                    <ImagePlus className="h-3.5 w-3.5" />
                    <span>Upload &amp; Re-frame New Photo</span>
                  </button>
                </div>
              ) : (
                <div className="mx-auto w-full max-w-[330px]">
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
                    className={`flex aspect-[3/4] w-full cursor-pointer flex-col items-center justify-center border border-dashed px-6 text-center transition-colors ${
                      isDragging
                        ? "border-[#111111] bg-[#F4F4F3]"
                        : "border-[#CCCCCC] bg-white hover:border-[#111111]"
                    }`}
                  >
                    <div className="flex h-11 w-11 items-center justify-center border border-[#E5E5E5] bg-[#FAFAFA] text-[#111111]">
                      <Upload className="h-4 w-4" strokeWidth={1.5} />
                    </div>
                    <p className="mt-4 text-[13px] font-medium text-[#111111]">
                      Upload full-body photo
                    </p>
                    <p className="mt-1 max-w-[26ch] text-[12px] leading-relaxed text-[#525252]">
                      Drag and zoom inside our 3:4 ghost guide before saving.
                    </p>
                  </div>
                </div>
              )
            ) : (
              /* Tab B: Preset Studio Models */
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-3 gap-3">
                  {PRESET_MODELS.map((model) => {
                    const isSelected = selectedPresetUrl === model.avatarUrl;
                    return (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => handleSelectPreset(model)}
                        disabled={isSaving}
                        className={`group flex flex-col border text-left transition-colors ${
                          isSelected
                            ? "border-[#111111] bg-white"
                            : "border-[#E5E5E5] bg-white hover:border-[#A3A3A3]"
                        }`}
                      >
                        <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F4F4F3]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={model.avatarUrl}
                            alt={`${model.name} studio preset`}
                            className="h-full w-full object-cover object-top"
                          />
                          {isSelected && (
                            <span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center bg-[#111111] text-white">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </div>
                        <div className="border-t border-[#E5E5E5] p-2.5">
                          <div className="text-[12px] font-medium text-[#111111]">
                            {model.name}
                          </div>
                          <div className="mt-0.5 text-[10px] leading-snug text-[#525252] tabular-nums">
                            {model.summary}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] leading-relaxed text-[#6B6B6B]">
                  Front-facing 3:4 studio models pre-calibrated for clean
                  garment draping.
                </p>
              </div>
            )}

            {activeTab === "upload" && (
              <p className="mx-auto mt-3 max-w-[330px] text-[11px] leading-relaxed text-[#6B6B6B]">
                Stand facing forward in even indoor lighting for the cleanest
                fit.
              </p>
            )}
          </div>

          {/* Right Panel: Measurements & Fit */}
          <div className="flex flex-col justify-between p-6 md:col-span-5">
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="profile-height"
                    className="mb-1.5 block text-[12px] font-medium text-[#111111]"
                  >
                    Height (cm)
                  </label>
                  <div className="relative flex items-center">
                    <input
                      id="profile-height"
                      type="number"
                      inputMode="numeric"
                      min={100}
                      max={250}
                      required
                      value={heightInput}
                      onChange={(e) => setHeightInput(e.target.value)}
                      placeholder="172"
                      disabled={isSaving}
                      className="h-10 w-full border border-[#E5E5E5] bg-white pr-9 pl-3 text-[14px] text-[#111111] tabular-nums placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA]"
                    />
                    <span className="pointer-events-none absolute right-3 text-[12px] text-[#6B6B6B]">
                      cm
                    </span>
                  </div>
                </div>

                <div>
                  <label
                    htmlFor="profile-weight"
                    className="mb-1.5 block text-[12px] font-medium text-[#111111]"
                  >
                    Weight (kg)
                  </label>
                  <div className="relative flex items-center">
                    <input
                      id="profile-weight"
                      type="number"
                      inputMode="numeric"
                      min={30}
                      max={250}
                      required
                      value={weightInput}
                      onChange={(e) => setWeightInput(e.target.value)}
                      placeholder="59"
                      disabled={isSaving}
                      className="h-10 w-full border border-[#E5E5E5] bg-white pr-9 pl-3 text-[14px] text-[#111111] tabular-nums placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA]"
                    />
                    <span className="pointer-events-none absolute right-3 text-[12px] text-[#6B6B6B]">
                      kg
                    </span>
                  </div>
                </div>
              </div>

              <div>
                <span className="mb-1.5 block text-[12px] font-medium text-[#111111]">
                  Preferred Fit
                </span>
                <div className="grid grid-cols-3 gap-1.5">
                  {PREFERRED_FITS.map((fit) => {
                    const selected = preferredFit === fit;
                    return (
                      <button
                        key={fit}
                        type="button"
                        onClick={() => setPreferredFit(fit)}
                        disabled={isSaving}
                        className={`h-9 border px-2 text-[12px] font-medium transition-colors ${
                          selected
                            ? "border-[#111111] bg-[#111111] text-white"
                            : "border-[#E5E5E5] bg-white text-[#525252] hover:border-[#111111] hover:text-[#111111]"
                        }`}
                      >
                        {PREFERRED_FIT_LABELS[fit]}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[#6B6B6B]">
                  Saved on your silhouette ledger for sizing reference.
                </p>
              </div>

              {activeTab === "upload" && cropSourceUrl && (
                <div className="border border-[#E5E5E5] bg-[#FAFAFA] px-3 py-2.5 text-[11px] leading-relaxed text-[#525252]">
                  {backgroundMode === "cutout"
                    ? "Saves a 768×1024 JPEG after stripping the background onto #FAFAFA locally."
                    : "Saves a 768×1024 cropped JPEG with your original background preserved."}
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="flex flex-col gap-2 border border-[#DC2626]/30 bg-[#FEF2F2] px-3 py-2.5 text-[12px] leading-snug text-[#991B1B]"
                >
                  <span>{error}</span>
                  {fallbackAvatarDataUrl && (
                    <div>
                      <button
                        type="button"
                        onClick={() => void handleUseOriginalFallback()}
                        disabled={isSaving}
                        className="inline-flex h-7 items-center bg-[#111111] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#262626] disabled:opacity-40"
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
                disabled={!canSubmit}
                className="inline-flex h-9 items-center gap-2 bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Saving…</span>
                  </>
                ) : (
                  <>
                    <UserRound className="h-3.5 w-3.5" />
                    <span>Save Profile</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/**
 * Minimalist non-interactive Ghost Silhouette SVG overlay inside the 3:4 crop box
 * so users align head, shoulders, and torso cleanly before cropping.
 */
function GhostSilhouetteOverlay() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
    >
      <svg
        viewBox="0 0 300 400"
        fill="none"
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Subtle 3:4 framing ticks */}
        <path
          d="M24 38 V24 H38 M262 24 H276 V38 M24 362 V376 H38 M262 376 H276 V362"
          stroke="rgba(255,255,255,0.45)"
          strokeWidth="1"
        />

        {/* Soft dark halo stroke underneath so the outline stays visible on white walls */}
        <g
          stroke="rgba(17,17,17,0.35)"
          strokeWidth="2.5"
          strokeDasharray="4 4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="150" cy="64" rx="24" ry="30" />
          <path d="M139 92 C139 102 136 108 122 114 C96 123 76 135 69 162 L58 242 C56 254 66 260 76 258 L89 252 L98 184 L103 256 L96 364" />
          <path d="M161 92 C161 102 164 108 178 114 C204 123 224 135 231 162 L242 242 C244 254 234 260 224 258 L211 252 L202 184 L197 256 L204 364" />
          <path d="M103 256 Q150 264 197 256" />
        </g>

        {/* Primary crisp white dashed silhouette guide */}
        <g
          stroke="rgba(255,255,255,0.72)"
          strokeWidth="1.25"
          strokeDasharray="4 4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="150" cy="64" rx="24" ry="30" />
          <path d="M139 92 C139 102 136 108 122 114 C96 123 76 135 69 162 L58 242 C56 254 66 260 76 258 L89 252 L98 184 L103 256 L96 364" />
          <path d="M161 92 C161 102 164 108 178 114 C204 123 224 135 231 162 L242 242 C244 254 234 260 224 258 L211 252 L202 184 L197 256 L204 364" />
          <path d="M103 256 Q150 264 197 256" />
        </g>
      </svg>
    </div>
  );
}
