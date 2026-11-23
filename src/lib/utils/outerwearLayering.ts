import type { OuterwearStyle } from "@/lib/types/tailorFit";

export interface RgbaBuffer {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface LayeredOuterwearOptions {
  style: OuterwearStyle;
  /** Suppresses bottom hem peek below the jacket waist (e.g. when tucked into trousers). */
  suppressHemPeek?: boolean;
  /** Maximum working width for the outerwear garment (default 768 on server, 320 in preview). */
  maxWidth?: number;
}

export interface LayeredOuterwearResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  style: OuterwearStyle;
  /** True if the uploaded outerwear PNG was already open down the center front. */
  wasAlreadyOpenFront: boolean;
  /** Center opening width in output pixels (0 when zipped). */
  openGapPx: number;
  /** Number of dark ghost-mannequin collar-lining pixels replaced with the inner tee. */
  collarCavityPixels: number;
  /** Extra tee hem peek height below the jacket waist belt in output pixels. */
  hemPeekPx: number;
}

interface OuterwearGeometry {
  centerX: number;
  splitX: number;
  torsoLeft: number;
  torsoRight: number;
  torsoWidth: number;
  collarTopY: number;
  collarRimY: number;
  /** Per-column back-collar rim bottom row following the actual curved jacket neckline. */
  colRimY: Int32Array;
  torsoBottomY: number;
  /** Per-column waist hem row across the torso so downward hem shadows follow curved/belted hems. */
  colWaistBottomY: Int32Array;
  alreadyOpenFront: boolean;
  bodyR: number;
  bodyG: number;
  bodyB: number;
  bodyLum: number;
  bodySat: number;
  rowTorsoLeft: Int32Array;
  rowTorsoRight: Int32Array;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) * 0.5;
}

/**
 * Premultiplied-alpha bilinear RGBA resampler (pure JS, zero native deps,
 * identical results in Node and Browser without dark edge halos).
 */
