"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bookmark,
  BookMarked,
  Camera,
  Check,
  Layers,
  Loader2,
  RotateCcw,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  deleteLook,
  saveLook,
  upsertBodyProfile,
} from "@/app/canvas/actions";
import { logOutfitWear, logWear } from "@/app/closet/actions";
import { BodyProfileModal } from "@/components/BodyProfileModal";
import { CameraBooth } from "@/components/CameraBooth";
import { LayerBoard, type BoardSelection } from "@/components/LayerBoard";
import { Navbar } from "@/components/Navbar";
import { TailorFitPanel } from "@/components/TailorFitPanel";
import type { BodyProfileDTO, SavedLookDTO } from "@/lib/canvas";
import {
  CATEGORY_LABELS,
  WARDROBE_CATEGORIES,
  type WardrobeCategory,
} from "@/lib/categories";
import type { WardrobeItemDTO } from "@/lib/closet";
import { PREFERRED_FIT_LABELS } from "@/lib/fitPreferences";
import {
  computeTailorGeometry,
  DEFAULT_TAILOR_FIT,
  sanitizeTailorFit,
  type OuterwearStyle,
  type TailorFitConfig,
  type TailorGuideKind,
  type TryOnRenderMode,
} from "@/lib/types/tailorFit";
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

type StudioMode = "tryon" | "booth" | "board" | "lookbook";
type TryOnFilter = "all" | WardrobeCategory;

interface PreviewedOutfitSnapshot {
  upperId: string | null;
  outerwearId: string | null;
  lowerId: string | null;
  /** Strictly the AI-draped pieces (Top, Outerwear, and/or Bottom) — never Shoes/Accessories */
  drapedLabel: string;
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

function buildPieceLabel(pieces: WardrobeItemDTO[]): string {
  const joined = pieces
    .map((p) => p.name.trim())
    .filter(Boolean)
    .join(" + ");
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

  // Synced outfit selection across AI Try-On & Camera Booth
  const [tryOnFilter, setTryOnFilter] = useState<TryOnFilter>("all");
  const [selectedUpperId, setSelectedUpperId] = useState<string | null>(null);
  const [selectedOuterwearId, setSelectedOuterwearId] = useState<string | null>(
    null
  );
  const [selectedLowerId, setSelectedLowerId] = useState<string | null>(null);
  const [selectedShoesId, setSelectedShoesId] = useState<string | null>(null);
  const [selectedAccessoryIds, setSelectedAccessoryIds] = useState<string[]>(
    []
  );

  // Try-On result state
  const [tryOnResultUrl, setTryOnResultUrl] = useState<string | null>(null);
  const [lastCompositeUrl, setLastCompositeUrl] = useState<string | null>(null);
  const [lastRenderEngine, setLastRenderEngine] = useState<string | null>(null);
  const [previewedOutfit, setPreviewedOutfit] =
    useState<PreviewedOutfitSnapshot | null>(null);
  const [viewStage, setViewStage] = useState<"after" | "before">("after");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatingPasses, setGeneratingPasses] = useState<1 | 2>(1);
  const [generatingStepIndex, setGeneratingStepIndex] = useState<number>(1);
  const [streamingStageLabel, setStreamingStageLabel] = useState<string | null>(
    null
  );
  const [streamingPass1Cached, setStreamingPass1Cached] = useState(false);
  const [cleanSwap, setCleanSwap] = useState(false);
  const [renderMode, setRenderMode] = useState<TryOnRenderMode>("two-pass");
  const [tailorFit, setTailorFit] =
    useState<TailorFitConfig>(DEFAULT_TAILOR_FIT);
  const [activeGuide, setActiveGuide] = useState<TailorGuideKind>(null);
  const [lastRenderedFitKey, setLastRenderedFitKey] = useState<string | null>(
    null
  );
  const guideTimerRef = useRef<number | null>(null);
  const sessionResultCacheRef = useRef<
    Map<
      string,
      {
        resultUrl: string;
        garmentCompositeUrl?: string | null;
        engine?: string | null;
      }
    >
  >(new Map());
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
  const [selectedBySlot, setSelectedBySlot] = useState<BoardSelection>({});
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

  useEffect(() => {
    return () => {
      if (guideTimerRef.current !== null) {
        window.clearTimeout(guideTimerRef.current);
      }
    };
  }, []);

  const handleActiveGuideChange = useCallback((guide: TailorGuideKind) => {
    if (guideTimerRef.current !== null) {
      window.clearTimeout(guideTimerRef.current);
      guideTimerRef.current = null;
    }
    setActiveGuide(guide);
    if (guide !== null) {
      guideTimerRef.current = window.setTimeout(() => {
        setActiveGuide(null);
        guideTimerRef.current = null;
      }, 1200);
    }
  }, []);

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
  const selectedOuterwearItem = selectedOuterwearId
    ? itemsById.get(selectedOuterwearId) ?? null
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

  const drapedSelectionItems = useMemo(() => {
    const list: WardrobeItemDTO[] = [];
    if (selectedUpperItem) list.push(selectedUpperItem);
    if (selectedOuterwearItem) list.push(selectedOuterwearItem);
    if (selectedLowerItem) list.push(selectedLowerItem);
    return list;
  }, [selectedUpperItem, selectedOuterwearItem, selectedLowerItem]);

  const allSelectedOutfitItems = useMemo(() => {
    return [...drapedSelectionItems, ...styledWithItems];
  }, [drapedSelectionItems, styledWithItems]);

  const selectedOutfitSummary = useMemo(
    () =>
      allSelectedOutfitItems
        .map((item) => item.name.trim().toUpperCase())
        .join(" + "),
    [allSelectedOutfitItems]
  );

  const hasAnyUpperSelected = Boolean(
    selectedUpperItem || selectedOuterwearItem
  );
  const hasLayeredOuterwear = Boolean(
    selectedUpperItem && selectedOuterwearItem
  );
  const canRunTryOnGarments = drapedSelectionItems.length > 0;
  const effectivePassSlots =
    (hasAnyUpperSelected ? 1 : 0) + (selectedLowerItem ? 1 : 0);
  const plannedPassCount: 1 | 2 =
    effectivePassSlots < 2 || renderMode === "composite" ? 1 : 2;

  const currentFitKey = useMemo(
    () =>
      JSON.stringify({
        upperId: selectedUpperItem?.id ?? null,
        outerwearId: selectedOuterwearItem?.id ?? null,
        lowerId: selectedLowerItem?.id ?? null,
        cleanSwap,
        renderMode,
        tailorFit,
      }),
    [
      selectedUpperItem?.id,
      selectedOuterwearItem?.id,
      selectedLowerItem?.id,
      cleanSwap,
      renderMode,
      tailorFit,
    ]
  );

  const sessionCacheKey = useMemo(() => {
    const avatarUrl = bodyProfile?.avatarUrl ?? "";
    const avatarToken = avatarUrl
      ? `${avatarUrl.length}:${avatarUrl.slice(0, 48)}:${avatarUrl.slice(-24)}`
      : "none";
    return `${avatarToken}::${currentFitKey}`;
  }, [bodyProfile?.avatarUrl, currentFitKey]);

