"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Camera,
  CameraOff,
  Loader2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Timer,
  UserRound,
} from "lucide-react";
import { extractErrorMessage } from "@/lib/utils/normalizeImage";

interface CameraBoothProps {
  hasTryOnSelection: boolean;
  selectedSummary: string;
  onTryOnFrame: (frameDataUrl: string) => Promise<void> | void;
  onSetStudioAvatar: (studioAvatarDataUrl: string) => Promise<void> | void;
}

type FacingMode = "user" | "environment";
type BoothStatus = "idle" | "starting" | "live" | "captured" | "error";
type TimerDuration = 3 | 5;

const CAPTURE_WIDTH = 768;
const CAPTURE_HEIGHT = 1024;
const STUDIO_BG = "#FAFAFA";
const VERTICAL_MARGIN_RATIO = 0.09;
const HORIZONTAL_MARGIN_RATIO = 0.08;
const ALPHA_THRESHOLD = 16;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode captured photo."));
    img.src = src;
  });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [header, body] = dataUrl.split(",");
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

/**
 * Composites a cutout Blob tightly trimmed and centered onto a 768x1024 #FAFAFA Studio Avatar.
 */
async function composeStudioAvatarFromCutout(
  cutoutBlob: Blob
): Promise<string> {
  const objectUrl = URL.createObjectURL(cutoutBlob);
  try {
    const img = await loadImage(objectUrl);
    const srcW = Math.max(1, img.naturalWidth);
    const srcH = Math.max(1, img.naturalHeight);

    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = srcW;
    tmpCanvas.height = srcH;
    const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
    if (!tmpCtx) throw new Error("Browser canvas unavailable.");

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
    studioCanvas.width = CAPTURE_WIDTH;
    studioCanvas.height = CAPTURE_HEIGHT;
    const studioCtx = studioCanvas.getContext("2d");
    if (!studioCtx) throw new Error("Browser canvas unavailable.");

    studioCtx.fillStyle = STUDIO_BG;
    studioCtx.fillRect(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);

    const maxDrawW = CAPTURE_WIDTH * (1 - HORIZONTAL_MARGIN_RATIO * 2);
    const maxDrawH = CAPTURE_HEIGHT * (1 - VERTICAL_MARGIN_RATIO * 2);
    const scale = Math.min(maxDrawW / cropW, maxDrawH / cropH);

    const drawW = Math.max(1, Math.round(cropW * scale));
    const drawH = Math.max(1, Math.round(cropH * scale));
    const drawX = Math.round((CAPTURE_WIDTH - drawW) / 2);
    const drawY = Math.round((CAPTURE_HEIGHT - drawH) / 2);

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

export function CameraBooth({
  hasTryOnSelection,
  selectedSummary,
  onTryOnFrame,
  onSetStudioAvatar,
}: CameraBoothProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const [status, setStatus] = useState<BoothStatus>("idle");
  const [facingMode, setFacingMode] = useState<FacingMode>("user");
  const [timerSeconds, setTimerSeconds] = useState<TimerDuration>(3);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [capturedDataUrl, setCapturedDataUrl] = useState<string | null>(null);
  const [isBusyAction, setIsBusyAction] = useState<
    "tryon" | "avatar" | null
  >(null);
  const [avatarProgress, setAvatarProgress] = useState("");
  const [error, setError] = useState<string | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setCountdown(null);
  }, []);

  const stopTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, []);

  const stopCamera = useCallback(() => {
    clearTimer();
    stopTracks();
    setCapturedDataUrl(null);
    setStatus("idle");
  }, [clearTimer, stopTracks]);

  // Strict hardware cleanup on tab switch or unmount
  useEffect(() => {
    return () => {
      clearTimer();
      stopTracks();
    };
  }, [clearTimer, stopTracks]);

  const startCamera = useCallback(
    async (requestedFacing: FacingMode = facingMode) => {
      setError(null);
      clearTimer();
      stopTracks();
      setCapturedDataUrl(null);
      setStatus("starting");

      if (
        typeof navigator === "undefined" ||
        !navigator.mediaDevices?.getUserMedia
      ) {
        setStatus("error");
        setError(
          "Camera access requires HTTPS or localhost in a modern browser."
        );
        return;
      }

      let stream: MediaStream;
      try {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: requestedFacing },
              width: { ideal: 960 },
              height: { ideal: 1280 },
            },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: requestedFacing },
            audio: false,
          });
        }
      } catch (camErr) {
        console.error("[CameraBooth] getUserMedia failed:", camErr);
        setStatus("error");
        setError(
          "Camera permission denied or unavailable. Allow camera access and retry."
        );
        return;
      }

      streamRef.current = stream;

      try {
        const video = videoRef.current;
        if (!video) throw new Error("Video element unavailable.");
        video.srcObject = stream;
        await video.play();

        if (!streamRef.current) return;
        setFacingMode(requestedFacing);
        setStatus("live");
      } catch (playErr) {
        console.error("[CameraBooth] video playback failed:", playErr);
        stopTracks();
        setStatus("error");
        setError("Could not start camera preview. Please retry.");
      }
    },
    [clearTimer, facingMode, stopTracks]
  );

  function handleFlipCamera() {
    const next: FacingMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(next);
    if (status === "live") {
      void startCamera(next);
    }
  }

  const snapFrameNow = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2 || video.videoWidth === 0) {
      setError("Camera frame wasn't ready. Try snapping again.");
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.width = CAPTURE_WIDTH;
    canvas.height = CAPTURE_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const vidW = video.videoWidth;
    const vidH = video.videoHeight;
    const scale = Math.max(CAPTURE_WIDTH / vidW, CAPTURE_HEIGHT / vidH);
    const drawW = vidW * scale;
    const drawH = vidH * scale;
    const offsetX = (CAPTURE_WIDTH - drawW) / 2;
    const offsetY = (CAPTURE_HEIGHT - drawH) / 2;

    ctx.fillStyle = STUDIO_BG;
    ctx.fillRect(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT);
    ctx.save();
    if (facingMode === "user") {
      ctx.translate(CAPTURE_WIDTH, 0);
      ctx.scale(-1, 1);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(video, offsetX, offsetY, drawW, drawH);
    ctx.restore();

    const snappedDataUrl = canvas.toDataURL("image/jpeg", 0.9);
    // Shut off camera immediately while reviewing the snapped portrait
    stopTracks();
    setCapturedDataUrl(snappedDataUrl);
    setStatus("captured");
  }, [facingMode, stopTracks]);

  function handleStartSelfTimer() {
    if (status !== "live" || countdown !== null) return;
    setError(null);
    let remainingSec: number = timerSeconds;
    setCountdown(remainingSec);

    timerRef.current = window.setInterval(() => {
      remainingSec -= 1;
      if (remainingSec > 0) {
        setCountdown(remainingSec);
        return;
      }
      clearTimer();
      snapFrameNow();
    }, 1000);
  }

  async function handleTryOnSnapped() {
    if (!capturedDataUrl || !hasTryOnSelection || isBusyAction) return;
    setError(null);
    setIsBusyAction("tryon");
    try {
      await onTryOnFrame(capturedDataUrl);
    } catch (err) {
      setError(
        `Could not start AI Try-On (${extractErrorMessage(err)}). Try again.`
      );
      setIsBusyAction(null);
    }
  }

  async function handleSetAsStudioAvatar() {
    if (!capturedDataUrl || isBusyAction) return;
    setError(null);
    setIsBusyAction("avatar");
    setAvatarProgress("Normalizing into 3:4 Studio Avatar…");

    try {
      let finalAvatarUrl = capturedDataUrl;

      try {
        const blob = dataUrlToBlob(capturedDataUrl);
        const { removeBackground } = await import("@imgly/background-removal");
        const cutoutBlob = await removeBackground(blob, {
          output: { format: "image/png", quality: 0.9 },
          progress: (key, current, total) => {
            if (key.startsWith("fetch:")) {
              setAvatarProgress("Downloading cutout model (first run)…");
            } else if (key.startsWith("compute:")) {
              setAvatarProgress("Isolating silhouette onto studio backdrop…");
            }
            if (total > 0) {
              const pct = Math.min(
                100,
                Math.max(0, Math.round((current / total) * 100))
              );
              setAvatarProgress(`Creating Studio Avatar… ${pct}%`);
            }
          },
        });
        finalAvatarUrl = await composeStudioAvatarFromCutout(cutoutBlob);
      } catch (bgErr) {
        console.warn(
          "[CameraBooth] Background removal failed, saving clean 3:4 snapped frame:",
          bgErr
        );
      }

      setAvatarProgress("Saving Studio Avatar…");
      await onSetStudioAvatar(finalAvatarUrl);
    } catch (err) {
      setError(
        `Could not save Studio Avatar (${extractErrorMessage(err)}). Try again.`
      );
    } finally {
      setIsBusyAction(null);
      setAvatarProgress("");
    }
  }

  return (
    <section className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E0DA] px-5 py-3.5">
        <div className="flex items-baseline gap-2.5">
          <h1 className="text-[11px] font-semibold tracking-[0.14em] text-[#0E0E0E] uppercase">
            Camera Booth
          </h1>
          <span className="text-[11px] text-[#6C6A64] tabular-nums">
            3:4 · 768×1024
          </span>
        </div>

        <div className="flex items-center gap-2">
          {status === "live" && (
            <>
              <button
                type="button"
                onClick={handleFlipCamera}
                disabled={countdown !== null}
                className="inline-flex h-7 items-center gap-1.5 border border-[#E2E0DA] bg-white px-2.5 text-[11px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E] disabled:opacity-40"
              >
                <RefreshCw className="h-3 w-3" />
                <span>Flip Camera</span>
              </button>
              <button
                type="button"
                onClick={stopCamera}
                className="inline-flex h-7 items-center gap-1.5 border border-[#0E0E0E] bg-[#0E0E0E] px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
              >
                <CameraOff className="h-3 w-3" />
                <span>Stop</span>
              </button>
            </>
          )}

          {status === "captured" && (
            <button
              type="button"
              onClick={() => void startCamera(facingMode)}
              disabled={isBusyAction !== null}
              className="inline-flex h-7 items-center gap-1.5 border border-[#E2E0DA] bg-white px-2.5 text-[11px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E] disabled:opacity-40"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Retake</span>
            </button>
          )}
        </div>
      </div>

      {/* 3:4 Viewfinder Stage */}
      <div className="flex flex-1 items-center justify-center bg-[#F2F1ED] p-4 sm:p-6">
        <div className="relative aspect-[3/4] w-full max-w-[440px] overflow-hidden border border-[#E2E0DA] bg-white">
          <video
            ref={videoRef}
            playsInline
            muted
            className={`h-full w-full object-cover ${
              facingMode === "user" ? "-scale-x-100" : ""
            } ${status === "live" ? "block" : "hidden"}`}
          />

          {status === "live" && <BoothGhostSilhouette />}

          {status === "captured" && capturedDataUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={capturedDataUrl}
              alt="Captured 3:4 full-body portrait"
              className={`h-full w-full object-cover transition-opacity ${
                isBusyAction ? "opacity-40 blur-[2px]" : "opacity-100"
              }`}
            />
          )}

          {status === "idle" && (
            <div className="flex h-full w-full flex-col items-center justify-center bg-[#F9F8F6] px-8 text-center">
              <div className="flex h-12 w-12 items-center justify-center border border-[#E2E0DA] bg-white text-[#0E0E0E]">
                <Camera className="h-5 w-5" strokeWidth={1.3} />
              </div>
              <h2 className="mt-5 text-[16px] font-medium tracking-[-0.02em] text-[#0E0E0E]">
                Full-Body Camera Booth
              </h2>
              <p className="mt-1.5 max-w-[30ch] text-[13px] leading-relaxed text-[#4A4945]">
                Align with the 3:4 ghost guide using a 3s or 5s self-timer, then
                drape your outfit in HD.
              </p>
              <button
                type="button"
                onClick={() => void startCamera(facingMode)}
                className="mt-6 inline-flex h-10 items-center gap-2 bg-[#0E0E0E] px-5 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
              >
                <Camera className="h-3.5 w-3.5" />
                <span>Start Camera</span>
              </button>
              <p className="mt-4 max-w-[30ch] text-[11px] leading-relaxed text-[#6C6A64]">
                Stand facing forward in even indoor lighting for the cleanest
                fit.
              </p>
            </div>
          )}

          {status === "starting" && (
            <div className="flex h-full w-full flex-col items-center justify-center bg-[#F9F8F6] px-8 text-center">
              <Loader2 className="h-5 w-5 animate-spin text-[#0E0E0E]" />
              <p className="mt-3 text-[13px] font-medium text-[#0E0E0E]">
                Starting camera…
              </p>
            </div>
          )}

          {status === "error" && (
            <div className="flex h-full w-full flex-col items-center justify-center bg-[#F9F8F6] px-8 text-center">
              <p className="text-[14px] font-medium text-[#0E0E0E]">
                Camera unavailable
              </p>
              <p className="mt-1.5 max-w-[30ch] text-[12px] leading-relaxed text-[#4A4945]">
                {error || "Allow camera permission and retry."}
              </p>
              <button
                type="button"
                onClick={() => void startCamera(facingMode)}
                className="mt-5 inline-flex h-9 items-center gap-1.5 bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Retry Camera</span>
              </button>
            </div>
          )}

          {status === "live" && countdown !== null && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#0E0E0E]/35 backdrop-blur-[1px]">
              <span className="text-[76px] font-medium tracking-[-0.04em] text-white tabular-nums">
                {countdown}
              </span>
              <span className="mt-1 border border-white/30 bg-[#0E0E0E]/80 px-3 py-1 text-[11px] font-medium text-white">
                Step back &amp; hold pose
              </span>
            </div>
          )}

          {status === "captured" && isBusyAction && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#F9F8F6]/85 px-6 text-center backdrop-blur-[2px]">
              <Loader2 className="h-5 w-5 animate-spin text-[#0E0E0E]" />
              <p className="mt-3 text-[13px] font-medium text-[#0E0E0E]">
                {isBusyAction === "avatar"
                  ? avatarProgress || "Creating Studio Avatar…"
                  : "Sending frame to AI Try-On…"}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Inline Error Banner */}
      {error && status !== "error" && (
        <div
          role="alert"
          className="border-t border-[#D9B4B2] bg-[#FAF2F2] px-5 py-2.5 text-[12px] text-[#8C1D18]"
        >
          {error}
        </div>
      )}

      {/* Pinned Action Bar */}
      <div className="border-t border-[#E2E0DA] bg-white px-5 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        {status === "captured" ? (
          <div className="flex flex-col gap-3">
            {selectedSummary && (
              <div className="truncate text-[11px] text-[#4A4945]">
                Selected outfit:{" "}
                <span className="font-medium text-[#0E0E0E]">
                  {selectedSummary}
                </span>
              </div>
            )}
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void handleTryOnSnapped()}
                disabled={!hasTryOnSelection || isBusyAction !== null}
                className="inline-flex h-10 items-center justify-center gap-2 bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>Try On Selected Outfit</span>
              </button>

              <button
                type="button"
                onClick={() => void handleSetAsStudioAvatar()}
                disabled={isBusyAction !== null}
                className="inline-flex h-10 items-center justify-center gap-2 border border-[#E2E0DA] bg-white px-4 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <UserRound className="h-3.5 w-3.5" />
                <span>Set as Studio Avatar</span>
              </button>
            </div>
            {!hasTryOnSelection && (
              <p className="text-[11px] text-[#6C6A64]">
                Select a Top, Outerwear, or Bottom from your closet to enable
                Try On Selected Outfit.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#4A4945]">
                <Timer className="h-3.5 w-3.5" />
                <span>Self-Timer</span>
              </span>
              <div
                role="group"
                aria-label="Self-timer duration"
                className="inline-flex border border-[#E2E0DA] bg-[#F9F8F6] p-0.5"
              >
                {([3, 5] as const).map((sec) => (
                  <button
                    key={sec}
                    type="button"
                    onClick={() => setTimerSeconds(sec)}
                    disabled={countdown !== null}
                    className={`h-7 px-2.5 text-[11px] font-medium tabular-nums transition-colors disabled:opacity-40 ${
                      timerSeconds === sec
                        ? "bg-[#0E0E0E] text-white"
                        : "text-[#4A4945] hover:text-[#0E0E0E]"
                    }`}
                  >
                    {sec}s
                  </button>
                ))}
              </div>
            </div>

            {status === "live" ? (
              countdown !== null ? (
                <button
                  type="button"
                  onClick={clearTimer}
                  className="inline-flex h-9 items-center gap-1.5 border border-[#0E0E0E] bg-white px-4 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:bg-[#F9F8F6]"
                >
                  <span>Cancel ({countdown}s)</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStartSelfTimer}
                  className="inline-flex h-9 items-center gap-2 bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
                >
                  <Camera className="h-3.5 w-3.5" />
                  <span>Snap Portrait ({timerSeconds}s)</span>
                </button>
              )
            ) : (
              <span className="text-[11px] font-medium tracking-[0.08em] text-[#6C6A64] uppercase">
                {status === "starting"
                  ? "Initializing camera…"
                  : "Ready for capture"}
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function BoothGhostSilhouette() {
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
        <path
          d="M22 36 V22 H36 M264 22 H278 V36 M22 364 V378 H36 M264 378 H278 V364"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth="1"
        />
        <g
          stroke="rgba(14,14,14,0.35)"
          strokeWidth="2.4"
          strokeDasharray="4 4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="150" cy="64" rx="24" ry="30" />
          <path d="M139 92 C139 102 136 108 122 114 C96 123 76 135 69 162 L58 242 C56 254 66 260 76 258 L89 252 L98 184 L103 256 L96 364" />
          <path d="M161 92 C161 102 164 108 178 114 C204 123 224 135 231 162 L242 242 C244 254 234 260 224 258 L211 252 L202 184 L197 256 L204 364" />
          <path d="M103 256 Q150 264 197 256" />
        </g>
        <g
          stroke="rgba(255,255,255,0.78)"
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
