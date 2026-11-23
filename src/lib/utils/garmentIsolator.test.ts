import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  analyzeForegroundSemantics,
  ATR_LABELS,
  ATR_NUM_CLASSES,
  isolateGarmentCutout,
  type SemanticParseMap,
} from "./garmentIsolator";
import {
  composeLayeredUpperCutout,
  composeStudioFlatLayCanvas,
  STUDIO_FLATLAY_BG,
  trimGarmentCutout,
} from "./garmentReshaper";
import {
  buildFullOutfitCacheKey,
  buildPass1CacheKey,
} from "../cache/tryonCache";
import { DEFAULT_TAILOR_FIT } from "../types/tailorFit";

interface SyntheticOutfitScene {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  semanticMap: SemanticParseMap;
}

/**
 * Builds a synthetic 240x320 full-outfit model cutout matching the spec acceptance case:
 * - Black tee (Upper-clothes) in upper torso
 * - Skin arms on left/right + a small hand/thumb hooking into the jeans waistband + small pocket occlusion
 * - Baggy light-wash denim jeans (Pants) across mid/lower torso
 * - White sneakers (Left-shoe & Right-shoe) beneath pant hems
 */
function createSyntheticModelOutfitScene(): SyntheticOutfitScene {
  const width = 240;
  const height = 320;
  const rgba = new Uint8ClampedArray(width * height * 4);

  const gw = 120;
  const gh = 160;
  const gPixels = gw * gh;
  const probs = new Uint8Array(ATR_NUM_CLASSES * gPixels);
  const labels = new Uint8Array(gPixels);

  const paintRect = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number,
    label: number
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;

        const gx = Math.min(gw - 1, Math.floor((x * gw) / width));
        const gy = Math.min(gh - 1, Math.floor((y * gh) / height));
        labels[gy * gw + gx] = label;
      }
    }
  };

  // Black T-shirt: y=[24..108], x=[68..172]
  paintRect(68, 24, 172, 108, 20, 20, 22, ATR_LABELS.UPPER_CLOTHES);
  // Left & Right Skin Arms: x=[46..68] & x=[172..194], y=[30..124]
  paintRect(46, 30, 68, 124, 210, 150, 110, ATR_LABELS.LEFT_ARM);
  paintRect(172, 30, 194, 124, 210, 150, 110, ATR_LABELS.RIGHT_ARM);
  // Baggy light-wash denim jeans: y=[108..264], x=[64..176]
  paintRect(64, 108, 176, 264, 142, 168, 190, ATR_LABELS.PANTS);
  // Small thumb/fingers hooking the top waistband of the jeans (concave notch < 4% bbox)
  paintRect(86, 104, 100, 120, 210, 150, 110, ATR_LABELS.RIGHT_ARM);
  // Small interior hand/thumb occlusion over left pocket (< 4% bbox)
  paintRect(132, 142, 142, 152, 210, 150, 110, ATR_LABELS.LEFT_ARM);
  // White sneakers beneath pant hems: y=[264..294]
  paintRect(68, 264, 110, 294, 245, 245, 248, ATR_LABELS.LEFT_SHOE);
  paintRect(130, 264, 172, 294, 245, 245, 248, ATR_LABELS.RIGHT_SHOE);

  // Fill sharp one-hot quantized softmax probabilities matching `labels`
  for (let i = 0; i < gPixels; i++) {
    const cls = labels[i];
    probs[cls * gPixels + i] = 255;
  }

  return {
    width,
    height,
    rgba,
    semanticMap: {
      width: gw,
      height: gh,
      numClasses: ATR_NUM_CLASSES,
      probs,
      labels,
    },
  };
}

function countMatchingPixels(
  rgba: Uint8ClampedArray,
  predicate: (r: number, g: number, b: number, a: number) => boolean
): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (predicate(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3])) {
      count++;
    }
  }
  return count;
}

