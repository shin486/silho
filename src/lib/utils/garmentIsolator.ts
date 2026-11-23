import type { WardrobeCategory } from "@/lib/categories";

/**
 * Exact 18-class ATR semantic label indices from `Xenova/segformer_b2_clothes`
 * (`mattmdjaga/segformer_b2_clothes`).
 */
export const ATR_LABELS = {
  BACKGROUND: 0,
  HAT: 1,
  HAIR: 2,
  SUNGLASSES: 3,
  UPPER_CLOTHES: 4,
  SKIRT: 5,
  PANTS: 6,
  DRESS: 7,
  BELT: 8,
  LEFT_SHOE: 9,
  RIGHT_SHOE: 10,
  FACE: 11,
  LEFT_LEG: 12,
  RIGHT_LEG: 13,
  LEFT_ARM: 14,
  RIGHT_ARM: 15,
  BAG: 16,
  SCARF: 17,
} as const;

export type AtrLabelId = (typeof ATR_LABELS)[keyof typeof ATR_LABELS];

export const ATR_NUM_CLASSES = 18;

const HUMAN_BODY_LABELS: readonly number[] = [
  ATR_LABELS.HAIR,
  ATR_LABELS.FACE,
  ATR_LABELS.LEFT_LEG,
  ATR_LABELS.RIGHT_LEG,
  ATR_LABELS.LEFT_ARM,
  ATR_LABELS.RIGHT_ARM,
];

const ARM_HAND_LABELS: readonly number[] = [
  ATR_LABELS.LEFT_ARM,
  ATR_LABELS.RIGHT_ARM,
];

const SHOE_LABELS: readonly number[] = [
  ATR_LABELS.LEFT_SHOE,
  ATR_LABELS.RIGHT_SHOE,
];

const ACCESSORY_LABELS: readonly number[] = [
  ATR_LABELS.HAT,
  ATR_LABELS.SUNGLASSES,
  ATR_LABELS.BELT,
  ATR_LABELS.BAG,
  ATR_LABELS.SCARF,
];

const ALL_WEARABLE_LABELS: readonly number[] = [
  ATR_LABELS.UPPER_CLOTHES,
  ATR_LABELS.SKIRT,
  ATR_LABELS.PANTS,
  ATR_LABELS.DRESS,
  ATR_LABELS.LEFT_SHOE,
  ATR_LABELS.RIGHT_SHOE,
  ...ACCESSORY_LABELS,
];

export interface SemanticParseMap {
  /** Low-res semantic grid width (typically 128 for SegFormer-B2 512x512). */
  width: number;
  /** Low-res semantic grid height (typically 128 for SegFormer-B2 512x512). */
  height: number;
  /** Number of semantic classes (18 for ATR SegFormer-B2-Clothes). */
  numClasses: number;
  /**
   * Quantized softmax probabilities [0..255] in CHW layout:
   * `probs[classId * width * height + y * width + x]`
   */
  probs: Uint8Array;
  /** Argmax class index [0..17] per semantic cell (`width * height`). */
  labels: Uint8Array;
}

export interface ForegroundSemanticSummary {
  foregroundPixels: number;
  humanRatio: number;
  hasHumanOrOtherClothes: boolean;
  categoryCoverage: Record<WardrobeCategory, number>;
  detectedCategories: WardrobeCategory[];
}

export interface IsolatedGarmentResult {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  /**
   * Top-left origin of the output canvas inside the full source image coordinate space,
   * so manual Restore brush strokes map pixel-exactly back to `sourceRgba`.
   */
  cropOriginX: number;
  cropOriginY: number;
  /** True when category-only isolation actually stripped non-target regions. */
  isolated: boolean;
  /** True when category isolation was requested but no target region existed in the photo. */
  targetMissing: boolean;
  /** Number of small occlusion pixels inpainted (e.g., thumb on waistband). */
  inpaintedPixels: number;
  /** Elapsed processing time in milliseconds. */
  elapsedMs: number;
}

export interface IsolateGarmentOptions {
  /** Source RGBA buffer (normalized RGB with @imgly foreground alpha). */
  sourceRgba: Uint8ClampedArray;
  width: number;
  height: number;
  /** Cached semantic map from SegFormer-B2-Clothes (optional when in "full" mode). */
  semanticMap: SemanticParseMap | null;
  category: WardrobeCategory;
  mode: "category" | "full";
  /** Editorial transparent margin ratio around the tight bounding box (default 0.06 = 6%). */
  editorialPaddingRatio?: number;
}

const MAX_INPAINT_BBOX_FRACTION = 0.04;
const FG_ALPHA_MIN = 8;
const FG_ALPHA_SOLID = 40;
const BBOX_ALPHA_THRESHOLD = 12;
const GAUSS_5_WEIGHTS = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136] as const;

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Returns the strict ATR semantic label indices for a SILHO wardrobe category.
 *
 * - `top`: `Upper-clothes` (with `Dress` fallback only if `Upper-clothes` is absent)
 * - `bottom`: `Pants` + `Skirt`
 * - `outerwear`: `Upper-clothes` (+ `Dress` for long coats/trenches)
 * - `shoes`: `Left-shoe` + `Right-shoe`
 * - `accessory`: `Bag`, `Hat`, `Belt`, `Scarf`, `Sunglasses`
 */