export function resampleRgba(
  src: RgbaBuffer,
  dstW: number,
  dstH: number
): RgbaBuffer {
  const tw = Math.max(1, Math.round(dstW));
  const th = Math.max(1, Math.round(dstH));
  if (tw === src.width && th === src.height) {
    return {
      rgba: new Uint8ClampedArray(src.rgba),
      width: tw,
      height: th,
    };
  }

  const out = new Uint8ClampedArray(tw * th * 4);
  const sw = src.width;
  const sh = src.height;
  const sData = src.rgba;
  const scaleX = sw / tw;
  const scaleY = sh / th;

  for (let y = 0; y < th; y++) {
    const fy = clamp((y + 0.5) * scaleY - 0.5, 0, sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = fy - y0;
    const invWy = 1 - wy;
    const row0 = y0 * sw;
    const row1 = y1 * sw;
    const dstRow = y * tw;

    for (let x = 0; x < tw; x++) {
      const fx = clamp((x + 0.5) * scaleX - 0.5, 0, sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = fx - x0;
      const invWx = 1 - wx;

      const w00 = invWx * invWy;
      const w10 = wx * invWy;
      const w01 = invWx * wy;
      const w11 = wx * wy;

      const o00 = (row0 + x0) * 4;
      const o10 = (row0 + x1) * 4;
      const o01 = (row1 + x0) * 4;
      const o11 = (row1 + x1) * 4;

      const a00 = sData[o00 + 3];
      const a10 = sData[o10 + 3];
      const a01 = sData[o01 + 3];
      const a11 = sData[o11 + 3];

      const a = a00 * w00 + a10 * w10 + a01 * w01 + a11 * w11;
      const d = (dstRow + x) * 4;
      if (a < 1) {
        out[d + 3] = 0;
        continue;
      }

      const pr =
        sData[o00] * a00 * w00 +
        sData[o10] * a10 * w10 +
        sData[o01] * a01 * w01 +
        sData[o11] * a11 * w11;
      const pg =
        sData[o00 + 1] * a00 * w00 +
        sData[o10 + 1] * a10 * w10 +
        sData[o01 + 1] * a01 * w01 +
        sData[o11 + 1] * a11 * w11;
      const pb =
        sData[o00 + 2] * a00 * w00 +
        sData[o10 + 2] * a10 * w10 +
        sData[o01 + 2] * a01 * w01 +
        sData[o11 + 2] * a11 * w11;

      out[d] = Math.round(clamp(pr / a, 0, 255));
      out[d + 1] = Math.round(clamp(pg / a, 0, 255));
      out[d + 2] = Math.round(clamp(pb / a, 0, 255));
      out[d + 3] = Math.round(clamp(a, 0, 255));
    }
  }

  return { rgba: out, width: tw, height: th };
}

/**
 * Measures the straight lower-torso width of an inner Top cutout (ignoring wide
 * boxy/dropped short sleeves in the upper half) so the inner shirt's torso aligns
 * proportionally with the outerwear torso column.
 */
function measureInnerTopTorsoBounds(top: RgbaBuffer): {
  torsoLeft: number;
  torsoRight: number;
  torsoWidth: number;
  collarTopY: number;
} {
  const { rgba, width: w, height: h } = top;
  const lefts: number[] = [];
  const rights: number[] = [];
  const yStart = Math.floor(h * 0.68);
  const yEnd = Math.min(h - 1, Math.floor(h * 0.94));

  for (let y = yStart; y <= yEnd; y++) {
    let minX = -1;
    let maxX = -1;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (rgba[(row + x) * 4 + 3] >= 32) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }
    if (minX !== -1 && maxX - minX + 1 >= w * 0.22) {
      lefts.push(minX);
      rights.push(maxX);
    }
  }

  const torsoLeft =
    lefts.length > 0 ? Math.round(medianOf(lefts)) : Math.round(w * 0.22);
  const torsoRight =
    rights.length > 0 ? Math.round(medianOf(rights)) : Math.round(w * 0.78);
  const torsoWidth = Math.max(12, torsoRight - torsoLeft + 1);

  const midX = Math.round((torsoLeft + torsoRight) * 0.5);
  const probeHalf = Math.max(2, Math.round(torsoWidth * 0.16));
  let collarTopY = 0;
  outer: for (let y = 0; y < Math.floor(h * 0.35); y++) {
    const row = y * w;
    for (
      let x = Math.max(0, midX - probeHalf);
      x <= Math.min(w - 1, midX + probeHalf);
      x++
    ) {
      if (rgba[(row + x) * 4 + 3] >= 32) {
        collarTopY = y;
        break outer;
      }
    }
  }

  return { torsoLeft, torsoRight, torsoWidth, collarTopY };
}

/**
 * Analyzes an outerwear cutout's torso column (separating hanging long sleeves at
 * armpit gaps), waist hem row (ignoring longer hanging cuffs), zipper/front axis,
 * curved back-collar rim, open-front state, and median front-body fabric color.
 */
function analyzeOuterwearStructure(outer: RgbaBuffer): OuterwearGeometry {
  const { rgba, width: w, height: h } = outer;
  const midX = Math.floor(w / 2);

  // 1. Check whether the uploaded outerwear PNG is already open down the center chest
  const stripHalf = Math.max(2, Math.round(w * 0.04));
  const stripY0 = Math.floor(h * 0.36);
  const stripY1 = Math.min(h - 1, Math.floor(h * 0.84));
  let centerTotal = 0;
  let centerOpaque = 0;
  for (let y = stripY0; y <= stripY1; y++) {
    const row = y * w;
    for (
      let x = Math.max(0, midX - stripHalf);
      x <= Math.min(w - 1, midX + stripHalf);
      x++
    ) {
      centerTotal++;
      if (rgba[(row + x) * 4 + 3] >= 24) centerOpaque++;
    }
  }
  const alreadyOpenFront = centerOpaque / Math.max(1, centerTotal) < 0.45;

  // 2. Find central torso bounds per row inside armpit gaps (y = 44%..82%)
  const runLefts: number[] = [];
  const runRights: number[] = [];
  const rowTorsoLeft = new Int32Array(h).fill(-1);
  const rowTorsoRight = new Int32Array(h).fill(-1);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    if (!alreadyOpenFront) {
      let seedX = -1;
      for (let d = 0; d <= Math.round(w * 0.12); d++) {
        if (midX + d < w && rgba[(row + midX + d) * 4 + 3] >= 24) {
          seedX = midX + d;
          break;
        }
        if (midX - d >= 0 && rgba[(row + midX - d) * 4 + 3] >= 24) {
          seedX = midX - d;
          break;
        }
      }
      if (seedX !== -1) {
        let l = seedX;
        while (l > 0 && rgba[(row + l - 1) * 4 + 3] >= 24) l--;
        let r = seedX;
        while (r < w - 1 && rgba[(row + r + 1) * 4 + 3] >= 24) r++;
        rowTorsoLeft[y] = l;
        rowTorsoRight[y] = r;
        if (y >= Math.floor(h * 0.44) && y <= Math.floor(h * 0.82)) {
          if (r - l + 1 <= w * 0.82 && r - l + 1 >= w * 0.24) {
            runLefts.push(l);
            runRights.push(r);
          }
        }
      }
    } else {
      let leftInner = midX;
      while (leftInner > 0 && rgba[(row + leftInner) * 4 + 3] < 24) leftInner--;
      let leftOuter = leftInner;
      while (leftOuter > 0 && rgba[(row + leftOuter - 1) * 4 + 3] >= 24)
        leftOuter--;

      let rightInner = midX;
      while (rightInner < w - 1 && rgba[(row + rightInner) * 4 + 3] < 24)
        rightInner++;
      let rightOuter = rightInner;
      while (rightOuter < w - 1 && rgba[(row + rightOuter + 1) * 4 + 3] >= 24)
        rightOuter++;

      if (leftInner > leftOuter && rightOuter > rightInner) {
        rowTorsoLeft[y] = leftOuter;
        rowTorsoRight[y] = rightOuter;
        if (y >= Math.floor(h * 0.44) && y <= Math.floor(h * 0.82)) {
          if (rightOuter - leftOuter + 1 <= w * 0.84) {
            runLefts.push(leftOuter);
            runRights.push(rightOuter);
          }
        }
      }
    }
  }

  let torsoLeft: number;
  let torsoRight: number;
  if (runLefts.length >= 6) {
    torsoLeft = Math.round(medianOf(runLefts));
    torsoRight = Math.round(medianOf(runRights));
  } else {
    torsoLeft = Math.round(w * 0.21);
    torsoRight = Math.round(w * 0.79);
  }

  let torsoWidth = Math.max(20, torsoRight - torsoLeft + 1);
  if (torsoWidth > w * 0.74) {
    const cx = Math.round((torsoLeft + torsoRight) * 0.5);
    torsoWidth = Math.round(w * 0.58);
    torsoLeft = clamp(cx - Math.floor(torsoWidth / 2), 0, w - 1);
    torsoRight = clamp(torsoLeft + torsoWidth - 1, 0, w - 1);
  }
  const centerX = Math.round((torsoLeft + torsoRight) * 0.5);

  const clampPad = Math.max(2, Math.round(torsoWidth * 0.05));
  for (let y = 0; y < h; y++) {
    if (rowTorsoLeft[y] === -1 || rowTorsoLeft[y] < torsoLeft - clampPad) {
      rowTorsoLeft[y] = torsoLeft;
    }
    if (rowTorsoRight[y] === -1 || rowTorsoRight[y] > torsoRight + clampPad) {
      rowTorsoRight[y] = torsoRight;
    }
  }

  // 3. Find exact jacket torso bottom hem row (median across the waist span,
  // ignoring both lower-hanging wrist cuffs AND narrow downward belt-buckle tips).
  const checkL = clamp(
    torsoLeft + Math.round(torsoWidth * 0.1),
    0,
    w - 1
  );
  const checkR = clamp(
    torsoRight - Math.round(torsoWidth * 0.1),
    checkL,
    w - 1
  );
  const colWaistBottomY = new Int32Array(w).fill(h - 1);
  const waistBottomSamples: number[] = [];

  for (let x = torsoLeft; x <= torsoRight; x++) {
    let colBottom = -1;
    for (let y = h - 1; y >= Math.floor(h * 0.45); y--) {
      if (rgba[(y * w + x) * 4 + 3] >= 24) {
        colBottom = y;
        break;
      }
    }
    if (colBottom !== -1) {
      colWaistBottomY[x] = colBottom;
      if (x >= checkL && x <= checkR) {
        waistBottomSamples.push(colBottom);
      }
    }
  }

  // Use 75th-percentile waist bottom so curved belted waists anchor solidly at the belt's lower rim
  let torsoBottomY = h - 1;
  if (waistBottomSamples.length >= 6) {
    waistBottomSamples.sort((a, b) => a - b);
    torsoBottomY =
      waistBottomSamples[Math.floor(waistBottomSamples.length * 0.78)];
  }
  for (let x = 0; x < w; x++) {
    if (x < torsoLeft || x > torsoRight) {
      colWaistBottomY[x] = torsoBottomY;
    }
  }

  // 4. Curved back-collar rim tracking actual per-column top silhouette near neck
  const neckProbeHalf = Math.max(3, Math.round(torsoWidth * 0.14));
  let collarTopY = 0;
  findTop: for (let y = 0; y < Math.floor(torsoBottomY * 0.35); y++) {
    const row = y * w;
    for (
      let x = Math.max(0, centerX - neckProbeHalf);
      x <= Math.min(w - 1, centerX + neckProbeHalf);
      x++
    ) {
      if (rgba[(row + x) * 4 + 3] >= 24) {
        collarTopY = y;
        break findTop;
      }
    }
  }

  const rimThickness = Math.max(4, Math.round(h * 0.03));
  const collarRimY = Math.min(torsoBottomY - 12, collarTopY + rimThickness);
  const colRimY = new Int32Array(w).fill(collarRimY);
  for (
    let x = Math.max(0, centerX - Math.round(torsoWidth * 0.34));
    x <= Math.min(w - 1, centerX + Math.round(torsoWidth * 0.34));
    x++
  ) {
    let colTop = collarTopY;
    for (let y = 0; y < Math.floor(torsoBottomY * 0.35); y++) {
      if (rgba[(y * w + x) * 4 + 3] >= 24) {
        colTop = y;
        break;
      }
    }
    colRimY[x] = Math.min(torsoBottomY - 12, colTop + rimThickness);
  }

  // 5. Sample median outer front jacket color from mid-chest wings (away from collar & zipper)
  const rSamples: number[] = [];
  const gSamples: number[] = [];
  const bSamples: number[] = [];
  const ySample0 = Math.round(torsoBottomY * 0.42);
  const ySample1 = Math.round(torsoBottomY * 0.66);
  const stride = Math.max(1, Math.floor(torsoWidth / 48));
  for (let y = ySample0; y <= ySample1; y += stride) {
    const row = y * w;
    for (let side = -1; side <= 1; side += 2) {
      const x0 = clamp(
        centerX + Math.round(side * torsoWidth * 0.16),
        0,
        w - 1
      );
      const x1 = clamp(
        centerX + Math.round(side * torsoWidth * 0.34),
        0,
        w - 1
      );
      const xa = Math.min(x0, x1);
      const xb = Math.max(x0, x1);
      for (let x = xa; x <= xb; x += stride) {
        const o = (row + x) * 4;
        if (rgba[o + 3] >= 200) {
          rSamples.push(rgba[o]);
          gSamples.push(rgba[o + 1]);
          bSamples.push(rgba[o + 2]);
        }
      }
    }
  }
  const bodyR = rSamples.length > 0 ? medianOf(rSamples) : 80;
  const bodyG = gSamples.length > 0 ? medianOf(gSamples) : 80;
  const bodyB = bSamples.length > 0 ? medianOf(bSamples) : 80;
  const bodyLum = 0.2126 * bodyR + 0.7152 * bodyG + 0.0722 * bodyB;
  const bodySat =
    Math.max(bodyR, bodyG, bodyB) - Math.min(bodyR, bodyG, bodyB);

  // 6. Detect center zipper / placket axis within centerX ± 7% of torsoWidth
  let splitX = centerX;
  if (!alreadyOpenFront) {
    const searchHalf = Math.max(2, Math.round(torsoWidth * 0.07));
    const zY0 = Math.round(torsoBottomY * 0.36);
    const zY1 = Math.round(torsoBottomY * 0.88);
    let bestScore = -Infinity;

    for (
      let x = Math.max(2, centerX - searchHalf);
      x <= Math.min(w - 3, centerX + searchHalf);
      x++
    ) {
      let edgeSum = 0;
      let darkSum = 0;
      let count = 0;
      for (let y = zY0; y <= zY1; y += 2) {
        const o = (y * w + x) * 4;
        if (rgba[o + 3] < 200) continue;
        const lL =
          0.2126 * rgba[(y * w + x - 2) * 4] +
          0.7152 * rgba[(y * w + x - 2) * 4 + 1] +
          0.0722 * rgba[(y * w + x - 2) * 4 + 2];
        const lC =
          0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
        const lR =
          0.2126 * rgba[(y * w + x + 2) * 4] +
          0.7152 * rgba[(y * w + x + 2) * 4 + 1] +
          0.0722 * rgba[(y * w + x + 2) * 4 + 2];
        const valley = Math.max(0, (lL + lR) * 0.5 - lC);
        const step = Math.abs(lR - lL);
        edgeSum += valley * 1.4 + step * 0.4;
        darkSum += Math.max(0, bodyLum - lC);
        count++;
      }
      if (count < 8) continue;
      const distNorm = Math.abs(x - centerX) / Math.max(1, searchHalf);
      const centerBonus = (1 - distNorm * distNorm) * 6;
      const score = (edgeSum + darkSum * 0.35) / count + centerBonus;
      if (score > bestScore) {
        bestScore = score;
        splitX = x;
      }
    }
  }

  return {
    centerX,
    splitX,
    torsoLeft,
    torsoRight,
    torsoWidth,
    collarTopY,
    collarRimY,
    colRimY,
    torsoBottomY,
    colWaistBottomY,
    alreadyOpenFront,
    bodyR,
    bodyG,
    bodyB,
    bodyLum,
    bodySat,
    rowTorsoLeft,
    rowTorsoRight,
  };
}

