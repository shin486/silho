import sharp from "sharp";
import type { OuterwearStyle } from "@/lib/types/tailorFit";
import { synthesizeLayeredOuterwearRgba } from "@/lib/utils/outerwearLayering";

/** Clean neutral studio off-white flat-lay backdrop (`#F6F6F4`) for VTON & CLIP encoders. */
export const STUDIO_FLATLAY_BG = { r: 246, g: 246, b: 244 } as const;

export interface TrimmedGarmentCutout {
  /** PNG buffer with clean alpha channel (no opaque white outer box) */
  buffer: Buffer;
  width: number;
  height: number;
  aspect: number;
}

export interface StudioFlatLayResult {
  pngBuffer: Buffer;
  width: number;
  height: number;
  trimmedWidth: number;
  trimmedHeight: number;
  aspect: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Trims transparent or near-white outer margins (`threshold: 18`) while
 * preserving existing transparency — OR, for opaque white-backdrop uploads,
 * flood-fills outer near-white border pixels (`r > 240 && g > 240 && b > 240`)
 * so overlapping Top + Bottom flat-lays never show an opaque white box over trousers.
 */
export async function trimGarmentCutout(
  buf: Buffer
): Promise<TrimmedGarmentCutout> {
  // Detect before trimming whether the input already has a real transparent alpha cutout.
  // If so, skip opaque-white border flood-removal after trim so bright white cotton tees
  // whose sleeves/hems touch the tight trimmed edge are NEVER erased as "white background".
  let alreadyHasTransparentBorder = false;
  try {
    const probeMeta = await sharp(buf).metadata();
    if (probeMeta.hasAlpha) {
      const probeW = Math.max(4, Math.min(64, probeMeta.width ?? 64));
      const probeH = Math.max(4, Math.min(64, probeMeta.height ?? 64));
      const probeRgba = await sharp(buf)
        .resize(probeW, probeH, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer();
      let borderTotal = 0;
      let borderTransparent = 0;
      for (let x = 0; x < probeW; x++) {
        borderTotal += 2;
        if (probeRgba[x * 4 + 3] < 30) borderTransparent++;
        if (probeRgba[((probeH - 1) * probeW + x) * 4 + 3] < 30)
          borderTransparent++;
      }
      for (let y = 1; y < probeH - 1; y++) {
        borderTotal += 2;
        if (probeRgba[y * probeW * 4 + 3] < 30) borderTransparent++;
        if (probeRgba[(y * probeW + (probeW - 1)) * 4 + 3] < 30)
          borderTransparent++;
      }
      if (borderTransparent >= Math.max(4, Math.floor(borderTotal * 0.1))) {
        alreadyHasTransparentBorder = true;
      }
    }
  } catch {
    // Proceed safely with standard trim
  }

  let pngBuffer: Buffer;
  let width: number;
  let height: number;

  try {
    const trimmed = await sharp(buf)
      .ensureAlpha()
      .trim({ threshold: 18 })
      .png()
      .toBuffer({ resolveWithObject: true });
    if (trimmed.info.width >= 4 && trimmed.info.height >= 4) {
      pngBuffer = trimmed.data;
      width = trimmed.info.width;
      height = trimmed.info.height;
    } else {
      throw new Error("Trim collapsed uniform image");
    }
  } catch {
    const fallback = await sharp(buf)
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true });
    pngBuffer = fallback.data;
    width = fallback.info.width;
    height = fallback.info.height;
  }

  if (alreadyHasTransparentBorder) {
    return {
      buffer: pngBuffer,
      width: Math.max(1, width),
      height: Math.max(1, height),
      aspect: Math.max(1, width) / Math.max(1, height),
    };
  }

  // Probe outer border on a compact working mask to check whether an opaque white box needs flood-removal
  const maxSide = 256;
  const scale = Math.min(1, maxSide / Math.max(1, width, height));
  const maskW = Math.max(4, Math.round(width * scale));
  const maskH = Math.max(4, Math.round(height * scale));

