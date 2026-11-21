import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db/drizzle";
import { bodyProfiles, savedLooks, tryonUsage } from "@/db/schema";
import { TRYON_DAILY_LIMIT, type PreferredFit } from "@/lib/fitPreferences";

export interface BodyProfileDTO {
  id: string;
  avatarUrl: string;
  heightCm: number;
  weightKg: number;
  preferredFit: PreferredFit;
  updatedAt: string;
}

export interface TryOnQuotaDTO {
  used: number;
  limit: number;
  remaining: number | null;
  unlimited: boolean;
}

export interface SavedLookDTO {
  id: string;
  itemId: string | null;
  imageUrl: string;
  label: string;
  createdAt: string;
}

export async function getUserBodyProfile(
  userId: string
): Promise<BodyProfileDTO | null> {
  const [profile] = await db
    .select({
      id: bodyProfiles.id,
      avatarUrl: bodyProfiles.avatarUrl,
      heightCm: bodyProfiles.heightCm,
      weightKg: bodyProfiles.weightKg,
      preferredFit: bodyProfiles.preferredFit,
      updatedAt: bodyProfiles.updatedAt,
    })
    .from(bodyProfiles)
    .where(eq(bodyProfiles.userId, userId))
    .limit(1);

  if (!profile) {
    return null;
  }

  return {
    id: profile.id,
    avatarUrl: profile.avatarUrl,
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    preferredFit: profile.preferredFit,
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export async function getTryOnQuota(userId: string): Promise<TryOnQuotaDTO> {
  const isUnlimited = process.env.TRYON_UNLIMITED === "true";
  if (isUnlimited) {
    return {
      used: 0,
      limit: TRYON_DAILY_LIMIT,
      remaining: null,
      unlimited: true,
    };
  }

  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [row] = await db
    .select({
      used: sql<number>`count(${tryonUsage.id})::int`,
    })
    .from(tryonUsage)
    .where(
      and(
        eq(tryonUsage.userId, userId),
        gte(tryonUsage.createdAt, windowStart)
      )
    );

  const used = Number(row?.used) || 0;
  const remaining = Math.max(0, TRYON_DAILY_LIMIT - used);

  return {
    used,
    limit: TRYON_DAILY_LIMIT,
    remaining,
    unlimited: false,
  };
}

export async function getUserSavedLooks(
  userId: string
): Promise<SavedLookDTO[]> {
  const rows = await db
    .select({
      id: savedLooks.id,
      itemId: savedLooks.itemId,
      imageUrl: savedLooks.imageUrl,
      label: savedLooks.label,
      createdAt: savedLooks.createdAt,
    })
    .from(savedLooks)
    .where(eq(savedLooks.userId, userId))
    .orderBy(desc(savedLooks.createdAt));

  return rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    imageUrl: row.imageUrl,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
  }));
}