/**
 * Detects the opaque ghost-mannequin interior back-collar lining inside a jacket's
 * V-neck / U-neck opening, strips 1px dark anti-aliased lining fringes along the lapel
 * rim, and returns a smooth continuous mask (`0..255` alpha cutout) for razor-clean lapels.
 */
function detectCollarInteriorMask(
  outer: RgbaBuffer,
  geom: OuterwearGeometry
): {
  cavityMask: Uint8Array;
  cavityAlpha: Uint8Array;
  cavityPixels: number;
  vApexY: number;
} {
  const { rgba, width: w, height: h } = outer;
  const {
    centerX,
    torsoWidth,
    collarRimY,
    colRimY,
    torsoBottomY,
    bodyR,
    bodyG,
    bodyB,
    bodyLum,
    bodySat,
  } = geom;

  const total = w * h;
  const maxY = Math.min(
    torsoBottomY - 8,
    Math.round(collarRimY + (torsoBottomY - collarRimY) * 0.36)
  );
  const spanY = Math.max(12, maxY - collarRimY);

  const inCollarFunnel = (x: number, y: number): boolean => {
    const rimY = colRimY[x] ?? collarRimY;
    if (y < rimY || y > maxY) return false;
    const t = clamp((y - collarRimY) / spanY, 0, 1);
    const maxHalfW = torsoWidth * (0.27 * (1 - t * 0.72));
    return Math.abs(x - centerX) <= maxHalfW;
  };

  const candidate = new Uint8Array(total);
  for (let y = collarRimY; y <= maxY; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!inCollarFunnel(x, y)) continue;
      const idx = row + x;
      const o = idx * 4;
      const a = rgba[o + 3];
      if (a < 24) {
        candidate[idx] = 1;
        continue;
      }

      const r = rgba[o];
      const g = rgba[o + 1];
      const b = rgba[o + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const dist = Math.hypot(r - bodyR, g - bodyG, b - bodyB);

      const isClearlyDarkerLining =
        (bodyLum >= 42 && lum < bodyLum * 0.72 && bodyLum - lum >= 13) ||
        (lum < 48 && dist >= 30);
      const isNeutralDarkSatinGlint =
        bodySat >= 22 && sat < bodySat * 0.48 && lum < 126 && dist >= 32;
      const isDistinctInnerColor = dist >= 50 && lum < bodyLum * 0.94;

      if (
        isClearlyDarkerLining ||
        isNeutralDarkSatinGlint ||
        isDistinctInnerColor
      ) {
        candidate[idx] = 1;
      }
    }
  }

  const cavityMask = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  const seedY0 = collarRimY + 1;
  const seedY1 = Math.min(
    maxY,
    collarRimY + Math.max(8, Math.round(spanY * 0.42))
  );
  const seedHalfX = Math.max(3, Math.round(torsoWidth * 0.12));

  for (let y = seedY0; y <= seedY1; y++) {
    const row = y * w;
    for (
      let x = Math.max(0, centerX - seedHalfX);
      x <= Math.min(w - 1, centerX + seedHalfX);
      x++
    ) {
      const idx = row + x;
      if (candidate[idx] && !cavityMask[idx]) {
        cavityMask[idx] = 1;
        queue[qTail++] = idx;
      }
    }
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    if (cx > 0 && candidate[cur - 1] && !cavityMask[cur - 1]) {
      cavityMask[cur - 1] = 1;
      queue[qTail++] = cur - 1;
    }
    if (cx < w - 1 && candidate[cur + 1] && !cavityMask[cur + 1]) {
      cavityMask[cur + 1] = 1;
      queue[qTail++] = cur + 1;
    }
    if (cy > collarRimY && candidate[cur - w] && !cavityMask[cur - w]) {
      cavityMask[cur - w] = 1;
      queue[qTail++] = cur - w;
    }
    if (cy < maxY && candidate[cur + w] && !cavityMask[cur + w]) {
      cavityMask[cur + w] = 1;
      queue[qTail++] = cur + w;
    }
  }

  const torsoArea = torsoWidth * Math.max(1, torsoBottomY - collarRimY);
  const minValidCavity = Math.max(32, Math.round(torsoArea * 0.008));
  const maxValidCavity = Math.round(torsoArea * 0.13);

  let vApexY = collarRimY + Math.round(spanY * 0.5);
  let cavityPixels = qTail;

  if (qTail >= minValidCavity && qTail <= maxValidCavity) {
    // 1. Scanline fill interior brand-label / satin highlight dots inside the V-opening
    for (let y = collarRimY; y <= maxY; y++) {
      const row = y * w;
      let rowL = -1;
      let rowR = -1;
      for (
        let x = Math.max(0, centerX - Math.round(torsoWidth * 0.29));
        x <= Math.min(w - 1, centerX + Math.round(torsoWidth * 0.29));
        x++
      ) {
        if (cavityMask[row + x]) {
          if (rowL === -1) rowL = x;
          rowR = x;
        }
      }
      if (rowL !== -1 && rowR > rowL) {
        for (let x = rowL; x <= rowR; x++) {
          if (!cavityMask[row + x]) {
            cavityMask[row + x] = 1;
            cavityPixels++;
          }
        }
      }
    }

    // 2. Strip 1px dark anti-aliased lining-to-lapel transition fringe so lapels sit
    // razor-clean over the white tee with zero jagged dark stair-steps!
    const expanded = new Uint8Array(cavityMask);
    for (let y = collarRimY + 1; y < maxY; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const idx = row + x;
        if (cavityMask[idx] || !inCollarFunnel(x, y)) continue;
        const adjCavity =
          cavityMask[idx - 1] ||
          cavityMask[idx + 1] ||
          cavityMask[idx - w] ||
          cavityMask[idx + w];
        if (!adjCavity) continue;
        const o = idx * 4;
        const lum =
          0.2126 * rgba[o] + 0.7152 * rgba[o + 1] + 0.0722 * rgba[o + 2];
        if (lum < bodyLum * 0.88) {
          expanded[idx] = 1;
          cavityPixels++;
        }
      }
    }
    cavityMask.set(expanded);

    for (let y = maxY; y >= collarRimY; y--) {
      const row = y * w;
      let rowCount = 0;
      for (
        let x = Math.max(0, centerX - Math.round(torsoWidth * 0.28));
        x <= Math.min(w - 1, centerX + Math.round(torsoWidth * 0.28));
        x++
      ) {
        if (cavityMask[row + x]) rowCount++;
      }
      if (rowCount >= 3) {
        vApexY = y;
        break;
      }
    }
  } else {
    // Tier 2 Fallback (e.g. jet-black jacket with identical black lining):
    // synthesize a clean anatomical V-neck throat opening beneath the curved collar rim.
    cavityMask.fill(0);
    cavityPixels = 0;
    vApexY = Math.min(
      maxY,
      collarRimY + Math.max(12, Math.round((torsoBottomY - collarRimY) * 0.19))
    );
    const fallbackSpan = Math.max(1, vApexY - collarRimY);

    for (let y = collarRimY; y <= vApexY; y++) {
      const t = (y - collarRimY) / fallbackSpan;
      const halfW = Math.round(torsoWidth * 0.2 * Math.pow(1 - t, 0.82));
      const row = y * w;
      for (
        let x = Math.max(0, centerX - halfW);
        x <= Math.min(w - 1, centerX + halfW);
        x++
      ) {
        if (y < (colRimY[x] ?? collarRimY)) continue;
        cavityMask[row + x] = 1;
        cavityPixels++;
      }
    }
  }

  // Smooth 3x3 box-filter anti-aliasing on `cavityAlpha` (0 = jacket lapel, 255 = clear cavity)
  const cavityAlpha = new Uint8Array(total);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      const sum =
        cavityMask[idx - w - 1] +
        cavityMask[idx - w] * 2 +
        cavityMask[idx - w + 1] +
        cavityMask[idx - 1] * 2 +
        cavityMask[idx] * 4 +
        cavityMask[idx + 1] * 2 +
        cavityMask[idx + w - 1] +
        cavityMask[idx + w] * 2 +
        cavityMask[idx + w + 1];
      // Preserve crisp 100% solid interior cavity & 100% solid outer lapels; anti-alias only the 1px rim
      if (cavityMask[idx]) {
        cavityAlpha[idx] = sum >= 12 ? 255 : Math.round((sum / 16) * 255);
      } else {
        cavityAlpha[idx] = sum >= 6 ? Math.round((sum / 16) * 255) : 0;
      }
    }
  }

  return { cavityMask, cavityAlpha, cavityPixels, vApexY };
}