export function getCategoryTargetLabels(
  category: WardrobeCategory,
  classCoverage?: Float32Array
): number[] {
  switch (category) {
    case "top": {
      const upperCov = classCoverage?.[ATR_LABELS.UPPER_CLOTHES] ?? 1;
      const dressCov = classCoverage?.[ATR_LABELS.DRESS] ?? 0;
      if (upperCov < 0.008 && dressCov >= 0.03) {
        return [ATR_LABELS.DRESS];
      }
      return [ATR_LABELS.UPPER_CLOTHES];
    }
    case "bottom":
      return [ATR_LABELS.PANTS, ATR_LABELS.SKIRT];
    case "outerwear": {
      // Preserve sewn-in waist belts on belted moto jackets and trench coats
      // whenever an upper/coat region is present (without treating standalone belts as outerwear).
      const upperAndDressCov =
        (classCoverage?.[ATR_LABELS.UPPER_CLOTHES] ?? 1) +
        (classCoverage?.[ATR_LABELS.DRESS] ?? 0);
      return upperAndDressCov >= 0.05
        ? [ATR_LABELS.UPPER_CLOTHES, ATR_LABELS.DRESS, ATR_LABELS.BELT]
        : [ATR_LABELS.UPPER_CLOTHES, ATR_LABELS.DRESS];
    }
    case "shoes":
      return [ATR_LABELS.LEFT_SHOE, ATR_LABELS.RIGHT_SHOE];
    case "accessory":
      return [...ACCESSORY_LABELS];
  }
}

/**
 * Computes per-class semantic coverage strictly inside the foreground silhouette
 * so the UI knows whether a human or multiple garments are present (auto-enabling
 * "Isolate [Category] Only" by default on model/outfit shots, while keeping pure
 * single-piece flat-lays untouched in "Full Subject" mode).
 */
export function analyzeForegroundSemantics(
  sourceRgba: Uint8ClampedArray,
  width: number,
  height: number,
  semanticMap: SemanticParseMap
): ForegroundSemanticSummary {
  const gw = semanticMap.width;
  const gh = semanticMap.height;
  const labels = semanticMap.labels;

  // Subsample stride for ultra-fast (<2ms) foreground inspection
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 240));
  const classCounts = new Float32Array(ATR_NUM_CLASSES);
  let fgCount = 0;

  for (let y = 0; y < height; y += stride) {
    const gy = Math.min(gh - 1, Math.floor(((y + 0.5) * gh) / height));
    const gRow = gy * gw;
    const rowOff = y * width;
    for (let x = 0; x < width; x += stride) {
      if (sourceRgba[(rowOff + x) * 4 + 3] < FG_ALPHA_SOLID) continue;
      fgCount++;
      const gx = Math.min(gw - 1, Math.floor(((x + 0.5) * gw) / width));
      const cls = labels[gRow + gx];
      if (cls < ATR_NUM_CLASSES) {
        classCounts[cls] += 1;
      }
    }
  }

  const denom = Math.max(1, fgCount);
  const classCoverage = new Float32Array(ATR_NUM_CLASSES);
  for (let c = 0; c < ATR_NUM_CLASSES; c++) {
    classCoverage[c] = classCounts[c] / denom;
  }

  let humanRatio = 0;
  for (const c of HUMAN_BODY_LABELS) {
    humanRatio += classCoverage[c];
  }

  const categoryCoverage: Record<WardrobeCategory, number> = {
    top: classCoverage[ATR_LABELS.UPPER_CLOTHES],
    bottom: classCoverage[ATR_LABELS.PANTS] + classCoverage[ATR_LABELS.SKIRT],
    outerwear:
      classCoverage[ATR_LABELS.UPPER_CLOTHES] + classCoverage[ATR_LABELS.DRESS],
    shoes:
      classCoverage[ATR_LABELS.LEFT_SHOE] +
      classCoverage[ATR_LABELS.RIGHT_SHOE],
    accessory: ACCESSORY_LABELS.reduce(
      (sum, c) => sum + classCoverage[c],
      0
    ),
  };

  // Count distinct MAJOR body garment zones present (excluding sewn-in accessories like belts
  // on moto jackets/trench coats or glossy leather pockets misclassified as bags, which cause
  // false-positive multi-garment splits on single-piece flat-lays).
  const upperGroupCov =
    classCoverage[ATR_LABELS.UPPER_CLOTHES] + classCoverage[ATR_LABELS.DRESS];
  const bottomGroupCov = categoryCoverage.bottom;
  const shoesGroupCov = categoryCoverage.shoes;

  let distinctMajorGarments = 0;
  if (upperGroupCov >= 0.07) distinctMajorGarments++;
  if (bottomGroupCov >= 0.07) distinctMajorGarments++;
  if (shoesGroupCov >= 0.025) distinctMajorGarments++;

  // Require clear human presence (>= 6% body/head/limb coverage inside foreground) OR >= 2
  // major body garments (e.g. tee + jeans or jeans + sneakers) so 1-3% SegFormer false
  // positives on glossy leather jackets / ghost-mannequin flat-lays stay in Full Subject mode.
  const hasHumanOrOtherClothes =
    humanRatio >= 0.06 || distinctMajorGarments >= 2;

  const detectedCategories = (
    ["top", "bottom", "outerwear", "shoes", "accessory"] as WardrobeCategory[]
  ).filter((cat) => categoryCoverage[cat] >= 0.012);

  return {
    foregroundPixels: fgCount * stride * stride,
    humanRatio,
    hasHumanOrOtherClothes,
    categoryCoverage,
    detectedCategories,
  };
}

