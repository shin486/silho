import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeGarmentSymmetry,
  buildHighContrastAnalysisRgba,
  computeBrightStudioRescueMask,
  detectBrightStudioBackground,
  detectExistingTransparentCutout,
  EDGE_SENSITIVITY_CUTOFFS,
  mirrorGarmentBuffer,
  recombineOriginalRgbWithAlphaMatte,
} from "./garmentSymmetry";

function makeFilledRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    buf[o + 3] = a;
  }
  return buf;
}

test("detectBrightStudioBackground identifies bright uniform 16px studio borders and rejects non-white or busy borders", () => {
  // Bright white studio backdrop (RGB 252) with a pale white tee in the center
  const studio = makeFilledRgba(128, 128, 253, 253, 252, 255);
  for (let y = 24; y < 104; y++) {
    for (let x = 28; x < 100; x++) {
      const o = (y * 128 + x) * 4;
      studio[o] = 242;
      studio[o + 1] = 242;
      studio[o + 2] = 240;
    }
  }
  const studioStats = detectBrightStudioBackground(studio, 128, 128);
  assert.equal(studioStats.isBrightStudio, true);
  assert.ok(studioStats.meanLuminance > 235);
  assert.ok(studioStats.stdDev < 18);

  // Dark / neutral indoor background
  const indoor = makeFilledRgba(128, 128, 175, 170, 165, 255);
  assert.equal(detectBrightStudioBackground(indoor, 128, 128).isBrightStudio, false);

  // High-variance border (alternating white and mid-gray -> stdDev >= 18)
  const noisy = makeFilledRgba(128, 128, 255, 255, 255, 255);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 128; x++) {
      if (x % 2 === 0) {
        const o = (y * 128 + x) * 4;
        noisy[o] = 200;
        noisy[o + 1] = 200;
        noisy[o + 2] = 200;
      }
    }
  }
  const noisyStats = detectBrightStudioBackground(noisy, 128, 128);
  assert.equal(noisyStats.isBrightStudio, false);
});

test("detectExistingTransparentCutout identifies transparent PNG cutouts and rejects opaque studio or rounded-corner photos", () => {
  // 1. Transparent PNG leather jacket cutout (transparent border with RGB=255,255,255,0!)
  const pngCutout = makeFilledRgba(160, 180, 255, 255, 255, 0);
  for (let y = 18; y < 162; y++) {
    for (let x = 28; x < 132; x++) {
      const o = (y * 160 + x) * 4;
      pngCutout[o] = 115;
      pngCutout[o + 1] = 40;
      pngCutout[o + 2] = 46;
      pngCutout[o + 3] = 255;
    }
  }
  const pngStats = detectExistingTransparentCutout(pngCutout, 160, 180);
  assert.equal(pngStats.hasExistingTransparency, true);
  assert.ok(pngStats.borderTransparentRatio > 0.7);
  // Transparent (255,255,255,0) border must NOT be mistaken for an opaque white studio backdrop
  assert.equal(
    detectBrightStudioBackground(pngCutout, 160, 180).isBrightStudio,
    false
  );

  // 2. Opaque white studio photo -> NOT an existing transparent cutout
  const opaqueStudio = makeFilledRgba(160, 180, 253, 253, 252, 255);
  assert.equal(
    detectExistingTransparentCutout(opaqueStudio, 160, 180)
      .hasExistingTransparency,
    false
  );

  // 3. Opaque photo with tiny 8px transparent rounded corners -> NOT an existing cutout
  const roundedPhoto = makeFilledRgba(160, 180, 220, 220, 220, 255);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      roundedPhoto[(y * 160 + x) * 4 + 3] = 0;
      roundedPhoto[(y * 160 + (159 - x)) * 4 + 3] = 0;
      roundedPhoto[((179 - y) * 160 + x) * 4 + 3] = 0;
      roundedPhoto[((179 - y) * 160 + (159 - x)) * 4 + 3] = 0;
    }
  }
  assert.equal(
    detectExistingTransparentCutout(roundedPhoto, 160, 180)
      .hasExistingTransparency,
    false
  );
});

