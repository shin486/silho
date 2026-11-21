"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Plus, Shirt, Trash2 } from "lucide-react";
import { deleteWardrobeItem, logWear } from "@/app/closet/actions";
import { Navbar } from "@/components/Navbar";
import { UploadCutoutModal } from "@/components/UploadCutoutModal";
import {
  CATEGORY_LABELS,
  WARDROBE_CATEGORIES,
  type WardrobeCategory,
} from "@/lib/categories";
import type { WardrobeItemDTO } from "@/lib/closet";
import {
  calculateCostPerWear,
  formatPeso,
  getDaysSinceLastWorn,
  isDeadStock,
} from "@/lib/utils/costPerWear";

interface ClosetClientProps {
  initialItems: WardrobeItemDTO[];
  userName?: string | null;
}

type FilterCategory = "all" | WardrobeCategory;
type SortOption = "recent" | "cpw_desc" | "cpw_asc" | "wears_desc";

function parseIsoDateOnly(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLastWornLabel(lastWornDate: Date | null): string {
  const days = getDaysSinceLastWorn(lastWornDate);
  if (days === null) return "Unworn";
  if (days === 0) return "Worn today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export function ClosetClient({ initialItems, userName }: ClosetClientProps) {
  const router = useRouter();
  const [items, setItems] = useState<WardrobeItemDTO[]>(initialItems);
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const [loggingIds, setLoggingIds] = useState<Record<string, boolean>>({});
  const [justLoggedIds, setJustLoggedIds] = useState<Record<string, boolean>>(
    {}
  );
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  const categoryCounts = useMemo(() => {
    const counts: Record<FilterCategory, number> = {
      all: items.length,
      top: 0,
      bottom: 0,
      outerwear: 0,
      shoes: 0,
      accessory: 0,
    };
    for (const item of items) {
      counts[item.category] += 1;
    }
    return counts;
  }, [items]);

  const metrics = useMemo(() => {
    const pricedItems = items.filter((item) => item.price > 0);
    const totalValue = pricedItems.reduce((sum, item) => sum + item.price, 0);
    const totalWears = items.reduce((sum, item) => sum + item.wearCount, 0);
    const averageCpw =
      pricedItems.length > 0
        ? pricedItems.reduce(
            (sum, item) =>
              sum + calculateCostPerWear(item.price, item.wearCount),
            0
          ) / pricedItems.length
        : 0;

    return {
      totalValue,
      totalWears,
      averageCpw,
    };
  }, [items]);

  const visibleItems = useMemo(() => {
    const filtered =
      activeCategory === "all"
        ? items
        : items.filter((item) => item.category === activeCategory);

    const copy = [...filtered];
    switch (sortBy) {
      case "cpw_desc":
        copy.sort(
          (a, b) =>
            calculateCostPerWear(b.price, b.wearCount) -
            calculateCostPerWear(a.price, a.wearCount)
        );
        break;
      case "cpw_asc":
        copy.sort(
          (a, b) =>
            calculateCostPerWear(a.price, a.wearCount) -
            calculateCostPerWear(b.price, b.wearCount)
        );
        break;
      case "wears_desc":
        copy.sort((a, b) => b.wearCount - a.wearCount);
        break;
      case "recent":
      default:
        copy.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        break;
    }

    return copy;
  }, [items, activeCategory, sortBy]);

  async function handleLogWear(itemId: string) {
    if (loggingIds[itemId]) return;
    setActionError(null);
    setLoggingIds((prev) => ({ ...prev, [itemId]: true }));

    const todayIso = new Date().toISOString().slice(0, 10);
    const previousItems = items;

    // Optimistically reflect the wear increment and recalculated cost-per-wear.
    setItems((prev) =>
      prev.map((item) =>
        item.id === itemId
          ? {
              ...item,
              wearCount: item.wearCount + 1,
              lastWornDate: todayIso,
            }
          : item
      )
    );

    try {
      const result = await logWear(itemId);
      if (!result.ok) {
        setItems(previousItems);
        setActionError(result.error || "Unable to log wear. Please try again.");
        return;
      }

      setJustLoggedIds((prev) => ({ ...prev, [itemId]: true }));
      window.setTimeout(() => {
        setJustLoggedIds((prev) => {
          const next = { ...prev };
          delete next[itemId];
          return next;
        });
      }, 1400);

      router.refresh();
    } catch {
      setItems(previousItems);
      setActionError("Network error while logging wear. Please try again.");
    } finally {
      setLoggingIds((prev) => {
        const next = { ...prev };
        delete next[itemId];
        return next;
      });
    }
  }

  async function handleDelete(itemId: string) {
    setActionError(null);
    setDeletingId(itemId);

    const previousItems = items;
    setItems((prev) => prev.filter((item) => item.id !== itemId));

    try {
      const result = await deleteWardrobeItem(itemId);
      if (!result.ok) {
        setItems(previousItems);
        setActionError(result.error || "Could not remove piece.");
        return;
      }
      setConfirmDeleteId(null);
      router.refresh();
    } catch {
      setItems(previousItems);
      setActionError("Network error while removing piece.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#111111]">
      <Navbar
        userName={userName}
        metricsSlot={
          <div className="flex items-center gap-6 text-[12px]">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[#6B6B6B]">Total Value</span>
              <span className="font-medium text-[#111111] tabular-nums">
                {formatPeso(metrics.totalValue)}
              </span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[#6B6B6B]">Avg. Cost / Wear</span>
              <span className="font-medium text-[#111111] tabular-nums">
                {formatPeso(metrics.averageCpw)}
                <span className="font-normal text-[#6B6B6B]">/wear</span>
              </span>
            </div>
          </div>
        }
        actionSlot={
          <button
            type="button"
            onClick={() => setIsUploadOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 bg-[#111111] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Piece</span>
          </button>
        }
      />

      {/* Sub-header ledger (mobile metrics + category filter pills + sort) */}
      <div className="border-b border-[#E5E5E5] bg-white">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
          {/* Compact metrics row visible below lg */}
          <div className="grid grid-cols-3 divide-x divide-[#E5E5E5] border-b border-[#E5E5E5] py-3 lg:hidden">
            <div className="pr-3">
              <div className="text-[11px] text-[#6B6B6B]">Total Value</div>
              <div className="mt-0.5 text-[14px] font-medium text-[#111111] tabular-nums">
                {formatPeso(metrics.totalValue)}
              </div>
            </div>
            <div className="px-3">
              <div className="text-[11px] text-[#6B6B6B]">Avg. ₱ / Wear</div>
              <div className="mt-0.5 text-[14px] font-medium text-[#111111] tabular-nums">
                {formatPeso(metrics.averageCpw)}
              </div>
            </div>
            <div className="pl-3">
              <div className="text-[11px] text-[#6B6B6B]">Total Wears</div>
              <div className="mt-0.5 text-[14px] font-medium text-[#111111] tabular-nums">
                {metrics.totalWears}
              </div>
            </div>
          </div>

          {/* Category filter pills + sort */}
          <div className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div
              role="tablist"
              aria-label="Filter wardrobe by category"
              className="flex flex-wrap items-center gap-1.5"
            >
              {(["all", ...WARDROBE_CATEGORIES] as const).map((cat) => {
                const isActive = activeCategory === cat;
                const label = cat === "all" ? "All" : CATEGORY_LABELS[cat];
                return (
                  <button
                    key={cat}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveCategory(cat)}
                    className={`inline-flex h-8 items-center gap-1.5 border px-3 text-[12px] transition-colors ${
                      isActive
                        ? "border-[#111111] bg-[#111111] font-medium text-white"
                        : "border-[#E5E5E5] bg-white text-[#525252] hover:border-[#111111] hover:text-[#111111]"
                    }`}
                  >
                    <span>{label}</span>
                    <span
                      className={`text-[11px] tabular-nums ${
                        isActive ? "text-white/75" : "text-[#6B6B6B]"
                      }`}
                    >
                      {categoryCounts[cat]}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-3">
              <span className="hidden text-[12px] text-[#6B6B6B] tabular-nums sm:inline">
                {metrics.totalWears}{" "}
                {metrics.totalWears === 1 ? "wear" : "wears"} logged
              </span>
              <label className="flex items-center gap-2 text-[12px] text-[#6B6B6B]">
                <span className="sr-only">Sort pieces</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="h-8 border border-[#E5E5E5] bg-white px-2.5 text-[12px] text-[#111111] transition-colors hover:border-[#111111] focus:border-[#111111] focus:outline-none"
                >
                  <option value="recent">Sort: Recent</option>
                  <option value="cpw_desc">Sort: Highest ₱/wear</option>
                  <option value="cpw_asc">Sort: Lowest ₱/wear</option>
                  <option value="wears_desc">Sort: Most worn</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </div>

      {/* Main Wardrobe Gallery */}
      <main className="mx-auto max-w-[1400px] px-4 py-7 sm:px-6 lg:px-8">
        {actionError && (
          <div
            role="alert"
            className="mb-6 flex items-center justify-between border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-2.5 text-[13px] text-[#991B1B]"
          >
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-[12px] font-medium underline underline-offset-4"
            >
              Dismiss
            </button>
          </div>
        )}

        {items.length === 0 ? (
          <section className="flex flex-col items-center justify-center border border-dashed border-[#D4D4D4] bg-white px-6 py-24 text-center">
            <div className="flex h-12 w-12 items-center justify-center border border-[#E5E5E5] bg-[#FAFAFA] text-[#111111]">
              <Shirt className="h-5 w-5" strokeWidth={1.25} />
            </div>
            <h1 className="mt-5 text-[16px] font-medium text-[#111111]">
              Your closet archive is empty
            </h1>
            <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-[#525252]">
              Upload your first garment photo to isolate a clean transparent
              cutout and begin tracking cost per wear.
            </p>
            <button
              type="button"
              onClick={() => setIsUploadOpen(true)}
              className="mt-6 inline-flex h-9 items-center gap-1.5 bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Piece</span>
            </button>
          </section>
        ) : visibleItems.length === 0 ? (
          <section className="flex flex-col items-center justify-center border border-dashed border-[#D4D4D4] bg-white px-6 py-20 text-center">
            <p className="text-[14px] font-medium text-[#111111]">
              No {activeCategory !== "all" ? CATEGORY_LABELS[activeCategory].toLowerCase() : ""} pieces yet
            </p>
            <p className="mt-1 text-[13px] text-[#525252]">
              Add a piece in this category or switch back to your full closet.
            </p>
            <div className="mt-5 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setActiveCategory("all")}
                className="h-8 border border-[#E5E5E5] bg-white px-3 text-[12px] font-medium text-[#111111] transition-colors hover:border-[#111111]"
              >
                Show all
              </button>
              <button
                type="button"
                onClick={() => setIsUploadOpen(true)}
                className="inline-flex h-8 items-center gap-1.5 bg-[#111111] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Piece</span>
              </button>
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleItems.map((item) => {
              const cpw = calculateCostPerWear(item.price, item.wearCount);
              const lastWorn = parseIsoDateOnly(item.lastWornDate);
              const deadStock = isDeadStock(lastWorn);
              const isLogging = Boolean(loggingIds[item.id]);
              const isJustLogged = Boolean(justLoggedIds[item.id]);
              const isConfirmingDelete = confirmDeleteId === item.id;
              const isDeleting = deletingId === item.id;

              return (
                <article
                  key={item.id}
                  className="group flex flex-col border border-[#E5E5E5] bg-white transition-colors hover:border-[#CCCCCC]"
                >
                  {/* Neutral Garment Cutout Stage */}
                  <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-[#F4F4F3] p-6">
                    <span className="absolute top-3 left-3 text-[10px] font-medium tracking-[0.1em] text-[#525252] uppercase">
                      {CATEGORY_LABELS[item.category]}
                    </span>

                    {item.price > 0 && (
                      <span
                        title="Live cost per wear"
                        className="absolute top-3 right-3 border border-[#E5E5E5] bg-white px-2 py-0.5 text-[11px] font-medium text-[#111111] tabular-nums"
                      >
                        {formatPeso(cpw)}/wear
                      </span>
                    )}

                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      loading="lazy"
                      className="max-h-full max-w-full object-contain drop-shadow-[0_12px_18px_rgba(17,17,17,0.08)] transition-transform duration-300 group-hover:scale-[1.02]"
                    />

                    {deadStock && (
                      <span className="absolute bottom-3 left-3 border border-[#D6D3D1] bg-[#FAFAF9]/95 px-2 py-0.5 text-[10px] font-medium tracking-[0.04em] text-[#57534E]">
                        90d+ unworn
                      </span>
                    )}

                    {/* Discreet inline delete control */}
                    <div className="absolute right-3 bottom-3">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1 border border-[#E5E5E5] bg-white p-1">
                          <button
                            type="button"
                            onClick={() => handleDelete(item.id)}
                            disabled={isDeleting}
                            className="bg-[#111111] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#262626] disabled:opacity-50"
                          >
                            {isDeleting ? "…" : "Delete"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={isDeleting}
                            className="px-1.5 py-0.5 text-[11px] text-[#525252] hover:text-[#111111]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(item.id)}
                          aria-label={`Delete ${item.name}`}
                          title="Delete piece"
                          className="flex h-7 w-7 items-center justify-center border border-[#E5E5E5] bg-white/90 text-[#6B6B6B] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:border-[#111111] hover:text-[#111111]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Editorial Ledger Footer */}
                  <div className="flex flex-1 flex-col justify-between gap-3 border-t border-[#E5E5E5] p-4">
                    <div>
                      <div className="flex items-baseline justify-between gap-3">
                        <h2 className="truncate text-[14px] font-medium text-[#111111]">
                          {item.name}
                        </h2>
                        {item.price > 0 && (
                          <span className="shrink-0 text-[13px] text-[#525252] tabular-nums">
                            {formatPeso(item.price)}
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center justify-between text-[12px] text-[#6B6B6B]">
                        <span className="tabular-nums">
                          {item.wearCount}{" "}
                          {item.wearCount === 1 ? "wear" : "wears"}
                        </span>
                        <span>{formatLastWornLabel(lastWorn)}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleLogWear(item.id)}
                      disabled={isLogging}
                      className={`flex h-9 w-full items-center justify-center gap-1.5 border text-[12px] font-medium transition-colors disabled:opacity-60 ${
                        isJustLogged
                          ? "border-[#111111] bg-[#111111] text-white"
                          : "border-[#E5E5E5] bg-white text-[#111111] hover:border-[#111111] hover:bg-[#111111] hover:text-white"
                      }`}
                    >
                      {isLogging ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Logging…</span>
                        </>
                      ) : isJustLogged ? (
                        <>
                          <Check className="h-3.5 w-3.5" />
                          <span>Worn Today</span>
                        </>
                      ) : (
                        <span>+1 Worn Today</span>
                      )}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      <UploadCutoutModal
        open={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
      />
    </div>
  );
}