function alphaOverPixel(
  dst: Uint8ClampedArray,
  dstOff: number,
  sr: number,
  sg: number,
  sb: number,
  saByte: number
): void {
  if (saByte <= 0) return;
  const sa = saByte / 255;
  const da = dst[dstOff + 3] / 255;
  if (da <= 0.001 || sa >= 0.999) {
    dst[dstOff] = sr;
    dst[dstOff + 1] = sg;
    dst[dstOff + 2] = sb;
    dst[dstOff + 3] = saByte;
    return;
  }
  const outA = sa + da * (1 - sa);
  const invOutA = outA > 0 ? 1 / outA : 0;
  dst[dstOff] = Math.round((sr * sa + dst[dstOff] * da * (1 - sa)) * invOutA);
  dst[dstOff + 1] = Math.round(
    (sg * sa + dst[dstOff + 1] * da * (1 - sa)) * invOutA
  );
  dst[dstOff + 2] = Math.round(
    (sb * sa + dst[dstOff + 2] * da * (1 - sa)) * invOutA
  );
  dst[dstOff + 3] = Math.round(clamp(outA * 255, 0, 255));
}

function darkenPixel(
  dst: Uint8ClampedArray,
  dstOff: number,
  shadowOpacity: number
): void {
  if (shadowOpacity <= 0.002 || dst[dstOff + 3] < 8) return;
  const factor = 1 - clamp(shadowOpacity, 0, 0.65);
  dst[dstOff] = Math.round(dst[dstOff] * factor);
  dst[dstOff + 1] = Math.round(dst[dstOff + 1] * factor);
  dst[dstOff + 2] = Math.round(dst[dstOff + 2] * factor);
}

