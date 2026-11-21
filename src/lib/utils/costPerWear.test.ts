import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCostPerWear,
  getDaysSinceLastWorn,
  isDeadStock,
} from "./costPerWear";

test("calculateCostPerWear returns full price when wearCount is 0", () => {
  assert.equal(calculateCostPerWear(2500, 0), 2500);
  assert.equal(calculateCostPerWear(2500, -3), 2500);
});

test("calculateCostPerWear divides price by wearCount for worn pieces", () => {
  assert.equal(calculateCostPerWear(2500, 1), 2500);
  assert.equal(calculateCostPerWear(2500, 5), 500);
  assert.equal(calculateCostPerWear(1000, 4), 250);
  assert.equal(calculateCostPerWear(0, 10), 0);
});

test("getDaysSinceLastWorn returns null for never-worn items", () => {
  assert.equal(getDaysSinceLastWorn(null), null);
});

test("getDaysSinceLastWorn calculates whole elapsed days accurately", () => {
  const ref = new Date("2026-11-22T12:00:00Z");
  const sameDay = new Date("2026-11-22T00:00:00Z");
  const tenDaysAgo = new Date("2026-11-12T12:00:00Z");
  const futureDate = new Date("2026-11-23T00:00:00Z");

  assert.equal(getDaysSinceLastWorn(sameDay, ref), 0);
  assert.equal(getDaysSinceLastWorn(tenDaysAgo, ref), 10);
  assert.equal(getDaysSinceLastWorn(futureDate, ref), 0);
});

test("isDeadStock respects default 90-day and custom thresholds", () => {
  const ref = new Date("2026-11-22T12:00:00Z");
  const days89 = new Date(ref.getTime() - 89 * 86_400_000);
  const days90 = new Date(ref.getTime() - 90 * 86_400_000);
  const days45 = new Date(ref.getTime() - 45 * 86_400_000);

  assert.equal(isDeadStock(null, 90, ref), false);
  assert.equal(isDeadStock(days89, 90, ref), false);
  assert.equal(isDeadStock(days90, 90, ref), true);
  assert.equal(isDeadStock(days45, 30, ref), true);
  assert.equal(isDeadStock(days45, 60, ref), false);
});
