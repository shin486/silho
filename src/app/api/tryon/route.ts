import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { Client, handle_file } from "@gradio/client";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "@/db/drizzle";
import { bodyProfiles, tryonUsage, wardrobeItems } from "@/db/schema";
import { TRYON_DAILY_LIMIT } from "@/lib/fitPreferences";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BUSY_ERROR_MESSAGE =
  "AI try-on server is currently busy. Try again in a moment or use the Layer Board.";

const CATVTON_SPACES = [
  "zhengchong/CatVTON",
  "multimodalart/CatVTON-zerogpu",
] as const;

const CATVTON_STEPS = 40;
const CATVTON_GUIDANCE = 2.5;
const CATVTON_SEED = 42;
const CATVTON_SHOW_TYPE = "result only";

type CatVtonClothType = "upper" | "lower";

function getHfToken(): `hf_${string}` | undefined {
  const raw = process.env.HF_TOKEN?.trim();
  if (raw && raw.startsWith("hf_")) {
    return raw as `hf_${string}`;
  }
  return undefined;
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

/**
 * Flattens any transparent garment cutout onto a solid #FFFFFF backdrop so
 * CatVTON sees crisp garment boundaries without edge artifacts.
 */
async function flattenGarmentToWhiteBlob(source: string): Promise<Blob> {
  const rawBuffer = await imageSourceToBuffer(source);
  const flattened = await sharp(rawBuffer)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 94 })
    .toBuffer();

  return new Blob([new Uint8Array(flattened)], { type: "image/jpeg" });
}

/**
 * Normalizes a model portrait onto a clean opaque #FAFAFA RGB JPEG Blob.
 */
async function normalizeAvatarToBlob(source: string | Buffer): Promise<Blob> {
  const rawBuffer =
    typeof source === "string" ? await imageSourceToBuffer(source) : source;
  const flattened = await sharp(rawBuffer)
    .flatten({ background: { r: 250, g: 250, b: 250 } })
    .jpeg({ quality: 92 })
    .toBuffer();

  return new Blob([new Uint8Array(flattened)], { type: "image/jpeg" });
}

/**
 * Creates a solid single-color black PNG Blob for CatVTON's ImageEditor `layers[0]` slot.
 * CatVTON inspects `len(np.unique(mask)) == 1` to trigger its built-in AutoMasker.
 */