test("Bottom isolation strips black tee, arms/hands, and white sneakers while inpainting waistband thumb notch", () => {
  const scene = createSyntheticModelOutfitScene();
  const summary = analyzeForegroundSemantics(
    scene.rgba,
    scene.width,
    scene.height,
    scene.semanticMap
  );
  assert.equal(summary.hasHumanOrOtherClothes, true);

  const bottomResult = isolateGarmentCutout({
    sourceRgba: scene.rgba,
    width: scene.width,
    height: scene.height,
    semanticMap: scene.semanticMap,
    category: "bottom",
    mode: "category",
  });

  assert.equal(bottomResult.isolated, true);
  assert.equal(bottomResult.targetMissing, false);
  assert.ok(
    bottomResult.inpaintedPixels > 0,
    "expected small hand waistband/pocket occlusions to be inpainted"
  );

  const denimPixels = countMatchingPixels(
    bottomResult.rgba,
    (r, g, b, a) => a >= 200 && b > r + 20 && g > r + 10
  );
  const blackTeePixels = countMatchingPixels(
    bottomResult.rgba,
    (r, g, b, a) => a >= 40 && r < 45 && g < 45 && b < 45
  );
  const skinPixels = countMatchingPixels(
    bottomResult.rgba,
    (r, g, b, a) => a >= 40 && r > 180 && g > 120 && g < 175 && b < 135
  );
  const sneakerPixels = countMatchingPixels(
    bottomResult.rgba,
    (r, g, b, a) => a >= 40 && r > 225 && g > 225 && b > 225
  );

  assert.ok(denimPixels > 12_000, `expected denim jeans retained, got ${denimPixels}`);
  assert.equal(blackTeePixels, 0, "expected zero black tee pixels in Bottom cutout");
  assert.equal(skinPixels, 0, "expected zero skin/hand pixels in Bottom cutout");
  assert.equal(sneakerPixels, 0, "expected zero sneaker pixels in Bottom cutout");

  // Uniform 6% editorial padding on transparent outer margins
  assert.equal(bottomResult.rgba[3], 0, "top-left editorial margin must be transparent");
  assert.equal(
    bottomResult.rgba[bottomResult.rgba.length - 1],
    0,
    "bottom-right editorial margin must be transparent"
  );
  assert.ok(
    bottomResult.elapsedMs < 500,
    `expected fast reactive isolation, got ${bottomResult.elapsedMs.toFixed(1)}ms`
  );
});

test("Switching category from Bottom to Top and Shoes isolates each garment cleanly from the same cached map", () => {
  const scene = createSyntheticModelOutfitScene();

  const topResult = isolateGarmentCutout({
    sourceRgba: scene.rgba,
    width: scene.width,
    height: scene.height,
    semanticMap: scene.semanticMap,
    category: "top",
    mode: "category",
  });
  assert.equal(topResult.isolated, true);
  assert.equal(topResult.targetMissing, false);

  const topBlackPixels = countMatchingPixels(
    topResult.rgba,
    (r, g, b, a) => a >= 200 && r < 40 && g < 40 && b < 40
  );
  const topDenimPixels = countMatchingPixels(
    topResult.rgba,
    (r, g, b, a) => a >= 40 && b > r + 20 && g > r + 10
  );
  const topSkinPixels = countMatchingPixels(
    topResult.rgba,
    (r, g, b, a) => a >= 40 && r > 180 && g > 120 && g < 175 && b < 135
  );

  assert.ok(topBlackPixels > 6_000, `expected black tee retained, got ${topBlackPixels}`);
  assert.equal(topDenimPixels, 0, "expected zero denim jeans pixels in Top cutout");
  assert.equal(topSkinPixels, 0, "expected zero skin pixels in Top cutout");

  const shoesResult = isolateGarmentCutout({
    sourceRgba: scene.rgba,
    width: scene.width,
    height: scene.height,
    semanticMap: scene.semanticMap,
    category: "shoes",
    mode: "category",
  });
  assert.equal(shoesResult.isolated, true);
  const shoeWhitePixels = countMatchingPixels(
    shoesResult.rgba,
    (r, g, b, a) => a >= 200 && r > 225 && g > 225 && b > 225
  );
  const shoeDenimPixels = countMatchingPixels(
    shoesResult.rgba,
    (r, g, b, a) => a >= 40 && b > r + 20 && g > r + 10
  );
  assert.ok(shoeWhitePixels > 1_800, `expected both white sneakers retained, got ${shoeWhitePixels}`);
  assert.equal(shoeDenimPixels, 0, "expected zero denim pixels in Shoes cutout");

  // Missing category (Accessories) falls back safely with targetMissing=true
  const accessoryResult = isolateGarmentCutout({
    sourceRgba: scene.rgba,
    width: scene.width,
    height: scene.height,
    semanticMap: scene.semanticMap,
    category: "accessory",
    mode: "category",
  });
  assert.equal(accessoryResult.targetMissing, true);
  assert.equal(accessoryResult.isolated, false);

  // Full Subject mode preserves all subject parts untouched
  const fullResult = isolateGarmentCutout({
    sourceRgba: scene.rgba,
    width: scene.width,
    height: scene.height,
    semanticMap: scene.semanticMap,
    category: "bottom",
    mode: "full",
  });
  assert.equal(fullResult.isolated, false);
  assert.ok(
    countMatchingPixels(fullResult.rgba, (r, g, b, a) => a >= 200 && r < 40 && g < 40 && b < 40) >
      6_000
  );
});

