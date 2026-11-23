"use client";

import { useEffect, useState } from "react";
import type { OuterwearStyle } from "@/lib/types/tailorFit";
import { synthesizeLayeredOuterwearRgba } from "@/lib/utils/outerwearLayering";

export interface TrimmedGarmentResult {
  dataUrl: string;
  width: number;
  height: number;
  aspect: number;
}

const MAX_TRIM_DIM = 768;
const ALPHA_BG_THRESHOLD = 20;
const WHITE_BG_THRESHOLD = 240;

const pendingTrimCache = new Map<string, Promise<TrimmedGarmentResult>>();
const resolvedTrimCache = new Map<string, TrimmedGarmentResult>();

function loadBrowserImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (src.startsWith("http://") || src.startsWith("https://")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load garment image."));
    img.src = src;
  });
}

function isBgPixel(
  data: Uint8ClampedArray,
  pixelIndex: number
): boolean {
  const o = pixelIndex * 4;
  const a = data[o + 3];
  if (a < ALPHA_BG_THRESHOLD) return true;
  return (
    data[o] > WHITE_BG_THRESHOLD &&
    data[o + 1] > WHITE_BG_THRESHOLD &&
    data[o + 2] > WHITE_BG_THRESHOLD
  );
}

/**
 * Browser-side garment auto-trimmer mirroring server sharp.trim + white-border flood-fill:
 * - Caps working canvas to max 768px for fast <15ms execution.
 * - Flood-fills border-connected transparent or near-white (> 240) pixels to alpha = 0,
 *   preserving opaque white garment interiors while stripping white product boxes.
 * - Crops strictly to the tight foreground bounding box and caches results in memory.
 */