function buildDiskOffsets(radius: number): Int32Array {
  const pts: number[] = [];
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        pts.push(dx, dy);
      }
    }
  }
  return new Int32Array(pts);
}

const DISK_R1 = buildDiskOffsets(1);
const DISK_R2 = buildDiskOffsets(2);

function dilateBinaryMask(
  src: Uint8Array,
  w: number,
  h: number,
  disk: Int32Array
): Uint8Array {
  const dst = new Uint8Array(w * h);
  const count = disk.length;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (src[row + x] === 0) continue;
      for (let k = 0; k < count; k += 2) {
        const nx = x + disk[k];
        const ny = y + disk[k + 1];
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
          dst[ny * w + nx] = 1;
        }
      }
    }
  }
  return dst;
}

/**
 * Reclaims solid foreground garment pixels where SegFormer dropped out to `Background (0)`
 * (e.g. glossy burgundy/black leather jacket sleeve creases, dark zippers, or metallic belt
 * buckles) strictly when each connected dropout component borders `targetMask` cleanly and
 * is NOT bounded primarily by non-target garment/skin/shoe occluder walls.
 */
function reclaimForegroundBgDropouts(
  targetMask: Uint8Array,
  bgDropoutCandidate: Uint8Array,
  dilatedHardOcc: Uint8Array,
  dilatedSoftNonTarget: Uint8Array,
  w: number,
  h: number
): void {
  const total = w * h;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);

  for (let i = 0; i < total; i++) {
    if (
      !bgDropoutCandidate[i] ||
      visited[i] ||
      targetMask[i] ||
      dilatedHardOcc[i] ||
      dilatedSoftNonTarget[i]
    ) {
      continue;
    }

    let head = 0;
    let tail = 0;
    visited[i] = 1;
    queue[tail++] = i;

    let touchTarget = 0;
    let touchNonTarget = 0;

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur - cx) / w;

      const checkNeighbor = (nIdx: number) => {
        if (targetMask[nIdx]) {
          touchTarget++;
          return;
        }
        if (dilatedHardOcc[nIdx] || dilatedSoftNonTarget[nIdx]) {
          touchNonTarget++;
          return;
        }
        if (bgDropoutCandidate[nIdx] && !visited[nIdx]) {
          visited[nIdx] = 1;
          queue[tail++] = nIdx;
        }
      };

      if (cx > 0) checkNeighbor(cur - 1);
      if (cx < w - 1) checkNeighbor(cur + 1);
      if (cy > 0) checkNeighbor(cur - w);
      if (cy < h - 1) checkNeighbor(cur + w);
    }

    if (touchTarget > 0 && touchTarget >= touchNonTarget * 2.5) {
      for (let k = 0; k < tail; k++) {
        targetMask[queue[k]] = 1;
      }
    }
  }
}

/**
 * Filters tiny disconnected noise islands while preserving main garment parts
 * (e.g., both pant legs or both shoes).
 */
function keepSignificantComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  minFractionOfLargest: number,
  minAbsolutePixels: number
): void {
  const total = w * h;
  const compId = new Int32Array(total);
  const queue = new Int32Array(total);
  const compSizes: number[] = [0]; // 1-indexed
  let nextId = 0;

  for (let i = 0; i < total; i++) {
    if (mask[i] === 0 || compId[i] !== 0) continue;
    nextId++;
    let head = 0;
    let tail = 0;
    compId[i] = nextId;
    queue[tail++] = i;

    while (head < tail) {
      const cur = queue[head++];
      const cx = cur % w;
      const cy = (cur - cx) / w;
      if (cx > 0 && mask[cur - 1] && !compId[cur - 1]) {
        compId[cur - 1] = nextId;
        queue[tail++] = cur - 1;
      }
      if (cx < w - 1 && mask[cur + 1] && !compId[cur + 1]) {
        compId[cur + 1] = nextId;
        queue[tail++] = cur + 1;
      }
      if (cy > 0 && mask[cur - w] && !compId[cur - w]) {
        compId[cur - w] = nextId;
        queue[tail++] = cur - w;
      }
      if (cy < h - 1 && mask[cur + w] && !compId[cur + w]) {
        compId[cur + w] = nextId;
        queue[tail++] = cur + w;
      }
    }
    compSizes.push(tail);
  }

  if (nextId === 0) return;

  let maxSize = 0;
  for (let id = 1; id <= nextId; id++) {
    if (compSizes[id] > maxSize) maxSize = compSizes[id];
  }

  const keepThreshold = Math.max(
    minAbsolutePixels,
    Math.floor(maxSize * minFractionOfLargest)
  );
  const keep = new Uint8Array(nextId + 1);
  for (let id = 1; id <= nextId; id++) {
    if (compSizes[id] >= keepThreshold) {
      keep[id] = 1;
    }
  }

  for (let i = 0; i < total; i++) {
    const id = compId[i];
    if (id !== 0 && keep[id] === 0) {
      mask[i] = 0;
    }
  }
}

/**
 * Detects:
 *  1) Enclosed interior holes inside `targetMask` smaller than 4% of the garment bbox.
 *  2) Small concave occlusion notches carved strictly by `hardOccluderMask` (e.g. a thumb/hand
 *     hooking the top waistband or fingers over a pocket) that sit bridged between garment
 *     pixels on both sides and stay strictly under 4% of the garment bbox.
 *
 * Returns a binary mask (`1` = pixel to inpaint) and the total count of inpaint pixels.
 */
