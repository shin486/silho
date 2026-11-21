"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db/drizzle";
import { wardrobeItems, wearLogs } from "@/db/schema";
import { isWardrobeCategory, type WardrobeCategory } from "@/lib/categories";
import { getSession } from "@/lib/session";

export interface AddWardrobeItemInput {
  name: string;
  category: WardrobeCategory;
  price?: number | null;
  imageUrl: string;
}

export interface ActionResult<T = undefined> {
  ok: boolean;
  error?: string;
  data?: T;
}

const MAX_IMAGE_DATA_URL_LENGTH = 5_500_000;

export async function addWardrobeItem(
  input: AddWardrobeItemInput
): Promise<ActionResult<{ id: string }>> {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "Your session expired. Sign in again to save pieces." };
  }

  const trimmedName = input.name.trim();
  if (!trimmedName || trimmedName.length > 120) {
    return { ok: false, error: "Enter a piece name between 1 and 120 characters." };
  }

  if (!isWardrobeCategory(input.category)) {
    return { ok: false, error: "Select a valid wardrobe category." };
  }

  const hasProvidedPrice =
    input.price !== undefined && input.price !== null && input.price !== 0;
  const numericPrice = hasProvidedPrice ? Number(input.price) : 0;
  if (
    !Number.isFinite(numericPrice) ||
    numericPrice < 0 ||
    numericPrice > 99_999_999.99
  ) {
    return { ok: false, error: "Enter a valid purchase price in PHP." };
  }

  const imageUrl = input.imageUrl.trim();
  const isValidImage =
    imageUrl.startsWith("data:image/") ||
    imageUrl.startsWith("https://") ||
    imageUrl.startsWith("http://");

  if (!isValidImage || imageUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
    return {
      ok: false,
      error: "The garment cutout could not be saved. Try uploading a smaller image.",
    };
  }

  try {
    const [inserted] = await db
      .insert(wardrobeItems)
      .values({
        userId: session.user.id,
        name: trimmedName,
        category: input.category,
        price: numericPrice.toFixed(2),
        imageUrl,
      })
      .returning({ id: wardrobeItems.id });

    revalidatePath("/closet");
    revalidatePath("/canvas");

    return { ok: true, data: { id: inserted.id } };
  } catch (error) {
    console.error("[addWardrobeItem] failed:", error);
    return {
      ok: false,
      error: "Could not save this piece to your closet. Please try again.",
    };
  }
}

export async function logWear(itemId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "Your session expired. Sign in again to log wears." };
  }

  if (!itemId) {
    return { ok: false, error: "Missing piece identifier." };
  }

  try {
    const [ownedItem] = await db
      .select({ id: wardrobeItems.id })
      .from(wardrobeItems)
      .where(
        and(
          eq(wardrobeItems.id, itemId),
          eq(wardrobeItems.userId, session.user.id)
        )
      )
      .limit(1);

    if (!ownedItem) {
      return { ok: false, error: "Piece not found in your closet." };
    }

    await db.insert(wearLogs).values({
      userId: session.user.id,
      itemId: ownedItem.id,
    });

    revalidatePath("/closet");
    revalidatePath("/canvas");

    return { ok: true };
  } catch (error) {
    console.error("[logWear] failed:", error);
    return {
      ok: false,
      error: "Unable to record today's wear. Please try again.",
    };
  }
}

export async function logOutfitWear(itemIds: string[]): Promise<ActionResult<{ loggedCount: number }>> {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "Your session expired. Sign in again to log an outfit." };
  }

  const uniqueIds = Array.from(new Set(itemIds.filter(Boolean)));
  if (uniqueIds.length === 0) {
    return { ok: false, error: "Select at least one piece on the canvas first." };
  }

  try {
    const ownedItems = await db
      .select({ id: wardrobeItems.id })
      .from(wardrobeItems)
      .where(
        and(
          eq(wardrobeItems.userId, session.user.id),
          inArray(wardrobeItems.id, uniqueIds)
        )
      );

    if (ownedItems.length === 0) {
      return { ok: false, error: "No matching pieces found in your closet." };
    }

    await db.insert(wearLogs).values(
      ownedItems.map((item) => ({
        userId: session.user.id,
        itemId: item.id,
      }))
    );

    revalidatePath("/closet");
    revalidatePath("/canvas");

    return { ok: true, data: { loggedCount: ownedItems.length } };
  } catch (error) {
    console.error("[logOutfitWear] failed:", error);
    return {
      ok: false,
      error: "Unable to record wears for this fit. Please try again.",
    };
  }
}

export async function deleteWardrobeItem(itemId: string): Promise<ActionResult> {
  const session = await getSession();
  if (!session) {
    return { ok: false, error: "Your session expired. Sign in again." };
  }

  if (!itemId) {
    return { ok: false, error: "Missing piece identifier." };
  }

  try {
    await db
      .delete(wardrobeItems)
      .where(
        and(
          eq(wardrobeItems.id, itemId),
          eq(wardrobeItems.userId, session.user.id)
        )
      );

    revalidatePath("/closet");
    revalidatePath("/canvas");

    return { ok: true };
  } catch (error) {
    console.error("[deleteWardrobeItem] failed:", error);
    return {
      ok: false,
      error: "Could not remove this piece. Please try again.",
    };
  }
}
