import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/drizzle";
import { wardrobeItems, wearLogs } from "@/db/schema";
import type { WardrobeCategory } from "@/lib/categories";

export interface WardrobeItemDTO {
  id: string;
  name: string;
  category: WardrobeCategory;
  price: number;
  imageUrl: string;
  createdAt: string;
  wearCount: number;
  lastWornDate: string | null;
}

export async function getUserWardrobe(
  userId: string
): Promise<WardrobeItemDTO[]> {
  const rows = await db
    .select({
      id: wardrobeItems.id,
      name: wardrobeItems.name,
      category: wardrobeItems.category,
      price: wardrobeItems.price,
      imageUrl: wardrobeItems.imageUrl,
      createdAt: wardrobeItems.createdAt,
      wearCount: sql<number>`count(${wearLogs.id})::int`,
      lastWornDate: sql<string | null>`max(${wearLogs.wornDate})`,
    })
    .from(wardrobeItems)
    .leftJoin(
      wearLogs,
      and(eq(wearLogs.itemId, wardrobeItems.id), eq(wearLogs.userId, userId))
    )
    .where(eq(wardrobeItems.userId, userId))
    .groupBy(wardrobeItems.id)
    .orderBy(desc(wardrobeItems.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    price: Number.parseFloat(row.price) || 0,
    imageUrl: row.imageUrl,
    createdAt: row.createdAt.toISOString(),
    wearCount: Number(row.wearCount) || 0,
    lastWornDate: row.lastWornDate ?? null,
  }));
}