test("buildHighContrastAnalysisRgba boosts faint white-on-white cotton contrast while preserving studio white", () => {
  const w = 160;
  const h = 160;
  const img = makeFilledRgba(w, h, 255, 255, 255, 255);

  // Faint white cotton shirt + slight seam shading (RGB 243..247 against 255 white)
  for (let y = 30; y < 130; y++) {
    for (let x = 35; x < 125; x++) {
      const o = (y * w + x) * 4;
      const shade = x === 35 || x === 124 ? 236 : 244;
      img[o] = shade;
      img[o + 1] = shade;
      img[o + 2] = shade - 1;
    }
  }

  const border = detectBrightStudioBackground(img, w, h);
  assert.equal(border.isBrightStudio, true);

  const boosted = buildHighContrastAnalysisRgba(img, w, h, border);

  // Corner studio backdrop stays clean white
  assert.ok(boosted[0] >= 253 && boosted[1] >= 253 && boosted[2] >= 253);

  // Pale white cotton sleeve interior & edge drop decisively below original 244 for stronger separation
  const centerOff = (80 * w + 80) * 4;
  const origDiff = 255 - img[centerOff];
  const boostedDiff = 255 - boosted[centerOff];
  assert.ok(
    boostedDiff > origDiff * 1.4,
    `expected stronger white-on-white contrast: origDiff=${origDiff}, boostedDiff=${boostedDiff}`
  );
});

test("recombineOriginalRgbWithAlphaMatte preserves soft 0.32 cotton borders at default 0.28 cutoff with untouched original RGB", () => {
  const w = 40;
  const h = 40;
  const originalRgba = makeFilledRgba(w, h, 248, 247, 245, 255);
  const rawMatte = new Uint8Array(w * h);

  // Solid center core (alpha = 255) + soft white sleeve zone (alpha = 84 ≈ 0.33)
  for (let y = 8; y < 32; y++) {
    for (let x = 8; x < 32; x++) {
      rawMatte[y * w + x] = x < 18 ? 84 : 255;
    }
  }

  const softOut = recombineOriginalRgbWithAlphaMatte({
    originalRgba,
    rawMatteAlpha: rawMatte,
    width: w,
    height: h,
    alphaCutoff: EDGE_SENSITIVITY_CUTOFFS.soft, // 0.28
  });

  const crispOut = recombineOriginalRgbWithAlphaMatte({
    originalRgba,
    rawMatteAlpha: rawMatte,
    width: w,
    height: h,
    alphaCutoff: EDGE_SENSITIVITY_CUTOFFS.crisp, // 0.45
  });

  const softSleeveIdx = (20 * w + 12) * 4;
  assert.equal(
    softOut[softSleeveIdx + 3],
    255,
    "expected soft 0.28 cutoff to solidify interior 0.33 sleeve pixel to 255 (zero checkerboard bleed)"
  );
  // Original RGB must stay 100% unmodified
  assert.equal(softOut[softSleeveIdx], 248);
  assert.equal(softOut[softSleeveIdx + 1], 247);
  assert.equal(softOut[softSleeveIdx + 2], 245);

  // Harder 0.45 cutoff drops the 0.33 sleeve pixel
  assert.equal(crispOut[softSleeveIdx + 3], 0);
});

test("computeBrightStudioRescueMask rescues a dropped white-on-white right sleeve and solidifies interior bright holes", () => {
  const w = 160;
  const h = 160;
  // Pure #FFFFFF studio background
  const orig = makeFilledRgba(w, h, 255, 255, 255, 255);
  const rawMatte = new Uint8Array(w * h);

  // White cotton tee (RGB 246..249 against 255 white): torso + left sleeve + right sleeve
  for (let y = 30; y < 130; y++) {
    for (let x = 48; x < 112; x++) {
      const o = (y * w + x) * 4;
      orig[o] = 247;
      orig[o + 1] = 247;
      orig[o + 2] = 246;
      rawMatte[y * w + x] = 255;
    }
  }
  // Right sleeve: pale cotton RGB 248, completely DROPPED by @imgly (rawMatte = 0)
  for (let y = 36; y < 84; y++) {
    for (let x = 112; x < 142; x++) {
      const o = (y * w + x) * 4;
      orig[o] = 248;
      orig[o + 1] = 248;
      orig[o + 2] = 247;
      rawMatte[y * w + x] = 0;
    }
  }
  // Enclosed pure-white specular highlight inside chest where neural matte dipped to 0
  for (let y = 65; y < 78; y++) {
    for (let x = 72; x < 86; x++) {
      rawMatte[y * w + x] = 0;
    }
  }

  const borderStats = detectBrightStudioBackground(orig, w, h);
  assert.equal(borderStats.isBrightStudio, true);

  const rescue = computeBrightStudioRescueMask({
    originalRgba: orig,
    rawMatteAlpha: rawMatte,
    width: w,
    height: h,
    borderStats,
  });
  assert.ok(rescue, "expected studio rescue mask on white-on-white flat-lay");

  const recombined = recombineOriginalRgbWithAlphaMatte({
    originalRgba: orig,
    rawMatteAlpha: rawMatte,
    width: w,
    height: h,
    alphaCutoff: EDGE_SENSITIVITY_CUTOFFS.soft,
    studioRescueMask: rescue,
  });

  // Dropped pale-white right sleeve is rescued at full 255 opacity with true original RGB
  const rightSleeveIdx = (60 * w + 128) * 4;
  assert.equal(recombined[rightSleeveIdx + 3], 255);
  assert.equal(recombined[rightSleeveIdx], 248);

  // Enclosed specular chest hole is solidified to 255
  const chestHoleIdx = (70 * w + 78) * 4;
  assert.equal(recombined[chestHoleIdx + 3], 255);

  // Outer #FFFFFF studio corner stays 100% transparent (alpha = 0)
  assert.equal(recombined[3], 0);
});

