import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { Client, handle_file } from "@gradio/client";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db/drizzle";
import { bodyProfiles, tryonUsage, wardrobeItems } from "@/db/schema";
import {
  buildFullOutfitCacheKey,
  buildPass1CacheKey,
  getCachedFullOutfit,
  getCachedPass1,
  setCachedFullOutfit,
  setCachedPass1,
  sha256Hex,
  type TryOnEngineKind,
  type TryOnSlotKind,
} from "@/lib/cache/tryonCache";
import { TRYON_DAILY_LIMIT } from "@/lib/fitPreferences";
import { getSession } from "@/lib/session";
import {
  computeTailorGeometry,
  isDefaultTailorFit,
  needsAutoCleanMask,
  sanitizeTailorFit,
  type TailorFitConfig,
  type TailorGeometryResult,
  type TryOnRenderMode,
} from "@/lib/types/tailorFit";
import {
  composeLayeredUpperCutout,
  composeStudioFlatLayCanvas,
  createUntuckedHemShadowPng,
  reshapeBottomHemPreserving,
  reshapeTopSeamPreserving,
  STUDIO_FLATLAY_BG,
  trimGarmentCutout,
  type TrimmedGarmentCutout,
} from "@/lib/utils/garmentReshaper";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BUSY_ERROR_MESSAGE =
  "AI try-on server is currently busy. Try again in a moment or use the Layer Board.";
const ZEROGPU_QUOTA_ERROR_MESSAGE =
  "Free Hugging Face ZeroGPU quota reached and fallback try-on server is currently busy. Try again shortly or use the Layer Board.";

const DEFAULT_FASHN_SPACE_ID = "fashn-ai/fashn-vton-1.5";
const CATVTON_FALLBACK_SPACES = [
  "zhengchong/CatVTON",
  "multimodalart/CatVTON-zerogpu",
] as const;
const WESHOP_SPACE_ID = "WeShopAI/WeShopAI-Virtual-Try-On";

// Balanced inference parameters for FASHN VTON 1.5
const FASHN_STEPS_COMPOSITE = 32;
const FASHN_STEPS_SINGLE = 32;
const FASHN_STEPS_PASS1 = 26;
const FASHN_STEPS_PASS2 = 30;
const FASHN_STEPS_HIGH_DETAIL = 40;
const VTON_API_STEPS_DEFAULT = 30;
const VTON_API_STEPS_HIGH_DETAIL = 40;
const FITDIT_STEPS_DEFAULT = 25;
const FITDIT_STEPS_HIGH_DETAIL = 30;
const FITDIT_GUIDANCE = 2.0;
const FASHN_SEED = 42;
const VTON_API_TIMEOUT_MS = 120_000;
const VTON_API_SUBMIT_TIMEOUT_MS = 30_000;
const VTON_API_POLL_INTERVAL_MS = 2_500;
const VTON_API_POLL_MAX_MS = 420_000;
const VTON_API_POLL_REQ_TIMEOUT_MS = 20_000;
const WESHOP_PASS_TIMEOUT_MS = 90_000;

const CATVTON_STEPS = 30;
const CATVTON_STEPS_HIGH_DETAIL = 40;
const CATVTON_GUIDANCE = 2.5;
const CATVTON_SEED = 42;
const CATVTON_SHOW_TYPE = "result only";

// Full-res local canvas for crisp blending + CatVTON/WeShop inputs
const MODEL_WIDTH = 768;
const MODEL_HEIGHT = 1024;

// Canonical 2:3 native garment canvas for Tailor Fit geometry engine & FASHN VTON 1.5
const FASHN_NATIVE_WIDTH = 576;
const FASHN_NATIVE_HEIGHT = 864;

// Unpadded 3:4 person canvas for FASHN VTON 1.5 (TryOnPipeline natively runs
// ResizePad + unpad internally, giving 0.0px vertical drift and pixel-exact alignment)
const FASHN_PERSON_WIDTH = 576;
const FASHN_PERSON_HEIGHT = 768;

// 2D Change-Mask Compositor parameters (tight garment-only mask; zero sky-biased tone boost)
const MASK_W = 192;
const MASK_H = 256;
const CHANGE_DELTA_THRESHOLD = 42;
const DILATION_RADIUS = 4;
const MAX_INTERIOR_GAP_PX = 20;
const MIN_MASK_COVERAGE = 0.015;

type SingleSlotKind = "upper" | "outerwear" | "lower";

interface BlendResult {
  buffer: Buffer;
  meanDiff: number;
  maskCoveragePct: number;
}

interface TailoredCanvasOutput {
  buffer: Buffer;
  blob: Blob;
  geometry: TailorGeometryResult;
}

interface Pass1PreviewEvent {
  buffer34: Buffer;
  cachedPass1: boolean;
  nextSlot: SingleSlotKind;
  stepIndex: number;
  totalSteps: number;
  engine: TryOnEngineKind;
}

interface EngineRunResult {
  generated34Buffer: Buffer;
  passes: TryOnSlotKind[];
  rawW: number;
  rawH: number;
  pass1Ms: number;
  pass2Ms: number;
  cachedPass1: boolean;
}

interface CachedGradioConnection {
  client: Client;
  endpoint: string;
}

const globalForGradioPool = globalThis as typeof globalThis & {
  __silhoGradioClients?: Map<string, Promise<CachedGradioConnection>>;
};

function getGradioPool(): Map<string, Promise<CachedGradioConnection>> {
  if (!globalForGradioPool.__silhoGradioClients) {
    globalForGradioPool.__silhoGradioClients = new Map();
  }
  return globalForGradioPool.__silhoGradioClients;
}

interface VtonApiConfig {
  url: string;
  secret?: string;
}

type VtonApiBackend = "fitdit" | "fashn";

const globalForBackendCache = globalThis as typeof globalThis & {
  __silhoVtonBackendCache?: Map<string, { backend: VtonApiBackend; expiresAt: number }>;
};

function getVtonBackendCache(): Map<
  string,
  { backend: VtonApiBackend; expiresAt: number }
> {
  if (!globalForBackendCache.__silhoVtonBackendCache) {
    globalForBackendCache.__silhoVtonBackendCache = new Map();
  }
  return globalForBackendCache.__silhoVtonBackendCache;
}

function getVtonApiConfig(): VtonApiConfig | null {
  const url = process.env.VTON_API_URL?.trim().replace(/\/+$/, "");
  if (!url) return null;
  const secret = process.env.VTON_API_SECRET?.trim() || undefined;
  return { url, secret };
}

function getPrimaryEnginePref(): "weshop" | "vton-api" {
  const raw = process.env.TRYON_PRIMARY_ENGINE?.trim().toLowerCase();
  if (raw === "vton-api" || raw === "fitdit" || raw === "fitdit-api") {
    return "vton-api";
  }
  return "weshop";
}

async function detectVtonApiBackend(
  config: VtonApiConfig
): Promise<VtonApiBackend> {
  const cache = getVtonBackendCache();
  const cached = cache.get(config.url);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.backend;
  }

  let backend: VtonApiBackend = "fashn";
  try {
    const res = await fetch(`${config.url}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as {
        engine?: unknown;
      } | null;
      if (typeof data?.engine === "string" && data.engine.toLowerCase() === "fitdit") {
        backend = "fitdit";
      }
    }
  } catch {
    // Keep default "fashn" if health check briefly times out
  }

  cache.set(config.url, { backend, expiresAt: Date.now() + 5 * 60_000 });
  return backend;
}

function getFashnSpaceId(): string {
  return process.env.FASHN_SPACE_ID?.trim() || DEFAULT_FASHN_SPACE_ID;
}

function getHfToken(): `hf_${string}` | undefined {
  const raw = process.env.HF_TOKEN?.trim();
  if (raw && raw.startsWith("hf_")) {
    return raw as `hf_${string}`;
  }
  return undefined;
}

function getErrorDetail(err: unknown): string {
  if (err instanceof Error) {
    const extra = err as Error & {
      title?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    const base = [extra.title, err.message].filter(Boolean).join(": ");
    if (extra.cause && typeof extra.cause === "object") {
      const c = extra.cause as Record<string, unknown>;
      const causeParts = [c.code, c.message].filter(Boolean).join(": ");
      if (causeParts && !base.includes(causeParts)) {
        return `${base} (${causeParts})`;
      }
    } else if (extra.code && !base.includes(String(extra.code))) {
      return `${base} (${String(extra.code)})`;
    }
    return base;
  }
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    return [rec.title, rec.message, rec.error].filter(Boolean).join(": ");
  }
  return String(err ?? "");
}

function isZeroGpuQuotaError(err: unknown): boolean {
  const detail = getErrorDetail(err);
  return /zerogpu|runs limit|quota/i.test(detail);
}

function isQueueOrTimeoutError(err: unknown): boolean {
  const detail = getErrorDetail(err);
  return /timed out|timeout|queue|rate limit|too many requests|429|limit exceeded/i.test(
    detail
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`)
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

/**
 * Module-level cached Gradio client pool (reuses connected Client + resolved endpoint
 * across requests and across Pass 1 -> Pass 2 to skip repeated /info handshakes).
 */
async function getOrConnectGradioClient(params: {
  spaceId: string;
  hfToken?: `hf_${string}`;
  preferredEndpoint: string;
  fallbackParamName: string;
}): Promise<{ cacheKey: string; conn: CachedGradioConnection }> {
  const pool = getGradioPool();
  const tokenTag = params.hfToken
    ? sha256Hex(params.hfToken).slice(0, 12)
    : "anon";
  const cacheKey = `${params.spaceId}::${tokenTag}`;

  let pending = pool.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const client = await Client.connect(
        params.spaceId,
        params.hfToken ? { token: params.hfToken } : undefined
      );
      const apiInfo = await client.view_api();
      const endpointNames = Object.keys(apiInfo.named_endpoints || {});
      const endpoint = endpointNames.includes(params.preferredEndpoint)
        ? params.preferredEndpoint
        : endpointNames.find((name) =>
            apiInfo.named_endpoints[name]?.parameters?.some(
              (p) => p.parameter_name === params.fallbackParamName
            )
          ) ?? params.preferredEndpoint;

      return { client, endpoint };
    })();

    pending.catch(() => {
      if (pool.get(cacheKey) === pending) {
        pool.delete(cacheKey);
      }
    });

    pool.set(cacheKey, pending);
  }

  const conn = await pending;
  return { cacheKey, conn };
}

function evictGradioClient(cacheKey: string): void {
  const pool = getGradioPool();
  const existing = pool.get(cacheKey);
  pool.delete(cacheKey);
  if (existing) {
    existing
      .then((entry) => {
        try {
          entry.client.close();
        } catch {
          // Ignore close errors
        }
      })
      .catch(() => {
        // Ignore already-rejected promise
      });
  }
}