  const smallRgba = await sharp(pngBuffer)
    .resize(maskW, maskH, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer();

  const isOpaqueNearWhite = (idx: number): boolean => {
    const o = idx * 4;
    return (
      smallRgba[o + 3] > 230 &&
      smallRgba[o] > 240 &&
      smallRgba[o + 1] > 240 &&
      smallRgba[o + 2] > 240
    );
  };

  const total = maskW * maskH;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  const trySeed = (x: number, y: number) => {
    const idx = y * maskW + x;
    if (visited[idx] || !isOpaqueNearWhite(idx)) return;
    visited[idx] = 1;
    queue[qTail++] = idx;
  };

  for (let x = 0; x < maskW; x++) {
    trySeed(x, 0);
    trySeed(x, maskH - 1);
  }
  for (let y = 1; y < maskH - 1; y++) {
    trySeed(0, y);
    trySeed(maskW - 1, y);
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % maskW;
    const cy = (cur - cx) / maskW;
    if (cx > 0) trySeed(cx - 1, cy);
    if (cx < maskW - 1) trySeed(cx + 1, cy);
    if (cy > 0) trySeed(cx, cy - 1);
    if (cy < maskH - 1) trySeed(cx, cy + 1);
  }

  // Only strip opaque white border if it removes 1%..88% of the frame (never wipe an entire white garment!)
  if (
    qTail >= Math.max(12, Math.floor(total * 0.01)) &&
    qTail < Math.floor(total * 0.88)
  ) {
    const keepMaskSmall = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      keepMaskSmall[i] = visited[i] ? 0 : 255;
    }

    const [fullRgba, fullKeepAlpha] = await Promise.all([
      sharp(pngBuffer).ensureAlpha().toColourspace("srgb").raw().toBuffer(),
      sharp(keepMaskSmall, {
        raw: { width: maskW, height: maskH, channels: 1 },
      })
        .resize(width, height, { kernel: "lanczos3" })
        .blur(0.8)
        .toColourspace("b-w")
        .extractChannel(0)
        .raw()
        .toBuffer(),
    ]);

    const fullPixels = width * height;
    const outRgba = new Uint8Array(fullRgba);
    for (let p = 0; p < fullPixels; p++) {
      const aIdx = p * 4 + 3;
      if (fullKeepAlpha[p] < outRgba[aIdx]) {
        outRgba[aIdx] = fullKeepAlpha[p];
      }
    }

    const cleaned = await sharp(outRgba, {
      raw: { width, height, channels: 4 },
    })
      .png()
      .toBuffer();

    try {
      const retrimmed = await sharp(cleaned)
        .trim({ threshold: 18 })
        .png()
        .toBuffer({ resolveWithObject: true });
      pngBuffer = retrimmed.data;
      width = retrimmed.info.width;
      height = retrimmed.info.height;
    } catch {
      pngBuffer = cleaned;
    }
  }

  return {
    buffer: pngBuffer,
    width: Math.max(1, width),
    height: Math.max(1, height),
    aspect: Math.max(1, width) / Math.max(1, height),
  };
}

/**
 * Auto-detects the exact row (`sleeveEndY`) where drop-sleeves end and the clean
 * straight-sided torso column begins, plus the bottom hem horizontal span.
 */
