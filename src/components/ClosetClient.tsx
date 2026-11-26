"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { ArrowRight, Check, ChevronDown, Plus, Trash2 } from "lucide-react";
import { deleteWardrobeItem, logWear } from "@/app/closet/actions";
import { Navbar } from "@/components/Navbar";
import { RollingNumber } from "@/components/RollingNumber";
import {
  hydrateStagedOutfitFromStorage,
  readStagedOutfit,
  useViewTransition,
  ViewTransitionStage,
  writeStagedOutfit,
  type StagedOutfitSelection,
} from "@/components/ViewTransitionProvider";
import { UploadCutoutModal } from "@/components/UploadCutoutModal";
import {
  CATEGORY_LABELS,
  WARDROBE_CATEGORIES,
  type WardrobeCategory,
} from "@/lib/categories";
import type { WardrobeItemDTO } from "@/lib/closet";
import { cleanGarmentName } from "@/lib/utils/garmentName";

interface ClosetClientProps {
  initialItems: WardrobeItemDTO[];
  userName?: string | null;
  hideNavbar?: boolean;
  externalUploadOpen?: boolean;
  onExternalUploadOpen?: () => void;
  onExternalUploadClose?: () => void;
  onItemsChange?: (items: WardrobeItemDTO[]) => void;
}

type FilterCategory = "all" | WardrobeCategory;
type SortOption = "recent" | "wears_desc" | "wears_asc";

/** Slot order used for the dock summary and Studio hand-off. */
const SLOT_ORDER: readonly WardrobeCategory[] = [
  "top",
  "outerwear",
  "bottom",
  "shoes",
  "accessory",
];

const EASE = [0.22, 1, 0.36, 1] as const;
const FAST = { duration: 0.22, ease: EASE };

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildStudioHref(selected: WardrobeItemDTO[]): string {
  const params = new URLSearchParams();
  const accessories: string[] = [];
  for (const item of selected) {
    if (item.category === "accessory") {
      accessories.push(item.id);
    } else {
      params.set(item.category, item.id);
    }
  }
  if (accessories.length > 0) params.set("acc", accessories.join(","));
  const query = params.toString();
  return query ? `/canvas?${query}` : "/canvas";
}

function stagedIdsForCloset(
  staged: StagedOutfitSelection | null,
  availableItems: WardrobeItemDTO[]
): string[] {
  if (!staged) return [];
  const byId = new Map(availableItems.map((item) => [item.id, item]));
  const ids: string[] = [];
  if (staged.top && byId.get(staged.top)?.category === "top") {
    ids.push(staged.top);
  }
  if (
    staged.outerwear &&
    byId.get(staged.outerwear)?.category === "outerwear"
  ) {
    ids.push(staged.outerwear);
  }
  if (staged.bottom && byId.get(staged.bottom)?.category === "bottom") {
    ids.push(staged.bottom);
  }
  if (staged.shoes && byId.get(staged.shoes)?.category === "shoes") {
    ids.push(staged.shoes);
  }
  for (const accId of staged.accessories) {
    if (byId.get(accId)?.category === "accessory" && !ids.includes(accId)) {
      ids.push(accId);
    }
  }
  return ids;
}

function toStagedOutfitSelection(
  ids: string[],
  availableItems: WardrobeItemDTO[]
): StagedOutfitSelection {
  const byId = new Map(availableItems.map((item) => [item.id, item]));
  const next: StagedOutfitSelection = {
    top: null,
    outerwear: null,
    bottom: null,
    shoes: null,
    accessories: [],
  };
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) continue;
    if (item.category === "accessory") {
      if (!next.accessories.includes(item.id)) next.accessories.push(item.id);
    } else {
      next[item.category] = item.id;
    }
  }
  return next;
}

