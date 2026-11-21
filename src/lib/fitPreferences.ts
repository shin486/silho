export const PREFERRED_FITS = ["slim", "regular", "oversized"] as const;

export type PreferredFit = (typeof PREFERRED_FITS)[number];

export const PREFERRED_FIT_LABELS: Record<PreferredFit, string> = {
  slim: "Slim",
  regular: "Regular",
  oversized: "Oversized",
};

export function isPreferredFit(value: string): value is PreferredFit {
  return (PREFERRED_FITS as readonly string[]).includes(value);
}

export const TRYON_DAILY_LIMIT = 3;
