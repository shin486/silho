import { createHash } from "node:crypto";
import type { TailorFitConfig, TryOnRenderMode } from "@/lib/types/tailorFit";

export type TryOnEngineKind =
  | "fitdit-api"
  | "vton-api"
  | "fashn-vton-1.5"
  | "catvton"
  | "weshop";
export type TryOnSlotKind = "upper" | "outerwear" | "lower" | "composite";

export interface FullOutfitCacheEntry {
  resultUrl: string;
  engine: TryOnEngineKind;
  passes: TryOnSlotKind[];
  garmentCompositeUrl?: string;
}

export interface Pass1CacheEntry {
  buffer34: Buffer;
  /** Native 576x864 2:3 JPEG buffer ready to feed directly into FASHN Pass 2 */
  fashnPadded576?: Buffer;
  rawW: number;
  rawH: number;
  engine: TryOnEngineKind;
}

interface CacheRecord<T> {
  value: T;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 24;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

class LruTtlCache<T> {
  private readonly store = new Map<string, CacheRecord<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number
  ) {}

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    // Refresh LRU recency
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

interface GlobalTryOnCaches {
  fullOutfit: LruTtlCache<FullOutfitCacheEntry>;
  pass1: LruTtlCache<Pass1CacheEntry>;
}

const globalForTryonCache = globalThis as typeof globalThis & {
  __silhoTryonCaches?: GlobalTryOnCaches;
};

function getCaches(): GlobalTryOnCaches {
  if (!globalForTryonCache.__silhoTryonCaches) {
    globalForTryonCache.__silhoTryonCaches = {
      fullOutfit: new LruTtlCache<FullOutfitCacheEntry>(
        MAX_CACHE_ENTRIES,
        CACHE_TTL_MS
      ),
      pass1: new LruTtlCache<Pass1CacheEntry>(MAX_CACHE_ENTRIES, CACHE_TTL_MS),
    };
  }
  return globalForTryonCache.__silhoTryonCaches;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildFullOutfitCacheKey(params: {
  avatarHash: string;
  upperItemId: string | null;
  outerwearItemId?: string | null;
  lowerItemId: string | null;
  cleanSwap: boolean;
  tailorFit: TailorFitConfig;
  renderMode: TryOnRenderMode;
  highDetail: boolean;
}): string {
  return sha256Hex(
    JSON.stringify({
      v: 15,
      avatarHash: params.avatarHash,
      upperItemId: params.upperItemId,
      outerwearItemId: params.outerwearItemId ?? null,
      lowerItemId: params.lowerItemId,
      cleanSwap: params.cleanSwap,
      tailorFit: params.tailorFit,
      renderMode: params.renderMode,
      highDetail: params.highDetail,
    })
  );
}

export function buildPass1CacheKey(params: {
  avatarHash: string;
  engine: TryOnEngineKind;
  pass1ItemId: string;
  pass1Slot: "upper" | "outerwear" | "lower";
  pass1TailorSlice: { cropPct: number; widthScale: number };
  pass1SegFree: boolean;
  highDetail: boolean;
  /** Optional chain prefix when caching multi-step intermediate states (e.g. Bottom -> Top before Outerwear). */
  priorChainKey?: string;
}): string {
  return sha256Hex(
    JSON.stringify({
      v: 12,
      avatarHash: params.avatarHash,
      engine: params.engine,
      pass1ItemId: params.pass1ItemId,
      pass1Slot: params.pass1Slot,
      pass1TailorSlice: params.pass1TailorSlice,
      pass1SegFree: params.pass1SegFree,
      highDetail: params.highDetail,
      priorChainKey: params.priorChainKey ?? null,
    })
  );
}

export function getCachedFullOutfit(key: string): FullOutfitCacheEntry | null {
  return getCaches().fullOutfit.get(key);
}

export function setCachedFullOutfit(
  key: string,
  entry: FullOutfitCacheEntry
): void {
  getCaches().fullOutfit.set(key, entry);
}

export function getCachedPass1(key: string): Pass1CacheEntry | null {
  return getCaches().pass1.get(key);
}

export function setCachedPass1(key: string, entry: Pass1CacheEntry): void {
  getCaches().pass1.set(key, entry);
}