async function analyzeTopSilhouette(cutout: TrimmedGarmentCutout): Promise<{
  torsoWidth: number;
  sleeveEndY: number;
  hemLeftRatio: number;
  hemRightRatio: number;
}> {
  const rgba = await sharp(cutout.buffer)
    .ensureAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer();

  const w = cutout.width;
  const h = cutout.height;
  const rowBounds: Array<{ minX: number; maxX: number; span: number }> = [];

  for (let y = 0; y < h; y++) {
    let minX = -1;
    let maxX = -1;
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] > 40) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    rowBounds.push({
      minX,
      maxX,
      span: minX === -1 ? 0 : maxX - minX + 1,
    });
  }

  const yStart = Math.floor(h * 0.72);
  const yEnd = Math.min(h - 1, Math.floor(h * 0.94));
  const lefts: number[] = [];
  const rights: number[] = [];
  for (let y = yStart; y <= yEnd; y++) {
    if (rowBounds[y].span > w * 0.25) {
      lefts.push(rowBounds[y].minX);
      rights.push(rowBounds[y].maxX);
    }
  }

  lefts.sort((a, b) => a - b);
  rights.sort((a, b) => a - b);
  const torsoLeft =
    lefts.length > 0
      ? lefts[Math.floor(lefts.length / 2)]
      : Math.round(w * 0.22);
  const torsoRight =
    rights.length > 0
      ? rights[Math.floor(rights.length / 2)]
      : Math.round(w * 0.78);
  const torsoWidth = Math.max(16, torsoRight - torsoLeft + 1);

  // Detect sleeveEndY: first row after y = 36% where width drops within 8% of torsoWidth
  // and remains narrow for 5 consecutive rows.
  let sleeveEndY = Math.round(h * 0.58);
  const narrowLimit = torsoWidth * 1.08;
  for (let y = Math.round(h * 0.36); y < Math.round(h * 0.75); y++) {
    let ok = true;
    for (let k = 0; k < 5; k++) {
      if (y + k >= h || rowBounds[y + k].span > narrowLimit) {
        ok = false;
        break;
      }
    }
    if (ok) {
      sleeveEndY = y + 2;
      break;
    }
  }

  return {
    torsoWidth,
    sleeveEndY,
    hemLeftRatio: clamp(torsoLeft / Math.max(1, w), 0, 0.45),
    hemRightRatio: clamp((torsoRight + 1) / Math.max(1, w), 0.55, 1),
  };
}

/**
 * Seam-Preserving Top Silhouette Warp (verified Method B + Heavyweight Boxy Block):
 * - Preserves collar, diagonal drop-sleeve cuffs (via auto-detected `sleeveEndY`), and the
 *   real stitched bottom hem band (88%..100%) re-stitched with a 4px soft blend seam.
 * - Compresses or stretches ONLY the clean lower torso column to reach exact pixel target.
 * - When `widthScale >= 1.12` (Boxy / Oversized), straightens and widens the lower torso
 *   rows below the armpits into a 100% untapered vertical block (zero waist taper) so FASHN
 *   reads a true heavyweight boxy drop-shoulder tee (Elwood / Rue Porter / LA Apparel 1801GD).
 */