  const rememberSessionResult = useCallback(
    (
      key: string,
      resultUrl: string,
      garmentCompositeUrl?: string | null,
      engine?: string | null
    ) => {
      const cache = sessionResultCacheRef.current;
      if (cache.has(key)) {
        cache.delete(key);
      }
      cache.set(key, {
        resultUrl,
        garmentCompositeUrl: garmentCompositeUrl ?? null,
        engine: engine ?? null,
      });
      while (cache.size > 24) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    },
    []
  );

  // Instant 0ms restore when flipping back to a previously rendered outfit/fit in this session
  useEffect(() => {
    if (isGenerating || !canRunTryOnGarments) return;
    const cached = sessionResultCacheRef.current.get(sessionCacheKey);
    if (!cached) return;

    setTryOnResultUrl(cached.resultUrl);
    if (cached.garmentCompositeUrl !== undefined) {
      setLastCompositeUrl(cached.garmentCompositeUrl);
    }
    setLastRenderEngine(cached.engine ?? null);
    setLastRenderedFitKey(currentFitKey);
    setPreviewedOutfit({
      upperId: selectedUpperItem?.id ?? null,
      outerwearId: selectedOuterwearItem?.id ?? null,
      lowerId: selectedLowerItem?.id ?? null,
      drapedLabel: buildPieceLabel(drapedSelectionItems),
    });
    setSavedCurrentResultKey(null);
    setViewStage("after");
    setTryOnError(null);
  }, [
    sessionCacheKey,
    currentFitKey,
    isGenerating,
    canRunTryOnGarments,
    selectedUpperItem?.id,
    selectedOuterwearItem?.id,
    selectedLowerItem?.id,
    drapedSelectionItems,
  ]);

  const isFitDirty = Boolean(
    tryOnResultUrl &&
    lastRenderedFitKey &&
    lastRenderedFitKey !== currentFitKey
  );

  // Layer Board derived metrics for navbar
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
    if (item.category === "top") {
      setSelectedUpperId((prev) => (prev === item.id ? null : item.id));
      return;
    }
    if (item.category === "outerwear") {
      setSelectedOuterwearId((prev) => (prev === item.id ? null : item.id));
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
    if (item.category === "top") return selectedUpperId === item.id;
    if (item.category === "outerwear") return selectedOuterwearId === item.id;
    if (item.category === "bottom") return selectedLowerId === item.id;
    if (item.category === "shoes") return selectedShoesId === item.id;
    return selectedAccessoryIds.includes(item.id);
  }

  function getSlotTag(category: WardrobeCategory): string {
    if (category === "top") return "Top";
    if (category === "outerwear") return "Outer";
    if (category === "bottom") return "Lower";
    return "Styled";
  }

  function clearSelectedOutfit() {
    setSelectedUpperId(null);
    setSelectedOuterwearId(null);
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

  async function executeAiTryOn(overrideProfile?: BodyProfileDTO | null) {
    const activeProfile = overrideProfile ?? bodyProfile;
    if (
      !activeProfile ||
      !canRunTryOnGarments ||
      isGenerating ||
      isRateLimited
    ) {
      return;
    }

    const passes: 1 | 2 = plannedPassCount;
    const requestFitKey = currentFitKey;
    const activeAvatarUrl = activeProfile.avatarUrl ?? "";
    const activeAvatarToken = activeAvatarUrl
      ? `${activeAvatarUrl.length}:${activeAvatarUrl.slice(0, 48)}:${activeAvatarUrl.slice(-24)}`
      : "none";
    const requestSessionKey = `${activeAvatarToken}::${requestFitKey}`;
    const drapedSnapshot: PreviewedOutfitSnapshot = {
      upperId: selectedUpperItem?.id ?? null,
      outerwearId: selectedOuterwearItem?.id ?? null,
      lowerId: selectedLowerItem?.id ?? null,
      drapedLabel: buildPieceLabel(drapedSelectionItems),
    };

    // Instant 0ms session cache hit
    const localCached = sessionResultCacheRef.current.get(requestSessionKey);
    if (localCached) {
      setTryOnError(null);
      setTryOnBusyFallback(false);
      setTryOnResultUrl(localCached.resultUrl);
      if (localCached.garmentCompositeUrl !== undefined) {
        setLastCompositeUrl(localCached.garmentCompositeUrl);
      }
      setLastRenderEngine(localCached.engine ?? null);
      setLastRenderedFitKey(requestFitKey);
      setPreviewedOutfit(drapedSnapshot);
      setSavedCurrentResultKey(null);
      setViewStage("after");
      return;
    }

    setGeneratingPasses(passes);
    setGeneratingStepIndex(1);
    setStreamingStageLabel(null);
    setStreamingPass1Cached(false);
    setTryOnError(null);
    setTryOnBusyFallback(false);
    setIsGenerating(true);

    try {
      const response = await fetch("/api/tryon", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept:
            passes >= 2
              ? "application/x-ndjson, application/json"
              : "application/json",
        },
        body: JSON.stringify({
          upperItemId: selectedUpperItem?.id,
          outerwearItemId: selectedOuterwearItem?.id,
          lowerItemId: selectedLowerItem?.id,
          cleanSwap,
          renderMode,
          tailorFit,
        }),
      });

      const contentType = (
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (contentType.includes("application/x-ndjson") && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let receivedFinal = false;

        const handleEventLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const evt = JSON.parse(trimmed) as {
            stage?: "pass1_done" | "done" | "error";
            previewUrl?: string;
            cachedPass1?: boolean;
            nextSlot?: "upper" | "outerwear" | "lower";
            stepIndex?: number;
            totalSteps?: number;
            resultUrl?: string;
            garmentCompositeUrl?: string;
            engine?: string;
            remaining?: number | null;
            unlimited?: boolean;
            cached?: boolean;
            error?: string;
          };

          if (evt.stage === "pass1_done" && evt.previewUrl) {
            setTryOnResultUrl(evt.previewUrl);
            setViewStage("after");
            setStreamingPass1Cached(Boolean(evt.cachedPass1));
            const nextStep = (evt.stepIndex ?? 1) + 1;
            setGeneratingStepIndex(nextStep);
            if (evt.totalSteps === 1 || evt.totalSteps === 2) {
              setGeneratingPasses(evt.totalSteps);
            }
            setStreamingStageLabel(
              evt.nextSlot === "outerwear"
                ? selectedUpperItem
                  ? "Layering jacket + shirt…"
                  : "Layering outerwear…"
                : evt.nextSlot === "upper"
                  ? "Layering shirt…"
                  : "Layering lower piece…"
            );
            return;
          }

          if (evt.stage === "done" && evt.resultUrl) {
            receivedFinal = true;
            if (typeof evt.unlimited === "boolean") {
              setUnlimited(evt.unlimited);
            }
            if (evt.remaining === null || typeof evt.remaining === "number") {
              setRemaining(evt.remaining);
            }
            rememberSessionResult(
              requestSessionKey,
              evt.resultUrl,
              evt.garmentCompositeUrl ?? null,
              evt.engine ?? null
            );
            setTryOnResultUrl(evt.resultUrl);
            setLastCompositeUrl(evt.garmentCompositeUrl ?? null);
            setLastRenderEngine(evt.engine ?? null);
            setLastRenderedFitKey(requestFitKey);
            setPreviewedOutfit(drapedSnapshot);
            setSavedCurrentResultKey(null);
            setViewStage("after");
            setStreamingStageLabel(null);
            if (!evt.cached) {
              router.refresh();
            }
            return;
          }

          if (evt.stage === "error") {
            receivedFinal = true;
            if (typeof evt.unlimited === "boolean") {
              setUnlimited(evt.unlimited);
            }
            if (evt.remaining === null || typeof evt.remaining === "number") {
              setRemaining(evt.remaining);
            }
            setTryOnError(
              evt.error ||
              "AI try-on server is currently busy. Try again in a moment or use the Layer Board."
            );
            setTryOnBusyFallback(true);
            setStreamingStageLabel(null);
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            handleEventLine(line);
          }
        }

        if (buffer.trim()) {
          handleEventLine(buffer);
        }

        if (!receivedFinal) {
          setTryOnError(
            "AI try-on stream ended unexpectedly. Try again or use the Layer Board."
          );
          setTryOnBusyFallback(true);
        }
        return;
      }

      const payload = (await response.json().catch(() => null)) as {
        resultUrl?: string;
        garmentCompositeUrl?: string;
        engine?: string;
        remaining?: number | null;
        unlimited?: boolean;
        cached?: boolean;
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

      rememberSessionResult(
        requestSessionKey,
        payload.resultUrl,
        payload.garmentCompositeUrl ?? null,
        payload.engine ?? null
      );
      setTryOnResultUrl(payload.resultUrl);
      setLastCompositeUrl(payload.garmentCompositeUrl ?? null);
      setLastRenderEngine(payload.engine ?? null);
      setLastRenderedFitKey(requestFitKey);
      // Honest stage badge: strictly draped Upper and/or Lower pieces (never Shoes/Accessories)
      setPreviewedOutfit(drapedSnapshot);
      setSavedCurrentResultKey(null);
      setViewStage("after");
      if (!payload.cached) {
        router.refresh();
      }
    } catch {
      setTryOnError(
        "AI try-on server is currently busy. Try again in a moment or use the Layer Board."
      );
      setTryOnBusyFallback(true);
    } finally {
      setIsGenerating(false);
      setStreamingStageLabel(null);
      setStreamingPass1Cached(false);
    }
  }

