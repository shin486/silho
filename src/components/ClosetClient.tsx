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
  if (days === 0) return "Today";
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
    const deadStockCount = items.filter((item) =>
      isDeadStock(parseIsoDateOnly(item.lastWornDate))
    ).length;

    return {
      totalValue,
      totalWears,
      averageCpw,
      deadStockCount,
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
    <div className="min-h-screen bg-[#F9F8F6] text-[#0E0E0E]">
      <Navbar
        userName={userName}
        actionSlot={
          <button
            type="button"
            onClick={() => setIsUploadOpen(true)}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap bg-[#0E0E0E] px-2.5 text-[12px] font-medium tracking-[0.02em] text-white transition-colors hover:bg-[#2B2B29] sm:px-3.5"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.8} />
            <span className="sm:hidden">Add</span>
            <span className="hidden sm:inline">Add Piece</span>
          </button>
        }
      />

      {/* Editorial Architectural Ledger Header */}
      <section
        aria-label="Wardrobe ledger overview"
        className="border-b border-[#E2E0DA] bg-white"
      >
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 lg:px-10">
          {/* Top Row: Identity + 4-Column Tabular Ledger */}
          <div className="grid grid-cols-1 items-stretch border-b border-[#E2E0DA] lg:grid-cols-12">
            <div className="flex items-baseline justify-between gap-4 py-5 lg:col-span-4 lg:flex-col lg:justify-center lg:border-r lg:border-[#E2E0DA] lg:py-6 lg:pr-8">
              <h1 className="text-[22px] font-medium tracking-[-0.03em] text-[#0E0E0E] sm:text-[26px]">
                Closet Archive
              </h1>
              <span className="text-[11px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase tabular-nums lg:mt-1.5">
                {items.length} {items.length === 1 ? "Piece" : "Pieces"} Cataloged
              </span>
            </div>

            <div className="grid grid-cols-2 border-t border-[#E2E0DA] sm:grid-cols-4 lg:col-span-8 lg:border-t-0">
              <div className="border-r border-b border-[#E2E0DA] py-4 pr-4 sm:border-b-0 sm:px-5 lg:py-6 lg:pl-7">
                <div className="text-[10px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
                  Total Archive
                </div>
                <div className="mt-1.5 text-[20px] leading-none font-semibold tracking-[-0.03em] text-[#0E0E0E] tabular-nums sm:text-[24px]">
                  {formatPeso(metrics.totalValue)}
                </div>
              </div>

              <div className="border-b border-[#E2E0DA] py-4 pl-4 sm:border-r sm:border-b-0 sm:px-5 lg:py-6">
                <div className="text-[10px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
                  Avg. Cost / Wear
                </div>
                <div className="mt-1.5 flex items-baseline gap-1 text-[20px] leading-none font-semibold tracking-[-0.03em] text-[#0E0E0E] tabular-nums sm:text-[24px]">
                  <span>{formatPeso(metrics.averageCpw)}</span>
                  <span className="text-[11px] font-normal tracking-normal text-[#6C6A64]">
                    /wear
                  </span>
                </div>
              </div>

              <div className="border-r border-[#E2E0DA] py-4 pr-4 sm:px-5 lg:py-6">
                <div className="text-[10px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
                  Logged Wears
                </div>
                <div className="mt-1.5 text-[20px] leading-none font-semibold tracking-[-0.03em] text-[#0E0E0E] tabular-nums sm:text-[24px]">
                  {metrics.totalWears}
                </div>
              </div>

              <div className="py-4 pl-4 sm:pl-5 lg:py-6">
                <div className="text-[10px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
                  Unworn 90d+
                </div>
                <div className="mt-1.5 text-[20px] leading-none font-semibold tracking-[-0.03em] text-[#0E0E0E] tabular-nums sm:text-[24px]">
                  {metrics.deadStockCount}
                </div>
              </div>
            </div>
          </div>

          {/* Bottom Row: Uniqlo-Style Horizontal Underline Category Rail + Sort */}
          <div className="flex items-center justify-between gap-4">
            <div
              role="tablist"
              aria-label="Filter wardrobe by category"
              className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-5 overflow-x-auto sm:gap-7"
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
                    className={`relative inline-flex h-12 shrink-0 items-center gap-1.5 text-[12px] tracking-[0.02em] transition-colors ${
                      isActive
                        ? "font-medium text-[#0E0E0E]"
                        : "text-[#6C6A64] hover:text-[#0E0E0E]"
                    }`}
                  >
                    <span>{label}</span>
                    <span
                      className={`text-[11px] tabular-nums ${
                        isActive ? "text-[#0E0E0E]" : "text-[#6C6A64]"
                      }`}
                    >
                      {categoryCounts[cat]}
                    </span>
                    {isActive && (
                      <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="shrink-0 py-2">
              <label className="flex items-center gap-2 text-[12px] text-[#6C6A64]">
                <span className="sr-only">Sort pieces</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="h-9 border border-[#E2E0DA] bg-[#F9F8F6] px-2.5 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E] focus:border-[#0E0E0E]"
                >
                  <option value="recent">Recent</option>
                  <option value="cpw_desc">Highest ₱/wear</option>
                  <option value="cpw_asc">Lowest ₱/wear</option>
                  <option value="wears_desc">Most worn</option>
                </select>
              </label>
            </div>
          </div>
        </div>
      </section>

      {/* Main Swiss-Japanese Shared-Hairline Catalog Grid */}
      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        {actionError && (
          <div
            role="alert"
            className="mb-6 flex items-center justify-between border border-[#D9B4B2] bg-[#FAF2F2] px-4 py-3 text-[13px] text-[#8C1D18]"
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
          <section className="flex flex-col items-center justify-center border border-[#E2E0DA] bg-white px-6 py-24 text-center">
            <div className="flex h-12 w-12 items-center justify-center border border-[#E2E0DA] bg-[#F2F1ED] text-[#0E0E0E]">
              <Shirt className="h-5 w-5" strokeWidth={1.3} />
            </div>
            <h2 className="mt-5 text-[18px] font-medium tracking-[-0.02em] text-[#0E0E0E]">
              Your closet archive is empty
            </h2>
            <p className="mt-1.5 max-w-[40ch] text-[13px] leading-relaxed text-[#4A4945]">
              Upload your first garment photo to isolate a clean transparent
              cutout and begin measuring cost per wear.
            </p>
            <button
              type="button"
              onClick={() => setIsUploadOpen(true)}
              className="mt-6 inline-flex h-10 items-center gap-2 bg-[#0E0E0E] px-5 text-[12px] font-medium tracking-[0.02em] text-white transition-colors hover:bg-[#2B2B29]"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add First Piece</span>
            </button>
          </section>
        ) : visibleItems.length === 0 ? (
          <section className="flex flex-col items-center justify-center border border-[#E2E0DA] bg-white px-6 py-20 text-center">
            <p className="text-[15px] font-medium tracking-[-0.015em] text-[#0E0E0E]">
              No{" "}
              {activeCategory !== "all"
                ? CATEGORY_LABELS[activeCategory].toLowerCase()
                : ""}{" "}
              pieces yet
            </p>
            <p className="mt-1.5 text-[13px] text-[#4A4945]">
              Add a garment in this category or switch back to your full archive.
            </p>
            <div className="mt-6 flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setActiveCategory("all")}
                className="h-9 border border-[#E2E0DA] bg-white px-4 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E]"
              >
                Show all
              </button>
              <button
                type="button"
                onClick={() => setIsUploadOpen(true)}
                className="inline-flex h-9 items-center gap-1.5 bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Add Piece</span>
              </button>
            </div>
          </section>
        ) : (
          <div className="grid grid-cols-2 border-t border-l border-[#E2E0DA] md:grid-cols-3 xl:grid-cols-4">
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
                  className="group flex flex-col border-r border-b border-[#E2E0DA] bg-white"
                >
                  {/* Warm Chalk-Stone Studio Stage */}
                  <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden bg-[#F2F1ED] p-3.5 sm:p-6">
                    <span className="absolute top-2.5 left-2.5 text-[9px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase sm:top-3.5 sm:left-3.5 sm:text-[10px]">
                      {CATEGORY_LABELS[item.category]}
                    </span>

                    {/* Discreet Delete Control */}
                    <div className="absolute top-2 right-2 z-10 sm:top-3 sm:right-3">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1 border border-[#0E0E0E] bg-white p-1">
                          <button
                            type="button"
                            onClick={() => handleDelete(item.id)}
                            disabled={isDeleting}
                            className="bg-[#0E0E0E] px-2 py-1 text-[10px] font-medium text-white hover:bg-[#2B2B29] disabled:opacity-50 sm:text-[11px]"
                          >
                            {isDeleting ? "…" : "Delete"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            disabled={isDeleting}
                            className="px-1.5 py-1 text-[10px] text-[#4A4945] hover:text-[#0E0E0E] sm:text-[11px]"
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
                          className="flex h-8 w-8 items-center justify-center border border-[#E2E0DA] bg-white/90 text-[#6C6A64] opacity-100 transition-opacity hover:border-[#0E0E0E] hover:text-[#0E0E0E] focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.6} />
                        </button>
                      )}
                    </div>

                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.imageUrl}
                      alt={item.name}
                      loading="lazy"
                      className="max-h-full max-w-full object-contain drop-shadow-[0_14px_20px_rgba(14,14,14,0.09)] transition-transform duration-300 ease-out group-hover:scale-[1.035]"
                    />

                    {deadStock && (
                      <span className="absolute bottom-2.5 left-2.5 bg-[#0E0E0E] px-2 py-0.5 text-[9px] font-medium tracking-[0.12em] text-white uppercase sm:bottom-3.5 sm:left-3.5 sm:text-[10px]">
                        90d+ Unworn
                      </span>
                    )}
                  </div>

                  {/* Hangtag Spec Footer */}
                  <div className="flex flex-1 flex-col justify-between bg-white p-3 sm:p-4">
                    <div>
                      <h2 className="truncate text-[13px] font-medium tracking-[-0.01em] text-[#0E0E0E] sm:text-[14px]">
                        {item.name}
                      </h2>

                      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#6C6A64] tabular-nums">
                        <span>
                          {item.wearCount}{" "}
                          {item.wearCount === 1 ? "wear" : "wears"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{formatLastWornLabel(lastWorn)}</span>
                      </div>

                      <div className="mt-2.5 flex items-baseline justify-between gap-2 border-t border-[#E2E0DA]/80 pt-2.5">
                        {item.price > 0 ? (
                          <>
                            <div className="flex items-baseline gap-0.5 tabular-nums">
                              <span className="text-[15px] font-semibold tracking-[-0.02em] text-[#0E0E0E] sm:text-[17px]">
                                {formatPeso(cpw)}
                              </span>
                              <span className="text-[10px] text-[#6C6A64] sm:text-[11px]">
                                /wear
                              </span>
                            </div>
                            <span className="shrink-0 text-[11px] text-[#6C6A64] tabular-nums sm:text-[12px]">
                              {formatPeso(item.price)}
                            </span>
                          </>
                        ) : (
                          <span className="text-[11px] tracking-[0.06em] text-[#6C6A64] uppercase">
                            Archive piece
                          </span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleLogWear(item.id)}
                      disabled={isLogging}
                      className={`mt-3 flex h-9 w-full items-center justify-center gap-1.5 border text-[11px] font-medium tracking-[0.04em] uppercase transition-colors disabled:opacity-55 sm:text-[12px] ${
                        isJustLogged
                          ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                          : "border-[#E2E0DA] bg-[#F9F8F6] text-[#0E0E0E] hover:border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-white"
                      }`}
                    >
                      {isLogging ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>Logging</span>
                        </>
                      ) : isJustLogged ? (
                        <>
                          <Check className="h-3.5 w-3.5" strokeWidth={2} />
                          <span>Worn Today</span>
                        </>
                      ) : (
                        <span>+ Worn Today</span>
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