export function ClosetClient({
  initialItems,
  userName,
  hideNavbar = false,
  externalUploadOpen,
  onExternalUploadOpen,
  onExternalUploadClose,
  onItemsChange,
}: ClosetClientProps) {
  const router = useRouter();
  const { navigateToView } = useViewTransition();
  const [items, setItems] = useState<WardrobeItemDTO[]>(initialItems);
  const [activeCategory, setActiveCategory] = useState<FilterCategory>("all");
  const [sortBy, setSortBy] = useState<SortOption>("recent");
  const [isUploadOpen, setIsUploadOpen] = useState(false);

  const uploadOpen =
    externalUploadOpen !== undefined ? externalUploadOpen : isUploadOpen;
  const closeUpload = () => {
    if (externalUploadOpen !== undefined) {
      onExternalUploadClose?.();
    } else {
      setIsUploadOpen(false);
    }
  };
  const openUpload = () => {
    if (onExternalUploadOpen) {
      onExternalUploadOpen();
      return;
    }
    setIsUploadOpen(true);
  };

  const [loggingIds, setLoggingIds] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    stagedIdsForCloset(readStagedOutfit(), initialItems)
  );
  const [stageReady, setStageReady] = useState(
    () => readStagedOutfit() !== null
  );
  const [isOpeningStudio, setIsOpeningStudio] = useState(false);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

  useEffect(() => {
    if (stageReady) return;
    const stored = hydrateStagedOutfitFromStorage();
    if (stored) {
      setSelectedIds(stagedIdsForCloset(stored, items));
    }
    setStageReady(true);
  }, [stageReady, items]);

  useEffect(() => {
    if (!stageReady) return;
    writeStagedOutfit(toStagedOutfitSelection(selectedIds, items));
  }, [stageReady, selectedIds, items]);

  useEffect(() => {
    router.prefetch("/canvas");
  }, [router]);

  const selectedItems = useMemo(() => {
    const byId = new Map(items.map((item) => [item.id, item]));
    return selectedIds
      .map((id) => byId.get(id))
      .filter((item): item is WardrobeItemDTO => Boolean(item))
      .sort(
        (a, b) =>
          SLOT_ORDER.indexOf(a.category) - SLOT_ORDER.indexOf(b.category)
      );
  }, [items, selectedIds]);

  const dockSummary = useMemo(() => {
    const categories = SLOT_ORDER.filter((slot) =>
      selectedItems.some((item) => item.category === slot)
    );
    return `${categories.map((slot) => CATEGORY_LABELS[slot]).join(" + ")} selected`;
  }, [selectedItems]);

  const visibleItems = useMemo(() => {
    const filtered =
      activeCategory === "all"
        ? items
        : items.filter((item) => item.category === activeCategory);

    const copy = [...filtered];
    switch (sortBy) {
      case "wears_desc":
        copy.sort((a, b) => b.wearCount - a.wearCount);
        break;
      case "wears_asc":
        copy.sort((a, b) => a.wearCount - b.wearCount);
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

  function toggleSelected(item: WardrobeItemDTO) {
    setSelectedIds((prev) => {
      if (prev.includes(item.id)) return prev.filter((id) => id !== item.id);
      // One piece per slot; accessories stack.
      const keep =
        item.category === "accessory"
          ? prev
          : prev.filter((id) => {
            const other = items.find((candidate) => candidate.id === id);
            return other ? other.category !== item.category : false;
          });
      return [...keep, item.id];
    });
  }

  function openStudio() {
    if (selectedItems.length === 0 || isOpeningStudio) return;
    writeStagedOutfit(toStagedOutfitSelection(selectedIds, items));
    const switchedInMemory = navigateToView(buildStudioHref(selectedItems));
    if (!switchedInMemory) {
      setIsOpeningStudio(true);
    }
  }

  async function handleLogWear(itemId: string) {
    if (loggingIds[itemId]) return;
    setActionError(null);
    setLoggingIds((prev) => ({ ...prev, [itemId]: true }));

    const todayIso = new Date().toISOString().slice(0, 10);
    const previousItems = items;
    const optimisticItems = items.map((item) =>
      item.id === itemId
        ? { ...item, wearCount: item.wearCount + 1, lastWornDate: todayIso }
        : item
    );

    setItems(optimisticItems);
    onItemsChange?.(optimisticItems);

    try {
      const result = await logWear(itemId);
      if (!result.ok) {
        setItems(previousItems);
        onItemsChange?.(previousItems);
        setActionError(result.error || "Unable to log wear. Please try again.");
        return;
      }
      router.refresh();
    } catch {
      setItems(previousItems);
      onItemsChange?.(previousItems);
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
    const nextItems = items.filter((item) => item.id !== itemId);
    setItems(nextItems);
    onItemsChange?.(nextItems);
    setSelectedIds((prev) => prev.filter((id) => id !== itemId));

    try {
      const result = await deleteWardrobeItem(itemId);
      if (!result.ok) {
        setItems(previousItems);
        onItemsChange?.(previousItems);
        setActionError(result.error || "Could not remove piece.");
        return;
      }
      setConfirmDeleteId(null);
      router.refresh();
    } catch {
      setItems(previousItems);
      onItemsChange?.(previousItems);
      setActionError("Network error while removing piece.");
    } finally {
      setDeletingId(null);
    }
  }

  const addButton = (
    <button
      type="button"
      onClick={openUpload}
      className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-[var(--btn-primary-bg)] pr-3.5 pl-3 text-[13px] font-medium whitespace-nowrap text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)]"
    >
      <Plus className="h-3.5 w-3.5" strokeWidth={2} />
      <span>Add</span>
    </button>
  );

  const closetContent = (
    <>
      <main
        className={`mx-auto max-w-[1440px] px-5 pb-[calc(7rem+env(safe-area-inset-bottom))] transition-opacity duration-200 sm:px-8 lg:px-10 ${
          hideNavbar ? "pt-2 sm:pt-3" : "pt-10 sm:pt-14"
        } ${isOpeningStudio ? "opacity-60" : "opacity-100"}`}
      >
        {!hideNavbar && (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="text-[34px] leading-none font-bold tracking-[-0.04em] sm:text-[44px]">
              Closet
            </h1>
            <p className="text-[13px] text-[var(--ink-muted)] tabular-nums">
              {pluralize(items.length, "piece", "pieces")}
            </p>
          </div>
        )}

        {/* Category tabs + sort */}
        <div
          className={`flex items-stretch justify-between gap-4 border-b border-[var(--border-hairline)] ${
            hideNavbar ? "mt-2" : "mt-8"
          }`}
        >
          <div
            role="tablist"
            aria-label="Filter closet by category"
            className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-6 overflow-x-auto sm:gap-8"
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
                  className={`relative inline-flex h-11 shrink-0 items-center text-[13px] transition-colors duration-150 focus-visible:outline-offset-[-2px] ${isActive
                    ? "font-semibold text-[var(--ink-primary)]"
                    : "font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                    }`}
                >
                  {label}
                  {isActive && (
                    <motion.span
                      layoutId="closet-tab-underline"
                      transition={{ duration: 0.26, ease: EASE }}
                      className="absolute inset-x-0 -bottom-px h-[1.5px] bg-[var(--ink-primary)]"
                    />
                  )}
                </button>
              );
            })}
          </div>

          <label className="relative flex shrink-0 items-center">
            <span className="sr-only">Sort pieces</span>
            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortOption)}
              className="h-11 cursor-pointer appearance-none bg-transparent pr-5 text-[13px] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:text-[var(--ink-primary)]"
            >
              <option value="recent">Recent</option>
              <option value="wears_desc">Most worn</option>
              <option value="wears_asc">Least worn</option>
            </select>
            <ChevronDown
              aria-hidden="true"
              className="pointer-events-none absolute right-0 h-3.5 w-3.5 text-[var(--ink-muted)]"
            />
          </label>
        </div>

        {actionError && (
          <div
            role="alert"
            className="mt-6 flex items-center justify-between rounded-[16px] border border-[var(--status-danger-border)] bg-[var(--status-danger-bg)] px-5 py-3 text-[13px] text-[var(--status-danger-ink)]"
          >
            <span>{actionError}</span>
            <button
              type="button"
              onClick={() => setActionError(null)}
              className="text-[12px] font-semibold underline underline-offset-4"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Garment grid */}
              {items.length === 0 ? (
                <section className="flex flex-col items-center justify-center px-6 py-28 text-center">
                  <h2 className="text-[22px] font-semibold tracking-[-0.03em]">
                    Your closet is empty
                  </h2>
                  <p className="mt-2 max-w-[36ch] text-[14px] leading-relaxed text-[var(--ink-muted)]">
                    Add a garment photo and Silho will isolate a clean cutout.
                  </p>
                  <button
                    type="button"
                    onClick={openUpload}
                    className="mt-7 inline-flex h-11 items-center gap-1.5 rounded-full bg-[var(--btn-primary-bg)] px-6 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Add your first piece</span>
                  </button>
                </section>
              ) : visibleItems.length === 0 ? (
                <section className="flex flex-col items-center justify-center px-6 py-24 text-center">
                  <p className="text-[17px] font-semibold tracking-[-0.02em]">
                    No{" "}
                    {activeCategory !== "all"
                      ? CATEGORY_LABELS[activeCategory].toLowerCase()
                      : ""}{" "}
                    pieces yet
                  </p>
                  <div className="mt-5 flex items-center gap-5 text-[13px] font-medium">
                    <button
                      type="button"
                      onClick={() => setActiveCategory("all")}
                      className="text-[var(--ink-muted)] underline-offset-4 transition-colors duration-150 hover:text-[var(--ink-primary)] hover:underline"
                    >
                      Show all
                    </button>
                    <button
                      type="button"
                      onClick={openUpload}
                      className="text-[var(--ink-primary)] underline-offset-4 hover:underline"
                    >
                      Add a piece
                    </button>
                  </div>
                </section>
              ) : (
                <div className="relative mt-8 grid grid-cols-2 gap-x-3.5 gap-y-8 sm:gap-x-5 md:grid-cols-3 xl:grid-cols-4">
                  <AnimatePresence initial={false} mode="popLayout">
                    {visibleItems.map((item) => {
                      const displayName = cleanGarmentName(item.name, item.category);
                      const isSelected = selectedIds.includes(item.id);
                      const isSpotlit = spotlightId === item.id;
                      const isDimmed = spotlightId !== null && !isSpotlit;
                      const isConfirmingDelete = confirmDeleteId === item.id;
                      const isDeleting = deletingId === item.id;
                      const isLogging = Boolean(loggingIds[item.id]);

                      return (
                        <motion.article
                          key={item.id}
                          layout="position"
                          initial={{ opacity: 0, y: 14, scale: 0.98 }}
                          animate={{
                            opacity: isDimmed ? 0.65 : 1,
                            y: 0,
                            scale: 1,
                          }}
                          exit={{ opacity: 0, scale: 0.98 }}
                          transition={{ ...FAST, layout: { duration: 0.26, ease: EASE } }}
                          className="group relative"
                          onPointerEnter={(event) => {
                            if (event.pointerType === "mouse") setSpotlightId(item.id);
                          }}
                          onPointerLeave={() =>
                            setSpotlightId((prev) => (prev === item.id ? null : prev))
                          }
                          onPointerDown={() => setSpotlightId(item.id)}
                          onPointerUp={(event) => {
                            if (event.pointerType !== "mouse") setSpotlightId(null);
                          }}
                          onPointerCancel={() => setSpotlightId(null)}
                          onFocus={(event) => {
                            if (event.target.matches(":focus-visible")) {
                              setSpotlightId(item.id);
                            }
                          }}
                          onBlur={() =>
                            setSpotlightId((prev) => (prev === item.id ? null : prev))
                          }
                        >
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => toggleSelected(item)}
                              aria-pressed={isSelected}
                              className="relative block w-full overflow-hidden rounded-[20px] bg-[var(--bg-tile)] text-left"
                            >
                              <div className="flex aspect-[4/5] items-center justify-center p-8 sm:p-10">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <motion.img
                                  src={item.imageUrl}
                                  alt={displayName}
                                  loading="lazy"
                                  draggable={false}
                                  animate={{
                                    scale: isSpotlit ? 1.04 : 1,
                                    y: isSpotlit ? -4 : 0,
                                    filter: isSpotlit
                                      ? "drop-shadow(0 10px 14px rgba(20, 20, 21, 0.12))"
                                      : "drop-shadow(0 0px 0px rgba(20, 20, 21, 0))",
                                  }}
                                  transition={FAST}
                                  className="max-h-full max-w-full object-contain mix-blend-multiply dark:mix-blend-normal"
                                />
                              </div>

                              {isSelected && (
                                <>
                                  <span
                                    aria-hidden="true"
                                    className="pointer-events-none absolute inset-0 rounded-[20px] border-[1.5px] border-[var(--ink-primary)]"
                                  />
                                  <span
                                    aria-hidden="true"
                                    className="absolute top-3 left-3 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                                  >
                                    <Check className="h-3 w-3" strokeWidth={2.4} />
                                  </span>
                                </>
                              )}
                            </button>

                            {/* Discreet delete control */}
                            <div className="absolute top-2.5 right-2.5 z-10">
                              {isConfirmingDelete ? (
                                <div className="flex items-center gap-3 rounded-full bg-[var(--bg-surface)] px-3 py-1.5 text-[12px] shadow-[0_2px_10px_rgba(0,0,0,0.12)]">
                                  <button
                                    type="button"
                                    onClick={() => handleDelete(item.id)}
                                    disabled={isDeleting}
                                    className="font-semibold text-[var(--ink-primary)] hover:opacity-70 disabled:opacity-45"
                                  >
                                    {isDeleting ? "…" : "Delete"}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    disabled={isDeleting}
                                    className="text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(item.id)}
                                  aria-label={`Delete ${displayName}`}
                                  className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--ink-muted)] opacity-100 transition-all duration-150 hover:bg-[var(--bg-surface)] hover:text-[var(--ink-primary)] focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                                >
                                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.6} />
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Quiet title + wear readout */}
                          <div className="px-1 pt-3">
                            <h2
                              title={displayName}
                              className="truncate text-[14px] font-medium tracking-[-0.01em] text-[var(--ink-primary)]"
                            >
                              {displayName}
                            </h2>
                            <div className="mt-0.5 flex items-center justify-between gap-2 text-[12px] text-[var(--ink-muted)] tabular-nums">
                              <span
                                className="inline-flex items-baseline gap-1"
                                aria-live="polite"
                              >
                                <RollingNumber value={item.wearCount} />
                                <span>{item.wearCount === 1 ? "wear" : "wears"}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => handleLogWear(item.id)}
                                disabled={isLogging}
                                className="-my-2 py-2 pl-2 text-[12px] font-medium text-[var(--ink-secondary)] transition-colors duration-150 hover:text-[var(--ink-primary)] disabled:opacity-50"
                              >
                                Wore today
                              </button>
                            </div>
                          </div>
                        </motion.article>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
            </main>

            {/* Floating outfit dock: bridge into Studio */}
            <AnimatePresence>
              {selectedItems.length > 0 && (
                <motion.div
                  key="outfit-dock"
                  role="region"
                  aria-label="Selected outfit"
                  initial={{ y: 32, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 24, opacity: 0 }}
                  transition={{ duration: 0.26, ease: EASE }}
                  className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
                >
                  <div className="pointer-events-auto flex w-full max-w-[540px] items-center gap-2 rounded-[22px] bg-[var(--btn-primary-bg)] py-2.5 pr-2.5 pl-5 text-[var(--btn-primary-fg)] shadow-[0_14px_36px_rgba(0,0,0,0.2)]">
                    <p className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {dockSummary}
                    </p>
                    <button
                      type="button"
                      onClick={() => setSelectedIds([])}
                      disabled={isOpeningStudio}
                      className="h-10 rounded-full px-3 text-[13px] opacity-70 transition-opacity duration-150 hover:opacity-100 disabled:opacity-40"
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      onClick={openStudio}
                      disabled={isOpeningStudio}
                      className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-[var(--btn-primary-fg)] px-4 text-[13px] font-semibold text-[var(--btn-primary-bg)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-70"
                    >
                      <span>{isOpeningStudio ? "Opening…" : "Open Studio"}</span>
                      <motion.span
                        aria-hidden="true"
                        animate={{ x: isOpeningStudio ? 4 : 0 }}
                        transition={FAST}
                        className="inline-flex"
                      >
                        <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
                      </motion.span>
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {!onExternalUploadOpen && (
              <UploadCutoutModal open={uploadOpen} onClose={closeUpload} />
            )}
          </>
          );

          if (hideNavbar) {
    return closetContent;
  }

          return (
          <MotionConfig reducedMotion="user">
            <div className="min-h-dvh bg-[var(--bg-surface)] text-[var(--ink-primary)] transition-colors duration-150">
              <Navbar userName={userName} actionSlot={addButton} />
              <ViewTransitionStage view="closet">{closetContent}</ViewTransitionStage>
            </div>
          </MotionConfig>
          );
}