  // Lookbook label includes both draped pieces AND any selected Shoes / Accessories
  const currentLookLabel = useMemo(() => {
    const pieces: WardrobeItemDTO[] = [];
    if (previewedOutfit) {
      const upper = previewedOutfit.upperId
        ? itemsById.get(previewedOutfit.upperId)
        : undefined;
      const outerwear = previewedOutfit.outerwearId
        ? itemsById.get(previewedOutfit.outerwearId)
        : undefined;
      const lower = previewedOutfit.lowerId
        ? itemsById.get(previewedOutfit.lowerId)
        : undefined;
      if (upper) pieces.push(upper);
      if (outerwear) pieces.push(outerwear);
      if (lower) pieces.push(lower);
    } else {
      for (const p of drapedSelectionItems) pieces.push(p);
    }
    for (const s of styledWithItems) pieces.push(s);

    if (pieces.length > 0) return buildPieceLabel(pieces);
    return previewedOutfit?.drapedLabel || "Saved Fit";
  }, [previewedOutfit, itemsById, drapedSelectionItems, styledWithItems]);

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
        previewedOutfit?.outerwearId ??
        previewedOutfit?.upperId ??
        previewedOutfit?.lowerId ??
        selectedOuterwearId ??
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

  async function persistBoothAvatar(avatarUrl: string): Promise<BodyProfileDTO> {
    const heightCm = bodyProfile?.heightCm ?? 170;
    const weightKg = bodyProfile?.weightKg ?? 62;
    const preferredFit = bodyProfile?.preferredFit ?? "regular";

    const saved = await upsertBodyProfile({
      avatarUrl,
      heightCm,
      weightKg,
      preferredFit,
    });

    if (!saved.ok || !saved.data) {
      throw new Error(saved.error || "Could not save captured portrait.");
    }

    sessionResultCacheRef.current.clear();
    setBodyProfile(saved.data);
    setTryOnResultUrl(null);
    setLastRenderEngine(null);
    setLastRenderedFitKey(null);
    setPreviewedOutfit(null);
    setSavedCurrentResultKey(null);
    setViewStage("before");
    router.refresh();
    return saved.data;
  }

  async function handleBoothTryOnFrame(frameDataUrl: string) {
    const savedProfile = await persistBoothAvatar(frameDataUrl);
    setMode("tryon");
    if (canRunTryOnGarments && !isRateLimited) {
      void executeAiTryOn(savedProfile);
    }
  }

  async function handleBoothSetStudioAvatar(studioAvatarDataUrl: string) {
    await persistBoothAvatar(studioAvatarDataUrl);
    setMode("tryon");
  }