test("Pure single-item flat-lay reports hasHumanOrOtherClothes = false", () => {
  const width = 120;
  const height = 160;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const gw = 60;
  const gh = 80;
  const gPixels = gw * gh;
  const probs = new Uint8Array(ATR_NUM_CLASSES * gPixels);
  const labels = new Uint8Array(gPixels);

  for (let y = 20; y < 140; y++) {
    for (let x = 25; x < 95; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = 140;
      rgba[o + 1] = 166;
      rgba[o + 2] = 188;
      rgba[o + 3] = 255;
      const gx = Math.floor((x * gw) / width);
      const gy = Math.floor((y * gh) / height);
      labels[gy * gw + gx] = ATR_LABELS.PANTS;
    }
  }
  for (let i = 0; i < gPixels; i++) {
    probs[labels[i] * gPixels + i] = 255;
  }

  const summary = analyzeForegroundSemantics(rgba, width, height, {
    width: gw,
    height: gh,
    numClasses: ATR_NUM_CLASSES,
    probs,
    labels,
  });
  assert.equal(summary.hasHumanOrOtherClothes, false);
});

test("Flat-lay belted leather jacket with minor SegFormer Face/Arm false positives stays Full Subject and keeps sleeve dropouts + belt in Outerwear isolation", () => {
  const width = 200;
  const height = 220;
  const rgba = new Uint8ClampedArray(width * height * 4);
  const gw = 100;
  const gh = 110;
  const gPixels = gw * gh;
  const probs = new Uint8Array(ATR_NUM_CLASSES * gPixels);
  const labels = new Uint8Array(gPixels);

  const paintJacket = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number,
    label: number
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
        const gx = Math.min(gw - 1, Math.floor((x * gw) / width));
        const gy = Math.min(gh - 1, Math.floor((y * gh) / height));
        labels[gy * gw + gx] = label;
      }
    }
  };

  // Burgundy leather jacket torso + both sleeves (Upper-clothes)
  paintJacket(56, 26, 144, 174, 118, 42, 48, ATR_LABELS.UPPER_CLOTHES);
  paintJacket(26, 36, 56, 176, 114, 40, 46, ATR_LABELS.UPPER_CLOTHES);
  paintJacket(144, 36, 174, 176, 114, 40, 46, ATR_LABELS.UPPER_CLOTHES);

  // Glossy specular patch on the left sleeve misclassified as Background (0) by SegFormer!
  paintJacket(28, 92, 52, 134, 152, 74, 78, ATR_LABELS.BACKGROUND);

  // Sewn-in moto jacket waist belt labeled Belt (8)
  paintJacket(56, 174, 144, 192, 108, 36, 42, ATR_LABELS.BELT);

  // ~2% false-positive Face inside the dark hollow collar opening
  paintJacket(88, 28, 112, 46, 28, 18, 18, ATR_LABELS.FACE);

  for (let i = 0; i < gPixels; i++) {
    probs[labels[i] * gPixels + i] = 255;
  }

  const semanticMap: SemanticParseMap = {
    width: gw,
    height: gh,
    numClasses: ATR_NUM_CLASSES,
    probs,
    labels,
  };

  // Must NOT auto-trigger Isolate mode on a pure flat-lay leather jacket
  const summary = analyzeForegroundSemantics(rgba, width, height, semanticMap);
  assert.equal(
    summary.hasHumanOrOtherClothes,
    false,
    `expected flat-lay leather jacket to stay Full Subject (humanRatio=${(summary.humanRatio * 100).toFixed(2)}%)`
  );

  // Even when explicitly running Isolate Outerwear Only, BOTH the glossy Background-dropout
  // left sleeve patch AND the sewn-in waist belt must remain 100% intact (zero chewed holes!)
  const outerwearResult = isolateGarmentCutout({
    sourceRgba: rgba,
    width,
    height,
    semanticMap,
    category: "outerwear",
    mode: "category",
  });
  assert.equal(outerwearResult.isolated, true);
  assert.equal(outerwearResult.targetMissing, false);

  const checkOrigPixelOpaque = (origX: number, origY: number, label: string) => {
    const outX = origX - outerwearResult.cropOriginX;
    const outY = origY - outerwearResult.cropOriginY;
    assert.ok(
      outX >= 0 &&
        outX < outerwearResult.width &&
        outY >= 0 &&
        outY < outerwearResult.height,
      `${label} pixel (${origX},${origY}) fell outside cropped bounds`
    );
    const alpha =
      outerwearResult.rgba[(outY * outerwearResult.width + outX) * 4 + 3];
    assert.ok(
      alpha >= 200,
      `expected ${label} pixel (${origX},${origY}) preserved at full opacity, got alpha=${alpha}`
    );
  };

  checkOrigPixelOpaque(40, 112, "glossy left sleeve dropout");
  checkOrigPixelOpaque(100, 182, "sewn-in moto waist belt");
  checkOrigPixelOpaque(158, 110, "right leather sleeve");
});

