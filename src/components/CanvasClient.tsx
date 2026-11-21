"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bookmark,
  BookMarked,
  Check,
  Layers,
  Loader2,
  Pencil,
  RotateCcw,
  Shuffle,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { deleteLook, saveLook } from "@/app/canvas/actions";
import { logOutfitWear, logWear } from "@/app/closet/actions";
import { BodyProfileModal } from "@/components/BodyProfileModal";
import { Navbar } from "@/components/Navbar";
import type { BodyProfileDTO, SavedLookDTO } from "@/lib/canvas";
import {
  CATEGORY_LABELS,
  WARDROBE_CATEGORIES,
  type WardrobeCategory,
} from "@/lib/categories";
import type { WardrobeItemDTO } from "@/lib/closet";
import { PREFERRED_FIT_LABELS } from "@/lib/fitPreferences";
import { calculateCostPerWear, formatPeso } from "@/lib/utils/costPerWear";

interface CanvasClientProps {
  items: WardrobeItemDTO[];
  initialBodyProfile: BodyProfileDTO | null;
  initialSavedLooks: SavedLookDTO[];
  initialRemaining: number | null;
  isUnlimited: boolean;
  dailyLimit: number;
  userName?: string | null;
}

type StudioMode = "tryon" | "board" | "lookbook";
type TryOnFilter = "all" | WardrobeCategory;
type OutfitSelection = Partial<Record<WardrobeCategory, string>>;

interface PreviewedOutfitSnapshot {
  upperId: string | null;
  lowerId: string | null;
  styledIds: string[];
  label: string;
}

const TRYON_FILTERS: readonly { id: TryOnFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "top", label: CATEGORY_LABELS.top },
  { id: "bottom", label: CATEGORY_LABELS.bottom },
  { id: "outerwear", label: CATEGORY_LABELS.outerwear },
  { id: "shoes", label: CATEGORY_LABELS.shoes },
  { id: "accessory", label: CATEGORY_LABELS.accessory },
];

const SLOT_ORDER: WardrobeCategory[] = [
  "outerwear",
  "top",
  "bottom",
  "shoes",
  "accessory",
];

function formatSavedDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function buildOutfitLabel(pieces: WardrobeItemDTO[]): string {
  const joined = pieces.map((p) => p.name.trim()).filter(Boolean).join(" + ");
  if (!joined) return "Saved Fit";
  return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
}

