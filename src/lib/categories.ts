export const WARDROBE_CATEGORIES = [
  "top",
  "bottom",
  "outerwear",
  "shoes",
  "accessory",
] as const;

export type WardrobeCategory = (typeof WARDROBE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<WardrobeCategory, string> = {
  top: "Top",
  bottom: "Bottom",
  outerwear: "Outerwear",
  shoes: "Shoes",
  accessory: "Accessories",
};

export function isWardrobeCategory(value: string): value is WardrobeCategory {
  return (WARDROBE_CATEGORIES as readonly string[]).includes(value);
}