  async function handleSaveBoardLook(payload: {
    imageUrl: string;
    label: string;
    itemId: string | null;
  }) {
    const result = await saveLook(payload);
    if (!result.ok || !result.data) {
      throw new Error(result.error || "Could not save board look.");
    }
    setSavedLooks((prev) => [result.data!, ...prev]);
    router.refresh();
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
    const ids = new Set<string>();
    if (allSelectedOutfitItems.length > 0) {
      for (const item of allSelectedOutfitItems) ids.add(item.id);
    } else if (previewedOutfit) {
      if (previewedOutfit.upperId) ids.add(previewedOutfit.upperId);
      if (previewedOutfit.outerwearId) ids.add(previewedOutfit.outerwearId);
      if (previewedOutfit.lowerId) ids.add(previewedOutfit.lowerId);
    }
    return Array.from(ids);
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

  // Layer Board handlers
  function toggleBoardPiece(item: WardrobeItemDTO) {
    setBoardFeedback(null);
    setBoardError(null);
    setSelectedBySlot((prev) => ({
      ...prev,
      [item.category]: prev[item.category] === item.id ? undefined : item.id,
    }));
  }

  function clearBoardSlot(category: WardrobeCategory) {
    setSelectedBySlot((prev) => ({ ...prev, [category]: undefined }));
  }

  function clearBoardAll() {
    setSelectedBySlot({});
    setBoardFeedback(null);
    setBoardError(null);
  }

  function shuffleBoardFit() {
    setBoardFeedback(null);
    setBoardError(null);
    const next: BoardSelection = {};
    for (const category of WARDROBE_CATEGORIES) {
      const pool = itemsByCategory[category];
      if (pool.length > 0) {
        next[category] = pool[Math.floor(Math.random() * pool.length)].id;
      }
    }
    setSelectedBySlot(next);
  }

  function handleLogBoardOutfit() {
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
        `Logged +1 wear for ${result.data?.loggedCount ?? ids.length} ${(result.data?.loggedCount ?? ids.length) === 1 ? "piece" : "pieces"
        }.`
      );
      router.refresh();
    });
  }

  const activeModelSrc =
    tryOnResultUrl && viewStage === "after"
      ? tryOnResultUrl
      : bodyProfile?.avatarUrl ?? "";

  const stageGuideOverlay = useMemo(() => {
    if (!activeGuide) return null;

    // Synchronize 3:4 model hairline positions directly from computeTailorGeometry (2:3 frame -> 3:4 crop)
    const geom = computeTailorGeometry({
      hasUpper: hasAnyUpperSelected || activeGuide === "top-crop",
      hasLower: Boolean(selectedLowerItem) || activeGuide === "bottom-crop",
      fit: tailorFit,
      mode: "preview",
    });

    const map23YTo34Pct = (y23: number) => {
      const y34 = (y23 - 1 / 18) / (8 / 9);
      return Math.min(94, Math.max(10, y34 * 100));
    };

    if (activeGuide === "top-crop") {
      const topPct = map23YTo34Pct(geom.topHemY ?? 0.5);
      const label =
        tailorFit.topCropPct < 0
          ? `Top Hem · Long +${Math.abs(tailorFit.topCropPct)}%`
          : tailorFit.topCropPct > 0
            ? `Top Hem · -${tailorFit.topCropPct}% Crop`
            : "Top Hem · Regular";
      return { topPct, label };
    }
    if (activeGuide === "bottom-crop") {
      const topPct = map23YTo34Pct(geom.bottomHemY ?? 0.92);
      const suffix =
        tailorFit.bottomCropPct >= 9 && tailorFit.bottomCropPct <= 12
          ? " Ankle"
          : " Crop";
      const label =
        tailorFit.bottomCropPct > 0
          ? `Pant Hem · -${tailorFit.bottomCropPct}%${suffix}`
          : "Pant Hem · Full";
      return { topPct, label };
    }
    return {
      topPct: map23YTo34Pct(geom.waistLineY),
      label:
        tailorFit.tuckMode === "tucked"
          ? "Waist · Tucked In"
          : "Waist · Untucked",
    };
  }, [activeGuide, hasAnyUpperSelected, selectedLowerItem, tailorFit]);

  const showSyncedClosetSplit = mode === "tryon" || mode === "booth";

  return (
    <div className="min-h-screen bg-[#F9F8F6] text-[#0E0E0E]">
      <Navbar
        userName={userName}
        actionSlot={
          mode === "board" ? (
            <button
              type="button"
              onClick={handleLogBoardOutfit}
              disabled={selectedBoardItems.length === 0 || isLoggingOutfit}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap bg-[#0E0E0E] px-2.5 text-[12px] font-medium tracking-[0.02em] text-white transition-colors hover:bg-[#2B2B29] disabled:cursor-not-allowed disabled:opacity-40 sm:px-3.5"
            >
              {isLoggingOutfit ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span className="sm:hidden">Log Fit</span>
              <span className="hidden sm:inline">Log Fit Worn</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setIsProfileModalOpen(true)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border border-[#E2E0DA] bg-white px-2.5 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E] sm:px-3.5"
            >
              <UserRound className="h-3.5 w-3.5" strokeWidth={1.6} />
              <span className="sm:hidden">
                {bodyProfile ? "Profile" : "Model"}
              </span>
              <span className="hidden sm:inline">
                {bodyProfile ? "Edit Profile" : "Body Profile"}
              </span>
            </button>
          )
        }
      />

      {/* Full-Width Architectural Underline Mode Bar */}
      <div className="border-b border-[#E2E0DA] bg-white">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-10">
          <div
            role="tablist"
            aria-label="Canvas mode"
            className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-5 overflow-x-auto sm:gap-8"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "tryon"}
              onClick={() => setMode("tryon")}
              className={`relative inline-flex h-12 shrink-0 items-center gap-2 text-[12px] tracking-[0.02em] transition-colors ${mode === "tryon"
                ? "font-medium text-[#0E0E0E]"
                : "text-[#6C6A64] hover:text-[#0E0E0E]"
                }`}
            >
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.6} />
              <span>AI Try-On</span>
              {mode === "tryon" && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "booth"}
              onClick={() => setMode("booth")}
              className={`relative inline-flex h-12 shrink-0 items-center gap-2 text-[12px] tracking-[0.02em] transition-colors ${mode === "booth"
                ? "font-medium text-[#0E0E0E]"
                : "text-[#6C6A64] hover:text-[#0E0E0E]"
                }`}
            >
              <Camera className="h-3.5 w-3.5" strokeWidth={1.6} />
              <span>Camera Booth</span>
              {mode === "booth" && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "board"}
              onClick={() => setMode("board")}
              className={`relative inline-flex h-12 shrink-0 items-center gap-2 text-[12px] tracking-[0.02em] transition-colors ${mode === "board"
                ? "font-medium text-[#0E0E0E]"
                : "text-[#6C6A64] hover:text-[#0E0E0E]"
                }`}
            >
              <Layers className="h-3.5 w-3.5" strokeWidth={1.6} />
              <span>Layer Board</span>
              {mode === "board" && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "lookbook"}
              onClick={() => setMode("lookbook")}
              className={`relative inline-flex h-12 shrink-0 items-center gap-2 text-[12px] tracking-[0.02em] transition-colors ${mode === "lookbook"
                ? "font-medium text-[#0E0E0E]"
                : "text-[#6C6A64] hover:text-[#0E0E0E]"
                }`}
            >
              <BookMarked className="h-3.5 w-3.5" strokeWidth={1.6} />
              <span>Lookbook</span>
              <span
                className={`text-[11px] tabular-nums ${mode === "lookbook" ? "text-[#0E0E0E]" : "text-[#6C6A64]"
                  }`}
              >
                {savedLooks.length}
              </span>
              {mode === "lookbook" && (
                <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
              )}
            </button>
          </div>

          <div className="hidden shrink-0 items-center gap-2 text-[11px] font-medium tracking-[0.1em] text-[#4A4945] uppercase tabular-nums sm:flex">
            {mode === "tryon" && <span>{quotaBadgeText}</span>}
            {mode === "booth" && <span>3:4 Self-Timer · Local</span>}
            {mode === "board" && <span>4:5 Studio · Unlimited</span>}
            {mode === "lookbook" && (
              <span>
                {savedLooks.length}{" "}
                {savedLooks.length === 1 ? "Saved Look" : "Saved Looks"}
              </span>
            )}
          </div>
        </div>
      </div>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        {showSyncedClosetSplit ? (
          /* ----------------------------------------------------------------
           * SHARED-HAIRLINE 2-COLUMN STUDIO SPLIT
           * ---------------------------------------------------------------- */
          <div className="grid grid-cols-1 border border-[#E2E0DA] bg-white lg:grid-cols-12">
            {/* Left Panel: Model Stage or Camera Booth */}
            <div className="border-b border-[#E2E0DA] lg:col-span-6 lg:border-r lg:border-b-0">
              {mode === "booth" ? (
                <CameraBooth
                  hasTryOnSelection={canRunTryOnGarments}
                  selectedSummary={selectedOutfitSummary}
                  onTryOnFrame={handleBoothTryOnFrame}
                  onSetStudioAvatar={handleBoothSetStudioAvatar}
                />
              ) : (
                <section className="flex h-full flex-col bg-white">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E0DA] px-5 py-3.5">
                    <div className="flex items-baseline gap-2.5">
                      <h1 className="text-[11px] font-semibold tracking-[0.14em] text-[#0E0E0E] uppercase">
                        Model Stage
                      </h1>
                      <span className="text-[11px] text-[#6C6A64] tabular-nums sm:hidden">
                        {quotaBadgeText}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {bodyProfile && tryOnResultUrl && (
                        <div
                          role="group"
                          aria-label="Compare before and after"
                          className="inline-flex border border-[#E2E0DA] bg-[#F9F8F6]"
                        >
                          <button
                            type="button"
                            onClick={() => setViewStage("before")}
                            className={`px-3 py-1 text-[11px] font-medium tracking-[0.04em] uppercase transition-colors ${viewStage === "before"
                              ? "bg-[#0E0E0E] text-white"
                              : "text-[#4A4945] hover:text-[#0E0E0E]"
                              }`}
                          >
                            Before
                          </button>
                          <button
                            type="button"
                            onClick={() => setViewStage("after")}
                            className={`px-3 py-1 text-[11px] font-medium tracking-[0.04em] uppercase transition-colors ${viewStage === "after"
                              ? "bg-[#0E0E0E] text-white"
                              : "text-[#4A4945] hover:text-[#0E0E0E]"
                              }`}
                          >
                            After
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Warm Chalk-Stone Model Stage */}
                  <div
                    className={`relative flex min-h-[520px] flex-1 items-center justify-center bg-[#F2F1ED] px-5 pt-6 sm:px-8 ${styledWithItems.length > 0 ? "pb-24" : "pb-6"
                      }`}
                  >
                    {!bodyProfile ? (
                      <div className="mx-auto flex max-w-[340px] flex-col items-center text-center">
                        <div className="flex h-12 w-12 items-center justify-center border border-[#E2E0DA] bg-white text-[#0E0E0E]">
                          <UserRound className="h-5 w-5" strokeWidth={1.3} />
                        </div>
                        <h2 className="mt-5 text-[16px] font-medium tracking-[-0.02em] text-[#0E0E0E]">
                          Set up your Body Profile
                        </h2>
                        <p className="mt-1.5 text-[13px] leading-relaxed text-[#4A4945]">
                          Frame a 3:4 portrait, choose a preset studio model, or
                          snap directly in Camera Booth.
                        </p>
                        <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                          <button
                            type="button"
                            onClick={() => setIsProfileModalOpen(true)}
                            className="inline-flex h-10 items-center gap-2 bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
                          >
                            <UserRound className="h-3.5 w-3.5" />
                            <span>Set Up Body Profile</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setMode("booth")}
                            className="inline-flex h-10 items-center gap-1.5 border border-[#E2E0DA] bg-white px-4 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E]"
                          >
                            <Camera className="h-3.5 w-3.5" />
                            <span>Camera Booth</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="relative inline-flex max-h-[560px] max-w-full items-center justify-center">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={activeModelSrc}
                            alt={
                              tryOnResultUrl && viewStage === "after"
                                ? "Virtual try-on result"
                                : "Your Body Profile model"
                            }
                            className={`max-h-[560px] w-auto max-w-full object-contain transition-opacity duration-200 ${isGenerating && !streamingStageLabel
                              ? "opacity-35 blur-[2px]"
                              : "opacity-100"
                              }`}
                          />

                          {/* Live Hem / Waist Guide Overlay */}
                          {stageGuideOverlay && !isGenerating && (
                            <div
                              aria-hidden="true"
                              style={{ top: `${stageGuideOverlay.topPct}%` }}
                              className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2 transition-[top] duration-75"
                            >
                              <div className="w-full border-t border-dashed border-[#0E0E0E]/80 shadow-[0_1px_0_rgba(255,255,255,0.75)]" />
                              <span className="absolute right-2 -top-6 bg-[#0E0E0E] px-2 py-0.5 text-[10px] font-medium tracking-[0.06em] text-white uppercase tabular-nums">
                                {stageGuideOverlay.label}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Editorial Stage Plate */}
                        {tryOnResultUrl && previewedOutfit && !isGenerating && (
                          <span className="absolute top-3 left-3 max-w-[85%] truncate border border-[#E2E0DA] bg-white/95 px-2.5 py-1 text-[10px] font-medium tracking-[0.08em] text-[#0E0E0E] uppercase">
                            {viewStage === "after"
                              ? `Try-On · ${previewedOutfit.drapedLabel}`
                              : "Original Model"}
                          </span>
                        )}

                        {/* Progressive Pass-1 Streaming Pill */}
                        {isGenerating && streamingStageLabel && (
                          <div
                            role="status"
                            className="pointer-events-none absolute top-3 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-2 bg-[#0E0E0E]/92 px-3.5 py-1.5 text-[11px] font-medium text-white backdrop-blur-[2px]"
                          >
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                            <span className="whitespace-nowrap">
                              {streamingStageLabel}
                            </span>
                            {streamingPass1Cached && (
                              <span className="border-l border-white/25 pl-2 text-[10px] whitespace-nowrap text-white/75">
                                Pass 1 cached
                              </span>
                            )}
                          </div>
                        )}

                        {isGenerating && !streamingStageLabel && (
                          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[#F9F8F6]/80 px-6 text-center backdrop-blur-[2px]">
                            <Loader2 className="h-5 w-5 animate-spin text-[#0E0E0E]" />
                            <p className="mt-3 text-[13px] font-medium text-[#0E0E0E]">
                              {generatingPasses === 2
                                ? hasLayeredOuterwear
                                  ? "Draping layered outfit (2 passes)… ~25–40s"
                                  : "Draping full outfit (2 passes)… ~25–40s"
                                : drapedSelectionItems.length >= 2
                                  ? "Draping layered outfit (1:1 composite)… ~12–25s"
                                  : "Draping garment onto your silhouette… ~12–25s"}
                            </p>
                            {drapedSelectionItems.length > 0 && (
                              <p className="mt-1 max-w-[34ch] truncate text-[10px] font-medium tracking-[0.1em] text-[#4A4945] uppercase">
                                {buildPieceLabel(drapedSelectionItems)}
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}

                    {/* Pinned "Styled With" Strip */}
                    {styledWithItems.length > 0 && (
                      <div className="absolute inset-x-3 bottom-3 z-10 border border-[#E2E0DA] bg-white/95 px-3 py-2 backdrop-blur-[2px]">
                        <div className="flex items-center gap-3 overflow-x-auto">
                          <span className="shrink-0 text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                            Styled With
                          </span>
                          <div className="flex items-center gap-2">
                            {styledWithItems.map((piece) => (
                              <div
                                key={piece.id}
                                className="flex shrink-0 items-center gap-2 border border-[#E2E0DA] bg-[#F9F8F6] pr-1.5"
                              >
                                <div className="flex h-10 w-10 items-center justify-center bg-[#F2F1ED] p-1">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={piece.imageUrl}
                                    alt={piece.name}
                                    className="max-h-full max-w-full object-contain mix-blend-multiply"
                                  />
                                </div>
                                <div className="min-w-0 py-0.5">
                                  <div className="max-w-[110px] truncate text-[11px] font-medium text-[#0E0E0E]">
                                    {piece.name}
                                  </div>
                                  <div className="text-[9px] tracking-[0.08em] text-[#6C6A64] uppercase">
                                    {CATEGORY_LABELS[piece.category]}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeStyledPiece(piece)}
                                  disabled={isGenerating}
                                  aria-label={`Remove ${piece.name}`}
                                  className="flex h-6 w-6 items-center justify-center text-[#6C6A64] transition-colors hover:text-[#0E0E0E] disabled:opacity-40"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Error banner */}
                  {tryOnError && (
                    <div
                      role="alert"
                      className="flex flex-wrap items-center justify-between gap-2 border-t border-[#D9B4B2] bg-[#FAF2F2] px-5 py-3 text-[12px] text-[#8C1D18]"
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

                  {/* Editorial Model Spec Caption & Actions */}
                  {bodyProfile && (
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#E2E0DA] bg-white px-5 py-3.5">
                      <div className="flex items-center gap-2 text-[11px] tracking-[0.06em] text-[#4A4945] uppercase tabular-nums">
                        <span className="text-[#6C6A64]">Model</span>
                        <span className="font-semibold text-[#0E0E0E]">
                          {bodyProfile.heightCm} cm
                        </span>
                        <span className="text-[#C8C5BD]">·</span>
                        <span className="font-semibold text-[#0E0E0E]">
                          {bodyProfile.weightKg} kg
                        </span>
                        <span className="text-[#C8C5BD]">·</span>
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
                            className={`inline-flex h-9 items-center gap-1.5 border px-3.5 text-[11px] font-medium tracking-[0.04em] uppercase transition-colors disabled:opacity-60 ${isCurrentLookSaved
                              ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                              : "border-[#E2E0DA] bg-white text-[#0E0E0E] hover:border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-white"
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
                            className={`inline-flex h-9 items-center gap-1.5 border px-3.5 text-[11px] font-medium tracking-[0.04em] uppercase transition-colors disabled:opacity-40 ${loggedTryOnKey === loggableTryOnKey
                              ? "border-[#0E0E0E] bg-[#0E0E0E] text-white"
                              : "border-[#E2E0DA] bg-[#F9F8F6] text-[#0E0E0E] hover:border-[#0E0E0E] hover:bg-[#0E0E0E] hover:text-white"
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
                                : "+ Worn Today"}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </section>
              )}
            </div>

            {/* Right Panel: Synced Wardrobe Rail */}
            <section className="flex flex-col bg-white lg:col-span-6">
              <div className="border-b border-[#E2E0DA] px-5 pt-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-[11px] font-semibold tracking-[0.14em] text-[#0E0E0E] uppercase">
                      Wardrobe Rail
                    </h2>
                    <p className="mt-1 text-[12px] text-[#4A4945]">
                      Select Top, Outerwear (layers over shirt), Bottom, plus
                      optional Shoes &amp; Accessories.
                    </p>
                  </div>

                  {allSelectedOutfitItems.length > 0 && (
                    <button
                      type="button"
                      onClick={clearSelectedOutfit}
                      disabled={isGenerating}
                      className="inline-flex h-7 items-center gap-1 border border-[#E2E0DA] bg-white px-2.5 text-[11px] font-medium text-[#4A4945] transition-colors hover:border-[#0E0E0E] hover:text-[#0E0E0E] disabled:opacity-40"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>Clear</span>
                    </button>
                  )}
                </div>

                {/* Selected Outfit Command Strip */}
                <div className="mt-3.5 flex flex-wrap items-center justify-between gap-3 border border-[#E2E0DA] bg-[#F9F8F6] px-3.5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                      Selected Outfit
                      {drapedSelectionItems.length >= 2 && (
                        <span className="ml-1.5 text-[#0E0E0E]">
                          {renderMode === "composite"
                            ? "· 1-Pass Composite"
                            : plannedPassCount === 2
                              ? hasLayeredOuterwear
                                ? "· 2-Pass Layered Look"
                                : "· 2-Pass Full Look"
                              : "· Layered Upper"}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-[13px] font-medium text-[#0E0E0E]">
                      {selectedOutfitSummary || "No pieces selected yet"}
                    </div>
                  </div>

                  {mode === "tryon" && (
                    <button
                      type="button"
                      onClick={() => void executeAiTryOn()}
                      disabled={
                        !bodyProfile ||
                        !canRunTryOnGarments ||
                        isGenerating ||
                        isRateLimited
                      }
                      className="inline-flex h-10 shrink-0 items-center gap-2 bg-[#0E0E0E] px-4 text-[12px] font-medium tracking-[0.02em] text-white transition-colors hover:bg-[#2B2B29] disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {isGenerating ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          <span>
                            {generatingPasses >= 2
                              ? `Draping (${Math.min(generatingStepIndex, generatingPasses)}/${generatingPasses})…`
                              : "Draping…"}
                          </span>
                        </>
                      ) : isFitDirty ? (
                        <>
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 bg-white"
                          />
                          <span>Re-Drape Fit</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>Try On Outfit</span>
                        </>
                      )}
                    </button>
                  )}
                </div>

                {/* Clean Swap + Tailor Fit */}
                {mode === "tryon" && (
                  <>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <label
                        htmlFor="tryon-clean-swap"
                        title="Use if your original clothes peek through under a slimmer/shorter piece"
                        className="inline-flex cursor-pointer items-center gap-2 select-none"
                      >
                        <button
                          id="tryon-clean-swap"
                          type="button"
                          role="switch"
                          aria-checked={cleanSwap}
                          disabled={isGenerating}
                          onClick={() => setCleanSwap((v) => !v)}
                          title="Use if your original clothes peek through under a slimmer/shorter piece"
                          className={`relative inline-flex h-4 w-7 shrink-0 items-center border transition-colors disabled:opacity-40 ${cleanSwap
                            ? "border-[#0E0E0E] bg-[#0E0E0E]"
                            : "border-[#C8C5BD] bg-[#F2F1ED]"
                            }`}
                        >
                          <span
                            className={`inline-block h-2.5 w-2.5 transition-transform ${cleanSwap
                              ? "translate-x-3.5 bg-white"
                              : "translate-x-0.5 bg-[#4A4945]"
                              }`}
                          />
                        </button>
                        <span className="text-[11px] font-medium text-[#0E0E0E]">
                          Clean Swap
                        </span>
                        <span className="hidden text-[11px] text-[#6C6A64] sm:inline">
                          · Prevents original clothes from peeking under
                          slimmer/shorter pieces
                        </span>
                      </label>
                    </div>

                    {hasLayeredOuterwear && (
                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border border-[#E2E0DA] bg-[#F9F8F6] px-2.5 py-2">
                        <span className="text-[10px] font-medium tracking-[0.1em] text-[#4A4945] uppercase">
                          Outerwear Layer
                        </span>
                        <div
                          role="group"
                          aria-label="Outerwear layering style"
                          className="inline-flex border border-[#E2E0DA] bg-white"
                        >
                          {(
                            [
                              { id: "open-front", label: "Open Front" },
                              { id: "collar-hem-peek", label: "Collar + Hem" },
                              { id: "collar-only", label: "Collar Only" },
                            ] as const
                          ).map((opt, idx) => {
                            const active = tailorFit.outerwearStyle === opt.id;
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                disabled={isGenerating}
                                onClick={() =>
                                  setTailorFit((prev) =>
                                    sanitizeTailorFit({
                                      ...prev,
                                      outerwearStyle: opt.id as OuterwearStyle,
                                    })
                                  )
                                }
                                className={`h-6 px-2 text-[10px] font-medium transition-colors disabled:opacity-40 ${idx > 0 ? "border-l border-[#E2E0DA]" : ""
                                  } ${active
                                    ? "bg-[#0E0E0E] text-white"
                                    : "bg-white text-[#4A4945] hover:text-[#0E0E0E]"
                                  }`}
                              >
                                {opt.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <TailorFitPanel
                      fit={tailorFit}
                      onChange={setTailorFit}
                      onReset={() => setTailorFit(DEFAULT_TAILOR_FIT)}
                      hasUpper={hasAnyUpperSelected}
                      hasLower={Boolean(selectedLowerItem)}
                      upperItem={selectedUpperItem ?? selectedOuterwearItem}
                      outerwearItem={
                        selectedUpperItem ? selectedOuterwearItem : null
                      }
                      lowerItem={selectedLowerItem}
                      cleanSwap={cleanSwap}
                      renderMode={renderMode}
                      onChangeRenderMode={setRenderMode}
                      lastCompositeUrl={lastCompositeUrl}
                      lastEngine={lastRenderEngine}
                      showMiniPreview={true}
                      disabled={isGenerating}
                      defaultExpanded={false}
                      onActiveGuideChange={handleActiveGuideChange}
                    />
                  </>
                )}

                {mode === "tryon" &&
                  (!bodyProfile ||
                    isRateLimited ||
                    (allSelectedOutfitItems.length > 0 &&
                      !canRunTryOnGarments)) && (
                    <p className="mt-2.5 text-[11px] text-[#6C6A64]">
                      {!bodyProfile
                        ? "Set up your Body Profile, pick a Preset Model, or snap in Camera Booth to enable AI Try-On."
                        : isRateLimited
                          ? `Daily limit reached (${dailyLimit}/${dailyLimit}). Resets in 24h — use Layer Board for unlimited styling.`
                          : "Add a Top, Outerwear, or Bottom to run AI Try-On (Shoes & Accessories appear in Styled With)."}
                    </p>
                  )}

                {/* Horizontal Underline Category Rail */}
                <div
                  role="tablist"
                  aria-label="Filter wardrobe garments"
                  className="no-scrollbar mt-3 flex items-stretch gap-5 overflow-x-auto border-t border-[#E2E0DA]"
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
                        className={`relative inline-flex h-10 shrink-0 items-center gap-1.5 text-[12px] tracking-[0.02em] transition-colors ${isActive
                          ? "font-medium text-[#0E0E0E]"
                          : "text-[#6C6A64] hover:text-[#0E0E0E]"
                          }`}
                      >
                        <span>{filter.label}</span>
                        <span
                          className={`text-[11px] tabular-nums ${isActive ? "text-[#0E0E0E]" : "text-[#6C6A64]"
                            }`}
                        >
                          {tryOnFilterCounts[filter.id]}
                        </span>
                        {isActive && (
                          <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Shared-Hairline Garment Picker Grid */}
              <div className="flex-1 overflow-y-auto p-4 sm:p-5">
                {items.length === 0 ? (
                  <div className="flex flex-col items-center justify-center border border-[#E2E0DA] bg-[#F9F8F6] px-6 py-16 text-center">
                    <p className="text-[14px] font-medium text-[#0E0E0E]">
                      No pieces in your closet yet
                    </p>
                    <p className="mt-1 max-w-[32ch] text-[12px] text-[#4A4945]">
                      Add garment cutouts in your closet first, then return here
                      to try them on.
                    </p>
                    <Link
                      href="/closet"
                      className="mt-5 inline-flex h-9 items-center bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
                    >
                      Go to Closet
                    </Link>
                  </div>
                ) : tryOnVisibleItems.length === 0 ? (
                  <div className="py-16 text-center">
                    <p className="text-[13px] text-[#4A4945]">
                      No{" "}
                      {tryOnFilter !== "all"
                        ? CATEGORY_LABELS[tryOnFilter].toLowerCase()
                        : ""}{" "}
                      pieces in your closet yet.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTryOnFilter("all")}
                      className="mt-3 h-9 border border-[#E2E0DA] bg-white px-4 text-[12px] font-medium text-[#0E0E0E] hover:border-[#0E0E0E]"
                    >
                      Show all pieces
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 border-t border-l border-[#E2E0DA] sm:grid-cols-3">
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
                          className="group relative flex flex-col border-r border-b border-[#E2E0DA] bg-white text-left transition-colors hover:bg-[#F9F8F6] disabled:opacity-60"
                        >
                          {isSelected && (
                            <span
                              aria-hidden="true"
                              className="pointer-events-none absolute inset-0 z-10 border-[1.5px] border-[#0E0E0E]"
                            />
                          )}
                          <div className="relative flex aspect-[4/5] w-full items-center justify-center overflow-hidden bg-[#F2F1ED] p-3.5">
                            <span className="absolute top-2 left-2 text-[9px] font-medium tracking-[0.12em] text-[#6C6A64] uppercase">
                              {CATEGORY_LABELS[item.category]}
                            </span>

                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={item.imageUrl}
                              alt={item.name}
                              loading="lazy"
                              className="max-h-full max-w-full object-contain mix-blend-multiply transition-transform duration-300 ease-out group-hover:scale-[1.04]"
                            />

                            {isSelected && (
                              <span className="absolute top-2 right-2 inline-flex h-5 items-center gap-1 bg-[#0E0E0E] px-1.5 text-[9px] font-medium tracking-[0.08em] text-white uppercase">
                                <Check className="h-2.5 w-2.5" />
                                <span>{getSlotTag(item.category)}</span>
                              </span>
                            )}
                          </div>

                          <div className="border-t border-[#E2E0DA] p-2.5 sm:p-3">
                            <div className="truncate text-[12px] font-medium text-[#0E0E0E]">
                              {item.name}
                            </div>
                            <div className="mt-1 flex items-center justify-between text-[11px] text-[#6C6A64] tabular-nums">
                              {item.price > 0 ? (
                                <span className="font-medium text-[#0E0E0E]">
                                  {formatPeso(cpw)}
                                  <span className="font-normal text-[#6C6A64]">
                                    /w
                                  </span>
                                </span>
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
           * LOOKBOOK (Swiss-Japanese Shared-Hairline 3:4 Saved Fits Grid)
           * ---------------------------------------------------------------- */
          <div>
            {lookbookError && (
              <div
                role="alert"
                className="mb-6 flex items-center justify-between border border-[#D9B4B2] bg-[#FAF2F2] px-4 py-3 text-[13px] text-[#8C1D18]"
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
              <section className="flex flex-col items-center justify-center border border-[#E2E0DA] bg-white px-6 py-24 text-center">
                <div className="flex h-12 w-12 items-center justify-center border border-[#E2E0DA] bg-[#F2F1ED] text-[#0E0E0E]">
                  <BookMarked className="h-5 w-5" strokeWidth={1.3} />
                </div>
                <h1 className="mt-5 text-[18px] font-medium tracking-[-0.02em] text-[#0E0E0E]">
                  Your Lookbook is empty
                </h1>
                <p className="mt-1.5 max-w-[38ch] text-[13px] leading-relaxed text-[#4A4945]">
                  Save an AI Try-On drape or an Editorial Layer Board flat-lay
                  to archive your favorite fits here.
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setMode("tryon")}
                    className="inline-flex h-10 items-center gap-1.5 bg-[#0E0E0E] px-4 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    <span>Open AI Try-On</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("board")}
                    className="inline-flex h-10 items-center gap-1.5 border border-[#E2E0DA] bg-white px-4 text-[12px] font-medium text-[#0E0E0E] transition-colors hover:border-[#0E0E0E]"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    <span>Open Layer Board</span>
                  </button>
                </div>
              </section>
            ) : (
              <>
                <h1 className="sr-only">Lookbook</h1>
                <div className="grid grid-cols-2 border-t border-l border-[#E2E0DA] md:grid-cols-3 xl:grid-cols-4">
                  {savedLooks.map((look) => {
                    const isConfirming = confirmDeleteLookId === look.id;
                    const isDeleting = deletingLookId === look.id;

                    return (
                      <article
                        key={look.id}
                        className="group flex flex-col border-r border-b border-[#E2E0DA] bg-white"
                      >
                        <div className="relative aspect-[3/4] w-full overflow-hidden bg-[#F2F1ED]">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={look.imageUrl}
                            alt={look.label}
                            loading="lazy"
                            className="h-full w-full object-cover object-top transition-transform duration-300 ease-out group-hover:scale-[1.02]"
                          />

                          <div className="absolute top-2.5 right-2.5 sm:top-3 sm:right-3">
                            {isConfirming ? (
                              <div className="flex items-center gap-1 border border-[#0E0E0E] bg-white p-1">
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteLook(look.id)}
                                  disabled={isDeleting}
                                  className="bg-[#0E0E0E] px-2 py-1 text-[10px] font-medium text-white hover:bg-[#2B2B29] disabled:opacity-50 sm:text-[11px]"
                                >
                                  {isDeleting ? "…" : "Delete"}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteLookId(null)}
                                  disabled={isDeleting}
                                  className="px-1.5 py-1 text-[10px] text-[#4A4945] hover:text-[#0E0E0E] sm:text-[11px]"
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
                                className="flex h-8 w-8 items-center justify-center border border-[#E2E0DA] bg-white/90 text-[#6C6A64] opacity-100 transition-opacity hover:border-[#0E0E0E] hover:text-[#0E0E0E] focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                              >
                                <Trash2
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.6}
                                />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-col gap-1 border-t border-[#E2E0DA] px-3 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3 sm:px-4 sm:py-3.5">
                          <h2
                            title={look.label}
                            className="truncate text-[12px] font-medium text-[#0E0E0E] sm:text-[13px]"
                          >
                            {look.label}
                          </h2>
                          <span className="shrink-0 text-[10px] tracking-[0.06em] text-[#6C6A64] uppercase tabular-nums sm:text-[11px]">
                            {formatSavedDate(look.createdAt)}
                          </span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        ) : items.length === 0 ? (
          <div className="border border-[#E2E0DA] bg-white px-6 py-20 text-center">
            <h1 className="text-[18px] font-medium tracking-[-0.02em] text-[#0E0E0E]">
              Your layer board is empty
            </h1>
            <p className="mx-auto mt-1.5 max-w-[36ch] text-[13px] text-[#4A4945]">
              Add garment cutouts in your closet first, then arrange them on the
              editorial studio board.
            </p>
            <Link
              href="/closet"
              className="mt-6 inline-flex h-10 items-center bg-[#0E0E0E] px-5 text-[12px] font-medium text-white transition-colors hover:bg-[#2B2B29]"
            >
              Go to Closet
            </Link>
          </div>
        ) : (
          /* ----------------------------------------------------------------
           * EDITORIAL LAYER BOARD (Magazine Flat-Lay with Drag, Scale & Export)
           * ---------------------------------------------------------------- */
          <LayerBoard
            items={items}
            itemsById={itemsById}
            itemsByCategory={itemsByCategory}
            selectedBySlot={selectedBySlot}
            onTogglePiece={toggleBoardPiece}
            onClearSlot={clearBoardSlot}
            onClearAll={clearBoardAll}
            onShuffle={shuffleBoardFit}
            onSaveBoardLook={handleSaveBoardLook}
            boardFeedback={boardFeedback}
            boardError={boardError}
            tailorFit={tailorFit}
            onChangeTailorFit={setTailorFit}
            onResetTailorFit={() => setTailorFit(DEFAULT_TAILOR_FIT)}
          />
        )}
      </main>

      <BodyProfileModal
        open={isProfileModalOpen}
        initialProfile={bodyProfile}
        onClose={() => setIsProfileModalOpen(false)}
        onSaved={(savedProfile) => {
          sessionResultCacheRef.current.clear();
          setBodyProfile(savedProfile);
          setTryOnResultUrl(null);
          setLastRenderedFitKey(null);
          setPreviewedOutfit(null);
          setSavedCurrentResultKey(null);
          setViewStage("before");
          setTryOnError(null);
        }}
      />
    </div>
  );
}
