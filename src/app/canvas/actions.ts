"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/drizzle";
import { bodyProfiles, savedLooks, wardrobeItems } from "@/db/schema";
import type { BodyProfileDTO, SavedLookDTO } from "@/lib/canvas";
import { isPreferredFit, type PreferredFit } from "@/lib/fitPreferences";
import { isPresetModelUrl } from "@/lib/presetModels";
import { getSession } from "@/lib/session";

export interface UpsertBodyProfileInput {
  avatarUrl: string;
  heightCm: number;
  weightKg: number;
  preferredFit: PreferredFit;
}

export interface UpsertBodyProfileResult {
  ok: boolean;
  error?: string;
  data?: BodyProfileDTO;
}

export interface SaveLookInput {
  itemId?: string | null;
  imageUrl: string;
  label: string;
}

export interface SaveLookResult {
  ok: boolean;
  error?: string;
  data?: SavedLookDTO;
}

export interface DeleteLookResult {
  ok: boolean;
  error?: string;
}

const MAX_IMAGE_DATA_URL_LENGTH = 5_500_000;

export async function upsertBodyProfile(
  input: UpsertBodyProfileInput
): Promise<UpsertBodyProfileResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      error: "Your session expired. Sign in again to save your Body Profile.",
    };
  }

  // TODO: swap for Cloudinary/Object Storage
  const avatarUrl = input.avatarUrl.trim();
  const isValidImage =
    avatarUrl.startsWith("data:image/") ||
    avatarUrl.startsWith("https://") ||
    avatarUrl.startsWith("http://") ||
    isPresetModelUrl(avatarUrl);

  if (!isValidImage || avatarUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return {
      ok: false,
      error: "Upload a valid full-body photo or select a preset model.",
    };
  }

  const heightCm = Math.round(Number(input.heightCm));
  if (!Number.isFinite(heightCm) || heightCm < 100 || heightCm > 250) {
    return {
      ok: false,
      error: "Enter a height between 100 cm and 250 cm.",
    };
  }

  const weightKg = Math.round(Number(input.weightKg));
  if (!Number.isFinite(weightKg) || weightKg < 30 || weightKg > 250) {
    return {
      ok: false,
      error: "Enter a weight between 30 kg and 250 kg.",
    };
  }

  if (!isPreferredFit(input.preferredFit)) {
    return {
      ok: false,
      error: "Select Slim, Regular, or Oversized for preferred fit.",
    };
  }

  try {
    const now = new Date();
    const [saved] = await db
      .insert(bodyProfiles)
      .values({
        userId: session.user.id,
        avatarUrl,
        heightCm,
        weightKg,
        preferredFit: input.preferredFit,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: bodyProfiles.userId,
        set: {
          avatarUrl,
          heightCm,
          weightKg,
          preferredFit: input.preferredFit,
          updatedAt: now,
        },
      })
      .returning({
        id: bodyProfiles.id,
        avatarUrl: bodyProfiles.avatarUrl,
        heightCm: bodyProfiles.heightCm,
        weightKg: bodyProfiles.weightKg,
        preferredFit: bodyProfiles.preferredFit,
        updatedAt: bodyProfiles.updatedAt,
      });

    revalidatePath("/canvas");

    return {
      ok: true,
      data: {
        id: saved.id,
        avatarUrl: saved.avatarUrl,
        heightCm: saved.heightCm,
        weightKg: saved.weightKg,
        preferredFit: saved.preferredFit,
        updatedAt: saved.updatedAt.toISOString(),
      },
    };
  } catch (error) {
    console.error("[upsertBodyProfile] failed:", error);
    return {
      ok: false,
      error: "Could not save your Body Profile. Please try again.",
    };
  }
}

export async function saveLook(input: SaveLookInput): Promise<SaveLookResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      error: "Your session expired. Sign in again to save looks.",
    };
  }

  const label = input.label.trim();
  if (!label || label.length > 120) {
    return {
      ok: false,
      error: "Enter a look title between 1 and 120 characters.",
    };
  }

  const imageUrl = input.imageUrl.trim();
  const isValidImage =
    imageUrl.startsWith("data:image/") ||
    imageUrl.startsWith("https://") ||
    imageUrl.startsWith("http://");

  if (!isValidImage || imageUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return {
      ok: false,
      error: "Could not save this try-on image. Generate a new look and retry.",
    };
  }

  try {
    let verifiedItemId: string | null = null;
    if (input.itemId) {
      const [owned] = await db
        .select({ id: wardrobeItems.id })
        .from(wardrobeItems)
        .where(
          and(
            eq(wardrobeItems.id, input.itemId),
            eq(wardrobeItems.userId, session.user.id)
          )
        )
        .limit(1);
      verifiedItemId = owned?.id ?? null;
    }

    const [inserted] = await db
      .insert(savedLooks)
      .values({
        userId: session.user.id,
        itemId: verifiedItemId,
        imageUrl,
        label,
      })
      .returning({
        id: savedLooks.id,
        itemId: savedLooks.itemId,
        imageUrl: savedLooks.imageUrl,
        label: savedLooks.label,
        createdAt: savedLooks.createdAt,
      });

    revalidatePath("/canvas");

    return {
      ok: true,
      data: {
        id: inserted.id,
        itemId: inserted.itemId,
        imageUrl: inserted.imageUrl,
        label: inserted.label,
        createdAt: inserted.createdAt.toISOString(),
      },
    };
  } catch (error) {
    console.error("[saveLook] failed:", error);
    return {
      ok: false,
      error: "Could not save this look to your Lookbook. Please try again.",
    };
  }
}

export async function deleteLook(id: string): Promise<DeleteLookResult> {
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      error: "Your session expired. Sign in again.",
    };
  }

  if (!id) {
    return { ok: false, error: "Missing look identifier." };
  }

  try {
    await db
      .delete(savedLooks)
      .where(
        and(eq(savedLooks.id, id), eq(savedLooks.userId, session.user.id))
      );

    revalidatePath("/canvas");

    return { ok: true };
  } catch (error) {
    console.error("[deleteLook] failed:", error);
    return {
      ok: false,
      error: "Could not delete this look. Please try again.",
    };
  }
}