function findSmallOcclusionHoles(
  targetMask: Uint8Array,
  hardOccluderMask: Uint8Array,
  w: number,
  h: number
): { inpaintMask: Uint8Array; inpaintCount: number } {
  const total = w * h;
  const inpaintMask = new Uint8Array(total);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (targetMask[row + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return { inpaintMask, inpaintCount: 0 };
  }

  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  const bboxArea = bboxW * bboxH;
  const maxHoleArea = Math.max(16, Math.floor(bboxArea * MAX_INPAINT_BBOX_FRACTION));

  // Step 1: Exterior flood-fill on `targetMask === 0` to find true interior holes
  const exterior = new Uint8Array(total);
  const queue = new Int32Array(total);
  let qHead = 0;
  let qTail = 0;

  const seedExt = (idx: number) => {
    if (exterior[idx] || targetMask[idx]) return;
    exterior[idx] = 1;
    queue[qTail++] = idx;
  };

  for (let x = 0; x < w; x++) {
    seedExt(x);
    seedExt((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    seedExt(y * w);
    seedExt(y * w + (w - 1));
  }

  while (qHead < qTail) {
    const cur = queue[qHead++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    if (cx > 0) seedExt(cur - 1);
    if (cx < w - 1) seedExt(cur + 1);
    if (cy > 0) seedExt(cur - w);
    if (cy < h - 1) seedExt(cur + w);
  }

  const candidateHoles = new Uint8Array(total);
  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const idx = row + x;
      if (!targetMask[idx] && !exterior[idx]) {
        candidateHoles[idx] = 1;
      }
    }
  }

  // Step 2: Bridge small concave Arm/Hand & Shoe notches strictly inside `hardOccluderMask`
  // (e.g., thumb hooking into a jeans waistband or wrist crossing a cuff edge).
  const maxBridgeX = Math.max(6, Math.min(56, Math.round(bboxW * 0.18)));
  const maxBridgeY = Math.max(6, Math.min(44, Math.round(bboxH * 0.08)));

  // Horizontal bridge across short hand/shoe gaps flanked by garment pixels on both sides
  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    let lastGarmentX = -1;
    for (let x = minX; x <= maxX; x++) {
      if (targetMask[row + x]) {
        if (lastGarmentX !== -1 && x - lastGarmentX > 1) {
          const gap = x - lastGarmentX - 1;
          if (gap <= maxBridgeX) {
            let allOccluder = true;
            for (let gx = lastGarmentX + 1; gx < x; gx++) {
              if (!hardOccluderMask[row + gx]) {
                allOccluder = false;
                break;
              }
            }
            if (allOccluder) {
              for (let gx = lastGarmentX + 1; gx < x; gx++) {
                candidateHoles[row + gx] = 1;
              }
            }
          }
        }
        lastGarmentX = x;
      }
    }
  }

  // Vertical bridge across short hand/shoe gaps flanked by garment pixels above and below
  for (let x = minX; x <= maxX; x++) {
    let lastGarmentY = -1;
    for (let y = minY; y <= maxY; y++) {
      if (targetMask[y * w + x]) {
        if (lastGarmentY !== -1 && y - lastGarmentY > 1) {
          const gap = y - lastGarmentY - 1;
          if (gap <= maxBridgeY) {
            let allOccluder = true;
            for (let gy = lastGarmentY + 1; gy < y; gy++) {
              if (!hardOccluderMask[gy * w + x]) {
                allOccluder = false;
                break;
              }
            }
            if (allOccluder) {
              for (let gy = lastGarmentY + 1; gy < y; gy++) {
                candidateHoles[gy * w + x] = 1;
              }
            }
          }
        }
        lastGarmentY = y;
      }
    }
  }

  // Step 3: Filter candidate hole components strictly to area < 4% of garment bbox
  const visited = new Uint8Array(total);
  let inpaintCount = 0;

  for (let y = minY; y <= maxY; y++) {
    const row = y * w;
    for (let x = minX; x <= maxX; x++) {
      const startIdx = row + x;
      if (!candidateHoles[startIdx] || visited[startIdx]) continue;

      let head = 0;
      let tail = 0;
      visited[startIdx] = 1;
      queue[tail++] = startIdx;

      while (head < tail) {
        const cur = queue[head++];
        const cx = cur % w;
        const cy = (cur - cx) / w;
        if (cx > minX && candidateHoles[cur - 1] && !visited[cur - 1]) {
          visited[cur - 1] = 1;
          queue[tail++] = cur - 1;
        }
        if (cx < maxX && candidateHoles[cur + 1] && !visited[cur + 1]) {
          visited[cur + 1] = 1;
          queue[tail++] = cur + 1;
        }
        if (cy > minY && candidateHoles[cur - w] && !visited[cur - w]) {
          visited[cur - w] = 1;
          queue[tail++] = cur - w;
        }
        if (cy < maxY && candidateHoles[cur + w] && !visited[cur + w]) {
          visited[cur + w] = 1;
          queue[tail++] = cur + w;
        }
      }

      if (tail <= maxHoleArea && inpaintCount + tail <= maxHoleArea * 2) {
        for (let k = 0; k < tail; k++) {
          inpaintMask[queue[k]] = 1;
        }
        inpaintCount += tail;
      }
    }
  }

  return { inpaintMask, inpaintCount };
}

/**
 * Lightweight Telea-inspired inward marching + harmonic diffusion inpainter:
 * fills small occlusion holes (`< 4%` bbox) using surrounding garment pixels so
 * waistbands, pockets, and hems remain continuous with zero skin/shoe artifacts.
 */
function diffuseInpaintGarmentHoles(
  rgbWork: Float32Array,
  targetMask: Uint8Array,
  inpaintMask: Uint8Array,
  w: number,
  h: number
): void {
  const total = w * h;
  const known = new Uint8Array(total);
  const holeList: number[] = [];

  for (let i = 0; i < total; i++) {
    if (targetMask[i] && !inpaintMask[i]) {
      known[i] = 1;
    } else if (inpaintMask[i]) {
      holeList.push(i);
    }
  }

  if (holeList.length === 0) return;

  // Phase 1: Inward onion-peel BFS initialization from known garment boundary pixels
  let frontier: number[] = [];
  const inFrontier = new Uint8Array(total);

  for (let k = 0; k < holeList.length; k++) {
    const idx = holeList[k];
    const x = idx % w;
    const y = (idx - x) / w;
    if (
      (x > 0 && known[idx - 1]) ||
      (x < w - 1 && known[idx + 1]) ||
      (y > 0 && known[idx - w]) ||
      (y < h - 1 && known[idx + w])
    ) {
      frontier.push(idx);
      inFrontier[idx] = 1;
    }
  }

  const neighborOffsets = [
    [-1, 0, 1.35],
    [1, 0, 1.35],
    [0, -1, 1.0],
    [0, 1, 1.0],
    [-1, -1, 0.65],
    [1, -1, 0.65],
    [-1, 1, 0.65],
    [1, 1, 0.65],
  ] as const;

  let guard = 0;
  while (frontier.length > 0 && guard < 256) {
    guard++;
    const nextFrontier: number[] = [];

    for (let f = 0; f < frontier.length; f++) {
      const idx = frontier[f];
      const x = idx % w;
      const y = (idx - x) / w;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumW = 0;

      for (let n = 0; n < neighborOffsets.length; n++) {
        const nx = x + neighborOffsets[n][0];
        const ny = y + neighborOffsets[n][1];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const nIdx = ny * w + nx;
        if (!known[nIdx]) continue;
        const weight = neighborOffsets[n][2];
        const o = nIdx * 3;
        sumR += rgbWork[o] * weight;
        sumG += rgbWork[o + 1] * weight;
        sumB += rgbWork[o + 2] * weight;
        sumW += weight;
      }

      if (sumW > 0) {
        const o = idx * 3;
        rgbWork[o] = sumR / sumW;
        rgbWork[o + 1] = sumG / sumW;
        rgbWork[o + 2] = sumB / sumW;
      }
    }

    for (let f = 0; f < frontier.length; f++) {
      const idx = frontier[f];
      known[idx] = 1;
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0 && inpaintMask[idx - 1] && !known[idx - 1] && !inFrontier[idx - 1]) {
        inFrontier[idx - 1] = 1;
        nextFrontier.push(idx - 1);
      }
      if (x < w - 1 && inpaintMask[idx + 1] && !known[idx + 1] && !inFrontier[idx + 1]) {
        inFrontier[idx + 1] = 1;
        nextFrontier.push(idx + 1);
      }
      if (y > 0 && inpaintMask[idx - w] && !known[idx - w] && !inFrontier[idx - w]) {
        inFrontier[idx - w] = 1;
        nextFrontier.push(idx - w);
      }
      if (y < h - 1 && inpaintMask[idx + w] && !known[idx + w] && !inFrontier[idx + w]) {
        inFrontier[idx + w] = 1;
        nextFrontier.push(idx + w);
      }
    }

    frontier = nextFrontier;
  }

  // Phase 2: Gauss-Seidel harmonic relaxation (18 passes) for smooth wash/lighting continuity
  for (let iter = 0; iter < 18; iter++) {
    for (let k = 0; k < holeList.length; k++) {
      const idx = holeList[k];
      const x = idx % w;
      const y = (idx - x) / w;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let sumW = 0;

      if (x > 0 && known[idx - 1]) {
        const o = (idx - 1) * 3;
        sumR += rgbWork[o] * 1.25;
        sumG += rgbWork[o + 1] * 1.25;
        sumB += rgbWork[o + 2] * 1.25;
        sumW += 1.25;
      }
      if (x < w - 1 && known[idx + 1]) {
        const o = (idx + 1) * 3;
        sumR += rgbWork[o] * 1.25;
        sumG += rgbWork[o + 1] * 1.25;
        sumB += rgbWork[o + 2] * 1.25;
        sumW += 1.25;
      }
      if (y > 0 && known[idx - w]) {
        const o = (idx - w) * 3;
        sumR += rgbWork[o];
        sumG += rgbWork[o + 1];
        sumB += rgbWork[o + 2];
        sumW += 1;
      }
      if (y < h - 1 && known[idx + w]) {
        const o = (idx + w) * 3;
        sumR += rgbWork[o];
        sumG += rgbWork[o + 1];
        sumB += rgbWork[o + 2];
        sumW += 1;
      }

      if (sumW > 0) {
        const o = idx * 3;
        rgbWork[o] = sumR / sumW;
        rgbWork[o + 1] = sumG / sumW;
        rgbWork[o + 2] = sumB / sumW;
      }
    }
  }

  // Subtle deterministic fabric weave micro-grain so inpainted area matches woven texture
  for (let k = 0; k < holeList.length; k++) {
    const idx = holeList[k];
    const x = idx % w;
    const y = (idx - x) / w;
    const hash = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const grain = ((hash - Math.floor(hash)) - 0.5) * 4.0;
    const o = idx * 3;
    rgbWork[o] = clamp(rgbWork[o] + grain, 0, 255);
    rgbWork[o + 1] = clamp(rgbWork[o + 1] + grain, 0, 255);
    rgbWork[o + 2] = clamp(rgbWork[o + 2] + grain, 0, 255);
  }
}

