import type { WardrobeCategory } from "@/lib/categories";

const IMAGE_EXTENSION = /\.(png|jpe?g|webp|avif|heic|heif|gif|bmp|tiff?)$/i;
const UUID =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const CATEGORY_FALLBACK_TITLES: Record<WardrobeCategory, string> = {
  top: "Studio Tee",
  bottom: "Pleated Trouser",
  outerwear: "Studio Jacket",
  shoes: "Studio Footwear",
  accessory: "Studio Accessory",
};

const KNOWN_SCRAPE_ALIASES: readonly {
  pattern: RegExp;
  resolve: (category?: WardrobeCategory) => string;
}[] = [
  {
    pattern: /^25939711r(?:\s+\d+)?$/i,
    resolve: () => "White Zip Hoodie",
  },
  {
    pattern: /os[\s_-]*boxy[\s_-]*tees?[\s_-]*white/i,
    resolve: () => "Boxy White Tee",
  },
  {
    pattern: /^oip(?:\s*\(\d+\))?$/i,
    resolve: (category) =>
      category ? CATEGORY_FALLBACK_TITLES[category] : "Untitled Piece",
  },
  {
    pattern: /womens?\s+stone\s+street.*platform\s+boot/i,
    resolve: () => "Stone Street Platform Boot",
  },
];

const BOILERPLATE_WORDS = new Set([
  "img",
  "dsc",
  "dscn",
  "dscf",
  "pxl",
  "mvimg",
  "screenshot",
  "image",
  "photo",
  "picture",
  "pic",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "avif",
  "cutout",
  "transparent",
  "removebg",
  "nobg",
  "bgremoved",
  "whiteback",
  "whitebg",
  "blackback",
  "blackbg",
  "oip",
  "os",
  "back",
  "front",
  "womens",
  "women",
  "mens",
  "men",
]);

function isNoiseToken(token: string): boolean {
  // Pure numeric prefixes/counters ("2", "1", "20240312")
  if (/^\d+$/.test(token)) return true;
  // Dimension strings ("1024x", "1024x1024", "6inch")
  if (/^\d+x\d*$/i.test(token) || /^\d+(?:inch|in|cm|mm)$/i.test(token)) {
    return true;
  }
  // Hash-like fragments: 6+ alphanumeric/hex chars containing digits
  if (/^[0-9a-z]{6,}$/i.test(token) && /\d/.test(token)) return true;
  if (BOILERPLATE_WORDS.has(token.toLowerCase())) return true;
  return false;
}

function splitCompoundWords(input: string): string {
  return input
    .replace(/\btees?whiteback\b/gi, "White Tee")
    .replace(/\btees?blackback\b/gi, "Black Tee")
    .replace(/\btees?(white|black|grey|gray|cream|navy)\b/gi, "$1 Tee")
    .replace(/\b([a-z0-9]{2,})(whiteback|whitebg|blackback|blackbg)\b/gi, "$1");
}

function toEditorialTokenCase(token: string): string {
  const isAllLower = token === token.toLowerCase();
  const isAllUpper = token === token.toUpperCase() && /[A-Z]/.test(token);
  if (isAllLower || isAllUpper) {
    return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
  }
  return token;
}

/**
 * Turns raw filenames, product scrape codes, and ALL-CAPS labels into
 * clean editorial Title Case across Closet and Studio.
 * Display-only: stored database names remain untouched.
 */
export function cleanGarmentName(
  raw: string | null | undefined,
  category?: WardrobeCategory
): string {
  const trimmed = (raw ?? "").trim();
  const fallback = category
    ? CATEGORY_FALLBACK_TITLES[category]
    : "Untitled Piece";
  if (!trimmed) return fallback;

  const baseWithoutExt = trimmed
    .replace(IMAGE_EXTENSION, "")
    .replace(/\s*\(\d+\)\s*$/, "")
    .trim();

  for (const alias of KNOWN_SCRAPE_ALIASES) {
    if (alias.pattern.test(baseWithoutExt)) {
      return alias.resolve(category);
    }
  }

  let value = baseWithoutExt.replace(UUID, " ");
  value = value.replace(/[-_.]+/g, " ");
  value = splitCompoundWords(value);

  const tokens = value
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !isNoiseToken(token))
    .map(toEditorialTokenCase);

  const cleaned = tokens.join(" ").trim();
  if (!cleaned) return fallback;
  return cleaned.length > 60 ? `${cleaned.slice(0, 59).trimEnd()}…` : cleaned;
}