test("composeStudioFlatLayCanvas composites transparent cutout centered onto #F6F6F4 studio backdrop", async () => {
  const srcW = 160;
  const srcH = 260;
  const rawRgba = new Uint8Array(srcW * srcH * 4);
  for (let y = 30; y < 230; y++) {
    for (let x = 40; x < 120; x++) {
      const o = (y * srcW + x) * 4;
      rawRgba[o] = 138;
      rawRgba[o + 1] = 165;
      rawRgba[o + 2] = 188;
      rawRgba[o + 3] = 255;
    }
  }
  const transparentPng = await sharp(rawRgba, {
    raw: { width: srcW, height: srcH, channels: 4 },
  })
    .png()
    .toBuffer();

  const studio = await composeStudioFlatLayCanvas({
    rawBuffer: transparentPng,
    canvasWidth: 384,
    canvasHeight: 512,
    paddingRatio: 0.08,
  });

  assert.equal(studio.width, 384);
  assert.equal(studio.height, 512);
  assert.equal(studio.trimmedWidth, 80);
  assert.equal(studio.trimmedHeight, 200);

  const rawRgb = await sharp(studio.pngBuffer).raw().toBuffer();
  // Corner pixel must be clean #F6F6F4 studio flat-lay backdrop
  assert.equal(rawRgb[0], STUDIO_FLATLAY_BG.r);
  assert.equal(rawRgb[1], STUDIO_FLATLAY_BG.g);
  assert.equal(rawRgb[2], STUDIO_FLATLAY_BG.b);

  // Center pixel must contain the denim garment
  const centerIdx = (256 * 384 + 192) * 3;
  assert.ok(Math.abs(rawRgb[centerIdx] - 138) <= 3);
  assert.ok(Math.abs(rawRgb[centerIdx + 1] - 165) <= 3);
  assert.ok(Math.abs(rawRgb[centerIdx + 2] - 188) <= 3);
});