export function trimGarmentImage(
  imageUrl: string
): Promise<TrimmedGarmentResult> {
  const existing = pendingTrimCache.get(imageUrl);
  if (existing) return existing;

  const task = (async (): Promise<TrimmedGarmentResult> => {
    try {
      const img = await loadBrowserImage(imageUrl);
      const natW = Math.max(1, img.naturalWidth);
      const natH = Math.max(1, img.naturalHeight);

      const scale = Math.min(1, MAX_TRIM_DIM / Math.max(natW, natH));
      const w = Math.max(1, Math.round(natW * scale));
      const h = Math.max(1, Math.round(natH * scale));

      const workCanvas = document.createElement("canvas");
      workCanvas.width = w;
      workCanvas.height = h;
      const workCtx = workCanvas.getContext("2d", { willReadFrequently: true });
      if (!workCtx) {
        return {
          dataUrl: imageUrl,
          width: natW,
          height: natH,
          aspect: natW / natH,
        };
      }

      workCtx.drawImage(img, 0, 0, w, h);
      const imageData = workCtx.getImageData(0, 0, w, h);
      const data = imageData.data;
      const total = w * h;

      // Detect whether this asset is already an alpha-transparent cutout PNG.
      // On transparent cutouts, NEVER let border flood-fill bleed into opaque white cotton garments!
      let borderTotal = 0;
      let borderTransparent = 0;
      for (let x = 0; x < w; x++) {
        borderTotal += 2;
        if (data[x * 4 + 3] < ALPHA_BG_THRESHOLD) borderTransparent++;
        if (data[((h - 1) * w + x) * 4 + 3] < ALPHA_BG_THRESHOLD)
          borderTransparent++;
      }
      for (let y = 1; y < h - 1; y++) {
        borderTotal += 2;
        if (data[y * w * 4 + 3] < ALPHA_BG_THRESHOLD) borderTransparent++;
        if (data[(y * w + (w - 1)) * 4 + 3] < ALPHA_BG_THRESHOLD)
          borderTransparent++;
      }
      const hasTransparentBorder =
        borderTransparent >= Math.max(4, Math.floor(borderTotal * 0.1));

      // Border flood-fill for transparent (or opaque near-white box when no alpha cutout exists)
      const visited = new Uint8Array(total);
      const queue = new Int32Array(total);
      let qHead = 0;
      let qTail = 0;

      const trySeed = (x: number, y: number) => {
        const idx = y * w + x;
        if (visited[idx]) return;
        const isBg = hasTransparentBorder
          ? data[idx * 4 + 3] < ALPHA_BG_THRESHOLD
          : isBgPixel(data, idx);
        if (!isBg) return;
        visited[idx] = 1;
        queue[qTail++] = idx;
      };

      for (let x = 0; x < w; x++) {
        trySeed(x, 0);
        trySeed(x, h - 1);
      }
      for (let y = 1; y < h - 1; y++) {
        trySeed(0, y);
        trySeed(w - 1, y);
      }

      while (qHead < qTail) {
        const cur = queue[qHead++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > 0) trySeed(cx - 1, cy);
        if (cx < w - 1) trySeed(cx + 1, cy);
        if (cy > 0) trySeed(cx, cy - 1);
        if (cy < h - 1) trySeed(cx, cy + 1);
      }

      // Clear border-connected background pixels to alpha = 0 & compute tight bounding box
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < h; y++) {
        const row = y * w;
        for (let x = 0; x < w; x++) {
          const idx = row + x;
          if (visited[idx]) {
            data[idx * 4 + 3] = 0;
            continue;
          }
          if (data[idx * 4 + 3] >= ALPHA_BG_THRESHOLD) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      // Fallback if image was entirely near-white or empty
      if (maxX < minX || maxY < minY) {
        const fallback: TrimmedGarmentResult = {
          dataUrl: imageUrl,
          width: natW,
          height: natH,
          aspect: natW / natH,
        };
        resolvedTrimCache.set(imageUrl, fallback);
        return fallback;
      }

      workCtx.putImageData(imageData, 0, 0);

      const trimW = Math.max(1, maxX - minX + 1);
      const trimH = Math.max(1, maxY - minY + 1);

      const outCanvas = document.createElement("canvas");
      outCanvas.width = trimW;
      outCanvas.height = trimH;
      const outCtx = outCanvas.getContext("2d");
      if (!outCtx) {
        const fallback: TrimmedGarmentResult = {
          dataUrl: imageUrl,
          width: natW,
          height: natH,
          aspect: natW / natH,
        };
        resolvedTrimCache.set(imageUrl, fallback);
        return fallback;
      }

      outCtx.drawImage(
        workCanvas,
        minX,
        minY,
        trimW,
        trimH,
        0,
        0,
        trimW,
        trimH
      );

      const result: TrimmedGarmentResult = {
        dataUrl: outCanvas.toDataURL("image/png"),
        width: trimW,
        height: trimH,
        aspect: trimW / trimH,
      };
      resolvedTrimCache.set(imageUrl, result);
      return result;
    } catch {
      // Fallback safely on CORS-tainted or undecodable images
      return {
        dataUrl: imageUrl,
        width: 576,
        height: 864,
        aspect: 576 / 864,
      };
    }
  })();

  pendingTrimCache.set(imageUrl, task);
  return task;
}

export function useTrimmedGarment(imageUrl?: string | null): {
  src: string;
  aspect?: number;
  width?: number;
  height?: number;
  ready: boolean;
} {
  const cached = imageUrl ? resolvedTrimCache.get(imageUrl) : undefined;

  const [state, setState] = useState<{
    sourceUrl: string | null;
    result: TrimmedGarmentResult | null;
  }>(() => ({
    sourceUrl: imageUrl ?? null,
    result: cached ?? null,
  }));

  useEffect(() => {
    if (!imageUrl) {
      setState({ sourceUrl: null, result: null });
      return;
    }

    const immediate = resolvedTrimCache.get(imageUrl);
    if (immediate) {
      setState({ sourceUrl: imageUrl, result: immediate });
      return;
    }

    let cancelled = false;
    void trimGarmentImage(imageUrl).then((trimmed) => {
      if (!cancelled) {
        setState({ sourceUrl: imageUrl, result: trimmed });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  if (!imageUrl) {
    return { src: "", ready: false };
  }

  const resolved =
    cached ?? (state.sourceUrl === imageUrl ? state.result : null);

  if (resolved) {
    return {
      src: resolved.dataUrl,
      aspect: resolved.aspect,
      width: resolved.width,
      height: resolved.height,
      ready: true,
    };
  }

  return {
    src: imageUrl,
    ready: false,
  };
}

const pendingLayeredCache = new Map<string, Promise<TrimmedGarmentResult>>();
const resolvedLayeredCache = new Map<string, TrimmedGarmentResult>();

async function imageUrlToRgba(
  src: string,
  maxDim: number
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const img = await loadBrowserImage(src);
  const natW = Math.max(1, img.naturalWidth);
  const natH = Math.max(1, img.naturalHeight);
  const scale = Math.min(1, maxDim / Math.max(natW, natH));
  const width = Math.max(1, Math.round(natW * scale));
  const height = Math.max(1, Math.round(natH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 2D unavailable.");
  }
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return {
    rgba: new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data),
    width,
    height,
  };
}

function buildLayeredCacheKey(
  topUrl: string,
  outerwearUrl: string,
  style: OuterwearStyle,
  suppressHemPeek: boolean
): string {
  const tSig = `${topUrl.length}:${topUrl.slice(0, 32)}:${topUrl.slice(-24)}`;
  const oSig = `${outerwearUrl.length}:${outerwearUrl.slice(0, 32)}:${outerwearUrl.slice(-24)}`;
  return `${tSig}::${oSig}::${style}::${suppressHemPeek ? "1" : "0"}`;
}

export function synthesizeLayeredPreviewImage(
  topUrl: string,
  outerwearUrl: string,
  style: OuterwearStyle,
  suppressHemPeek: boolean
): Promise<TrimmedGarmentResult> {
  const key = buildLayeredCacheKey(
    topUrl,
    outerwearUrl,
    style,
    suppressHemPeek
  );
  const existing = pendingLayeredCache.get(key);
  if (existing) return existing;

  const task = (async (): Promise<TrimmedGarmentResult> => {
    const [topTrim, outerTrim] = await Promise.all([
      trimGarmentImage(topUrl),
      trimGarmentImage(outerwearUrl),
    ]);
    const [topBuf, outerBuf] = await Promise.all([
      imageUrlToRgba(topTrim.dataUrl, 320),
      imageUrlToRgba(outerTrim.dataUrl, 320),
    ]);

    const layered = synthesizeLayeredOuterwearRgba(topBuf, outerBuf, {
      style,
      suppressHemPeek,
      maxWidth: 320,
    });

    const canvas = document.createElement("canvas");
    canvas.width = layered.width;
    canvas.height = layered.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Canvas 2D unavailable.");
    }
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(layered.rgba),
        layered.width,
        layered.height
      ),
      0,
      0
    );

    const result: TrimmedGarmentResult = {
      dataUrl: canvas.toDataURL("image/png"),
      width: layered.width,
      height: layered.height,
      aspect: layered.width / Math.max(1, layered.height),
    };
    resolvedLayeredCache.set(key, result);
    return result;
  })();

  task.catch(() => {
    if (pendingLayeredCache.get(key) === task) {
      pendingLayeredCache.delete(key);
    }
  });

  pendingLayeredCache.set(key, task);
  return task;
}

/**
 * Browser-side 1:1 preview hook mirroring the backend's 3-mode `composeLayeredUpperCutout`
 * synthesizer so switching Open Front / Collar + Hem / Collar Only updates Live Cut Preview live.
 */
export function useLayeredOuterwearPreview(params: {
  topUrl?: string | null;
  outerwearUrl?: string | null;
  style: OuterwearStyle;
  suppressHemPeek: boolean;
}): {
  src: string;
  aspect?: number;
  ready: boolean;
} {
  const { topUrl, outerwearUrl, style, suppressHemPeek } = params;
  const key =
    topUrl && outerwearUrl
      ? buildLayeredCacheKey(topUrl, outerwearUrl, style, suppressHemPeek)
      : null;
  const cached = key ? resolvedLayeredCache.get(key) : undefined;

  const [state, setState] = useState<{
    key: string | null;
    result: TrimmedGarmentResult | null;
  }>(() => ({
    key,
    result: cached ?? null,
  }));

  useEffect(() => {
    if (!topUrl || !outerwearUrl || !key) {
      setState({ key: null, result: null });
      return;
    }

    const immediate = resolvedLayeredCache.get(key);
    if (immediate) {
      setState({ key, result: immediate });
      return;
    }

    let cancelled = false;
    void synthesizeLayeredPreviewImage(
      topUrl,
      outerwearUrl,
      style,
      suppressHemPeek
    )
      .then((res) => {
        if (!cancelled) {
          setState({ key, result: res });
        }
      })
      .catch(() => {
        // Fall back silently to stacked layer preview
      });

    return () => {
      cancelled = true;
    };
  }, [topUrl, outerwearUrl, style, suppressHemPeek, key]);

  if (!key) {
    return { src: "", ready: false };
  }

  const resolved = cached ?? (state.key === key ? state.result : null);
  if (resolved) {
    return {
      src: resolved.dataUrl,
      aspect: resolved.aspect,
      ready: true,
    };
  }

  return { src: "", ready: false };
}