/**
 * Separable 5-tap Gaussian feather (~1.5px anti-aliased edge) on a binary/uint8 alpha plane.
 */
function featherMaskSeparable(
  src: Uint8Array,
  w: number,
  h: number
): Uint8Array {
  const total = w * h;
  const horiz = new Float32Array(total);
  const out = new Uint8Array(total);
  const w0 = GAUSS_5_WEIGHTS[0];
  const w1 = GAUSS_5_WEIGHTS[1];
  const w2 = GAUSS_5_WEIGHTS[2];
  const w3 = GAUSS_5_WEIGHTS[3];
  const w4 = GAUSS_5_WEIGHTS[4];

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const xm2 = x >= 2 ? x - 2 : 0;
      const xm1 = x >= 1 ? x - 1 : 0;
      const xp1 = x + 1 < w ? x + 1 : w - 1;
      const xp2 = x + 2 < w ? x + 2 : w - 1;
      horiz[row + x] =
        src[row + xm2] * w0 +
        src[row + xm1] * w1 +
        src[row + x] * w2 +
        src[row + xp1] * w3 +
        src[row + xp2] * w4;
    }
  }

  for (let y = 0; y < h; y++) {
    const ym2 = (y >= 2 ? y - 2 : 0) * w;
    const ym1 = (y >= 1 ? y - 1 : 0) * w;
    const y0 = y * w;
    const yp1 = (y + 1 < h ? y + 1 : h - 1) * w;
    const yp2 = (y + 2 < h ? y + 2 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const v =
        horiz[ym2 + x] * w0 +
        horiz[ym1 + x] * w1 +
        horiz[y0 + x] * w2 +
        horiz[yp1 + x] * w3 +
        horiz[yp2 + x] * w4;
      out[y0 + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }

  return out;
}

/**
 * Tightly crops an RGBA buffer to its non-transparent silhouette and centers it
 * onto a transparent canvas with uniform editorial padding (default 6%).
 */
export function cropAndPadTransparentCanvas(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  editorialPaddingRatio = 0.06
): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  cropOriginX: number;
  cropOriginY: number;
} {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (rgba[(row + x) * 4 + 3] >= BBOX_ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      rgba: new Uint8ClampedArray(rgba),
      width,
      height,
      cropOriginX: 0,
      cropOriginY: 0,
    };
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const pad = Math.max(
    6,
    Math.round(Math.max(cropW, cropH) * editorialPaddingRatio)
  );
  const outW = cropW + pad * 2;
  const outH = cropH + pad * 2;
  const outRgba = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < cropH; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    const dstStart = ((pad + y) * outW + pad) * 4;
    outRgba.set(rgba.subarray(srcStart, srcStart + cropW * 4), dstStart);
  }

  return {
    rgba: outRgba,
    width: outW,
    height: outH,
    cropOriginX: minX - pad,
    cropOriginY: minY - pad,
  };
}

