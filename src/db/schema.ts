import { relations } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { WardrobeCategory } from "@/lib/categories";
import type { PreferredFit } from "@/lib/fitPreferences";

// ---------------------------------------------------------------------------
// Better Auth standard PostgreSQL tables
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_id_idx").on(table.userId)]
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_user_id_idx").on(table.userId)]
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)]
);

// ---------------------------------------------------------------------------
// Silho domain tables
// ---------------------------------------------------------------------------

export const wardrobeItems = pgTable(
  "wardrobe_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category").$type<WardrobeCategory>().notNull(),
    price: numeric("price", { precision: 10, scale: 2 }).notNull(),
    imageUrl: text("image_url").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("wardrobe_items_user_id_idx").on(table.userId),
    index("wardrobe_items_user_category_idx").on(table.userId, table.category),
  ]
);

export const wearLogs = pgTable(
  "wear_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => wardrobeItems.id, { onDelete: "cascade" }),
    wornDate: date("worn_date").defaultNow().notNull(),
  },
  (table) => [
    index("wear_logs_user_id_idx").on(table.userId),
    index("wear_logs_item_id_idx").on(table.itemId),
  ]
);

export const tryonUsage = pgTable(
  "tryon_usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("tryon_usage_user_id_idx").on(table.userId)]
);

export const bodyProfiles = pgTable("body_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  // TODO: swap for Cloudinary/Object Storage
  avatarUrl: text("avatar_url").notNull(),
  heightCm: integer("height_cm").notNull(),
  weightKg: integer("weight_kg").notNull(),
  preferredFit: text("preferred_fit")
    .$type<PreferredFit>()
    .notNull()
    .default("regular"),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const savedLooks = pgTable(
  "saved_looks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    itemId: uuid("item_id").references(() => wardrobeItems.id, {
      onDelete: "set null",
    }),
    imageUrl: text("image_url").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("saved_looks_user_id_idx").on(table.userId)]
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const userRelations = relations(user, ({ one, many }) => ({
  sessions: many(session),
  accounts: many(account),
  wardrobeItems: many(wardrobeItems),
  wearLogs: many(wearLogs),
  tryonUsages: many(tryonUsage),
  bodyProfile: one(bodyProfiles),
  savedLooks: many(savedLooks),
}));

export const wardrobeItemsRelations = relations(
  wardrobeItems,
  ({ one, many }) => ({
    owner: one(user, {
      fields: [wardrobeItems.userId],
      references: [user.id],
    }),
    wearLogs: many(wearLogs),
    savedLooks: many(savedLooks),
  })
);

export const wearLogsRelations = relations(wearLogs, ({ one }) => ({
  owner: one(user, {
    fields: [wearLogs.userId],
    references: [user.id],
  }),
  item: one(wardrobeItems, {
    fields: [wearLogs.itemId],
    references: [wardrobeItems.id],
  }),
}));

export const tryonUsageRelations = relations(tryonUsage, ({ one }) => ({
  owner: one(user, {
    fields: [tryonUsage.userId],
    references: [user.id],
  }),
}));

export const bodyProfilesRelations = relations(bodyProfiles, ({ one }) => ({
  owner: one(user, {
    fields: [bodyProfiles.userId],
    references: [user.id],
  }),
}));

export const savedLooksRelations = relations(savedLooks, ({ one }) => ({
  owner: one(user, {
    fields: [savedLooks.userId],
    references: [user.id],
  }),
  item: one(wardrobeItems, {
    fields: [savedLooks.itemId],
    references: [wardrobeItems.id],
  }),
}));

export type WardrobeItemRecord = typeof wardrobeItems.$inferSelect;
export type NewWardrobeItemRecord = typeof wardrobeItems.$inferInsert;
export type WearLogRecord = typeof wearLogs.$inferSelect;
export type BodyProfileRecord = typeof bodyProfiles.$inferSelect;
export type SavedLookRecord = typeof savedLooks.$inferSelect;