export async function reshapeTopSeamPreserving(params: {
  cutout: TrimmedGarmentCutout;
  targetWidth: number;
  targetHeight: number;
  cropBottomPct: number;
  widthScale?: number;
}): Promise<{
  pngBuffer: Buffer;
  hemLeftRatio: number;
  hemRightRatio: number;
}> {
  const { cutout, targetWidth, targetHeight, cropBottomPct } = params;
  const widthScale = params.widthScale ?? 1.0;
  const w = cutout.width;
  const h = cutout.height;
  let { sleeveEndY, hemLeftRatio, hemRightRatio } =
    await analyzeTopSilhouette(cutout);

  // Compute source-space target height matching the requested crop/stretch ratio
  // so the stitched hem band keeps realistic proportion before final lanczos3 resize.
  const scaleRatioY = clamp(
    (targetHeight / Math.max(1, targetWidth)) / Math.max(0.25, h / Math.max(1, w)),
    0.58,
    1.32
  );
  const desiredH = clamp(
    Math.round(h * scaleRatioY),
    Math.round(h * 0.58),
    Math.round(h * 1.32)
  );

  const seamPx = 4;
  const hemStartY = Math.min(h - 12, Math.round(h * 0.88));
  const hemBandH = Math.max(12, h - hemStartY);
  const yokeEndY = clamp(sleeveEndY, Math.round(h * 0.38), hemStartY - 20);
  const srcMidH = Math.max(10, hemStartY - yokeEndY);

  // Keep yoke + sleeves 1:1 on regular/long; scale yoke smoothly when heavily shortened
  // so diagonal sleeve cuffs stay crisp with zero wings or notches.
  const yokeScaleY =
    cropBottomPct > 4
      ? clamp(1 - (cropBottomPct / 100) * 0.72, 0.8, 1.0)
      : 1.0;
  const targetYokeH = Math.max(24, Math.round(yokeEndY * yokeScaleY));
  const targetHemH = hemBandH;
  const targetMidH = Math.max(
    seamPx + 12,
    desiredH - targetYokeH - targetHemH
  );
  const stitchedH = targetYokeH + targetMidH + targetHemH;

  const [yokeRaw, midRaw, hemRaw] = await Promise.all([
    sharp(cutout.buffer)
      .extract({ left: 0, top: 0, width: w, height: yokeEndY })
      .resize({
        width: w,
        height: targetYokeH,
        fit: "fill",
        kernel: "lanczos3",
      })
      .ensureAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(cutout.buffer)
      .extract({
        left: 0,
        top: yokeEndY,
        width: w,
        height: Math.min(h - yokeEndY, srcMidH + seamPx),
      })
      .resize({
        width: w,
        height: targetMidH + seamPx,
        fit: "fill",
        kernel: "lanczos3",
      })
      .ensureAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
    sharp(cutout.buffer)
      .extract({ left: 0, top: hemStartY, width: w, height: hemBandH })
      .ensureAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer(),
  ]);

  const stitched = new Uint8Array(w * stitchedH * 4);

  // 1. Zone 1: Upper Yoke, Collar & Sleeves
  stitched.set(yokeRaw, 0);

  // 2. Zone 2: Compressed/Stretched Mid-Torso
  stitched.set(midRaw.subarray(0, targetMidH * w * 4), targetYokeH * w * 4);

  // 3. Zone 3: Preserved Stitched Bottom Hem Band with 4px soft blend seam
  const hemDestStartRow = targetYokeH + targetMidH;
  for (let row = 0; row < targetHemH; row++) {
    const destY = hemDestStartRow + row;
    for (let x = 0; x < w; x++) {
      const destIdx = (destY * w + x) * 4;
      const hemIdx = (row * w + x) * 4;
      if (row < seamPx) {
        const t = (row + 1) / (seamPx + 1);
        const midOverlapIdx = ((targetMidH + row) * w + x) * 4;
        for (let c = 0; c < 4; c++) {
          stitched[destIdx + c] = Math.round(
            midRaw[midOverlapIdx + c] * (1 - t) + hemRaw[hemIdx + c] * t
          );
        }
      } else {
        stitched[destIdx] = hemRaw[hemIdx];
        stitched[destIdx + 1] = hemRaw[hemIdx + 1];
        stitched[destIdx + 2] = hemRaw[hemIdx + 2];
        stitched[destIdx + 3] = hemRaw[hemIdx + 3];
      }
    }
  }

  // 4. Heavyweight Boxy Straight-Side-Seam Block Pass (when widthScale >= 1.12):
  // Eliminates inward waist taper and widens the straight lower torso column below the
  // armpits so the silhouette matches a true boxy drop-shoulder tee with crisp vertical sides.
  if (widthScale >= 1.12 && stitchedH > targetYokeH + 16) {
    const boxyStrength = clamp((widthScale - 1.1) / 0.14, 0.15, 1.0);
    const torsoRows: Array<{ minX: number; maxX: number; span: number }> = [];
    for (let y = 0; y < stitchedH; y++) {
      let minX = -1;
      let maxX = -1;
      const rowOff = y * w * 4;
      for (let x = 0; x < w; x++) {
        if (stitched[rowOff + x * 4 + 3] > 40) {
          if (minX === -1) minX = x;
          maxX = x;
        }
      }
      torsoRows.push({
        minX,
        maxX,
        span: minX === -1 ? 0 : maxX - minX + 1,
      });
    }

    // Measure upper-chest reference width right at the underarm junction so we
    // eliminate inward waist taper without creating an outward A-line flare step.
    const chestSampleStart = Math.min(stitchedH - 1, targetYokeH);
    const chestSampleEnd = Math.min(stitchedH - 1, targetYokeH + 10);
    const chestSpans: number[] = [];
    const centerSamples: number[] = [];
    for (let y = chestSampleStart; y <= chestSampleEnd; y++) {
      const rb = torsoRows[y];
      if (rb.span > w * 0.25) {
        chestSpans.push(rb.span);
        centerSamples.push((rb.minX + rb.maxX) * 0.5);
      }
    }

    if (chestSpans.length > 0 && centerSamples.length > 0) {
      chestSpans.sort((a, b) => a - b);
      centerSamples.sort((a, b) => a - b);
      const chestAnchorSpan = chestSpans[Math.floor(chestSpans.length / 2)];
      const centerX = centerSamples[Math.floor(centerSamples.length / 2)];
      // Drop straight down vertically from the armpit chest width (up to +2% subtle boxy ease, zero bulge)
      const targetSpan = Math.min(
        w * 0.84,
        chestAnchorSpan * (1 + 0.02 * boxyStrength)
      );
      const targetHalfSpan = targetSpan * 0.5;
      const targetLeft = clamp(centerX - targetHalfSpan, 1, w * 0.45);
      const targetRight = clamp(centerX + targetHalfSpan, w * 0.55, w - 2);
      const transitionRows = Math.max(12, Math.min(24, Math.round(stitchedH * 0.06)));

      const rowCopy = new Uint8Array(w * 4);
      for (let y = targetYokeH; y < stitchedH; y++) {
        const rb = torsoRows[y];
        if (rb.span < 16) continue;

        const tRaw = clamp((y - targetYokeH) / transitionRows, 0, 1);
        // Smoothstep ramp from underarm into full straight vertical side seams
        const blend = tRaw * tRaw * (3 - 2 * tRaw);
        const dstL = Math.min(rb.minX, rb.minX + (targetLeft - rb.minX) * blend);
        const dstR = Math.max(rb.maxX, rb.maxX + (targetRight - rb.maxX) * blend);
        const dstSpan = Math.max(1, dstR - dstL);
        const srcSpan = Math.max(1, rb.maxX - rb.minX);

        const rowOff = y * w * 4;
        rowCopy.set(stitched.subarray(rowOff, rowOff + w * 4));
        stitched.fill(0, rowOff, rowOff + w * 4);

        const xStart = Math.max(0, Math.floor(dstL));
        const xEnd = Math.min(w - 1, Math.ceil(dstR));
        for (let x = xStart; x <= xEnd; x++) {
          const u = clamp((x - dstL) / dstSpan, 0, 1);
          const srcX = rb.minX + u * srcSpan;
          const x0 = clamp(Math.floor(srcX), 0, w - 1);
          const x1 = clamp(x0 + 1, 0, w - 1);
          const frac = srcX - x0;
          const o0 = x0 * 4;
          const o1 = x1 * 4;
          const d = rowOff + x * 4;
          for (let c = 0; c < 4; c++) {
            stitched[d + c] = Math.round(
              rowCopy[o0 + c] * (1 - frac) + rowCopy[o1 + c] * frac
            );
          }
        }
      }

      hemLeftRatio = clamp(targetLeft / Math.max(1, w), 0, 0.45);
      hemRightRatio = clamp((targetRight + 1) / Math.max(1, w), 0.55, 1);
    }
  }

  const pngBuffer = await sharp(stitched, {
    raw: { width: w, height: stitchedH, channels: 4 },
  })
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "fill",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();

  return { pngBuffer, hemLeftRatio, hemRightRatio };
}