async function createBlankMaskBlob(): Promise<Blob> {
  const maskBuffer = await sharp({
    create: {
      width: 768,
      height: 1024,
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
    throw new Error(`Failed to fetch CatVTON output image (${res.status}).`);
  }

  const contentType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType };
}

/**
 * Connects to zhengchong/CatVTON (falling back to the official ZeroGPU mirror
 * multimodalart/CatVTON-zerogpu if the primary Space is sleeping/in error)
 * and resolves the exact `/submit_function` endpoint via `client.view_api()`.
 */
async function connectCatVtonClient(hfToken?: `hf_${string}`): Promise<{
  client: Client;
  endpoint: string;
}> {
  let lastError: unknown = null;

  for (const spaceId of CATVTON_SPACES) {
    let candidate: Client | null = null;
    try {
      candidate = await Client.connect(spaceId, {
        hf_token: hfToken,
      });

      const apiInfo = await candidate.view_api();
      const endpointNames = Object.keys(apiInfo.named_endpoints || {});
      const endpoint = endpointNames.includes("/submit_function")
        ? "/submit_function"
        : endpointNames.find((name) =>
            apiInfo.named_endpoints[name]?.parameters?.some(
              (p) => p.parameter_name === "cloth_type"
            )
          ) ?? "/submit_function";

      return { client: candidate, endpoint };
    } catch (err) {
      lastError = err;
      try {
        candidate?.close();
      } catch {
        // Ignore cleanup failures.
      }
      console.warn(
        `[/api/tryon] Could not connect to ${spaceId}, trying next Space:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  throw lastError ?? new Error("All CatVTON Spaces are currently unavailable.");
}

async function runCatVtonPass(params: {
  client: Client;
  endpoint: string;
  personBlob: Blob;
  garmentBlob: Blob;
  blankMaskBlob: Blob;
  clothType: CatVtonClothType;
}): Promise<string> {
  const prediction = await params.client.predict(params.endpoint, {
    person_image: {
      background: handle_file(params.personBlob),
      layers: [handle_file(params.blankMaskBlob)],
      composite: null,
    },
    cloth_image: handle_file(params.garmentBlob),
    cloth_type: params.clothType,
    num_inference_steps: CATVTON_STEPS,
    guidance_scale: CATVTON_GUIDANCE,
    seed: CATVTON_SEED,
    show_type: CATVTON_SHOW_TYPE,
  });

  const rawResultUrl = extractResultImageUrl(prediction.data);
  if (!rawResultUrl) {
    throw new Error(`CatVTON returned no image for ${params.clothType} pass.`);
  }

  return rawResultUrl;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized. Sign in to use AI Try-On." },
      { status: 401 }
    );
  }

  let upperItemId: string | null = null;
  let lowerItemId: string | null = null;

  try {
    const body = (await request.json()) as {
      upperItemId?: unknown;
      lowerItemId?: unknown;
      itemId?: unknown;
    };

    if (typeof body?.upperItemId === "string" && body.upperItemId.trim()) {
      upperItemId = body.upperItemId.trim();
    }
    if (typeof body?.lowerItemId === "string" && body.lowerItemId.trim()) {
      lowerItemId = body.lowerItemId.trim();
    }
    // Backwards-compatible fallback if a single itemId is sent
    if (!upperItemId && !lowerItemId && typeof body?.itemId === "string" && body.itemId.trim()) {
      upperItemId = body.itemId.trim();
    }
  } catch {
    return NextResponse.json(
      { error: "Invalid request payload." },
      { status: 400 }
    );
  }

  if (!upperItemId && !lowerItemId) {
    return NextResponse.json(
      { error: "Select at least one Upper (Top/Outerwear) or Lower (Bottom) piece." },
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
    new Set([upperItemId, lowerItemId].filter((id): id is string => Boolean(id)))
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
  const lowerItem = lowerItemId ? itemById.get(lowerItemId) ?? null : null;

  if ((upperItemId && !upperItem) || (lowerItemId && !lowerItem)) {
    return NextResponse.json(
      {
        error: "One or more selected pieces were not found in your closet.",
        remaining: currentRemaining,
        unlimited: isUnlimited,
      },
      { status: 404 }
    );
  }

  // 3. Normalize model photo onto #FAFAFA, flatten garments onto #FFFFFF, and build blank AutoMasker layer
  let modelBlob: Blob;
  let upperBlob: Blob | null = null;
  let lowerBlob: Blob | null = null;
  let blankMaskBlob: Blob;

  try {
    const [normModel, blankMask, normUpper, normLower] = await Promise.all([
      normalizeAvatarToBlob(profile.avatarUrl),
      createBlankMaskBlob(),
      upperItem ? flattenGarmentToWhiteBlob(upperItem.imageUrl) : Promise.resolve(null),
      lowerItem ? flattenGarmentToWhiteBlob(lowerItem.imageUrl) : Promise.resolve(null),
    ]);

    modelBlob = normModel;
    blankMaskBlob = blankMask;
    upperBlob = normUpper;
    lowerBlob = normLower;
  } catch (err) {
    console.error("[/api/tryon] failed to normalize images:", err);
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

  // 4. Execute CatVTON pass(es): Upper only, Lower only, or chained Upper -> Lower
  const hfToken = getHfToken();
  let client: Client | null = null;

  try {
    const connected = await connectCatVtonClient(hfToken);
    client = connected.client;
    const { endpoint } = connected;

    let finalRawUrl = "";
    let passes = 0;

    if (upperBlob && lowerBlob) {
      // Pass 1: Upper garment onto user's Studio Avatar
      const pass1Url = await runCatVtonPass({
        client,
        endpoint,
        personBlob: modelBlob,
        garmentBlob: upperBlob,
        blankMaskBlob,
        clothType: "upper",
      });
      passes = 1;

      // Feed Pass 1's rendered portrait directly into Pass 2 (Lower garment)
      const { buffer: pass1Buffer } = await fetchResultBuffer(pass1Url, hfToken);
      const pass1PersonBlob = await normalizeAvatarToBlob(pass1Buffer);

      finalRawUrl = await runCatVtonPass({
        client,
        endpoint,
        personBlob: pass1PersonBlob,
        garmentBlob: lowerBlob,
        blankMaskBlob,
        clothType: "lower",
      });
      passes = 2;
    } else if (upperBlob) {
      finalRawUrl = await runCatVtonPass({
        client,
        endpoint,
        personBlob: modelBlob,
        garmentBlob: upperBlob,
        blankMaskBlob,
        clothType: "upper",
      });
      passes = 1;
    } else if (lowerBlob) {
      finalRawUrl = await runCatVtonPass({
        client,
        endpoint,
        personBlob: modelBlob,
        garmentBlob: lowerBlob,
        blankMaskBlob,
        clothType: "lower",
      });
      passes = 1;
    }

    let resultUrl = finalRawUrl;
    try {
      const { buffer, contentType } = await fetchResultBuffer(
        finalRawUrl,
        hfToken
      );
      resultUrl = `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch {
      // Fall back to direct URL if proxy conversion fails.
    }

    // 5. Record usage only after a successful generation
    await db.insert(tryonUsage).values({
      userId: session.user.id,
    });

    const remaining = isUnlimited
      ? null
      : Math.max(0, TRYON_DAILY_LIMIT - (usedCount + 1));

    return NextResponse.json(
      { resultUrl, remaining, unlimited: isUnlimited, passes },
      { status: 200 }
    );
  } catch (error) {
    console.error("[/api/tryon] CatVTON failed:", error);
    return NextResponse.json(
      {
        error: BUSY_ERROR_MESSAGE,
        remaining: currentRemaining,
        unlimited: isUnlimited,
      },
      { status: 503 }
    );
  } finally {
    try {
      client?.close();
    } catch {
      // Ignore cleanup errors on already-closed clients.
    }
  }
}