/**
 * Isolates strictly the selected wardrobe category from a foreground subject cutout
 * using the cached SegFormer semantic probability map, subtracts dilated Arm/Hand &
 * Shoe occluders, inpaints small occlusion holes (< 4% bbox), applies 1.5px anti-aliased
 * alpha feathering along cut boundaries, and auto-crops with uniform 6% editorial padding.
 */
export function isolateGarmentCutout(
  options: IsolateGarmentOptions
): IsolatedGarmentResult {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const {
    sourceRgba,
    width,
    height,
    semanticMap,
    category,
    mode,
    editorialPaddingRatio = 0.06,
  } = options;

  if (mode === "full" || !semanticMap) {
    const cropped = cropAndPadTransparentCanvas(
      sourceRgba,
      width,
      height,
      editorialPaddingRatio
    );
    return {
      ...cropped,
      isolated: false,
      targetMissing: false,
      inpaintedPixels: 0,
      elapsedMs:
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
        t0,
    };
  }

  const gw = semanticMap.width;
  const gh = semanticMap.height;
  const gPixels = gw * gh;
  const probs = semanticMap.probs;

  // Quick foreground class distribution for Top->Dress fallback detection
  const fgSummary = analyzeForegroundSemantics(
    sourceRgba,
    width,
    height,
    semanticMap
  );
  const classCovProxy = new Float32Array(ATR_NUM_CLASSES);
  classCovProxy[ATR_LABELS.UPPER_CLOTHES] = fgSummary.categoryCoverage.top;
  classCovProxy[ATR_LABELS.DRESS] = Math.max(
    0,
    fgSummary.categoryCoverage.outerwear - fgSummary.categoryCoverage.top
  );

  const targetLabels = getCategoryTargetLabels(category, classCovProxy);
  const targetSet = new Set<number>(targetLabels);
  const armSet = new Set<number>(ARM_HAND_LABELS);
  const shoeSet = new Set<number>(category === "shoes" ? [] : SHOE_LABELS);
  const hemOccluderSet = new Set<number>(
    category === "shoes" ? [ATR_LABELS.PANTS, ATR_LABELS.SKIRT] : []
  );
  const otherHumanSet = new Set<number>(
    HUMAN_BODY_LABELS.filter((c) => !armSet.has(c))
  );
  const otherWearableSet = new Set<number>(
    ALL_WEARABLE_LABELS.filter(
      (c) => !targetSet.has(c) && !shoeSet.has(c) && !hemOccluderSet.has(c)
    )
  );

  // Pre-aggregate the 18 semantic planes into 3 low-res grids (128x128 -> <0.3ms!)
  const gridTarget = new Float32Array(gPixels);
  const gridHardOcc = new Float32Array(gPixels); // Arm/Hand + Shoe (or Pant hem for Shoes), 2px dilation
  const gridOtherNonTarget = new Float32Array(gPixels); // Head, Legs, Non-target garments

  const inv255 = 1 / 255;
  for (let c = 0; c < semanticMap.numClasses; c++) {
    if (c === ATR_LABELS.BACKGROUND) continue;
    const planeOff = c * gPixels;
    if (targetSet.has(c)) {
      for (let i = 0; i < gPixels; i++) {
        gridTarget[i] += probs[planeOff + i] * inv255;
      }
    } else if (armSet.has(c) || shoeSet.has(c) || hemOccluderSet.has(c)) {
      for (let i = 0; i < gPixels; i++) {
        gridHardOcc[i] += probs[planeOff + i] * inv255;
      }
    } else if (otherHumanSet.has(c) || otherWearableSet.has(c)) {
      for (let i = 0; i < gPixels; i++) {
        gridOtherNonTarget[i] += probs[planeOff + i] * inv255;
      }
    }
  }

  const total = width * height;
  const targetMask = new Uint8Array(total);
  const hardOccMask = new Uint8Array(total);
  const softNonTargetMask = new Uint8Array(total);
  const bgDropoutCandidate = new Uint8Array(total);
  const outerFringeCandidate = new Uint8Array(total);

  // Precompute bilinear row/col interpolation indices & weights
  const x0Arr = new Int32Array(width);
  const x1Arr = new Int32Array(width);
  const fxArr = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const gx = clamp(((x + 0.5) * gw) / width - 0.5, 0, gw - 1);
    const x0 = Math.floor(gx);
    x0Arr[x] = x0;
    x1Arr[x] = Math.min(gw - 1, x0 + 1);
    fxArr[x] = gx - x0;
  }

  let fgSolidCount = 0;
  let initialTargetCount = 0;

  for (let y = 0; y < height; y++) {
    const gy = clamp(((y + 0.5) * gh) / height - 0.5, 0, gh - 1);
    const y0 = Math.floor(gy);
    const y1 = Math.min(gh - 1, y0 + 1);
    const fy = gy - y0;
    const invFy = 1 - fy;
    const gRow0 = y0 * gw;
    const gRow1 = y1 * gw;
    const rowOff = y * width;

    for (let x = 0; x < width; x++) {
      const pIdx = rowOff + x;
      const alpha = sourceRgba[pIdx * 4 + 3];
      if (alpha < FG_ALPHA_MIN) continue;
      if (alpha >= FG_ALPHA_SOLID) fgSolidCount++;

      const x0 = x0Arr[x];
      const x1 = x1Arr[x];
      const fx = fxArr[x];
      const invFx = 1 - fx;

      const i00 = gRow0 + x0;
      const i10 = gRow0 + x1;
      const i01 = gRow1 + x0;
      const i11 = gRow1 + x1;

      const w00 = invFx * invFy;
      const w10 = fx * invFy;
      const w01 = invFx * fy;
      const w11 = fx * fy;

      const pTarget =
        gridTarget[i00] * w00 +
        gridTarget[i10] * w10 +
        gridTarget[i01] * w01 +
        gridTarget[i11] * w11;
      const pHard =
        gridHardOcc[i00] * w00 +
        gridHardOcc[i10] * w10 +
        gridHardOcc[i01] * w01 +
        gridHardOcc[i11] * w11;
      const pOther =
        gridOtherNonTarget[i00] * w00 +
        gridOtherNonTarget[i10] * w10 +
        gridOtherNonTarget[i01] * w01 +
        gridOtherNonTarget[i11] * w11;

      const pNonTarget = pHard + pOther;
      const pSemFg = pTarget + pNonTarget;

      if (pHard >= 0.16 && pHard >= pTarget * 0.45) {
        hardOccMask[pIdx] = 1;
      } else if (pOther >= 0.24 && pOther > pTarget * 0.85) {
        softNonTargetMask[pIdx] = 1;
      } else if (pSemFg > 0.06 && pTarget >= pNonTarget * 0.85 && pTarget >= 0.1) {
        targetMask[pIdx] = 1;
        if (alpha >= FG_ALPHA_SOLID) initialTargetCount++;
      } else if (pNonTarget < 0.16 && pSemFg < 0.35 && alpha >= 24) {
        // Solid foreground pixel where SegFormer predicted Background (>= 65%) with low
        // competing non-target probability (common on glossy leather sleeves & dark hems).
        bgDropoutCandidate[pIdx] = 1;
        outerFringeCandidate[pIdx] = 1;
      } else if (pSemFg <= 0.12 && alpha >= FG_ALPHA_MIN) {
        outerFringeCandidate[pIdx] = 1;
      }
    }
  }

  // If the requested category is essentially absent in this image, fall back safely
  // to the trimmed full subject and inform the UI instead of returning a blank image.
  const targetRatio = initialTargetCount / Math.max(1, fgSolidCount);
  if (initialTargetCount < 64 || targetRatio < 0.008) {
    const cropped = cropAndPadTransparentCanvas(
      sourceRgba,
      width,
      height,
      editorialPaddingRatio
    );
    return {
      ...cropped,
      isolated: false,
      targetMissing: true,
      inpaintedPixels: 0,
      elapsedMs:
        (typeof performance !== "undefined" ? performance.now() : Date.now()) -
        t0,
    };
  }

  // Morphological 2px dilation of Arm/Hand + Shoe occluders & 1px dilation of other non-target garments
  const dilatedHardOcc = dilateBinaryMask(hardOccMask, width, height, DISK_R2);
  const dilatedSoftNonTarget = dilateBinaryMask(
    softNonTargetMask,
    width,
    height,
    DISK_R1
  );

  for (let i = 0; i < total; i++) {
    if (dilatedHardOcc[i] || dilatedSoftNonTarget[i]) {
      targetMask[i] = 0;
    }
  }

  // Reclaim connected Background-dropout patches inside the target garment (e.g. glossy
  // leather sleeves / belted jacket hems) strictly when bounded by targetMask, not occluders.
  reclaimForegroundBgDropouts(
    targetMask,
    bgDropoutCandidate,
    dilatedHardOcc,
    dilatedSoftNonTarget,
    width,
    height
  );

  // Recover crisp 1-2px outer anti-aliased silhouette fringes immediately adjacent to targetMask
  const dilatedTarget = dilateBinaryMask(targetMask, width, height, DISK_R2);
  for (let i = 0; i < total; i++) {
    if (
      outerFringeCandidate[i] &&
      dilatedTarget[i] &&
      !dilatedHardOcc[i] &&
      !dilatedSoftNonTarget[i]
    ) {
      targetMask[i] = 1;
    }
  }

  // Strip tiny isolated false-positive fragments
  const isMultiPieceCategory = category === "shoes" || category === "accessory";
  keepSignificantComponents(
    targetMask,
    width,
    height,
    isMultiPieceCategory ? 0.05 : 0.03,
    48
  );

  // Detect small interior holes & concave hand/shoe notches (< 4% garment bbox)
  const { inpaintMask, inpaintCount } = findSmallOcclusionHoles(
    targetMask,
    dilatedHardOcc,
    width,
    height
  );

  // Prepare working RGB buffer and run diffusion inpainting only when holes exist
  let inpaintedRgb: Float32Array | null = null;
  if (inpaintCount > 0) {
    inpaintedRgb = new Float32Array(total * 3);
    for (let i = 0; i < total; i++) {
      const s = i * 4;
      const d = i * 3;
      inpaintedRgb[d] = sourceRgba[s];
      inpaintedRgb[d + 1] = sourceRgba[s + 1];
      inpaintedRgb[d + 2] = sourceRgba[s + 2];
    }
    diffuseInpaintGarmentHoles(inpaintedRgb, targetMask, inpaintMask, width, height);
    for (let i = 0; i < total; i++) {
      if (inpaintMask[i]) {
        targetMask[i] = 1;
      }
    }
  }

  // 1.5px inward anti-aliased alpha feather along semantic cut boundaries:
  // stripped non-target pixels (`targetMask === 0`) stay strictly alpha=0 so zero
  // skin/shoe/shirt RGB ever bleeds back across the cut, while kept pixels within 2px
  // of a cut smoothly anti-alias into transparency.
  const binarySem255 = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    binarySem255[i] = targetMask[i] ? 255 : 0;
  }
  const featheredSem = featherMaskSeparable(binarySem255, width, height);

  // Mark pixels within 2px of a semantic cut (where foreground was stripped)
  const cutPixels = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (!targetMask[i] && sourceRgba[i * 4 + 3] >= 16) {
      cutPixels[i] = 1;
    }
  }
  const nearSemanticCut = dilateBinaryMask(cutPixels, width, height, DISK_R2);

  const composed = new Uint8ClampedArray(total * 4);
  for (let i = 0; i < total; i++) {
    if (!targetMask[i]) continue;

    const s = i * 4;
    const semA = featheredSem[i];
    if (semA < 10) continue;

    if (inpaintedRgb && inpaintMask[i]) {
      const o = i * 3;
      composed[s] = Math.round(inpaintedRgb[o]);
      composed[s + 1] = Math.round(inpaintedRgb[o + 1]);
      composed[s + 2] = Math.round(inpaintedRgb[o + 2]);
      composed[s + 3] = nearSemanticCut[i] ? semA : 255;
      continue;
    }

    const origA = sourceRgba[s + 3];
    if (origA < FG_ALPHA_MIN) continue;

    const finalA = nearSemanticCut[i]
      ? Math.round((origA * semA) / 255)
      : origA;

    if (finalA < 10) continue;

    composed[s] = sourceRgba[s];
    composed[s + 1] = sourceRgba[s + 1];
    composed[s + 2] = sourceRgba[s + 2];
    composed[s + 3] = finalA;
  }

  const cropped = cropAndPadTransparentCanvas(
    composed,
    width,
    height,
    editorialPaddingRatio
  );

  return {
    ...cropped,
    isolated: true,
    targetMissing: false,
    inpaintedPixels: inpaintCount,
    elapsedMs:
      (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
  };
}