test("composeLayeredUpperCutout reveals inner shirt through open jacket front and cache keys distinguish outerwear", async () => {
  // White inner tee transparent Cutout PNG (120x160 centered inside 140x180 transparent canvas)
  const shirtRaw = new Uint8Array(140 * 180 * 4);
  for (let y = 10; y < 170; y++) {
    for (let x = 10; x < 130; x++) {
      const o = (y * 140 + x) * 4;
      shirtRaw[o] = 248;
      shirtRaw[o + 1] = 248;
      shirtRaw[o + 2] = 246;
      shirtRaw[o + 3] = 255;
    }
  }
  const shirtPng = await sharp(shirtRaw, {
    raw: { width: 140, height: 180, channels: 4 },
  })
    .png()
    .toBuffer();

  // Open-front navy jacket transparent Cutout PNG (160x180 inside 180x200 with open front x=[74..106])
  const jacketRaw = new Uint8Array(180 * 200 * 4);
  for (let y = 10; y < 190; y++) {
    for (let x = 10; x < 170; x++) {
      if (x >= 74 && x < 106) continue; // open front!
      const o = (y * 180 + x) * 4;
      jacketRaw[o] = 28;
      jacketRaw[o + 1] = 44;
      jacketRaw[o + 2] = 74;
      jacketRaw[o + 3] = 255;
    }
  }
  const jacketPng = await sharp(jacketRaw, {
    raw: { width: 180, height: 200, channels: 4 },
  })
    .png()
    .toBuffer();

  const [shirtTrim, jacketTrim] = await Promise.all([
    trimGarmentCutout(shirtPng),
    trimGarmentCutout(jacketPng),
  ]);

  const layered = await composeLayeredUpperCutout(shirtTrim, jacketTrim);
  const { data, info } = await sharp(layered.buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Center opening must show the inner white shirt cleanly through the open jacket
  const centerIdx =
    (Math.floor(info.height * 0.5) * info.width + Math.floor(info.width * 0.5)) *
    4;
  assert.ok(data[centerIdx] > 230 && data[centerIdx + 3] > 230);

  // Left lapel panel must show the navy jacket
  const lapelIdx =
    (Math.floor(info.height * 0.5) * info.width + Math.floor(info.width * 0.2)) *
    4;
  assert.ok(data[lapelIdx] < 50 && data[lapelIdx + 2] > 55 && data[lapelIdx + 3] > 230);

  // Cache keys must separate Shirt-only vs Shirt+Jacket and Outerwear styles cleanly
  const shirtOnlyKey = buildFullOutfitCacheKey({
    avatarHash: "av1",
    upperItemId: "shirt-1",
    outerwearItemId: null,
    lowerItemId: "jeans-1",
    cleanSwap: false,
    tailorFit: DEFAULT_TAILOR_FIT,
    renderMode: "two-pass",
    highDetail: false,
  });
  const shirtAndJacketOpenKey = buildFullOutfitCacheKey({
    avatarHash: "av1",
    upperItemId: "shirt-1",
    outerwearItemId: "jacket-1",
    lowerItemId: "jeans-1",
    cleanSwap: false,
    tailorFit: { ...DEFAULT_TAILOR_FIT, outerwearStyle: "open-front" },
    renderMode: "two-pass",
    highDetail: false,
  });
  const shirtAndJacketZippedPeekKey = buildFullOutfitCacheKey({
    avatarHash: "av1",
    upperItemId: "shirt-1",
    outerwearItemId: "jacket-1",
    lowerItemId: "jeans-1",
    cleanSwap: false,
    tailorFit: { ...DEFAULT_TAILOR_FIT, outerwearStyle: "collar-hem-peek" },
    renderMode: "two-pass",
    highDetail: false,
  });
  assert.notEqual(shirtOnlyKey, shirtAndJacketOpenKey);
  assert.notEqual(shirtAndJacketOpenKey, shirtAndJacketZippedPeekKey);

  const step1Key = buildPass1CacheKey({
    avatarHash: "av1",
    engine: "weshop",
    pass1ItemId: "jeans-1",
    pass1Slot: "lower",
    pass1TailorSlice: { cropPct: 0, widthScale: 1 },
    pass1SegFree: false,
    highDetail: false,
  });
  const step2ChainedKey = buildPass1CacheKey({
    avatarHash: "av1",
    engine: "weshop",
    pass1ItemId: "shirt-1",
    pass1Slot: "upper",
    pass1TailorSlice: { cropPct: 0, widthScale: 1 },
    pass1SegFree: false,
    highDetail: false,
    priorChainKey: step1Key,
  });
  const step2UnchainedKey = buildPass1CacheKey({
    avatarHash: "av1",
    engine: "weshop",
    pass1ItemId: "shirt-1",
    pass1Slot: "upper",
    pass1TailorSlice: { cropPct: 0, widthScale: 1 },
    pass1SegFree: false,
    highDetail: false,
  });
  assert.notEqual(step2ChainedKey, step2UnchainedKey);
});

test("composeLayeredUpperCutout synthesizes Open Front, Collar + Hem, and Collar Only from a zipped jacket without tee sleeve poke-through", async () => {
  // Oversized white boxy tee with WIDE dropped short sleeves (220x200)
  const teeW = 220;
  const teeH = 200;
  const teeRaw = new Uint8Array(teeW * teeH * 4);
  const paintBox = (
    buf: Uint8Array,
    w: number,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    r: number,
    g: number,
    b: number
  ) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        buf[o] = r;
        buf[o + 1] = g;
        buf[o + 2] = b;
        buf[o + 3] = 255;
      }
    }
  };
  // Tee torso (x=55..165, y=8..194) + wide boxy short sleeves (x=10..210, y=22..96)
  paintBox(teeRaw, teeW, 55, 8, 165, 194, 248, 248, 246);
  paintBox(teeRaw, teeW, 10, 22, 210, 96, 248, 248, 246);

  // Zipped burgundy leather jacket (220x240) with transparent armpit gaps & dark black satin collar lining
  const jW = 220;
  const jH = 240;
  const jRaw = new Uint8Array(jW * jH * 4);
  // Central zipped burgundy torso (x=58..162, y=10..212)
  paintBox(jRaw, jW, 58, 10, 162, 212, 118, 42, 48);
  // Left & right sleeves with clear transparent armpit gaps at x=46..58 and x=162..174!
  paintBox(jRaw, jW, 18, 32, 46, 230, 114, 40, 46);
  paintBox(jRaw, jW, 174, 32, 202, 230, 114, 40, 46);
  // Shoulder bridges connecting sleeves to torso
  paintBox(jRaw, jW, 34, 22, 62, 56, 114, 40, 46);
  paintBox(jRaw, jW, 158, 22, 186, 56, 114, 40, 46);
  // Dark black satin ghost-mannequin collar lining inside V-neck (x=92..128, y=18..64)
  paintBox(jRaw, jW, 92, 18, 128, 64, 20, 16, 16);

  const [teeTrim, jacketTrim] = await Promise.all([
    trimGarmentCutout(
      await sharp(teeRaw, { raw: { width: teeW, height: teeH, channels: 4 } })
        .png()
        .toBuffer()
    ),
    trimGarmentCutout(
      await sharp(jRaw, { raw: { width: jW, height: jH, channels: 4 } })
        .png()
        .toBuffer()
    ),
  ]);

  // 1. Open Front (Unzipped): splits zipped jacket, reveals white tee down center + hem peek, zero armpit poke-through
  const openLayered = await composeLayeredUpperCutout(teeTrim, jacketTrim, {
    style: "open-front",
  });
  const openImg = await sharp(openLayered.buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  assert.ok(
    openImg.info.width > jacketTrim.width + 10,
    "expected open-front to part zipped panels wider than original jacket"
  );
  // Mid-chest center pixel must reveal the bright white tee (not burgundy leather!)
  const openChestIdx =
    (Math.floor(openImg.info.height * 0.5) * openImg.info.width +
      Math.floor(openImg.info.width * 0.5)) *
    4;
  assert.ok(
    openImg.data[openChestIdx] > 200 &&
      openImg.data[openChestIdx + 1] > 200 &&
      openImg.data[openChestIdx + 3] > 220,
    `expected white tee exposed down center in open-front, got rgba(${openImg.data[openChestIdx]},${openImg.data[openChestIdx + 1]},${openImg.data[openChestIdx + 2]},${openImg.data[openChestIdx + 3]})`
  );

  // 2. Collar + Hem Peek (Zipped): keeps mid-chest zipped burgundy, replaces dark collar lining with white tee, peeks white hem below waist
  const peekLayered = await composeLayeredUpperCutout(teeTrim, jacketTrim, {
    style: "collar-hem-peek",
  });
  const peekImg = await sharp(peekLayered.buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(peekImg.info.width, jacketTrim.width);

  // Collar V-neck interior (y ≈ 16% of height, center x) must show white tee instead of black satin lining
  const collarIdx =
    (Math.floor(peekImg.info.height * 0.16) * peekImg.info.width +
      Math.floor(peekImg.info.width * 0.5)) *
    4;
  assert.ok(
    peekImg.data[collarIdx] > 195 &&
      peekImg.data[collarIdx + 1] > 195 &&
      peekImg.data[collarIdx + 3] > 220,
    `expected white crewneck replacing dark collar lining, got rgba(${peekImg.data[collarIdx]},${peekImg.data[collarIdx + 1]},${peekImg.data[collarIdx + 2]},${peekImg.data[collarIdx + 3]})`
  );
  // Mid-chest remains zipped burgundy leather
  const zippedMidIdx =
    (Math.floor(peekImg.info.height * 0.55) * peekImg.info.width +
      Math.floor(peekImg.info.width * 0.5)) *
    4;
  assert.ok(
    peekImg.data[zippedMidIdx] > 90 && peekImg.data[zippedMidIdx + 1] < 65,
    "expected mid-chest to remain zipped burgundy leather in collar-hem-peek"
  );
  // Peeking white tee hem directly beneath the jacket waist belt (y ≈ 215 on 220-tall trimmed jacket)
  const hemPeekY = Math.min(peekImg.info.height - 4, 210);
  const hemPeekIdx =
    (hemPeekY * peekImg.info.width + Math.floor(peekImg.info.width * 0.5)) * 4;
  assert.ok(
    peekImg.data[hemPeekIdx] > 190 && peekImg.data[hemPeekIdx + 3] > 200,
    `expected white tee hem peeking beneath jacket waist, got rgba(${peekImg.data[hemPeekIdx]},${peekImg.data[hemPeekIdx + 1]},${peekImg.data[hemPeekIdx + 2]},${peekImg.data[hemPeekIdx + 3]})`
  );
  // Transparent armpit gap between sleeve and torso must stay transparent (no oversized white tee sleeve poke-through!)
  const armpitIdx =
    (Math.floor(peekImg.info.height * 0.45) * peekImg.info.width + 34) * 4;
  assert.equal(
    peekImg.data[armpitIdx + 3],
    0,
    "expected armpit gap to stay transparent with zero inner tee sleeve poke-through"
  );

  // 3. Collar Only (Tucked): shows white crewneck in collar, ZERO white tee hem hanging below waist belt
  const collarOnlyLayered = await composeLayeredUpperCutout(teeTrim, jacketTrim, {
    style: "collar-only",
  });
  const collarOnlyImg = await sharp(collarOnlyLayered.buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const collarOnlyNeckIdx =
    (Math.floor(collarOnlyImg.info.height * 0.16) * collarOnlyImg.info.width +
      Math.floor(collarOnlyImg.info.width * 0.5)) *
    4;
  assert.ok(
    collarOnlyImg.data[collarOnlyNeckIdx] > 195 &&
      collarOnlyImg.data[collarOnlyNeckIdx + 3] > 220,
    "expected white crewneck inside V-neck in collar-only mode"
  );
  const belowWaistIdx =
    (Math.min(collarOnlyImg.info.height - 4, 210) * collarOnlyImg.info.width +
      Math.floor(collarOnlyImg.info.width * 0.5)) *
    4;
  assert.equal(
    collarOnlyImg.data[belowWaistIdx + 3],
    0,
    "expected zero white tee hem hanging beneath jacket waist belt in collar-only mode"
  );
});