async function predictWithCachedClient(params: {
  spaceId: string;
  hfToken?: `hf_${string}`;
  preferredEndpoint: string;
  fallbackParamName: string;
  payload: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ data: unknown }> {
  let attempt = 0;
  while (true) {
    attempt++;
    const connectPromise = getOrConnectGradioClient({
      spaceId: params.spaceId,
      hfToken: params.hfToken,
      preferredEndpoint: params.preferredEndpoint,
      fallbackParamName: params.fallbackParamName,
    });
    const { cacheKey, conn } = params.timeoutMs
      ? await withTimeout(
          connectPromise,
          Math.min(params.timeoutMs, 30_000),
          `Gradio connect (${params.spaceId})`
        )
      : await connectPromise;

    try {
      const predictPromise = conn.client.predict(conn.endpoint, params.payload);
      return params.timeoutMs
        ? await withTimeout(
            predictPromise,
            params.timeoutMs,
            `Gradio predict (${params.spaceId})`
          )
        : await predictPromise;
    } catch (err) {
      if (
        attempt >= 2 ||
        isZeroGpuQuotaError(err) ||
        isQueueOrTimeoutError(err)
      ) {
        evictGradioClient(cacheKey);
        throw err;
      }
      console.warn(
        `[/api/tryon] Cached Gradio call to ${params.spaceId} failed (reconnecting once):`,
        getErrorDetail(err)
      );
      evictGradioClient(cacheKey);
    }
  }
}

async function imageSourceToBuffer(source: string): Promise<Buffer> {
  if (source.startsWith("data:")) {
    const commaIdx = source.indexOf(",");
    if (commaIdx === -1) {
      throw new Error("Malformed image data URL.");
    }
    const header = source.slice(5, commaIdx);
    const body = source.slice(commaIdx + 1);
    const isBase64 = header.includes(";base64");

    return isBase64
      ? Buffer.from(body, "base64")
      : Buffer.from(decodeURIComponent(body), "utf-8");
  }

  if (source.startsWith("/models/")) {
    const modelsRoot = path.resolve(process.cwd(), "public", "models");
    const relativeName = source.slice("/models/".length);
    const resolvedPath = path.resolve(modelsRoot, relativeName);

    if (
      !resolvedPath.startsWith(`${modelsRoot}${path.sep}`) ||
      relativeName.includes("..")
    ) {
      throw new Error("Invalid preset model path.");
    }

    return readFile(resolvedPath);
  }

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source);
    if (!res.ok) {
      throw new Error(`Failed to load stored image (${res.status}).`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error("Unsupported image source format.");
}

function jpegBufferToBlob(buffer: Buffer): Blob {
  return new Blob([new Uint8Array(buffer)], { type: "image/jpeg" });
}

function pngBufferToBlob(buffer: Buffer): Blob {
  return new Blob([new Uint8Array(buffer)], { type: "image/png" });
}

async function bufferToPngBlob(buffer: Buffer): Promise<Blob> {
  const pngBuffer = await sharp(buffer).png().toBuffer();
  return new Blob([new Uint8Array(pngBuffer)], { type: "image/png" });
}

/**
 * Studio flat-lay garment compositor for default (Regular) Tailor Fit:
 * trims outer transparent margins, composites the isolated transparent `Cutout PNG`
 * onto a clean neutral `#F6F6F4` off-white flat-lay canvas with centered aspect-ratio
 * padding (`768x1024`), so WeShopAI, FitDiT HD (`CLIP-L`/`CLIP-bigG` + `transformer_garm`),
 * and FASHN encode strictly the target garment's fabric, silhouette, wash, and stitching.
 */
async function rawGarmentToPassthroughOutput(
  rawBuffer: Buffer,
  slot: SingleSlotKind,
  fit: TailorFitConfig
): Promise<TailoredCanvasOutput> {
  const studio = await composeStudioFlatLayCanvas({
    rawBuffer,
    canvasWidth: MODEL_WIDTH,
    canvasHeight: MODEL_HEIGHT,
    paddingRatio: 0.08,
  });
  const geometry = computeTailorGeometry({
    hasUpper: slot === "upper" || slot === "outerwear",
    hasLower: slot === "lower",
    upperAspect:
      slot === "upper" || slot === "outerwear" ? studio.aspect : undefined,
    lowerAspect: slot === "lower" ? studio.aspect : undefined,
    fit,
    mode: "ai",
  });

  return {
    buffer: studio.pngBuffer,
    blob: pngBufferToBlob(studio.pngBuffer),
    geometry,
  };
}

/**
 * Optional zero-cost server-side semantic guardrail for legacy non-isolated wardrobe photos:
 * if a private FitDiT server (`VTON_API_URL`) is online, asks its `/isolate-garment` ATR+LIP
 * endpoint to verify and strip any stray skin/shoe/other-garment pixels outside `category`
 * before passing the asset to WeShopAI or Tailored canvas compositing.
 * Fails silently with the original buffer when FitDiT is unavailable or offline.
 */
async function maybeSanitizeGarmentViaFitDiT(params: {
  rawBuffer: Buffer;
  category: "tops" | "bottoms" | "one-pieces";
  vtonApi: VtonApiConfig | null;
}): Promise<Buffer> {
  if (!params.vtonApi) return params.rawBuffer;

  try {
    const backend = await detectVtonApiBackend(params.vtonApi);
    if (backend !== "fitdit") return params.rawBuffer;

    const form = new FormData();
    form.append("image", await bufferToPngBlob(params.rawBuffer), "garment.png");
    form.append("category", params.category);
    form.append("background", "transparent");

    const headers: Record<string, string> = {};
    if (params.vtonApi.secret) {
      headers["x-vton-secret"] = params.vtonApi.secret;
    }

    const res = await fetch(`${params.vtonApi.url}/isolate-garment`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return params.rawBuffer;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) return params.rawBuffer;

    const bytes = await res.arrayBuffer();
    if (bytes.byteLength === 0) return params.rawBuffer;
    return Buffer.from(bytes);
  } catch {
    return params.rawBuffer;
  }
}

/**
 * Renders exact Tailor Fit geometry from `computeTailorGeometry(..., mode: "ai")`
 * onto a canonical 576x864 (2:3) solid #FFFFFF studio canvas using our verified
 * seam-preserving silhouette warp (Method B) — preserving real stitched hems across
 * Long, Regular, Boxy, and Cropped — plus an 8px untucked cast hem shadow across
 * the trousers directly beneath the tee hem so FASHN VTON 1.5 preserves untucked depth.
 */
async function renderTailoredCanvas(
  upperCutout: TrimmedGarmentCutout | null,
  lowerCutout: TrimmedGarmentCutout | null,
  fit: TailorFitConfig
): Promise<TailoredCanvasOutput> {
  const geometry = computeTailorGeometry({
    hasUpper: Boolean(upperCutout),
    hasLower: Boolean(lowerCutout),
    upperAspect: upperCutout?.aspect,
    lowerAspect: lowerCutout?.aspect,
    fit,
    mode: "ai",
  });

  const buildTopLayer = async () => {
    if (!upperCutout || !geometry.upper) return null;
    const rect = geometry.upper;
    const targetW = Math.min(
      FASHN_NATIVE_WIDTH,
      Math.max(16, Math.round(rect.width * FASHN_NATIVE_WIDTH))
    );
    const targetH = Math.min(
      FASHN_NATIVE_HEIGHT,
      Math.max(16, Math.round(rect.height * FASHN_NATIVE_HEIGHT))
    );
    const left = Math.max(
      0,
      Math.min(
        FASHN_NATIVE_WIDTH - targetW,
        Math.round(rect.x * FASHN_NATIVE_WIDTH)
      )
    );
    const top = Math.max(
      0,
      Math.min(
        FASHN_NATIVE_HEIGHT - targetH,
        Math.round(rect.y * FASHN_NATIVE_HEIGHT)
      )
    );

    const { pngBuffer, hemLeftRatio, hemRightRatio } =
      await reshapeTopSeamPreserving({
        cutout: upperCutout,
        targetWidth: targetW,
        targetHeight: targetH,
        cropBottomPct: rect.cropBottomPct,
        widthScale: fit.topWidthScale,
      });

    return {
      input: pngBuffer,
      left,
      top,
      width: targetW,
      height: targetH,
      zIndex: rect.zIndex,
      hemLeftPx: left + Math.round(hemLeftRatio * targetW),
      hemRightPx: left + Math.round(hemRightRatio * targetW),
    };
  };

  const buildBottomLayer = async () => {
    if (!lowerCutout || !geometry.lower) return null;
    const rect = geometry.lower;
    const targetW = Math.min(
      FASHN_NATIVE_WIDTH,
      Math.max(16, Math.round(rect.width * FASHN_NATIVE_WIDTH))
    );
    const targetH = Math.min(
      FASHN_NATIVE_HEIGHT,
      Math.max(16, Math.round(rect.height * FASHN_NATIVE_HEIGHT))
    );
    const left = Math.max(
      0,
      Math.min(
        FASHN_NATIVE_WIDTH - targetW,
        Math.round(rect.x * FASHN_NATIVE_WIDTH)
      )
    );
    const top = Math.max(
      0,
      Math.min(
        FASHN_NATIVE_HEIGHT - targetH,
        Math.round(rect.y * FASHN_NATIVE_HEIGHT)
      )
    );

    const pngBuffer = await reshapeBottomHemPreserving({
      cutout: lowerCutout,
      targetWidth: targetW,
      targetHeight: targetH,
      cropBottomPct: rect.cropBottomPct,
    });

    return {
      input: pngBuffer,
      left,
      top,
      width: targetW,
      height: targetH,
      zIndex: rect.zIndex,
    };
  };

  const [topLayer, bottomLayer] = await Promise.all([
    buildTopLayer(),
    buildBottomLayer(),
  ]);

  const orderedComposites: Array<{
    input: Buffer;
    left: number;
    top: number;
    zIndex: number;
  }> = [];

  if (bottomLayer) {
    orderedComposites.push({
      input: bottomLayer.input,
      left: bottomLayer.left,
      top: bottomLayer.top,
      zIndex: bottomLayer.zIndex,
    });
  }

  // Untucked Hem Depth Shadow: 8px gradient fading rgba(0,0,0,0.22) -> 0 clipped
  // strictly to the horizontal overlap between the tee's bottom hem and the trousers.
  if (
    fit.tuckMode === "untucked" &&
    topLayer &&
    bottomLayer
  ) {
    const shadowLeft = Math.max(topLayer.hemLeftPx, bottomLayer.left);
    const shadowRight = Math.min(
      topLayer.hemRightPx,
      bottomLayer.left + bottomLayer.width
    );
    const shadowW = shadowRight - shadowLeft;
    const shadowH = 8;
    const shadowTop = Math.max(
      bottomLayer.top,
      Math.min(
        FASHN_NATIVE_HEIGHT - shadowH,
        topLayer.top + topLayer.height - 1
      )
    );

    if (shadowW >= 8 && shadowTop < bottomLayer.top + bottomLayer.height) {
      const shadowPng = await createUntuckedHemShadowPng(shadowW, shadowH);
      orderedComposites.push({
        input: shadowPng,
        left: shadowLeft,
        top: shadowTop,
        zIndex: Math.min(topLayer.zIndex - 1, bottomLayer.zIndex + 5),
      });
    }
  }

  if (topLayer) {
    orderedComposites.push({
      input: topLayer.input,
      left: topLayer.left,
      top: topLayer.top,
      zIndex: topLayer.zIndex,
    });
  }

  orderedComposites.sort((a, b) => a.zIndex - b.zIndex);

  const buffer = await sharp({
    create: {
      width: FASHN_NATIVE_WIDTH,
      height: FASHN_NATIVE_HEIGHT,
      channels: 3,
      background: STUDIO_FLATLAY_BG,
    },
  })
    .composite(
      orderedComposites.map(({ input, left, top }) => ({ input, left, top }))
    )
    .png({ compressionLevel: 4 })
    .toBuffer();

  return {
    buffer,
    blob: pngBufferToBlob(buffer),
    geometry,
  };
}

/**
 * Normalizes a model portrait to exact 768x1024 (3:4) opaque RGB JPEG Buffer.
 */
async function normalizeAvatarTo34Buffer(
  source: string | Buffer
): Promise<Buffer> {
  const rawBuffer =
    typeof source === "string" ? await imageSourceToBuffer(source) : source;
  return sharp(rawBuffer)
    .flatten({ background: { r: 250, g: 250, b: 250 } })
    .resize(MODEL_WIDTH, MODEL_HEIGHT, {
      fit: "cover",
      position: "center",
      kernel: "lanczos3",
    })
    .jpeg({ quality: 96, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

/**
 * Strictly for fashn-vton-1.5: downscales 768x1024 (3:4) cleanly to unpadded
 * 576x768 (3:4) lossless PNG. FASHN's TryOnPipeline handles internal ResizePad
 * and unpad natively, guaranteeing 0.0px vertical alignment against originalFullRes.
 */
async function pad34ToFashn576Buffer(buffer34: Buffer): Promise<Buffer> {
  return sharp(buffer34)
    .resize(FASHN_PERSON_WIDTH, FASHN_PERSON_HEIGHT, {
      fit: "cover",
      position: "center",
      kernel: "lanczos3",
    })
    .png({ compressionLevel: 4 })
    .toBuffer();
}

/**
 * Lossless 576x768 (3:4) PNG transfer buffer for Pass 1 -> Pass 2 chaining (avoids
 * double-JPEG compression and skips redundant resampling when FASHN already outputs 576x768).
 */
async function normalizeFashnOutTo576Buffer(rawOut: Buffer): Promise<Buffer> {
  const meta = await sharp(rawOut).metadata();
  if (
    meta.width === FASHN_PERSON_WIDTH &&
    meta.height === FASHN_PERSON_HEIGHT &&
    meta.format === "png"
  ) {
    return rawOut;
  }
  const pipeline =
    meta.width === FASHN_PERSON_WIDTH && meta.height === FASHN_PERSON_HEIGHT
      ? sharp(rawOut)
      : sharp(rawOut).resize(FASHN_PERSON_WIDTH, FASHN_PERSON_HEIGHT, {
          fit: "cover",
          position: "center",
          kernel: "lanczos3",
        });
  return pipeline.png({ compressionLevel: 4 }).toBuffer();
}

async function uncropFashn23To34(rawOut: Buffer): Promise<{
  buffer34: Buffer;
  rawW: number;
  rawH: number;
}> {
  const meta = await sharp(rawOut).metadata();
  const rawW = meta.width ?? 0;
  const rawH = meta.height ?? 0;

  // FASHN VTON 1.5 natively unpads 3:4 inputs back to 3:4 (e.g. 576x768).
  // Only crop 1/18 top & bottom if an external endpoint returned a 2:3 padded frame.
  const isAlready34 =
    rawW > 0 && rawH > 0 && Math.abs(rawW / rawH - 0.75) < 0.04;

  if (rawW > 0 && rawH > 0 && !isAlready34) {
    const cropY = Math.round(rawH / 18);
    const croppedHeight = Math.max(1, rawH - cropY * 2);

    const buffer34 = await sharp(rawOut)
      .extract({
        left: 0,
        top: cropY,
        width: rawW,
        height: croppedHeight,
      })
      .resize(MODEL_WIDTH, MODEL_HEIGHT, {
        fit: "cover",
        position: "center",
        kernel: "lanczos3",
      })
      .png({ compressionLevel: 4 })
      .toBuffer();

    return { buffer34, rawW, rawH };
  }

  const buffer34 = await sharp(rawOut)
    .resize(MODEL_WIDTH, MODEL_HEIGHT, {
      fit: "cover",
      position: "center",
      kernel: "lanczos3",
    })
    .png({ compressionLevel: 4 })
    .toBuffer();

  return { buffer34, rawW, rawH };
}

function buildDiskOffsets(radius: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        offsets.push([dx, dy]);
      }
    }
  }
  return offsets;
}

const DILATE_DISK_OFFSETS = buildDiskOffsets(DILATION_RADIUS);

function dilateMask255(
  src: Uint8Array,
  w: number,
  h: number,
  offsets: Array<[number, number]>
): Uint8Array {
  const dst = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      if (src[rowOff + x] === 0) continue;
      for (let k = 0; k < offsets.length; k++) {
        const nx = x + offsets[k][0];
        const ny = y + offsets[k][1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          dst[ny * w + nx] = 255;
        }
      }
    }
  }
  return dst;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Preserves crisp native 768x1024 face/head pixels strictly in the upper head band
 * (`y <= 34%`, feathered across 28%..34%, and guarded against overwriting high-delta collars)
 * while returning FASHN VTON 1.5's 0.0px-aligned output untouched across the entire
 * torso, waist, and legs — preventing original waistband/shorts from ever leaking back in.
 */
async function preserveHeadOnFashnOutput(
  originalBuffer: Buffer,
  generatedBuffer: Buffer
): Promise<BlendResult> {
  const [orig, gen] = await Promise.all([
    sharp(originalBuffer)
      .resize(MODEL_WIDTH, MODEL_HEIGHT, {
        fit: "cover",
        position: "center",
        kernel: "lanczos3",
      })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(generatedBuffer)
      .resize(MODEL_WIDTH, MODEL_HEIGHT, {
        fit: "cover",
        position: "center",
        kernel: "lanczos3",
      })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
  ]);

  const fullPixels = MODEL_WIDTH * MODEL_HEIGHT;
  const out = new Uint8Array(fullPixels * 3);
  const headSolidY = Math.round(MODEL_HEIGHT * 0.27);
  const headFadeEndY = Math.round(MODEL_HEIGHT * 0.34);
  const fadeSpan = Math.max(1, headFadeEndY - headSolidY);

  let totalRgbDelta = 0;
  let generatedPixels = 0;

  for (let y = 0; y < MODEL_HEIGHT; y++) {
    const baseOrigWeight =
      y <= headSolidY
        ? 1
        : y < headFadeEndY
          ? 1 - (y - headSolidY) / fadeSpan
          : 0;
    const rowOff = y * MODEL_WIDTH;

    for (let x = 0; x < MODEL_WIDTH; x++) {
      const i = (rowOff + x) * 3;
      const delta =
        Math.abs(orig[i] - gen[i]) +
        Math.abs(orig[i + 1] - gen[i + 1]) +
        Math.abs(orig[i + 2] - gen[i + 2]);
      totalRgbDelta += delta;

      // In the upper head zone, protect high-delta garment pixels (e.g. high collar/hoodie)
      // while preserving crisp original face, sunglasses, hair, and sky.
      let origW = baseOrigWeight;
      if (origW > 0 && delta > 48) {
        origW *= clamp(1 - (delta - 48) / 40, 0, 1);
      }

      const genW = 1 - origW;
      if (genW > 0.5) generatedPixels++;

      out[i] = Math.round(gen[i] * genW + orig[i] * origW);
      out[i + 1] = Math.round(gen[i + 1] * genW + orig[i + 1] * origW);
      out[i + 2] = Math.round(gen[i + 2] * genW + orig[i + 2] * origW);
    }
  }

  const buffer = await sharp(out, {
    raw: { width: MODEL_WIDTH, height: MODEL_HEIGHT, channels: 3 },
  })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return {
    buffer,
    meanDiff: totalRgbDelta / fullPixels,
    maskCoveragePct: generatedPixels / fullPixels,
  };
}

/**
 * Direct raw-pixel 2D garment compositor over the crisp 768x1024 original photo (used for CatVTON fallback).
 */
async function blendGarmentIntoOriginal(
  originalBuffer: Buffer,
  generatedBuffer: Buffer
): Promise<BlendResult> {
  const [orig, genRaw, origSmall, genSmall] = await Promise.all([
    sharp(originalBuffer)
      .resize(MODEL_WIDTH, MODEL_HEIGHT, {
        fit: "cover",
        position: "center",
        kernel: "lanczos3",
      })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(generatedBuffer)
      .resize(MODEL_WIDTH, MODEL_HEIGHT, {
        fit: "cover",
        position: "center",
        kernel: "lanczos3",
      })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(originalBuffer)
      .resize(MASK_W, MASK_H, { fit: "cover", position: "center" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(generatedBuffer)
      .resize(MASK_W, MASK_H, { fit: "cover", position: "center" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
  ]);

  const smallPixels = MASK_W * MASK_H;
  const fullPixels = MODEL_WIDTH * MODEL_HEIGHT;

  const rawDiff = new Uint8Array(smallPixels);
  let totalRgbDelta = 0;

  for (let i = 0; i < smallPixels; i++) {
    const o = i * 3;
    const delta =
      Math.abs(origSmall[o] - genSmall[o]) +
      Math.abs(origSmall[o + 1] - genSmall[o + 1]) +
      Math.abs(origSmall[o + 2] - genSmall[o + 2]);
    totalRgbDelta += delta;
    if (delta > CHANGE_DELTA_THRESHOLD) {
      rawDiff[i] = 255;
    }
  }

  const meanDiff = totalRgbDelta / smallPixels;

  const denoised = new Uint8Array(smallPixels);
  for (let y = 1; y < MASK_H - 1; y++) {
    const row = y * MASK_W;
    for (let x = 1; x < MASK_W - 1; x++) {
      const idx = row + x;
      if (rawDiff[idx] === 0) continue;
      let neighbors = 0;
      if (rawDiff[idx - MASK_W - 1]) neighbors++;
      if (rawDiff[idx - MASK_W]) neighbors++;
      if (rawDiff[idx - MASK_W + 1]) neighbors++;
      if (rawDiff[idx - 1]) neighbors++;
      if (rawDiff[idx + 1]) neighbors++;
      if (rawDiff[idx + MASK_W - 1]) neighbors++;
      if (rawDiff[idx + MASK_W]) neighbors++;
      if (rawDiff[idx + MASK_W + 1]) neighbors++;
      if (neighbors >= 2) {
        denoised[idx] = 255;
      }
    }
  }

  const dilatedMask = dilateMask255(
    denoised,
    MASK_W,
    MASK_H,
    DILATE_DISK_OFFSETS
  );

  // Close small interior garment gaps only (<= MAX_INTERIOR_GAP_PX) so stray
  // background noise near frame edges can never flood across face, ocean, or sky.
  for (let y = 0; y < MASK_H; y++) {
    const row = y * MASK_W;
    let lastActive = -1;
    for (let x = 0; x < MASK_W; x++) {
      if (dilatedMask[row + x] === 255) {
        if (lastActive !== -1 && x - lastActive - 1 > 0 && x - lastActive - 1 <= MAX_INTERIOR_GAP_PX) {
          for (let fx = lastActive + 1; fx < x; fx++) {
            dilatedMask[row + fx] = 255;
          }
        }
        lastActive = x;
      }
    }
  }

  const alphaBytes = await sharp(dilatedMask, {
    raw: { width: MASK_W, height: MASK_H, channels: 1 },
  })
    .resize(MODEL_WIDTH, MODEL_HEIGHT, { kernel: "lanczos3" })
    .blur(3.5)
    .toColourspace("b-w")
    .extractChannel(0)
    .raw()
    .toBuffer();

  if (alphaBytes.length !== fullPixels) {
    throw new Error(
      `Unexpected alpha mask length: ${alphaBytes.length} (expected ${fullPixels})`
    );
  }

  let activeAlphaPixels = 0;
  for (let p = 0; p < fullPixels; p++) {
    if (alphaBytes[p] > 25) {
      activeAlphaPixels++;
    }
  }

  const maskCoveragePct = activeAlphaPixels / fullPixels;

  if (maskCoveragePct < MIN_MASK_COVERAGE) {
    console.warn(
      "[TRYON] Mask coverage below 1.5%, returning generated output directly:",
      {
        meanRgbDiff: Number(meanDiff.toFixed(1)),
        maskCoveragePct: Number((maskCoveragePct * 100).toFixed(2)),
      }
    );
    const directJpeg = await sharp(genRaw, {
      raw: { width: MODEL_WIDTH, height: MODEL_HEIGHT, channels: 3 },
    })
      .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
      .toBuffer();
    return { buffer: directJpeg, meanDiff, maskCoveragePct };
  }

  // Keep FASHN/CatVTON native lighting and natural fabric grain untouched (no artificial sharpening).
  const gen = genRaw;

  const out = new Uint8Array(fullPixels * 3);
  for (let p = 0; p < fullPixels; p++) {
    const a = alphaBytes[p] / 255;
    const invA = 1 - a;
    const i = p * 3;
    out[i] = Math.round(gen[i] * a + orig[i] * invA);
    out[i + 1] = Math.round(gen[i + 1] * a + orig[i + 1] * invA);
    out[i + 2] = Math.round(gen[i + 2] * a + orig[i + 2] * invA);
  }

  const buffer = await sharp(out, {
    raw: { width: MODEL_WIDTH, height: MODEL_HEIGHT, channels: 3 },
  })
    .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
    .toBuffer();

  return { buffer, meanDiff, maskCoveragePct };
}

async function createBlankMaskBlob(): Promise<Blob> {
  const maskBuffer = await sharp({
    create: {
      width: MODEL_WIDTH,
      height: MODEL_HEIGHT,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();

  return new Blob([new Uint8Array(maskBuffer)], { type: "image/png" });
}

function extractResultImageUrl(data: unknown): string | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const first = data[0];
  if (typeof first === "string" && first.length > 0) {
    return first;
  }

  if (first && typeof first === "object") {
    const record = first as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.length > 0) {
      return record.url;
    }
    if (typeof record.data === "string" && record.data.length > 0) {
      return record.data;
    }
  }

  return null;
}

async function fetchResultBuffer(
  rawUrl: string,
  hfToken?: `hf_${string}`
): Promise<{ buffer: Buffer; contentType: string }> {
  if (rawUrl.startsWith("data:")) {
    const commaIdx = rawUrl.indexOf(",");
    const header = rawUrl.slice(5, commaIdx);
    const contentType = header.split(";")[0] || "image/png";
    const buffer = await imageSourceToBuffer(rawUrl);
    return { buffer, contentType };
  }

  const headers: HeadersInit = hfToken
    ? { Authorization: `Bearer ${hfToken}` }
    : {};
  const res = await fetch(rawUrl, { headers });
  if (!res.ok) {
    throw new Error(`Failed to fetch try-on output image (${res.status}).`);
  }

  const contentType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

function getSlotTailorSlice(
  tailorFit: TailorFitConfig,
  slot: SingleSlotKind
): { cropPct: number; widthScale: number } {
  return slot === "lower"
    ? {
        cropPct: tailorFit.bottomCropPct,
        widthScale: tailorFit.bottomWidthScale,
      }
    : {
        cropPct: tailorFit.topCropPct,
        widthScale: tailorFit.topWidthScale,
      };
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls a private GPU FastAPI FASHN VTON 1.5 server with native 576x864
 * multipart/form-data payloads:
 *  1. Submits async job to `POST ${VTON_API_URL}/jobs` -> `{ job_id }`, then polls
 *     `GET ${VTON_API_URL}/jobs/${job_id}` every 2.5s (up to 240s) until an `image/*`
 *     response arrives (bypassing Cloudflare Quick Tunnel's 100s proxy timeout).
 *  2. If `POST /jobs` returns 404 (older sync server), falls back to `POST /try-on`.
 */
async function predictViaVtonApi(params: {
  config: VtonApiConfig;
  person576Buffer: Buffer;
  garment576Blob: Blob;
  category: "tops" | "bottoms" | "one-pieces";
  timesteps: number;
  guidanceScale: number;
  segmentationFree: boolean;
}): Promise<Buffer> {
  const buildForm = () => {
    const form = new FormData();
    form.append(
      "person_image",
      pngBufferToBlob(params.person576Buffer),
      "person.png"
    );
    form.append("garment_image", params.garment576Blob, "garment.png");
    form.append("category", params.category);
    form.append("garment_photo_type", "flat-lay");
    form.append("num_timesteps", String(params.timesteps));
    form.append("guidance_scale", String(params.guidanceScale));
    form.append("seed", String(FASHN_SEED));
    form.append(
      "segmentation_free",
      params.segmentationFree ? "true" : "false"
    );
    return form;
  };

  const headers: Record<string, string> = {};
  if (params.config.secret) {
    headers["x-vton-secret"] = params.config.secret;
  }

  const readImageResponse = async (
    res: Response,
    label: string
  ): Promise<Buffer> => {
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (
      contentType &&
      !contentType.startsWith("image/") &&
      !contentType.includes("application/octet-stream")
    ) {
      const preview = await res.text().catch(() => "");
      throw new Error(
        `VTON API (${label}) returned non-image response (${contentType})${
          preview ? `: ${preview.slice(0, 200)}` : ""
        }`
      );
    }
    const rawBytes = await res.arrayBuffer();
    if (rawBytes.byteLength === 0) {
      throw new Error(
        `VTON API (${label}) returned an empty image body for ${params.category} pass.`
      );
    }
    return Buffer.from(rawBytes);
  };

  // 1. Try async job submission (`POST /jobs`) with retries for transient Cloudflare tunnel resets
  const maxSubmitAttempts = 3;
  let submitRes: Response | null = null;
  let lastSubmitErr: unknown = null;
  for (let attempt = 1; attempt <= maxSubmitAttempts; attempt++) {
    try {
      const res = await fetch(`${params.config.url}/jobs`, {
        method: "POST",
        headers,
        body: buildForm(),
        signal: AbortSignal.timeout(VTON_API_SUBMIT_TIMEOUT_MS),
      });
      if (
        (res.status === 502 || res.status === 503 || res.status === 504) &&
        attempt < maxSubmitAttempts
      ) {
        console.warn(
          `[/api/tryon] VTON POST /jobs attempt ${attempt} returned HTTP ${res.status}, retrying...`
        );
        await sleepMs(attempt * 1500);
        continue;
      }
      submitRes = res;
      break;
    } catch (err) {
      lastSubmitErr = err;
      if (attempt < maxSubmitAttempts) {
        console.warn(
          `[/api/tryon] VTON POST /jobs attempt ${attempt} failed (${getErrorDetail(err)}), retrying...`
        );
        await sleepMs(attempt * 1500);
        continue;
      }
      throw err;
    }
  }
  if (!submitRes) {
    throw lastSubmitErr ?? new Error("VTON API POST /jobs failed.");
  }

  // Backwards-compatible fallback for older synchronous servers that only expose `POST /try-on`
  if (submitRes.status === 404) {
    const syncRes = await fetch(`${params.config.url}/try-on`, {
      method: "POST",
      headers,
      body: buildForm(),
      signal: AbortSignal.timeout(VTON_API_TIMEOUT_MS),
    });

    if (!syncRes.ok) {
      const errBody = await syncRes.text().catch(() => "");
      throw new Error(
        `VTON API (${params.category}) returned HTTP ${syncRes.status}${
          errBody ? `: ${errBody.slice(0, 240)}` : ""
        }`
      );
    }

    return readImageResponse(syncRes, "/try-on");
  }

  if (!submitRes.ok) {
    const errBody = await submitRes.text().catch(() => "");
    throw new Error(
      `VTON API POST /jobs (${params.category}) returned HTTP ${submitRes.status}${
        errBody ? `: ${errBody.slice(0, 240)}` : ""
      }`
    );
  }

  const submitPayload = (await submitRes.json().catch(() => null)) as {
    job_id?: unknown;
  } | null;
  const jobId =
    typeof submitPayload?.job_id === "string"
      ? submitPayload.job_id.trim()
      : "";
  if (!jobId) {
    throw new Error(
      `VTON API POST /jobs (${params.category}) did not return a valid job_id.`
    );
  }

  // 2. Poll `GET /jobs/${job_id}` every 2500ms (up to 420s) until `image/*` arrives
  const pollUrl = `${params.config.url}/jobs/${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + VTON_API_POLL_MAX_MS;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    let pollRes: Response;
    try {
      pollRes = await fetch(pollUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(VTON_API_POLL_REQ_TIMEOUT_MS),
      });
    } catch (pollNetErr) {
      // Tolerate brief transient network blips while the GPU job is still running
      if (Date.now() + VTON_API_POLL_INTERVAL_MS >= deadline) {
        throw pollNetErr;
      }
      await sleepMs(VTON_API_POLL_INTERVAL_MS);
      continue;
    }

    const contentType = (pollRes.headers.get("content-type") ?? "").toLowerCase();

    if (pollRes.ok && contentType.startsWith("image/")) {
      try {
        return await readImageResponse(pollRes, `/jobs/${jobId}`);
      } catch (downloadErr) {
        // If Cloudflare resets the socket mid-PNG download, retry on the next poll
        if (Date.now() + VTON_API_POLL_INTERVAL_MS >= deadline) {
          throw downloadErr;
        }
        console.warn(
          `[/api/tryon] VTON GET /jobs/${jobId} image download interrupted (${getErrorDetail(downloadErr)}), retrying...`
        );
        await sleepMs(VTON_API_POLL_INTERVAL_MS);
        continue;
      }
    }

    if (pollRes.status === 401 || pollRes.status === 403 || pollRes.status === 404) {
      const errBody = await pollRes.text().catch(() => "");
      throw new Error(
        `VTON API GET /jobs/${jobId} returned HTTP ${pollRes.status}${
          errBody ? `: ${errBody.slice(0, 240)}` : ""
        }`
      );
    }

    // Transient proxy errors (Cloudflare 502/503/504): wait and keep polling
    if (pollRes.status === 502 || pollRes.status === 503 || pollRes.status === 504) {
      if (Date.now() + VTON_API_POLL_INTERVAL_MS >= deadline) {
        throw new Error(
          `VTON API GET /jobs/${jobId} failed with HTTP ${pollRes.status}.`
        );
      }
      await sleepMs(VTON_API_POLL_INTERVAL_MS);
      continue;
    }

    if (contentType.includes("application/json")) {
      const jobData = (await pollRes.json().catch(() => null)) as {
        status?: unknown;
        error?: unknown;
        detail?: unknown;
      } | null;
      const status =
        typeof jobData?.status === "string"
          ? jobData.status.toLowerCase()
          : "";
      const errMsg =
        typeof jobData?.error === "string"
          ? jobData.error
          : typeof jobData?.detail === "string"
            ? jobData.detail
            : "";

      if (status === "error" || status === "failed" || !pollRes.ok) {
        throw new Error(
          `VTON API job ${jobId} failed${
            errMsg ? `: ${errMsg.slice(0, 240)}` : ` (HTTP ${pollRes.status})`
          }`
        );
      }
    } else if (!pollRes.ok) {
      const errBody = await pollRes.text().catch(() => "");
      throw new Error(
        `VTON API GET /jobs/${jobId} returned HTTP ${pollRes.status}${
          errBody ? `: ${errBody.slice(0, 240)}` : ""
        }`
      );
    }

    const waitMs = Math.min(VTON_API_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()));
    if (waitMs > 0) {
      await sleepMs(waitMs);
    }
  }

  throw new Error(
    `VTON API job ${jobId} timed out after ${Math.round(VTON_API_POLL_MAX_MS / 1000)}s.`
  );
}

/**
 * Primary Engine: FASHN VTON 1.5 — executed either against a private GPU
 * FastAPI override (`VTON_API_URL`, engine `"vton-api"`) or Hugging Face Gradio
 * (`FASHN_SPACE_ID`, engine `"fashn-vton-1.5"`).
 * - Full outfit default (`renderMode === "composite"`): single-pass `category: "one-pieces"`
 *   using exact `renderTailoredCanvas(upper, lower, fit)` (`guidance_scale: 1.8 / 2.5`).
 * - Explicit `"two-pass"` mode: always Pass 1 (`bottoms`) -> Pass 2 (`tops`), forcing
 *   `segmentation_free: true` on untucked Pass 2 so the top drapes cleanly over the trousers.
 * - Single piece: 1 pass (`tops` or `bottoms`) using exact fixed-anchor `renderTailoredCanvas`.
 */
async function runFashnTryOn(params: {
  avatarHash: string;
  original34Buffer: Buffer;
  upperItemId: string | null;
  outerwearItemId: string | null;
  lowerItemId: string | null;
  compositeCanvas: TailoredCanvasOutput | null;
  upperCanvas: TailoredCanvasOutput | null;
  outerwearCanvas: TailoredCanvasOutput | null;
  layeredUpperCanvas: TailoredCanvasOutput | null;
  lowerCanvas: TailoredCanvasOutput | null;
  cleanSwap: boolean;
  tailorFit: TailorFitConfig;
  renderMode: TryOnRenderMode;
  highDetail: boolean;
  hfToken?: `hf_${string}`;
  vtonApi?: VtonApiConfig;
  vtonBackend?: VtonApiBackend;
  onPass1Complete?: (event: Pass1PreviewEvent) => Promise<void>;
}): Promise<EngineRunResult> {
  const spaceId = getFashnSpaceId();
  const isVtonApi = Boolean(params.vtonApi);
  const isFitDit = isVtonApi && params.vtonBackend === "fitdit";
  const engineKind: TryOnEngineKind = isFitDit
    ? "fitdit-api"
    : isVtonApi
      ? "vton-api"
      : "fashn-vton-1.5";
  const isDefaultFit = isDefaultTailorFit(params.tailorFit);
  const hasAnyUpper = Boolean(params.upperCanvas || params.outerwearCanvas);
  const autoCleanMask = needsAutoCleanMask(params.tailorFit, {
    hasUpper: hasAnyUpper,
    hasLower: Boolean(params.lowerCanvas),
  });
  const fullOrBottomSegFree = !params.cleanSwap;
  const singleTopSegFree = !(params.cleanSwap || autoCleanMask);

  // FitDiT SD3 uses guidance_scale = 2.0; FASHN VTON 1.5 uses 1.5 (default) / 1.7 (tailored).
  const guidanceScale = isFitDit
    ? FITDIT_GUIDANCE
    : clamp(isDefaultFit ? 1.5 : 1.7, 1.5, 1.8);

  const fitditSteps = params.highDetail
    ? FITDIT_STEPS_HIGH_DETAIL
    : FITDIT_STEPS_DEFAULT;
  const compositeSteps = isFitDit
    ? fitditSteps
    : isVtonApi
      ? params.highDetail
        ? VTON_API_STEPS_HIGH_DETAIL
        : VTON_API_STEPS_DEFAULT
      : params.highDetail
        ? FASHN_STEPS_HIGH_DETAIL
        : FASHN_STEPS_COMPOSITE;
  const singleSteps = isFitDit
    ? fitditSteps
    : isVtonApi
      ? params.highDetail
        ? VTON_API_STEPS_HIGH_DETAIL
        : VTON_API_STEPS_DEFAULT
      : params.highDetail
        ? FASHN_STEPS_HIGH_DETAIL
        : FASHN_STEPS_SINGLE;
  const pass1Steps = isFitDit
    ? fitditSteps
    : isVtonApi
      ? params.highDetail
        ? VTON_API_STEPS_HIGH_DETAIL
        : VTON_API_STEPS_DEFAULT
      : params.highDetail
        ? FASHN_STEPS_HIGH_DETAIL
        : FASHN_STEPS_PASS1;
  const pass2Steps = isFitDit
    ? fitditSteps
    : isVtonApi
      ? params.highDetail
        ? VTON_API_STEPS_HIGH_DETAIL
        : VTON_API_STEPS_DEFAULT
      : params.highDetail
        ? FASHN_STEPS_HIGH_DETAIL
        : FASHN_STEPS_PASS2;

  const preparePersonInputBuffer = async (buf34: Buffer): Promise<Buffer> => {
    if (isFitDit) {
      return sharp(buf34)
        .resize(MODEL_WIDTH, MODEL_HEIGHT, {
          fit: "cover",
          position: "center",
          kernel: "lanczos3",
        })
        .png({ compressionLevel: 4 })
        .toBuffer();
    }
    return pad34ToFashn576Buffer(buf34);
  };

  const runSinglePass = async (
    personInputBuffer: Buffer,
    garment576Blob: Blob,
    category: "tops" | "bottoms" | "one-pieces",
    timesteps: number,
    guidanceScale: number,
    segmentationFree: boolean
  ): Promise<{
    buffer34: Buffer;
    fashnPadded576: Buffer;
    rawW: number;
    rawH: number;
  }> => {
    let rawOutBuffer: Buffer;
    if (params.vtonApi) {
      rawOutBuffer = await predictViaVtonApi({
        config: params.vtonApi,
        person576Buffer: personInputBuffer,
        garment576Blob,
        category,
        timesteps,
        guidanceScale,
        segmentationFree,
      });
    } else {
      const prediction = await predictWithCachedClient({
        spaceId,
        hfToken: params.hfToken,
        preferredEndpoint: "/try_on",
        fallbackParamName: "garment_image",
        payload: {
          person_image: handle_file(pngBufferToBlob(personInputBuffer)),
          garment_image: handle_file(garment576Blob),
          category,
          garment_photo_type: "flat-lay",
          num_timesteps: timesteps,
          guidance_scale: guidanceScale,
          seed: FASHN_SEED,
          segmentation_free: segmentationFree,
        },
      });

      const url = extractResultImageUrl(prediction.data);
      if (!url) {
        throw new Error(`FASHN VTON returned no image for ${category} pass.`);
      }

      const fetched = await fetchResultBuffer(url, params.hfToken);
      rawOutBuffer = fetched.buffer;
    }

    const uncropped = await uncropFashn23To34(rawOutBuffer);
    const nextPassBuffer = isFitDit
      ? uncropped.buffer34
      : await normalizeFashnOutTo576Buffer(rawOutBuffer);

    return {
      buffer34: uncropped.buffer34,
      fashnPadded576: nextPassBuffer,
      rawW: uncropped.rawW,
      rawH: uncropped.rawH,
    };
  };

  // 1-Pass Composite mode (Full outfit or Top + Outerwear layered sheet)
  if (params.renderMode === "composite") {
    if (params.compositeCanvas && params.lowerCanvas && hasAnyUpper) {
      const tPass1 = Date.now();
      const personInput = await preparePersonInputBuffer(params.original34Buffer);
      const out = await runSinglePass(
        personInput,
        params.compositeCanvas.blob,
        "one-pieces",
        compositeSteps,
        guidanceScale,
        fullOrBottomSegFree
      );
      return {
        generated34Buffer: out.buffer34,
        passes: ["composite"],
        rawW: out.rawW,
        rawH: out.rawH,
        pass1Ms: Date.now() - tPass1,
        pass2Ms: 0,
        cachedPass1: false,
      };
    }
    if (params.layeredUpperCanvas && !params.lowerCanvas) {
      const tPass1 = Date.now();
      const personInput = await preparePersonInputBuffer(params.original34Buffer);
      const out = await runSinglePass(
        personInput,
        params.layeredUpperCanvas.blob,
        "tops",
        compositeSteps,
        guidanceScale,
        singleTopSegFree
      );
      return {
        generated34Buffer: out.buffer34,
        passes: ["composite"],
        rawW: out.rawW,
        rawH: out.rawH,
        pass1Ms: Date.now() - tPass1,
        pass2Ms: 0,
        cachedPass1: false,
      };
    }
  }

  // Build ordered sequential pass queue:
  // - FASHN VTON 1.5: supports true Shirt -> Jacket sequential passes (forcing
  //   `segmentation_free: true` on the jacket pass so open fronts reveal the shirt!).
  //   - Untucked:  Bottoms -> Shirt -> Jacket
  //   - Tucked In: Shirt -> Bottoms -> Jacket
  // - FitDiT HD: merges Shirt + Jacket into `layeredUpperCanvas` because FitDiT's
  //   upper-body agnostic rectangle mask would otherwise erase the inner shirt.
  interface PassStep {
    slot: SingleSlotKind;
    itemId: string;
    category: "tops" | "bottoms";
    canvas: TailoredCanvasOutput;
    segFree: boolean;
  }

  const isTucked = params.tailorFit.tuckMode === "tucked";
  const hasBothTopAndOuter = Boolean(
    params.upperCanvas &&
      params.outerwearCanvas &&
      params.upperItemId &&
      params.outerwearItemId
  );

  const lowerStep: PassStep | null =
    params.lowerCanvas && params.lowerItemId
      ? {
          slot: "lower",
          itemId: params.lowerItemId,
          category: "bottoms",
          canvas: params.lowerCanvas,
          segFree: fullOrBottomSegFree,
        }
      : null;

  const upperSteps: PassStep[] = [];
  if (hasBothTopAndOuter && params.layeredUpperCanvas) {
    // Unified layered upper flat-lay (Open Front / Collar + Hem / Collar Only):
    // sending Shirt+Jacket as ONE synthesized flat-lay guarantees FASHN/FitDiT never
    // overwrite the inner shirt during a separate jacket pass, and cuts 3 passes -> 2.
    const segFreeForLayered = lowerStep
      ? !isTucked && params.tailorFit.topCropPct > 0
        ? false
        : fullOrBottomSegFree
      : singleTopSegFree;
    upperSteps.push({
      slot: "outerwear",
      itemId: `${params.upperItemId}+${params.outerwearItemId}:${params.tailorFit.outerwearStyle}`,
      category: "tops",
      canvas: params.layeredUpperCanvas,
      segFree: segFreeForLayered,
    });
  } else {
    if (params.upperCanvas && params.upperItemId) {
      const segFreeForTop = lowerStep
        ? !isTucked && params.tailorFit.topCropPct > 0
          ? false
          : fullOrBottomSegFree
        : singleTopSegFree;
      upperSteps.push({
        slot: "upper",
        itemId: params.upperItemId,
        category: "tops",
        canvas: params.upperCanvas,
        segFree: segFreeForTop,
      });
    }
    if (params.outerwearCanvas && params.outerwearItemId) {
      const segFreeForOuter = lowerStep
        ? !isTucked && params.tailorFit.topCropPct > 0
          ? false
          : fullOrBottomSegFree
        : singleTopSegFree;
      upperSteps.push({
        slot: "outerwear",
        itemId: params.outerwearItemId,
        category: "tops",
        canvas: params.outerwearCanvas,
        segFree: segFreeForOuter,
      });
    }
  }

  const passQueue: PassStep[] = [];
  if (isTucked && lowerStep && upperSteps.length > 0) {
    // Shirt first -> Bottoms (tucked waistband over shirt) -> Outerwear jacket over both
    passQueue.push(upperSteps[0], lowerStep, ...upperSteps.slice(1));
  } else {
    // Untucked: Bottoms -> Shirt -> Jacket
    if (lowerStep) passQueue.push(lowerStep);
    passQueue.push(...upperSteps);
  }

  if (passQueue.length === 0) {
    throw new Error("No garment selected for FASHN VTON.");
  }

  let currentBuffer34 = params.original34Buffer;
  let currentNextInput: Buffer | null = null;
  let priorChainKey: string | undefined;
  let pass1Ms = 0;
  let pass2Ms = 0;
  let cachedPass1 = false;
  let lastRawW = MODEL_WIDTH;
  let lastRawH = MODEL_HEIGHT;
  const executedPasses: TryOnSlotKind[] = [];

  for (let i = 0; i < passQueue.length; i++) {
    const step = passQueue[i];
    const isLast = i === passQueue.length - 1;
    const stepCount =
      passQueue.length === 1
        ? singleSteps
        : i === 0
          ? pass1Steps
          : pass2Steps;
    executedPasses.push(step.slot);

    let stepKey: string | undefined;
    let stepCached = false;

    if (!isLast) {
      stepKey = buildPass1CacheKey({
        avatarHash: params.avatarHash,
        engine: engineKind,
        pass1ItemId: step.itemId,
        pass1Slot: step.slot,
        pass1TailorSlice: getSlotTailorSlice(params.tailorFit, step.slot),
        pass1SegFree: step.segFree,
        highDetail: params.highDetail,
        priorChainKey,
      });

      const cached = getCachedPass1(stepKey);
      if (cached && cached.fashnPadded576) {
        stepCached = true;
        if (i === 0) cachedPass1 = true;
        currentBuffer34 = cached.buffer34;
        currentNextInput = cached.fashnPadded576;
        lastRawW = cached.rawW;
        lastRawH = cached.rawH;
      }
    }

    if (!stepCached) {
      const tStep = Date.now();
      const personInput =
        currentNextInput ?? (await preparePersonInputBuffer(currentBuffer34));
      const out = await runSinglePass(
        personInput,
        step.canvas.blob,
        step.category,
        stepCount,
        guidanceScale,
        step.segFree
      );
      const elapsed = Date.now() - tStep;
      if (i === 0) pass1Ms += elapsed;
      else pass2Ms += elapsed;

      currentBuffer34 = out.buffer34;
      currentNextInput = out.fashnPadded576;
      lastRawW = out.rawW;
      lastRawH = out.rawH;

      if (stepKey) {
        setCachedPass1(stepKey, {
          buffer34: out.buffer34,
          fashnPadded576: out.fashnPadded576,
          rawW: out.rawW,
          rawH: out.rawH,
          engine: engineKind,
        });
      }
    }

    if (stepKey) {
      priorChainKey = stepKey;
    }

    if (!isLast && params.onPass1Complete) {
      await params.onPass1Complete({
        buffer34: currentBuffer34,
        cachedPass1: stepCached,
        nextSlot: passQueue[i + 1].slot,
        stepIndex: i + 1,
        totalSteps: passQueue.length,
        engine: engineKind,
      });
    }
  }

  return {
    generated34Buffer: currentBuffer34,
    passes: executedPasses,
    rawW: lastRawW,
    rawH: lastRawH,
    pass1Ms,
    pass2Ms,
    cachedPass1,
  };
}

/**
 * Automatic Fallback Engine 1: CatVTON (native 3:4, always Bottoms -> Top for 2-pass).
 */
async function runCatVtonFallback(params: {
  avatarHash: string;
  original34Buffer: Buffer;
  upperItemId: string | null;
  lowerItemId: string | null;
  upperCanvas: TailoredCanvasOutput | null;
  lowerCanvas: TailoredCanvasOutput | null;
  tailorFit: TailorFitConfig;
  highDetail: boolean;
  hfToken?: `hf_${string}`;
  onPass1Complete?: (event: Pass1PreviewEvent) => Promise<void>;
}): Promise<EngineRunResult> {
  const blankMaskBlob = await createBlankMaskBlob();
  const steps = params.highDetail ? CATVTON_STEPS_HIGH_DETAIL : CATVTON_STEPS;
  let lastError: unknown = null;

  for (const spaceId of CATVTON_FALLBACK_SPACES) {
    try {
      const runPass = async (
        person34Buffer: Buffer,
        garmentBlob: Blob,
        slot: SingleSlotKind
      ): Promise<{ buffer34: Buffer; rawW: number; rawH: number }> => {
        const prediction = await predictWithCachedClient({
          spaceId,
          hfToken: params.hfToken,
          preferredEndpoint: "/submit_function",
          fallbackParamName: "cloth_type",
          payload: {
            person_image: {
              background: handle_file(jpegBufferToBlob(person34Buffer)),
              layers: [handle_file(blankMaskBlob)],
              composite: null,
            },
            cloth_image: handle_file(garmentBlob),
            cloth_type: slot === "lower" ? "lower" : "upper",
            num_inference_steps: steps,
            guidance_scale: CATVTON_GUIDANCE,
            seed: CATVTON_SEED,
            show_type: CATVTON_SHOW_TYPE,
          },
        });

        const url = extractResultImageUrl(prediction.data);
        if (!url) {
          throw new Error(`CatVTON returned no image for ${slot} pass.`);
        }

        const { buffer } = await fetchResultBuffer(url, params.hfToken);
        const meta = await sharp(buffer).metadata();
        const buffer34 = await normalizeAvatarTo34Buffer(buffer);
        return {
          buffer34,
          rawW: meta.width ?? MODEL_WIDTH,
          rawH: meta.height ?? MODEL_HEIGHT,
        };
      };

      if (
        params.upperCanvas &&
        params.lowerCanvas &&
        params.upperItemId &&
        params.lowerItemId
      ) {
        // Always Pass 1 (lower) -> Pass 2 (upper) so trousers never overwrite the top
        const pass1Key = buildPass1CacheKey({
          avatarHash: params.avatarHash,
          engine: "catvton",
          pass1ItemId: params.lowerItemId,
          pass1Slot: "lower",
          pass1TailorSlice: getSlotTailorSlice(params.tailorFit, "lower"),
          pass1SegFree: false,
          highDetail: params.highDetail,
        });

        let pass1Ms = 0;
        let cachedPass1 = false;
        let pass1Buffer34: Buffer;

        const cached = getCachedPass1(pass1Key);
        if (cached) {
          cachedPass1 = true;
          pass1Buffer34 = cached.buffer34;
        } else {
          const tPass1 = Date.now();
          const pass1 = await runPass(
            params.original34Buffer,
            params.lowerCanvas.blob,
            "lower"
          );
          pass1Ms = Date.now() - tPass1;
          pass1Buffer34 = pass1.buffer34;
          setCachedPass1(pass1Key, {
            buffer34: pass1.buffer34,
            rawW: pass1.rawW,
            rawH: pass1.rawH,
            engine: "catvton",
          });
        }

        if (params.onPass1Complete) {
          await params.onPass1Complete({
            buffer34: pass1Buffer34,
            cachedPass1,
            nextSlot: "upper",
            stepIndex: 1,
            totalSteps: 2,
            engine: "catvton",
          });
        }

        const tPass2 = Date.now();
        const pass2 = await runPass(
          pass1Buffer34,
          params.upperCanvas.blob,
          "upper"
        );
        return {
          generated34Buffer: pass2.buffer34,
          passes: ["lower", "upper"],
          rawW: pass2.rawW,
          rawH: pass2.rawH,
          pass1Ms,
          pass2Ms: Date.now() - tPass2,
          cachedPass1,
        };
      }

      if (params.lowerCanvas) {
        const tPass1 = Date.now();
        const out = await runPass(
          params.original34Buffer,
          params.lowerCanvas.blob,
          "lower"
        );
        return {
          generated34Buffer: out.buffer34,
          passes: ["lower"],
          rawW: out.rawW,
          rawH: out.rawH,
          pass1Ms: Date.now() - tPass1,
          pass2Ms: 0,
          cachedPass1: false,
        };
      }

      if (params.upperCanvas) {
        const tPass1 = Date.now();
        const out = await runPass(
          params.original34Buffer,
          params.upperCanvas.blob,
          "upper"
        );
        return {
          generated34Buffer: out.buffer34,
          passes: ["upper"],
          rawW: out.rawW,
          rawH: out.rawH,
          pass1Ms: Date.now() - tPass1,
          pass2Ms: 0,
          cachedPass1: false,
        };
      }

      throw new Error("No garment selected for CatVTON.");
    } catch (err) {
      lastError = err;
      console.warn(
        `[/api/tryon] Fallback Space ${spaceId} failed:`,
        getErrorDetail(err)
      );
    }
  }

  throw lastError ?? new Error("All CatVTON fallback Spaces failed.");
}

/**
 * Primary Engine: WeShopAI/WeShopAI-Virtual-Try-On (native 1520x2048 photorealistic output).
 * - Uses raw unmodified garments when Tailor Fit is at default, and seam-preserving
 *   reshaped flat-lay cutouts when Tailor Fit is modified.
 * - In `"two-pass"` mode:
 *     - Untucked:  Pass 1 (lower) -> Pass 2 (upper) so the top drapes cleanly over trousers.
 *     - Tucked In: Pass 1 (upper) -> Pass 2 (lower) so the trouser waistband sits over the hem.
 * - In `"composite"` mode for full outfits, sends the 1:1 composited flat-lay in 1 pass.
 */
async function runWeShopTryOn(params: {
  avatarHash: string;
  original34Buffer: Buffer;
  upperItemId: string | null;
  outerwearItemId: string | null;
  lowerItemId: string | null;
  compositeCanvas: TailoredCanvasOutput | null;
  upperCanvas: TailoredCanvasOutput | null;
  outerwearCanvas: TailoredCanvasOutput | null;
  layeredUpperCanvas: TailoredCanvasOutput | null;
  lowerCanvas: TailoredCanvasOutput | null;
  tailorFit: TailorFitConfig;
  renderMode: TryOnRenderMode;
  highDetail: boolean;
  onPass1Complete?: (event: Pass1PreviewEvent) => Promise<void>;
}): Promise<EngineRunResult> {
  const runPass = async (
    person34Buffer: Buffer,
    garmentBuffer: Buffer,
    label: string
  ): Promise<{ buffer34: Buffer; rawW: number; rawH: number }> => {
    const [garmentPngBlob, personPngBlob] = await Promise.all([
      bufferToPngBlob(garmentBuffer),
      bufferToPngBlob(person34Buffer),
    ]);

    const runWithLogs = async (): Promise<{
      data: unknown;
      warningLog: string | null;
    }> => {
      const client = await withTimeout(
        Client.connect(WESHOP_SPACE_ID, {
          events: ["data", "status", "log"],
        }),
        30_000,
        `Gradio connect (${WESHOP_SPACE_ID})`
      );
      try {
        let finalData: unknown = null;
        let warningLog: string | null = null;
        const job = client.submit("/generate_image", {
          main_image: handle_file(garmentPngBlob),
          background_image: handle_file(personPngBlob),
        });
        for await (const rawMsg of job as AsyncIterable<Record<string, unknown>>) {
          if (rawMsg?.type === "log" && typeof rawMsg.log === "string" && rawMsg.log.trim()) {
            warningLog = rawMsg.log.trim();
          } else if (rawMsg?.type === "data") {
            finalData = rawMsg.data;
          }
        }
        return { data: finalData, warningLog };
      } finally {
        try {
          client.close();
        } catch {
          // ignore close errors
        }
      }
    };

    const { data, warningLog } = await withTimeout(
      runWithLogs(),
      WESHOP_PASS_TIMEOUT_MS,
      `WeShopAI (${label})`
    );

    const url = extractResultImageUrl(data);
    if (!url) {
      throw new Error(
        warningLog
          ? `WeShopAI (${label}): ${warningLog}`
          : `WeShopAI returned no try-on image for ${label} pass.`
      );
    }

    const { buffer } = await withTimeout(
      fetchResultBuffer(url),
      30_000,
      `WeShopAI image fetch (${label})`
    );
    const meta = await sharp(buffer).metadata();
    const buffer34 = await normalizeAvatarTo34Buffer(buffer);
    return {
      buffer34,
      rawW: meta.width ?? MODEL_WIDTH,
      rawH: meta.height ?? MODEL_HEIGHT,
    };
  };

  // 1-Pass Composite mode (Full outfit or Top + Outerwear layered sheet)
  if (params.renderMode === "composite") {
    const compBuf =
      params.compositeCanvas?.buffer ??
      (!params.lowerCanvas ? params.layeredUpperCanvas?.buffer : null);
    if (compBuf) {
      const tPass1 = Date.now();
      const out = await runPass(params.original34Buffer, compBuf, "composite");
      return {
        generated34Buffer: out.buffer34,
        passes: ["composite"],
        rawW: out.rawW,
        rawH: out.rawH,
        pass1Ms: Date.now() - tPass1,
        pass2Ms: 0,
        cachedPass1: false,
      };
    }
  }

  // Unified layered upper flat-lay for Top + Outerwear on WeShopAI:
  // prevents a standalone Jacket pass from overwriting the inner Shirt pass, and keeps
  // Bottoms + Layered Top/Jacket to a crisp 2-pass pipeline (or 1-pass for Top+Jacket alone).
  interface WeShopStep {
    slot: SingleSlotKind;
    itemId: string;
    buffer: Buffer;
  }

  const isTucked = params.tailorFit.tuckMode === "tucked";
  const hasBothTopAndOuter = Boolean(
    params.upperCanvas &&
      params.outerwearCanvas &&
      params.upperItemId &&
      params.outerwearItemId &&
      params.layeredUpperCanvas
  );

  const lowerStep: WeShopStep | null =
    params.lowerCanvas && params.lowerItemId
      ? {
          slot: "lower",
          itemId: params.lowerItemId,
          buffer: params.lowerCanvas.buffer,
        }
      : null;

  const upperCombinedStep: WeShopStep | null = hasBothTopAndOuter
    ? {
        slot: "outerwear",
        itemId: `${params.upperItemId}+${params.outerwearItemId}:${params.tailorFit.outerwearStyle}`,
        buffer: params.layeredUpperCanvas!.buffer,
      }
    : params.upperCanvas && params.upperItemId
      ? {
          slot: "upper",
          itemId: params.upperItemId,
          buffer: params.upperCanvas.buffer,
        }
      : params.outerwearCanvas && params.outerwearItemId
        ? {
            slot: "outerwear",
            itemId: params.outerwearItemId,
            buffer: params.outerwearCanvas.buffer,
          }
        : null;

  const passQueue: WeShopStep[] = [];
  if (isTucked && lowerStep && upperCombinedStep) {
    passQueue.push(upperCombinedStep, lowerStep);
  } else {
    if (lowerStep) passQueue.push(lowerStep);
    if (upperCombinedStep) passQueue.push(upperCombinedStep);
  }

  if (passQueue.length === 0) {
    throw new Error("No garment selected for WeShopAI.");
  }

  let currentBuffer34 = params.original34Buffer;
  let priorChainKey: string | undefined;
  let pass1Ms = 0;
  let pass2Ms = 0;
  let cachedPass1 = false;
  let lastRawW = MODEL_WIDTH;
  let lastRawH = MODEL_HEIGHT;
  const executedPasses: TryOnSlotKind[] = [];

  for (let i = 0; i < passQueue.length; i++) {
    const step = passQueue[i];
    const isLast = i === passQueue.length - 1;
    executedPasses.push(step.slot);

    let stepKey: string | undefined;
    let stepCached = false;

    if (!isLast) {
      stepKey = buildPass1CacheKey({
        avatarHash: params.avatarHash,
        engine: "weshop",
        pass1ItemId: step.itemId,
        pass1Slot: step.slot,
        pass1TailorSlice: getSlotTailorSlice(params.tailorFit, step.slot),
        pass1SegFree: false,
        highDetail: params.highDetail,
        priorChainKey,
      });

      const cached = getCachedPass1(stepKey);
      if (cached) {
        stepCached = true;
        if (i === 0) cachedPass1 = true;
        currentBuffer34 = cached.buffer34;
        lastRawW = cached.rawW;
        lastRawH = cached.rawH;
      }
    }

    if (!stepCached) {
      const tStep = Date.now();
      const out = await runPass(currentBuffer34, step.buffer, step.slot);
      const elapsed = Date.now() - tStep;
      if (i === 0) pass1Ms += elapsed;
      else pass2Ms += elapsed;

      currentBuffer34 = out.buffer34;
      lastRawW = out.rawW;
      lastRawH = out.rawH;

      if (stepKey) {
        setCachedPass1(stepKey, {
          buffer34: out.buffer34,
          rawW: out.rawW,
          rawH: out.rawH,
          engine: "weshop",
        });
      }
    }

    if (stepKey) {
      priorChainKey = stepKey;
    }

    if (!isLast && params.onPass1Complete) {
      await params.onPass1Complete({
        buffer34: currentBuffer34,
        cachedPass1: stepCached,
        nextSlot: passQueue[i + 1].slot,
        stepIndex: i + 1,
        totalSteps: passQueue.length,
        engine: "weshop",
      });
    }
  }

  return {
    generated34Buffer: currentBuffer34,
    passes: executedPasses,
    rawW: lastRawW,
    rawH: lastRawH,
    pass1Ms,
    pass2Ms,
    cachedPass1,
  };
}

export async function POST(request: Request) {
  const tRequestStart = Date.now();
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized. Sign in to use AI Try-On." },
      { status: 401 }
    );
  }

  const wantsNdjson = (request.headers.get("accept") || "")
    .toLowerCase()
    .includes("application/x-ndjson");

  let upperItemId: string | null = null;
  let outerwearItemId: string | null = null;
  let lowerItemId: string | null = null;
  let cleanSwap = false;
  let highDetail = false;
  let includeGarmentComposite = false;
  let renderMode: TryOnRenderMode = "two-pass";
  let tailorFit: TailorFitConfig = sanitizeTailorFit();

  try {
    const body = (await request.json()) as {
      upperItemId?: unknown;
      outerwearItemId?: unknown;
      lowerItemId?: unknown;
      itemId?: unknown;
      cleanSwap?: unknown;
      highDetail?: unknown;
      renderMode?: unknown;
      includeGarmentComposite?: unknown;
      tailorFit?: unknown;
    };

    if (typeof body?.upperItemId === "string" && body.upperItemId.trim()) {
      upperItemId = body.upperItemId.trim();
    }
    if (
      typeof body?.outerwearItemId === "string" &&
      body.outerwearItemId.trim()
    ) {
      outerwearItemId = body.outerwearItemId.trim();
    }
    if (typeof body?.lowerItemId === "string" && body.lowerItemId.trim()) {
      lowerItemId = body.lowerItemId.trim();
    }
    if (
      !upperItemId &&
      !outerwearItemId &&
      !lowerItemId &&
      typeof body?.itemId === "string" &&
      body.itemId.trim()
    ) {
      upperItemId = body.itemId.trim();
    }
    if (upperItemId && outerwearItemId && upperItemId === outerwearItemId) {
      outerwearItemId = null;
    }
    if (body?.cleanSwap === true) {
      cleanSwap = true;
    }
    if (body?.highDetail === true) {
      highDetail = true;
    }
    if (body?.includeGarmentComposite === true) {
      includeGarmentComposite = true;
    }
    if (body?.renderMode === "composite") {
      renderMode = "composite";
    } else if (body?.renderMode === "two-pass") {
      renderMode = "two-pass";
    }
    if (body?.tailorFit !== undefined) {
      tailorFit = sanitizeTailorFit(body.tailorFit);
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid request payload." },
      { status: 400 }
    );
  }

  if (!upperItemId && !outerwearItemId && !lowerItemId) {
    return NextResponse.json(
      {
        error:
          "Select at least one Top, Outerwear, or Bottom piece.",
      },
      { status: 400 }
    );
  }

  // 1. Check 24-hour rate limit ledger (bypassed when TRYON_UNLIMITED="true")
  const isUnlimited = process.env.TRYON_UNLIMITED === "true";
  let usedCount = 0;
  let currentRemaining: number | null = null;

  if (!isUnlimited) {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [usageRow] = await db
      .select({
        used: sql<number>`count(${tryonUsage.id})::int`,
      })
      .from(tryonUsage)
      .where(
        and(
          eq(tryonUsage.userId, session.user.id),
          gte(tryonUsage.createdAt, windowStart)
        )
      );

    usedCount = Number(usageRow?.used) || 0;
    currentRemaining = Math.max(0, TRYON_DAILY_LIMIT - usedCount);

    if (usedCount >= TRYON_DAILY_LIMIT) {
      return NextResponse.json(
        {
          error: "Daily limit reached (3/3). Resets in 24h.",
          remaining: 0,
          unlimited: false,
        },
        { status: 429 }
      );
    }
  }

  // 2. Fetch user's Body Profile and requested Wardrobe Items (ownership enforced)
  const requestedIds = Array.from(
    new Set(
      [upperItemId, outerwearItemId, lowerItemId].filter((id): id is string =>
        Boolean(id)
      )
    )
  );

  const [[profile], ownedItems] = await Promise.all([
    db
      .select({
        avatarUrl: bodyProfiles.avatarUrl,
      })
      .from(bodyProfiles)
      .where(eq(bodyProfiles.userId, session.user.id))
      .limit(1),
    db
      .select({
        id: wardrobeItems.id,
        name: wardrobeItems.name,
        category: wardrobeItems.category,
        imageUrl: wardrobeItems.imageUrl,
      })
      .from(wardrobeItems)
      .where(
        and(
          eq(wardrobeItems.userId, session.user.id),
          inArray(wardrobeItems.id, requestedIds)
        )
      ),
  ]);

  if (!profile) {
    return NextResponse.json(
      {
        error: "Set up your Body Profile before running AI Try-On.",
        remaining: currentRemaining,
        unlimited: isUnlimited,
      },
      { status: 400 }
    );
  }

  const itemById = new Map(ownedItems.map((item) => [item.id, item]));
  const upperItem = upperItemId ? itemById.get(upperItemId) ?? null : null;
  const outerwearItem = outerwearItemId
    ? itemById.get(outerwearItemId) ?? null
    : null;
  const lowerItem = lowerItemId ? itemById.get(lowerItemId) ?? null : null;

  if (
    (upperItemId && !upperItem) ||
    (outerwearItemId && !outerwearItem) ||
    (lowerItemId && !lowerItem)
  ) {
    return NextResponse.json(
      {
        error: "One or more selected pieces were not found in your closet.",
        remaining: currentRemaining,
        unlimited: isUnlimited,
      },
      { status: 404 }
    );
  }

  // 3. Check Full-Outfit LRU Cache (< 50ms instant return, no duplicate credit charged)
  const avatarHash = sha256Hex(profile.avatarUrl);
  const fullOutfitKey = buildFullOutfitCacheKey({
    avatarHash,
    upperItemId,
    outerwearItemId,
    lowerItemId,
    cleanSwap,
    tailorFit,
    renderMode,
    highDetail,
  });

  const cachedFull = getCachedFullOutfit(fullOutfitKey);
  if (cachedFull) {
    const totalMs = Date.now() - tRequestStart;
    console.log("[TRYON]", {
      engine: cachedFull.engine,
      renderMode,
      passes: cachedFull.passes,
      tailorFit,
      cacheHit: "full",
      prepMs: 0,
      pass1Ms: 0,
      pass2Ms: 0,
      blendMs: 0,
      totalMs,
    });

    return NextResponse.json(
      {
        resultUrl: cachedFull.resultUrl,
        ...(cachedFull.garmentCompositeUrl
          ? { garmentCompositeUrl: cachedFull.garmentCompositeUrl }
          : {}),
        remaining: currentRemaining,
        unlimited: isUnlimited,
        passes: cachedFull.passes.length,
        engine: cachedFull.engine,
        cached: true,
        timingMs: totalMs,
      },
      { status: 200 }
    );
  }

  // 4. Parallel sharp prep:
  //    - Default (unmodified) garment slots bypass garmentReshaper / renderTailoredCanvas
  //      completely and send the raw unmodified flat-lay directly to FASHN for max photorealism.
  //    - Custom Tailor Fit cuts (or explicit 1-Pass Composite mode) run renderTailoredCanvas.
  const hasCustomTopCut =
    tailorFit.topCropPct !== 0 ||
    Math.abs(tailorFit.topWidthScale - 1) >= 0.005;
  const hasCustomBottomCut =
    tailorFit.bottomCropPct !== 0 ||
    Math.abs(tailorFit.bottomWidthScale - 1) >= 0.005;
  const hasAnyUpperItem = Boolean(upperItem || outerwearItem);
  const hasLayeredTopAndOuter = Boolean(upperItem && outerwearItem);
  const needsCompositeCanvas =
    Boolean(hasAnyUpperItem && lowerItem) && renderMode === "composite";

  const tPrepStart = Date.now();
  const vtonApi = getVtonApiConfig();
  const hfToken = getHfToken();
  const shouldPreSanitizeViaFitDiT =
    Boolean(vtonApi) && getPrimaryEnginePref() !== "vton-api";
  let originalFullRes: Buffer;
  let compositeCanvas: TailoredCanvasOutput | null = null;
  let upperCanvas: TailoredCanvasOutput | null = null;
  let outerwearCanvas: TailoredCanvasOutput | null = null;
  let layeredUpperCanvas: TailoredCanvasOutput | null = null;
  let lowerCanvas: TailoredCanvasOutput | null = null;

  try {
    const [normOriginal, upperRawOrig, outerwearRawOrig, lowerRawOrig] =
      await Promise.all([
        normalizeAvatarTo34Buffer(profile.avatarUrl),
        upperItem ? imageSourceToBuffer(upperItem.imageUrl) : Promise.resolve(null),
        outerwearItem
          ? imageSourceToBuffer(outerwearItem.imageUrl)
          : Promise.resolve(null),
        lowerItem ? imageSourceToBuffer(lowerItem.imageUrl) : Promise.resolve(null),
      ]);

    originalFullRes = normOriginal;

    const [upperRawBuf, outerwearRawBuf, lowerRawBuf] = shouldPreSanitizeViaFitDiT
      ? await Promise.all([
          upperRawOrig
            ? maybeSanitizeGarmentViaFitDiT({
                rawBuffer: upperRawOrig,
                category: "tops",
                vtonApi,
              })
            : Promise.resolve(null),
          outerwearRawOrig
            ? maybeSanitizeGarmentViaFitDiT({
                rawBuffer: outerwearRawOrig,
                category: "tops",
                vtonApi,
              })
            : Promise.resolve(null),
          lowerRawOrig
            ? maybeSanitizeGarmentViaFitDiT({
                rawBuffer: lowerRawOrig,
                category: "bottoms",
                vtonApi,
              })
            : Promise.resolve(null),
        ])
      : [upperRawOrig, outerwearRawOrig, lowerRawOrig];

    const [upperCutout, outerwearCutout, lowerCutout] = await Promise.all([
      upperRawBuf &&
      (hasCustomTopCut || needsCompositeCanvas || hasLayeredTopAndOuter)
        ? trimGarmentCutout(upperRawBuf)
        : Promise.resolve(null),
      outerwearRawBuf &&
      ((hasCustomTopCut && !upperRawBuf) ||
        needsCompositeCanvas ||
        hasLayeredTopAndOuter)
        ? trimGarmentCutout(outerwearRawBuf)
        : Promise.resolve(null),
      lowerRawBuf && (hasCustomBottomCut || needsCompositeCanvas)
        ? trimGarmentCutout(lowerRawBuf)
        : Promise.resolve(null),
    ]);

    const layeredUpperCutout =
      upperCutout && outerwearCutout
        ? await composeLayeredUpperCutout(upperCutout, outerwearCutout, {
            style: tailorFit.outerwearStyle,
            suppressHemPeek:
              Boolean(lowerItem) && tailorFit.tuckMode === "tucked",
          })
        : null;
    const effectiveCompositeUpperCutout =
      layeredUpperCutout ?? upperCutout ?? outerwearCutout;

    const [
      builtComposite,
      builtUpper,
      builtOuterwear,
      builtLayeredUpper,
      builtLower,
    ] = await Promise.all([
      needsCompositeCanvas && effectiveCompositeUpperCutout && lowerCutout
        ? renderTailoredCanvas(effectiveCompositeUpperCutout, lowerCutout, tailorFit)
        : Promise.resolve(null),
      upperRawBuf
        ? hasCustomTopCut && upperCutout
          ? renderTailoredCanvas(upperCutout, null, tailorFit)
          : rawGarmentToPassthroughOutput(upperRawBuf, "upper", tailorFit)
        : Promise.resolve(null),
      outerwearRawBuf
        ? hasCustomTopCut && !upperRawBuf && outerwearCutout
          ? renderTailoredCanvas(outerwearCutout, null, tailorFit)
          : rawGarmentToPassthroughOutput(outerwearRawBuf, "outerwear", tailorFit)
        : Promise.resolve(null),
      layeredUpperCutout
        ? hasCustomTopCut
          ? renderTailoredCanvas(layeredUpperCutout, null, tailorFit)
          : rawGarmentToPassthroughOutput(
              layeredUpperCutout.buffer,
              "outerwear",
              tailorFit
            )
        : Promise.resolve(null),
      lowerRawBuf
        ? hasCustomBottomCut && lowerCutout
          ? renderTailoredCanvas(null, lowerCutout, tailorFit)
          : rawGarmentToPassthroughOutput(lowerRawBuf, "lower", tailorFit)
        : Promise.resolve(null),
    ]);

    compositeCanvas = builtComposite;
    upperCanvas = builtUpper;
    outerwearCanvas = builtOuterwear;
    layeredUpperCanvas = builtLayeredUpper;
    lowerCanvas = builtLower;
  } catch (err) {
    console.error("[/api/tryon] failed to normalize or compose images:", err);
    return NextResponse.json(
      {
        error:
          "Stored model or garment image could not be processed. Re-upload and try again.",
        remaining: currentRemaining,
        unlimited: isUnlimited,
      },
      { status: 400 }
    );
  }
  const prepMs = Date.now() - tPrepStart;

  const effectiveUpperSlots = upperCanvas || outerwearCanvas ? 1 : 0;
  const effectiveSlotCount = effectiveUpperSlots + (lowerCanvas ? 1 : 0);
  const isMultiPassStream =
    effectiveSlotCount >= 2 && renderMode === "two-pass";

  const garmentCompositeBuf =
    compositeCanvas?.buffer ??
    layeredUpperCanvas?.buffer ??
    upperCanvas?.buffer ??
    outerwearCanvas?.buffer ??
    lowerCanvas?.buffer ??
    null;
  let garmentCompositeUrl: string | undefined;
  if (garmentCompositeBuf) {
    const previewBuf = await sharp(garmentCompositeBuf)
      .jpeg({ quality: 75 })
      .toBuffer();
    garmentCompositeUrl = `data:image/jpeg;base64,${previewBuf.toString("base64")}`;
  }
  const autoCleanMask = needsAutoCleanMask(tailorFit, {
    hasUpper: Boolean(upperCanvas || outerwearCanvas),
    hasLower: Boolean(lowerCanvas),
  });
  const effectiveSegmentationFree = !(cleanSwap || autoCleanMask);
  const effectiveGuidanceScale = isDefaultTailorFit(tailorFit) ? 1.5 : 1.7;

  const executePipeline = async (
    emitPass1?: (payload: {
      stage: "pass1_done";
      previewUrl: string;
      cachedPass1: boolean;
      nextSlot: SingleSlotKind;
      stepIndex: number;
      totalSteps: number;
    }) => void
  ): Promise<{
    resultUrl: string;
    garmentCompositeUrl?: string;
    remaining: number | null;
    unlimited: boolean;
    passes: number;
    engine: TryOnEngineKind;
    cached: boolean;
    timingMs: number;
  }> => {
    const isDefaultFitRequest = isDefaultTailorFit(tailorFit);

    const onPass1Complete = emitPass1
      ? async (evt: Pass1PreviewEvent) => {
          let previewBuf = evt.buffer34;
          if (evt.engine === "fitdit-api") {
            previewBuf = await sharp(evt.buffer34)
              .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
              .toBuffer();
          } else if (evt.engine === "vton-api" || evt.engine === "fashn-vton-1.5") {
            if (isDefaultFitRequest) {
              previewBuf = await sharp(evt.buffer34)
                .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
                .toBuffer();
            } else {
              try {
                const headPreserved = await preserveHeadOnFashnOutput(
                  originalFullRes,
                  evt.buffer34
                );
                previewBuf = headPreserved.buffer;
              } catch {
                previewBuf = await sharp(evt.buffer34)
                  .jpeg({ quality: 94 })
                  .toBuffer();
              }
            }
          } else if (evt.engine !== "weshop") {
            try {
              const blendedPreview = await blendGarmentIntoOriginal(
                originalFullRes,
                evt.buffer34
              );
              previewBuf = blendedPreview.buffer;
            } catch {
              previewBuf = evt.buffer34;
            }
          }
          emitPass1({
            stage: "pass1_done",
            previewUrl: `data:image/jpeg;base64,${previewBuf.toString("base64")}`,
            cachedPass1: evt.cachedPass1,
            nextSlot: evt.nextSlot,
            stepIndex: evt.stepIndex,
            totalSteps: evt.totalSteps,
          });
        }
      : undefined;

    const primaryPref = getPrimaryEnginePref();
    let engine: TryOnEngineKind = "weshop";
    let engineResult: EngineRunResult | null = null;
    let sawZeroGpuQuota = false;
    let weshopErrorDetail: string | null = null;
    let vtonApiErrorDetail: string | null = null;

    const tryRunWeShop = async (
      roleLabel: string
    ): Promise<{ engine: TryOnEngineKind; result: EngineRunResult } | null> => {
      try {
        const result = await runWeShopTryOn({
          avatarHash,
          original34Buffer: originalFullRes,
          upperItemId,
          outerwearItemId,
          lowerItemId,
          compositeCanvas,
          upperCanvas,
          outerwearCanvas,
          layeredUpperCanvas,
          lowerCanvas,
          tailorFit,
          renderMode,
          highDetail,
          onPass1Complete,
        });
        return { engine: "weshop", result };
      } catch (weshopErr) {
        weshopErrorDetail = getErrorDetail(weshopErr);
        console.warn(
          `[/api/tryon] ${roleLabel} WeShopAI failed:`,
          weshopErrorDetail
        );
        return null;
      }
    };

    const tryRunPrivateGpu = async (
      roleLabel: string
    ): Promise<{ engine: TryOnEngineKind; result: EngineRunResult } | null> => {
      if (!vtonApi) return null;
      try {
        const backend = await detectVtonApiBackend(vtonApi);
        const result = await runFashnTryOn({
          avatarHash,
          original34Buffer: originalFullRes,
          upperItemId,
          outerwearItemId,
          lowerItemId,
          compositeCanvas,
          upperCanvas,
          outerwearCanvas,
          layeredUpperCanvas,
          lowerCanvas,
          cleanSwap,
          tailorFit,
          renderMode,
          highDetail,
          vtonApi,
          vtonBackend: backend,
          onPass1Complete,
        });
        return {
          engine: backend === "fitdit" ? "fitdit-api" : "vton-api",
          result,
        };
      } catch (vtonErr) {
        vtonApiErrorDetail = getErrorDetail(vtonErr);
        console.warn(
          `[/api/tryon] ${roleLabel} VTON_API_URL failed:`,
          vtonApiErrorDetail
        );
        return null;
      }
    };

    try {
      if (primaryPref === "vton-api" && vtonApi) {
        // 1. Primary: Private GPU (FitDiT HD or FASHN GPU, unlimited)
        const gpuAttempt = await tryRunPrivateGpu("Primary");
        if (gpuAttempt) {
          engine = gpuAttempt.engine;
          engineResult = gpuAttempt.result;
        }
        // 2. Fallback 1: WeShopAI (1520x2048)
        if (!engineResult) {
          const weshopAttempt = await tryRunWeShop("Fallback");
          if (weshopAttempt) {
            engine = weshopAttempt.engine;
            engineResult = weshopAttempt.result;
          }
        }
      } else {
        // 1. Primary: WeShopAI (1520x2048 photorealistic output)
        const weshopAttempt = await tryRunWeShop("Primary");
        if (weshopAttempt) {
          engine = weshopAttempt.engine;
          engineResult = weshopAttempt.result;
        }
        // 2. Fallback 1: Private GPU (FitDiT HD or FASHN GPU)
        if (!engineResult) {
          const gpuAttempt = await tryRunPrivateGpu("Fallback");
          if (gpuAttempt) {
            engine = gpuAttempt.engine;
            engineResult = gpuAttempt.result;
          }
        }
      }

      // 3. Automatic Fallback 2: Hugging Face ZeroGPU (FASHN -> CatVTON)
      if (!engineResult) {
        try {
          engineResult = await runFashnTryOn({
            avatarHash,
            original34Buffer: originalFullRes,
            upperItemId,
            outerwearItemId,
            lowerItemId,
            compositeCanvas,
            upperCanvas,
            outerwearCanvas,
            layeredUpperCanvas,
            lowerCanvas,
            cleanSwap,
            tailorFit,
            renderMode,
            highDetail,
            hfToken,
            onPass1Complete,
          });
          engine = "fashn-vton-1.5";
        } catch (fashnErr) {
          const fashnQuotaHit = isZeroGpuQuotaError(fashnErr);
          if (fashnQuotaHit) {
            sawZeroGpuQuota = true;
            console.warn(
              "[/api/tryon] Fallback FASHN Space hit ZeroGPU quota:",
              getErrorDetail(fashnErr)
            );
            throw fashnErr;
          }
          console.warn(
            "[/api/tryon] Fallback FASHN Space failed, trying CatVTON:",
            getErrorDetail(fashnErr)
          );
          try {
            const catUpperCanvas =
              layeredUpperCanvas ?? upperCanvas ?? outerwearCanvas;
            const catUpperId =
              upperItemId && outerwearItemId
                ? `${upperItemId}+${outerwearItemId}`
                : upperItemId ?? outerwearItemId;
            engineResult = await runCatVtonFallback({
              avatarHash,
              original34Buffer: originalFullRes,
              upperItemId: catUpperId,
              lowerItemId,
              upperCanvas: catUpperCanvas,
              lowerCanvas,
              tailorFit,
              highDetail,
              hfToken,
              onPass1Complete,
            });
            engine = "catvton";
          } catch (catErr) {
            if (isZeroGpuQuotaError(catErr)) {
              sawZeroGpuQuota = true;
            }
            throw catErr;
          }
        }
      }
    } catch (allErr) {
      const errorMessage = vtonApiErrorDetail
        ? `WeShopAI (${weshopErrorDetail ?? "unavailable"}) and private GPU (${vtonApiErrorDetail}) both failed. Check server logs or use the Layer Board.`
        : sawZeroGpuQuota
          ? ZEROGPU_QUOTA_ERROR_MESSAGE
          : BUSY_ERROR_MESSAGE;
      const wrapped = new Error(errorMessage) as Error & {
        cause?: unknown;
        status?: number;
      };
      wrapped.cause = allErr;
      wrapped.status = 503;
      throw wrapped;
    }

    // 5. Final composition:
    // - FitDiT HD / WeShopAI: native supersampled output returned directly (zero post-blending/sharpening).
    // - FASHN (vton-api / fashn-vton-1.5): raw output on default; head-only preservation on custom cuts.
    // - CatVTON fallback: 2D pixel-diff blend over originalFullRes.
    const tBlendStart = Date.now();
    let finalBuffer: Buffer;
    let meanDiff = 0;
    let maskCoveragePct = 1;

    if (engine === "weshop") {
      finalBuffer = engineResult.generated34Buffer;
    } else if (engine === "fitdit-api") {
      finalBuffer = await sharp(engineResult.generated34Buffer)
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toBuffer();
    } else if (engine === "vton-api" || engine === "fashn-vton-1.5") {
      if (isDefaultFitRequest) {
        // Default (unmodified) FASHN renders: return FASHN's raw aligned output directly
        // with zero post-blending or sharpening.
        finalBuffer = await sharp(engineResult.generated34Buffer)
          .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
          .toBuffer();
      } else {
        try {
          const preserved = await preserveHeadOnFashnOutput(
            originalFullRes,
            engineResult.generated34Buffer
          );
          finalBuffer = preserved.buffer;
          meanDiff = preserved.meanDiff;
          maskCoveragePct = preserved.maskCoveragePct;
        } catch (preserveErr) {
          console.error(
            "[/api/tryon] preserveHeadOnFashnOutput failed, returning generatedBuffer directly:",
            preserveErr
          );
          finalBuffer = await sharp(engineResult.generated34Buffer)
            .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
            .toBuffer();
        }
      }
    } else {
      try {
        const blended = await blendGarmentIntoOriginal(
          originalFullRes,
          engineResult.generated34Buffer
        );
        finalBuffer = blended.buffer;
        meanDiff = blended.meanDiff;
        maskCoveragePct = blended.maskCoveragePct;
      } catch (blendErr) {
        console.error(
          "[/api/tryon] blendGarmentIntoOriginal failed, returning generatedBuffer directly:",
          blendErr
        );
        finalBuffer = engineResult.generated34Buffer;
      }
    }
    const blendMs = Date.now() - tBlendStart;

    const resultUrl = `data:image/jpeg;base64,${finalBuffer.toString("base64")}`;

    setCachedFullOutfit(fullOutfitKey, {
      resultUrl,
      engine,
      passes: engineResult.passes,
      garmentCompositeUrl,
    });

    // 6. Record usage only after a successful generation
    await db.insert(tryonUsage).values({
      userId: session.user.id,
    });

    const remaining = isUnlimited
      ? null
      : Math.max(0, TRYON_DAILY_LIMIT - (usedCount + 1));
    const totalMs = Date.now() - tRequestStart;

    console.log("[TRYON]", {
      engine,
      renderMode,
      passes: engineResult.passes,
      tailorFit,
      rawGarments: {
        upper: Boolean(upperItem) && !hasCustomTopCut,
        outerwear: Boolean(outerwearItem) && !(hasCustomTopCut && !upperItem),
        lower: Boolean(lowerItem) && !hasCustomBottomCut,
      },
      autoCleanMask,
      effectiveSegmentationFree,
      guidanceScale: effectiveGuidanceScale,
      cacheHit: engineResult.cachedPass1 ? "pass1" : "none",
      prepMs,
      pass1Ms: engineResult.pass1Ms,
      pass2Ms: engineResult.pass2Ms,
      blendMs,
      totalMs,
      rawSize: `${engineResult.rawW}x${engineResult.rawH}`,
      meanRgbDiff: Number(meanDiff.toFixed(1)),
      maskCoveragePct: Number((maskCoveragePct * 100).toFixed(1)),
    });

    return {
      resultUrl,
      ...(garmentCompositeUrl ? { garmentCompositeUrl } : {}),
      remaining,
      unlimited: isUnlimited,
      passes: engineResult.passes.length,
      engine,
      cached: false,
      timingMs: totalMs,
    };
  };

  // Progressive NDJSON stream for multi-pass looks (2-pass or 3-pass Shirt -> Jacket)
  if (wantsNdjson && isMultiPassStream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const sendLine = (obj: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
        };
        // Emit periodic whitespace keepalives so browsers/proxies never drop long float32 2-pass runs
        const keepAlive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode("\n"));
          } catch {
            // stream already closed
          }
        }, 15_000);

        try {
          const finalPayload = await executePipeline((pass1Event) => {
            sendLine(pass1Event);
          });
          sendLine({
            stage: "done",
            ...finalPayload,
          });
        } catch (err) {
          console.error("[/api/tryon] Streamed try-on failed:", err);
          sendLine({
            stage: "error",
            error:
              err instanceof Error && err.message
                ? err.message
                : BUSY_ERROR_MESSAGE,
            status: 503,
            remaining: currentRemaining,
            unlimited: isUnlimited,
          });
        } finally {
          clearInterval(keepAlive);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // Standard JSON response (1-pass composite, single garment, & non-NDJSON callers)
  try {
    const payload = await executePipeline();
    return NextResponse.json(payload, { status: 200 });
  } catch (error) {
    console.error("[/api/tryon] All try-on engines failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error && error.message
            ? error.message
            : BUSY_ERROR_MESSAGE,
        remaining: currentRemaining,
        unlimited: isUnlimited,
      },
      { status: 503 }
    );
  }
}