/**
 * Hem-Preserving Bottom Reshaper:
 * Preserves the bottom ankle cuff (last 6%) intact when cropping ankle length,
 * compressing the mid-leg smoothly before sizing to exact pixel target.
 */
export async function reshapeBottomHemPreserving(params: {
  cutout: TrimmedGarmentCutout;
  targetWidth: number;
  targetHeight: number;
  cropBottomPct: number;
}): Promise<Buffer> {
  const { cutout, targetWidth, targetHeight, cropBottomPct } = params;
  const w = cutout.width;
  const h = cutout.height;

  if (cropBottomPct <= 0.5 || h < 48) {
    return sharp(cutout.buffer)
      .resize({
        width: targetWidth,
        height: targetHeight,
        fit: "fill",
        kernel: "lanczos3",
      })
      .png()
      .toBuffer();
  }

  const cuffH = Math.max(8, Math.round(h * 0.06));
  const upperSrcH = Math.max(16, h - cuffH);
  const croppedTotalH = Math.max(
    cuffH + 16,
    Math.round(h * (1 - clamp(cropBottomPct, 0, 35) / 100))
  );
  const upperDstH = Math.max(16, croppedTotalH - cuffH);

  const [legPng, cuffPng] = await Promise.all([
    sharp(cutout.buffer)
      .extract({ left: 0, top: 0, width: w, height: upperSrcH })
      .resize({ width: w, height: upperDstH, fit: "fill", kernel: "lanczos3" })
      .png()
      .toBuffer(),
    sharp(cutout.buffer)
      .extract({ left: 0, top: upperSrcH, width: w, height: cuffH })
      .png()
      .toBuffer(),
  ]);

  const stitched = await sharp({
    create: {
      width: w,
      height: upperDstH + cuffH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: legPng, left: 0, top: 0 },
      { input: cuffPng, left: 0, top: upperDstH },
    ])
    .png()
    .toBuffer();

  return sharp(stitched)
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "fill",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();
}