export function CanvasClient({
  items,
  initialBodyProfile,
  initialSavedLooks,
  initialRemaining,
  isUnlimited,
  dailyLimit,
  userName,
}: CanvasClientProps) {
  const router = useRouter();
  const [mode, setMode] = useState<StudioMode>("tryon");

  // Shared studio state
  const [bodyProfile, setBodyProfile] = useState<BodyProfileDTO | null>(
    initialBodyProfile
  );
  const [savedLooks, setSavedLooks] =
    useState<SavedLookDTO[]>(initialSavedLooks);
  const [remaining, setRemaining] = useState<number | null>(initialRemaining);
  const [unlimited, setUnlimited] = useState<boolean>(isUnlimited);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);

  // Multi-slot AI Try-On selection (1 Upper + 1 Lower + optional Shoes & Accessories)
  const [tryOnFilter, setTryOnFilter] = useState<TryOnFilter>("all");
  const [selectedUpperId, setSelectedUpperId] = useState<string | null>(null);
  const [selectedLowerId, setSelectedLowerId] = useState<string | null>(null);
  const [selectedShoesId, setSelectedShoesId] = useState<string | null>(null);
  const [selectedAccessoryIds, setSelectedAccessoryIds] = useState<string[]>(
    []
  );

  // Try-On result state
  const [tryOnResultUrl, setTryOnResultUrl] = useState<string | null>(null);
  const [previewedOutfit, setPreviewedOutfit] =
    useState<PreviewedOutfitSnapshot | null>(null);
  const [viewStage, setViewStage] = useState<"after" | "before">("after");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingPasses, setGeneratingPasses] = useState<1 | 2>(1);
  const [tryOnError, setTryOnError] = useState<string | null>(null);
  const [tryOnBusyFallback, setTryOnBusyFallback] = useState(false);

  // Quick log wear state
  const [isLoggingTryOnWear, setIsLoggingTryOnWear] = useState(false);
  const [loggedTryOnKey, setLoggedTryOnKey] = useState<string | null>(null);

  // Lookbook save & delete state
  const [isSavingLook, setIsSavingLook] = useState(false);
  const [savedCurrentResultKey, setSavedCurrentResultKey] = useState<
    string | null
  >(null);
  const [confirmDeleteLookId, setConfirmDeleteLookId] = useState<string | null>(
    null
  );
  const [deletingLookId, setDeletingLookId] = useState<string | null>(null);
  const [lookbookError, setLookbookError] = useState<string | null>(null);

  // Layer Board state
  const [selectedBySlot, setSelectedBySlot] = useState<OutfitSelection>({});
  const [activeSlot, setActiveSlot] = useState<WardrobeCategory>("top");
  const [isLoggingOutfit, startLogOutfitTransition] = useTransition();
  const [boardFeedback, setBoardFeedback] = useState<string | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);

  useEffect(() => {
    setBodyProfile(initialBodyProfile);
  }, [initialBodyProfile]);

  useEffect(() => {
    setSavedLooks(initialSavedLooks);
  }, [initialSavedLooks]);

  useEffect(() => {
    setRemaining(initialRemaining);
    setUnlimited(isUnlimited);
  }, [initialRemaining, isUnlimited]);

  const itemsById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items]
  );

  const itemsByCategory = useMemo(() => {
    const grouped: Record<WardrobeCategory, WardrobeItemDTO[]> = {
      top: [],
      bottom: [],
      outerwear: [],
      shoes: [],
      accessory: [],
    };
    for (const item of items) {
      grouped[item.category].push(item);
    }
    return grouped;
  }, [items]);

  const tryOnFilterCounts: Record<TryOnFilter, number> = useMemo(
    () => ({
      all: items.length,
      top: itemsByCategory.top.length,
      bottom: itemsByCategory.bottom.length,
      outerwear: itemsByCategory.outerwear.length,
      shoes: itemsByCategory.shoes.length,
      accessory: itemsByCategory.accessory.length,
    }),
    [items.length, itemsByCategory]
  );

  const tryOnVisibleItems = useMemo(() => {
    if (tryOnFilter === "all") return items;
    return items.filter((item) => item.category === tryOnFilter);
  }, [items, tryOnFilter]);

  const selectedUpperItem = selectedUpperId
    ? itemsById.get(selectedUpperId) ?? null
    : null;
  const selectedLowerItem = selectedLowerId
    ? itemsById.get(selectedLowerId) ?? null
    : null;
  const selectedShoesItem = selectedShoesId
    ? itemsById.get(selectedShoesId) ?? null
    : null;
  const selectedAccessoryItems = useMemo(
    () =>
      selectedAccessoryIds
        .map((id) => itemsById.get(id) ?? null)
        .filter((item): item is WardrobeItemDTO => item !== null),
    [selectedAccessoryIds, itemsById]
  );

  const styledWithItems = useMemo(() => {
    const list: WardrobeItemDTO[] = [];
    if (selectedShoesItem) list.push(selectedShoesItem);
    for (const acc of selectedAccessoryItems) list.push(acc);
    return list;
  }, [selectedShoesItem, selectedAccessoryItems]);

  const allSelectedOutfitItems = useMemo(() => {
    const list: WardrobeItemDTO[] = [];
    if (selectedUpperItem) list.push(selectedUpperItem);
    if (selectedLowerItem) list.push(selectedLowerItem);
    for (const styled of styledWithItems) list.push(styled);
    return list;
  }, [selectedUpperItem, selectedLowerItem, styledWithItems]);

  const selectedOutfitSummary = useMemo(
    () =>
      allSelectedOutfitItems
        .map((item) => item.name.trim().toUpperCase())
        .join(" + "),
    [allSelectedOutfitItems]
  );

  const canRunTryOnGarments = Boolean(selectedUpperItem || selectedLowerItem);
  const isFullOutfitPass = Boolean(selectedUpperItem && selectedLowerItem);

  // Layer Board derived metrics
  const selectedBoardItems = useMemo(() => {
    return SLOT_ORDER.map((slot) => {
      const id = selectedBySlot[slot];
      return id ? itemsById.get(id) ?? null : null;
    }).filter((item): item is WardrobeItemDTO => item !== null);
  }, [selectedBySlot, itemsById]);

  const fitValue = useMemo(
    () => selectedBoardItems.reduce((sum, item) => sum + item.price, 0),
    [selectedBoardItems]
  );

  const fitCostPerWear = useMemo(
    () =>
      selectedBoardItems.reduce(
        (sum, item) => sum + calculateCostPerWear(item.price, item.wearCount),
        0
      ),
    [selectedBoardItems]
  );

  const isRateLimited = !unlimited && (remaining ?? 0) <= 0;
  const quotaBadgeText = unlimited
    ? "Unlimited · Test Mode"
    : `${remaining ?? 0}/${dailyLimit} left today`;

  function toggleTryOnPiece(item: WardrobeItemDTO) {
    setTryOnError(null);
    if (item.category === "top" || item.category === "outerwear") {
      setSelectedUpperId((prev) => (prev === item.id ? null : item.id));
      return;
    }
    if (item.category === "bottom") {
      setSelectedLowerId((prev) => (prev === item.id ? null : item.id));
      return;
    }
    if (item.category === "shoes") {
      setSelectedShoesId((prev) => (prev === item.id ? null : item.id));
      return;
    }
    if (item.category === "accessory") {
      setSelectedAccessoryIds((prev) =>
        prev.includes(item.id)
          ? prev.filter((id) => id !== item.id)
          : [...prev, item.id]
      );
    }
  }

  function isTryOnPieceSelected(item: WardrobeItemDTO): boolean {
    if (item.category === "top" || item.category === "outerwear") {
      return selectedUpperId === item.id;
    }
    if (item.category === "bottom") {
      return selectedLowerId === item.id;
    }
    if (item.category === "shoes") {
      return selectedShoesId === item.id;
    }
    return selectedAccessoryIds.includes(item.id);
  }

  function getSlotTag(category: WardrobeCategory): string {
    if (category === "top" || category === "outerwear") return "Upper";
    if (category === "bottom") return "Lower";
    return "Styled";
  }

  function clearSelectedOutfit() {
    setSelectedUpperId(null);
    setSelectedLowerId(null);
    setSelectedShoesId(null);
    setSelectedAccessoryIds([]);
    setTryOnError(null);
  }

  function removeStyledPiece(item: WardrobeItemDTO) {
    if (item.category === "shoes") {
      setSelectedShoesId(null);
    } else if (item.category === "accessory") {
      setSelectedAccessoryIds((prev) => prev.filter((id) => id !== item.id));
    }
  }

  async function handleRunTryOn() {
    if (!bodyProfile || !canRunTryOnGarments || isGenerating || isRateLimited) {
      return;
    }

    const passes: 1 | 2 = isFullOutfitPass ? 2 : 1;
    setGeneratingPasses(passes);
    setTryOnError(null);
    setTryOnBusyFallback(false);
    setIsGenerating(true);

    try {
      const response = await fetch("/api/tryon", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          upperItemId: selectedUpperItem?.id,
          lowerItemId: selectedLowerItem?.id,
        }),
      });

      const payload = (await response.json().catch(() => null)) as {
        resultUrl?: string;
        remaining?: number | null;
        unlimited?: boolean;
        error?: string;
      } | null;

      if (typeof payload?.unlimited === "boolean") {
        setUnlimited(payload.unlimited);
      }

      if (payload?.remaining === null || typeof payload?.remaining === "number") {
        setRemaining(payload.remaining);
      }

      if (!response.ok || !payload?.resultUrl) {
        setTryOnError(
          payload?.error ||
            "AI try-on server is currently busy. Try again in a moment or use the Layer Board."
        );
        setTryOnBusyFallback(response.status === 503 || response.status >= 500);
        return;
      }

      setTryOnResultUrl(payload.resultUrl);
      setPreviewedOutfit({
        upperId: selectedUpperItem?.id ?? null,
        lowerId: selectedLowerItem?.id ?? null,
        styledIds: styledWithItems.map((s) => s.id),
        label: buildOutfitLabel(allSelectedOutfitItems),
      });
      setSavedCurrentResultKey(null);
      setViewStage("after");
      router.refresh();
    } catch {
      setTryOnError(
        "AI try-on server is currently busy. Try again in a moment or use the Layer Board."
      );
      setTryOnBusyFallback(true);
    } finally {
      setIsGenerating(false);
    }
  }

  // Build dynamic Lookbook label incorporating all currently selected pieces (including newly toggled Shoes/Accessories)
  const currentLookLabel = useMemo(() => {
    if (allSelectedOutfitItems.length > 0) {
      return buildOutfitLabel(allSelectedOutfitItems);
    }
    return previewedOutfit?.label || "Saved Fit";
  }, [allSelectedOutfitItems, previewedOutfit]);

  const currentResultSaveKey = tryOnResultUrl
    ? `${tryOnResultUrl.slice(0, 64)}::${currentLookLabel}`
    : null;
  const isCurrentLookSaved =
    Boolean(currentResultSaveKey) &&
    savedCurrentResultKey === currentResultSaveKey;

  async function handleSaveLook() {
    if (!tryOnResultUrl || isSavingLook || isCurrentLookSaved) return;

    setTryOnError(null);
    setIsSavingLook(true);

    try {
      const primaryItemId =
        previewedOutfit?.upperId ??
        previewedOutfit?.lowerId ??
        selectedUpperId ??
        selectedLowerId ??
        null;

      const result = await saveLook({
        itemId: primaryItemId,
        imageUrl: tryOnResultUrl,
        label: currentLookLabel,
      });

      if (!result.ok || !result.data) {
        setTryOnError(result.error || "Could not save this look.");
        return;
      }

      setSavedLooks((prev) => [result.data!, ...prev]);
      setSavedCurrentResultKey(currentResultSaveKey);
      router.refresh();
    } catch {
      setTryOnError("Network error while saving look. Please try again.");
    } finally {
      setIsSavingLook(false);
    }
  }

  async function handleDeleteLook(id: string) {
    setLookbookError(null);
    setDeletingLookId(id);
    const previous = savedLooks;
    setSavedLooks((prev) => prev.filter((look) => look.id !== id));

    try {
      const result = await deleteLook(id);
      if (!result.ok) {
        setSavedLooks(previous);
        setLookbookError(result.error || "Could not delete this look.");
        return;
      }
      setConfirmDeleteLookId(null);
      router.refresh();
    } catch {
      setSavedLooks(previous);
      setLookbookError("Network error while deleting look.");
    } finally {
      setDeletingLookId(null);
    }
  }

  const loggableTryOnIds = useMemo(() => {
    if (allSelectedOutfitItems.length > 0) {
      return allSelectedOutfitItems.map((i) => i.id);
    }
    if (!previewedOutfit) return [];
    return [
      previewedOutfit.upperId,
      previewedOutfit.lowerId,
      ...previewedOutfit.styledIds,
    ].filter((id): id is string => Boolean(id));
  }, [allSelectedOutfitItems, previewedOutfit]);

  const loggableTryOnKey = loggableTryOnIds.join(",");

  async function handleLogTryOnWear() {
    if (loggableTryOnIds.length === 0 || isLoggingTryOnWear) return;
    setTryOnError(null);
    setIsLoggingTryOnWear(true);

    try {
      const result =
        loggableTryOnIds.length === 1
          ? await logWear(loggableTryOnIds[0])
          : await logOutfitWear(loggableTryOnIds);

      if (!result.ok) {
        setTryOnError(result.error || "Unable to log wear right now.");
        return;
      }

      setLoggedTryOnKey(loggableTryOnKey);
      window.setTimeout(() => {
        setLoggedTryOnKey((curr) => (curr === loggableTryOnKey ? null : curr));
      }, 1800);
      router.refresh();
    } finally {
      setIsLoggingTryOnWear(false);
    }
  }

  // Layer Board actions
  function togglePiece(item: WardrobeItemDTO) {
    setBoardFeedback(null);
    setBoardError(null);
    setSelectedBySlot((prev) => ({
      ...prev,
      [item.category]: prev[item.category] === item.id ? undefined : item.id,
    }));
  }

  function clearSlot(category: WardrobeCategory) {
    setSelectedBySlot((prev) => ({ ...prev, [category]: undefined }));
  }

  function clearAll() {
    setSelectedBySlot({});
    setBoardFeedback(null);
    setBoardError(null);
  }

  function shuffleFit() {
    setBoardFeedback(null);
    setBoardError(null);
    const next: OutfitSelection = {};
    for (const category of WARDROBE_CATEGORIES) {
      const pool = itemsByCategory[category];
      if (pool.length > 0) {
        next[category] = pool[Math.floor(Math.random() * pool.length)].id;
      }
    }
    setSelectedBySlot(next);
  }

  function handleLogOutfit() {
    if (selectedBoardItems.length === 0) return;
    setBoardError(null);
    setBoardFeedback(null);
    const ids = selectedBoardItems.map((item) => item.id);

    startLogOutfitTransition(async () => {
      const result = await logOutfitWear(ids);
      if (!result.ok) {
        setBoardError(result.error || "Could not log wears for this fit.");
        return;
      }
      setBoardFeedback(
        `Logged +1 wear for ${result.data?.loggedCount ?? ids.length} ${
          (result.data?.loggedCount ?? ids.length) === 1 ? "piece" : "pieces"
        }.`
      );
      router.refresh();
    });
  }

  const slotItems = itemsByCategory[activeSlot];
  const activeModelSrc =
    tryOnResultUrl && viewStage === "after"
      ? tryOnResultUrl
      : bodyProfile?.avatarUrl ?? "";

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#111111]">
      <Navbar
        userName={userName}
        metricsSlot={
          mode === "board" ? (
            <div className="flex items-center gap-5 text-[12px]">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[#6B6B6B]">Fit Value</span>
                <span className="font-medium text-[#111111] tabular-nums">
                  {formatPeso(fitValue)}
                </span>
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[#6B6B6B]">Fit CPW</span>
                <span className="font-medium text-[#111111] tabular-nums">
                  {formatPeso(fitCostPerWear)}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-5 text-[12px]">
              <div className="flex items-baseline gap-1.5">
                <span className="text-[#6B6B6B]">
                  {unlimited ? "Try-On" : "Daily Try-Ons"}
                </span>
                <span className="font-medium text-[#111111] tabular-nums">
                  {quotaBadgeText}
                </span>
              </div>
              {bodyProfile && (
                <div className="flex items-baseline gap-1.5 text-[#525252] tabular-nums">
                  <span>{bodyProfile.heightCm} cm</span>
                  <span>·</span>
                  <span>{bodyProfile.weightKg} kg</span>
                  <span>·</span>
                  <span>{PREFERRED_FIT_LABELS[bodyProfile.preferredFit]}</span>
                </div>
              )}
            </div>
          )
        }
        actionSlot={
          mode === "board" ? (
            <button
              type="button"
              onClick={handleLogOutfit}
              disabled={selectedBoardItems.length === 0 || isLoggingOutfit}
              className="inline-flex h-8 items-center gap-1.5 bg-[#111111] px-3 text-[12px] font-medium text-white transition-colors hover:bg-[#262626] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {isLoggingOutfit ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span>Log Fit Worn</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIsProfileModalOpen(true)}
              className="inline-flex h-8 items-center gap-1.5 border border-[#E5E5E5] bg-white px-3 text-[12px] font-medium text-[#111111] transition-colors hover:border-[#111111]"
            >
              <UserRound className="h-3.5 w-3.5" />
              <span>{bodyProfile ? "Edit Profile" : "Body Profile"}</span>
            </button>
          )
        }
      />

      {/* Mode Switch Toolbar */}
      <div className="border-b border-[#E5E5E5] bg-white">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <div
            role="tablist"
            aria-label="Canvas mode"
            className="inline-flex flex-wrap border border-[#E5E5E5] bg-[#FAFAFA] p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "tryon"}
              onClick={() => setMode("tryon")}
              className={`inline-flex h-8 items-center gap-1.5 px-3.5 text-[12px] font-medium transition-colors ${
                mode === "tryon"
                  ? "bg-[#111111] text-white"
                  : "text-[#525252] hover:text-[#111111]"
              }`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>AI Try-On</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "board"}
              onClick={() => setMode("board")}
              className={`inline-flex h-8 items-center gap-1.5 px-3.5 text-[12px] font-medium transition-colors ${
                mode === "board"
                  ? "bg-[#111111] text-white"
                  : "text-[#525252] hover:text-[#111111]"
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Layer Board</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "lookbook"}
              onClick={() => setMode("lookbook")}
              className={`inline-flex h-8 items-center gap-1.5 px-3.5 text-[12px] font-medium transition-colors ${
                mode === "lookbook"
                  ? "bg-[#111111] text-white"
                  : "text-[#525252] hover:text-[#111111]"
              }`}
            >
              <BookMarked className="h-3.5 w-3.5" />
              <span>Lookbook</span>
              <span
                className={`ml-0.5 text-[11px] tabular-nums ${
                  mode === "lookbook" ? "text-white/80" : "text-[#6B6B6B]"
                }`}
              >
                {savedLooks.length}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-3 text-[12px] text-[#525252]">
            {mode === "tryon" && (
              <span className="border border-[#E5E5E5] bg-[#FAFAFA] px-2.5 py-1 text-[11px] font-medium text-[#111111] tabular-nums">
                {quotaBadgeText}
              </span>
            )}
            {mode === "board" && (
              <span className="tabular-nums">
                {selectedBoardItems.length} / {SLOT_ORDER.length} slots active
              </span>
            )}
            {mode === "lookbook" && (
              <span className="tabular-nums">
                {savedLooks.length}{" "}
                {savedLooks.length === 1 ? "saved look" : "saved looks"}
              </span>
            )}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[1400px] px-4 py-7 sm:px-6 lg:px-8">
        {mode === "tryon" ? (
          /* ----------------------------------------------------------------
           * AI TRY-ON STUDIO (Multi-Piece CatVTON: Upper + Lower + Styled With)
           * ---------------------------------------------------------------- */
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left Panel: Your Model */}
            <section className="flex flex-col border border-[#E5E5E5] bg-white lg:col-span-6">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E5E5E5] px-5 py-3.5">
                <div className="flex items-center gap-3">
                  <h1 className="text-[14px] font-medium text-[#111111]">
                    Your Model
                  </h1>
                  <span className="border border-[#E5E5E5] bg-[#FAFAFA] px-2 py-0.5 text-[11px] text-[#525252] tabular-nums">
                    {quotaBadgeText}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {bodyProfile && tryOnResultUrl && (
                    <div
                      role="group"
                      aria-label="Compare before and after"
                      className="inline-flex border border-[#E5E5E5] bg-white"
                    >
                      <button
                        type="button"
                        onClick={() => setViewStage("before")}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          viewStage === "before"
                            ? "bg-[#111111] text-white"
                            : "text-[#525252] hover:text-[#111111]"
                        }`}
                      >
                        Before
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewStage("after")}
                        className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          viewStage === "after"
                            ? "bg-[#111111] text-white"
                            : "text-[#525252] hover:text-[#111111]"
                        }`}
                      >
                        After
                      </button>
                    </div>
                  )}

                  {bodyProfile && (
                    <button
                      type="button"
                      onClick={() => setIsProfileModalOpen(true)}
                      disabled={isGenerating}
                      className="inline-flex h-7 items-center gap-1.5 border border-[#E5E5E5] bg-white px-2.5 text-[11px] font-medium text-[#111111] transition-colors hover:border-[#111111] disabled:opacity-40"
                    >
                      <Pencil className="h-3 w-3" />
                      <span>Edit Profile</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Model Stage */}
              <div className="relative flex min-h-[500px] flex-1 items-center justify-center bg-[#F4F4F3] p-6">
                {!bodyProfile ? (
                  <div className="mx-auto flex max-w-[340px] flex-col items-center text-center">
                    <div className="flex h-12 w-12 items-center justify-center border border-[#E5E5E5] bg-white text-[#111111]">
                      <UserRound className="h-5 w-5" strokeWidth={1.25} />
                    </div>
                    <h2 className="mt-5 text-[15px] font-medium text-[#111111]">
                      Set up your Body Profile
                    </h2>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-[#525252]">
                      Frame your own 3:4 portrait or select a preset studio
                      model to drape upper and lower pieces together.
                    </p>
                    <button
                      type="button"
                      onClick={() => setIsProfileModalOpen(true)}
                      className="mt-6 inline-flex h-9 items-center gap-2 bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
                    >
                      <UserRound className="h-3.5 w-3.5" />
                      <span>Set Up Body Profile</span>
                    </button>
                  </div>
                ) : (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={activeModelSrc}
                      alt={
                        tryOnResultUrl && viewStage === "after"
                          ? "Virtual try-on result"
                          : "Your Body Profile model"
                      }
                      className={`max-h-[560px] w-full object-contain transition-opacity duration-200 ${
                        isGenerating ? "opacity-35 blur-[2px]" : "opacity-100"
                      }`}
                    />

                    {tryOnResultUrl && previewedOutfit && !isGenerating && (
                      <span className="absolute top-3 left-3 max-w-[85%] truncate border border-[#E5E5E5] bg-white/95 px-2.5 py-1 text-[11px] font-medium text-[#111111]">
                        {viewStage === "after"
                          ? `Try-On · ${previewedOutfit.label}`
                          : "Original Model"}
                      </span>
                    )}

                    {isGenerating && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center bg-white/75 px-6 text-center backdrop-blur-[2px]">
                        <Loader2 className="h-5 w-5 animate-spin text-[#111111]" />
                        <p className="mt-3 text-[13px] font-medium text-[#111111]">
                          {generatingPasses === 2
                            ? "Draping full outfit (2 passes)… ~30–45s"
                            : "Draping garment onto your silhouette… ~15–30s"}
                        </p>
                        {selectedOutfitSummary && (
                          <p className="mt-1 max-w-[34ch] truncate text-[11px] tracking-[0.04em] text-[#525252]">
                            {selectedOutfitSummary}
                          </p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Styled With Strip (Selected Shoes & Accessories directly below Model Preview) */}
              {styledWithItems.length > 0 && (
                <div className="border-t border-[#E5E5E5] bg-[#FAFAFA] px-5 py-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[11px] font-medium tracking-[0.06em] text-[#525252] uppercase">
                      Styled With
                    </span>
                    <span className="text-[11px] text-[#6B6B6B] tabular-nums">
                      {styledWithItems.length}{" "}
                      {styledWithItems.length === 1 ? "piece" : "pieces"}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2.5">
                    {styledWithItems.map((piece) => (
                      <div
                        key={piece.id}
                        className="group flex items-center gap-2.5 border border-[#E5E5E5] bg-white pr-2"
                      >
                        <div className="flex h-12 w-12 shrink-0 items-center justify-center bg-[#F4F4F3] p-1.5">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={piece.imageUrl}
                            alt={piece.name}
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                        <div className="min-w-0 py-1">
                          <div className="max-w-[140px] truncate text-[12px] font-medium text-[#111111]">
                            {piece.name}
                          </div>
                          <div className="text-[10px] tracking-[0.04em] text-[#6B6B6B] uppercase">
                            {CATEGORY_LABELS[piece.category]}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeStyledPiece(piece)}
                          disabled={isGenerating}
                          aria-label={`Remove ${piece.name}`}
                          className="ml-0.5 flex h-5 w-5 items-center justify-center text-[#6B6B6B] transition-colors hover:text-[#111111] disabled:opacity-40"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Error banner */}
              {tryOnError && (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-[#DC2626]/25 bg-[#FEF2F2] px-5 py-3 text-[12px] text-[#991B1B]"
                >
                  <span>{tryOnError}</span>
                  {tryOnBusyFallback && (
                    <button
                      type="button"
                      onClick={() => setMode("board")}
                      className="shrink-0 font-medium underline underline-offset-4 hover:opacity-75"
                    >
                      Open Layer Board
                    </button>
                  )}
                </div>
              )}

              {/* Bottom Spec Bar & Quick Actions (Save Look + Log Worn Today) */}
              {bodyProfile && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E5E5E5] bg-white px-5 py-3">
                  <div className="flex items-center gap-2 text-[12px] text-[#525252] tabular-nums">
                    <span className="font-medium text-[#111111]">
                      {bodyProfile.heightCm} cm
                    </span>
                    <span className="text-[#CCCCCC]">·</span>
                    <span className="font-medium text-[#111111]">
                      {bodyProfile.weightKg} kg
                    </span>
                    <span className="text-[#CCCCCC]">·</span>
                    <span>
                      {PREFERRED_FIT_LABELS[bodyProfile.preferredFit]}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {tryOnResultUrl && (
                      <button
                        type="button"
                        onClick={() => void handleSaveLook()}
                        disabled={
                          isSavingLook || isGenerating || isCurrentLookSaved
                        }
                        className={`inline-flex h-8 items-center gap-1.5 border px-3 text-[12px] font-medium transition-colors disabled:opacity-60 ${
                          isCurrentLookSaved
                            ? "border-[#111111] bg-[#111111] text-white"
                            : "border-[#E5E5E5] bg-white text-[#111111] hover:border-[#111111] hover:bg-[#111111] hover:text-white"
                        }`}
                      >
                        {isSavingLook ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : isCurrentLookSaved ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : (
                          <Bookmark className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {isCurrentLookSaved ? "Saved Look" : "Save Look"}
                        </span>
                      </button>
                    )}

                    {loggableTryOnIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void handleLogTryOnWear()}
                        disabled={isLoggingTryOnWear || isGenerating}
                        className={`inline-flex h-8 items-center gap-1.5 border px-3 text-[12px] font-medium transition-colors disabled:opacity-40 ${
                          loggedTryOnKey === loggableTryOnKey
                            ? "border-[#111111] bg-[#111111] text-white"
                            : "border-[#E5E5E5] bg-white text-[#111111] hover:border-[#111111] hover:bg-[#111111] hover:text-white"
                        }`}
                      >
                        {isLoggingTryOnWear ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : loggedTryOnKey === loggableTryOnKey ? (
                          <Check className="h-3.5 w-3.5" />
                        ) : null}
                        <span>
                          {loggedTryOnKey === loggableTryOnKey
                            ? "Worn Today"
                            : "Log Worn Today"}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </section>

            {/* Right Panel: Your Closet (Multi-Slot Selection) */}
            <section className="flex flex-col border border-[#E5E5E5] bg-white lg:col-span-6">
              <div className="border-b border-[#E5E5E5] px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[14px] font-medium text-[#111111]">
                      Your Closet
                    </h2>
                    <p className="mt-0.5 text-[12px] text-[#525252]">
                      Pick 1 Upper, 1 Lower, plus optional Shoes &amp;
                      Accessories.
                    </p>
                  </div>

                  {allSelectedOutfitItems.length > 0 && (
                    <button
                      type="button"
                      onClick={clearSelectedOutfit}
                      disabled={isGenerating}
                      className="inline-flex h-7 items-center gap-1 border border-[#E5E5E5] bg-white px-2.5 text-[11px] text-[#525252] transition-colors hover:border-[#111111] hover:text-[#111111] disabled:opacity-40"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>

                {/* Compact Selected Outfit Summary Bar + Primary Try On Outfit CTA */}
                <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border border-[#E5E5E5] bg-[#FAFAFA] px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium tracking-[0.08em] text-[#6B6B6B] uppercase">
                      Selected Outfit
                      {isFullOutfitPass && (
                        <span className="ml-1.5 text-[#111111]">
                          · 2-Pass Full Look
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] font-medium tracking-[0.02em] text-[#111111]">
                      {selectedOutfitSummary || "No pieces selected yet"}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleRunTryOn()}
                    disabled={
                      !bodyProfile ||
                      !canRunTryOnGarments ||
                      isGenerating ||
                      isRateLimited
                    }
                    className="inline-flex h-9 shrink-0 items-center gap-2 bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isGenerating ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>
                          {generatingPasses === 2 ? "Draping (2/2)…" : "Draping…"}
                        </span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="h-3.5 w-3.5" />
                        <span>Try On Outfit</span>
                      </>
                    )}
                  </button>
                </div>

                {(!bodyProfile ||
                  isRateLimited ||
                  (allSelectedOutfitItems.length > 0 && !canRunTryOnGarments)) && (
                  <p className="mt-2 text-[11px] text-[#6B6B6B]">
                    {!bodyProfile
                      ? "Set up your Body Profile or pick a Preset Model on the left to enable AI Try-On."
                      : isRateLimited
                        ? "Daily limit reached (3/3). Resets in 24h — use Layer Board for unlimited layering."
                        : "Add a Top, Outerwear, or Bottom to run AI Try-On (Shoes & Accessories appear in Styled With)."}
                  </p>
                )}

                {/* Full 5-Category Filter Pills */}
                <div
                  role="tablist"
                  aria-label="Filter wardrobe garments"
                  className="mt-3.5 flex flex-wrap gap-1.5"
                >
                  {TRYON_FILTERS.map((filter) => {
                    const isActive = tryOnFilter === filter.id;
                    return (
                      <button
                        key={filter.id}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        onClick={() => setTryOnFilter(filter.id)}
                        className={`inline-flex h-8 items-center gap-1.5 border px-3 text-[12px] transition-colors ${
                          isActive
                            ? "border-[#111111] bg-[#111111] font-medium text-white"
                            : "border-[#E5E5E5] bg-white text-[#525252] hover:border-[#111111] hover:text-[#111111]"
                        }`}
                      >
                        <span>{filter.label}</span>
                        <span
                          className={`text-[11px] tabular-nums ${
                            isActive ? "text-white/75" : "text-[#6B6B6B]"
                          }`}
                        >
                          {tryOnFilterCounts[filter.id]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Garment Picker Grid */}
              <div className="flex-1 overflow-y-auto p-5">
                {items.length === 0 ? (
                  <div className="flex flex-col items-center justify-center border border-dashed border-[#D4D4D4] px-6 py-16 text-center">
                    <p className="text-[14px] font-medium text-[#111111]">
                      No pieces in your closet yet
                    </p>
                    <p className="mt-1 max-w-[32ch] text-[12px] text-[#525252]">
                      Add garment cutouts in your closet first, then return here
                      to try them on.
                    </p>
                    <Link
                      href="/closet"
                      className="mt-5 inline-flex h-8 items-center bg-[#111111] px-3.5 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
                    >
                      Go to Closet
                    </Link>
                  </div>
                ) : tryOnVisibleItems.length === 0 ? (
                  <div className="py-16 text-center">
                    <p className="text-[13px] text-[#525252]">
                      No{" "}
                      {tryOnFilter !== "all"
                        ? CATEGORY_LABELS[tryOnFilter].toLowerCase()
                        : ""}{" "}
                      pieces in your closet yet.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTryOnFilter("all")}
                      className="mt-3 h-8 border border-[#E5E5E5] bg-white px-3 text-[12px] font-medium text-[#111111] hover:border-[#111111]"
                    >
                      Show all pieces
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
                    {tryOnVisibleItems.map((item) => {
                      const isSelected = isTryOnPieceSelected(item);
                      const cpw = calculateCostPerWear(
                        item.price,
                        item.wearCount
                      );

                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleTryOnPiece(item)}
                          disabled={isGenerating}
                          className={`group flex flex-col border text-left transition-colors disabled:opacity-60 ${
                            isSelected
                              ? "border-[#111111] bg-[#FAFAFA]"
                              : "border-[#E5E5E5] bg-white hover:border-[#A3A3A3]"
                          }`}
                        >
                          <div className="relative flex aspect-[4/5] w-full items-center justify-center bg-[#F4F4F3] p-4">
                            <span className="absolute top-2 left-2 text-[10px] tracking-[0.08em] text-[#6B6B6B] uppercase">
                              {CATEGORY_LABELS[item.category]}
                            </span>

                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              loading="lazy"
                              className="max-h-full max-w-full object-contain drop-shadow-[0_8px_14px_rgba(17,17,17,0.08)]"
                            />

                            {isSelected && (
                              <span className="absolute top-2 right-2 inline-flex h-5 items-center gap-1 bg-[#111111] px-1.5 text-[10px] font-medium text-white">
                                <Check className="h-2.5 w-2.5" />
                                <span>{getSlotTag(item.category)}</span>
                              </span>
                            )}
                          </div>

                          <div className="border-t border-[#E5E5E5] p-3">
                            <div className="truncate text-[12px] font-medium text-[#111111]">
                              {item.name}
                            </div>
                            <div className="mt-1 flex items-center justify-between text-[11px] text-[#6B6B6B] tabular-nums">
                              {item.price > 0 ? (
                                <span>{formatPeso(cpw)}/wear</span>
                              ) : (
                                <span>{CATEGORY_LABELS[item.category]}</span>
                              )}
                              <span>
                                {item.wearCount}{" "}
                                {item.wearCount === 1 ? "wear" : "wears"}
                              </span>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : mode === "lookbook" ? (
          /* ----------------------------------------------------------------
           * LOOKBOOK (3:4 Editorial Saved Fits Grid)
           * ---------------------------------------------------------------- */
          <div>
            {lookbookError && (
              <div
                role="alert"
                className="mb-6 flex items-center justify-between border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-2.5 text-[13px] text-[#991B1B]"
              >
                <span>{lookbookError}</span>
                <button
                  type="button"
                  onClick={() => setLookbookError(null)}
                  className="text-[12px] font-medium underline underline-offset-4"
                >
                  Dismiss
                </button>
              </div>
            )}

            {savedLooks.length === 0 ? (
              <section className="flex flex-col items-center justify-center border border-dashed border-[#D4D4D4] bg-white px-6 py-24 text-center">
                <div className="flex h-12 w-12 items-center justify-center border border-[#E5E5E5] bg-[#FAFAFA] text-[#111111]">
                  <BookMarked className="h-5 w-5" strokeWidth={1.25} />
                </div>
                <h1 className="mt-5 text-[16px] font-medium text-[#111111]">
                  Your Lookbook is empty
                </h1>
                <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-[#525252]">
                  Generate an AI Try-On preview and click Save Look to archive
                  your favorite fits here.
                </p>
                <button
                  type="button"
                  onClick={() => setMode("tryon")}
                  className="mt-6 inline-flex h-9 items-center gap-1.5 bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Open AI Try-On</span>
                </button>
              </section>
            ) : (
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {savedLooks.map((look) => {
                  const isConfirming = confirmDeleteLookId === look.id;
                  const isDeleting = deletingLookId === look.id;

                  return (
                    <article
                      key={look.id}
                      className="group flex flex-col border border-[#E5E5E5] bg-white transition-colors hover:border-[#CCCCCC]"
                    >
                      <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F4F4F3]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={look.imageUrl}
                          alt={look.label}
                          loading="lazy"
                          className="h-full w-full object-cover object-top"
                        />

                        <div className="absolute right-3 bottom-3">
                          {isConfirming ? (
                            <div className="flex items-center gap-1 border border-[#E5E5E5] bg-white p-1">
                              <button
                                type="button"
                                onClick={() => void handleDeleteLook(look.id)}
                                disabled={isDeleting}
                                className="bg-[#111111] px-2 py-0.5 text-[11px] font-medium text-white hover:bg-[#262626] disabled:opacity-50"
                              >
                                {isDeleting ? "…" : "Delete"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteLookId(null)}
                                disabled={isDeleting}
                                className="px-1.5 py-0.5 text-[11px] text-[#525252] hover:text-[#111111]"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteLookId(look.id)}
                              aria-label={`Delete ${look.label}`}
                              title="Delete look"
                              className="flex h-7 w-7 items-center justify-center border border-[#E5E5E5] bg-white/90 text-[#6B6B6B] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:border-[#111111] hover:text-[#111111]"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex items-baseline justify-between gap-3 border-t border-[#E5E5E5] px-4 py-3.5">
                        <h2
                          title={look.label}
                          className="truncate text-[13px] font-medium text-[#111111]"
                        >
                          {look.label}
                        </h2>
                        <span className="shrink-0 text-[11px] text-[#6B6B6B] tabular-nums">
                          {formatSavedDate(look.createdAt)}
                        </span>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        ) : items.length === 0 ? (
          <div className="border border-dashed border-[#D4D4D4] bg-white px-6 py-20 text-center">
            <h1 className="text-[16px] font-medium text-[#111111]">
              Your layer board is empty
            </h1>
            <p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] text-[#525252]">
              Add transparent garment cutouts in your closet first, then layer
              them here to test silhouettes.
            </p>
            <Link
              href="/closet"
              className="mt-6 inline-flex h-9 items-center bg-[#111111] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#262626]"
            >
              Go to Closet
            </Link>
          </div>
        ) : (
          /* ----------------------------------------------------------------
           * LAYER BOARD (Instant 5-Category Cutout Composition)
           * ---------------------------------------------------------------- */
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Silhouette Board */}
            <section className="flex flex-col border border-[#E5E5E5] bg-white lg:col-span-7">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E5E5E5] px-5 py-3.5">
                <div className="flex items-baseline gap-4">
                  <h1 className="text-[14px] font-medium text-[#111111]">
                    Layer Board
                  </h1>
                  <span className="text-[12px] text-[#6B6B6B] tabular-nums">
                    {selectedBoardItems.length} / {SLOT_ORDER.length} slots
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={shuffleFit}
                    className="inline-flex h-7 items-center gap-1.5 border border-[#E5E5E5] bg-white px-2.5 text-[12px] text-[#111111] transition-colors hover:border-[#111111]"
                  >
                    <Shuffle className="h-3 w-3" />
                    <span>Shuffle</span>
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    disabled={selectedBoardItems.length === 0}
                    className="inline-flex h-7 items-center gap-1.5 border border-[#E5E5E5] bg-white px-2.5 text-[12px] text-[#525252] transition-colors hover:border-[#111111] hover:text-[#111111] disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" />
                    <span>Clear</span>
                  </button>
                </div>
              </div>

              {/* Cutout Stage */}
              <div className="flex min-h-[520px] flex-1 flex-col justify-between bg-[#F4F4F3] p-6 sm:p-8">
                {selectedBoardItems.length === 0 ? (
                  <div className="flex flex-1 flex-col items-center justify-center text-center">
                    <p className="text-[14px] font-medium text-[#111111]">
                      Select pieces to compose a silhouette
                    </p>
                    <p className="mt-1 text-[13px] text-[#525252]">
                      Pick from your closet index on the right or press Shuffle.
                    </p>
                  </div>
                ) : (
                  <div className="mx-auto flex w-full max-w-[440px] flex-1 flex-col items-center justify-center gap-4">
                    {(selectedBySlot.top ||
                      selectedBySlot.outerwear ||
                      selectedBySlot.accessory) && (
                      <div className="flex w-full items-center justify-center gap-4">
                        {selectedBySlot.outerwear &&
                          itemsById.get(selectedBySlot.outerwear) && (
                            <CanvasPieceTile
                              item={itemsById.get(selectedBySlot.outerwear)!}
                              sizeClass="h-44 w-44"
                              onRemove={() => clearSlot("outerwear")}
                            />
                          )}
                        {selectedBySlot.top &&
                          itemsById.get(selectedBySlot.top) && (
                            <CanvasPieceTile
                              item={itemsById.get(selectedBySlot.top)!}
                              sizeClass="h-44 w-44"
                              onRemove={() => clearSlot("top")}
                            />
                          )}
                        {selectedBySlot.accessory &&
                          itemsById.get(selectedBySlot.accessory) && (
                            <CanvasPieceTile
                              item={itemsById.get(selectedBySlot.accessory)!}
                              sizeClass="h-28 w-28"
                              onRemove={() => clearSlot("accessory")}
                            />
                          )}
                      </div>
                    )}

                    {selectedBySlot.bottom &&
                      itemsById.get(selectedBySlot.bottom) && (
                        <CanvasPieceTile
                          item={itemsById.get(selectedBySlot.bottom)!}
                          sizeClass="h-48 w-48"
                          onRemove={() => clearSlot("bottom")}
                        />
                      )}

                    {selectedBySlot.shoes &&
                      itemsById.get(selectedBySlot.shoes) && (
                        <CanvasPieceTile
                          item={itemsById.get(selectedBySlot.shoes)!}
                          sizeClass="h-28 w-36"
                          onRemove={() => clearSlot("shoes")}
                        />
                      )}
                  </div>
                )}

                {(boardFeedback || boardError) && (
                  <div
                    role={boardError ? "alert" : "status"}
                    className={`mt-4 border px-3 py-2 text-[12px] ${
                      boardError
                        ? "border-[#DC2626]/30 bg-[#FEF2F2] text-[#991B1B]"
                        : "border-[#E5E5E5] bg-white text-[#111111]"
                    }`}
                  >
                    {boardError || boardFeedback}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 divide-x divide-[#E5E5E5] border-t border-[#E5E5E5] bg-white">
                <div className="px-5 py-3">
                  <div className="text-[11px] uppercase tracking-[0.06em] text-[#6B6B6B]">
                    Combined Value
                  </div>
                  <div className="mt-0.5 text-[15px] font-medium text-[#111111] tabular-nums">
                    {formatPeso(fitValue)}
                  </div>
                </div>
                <div className="px-5 py-3">
                  <div className="text-[11px] uppercase tracking-[0.06em] text-[#6B6B6B]">
                    Combined Cost / Wear
                  </div>
                  <div className="mt-0.5 text-[15px] font-medium text-[#111111] tabular-nums">
                    {formatPeso(fitCostPerWear)}
                  </div>
                </div>
              </div>
            </section>

            {/* Closet Selector */}
            <section className="flex flex-col border border-[#E5E5E5] bg-white lg:col-span-5">
              <div className="border-b border-[#E5E5E5] px-5 py-3.5">
                <h2 className="text-[14px] font-medium text-[#111111]">
                  Wardrobe Pieces
                </h2>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {SLOT_ORDER.map((category) => {
                    const isActive = activeSlot === category;
                    const hasSelected = Boolean(selectedBySlot[category]);
                    return (
                      <button
                        key={category}
                        type="button"
                        onClick={() => setActiveSlot(category)}
                        className={`inline-flex h-7 items-center gap-1.5 border px-2.5 text-[12px] transition-colors ${
                          isActive
                            ? "border-[#111111] bg-[#111111] text-white"
                            : "border-[#E5E5E5] bg-white text-[#525252] hover:border-[#111111] hover:text-[#111111]"
                        }`}
                      >
                        <span>{CATEGORY_LABELS[category]}</span>
                        <span
                          className={`tabular-nums ${
                            isActive ? "text-white/75" : "text-[#6B6B6B]"
                          }`}
                        >
                          {itemsByCategory[category].length}
                        </span>
                        {hasSelected && (
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              isActive ? "bg-white" : "bg-[#111111]"
                            }`}
                          />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {slotItems.length === 0 ? (
                  <p className="py-12 text-center text-[13px] text-[#6B6B6B]">
                    No {CATEGORY_LABELS[activeSlot].toLowerCase()} pieces in your
                    closet yet.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    {slotItems.map((item) => {
                      const isSelected =
                        selectedBySlot[item.category] === item.id;
                      const cpw = calculateCostPerWear(
                        item.price,
                        item.wearCount
                      );
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => togglePiece(item)}
                          className={`group flex flex-col border text-left transition-colors ${
                            isSelected
                              ? "border-[#111111] bg-[#FAFAFA]"
                              : "border-[#E5E5E5] bg-white hover:border-[#A3A3A3]"
                          }`}
                        >
                          <div className="relative flex aspect-square w-full items-center justify-center bg-[#F4F4F3] p-3">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              className="max-h-full max-w-full object-contain drop-shadow-[0_6px_10px_rgba(17,17,17,0.08)]"
                            />
                            {isSelected && (
                              <span className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center bg-[#111111] text-white">
                                <Check className="h-3 w-3" />
                              </span>
                            )}
                          </div>
                          <div className="border-t border-[#E5E5E5] p-2.5">
                            <div className="truncate text-[12px] font-medium text-[#111111]">
                              {item.name}
                            </div>
                            <div className="mt-0.5 text-[11px] text-[#6B6B6B] tabular-nums">
                              {item.price > 0
                                ? `${formatPeso(cpw)}/wear`
                                : `${item.wearCount} ${
                                    item.wearCount === 1 ? "wear" : "wears"
                                  }`}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </main>

      <BodyProfileModal
        open={isProfileModalOpen}
        initialProfile={bodyProfile}
        onClose={() => setIsProfileModalOpen(false)}
        onSaved={(savedProfile) => {
          setBodyProfile(savedProfile);
          setTryOnResultUrl(null);
          setPreviewedOutfit(null);
          setSavedCurrentResultKey(null);
          setViewStage("before");
          setTryOnError(null);
        }}
      />
    </div>
  );
}

function CanvasPieceTile({
  item,
  sizeClass,
  onRemove,
}: {
  item: WardrobeItemDTO;
  sizeClass: string;
  onRemove: () => void;
}) {
  return (
    <div
      className={`group relative flex items-center justify-center ${sizeClass}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={item.imageUrl}
        alt={item.name}
        className="max-h-full max-w-full object-contain drop-shadow-[0_12px_20px_rgba(17,17,17,0.1)]"
      />
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${item.name} from canvas`}
        className="absolute top-0 right-0 flex h-6 w-6 items-center justify-center border border-[#E5E5E5] bg-white text-[#525252] opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100 hover:border-[#111111] hover:text-[#111111]"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
