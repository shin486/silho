import assert from "node:assert/strict";
import test from "node:test";
import {
  BOXY_TOP_PRESET,
  computeTailorGeometry,
  DEFAULT_TAILOR_FIT,
  isDefaultTailorFit,
  MIN_UNTUCKED_WAIST_OVERLAP,
  needsAutoCleanMask,
  sanitizeTailorFit,
} from "./tailorFit";

test("untucked full outfits always maintain topHemY >= waistLineY + 0.012 across Long, Regular, Boxy, and Cropped monotonically", () => {
  for (const mode of ["preview", "ai"] as const) {
    const longG = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.9,
      lowerAspect: 0.5,
      fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "untucked", topCropPct: -10 },
      mode,
    });
    const regG = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.9,
      lowerAspect: 0.5,
      fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "untucked", topCropPct: 0 },
      mode,
    });
    const boxyG = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.9,
      lowerAspect: 0.5,
      fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "untucked", ...BOXY_TOP_PRESET },
      mode,
    });
    const cropG = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.9,
      lowerAspect: 0.5,
      fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "untucked", topCropPct: 24 },
      mode,
    });
    const maxCropG = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.9,
      lowerAspect: 0.5,
      fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "untucked", topCropPct: 30 },
      mode,
    });

    const minFloor = regG.waistLineY + MIN_UNTUCKED_WAIST_OVERLAP;

    for (const g of [longG, regG, boxyG, cropG, maxCropG]) {
      assert.ok(g.upper && g.lower && g.topHemY !== undefined);
      // Untucked: top renders above trousers and hides top waistband crease
      assert.ok(g.upper.zIndex > g.lower.zIndex);
      assert.ok(
        g.topHemY >= minFloor - 1e-6,
        `expected topHemY (${g.topHemY}) >= ${minFloor} in mode=${mode}`
      );
      // Shoulder anchor pinned
      assert.equal(g.upper.y, regG.upper!.y);
    }

    // Strictly monotonic: Long > Regular > Boxy > Cropped
    assert.ok(longG.topHemY! > regG.topHemY!);
    assert.ok(regG.topHemY! > boxyG.topHemY!);
    assert.ok(boxyG.topHemY! > cropG.topHemY!);
    assert.ok(cropG.topHemY! >= maxCropG.topHemY!);

    // True Boxy preset widens the chest compared to Regular
    assert.ok(boxyG.upper!.width > regG.upper!.width);
  }
});

test("toggling tuckMode from untucked to tucked flips lower.zIndex > upper.zIndex and prevents waist gap", () => {
  const untucked = computeTailorGeometry({
    hasUpper: true,
    hasLower: true,
    fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "untucked", topCropPct: 24 },
    mode: "ai",
  });
  const tucked = computeTailorGeometry({
    hasUpper: true,
    hasLower: true,
    fit: { ...DEFAULT_TAILOR_FIT, tuckMode: "tucked", topCropPct: 24 },
    mode: "ai",
  });

  assert.ok(untucked.upper && untucked.lower && tucked.upper && tucked.lower);
  assert.ok(untucked.upper.zIndex > untucked.lower.zIndex);
  assert.ok(tucked.lower.zIndex > tucked.upper.zIndex);
  assert.ok(tucked.upper.y > untucked.upper.y);
  // Tucked top extends cleanly behind waistband with no midriff gap
  assert.ok((tucked.topHemY ?? 0) >= tucked.waistLineY + 0.029);
});

test("Slim (0.85x) and Oversized (1.20x) produce distinct width ratios without altering topY, bottomY, or hems", () => {
  for (const mode of ["preview", "ai"] as const) {
    const slim = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.85,
      lowerAspect: 0.5,
      fit: {
        ...DEFAULT_TAILOR_FIT,
        topWidthScale: 0.85,
        bottomWidthScale: 0.84,
      },
      mode,
    });
    const regular = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.85,
      lowerAspect: 0.5,
      fit: DEFAULT_TAILOR_FIT,
      mode,
    });
    const oversized = computeTailorGeometry({
      hasUpper: true,
      hasLower: true,
      upperAspect: 0.85,
      lowerAspect: 0.5,
      fit: {
        ...DEFAULT_TAILOR_FIT,
        topWidthScale: 1.2,
        bottomWidthScale: 1.2,
      },
      mode,
    });

    assert.ok(slim.upper && regular.upper && oversized.upper);
    assert.ok(slim.lower && regular.lower && oversized.lower);

    assert.ok(slim.upper.width < regular.upper.width);
    assert.ok(oversized.upper.width > regular.upper.width);
    assert.ok(slim.lower.width < regular.lower.width);
    assert.ok(oversized.lower.width > regular.lower.width);

    assert.equal(slim.upper.y, regular.upper.y);
    assert.equal(oversized.upper.y, regular.upper.y);
    assert.equal(slim.topHemY, regular.topHemY);
    assert.equal(oversized.topHemY, regular.topHemY);

    assert.equal(slim.lower.y, regular.lower.y);
    assert.equal(oversized.lower.y, regular.lower.y);
    assert.equal(slim.bottomHemY, regular.bottomHemY);
    assert.equal(oversized.bottomHemY, regular.bottomHemY);
  }
});

test("sanitizeTailorFit clamps ranges and needsAutoCleanMask only triggers on single-pass tops with strong crop or slim", () => {
  assert.equal(isDefaultTailorFit(DEFAULT_TAILOR_FIT), true);
  assert.equal(
    needsAutoCleanMask(DEFAULT_TAILOR_FIT, { hasUpper: true, hasLower: false }),
    false
  );

  const clamped = sanitizeTailorFit({
    tuckMode: "tucked",
    outerwearStyle: "invalid" as unknown as "open-front",
    topCropPct: -50,
    topWidthScale: 0.5,
    bottomCropPct: 99,
    bottomWidthScale: 2.0,
  });
  assert.deepEqual(clamped, {
    tuckMode: "tucked",
    outerwearStyle: "open-front",
    topCropPct: -12,
    topWidthScale: 0.8,
    bottomCropPct: 22,
    bottomWidthScale: 1.25,
  });
  assert.equal(
    sanitizeTailorFit({ outerwearStyle: "collar-hem-peek" }).outerwearStyle,
    "collar-hem-peek"
  );
  assert.equal(
    sanitizeTailorFit({ outerwearStyle: "collar-only" }).outerwearStyle,
    "collar-only"
  );

  // Never auto-enable on full-outfit (one-pieces) or bottoms-only passes
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, ...BOXY_TOP_PRESET },
      { hasUpper: true, hasLower: true }
    ),
    false
  );
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, topCropPct: 24, topWidthScale: 0.85 },
      { hasUpper: true, hasLower: true }
    ),
    false
  );
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, bottomCropPct: 18, bottomWidthScale: 0.84 },
      { hasUpper: false, hasLower: true }
    ),
    false
  );

  // Single-pass tops-only: only triggers at topCropPct >= 18 or topWidthScale <= 0.88
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, ...BOXY_TOP_PRESET },
      { hasUpper: true, hasLower: false }
    ),
    false
  );
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, topCropPct: 18 },
      { hasUpper: true, hasLower: false }
    ),
    true
  );
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, topWidthScale: 0.88 },
      { hasUpper: true, hasLower: false }
    ),
    true
  );
  assert.equal(
    needsAutoCleanMask(
      { ...DEFAULT_TAILOR_FIT, topCropPct: -10, topWidthScale: 1.2 },
      { hasUpper: true, hasLower: false }
    ),
    false
  );
});