/**
 * Generates a subtle 8px downward cast shadow PNG (`rgba(0,0,0,0.22)` -> `0`)
 * with soft horizontal edge feathering so an untucked top casts a natural 3D depth
 * cue strictly onto the trousers underneath its hem.
 */
export async function createUntuckedHemShadowPng(
  widthPx: number,
  heightPx = 8
): Promise<Buffer> {
  const w = Math.max(4, Math.round(widthPx));
  const h = Math.max(2, Math.round(heightPx));
  const raw = new Uint8Array(w * h * 4);
  const featherX = Math.max(2, Math.round(w * 0.06));

  for (let y = 0; y < h; y++) {
    // Smooth quadratic decay from 0.22 at y=0 to 0 at bottom
    const ny = y / Math.max(1, h - 1);
    const verticalAlpha = 0.22 * (1 - ny) * (1 - ny * 0.35);

    for (let x = 0; x < w; x++) {
      let edgeFactor = 1;
      if (x < featherX) {
        edgeFactor = (x + 1) / (featherX + 1);
      } else if (x >= w - featherX) {
        edgeFactor = (w - x) / (featherX + 1);
      }

      const idx = (y * w + x) * 4;
      raw[idx] = 0;
      raw[idx + 1] = 0;
      raw[idx + 2] = 0;
      raw[idx + 3] = Math.round(clamp(verticalAlpha * edgeFactor * 255, 0, 255));
    }
  }

  return sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
}

/**
 * Composites an isolated transparent garment cutout onto a clean neutral `#F6F6F4`
 * off-white studio flat-lay canvas with centered aspect-ratio padding (default 768x1024
 * with uniform 8% editorial margin), ensuring VTON engines (WeShopAI, FitDiT HD, FASHN)
 * and CLIP garment encoders see pure centered fabric with zero border clipping or alpha artifacts.
 */
