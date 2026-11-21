const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Calculates the cost per wear of a wardrobe piece.
 * Returns the full price when the piece has never been worn (`wearCount <= 0`).
 */
export function calculateCostPerWear(price: number, wearCount: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    return 0;
  }

  if (!Number.isFinite(wearCount) || wearCount <= 0) {
    return price;
  }

  return price / wearCount;
}

/**
 * Computes whole days elapsed since `lastWornDate`.
 * Returns `null` when the piece has never been worn or the date is invalid.
 */
export function getDaysSinceLastWorn(
  lastWornDate: Date | null,
  referenceDate: Date = new Date()
): number | null {
  if (!lastWornDate || Number.isNaN(lastWornDate.getTime())) {
    return null;
  }

  const diffMs = referenceDate.getTime() - lastWornDate.getTime();
  return Math.max(0, Math.floor(diffMs / MS_PER_DAY));
}

/**
 * Determines whether a worn piece has gone unworn for at least `thresholdDays` (default 90).
 * Pieces with `lastWornDate === null` return `false` so newly added pieces are not flagged immediately.
 */
export function isDeadStock(
  lastWornDate: Date | null,
  thresholdDays = 90,
  referenceDate: Date = new Date()
): boolean {
  const days = getDaysSinceLastWorn(lastWornDate, referenceDate);
  if (days === null) {
    return false;
  }

  return days >= thresholdDays;
}

/**
 * Formats a numeric PHP amount with consistent thousands grouping.
 */
export function formatPeso(amount: number, showDecimals = false): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(safeAmount);
}