/**
 * Pure RGBA synthesizer for layered `Top` + `Outerwear` flat-lays:
 *
 * - **`open-front`** (Unzipped): Splits zipped jackets along their center zipper axis,
 *   parts left & right front panels outward (`~19%` center gap with zero sleeve warping
 *   and natural slight hem A-drape), replaces dark ghost-mannequin collar lining with
 *   the tee's crewneck, casts soft lapel/front-edge shadows ONLY below actual fabric
 *   panel edges, and reveals a full vertical shirt strip from collar to hem.
 * - **`collar-hem-peek`** (Zipped): Keeps the jacket zipped, replaces dark interior
 *   collar lining with the tee crewneck + lapel shadows, and reveals ~8.5% of the full-
 *   width stitched tee hem peeking cleanly beneath the jacket waist belt.
 * - **`collar-only`** (Tucked): Replaces the dark interior collar lining with the tee
 *   crewneck while keeping the shirt hem neatly tucked behind the jacket waist.
 */
export function synthesizeLayeredOuterwearRgba(
  topSrc: RgbaBuffer,
  outerwearSrc: RgbaBuffer,
  options: LayeredOuterwearOptions
): LayeredOuterwearResult {
  const maxWidth = clamp(Math.round(options.maxWidth ?? 768), 160, 1200);
  const style = options.style;

  // 1. Scale outerwear to working resolution
  const outerScale = Math.min(1, maxWidth / Math.max(1, outerwearSrc.width));
  const ow = Math.max(48, Math.round(outerwearSrc.width * outerScale));
  const oh = Math.max(48, Math.round(outerwearSrc.height * outerScale));
  const outer = resampleRgba(outerwearSrc, ow, oh);

  const geom = analyzeOuterwearStructure(outer);
  const collar = detectCollarInteriorMask(outer, geom);

  // 2. Panel split geometry for `open-front` mode (~19% center opening)
  const shouldSplitOpen = style === "open-front" && !geom.alreadyOpenFront;
  const halfGap = shouldSplitOpen
    ? Math.max(8, Math.round(geom.torsoWidth * 0.095))
    : 0;
  const openGapPx = halfGap * 2;

  // 3. Hem peek height below the jacket's central waist belt/hem
  const hemPeekPx =
    style === "collar-only" || options.suppressHemPeek
      ? 0
      : style === "collar-hem-peek"
        ? Math.max(8, Math.round(geom.torsoBottomY * 0.088))
        : Math.max(7, Math.round(geom.torsoBottomY * 0.075));

  const teeBottomY =
    hemPeekPx > 0
      ? geom.torsoBottomY + hemPeekPx
      : Math.max(geom.collarRimY + 12, geom.torsoBottomY - 2);

  const canvasW = ow + openGapPx;
  const canvasH = Math.max(oh, teeBottomY + 2);
  const out = new Uint8ClampedArray(canvasW * canvasH * 4);

  // 4. Scale & align inner Top so its torso matches the jacket's full waist width
  // and its crewneck sits naturally inside the V-neck while its bottom hem hits `teeBottomY`.
  const topMetrics = measureInnerTopTorsoBounds(topSrc);
  const targetTeeTorsoW = Math.max(
    24,
    Math.round(geom.torsoWidth * 1.02 + openGapPx * 0.68)
  );
  const teeScaleX = targetTeeTorsoW / Math.max(1, topMetrics.torsoWidth);
  const scaledTopW = Math.max(24, Math.round(topSrc.width * teeScaleX));

  const teeNeckTargetY = Math.max(
    geom.collarRimY,
    geom.collarRimY + Math.round(oh * 0.015)
  );
  const desiredTeeHeight = Math.max(
    32,
    teeBottomY - teeNeckTargetY + Math.round(topMetrics.collarTopY * teeScaleX)
  );
  const scaledTop = resampleRgba(topSrc, scaledTopW, desiredTeeHeight);

  const teeCenterOutX = geom.splitX + halfGap;
  const scaledTopTorsoCenter =
    (topMetrics.torsoLeft + topMetrics.torsoRight) * 0.5 * teeScaleX;
  const topOffsetX = Math.round(teeCenterOutX - scaledTopTorsoCenter);
  const topOffsetY = Math.round(
    teeNeckTargetY - topMetrics.collarTopY * teeScaleX
  );

  // 5. Back layer (open-front only): smoothly bridge the curved back-collar rim behind the tee
  if (shouldSplitOpen) {
    const bridgeL = Math.max(
      0,
      geom.centerX - Math.round(geom.torsoWidth * 0.27)
    );
    const bridgeR = Math.min(
      ow - 1,
      geom.centerX + Math.round(geom.torsoWidth * 0.27)
    );
    const dstBridgeL = bridgeL;
    const dstBridgeR = bridgeR + openGapPx;
    const dstSpan = Math.max(1, dstBridgeR - dstBridgeL);
    const srcSpan = Math.max(1, bridgeR - bridgeL);

    for (let x = dstBridgeL; x <= dstBridgeR; x++) {
      const u = (x - dstBridgeL) / dstSpan;
      const sx = clamp(Math.round(bridgeL + u * srcSpan), 0, ow - 1);
      const rimEndY = Math.min(oh - 1, (geom.colRimY[sx] ?? geom.collarRimY) + 2);
      for (let y = geom.collarTopY; y <= rimEndY; y++) {
        const sOff = (y * ow + sx) * 4;
        if (outer.rgba[sOff + 3] < 20) continue;
        alphaOverPixel(
          out,
          (y * canvasW + x) * 4,
          Math.round(outer.rgba[sOff] * 0.86),
          Math.round(outer.rgba[sOff + 1] * 0.86),
          Math.round(outer.rgba[sOff + 2] * 0.86),
          outer.rgba[sOff + 3]
        );
      }
    }
  }

  // 6. Middle layer: paint inner Top clipped strictly to the jacket's full torso width
  // (preventing wide boxy short sleeves from poking out through transparent armpit gaps,
  // while keeping the peeking bottom hem FULL waist width beneath the jacket belt!).
  const clipLeftArr = new Float32Array(canvasH);
  const clipRightArr = new Float32Array(canvasH);
  const waistZoneStartY = Math.max(
    geom.collarRimY + 12,
    geom.torsoBottomY - Math.round(oh * 0.08)
  );
  const hemInset = Math.max(2, Math.round(geom.torsoWidth * 0.035));

  for (let y = 0; y < canvasH; y++) {
    let cl: number;
    let cr: number;
    if (y >= waistZoneStartY) {
      // Full-waist tailored hem width beneath the jacket belt (ignores narrow belt-buckle dips!)
      cl = geom.torsoLeft + hemInset;
      cr = geom.torsoRight + openGapPx - hemInset;
    } else {
      const refY = clamp(y, 0, oh - 1);
      cl = Math.max(geom.torsoLeft, geom.rowTorsoLeft[refY]);
      cr = Math.min(
        geom.torsoRight + openGapPx,
        geom.rowTorsoRight[refY] + openGapPx
      );
      if (y < geom.collarRimY + Math.round(oh * 0.12)) {
        const maxNeckHalf = geom.torsoWidth * 0.34 + halfGap;
        cl = Math.max(cl, teeCenterOutX - maxNeckHalf);
        cr = Math.min(cr, teeCenterOutX + maxNeckHalf);
      }
    }
    clipLeftArr[y] = cl;
    clipRightArr[y] = cr;
  }

  for (let y = 0; y < canvasH; y++) {
    if (y > teeBottomY) break;
    const sy = y - topOffsetY;
    if (sy < 0 || sy >= scaledTop.height) continue;

    const cl = clipLeftArr[y];
    const cr = clipRightArr[y];
    const xStart = Math.max(0, Math.floor(cl));
    const xEnd = Math.min(canvasW - 1, Math.ceil(cr));
    const dstRow = y * canvasW;
    const srcRow = sy * scaledTop.width;

    for (let x = xStart; x <= xEnd; x++) {
      const sx = x - topOffsetX;
      if (sx < 0 || sx >= scaledTop.width) continue;
      const sOff = (srcRow + sx) * 4;
      const sa = scaledTop.rgba[sOff + 3];
      if (sa < 8) continue;

      const edgeDist = Math.min(x - cl, cr - x);
      const clipFactor = edgeDist < 2 ? clamp(edgeDist / 2, 0, 1) : 1;
      const finalA = Math.round(sa * clipFactor);
      if (finalA < 8) continue;

      alphaOverPixel(
        out,
        (dstRow + x) * 4,
        scaledTop.rgba[sOff],
        scaledTop.rgba[sOff + 1],
        scaledTop.rgba[sOff + 2],
        finalA
      );
    }
  }

  // 7. Build anti-aliased jacket alpha mask (subtracting smooth `collar.cavityAlpha`)
  // and subtle open-front natural A-drape bevel below `vApexY`.
  const jacketAlpha = new Uint8Array(ow * oh);
  const leftOpenCutX = new Int32Array(oh).fill(-1);
  const rightOpenCutX = new Int32Array(oh).fill(-1);

  for (let y = 0; y < oh; y++) {
    const row = y * ow;
    // Continuous sub-pixel outward A-drape flare from vApexY to waist hem (zero 1px stair-stepping)
    const drapeExtraF =
      shouldSplitOpen && y >= collar.vApexY
        ? clamp(
            (y - collar.vApexY) /
              Math.max(1, geom.torsoBottomY - collar.vApexY),
            0,
            1
          ) * Math.max(1.0, geom.torsoWidth * 0.03)
        : 0;

    const cutLF = geom.splitX - 1 - drapeExtraF;
    const cutRF = geom.splitX + drapeExtraF;
    const cutL = Math.floor(cutLF);
    const cutR = Math.ceil(cutRF);

    for (let x = 0; x < ow; x++) {
      const idx = row + x;
      const origA = outer.rgba[idx * 4 + 3];
      if (origA < 8) continue;

      let drapeEdgeCoverage = 1;
      if (shouldSplitOpen && y >= collar.vApexY) {
        if (x > cutLF + 0.5 && x < cutRF - 0.5) {
          continue;
        }
        if (x >= cutLF - 0.5 && x <= cutLF + 0.5) {
          drapeEdgeCoverage = clamp(cutLF + 0.5 - x, 0, 1);
        } else if (x >= cutRF - 0.5 && x <= cutRF + 0.5) {
          drapeEdgeCoverage = clamp(x - (cutRF - 0.5), 0, 1);
        }
        if (drapeEdgeCoverage <= 0.02) continue;
      }

      const cavA = collar.cavityAlpha[idx];
      if (cavA >= 250) continue;

      const baseA =
        cavA > 0 ? Math.round((origA * (255 - cavA)) / 255) : origA;
      jacketAlpha[idx] = Math.round(baseA * drapeEdgeCoverage);
    }

    if (shouldSplitOpen && y >= collar.vApexY - 2 && y <= geom.torsoBottomY + 4) {
      if (cutL >= 0 && cutL < ow && jacketAlpha[row + cutL] >= 30) {
        leftOpenCutX[y] = cutL;
      }
      if (cutR >= 0 && cutR < ow && jacketAlpha[row + cutR] >= 30) {
        rightOpenCutX[y] = cutR;
      }
    }
  }

  // 8. Cast realistic ambient-occlusion shadows strictly adjacent to REAL jacket fabric edges:
  //    (a) Open-front parted panel shadows ONLY on rows where the parted front panel exists
  //        (never cutting vertical stripes through the V-neck collar opening!)
  //    (b) Collar lapel shadows along the smooth V-neck opening
  //    (c) Waist-hem downward shadow following the actual curved belt/hem row per column
  const shadowSpanX = Math.max(5, Math.min(11, Math.round(geom.torsoWidth * 0.045)));

  if (shouldSplitOpen) {
    for (let y = collar.vApexY; y <= Math.min(canvasH - 1, geom.torsoBottomY + 2); y++) {
      const row = y * canvasW;
      const lCut = leftOpenCutX[y];
      const rCut = rightOpenCutX[y];
      const lOutEdge = lCut !== -1 ? lCut : -1;
      const rOutEdge = rCut !== -1 ? rCut + openGapPx : -1;

      if (lOutEdge !== -1) {
        for (let d = 1; d <= shadowSpanX; d++) {
          const lx = lOutEdge + d;
          if (lx >= canvasW || (rOutEdge !== -1 && lx >= rOutEdge)) break;
          const t = 1 - d / (shadowSpanX + 1);
          darkenPixel(out, (row + lx) * 4, 0.22 * t * t);
        }
      }
      if (rOutEdge !== -1) {
        for (let d = 1; d <= shadowSpanX; d++) {
          const rx = rOutEdge - d;
          if (rx < 0 || (lOutEdge !== -1 && rx <= lOutEdge)) break;
          const t = 1 - d / (shadowSpanX + 1);
          darkenPixel(out, (row + rx) * 4, 0.22 * t * t);
        }
      }
    }
  }

  // Collar lapel cast shadow smoothly hugging the V-neck edges
  const collarShadowPx = Math.max(4, Math.min(9, Math.round(geom.torsoWidth * 0.035)));
  for (let y = geom.collarRimY; y <= Math.min(oh - 1, collar.vApexY + 2); y++) {
    const srcRow = y * ow;
    const dstRow = y * canvasW;
    let cavL = -1;
    let cavR = -1;
    for (let x = 0; x < ow; x++) {
      if (collar.cavityMask[srcRow + x]) {
        if (cavL === -1) cavL = x;
        cavR = x;
      }
    }
    if (cavL === -1 || cavR <= cavL) continue;
    for (let d = 0; d < collarShadowPx; d++) {
      const t = 1 - d / collarShadowPx;
      const opacity = 0.2 * t * t;
      const lxOut = cavL + d;
      if (lxOut >= 0 && lxOut < canvasW) {
        darkenPixel(out, (dstRow + lxOut) * 4, opacity);
      }
      const rxOut = cavR + openGapPx - d;
      if (rxOut >= 0 && rxOut < canvasW) {
        darkenPixel(out, (dstRow + rxOut) * 4, opacity);
      }
    }
  }

  // Downward waist-hem cast shadow beneath the jacket belt onto the full-width peeking white tee
  if (hemPeekPx > 0) {
    const hemShadowH = Math.max(4, Math.min(10, Math.round(hemPeekPx * 0.38)));
    for (let x = geom.torsoLeft; x <= geom.torsoRight; x++) {
      const isRightHalf = x >= geom.splitX;
      const dstX = shouldSplitOpen && isRightHalf ? x + openGapPx : x;
      if (dstX < 0 || dstX >= canvasW) continue;
      const baseHemY = geom.colWaistBottomY[x] ?? geom.torsoBottomY;
      for (let dy = 0; dy < hemShadowH; dy++) {
        const y = baseHemY + dy;
        if (y >= canvasH) break;
        const ny = dy / Math.max(1, hemShadowH);
        darkenPixel(out, (y * canvasW + dstX) * 4, 0.22 * (1 - ny) * (1 - ny));
      }
    }
  }

  // 9. Front layer: composite outerwear panels cleanly over the inner tee
  for (let y = 0; y < oh; y++) {
    const srcRow = y * ow;
    const dstRow = y * canvasW;
    const lCut = leftOpenCutX[y];
    const rCut = rightOpenCutX[y];

    for (let x = 0; x < ow; x++) {
      const idx = srcRow + x;
      const ja = jacketAlpha[idx];
      if (ja < 8) continue;

      const isRightHalf = x >= geom.splitX;
      const dstX = shouldSplitOpen && isRightHalf ? x + openGapPx : x;
      if (dstX < 0 || dstX >= canvasW) continue;

      const sOff = idx * 4;
      let r = outer.rgba[sOff];
      let g = outer.rgba[sOff + 1];
      let b = outer.rgba[sOff + 2];
      let a = ja;

      // Subtle 3D thickness & anti-aliased edge strictly on the parted open-front lapel cut
      if (shouldSplitOpen && y >= collar.vApexY) {
        const distFromCut = isRightHalf
          ? rCut !== -1
            ? x - rCut
            : 99
          : lCut !== -1
            ? lCut - x
            : 99;
        if (distFromCut === 0) {
          r = Math.round(r * 0.8);
          g = Math.round(g * 0.8);
          b = Math.round(b * 0.8);
          a = Math.round(a * 0.9);
        } else if (distFromCut === 1) {
          r = Math.round(r * 0.9);
          g = Math.round(g * 0.9);
          b = Math.round(b * 0.9);
        }
      }

      alphaOverPixel(out, (dstRow + dstX) * 4, r, g, b, a);
    }
  }

  return {
    rgba: out,
    width: canvasW,
    height: canvasH,
    style,
    wasAlreadyOpenFront: geom.alreadyOpenFront,
    openGapPx,
    collarCavityPixels: collar.cavityPixels,
    hemPeekPx,
  };
}