export async function composeStudioFlatLayCanvas(params: {
  rawBuffer: Buffer;
  canvasWidth?: number;
  canvasHeight?: number;
  paddingRatio?: number;
}): Promise<StudioFlatLayResult> {
  const canvasWidth = Math.max(64, Math.round(params.canvasWidth ?? 768));
  const canvasHeight = Math.max(64, Math.round(params.canvasHeight ?? 1024));
  const paddingRatio = clamp(params.paddingRatio ?? 0.08, 0.02, 0.25);

  const trimmed = await trimGarmentCutout(params.rawBuffer);

  const maxInnerW = Math.max(16, Math.round(canvasWidth * (1 - paddingRatio * 2)));
  const maxInnerH = Math.max(16, Math.round(canvasHeight * (1 - paddingRatio * 2)));
  const scale = Math.min(
    maxInnerW / Math.max(1, trimmed.width),
    maxInnerH / Math.max(1, trimmed.height)
  );
  const fitW = Math.max(1, Math.min(maxInnerW, Math.round(trimmed.width * scale)));
  const fitH = Math.max(1, Math.min(maxInnerH, Math.round(trimmed.height * scale)));
  const left = Math.max(0, Math.floor((canvasWidth - fitW) / 2));
  const top = Math.max(0, Math.floor((canvasHeight - fitH) / 2));

  const fittedGarment = await sharp(trimmed.buffer)
    .ensureAlpha()
    .resize({
      width: fitW,
      height: fitH,
      fit: "fill",
      kernel: "lanczos3",
    })
    .png()
    .toBuffer();

  const pngBuffer = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: STUDIO_FLATLAY_BG,
    },
  })
    .composite([{ input: fittedGarment, left, top }])
    .png({ compressionLevel: 4 })
    .toBuffer();

  return {
    pngBuffer,
    width: canvasWidth,
    height: canvasHeight,
    trimmedWidth: trimmed.width,
    trimmedHeight: trimmed.height,
    aspect: trimmed.aspect,
  };
}

/**
 * Composites a transparent `Outerwear` cutout cleanly over an inner `Top` cutout
 * using our 3-mode layered synthesizer:
 *  - `open-front` (default): splits zipped jackets along their center zipper axis
 *    (~19% center opening with lapel edge shadows) to reveal the full inner tee column.
 *  - `collar-hem-peek`: keeps the jacket zipped, replaces dark ghost-mannequin collar
 *    lining with the inner tee crewneck, and peeks ~8.5% of the tee hem below the waist.
 *  - `collar-only`: keeps the jacket zipped and reveals the tee crewneck inside the collar
 *    while tucking the tee hem cleanly behind the jacket waist.
 *
 * Used across WeShopAI, FASHN VTON 1.5, FitDiT HD, CatVTON, and 1-Pass Composite so the
 * outerwear pass never overwrites the inner shirt.
 */
export async function composeLayeredUpperCutout(
  topCutout: TrimmedGarmentCutout,
  outerwearCutout: TrimmedGarmentCutout,
  options?: {
    style?: OuterwearStyle;
    suppressHemPeek?: boolean;
  }
): Promise<TrimmedGarmentCutout> {
  const [topRaw, outerRaw] = await Promise.all([
    sharp(topCutout.buffer)
      .ensureAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(outerwearCutout.buffer)
      .ensureAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);

  const result = synthesizeLayeredOuterwearRgba(
    {
      rgba: new Uint8ClampedArray(
        topRaw.data.buffer,
        topRaw.data.byteOffset,
        topRaw.data.byteLength
      ),
      width: topRaw.info.width,
      height: topRaw.info.height,
    },
    {
      rgba: new Uint8ClampedArray(
        outerRaw.data.buffer,
        outerRaw.data.byteOffset,
        outerRaw.data.byteLength
      ),
      width: outerRaw.info.width,
      height: outerRaw.info.height,
    },
    {
      style: options?.style ?? "open-front",
      suppressHemPeek: options?.suppressHemPeek ?? false,
      maxWidth: 768,
    }
  );

  const layered = await sharp(Buffer.from(result.rgba), {
    raw: { width: result.width, height: result.height, channels: 4 },
  })
    .png({ compressionLevel: 4 })
    .toBuffer();

  return {
    buffer: layered,
    width: result.width,
    height: result.height,
    aspect: result.width / Math.max(1, result.height),
  };
}