test("analyzeGarmentSymmetry and mirrorGarmentBuffer detect a missing right sleeve on a white tee and reconstruct seamless symmetry", () => {
  const w = 220;
  const h = 240;
  const rgba = new Uint8ClampedArray(w * h * 4);

  const paint = (
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
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
  };

  // True anatomical centerline of the tee is x = 120:
  // Collar band: x=[98..142], y=[24..40]
  paint(98, 24, 142, 40, 246, 246, 244);
  // Straight torso column: x=[76..164], y=[40..204]
  paint(76, 40, 164, 204, 248, 248, 246);
  // Intact left sleeve ONLY (right sleeve completely dropped!): x=[30..76], y=[44..116]
  paint(30, 44, 76, 116, 245, 245, 243);

  const before = analyzeGarmentSymmetry(rgba, w, h, "top");
  assert.ok(
    Math.abs(before.centerX - 120) <= 3,
    `expected centerX near 120 (collar/torso center), got ${before.centerX}`
  );
  assert.equal(before.isAsymmetric, true);
  assert.ok(
    before.widthAsymmetry > 0.22,
    `expected > 22% width asymmetry, got ${(before.widthAsymmetry * 100).toFixed(1)}%`
  );
  assert.equal(before.recommendedDirection, "left-to-right");

  // Non-symmetric categories (Shoes / Accessories) never trigger asymmetry warning
  assert.equal(
    analyzeGarmentSymmetry(rgba, w, h, "shoes").isAsymmetric,
    false
  );

  // Mirror L -> R across centerX
  const mirrored = mirrorGarmentBuffer({
    rgba,
    width: w,
    height: h,
    category: "top",
  });

  assert.equal(mirrored.direction, "left-to-right");
  assert.ok(
    mirrored.elapsedMs < 40,
    `expected < 40ms pure buffer mirror, got ${mirrored.elapsedMs.toFixed(1)}ms`
  );

  const after = analyzeGarmentSymmetry(
    mirrored.rgba,
    mirrored.width,
    mirrored.height,
    "top"
  );
  assert.equal(after.isAsymmetric, false);
  assert.ok(
    after.widthAsymmetry < 0.04,
    `expected symmetric tee after Mirror L↔R, got ${(after.widthAsymmetry * 100).toFixed(1)}%`
  );

  // Verify the 12px center seam stays solid opaque with zero vertical crease / alpha drop
  const midY = Math.floor(mirrored.height * 0.5);
  for (let dx = -6; dx <= 6; dx++) {
    const sx = Math.round(mirrored.centerX) + dx;
    const o = (midY * mirrored.width + sx) * 4;
    assert.equal(
      mirrored.rgba[o + 3],
      255,
      `expected solid alpha along center seam dx=${dx}`
    );
  }
});

test("analyzeGarmentSymmetry recommends Right -> Left when the left sleeve is missing", () => {
  const w = 220;
  const h = 240;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const paint = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        rgba[o] = 246;
        rgba[o + 1] = 246;
        rgba[o + 2] = 244;
        rgba[o + 3] = 255;
      }
    }
  };
  // Centerline x = 100, intact RIGHT sleeve only
  paint(78, 24, 122, 40); // collar
  paint(56, 40, 144, 204); // torso
  paint(144, 44, 190, 116); // right sleeve

  const before = analyzeGarmentSymmetry(rgba, w, h, "outerwear");
  assert.equal(before.isAsymmetric, true);
  assert.equal(before.recommendedDirection, "right-to-left");

  const mirrored = mirrorGarmentBuffer({
    rgba,
    width: w,
    height: h,
    category: "outerwear",
  });
  const after = analyzeGarmentSymmetry(
    mirrored.rgba,
    mirrored.width,
    mirrored.height,
    "outerwear"
  );
  assert.equal(after.isAsymmetric, false);
  assert.ok(after.widthAsymmetry < 0.04);
});
