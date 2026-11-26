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
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  ArrowRight,
  BookMarked,
  Camera,
  Check,
  ChevronDown,
  Layers,
  Loader2,
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
import { RollingNumber } from "@/components/RollingNumber";
import { TailorFitPanel } from "@/components/TailorFitPanel";
import {
  hydrateStagedOutfitFromStorage,
  readStagedOutfit,
  useViewTransition,
  ViewTransitionStage,
  writeStagedOutfit,
} from "@/components/ViewTransitionProvider";
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
  isDefaultTailorFit,
  sanitizeTailorFit,
  type OuterwearStyle,
  type TailorFitConfig,
  type TailorGuideKind,
  type TryOnRenderMode,
} from "@/lib/types/tailorFit";
import { cleanGarmentName } from "@/lib/utils/garmentName";

const EASE = [0.22, 1, 0.36, 1] as const;
const FAST = { duration: 0.22, ease: EASE };

interface CanvasClientProps {
  items: WardrobeItemDTO[];
  initialBodyProfile: BodyProfileDTO | null;
  initialSavedLooks: SavedLookDTO[];
  initialRemaining: number | null;
  isUnlimited: boolean;
  dailyLimit: number;
  userName?: string | null;
  /** Optional outfit hand-off from the Closet dock (validated against `items`). */
  initialSelection?: {
    top?: string;
    outerwear?: string;
    bottom?: string;
    shoes?: string;
    accessories?: string[];
  };
  hideNavbar?: boolean;
  onItemsChange?: (items: WardrobeItemDTO[]) => void;
  onBodyProfileChange?: (profile: BodyProfileDTO) => void;
  onSavedLooksChange?: (looks: SavedLookDTO[]) => void;
  onQuotaChange?: (remaining: number | null, unlimited: boolean) => void;
  onBoardHeaderStateChange?: (state: {
    visible: boolean;
    disabled: boolean;
    isLogging: boolean;
  }) => void;
  boardLogTriggerRef?: { current: (() => void) | null };
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
    .map((p) => cleanGarmentName(p.name, p.category))
    .filter(Boolean)
    .join(" + ");
  if (!joined) return "Saved Fit";
  return joined.length > 120 ? `${joined.slice(0, 117)}…` : joined;
}

function buildSilhouetteNote(
  upper: WardrobeItemDTO | null,
  outerwear: WardrobeItemDTO | null,
  lower: WardrobeItemDTO | null,
  fit: TailorFitConfig
): string | null {
  const effectiveUpper = outerwear ?? upper;
  if (!effectiveUpper || !lower) return null;

  const upperName = cleanGarmentName(
    effectiveUpper.name,
    effectiveUpper.category
  );
  const lowerName = cleanGarmentName(lower.name, lower.category);
  const isBoxyUpper =
    fit.topWidthScale >= 1.12 || /boxy|oversized|hoodie/i.test(upperName);
  const isWideLower =
    fit.bottomWidthScale >= 1.1 || /wide|baggy|pleated/i.test(lowerName);

  if (fit.tuckMode === "tucked") {
    return "Tucked 1/3 : 2/3 proportion — elongated leg line";
  }
  if (isBoxyUpper && isWideLower) {
    return "Boxy + Wide — try a French tuck";
  }
  if (fit.topCropPct >= 10) {
    return "Cropped 1/3 : 2/3 silhouette — high waist break";
  }
  if (fit.topCropPct < 0 && fit.bottomWidthScale <= 0.92) {
    return "Longline 2/3 : 1/3 column silhouette";
  }
  if (outerwear && upper) {
    return "Layered 1/3 : 2/3 silhouette — open front balance";
  }
  return "Balanced 1/3 : 2/3 silhouette";
}

export function CanvasClient({
  items,
  initialBodyProfile,
  initialSavedLooks,
  initialRemaining,
  isUnlimited,
  dailyLimit,
  userName,
  initialSelection,
  hideNavbar = false,
  onItemsChange,
  onBodyProfileChange,
  onSavedLooksChange,
  onQuotaChange,
  onBoardHeaderStateChange,
  boardLogTriggerRef,
}: CanvasClientProps) {
  const router = useRouter();
  const { navigateToView } = useViewTransition();
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

  // Synced outfit selection across Closet dock, AI Try-On & Camera Booth
  const [tryOnFilter, setTryOnFilter] = useState<TryOnFilter>("all");
  const hasUrlSelection = Boolean(
    initialSelection?.top ||
      initialSelection?.outerwear ||
      initialSelection?.bottom ||
      initialSelection?.shoes ||
      (initialSelection?.accessories?.length ?? 0) > 0
  );
  const pickInitialId = (
    id: string | null | undefined,
    category: WardrobeCategory
  ): string | null =>
    id && items.some((item) => item.id === id && item.category === category)
      ? id
      : null;
  const initialStaged = hasUrlSelection ? null : readStagedOutfit();
  const [selectedUpperId, setSelectedUpperId] = useState<string | null>(() =>
    pickInitialId(
      hasUrlSelection ? initialSelection?.top : initialStaged?.top,
      "top"
    )
  );
  const [selectedOuterwearId, setSelectedOuterwearId] = useState<string | null>(
    () =>
      pickInitialId(
        hasUrlSelection ? initialSelection?.outerwear : initialStaged?.outerwear,
        "outerwear"
      )
  );
  const [selectedLowerId, setSelectedLowerId] = useState<string | null>(() =>
    pickInitialId(
      hasUrlSelection ? initialSelection?.bottom : initialStaged?.bottom,
      "bottom"
    )
  );
  const [selectedShoesId, setSelectedShoesId] = useState<string | null>(() =>
    pickInitialId(
      hasUrlSelection ? initialSelection?.shoes : initialStaged?.shoes,
      "shoes"
    )
  );
  const [selectedAccessoryIds, setSelectedAccessoryIds] = useState<string[]>(
    () => {
      const sourceAcc = hasUrlSelection
        ? initialSelection?.accessories ?? []
        : initialStaged?.accessories ?? [];
      return sourceAcc.filter((id) =>
        items.some((item) => item.id === id && item.category === "accessory")
      );
    }
  );
  const [stageReady, setStageReady] = useState(
    () => hasUrlSelection || readStagedOutfit() !== null
  );

  useEffect(() => {
    if (stageReady) return;
    const stored = hydrateStagedOutfitFromStorage();
    if (stored) {
      const pick = (id: string | null, category: WardrobeCategory) =>
        id && items.some((item) => item.id === id && item.category === category)
          ? id
          : null;
      setSelectedUpperId(pick(stored.top, "top"));
      setSelectedOuterwearId(pick(stored.outerwear, "outerwear"));
      setSelectedLowerId(pick(stored.bottom, "bottom"));
      setSelectedShoesId(pick(stored.shoes, "shoes"));
      setSelectedAccessoryIds(
        stored.accessories.filter((id) =>
          items.some((item) => item.id === id && item.category === "accessory")
        )
      );
    }
    setStageReady(true);
  }, [stageReady, items]);

  useEffect(() => {
    if (!stageReady) return;
    writeStagedOutfit({
      top: selectedUpperId,
      outerwear: selectedOuterwearId,
      bottom: selectedLowerId,
      shoes: selectedShoesId,
      accessories: selectedAccessoryIds,
    });
  }, [
    stageReady,
    selectedUpperId,
    selectedOuterwearId,
    selectedLowerId,
    selectedShoesId,
    selectedAccessoryIds,
  ]);

  // Try-On result state
  const [tryOnResultUrl, setTryOnResultUrl] = useState<string | null>(null);
  const [lastCompositeUrl, setLastCompositeUrl] = useState<string | null>(null);
  const [lastRenderEngine, setLastRenderEngine] = useState<string | null>(null);
  const [previewedOutfit, setPreviewedOutfit] =
    useState<PreviewedOutfitSnapshot | null>(null);
  const [viewStage, setViewStage] = useState<"after" | "before">("after");
  const [showProportionGrid, setShowProportionGrid] = useState(false);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
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

  // Quick log wear state (with optimistic live CPW animation in the right dock)
  const [isLoggingTryOnWear, setIsLoggingTryOnWear] = useState(false);
  const [loggedTryOnKey, setLoggedTryOnKey] = useState<string | null>(null);
  const [optimisticWearAdds, setOptimisticWearAdds] = useState<
    Record<string, number>
  >({});
  const [tailorDrawerOpen, setTailorDrawerOpen] = useState(false);

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
    setOptimisticWearAdds({});
  }, [items]);

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
        .map((item) => cleanGarmentName(item.name, item.category))
        .join(" + "),
    [allSelectedOutfitItems]
  );

  const silhouetteNote = useMemo(
    () =>
      buildSilhouetteNote(
        selectedUpperItem,
        selectedOuterwearItem,
        selectedLowerItem,
        tailorFit
      ),
    [selectedUpperItem, selectedOuterwearItem, selectedLowerItem, tailorFit]
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

  const isRateLimited = !unlimited && (remaining ?? 0) <= 0;

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
            const nextUnlimited =
              typeof evt.unlimited === "boolean" ? evt.unlimited : unlimited;
            const nextRemaining =
              evt.remaining === null || typeof evt.remaining === "number"
                ? evt.remaining
                : remaining;
            if (typeof evt.unlimited === "boolean") {
              setUnlimited(evt.unlimited);
            }
            if (evt.remaining === null || typeof evt.remaining === "number") {
              setRemaining(evt.remaining);
            }
            onQuotaChange?.(nextRemaining, nextUnlimited);
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

      if (typeof payload?.unlimited === "boolean" || payload?.remaining === null || typeof payload?.remaining === "number") {
        const nextUnlimited =
          typeof payload?.unlimited === "boolean" ? payload.unlimited : unlimited;
        const nextRemaining =
          payload?.remaining === null || typeof payload?.remaining === "number"
            ? payload.remaining
            : remaining;
        if (typeof payload?.unlimited === "boolean") {
          setUnlimited(payload.unlimited);
        }
        if (payload?.remaining === null || typeof payload?.remaining === "number") {
          setRemaining(payload.remaining);
        }
        onQuotaChange?.(nextRemaining, nextUnlimited);
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

      const nextLooks = [result.data!, ...savedLooks];
      setSavedLooks(nextLooks);
      onSavedLooksChange?.(nextLooks);
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
    onBodyProfileChange?.(saved.data);
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
    const nextLooks = [result.data!, ...savedLooks];
    setSavedLooks(nextLooks);
    onSavedLooksChange?.(nextLooks);
    router.refresh();
  }

  async function handleDeleteLook(id: string) {
    setLookbookError(null);
    setDeletingLookId(id);
    const previous = savedLooks;
    const nextLooks = savedLooks.filter((look) => look.id !== id);
    setSavedLooks(nextLooks);
    onSavedLooksChange?.(nextLooks);

    try {
      const result = await deleteLook(id);
      if (!result.ok) {
        setSavedLooks(previous);
        onSavedLooksChange?.(previous);
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
      const idSet = new Set(loggableTryOnIds);
      const todayIso = new Date().toISOString().slice(0, 10);
      if (onItemsChange) {
        onItemsChange(
          items.map((item) =>
            idSet.has(item.id)
              ? { ...item, wearCount: item.wearCount + 1, lastWornDate: todayIso }
              : item
          )
        );
      } else {
        setOptimisticWearAdds((prev) => {
          const next = { ...prev };
          for (const id of loggableTryOnIds) {
            next[id] = (next[id] ?? 0) + 1;
          }
          return next;
        });
      }
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
      const idSet = new Set(ids);
      const todayIso = new Date().toISOString().slice(0, 10);
      onItemsChange?.(
        items.map((item) =>
          idSet.has(item.id)
            ? { ...item, wearCount: item.wearCount + 1, lastWornDate: todayIso }
            : item
        )
      );
      setBoardFeedback(
        `Logged +1 wear for ${result.data?.loggedCount ?? ids.length} ${(result.data?.loggedCount ?? ids.length) === 1 ? "piece" : "pieces"
        }.`
      );
      router.refresh();
    });
  }

  useEffect(() => {
    if (boardLogTriggerRef) {
      boardLogTriggerRef.current = handleLogBoardOutfit;
    }
  });

  useEffect(() => {
    onBoardHeaderStateChange?.({
      visible: mode === "board",
      disabled: selectedBoardItems.length === 0 || isLoggingOutfit,
      isLogging: isLoggingOutfit,
    });
  }, [mode, selectedBoardItems.length, isLoggingOutfit, onBoardHeaderStateChange]);

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
  const isTailorModified = !isDefaultTailorFit(tailorFit);

  const dockModeTag =
    drapedSelectionItems.length === 0
      ? null
      : drapedSelectionItems.length === 1
        ? "SINGLE-PASS"
        : renderMode === "composite"
          ? "1-PASS COMPOSITE"
          : plannedPassCount === 2
            ? hasLayeredOuterwear
              ? "2-PASS LAYERED"
              : "2-PASS FULL LOOK"
            : "SINGLE-PASS LAYERED";

  const studioContent = (
    <>
      {/* Clean Title-Case Studio Mode Rail */}
      <div className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] transition-colors duration-150">
          <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 sm:px-8 lg:px-10">
            <div
              role="tablist"
              aria-label="Studio mode"
              className="no-scrollbar flex min-w-0 flex-1 items-stretch gap-6 overflow-x-auto sm:gap-8"
            >
              {(
                [
                  { id: "tryon", label: "Try-On" },
                  { id: "booth", label: "Camera Booth" },
                  { id: "board", label: "Layer Board" },
                  { id: "lookbook", label: "Lookbook", count: savedLooks.length },
                ] as const
              ).map((tab) => {
                const isActive = mode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setMode(tab.id)}
                    className={`relative inline-flex h-11 shrink-0 items-center gap-1.5 text-[13px] transition-colors duration-150 focus-visible:outline-offset-[-2px] ${
                      isActive
                        ? "font-semibold text-[var(--ink-primary)]"
                        : "font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                    }`}
                  >
                    <span>{tab.label}</span>
                    {"count" in tab && (
                      <span className="tabular-nums">{tab.count}</span>
                    )}
                    {isActive && (
                      <motion.span
                        layoutId="studio-mode-underline"
                        transition={{ duration: 0.26, ease: EASE }}
                        className="absolute inset-x-0 -bottom-px h-[1.5px] bg-[var(--ink-primary)]"
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <div className="hidden shrink-0 items-center gap-2 text-[12px] text-[var(--ink-muted)] tabular-nums sm:flex">
              {mode === "tryon" && !unlimited && remaining !== null && (
                <span>
                  {remaining}/{dailyLimit} renders left
                </span>
              )}
              {mode === "booth" && <span>3:4 self-timer</span>}
              {mode === "board" && <span>4:5 flat-lay</span>}
              {mode === "lookbook" && (
                <span>{savedLooks.length} saved</span>
              )}
            </div>
          </div>
        </div>

        <main className="mx-auto max-w-[1440px] px-5 pt-5 pb-[calc(7rem+env(safe-area-inset-bottom))] sm:px-8 sm:pt-7 lg:px-10">
        {showSyncedClosetSplit ? (
          /* ----------------------------------------------------------------
           * 2-COLUMN SWISS EDITORIAL STUDIO (28px Outer Cards)
           * ---------------------------------------------------------------- */
          <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-12">
            {/* LEFT COLUMN: The Lookbook Stage */}
            <div className="lg:sticky lg:top-[76px] lg:col-span-6">
              {mode === "booth" ? (
                <CameraBooth
                  hasTryOnSelection={canRunTryOnGarments}
                  selectedSummary={selectedOutfitSummary}
                  onTryOnFrame={handleBoothTryOnFrame}
                  onSetStudioAvatar={handleBoothSetStudioAvatar}
                />
              ) : (
                <div>
                  <h1 className="sr-only">Try-On Studio</h1>

                  {/* Single Quiet Utility Row Above Portrait Frame */}
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-1">
                    {bodyProfile ? (
                      <span className="text-[13px] text-[var(--ink-muted)] tabular-nums">
                        {bodyProfile.heightCm} cm · {bodyProfile.weightKg} kg ·{" "}
                        {PREFERRED_FIT_LABELS[bodyProfile.preferredFit]}
                      </span>
                    ) : (
                      <span className="text-[13px] font-medium text-[var(--ink-muted)]">
                        Portrait stage
                      </span>
                    )}

                    <div className="ml-auto flex items-center gap-5">
                      {bodyProfile && (
                        <div
                          role="group"
                          aria-label="Stage view controls"
                          className="inline-flex items-center gap-4"
                        >
                          {tryOnResultUrl && (
                            <>
                              <button
                                type="button"
                                aria-pressed={viewStage === "before"}
                                onClick={() => setViewStage("before")}
                                className={`relative pb-0.5 text-[13px] transition-colors duration-150 ${
                                  viewStage === "before"
                                    ? "font-semibold text-[var(--ink-primary)]"
                                    : "font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                }`}
                              >
                                Before
                                {viewStage === "before" && (
                                  <motion.span
                                    layoutId="stage-view-underline"
                                    transition={FAST}
                                    className="absolute inset-x-0 -bottom-0.5 h-[1.5px] bg-[var(--ink-primary)]"
                                  />
                                )}
                              </button>
                              <button
                                type="button"
                                aria-pressed={viewStage === "after"}
                                onClick={() => setViewStage("after")}
                                className={`relative pb-0.5 text-[13px] transition-colors duration-150 ${
                                  viewStage === "after"
                                    ? "font-semibold text-[var(--ink-primary)]"
                                    : "font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                                }`}
                              >
                                After
                                {viewStage === "after" && (
                                  <motion.span
                                    layoutId="stage-view-underline"
                                    transition={FAST}
                                    className="absolute inset-x-0 -bottom-0.5 h-[1.5px] bg-[var(--ink-primary)]"
                                  />
                                )}
                              </button>
                            </>
                          )}

                          <button
                            type="button"
                            aria-pressed={showProportionGrid}
                            onClick={() =>
                              setShowProportionGrid((prev) => !prev)
                            }
                            className={`relative pb-0.5 text-[13px] transition-colors duration-150 ${
                              showProportionGrid
                                ? "font-semibold text-[var(--ink-primary)]"
                                : "font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                            }`}
                          >
                            Grid
                            {showProportionGrid && (
                              <motion.span
                                initial={{ opacity: 0, scaleX: 0.6 }}
                                animate={{ opacity: 1, scaleX: 1 }}
                                transition={FAST}
                                className="absolute inset-x-0 -bottom-0.5 h-[1.5px] bg-[var(--ink-primary)]"
                              />
                            )}
                          </button>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => setIsProfileModalOpen(true)}
                        disabled={isGenerating}
                        className="text-[13px] font-medium text-[var(--ink-muted)] transition-colors duration-150 hover:text-[var(--ink-primary)] disabled:opacity-40"
                      >
                        Profile
                      </button>
                    </div>
                  </div>

                  {/* Clean Borderless Rounded Portrait Frame */}
                  <div
                    className={`relative flex min-h-[500px] flex-col items-center justify-center overflow-hidden rounded-[20px] bg-[var(--bg-tile)] px-6 pt-6 transition-colors duration-150 sm:min-h-[540px] sm:px-7 ${
                      styledWithItems.length > 0 ? "pb-24" : "pb-6"
                    }`}
                  >
                    {!bodyProfile ? (
                      <div className="relative z-10 m-auto flex max-w-[340px] flex-col items-center py-12 text-center">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[var(--ink-primary)]">
                          <UserRound className="h-5 w-5" strokeWidth={1.4} />
                        </div>
                        <h2 className="mt-5 text-[18px] font-bold tracking-[-0.025em] text-[var(--ink-primary)]">
                          Set up your model profile
                        </h2>
                        <p className="mt-2 text-[13px] leading-relaxed text-[var(--ink-muted)]">
                          Frame a 3:4 portrait, select a studio preset, or
                          capture directly in Camera Booth.
                        </p>
                        <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
                          <button
                            type="button"
                            onClick={() => setIsProfileModalOpen(true)}
                            className="inline-flex h-11 items-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 text-[13px] font-semibold text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)]"
                          >
                            <span>Set Up Profile</span>
                            <ArrowRight className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setMode("booth")}
                            className="inline-flex h-11 items-center gap-1.5 text-[13px] font-medium text-[var(--ink-muted)] transition-colors duration-150 hover:text-[var(--ink-primary)]"
                          >
                            <Camera className="h-3.5 w-3.5" />
                            <span>Camera Booth</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="relative z-[2] mx-auto my-auto flex max-h-[540px] max-w-full items-center justify-center">
                        <div className="relative inline-flex max-h-[540px] max-w-full items-center justify-center overflow-hidden rounded-[16px]">
                          <AnimatePresence mode="wait" initial={false}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <motion.img
                              key={`${tryOnResultUrl ? viewStage : "profile"}-${activeModelSrc}`}
                              src={activeModelSrc}
                              alt={
                                tryOnResultUrl && viewStage === "after"
                                  ? "Virtual try-on result"
                                  : "Your Body Profile model"
                              }
                              initial={{ opacity: 0, scale: 0.992 }}
                              animate={{
                                opacity:
                                  isGenerating && !streamingStageLabel ? 0.3 : 1,
                                scale: 1,
                              }}
                              exit={{ opacity: 0, scale: 0.992 }}
                              transition={FAST}
                              className="max-h-[540px] w-auto max-w-full object-contain"
                            />
                          </AnimatePresence>

                          {/* Subtle 1px Rule-of-Thirds Proportion Grid Overlay */}
                          <AnimatePresence>
                            {showProportionGrid && !isGenerating && (
                              <motion.div
                                key="proportion-grid"
                                aria-hidden="true"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.24, ease: EASE }}
                                className="pointer-events-none absolute inset-0 z-10"
                              >
                                <motion.div
                                  initial={{ scaleY: 0 }}
                                  animate={{ scaleY: 1 }}
                                  exit={{ scaleY: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="absolute inset-y-0 left-1/3 w-px origin-top bg-white/40 mix-blend-difference"
                                />
                                <motion.div
                                  initial={{ scaleY: 0 }}
                                  animate={{ scaleY: 1 }}
                                  exit={{ scaleY: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="absolute inset-y-0 left-2/3 w-px origin-top bg-white/40 mix-blend-difference"
                                />
                                <motion.div
                                  initial={{ scaleX: 0 }}
                                  animate={{ scaleX: 1 }}
                                  exit={{ scaleX: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="absolute inset-x-0 top-1/3 h-px origin-left bg-white/65 shadow-[0_1px_0_rgba(20,20,21,0.4)]"
                                />
                                <motion.div
                                  initial={{ scaleX: 0 }}
                                  animate={{ scaleX: 1 }}
                                  exit={{ scaleX: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="absolute inset-x-0 top-2/3 h-px origin-left bg-white/65 shadow-[0_1px_0_rgba(20,20,21,0.4)]"
                                />
                                <motion.span
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="absolute top-[calc(33.33%-18px)] left-2 rounded-[4px] bg-[#141415]/80 px-1.5 py-0.5 text-[9px] font-medium tracking-[0.1em] text-[#F5F5F5] tabular-nums"
                                >
                                  1/3
                                </motion.span>
                                <motion.span
                                  initial={{ opacity: 0 }}
                                  animate={{ opacity: 1 }}
                                  exit={{ opacity: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="absolute top-[calc(66.67%-18px)] left-2 rounded-[4px] bg-[#141415]/80 px-1.5 py-0.5 text-[9px] font-medium tracking-[0.1em] text-[#F5F5F5] tabular-nums"
                                >
                                  2/3
                                </motion.span>
                              </motion.div>
                            )}
                          </AnimatePresence>

                          {/* Live Hem / Waist Guide Overlay */}
                          <AnimatePresence>
                            {stageGuideOverlay && !isGenerating && (
                              <motion.div
                                key={stageGuideOverlay.label}
                                aria-hidden="true"
                                style={{ top: `${stageGuideOverlay.topPct}%` }}
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                transition={{ duration: 0.24, ease: EASE }}
                                className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2 transition-[top] duration-75"
                              >
                                <motion.div
                                  initial={{ scaleX: 0 }}
                                  animate={{ scaleX: 1 }}
                                  exit={{ scaleX: 0 }}
                                  transition={{ duration: 0.24, ease: EASE }}
                                  className="w-full origin-left border-t border-dashed border-[#111111]/85 shadow-[0_1px_0_rgba(255,255,255,0.8)]"
                                />
                                <span className="absolute right-2 -top-6 rounded-[6px] bg-[#141415] px-2 py-0.5 text-[10px] font-medium tracking-[0.1em] text-white uppercase tabular-nums">
                                  {stageGuideOverlay.label}
                                </span>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </div>
                    )}

                    {/* Progressive Pass-1 Streaming Indicator */}
                    {isGenerating && streamingStageLabel && (
                      <div
                        role="status"
                        className="pointer-events-none absolute top-4 right-5 z-20 inline-flex items-center gap-2 rounded-[10px] bg-[#141415] px-3.5 py-2 text-[10px] font-medium tracking-[0.12em] text-[#F5F5F5] uppercase dark:border dark:border-[#262629]"
                      >
                        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                        <span className="whitespace-nowrap">
                          {streamingStageLabel}
                        </span>
                        {streamingPass1Cached && (
                          <span className="border-l border-white/25 pl-2 text-[#8A8A8E]">
                            Cached
                          </span>
                        )}
                      </div>
                    )}

                    {isGenerating && !streamingStageLabel && (
                      <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-[var(--bg-tile)]/92 px-6 text-center">
                        <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-primary)]" />
                        <p className="mt-3 text-[13px] font-semibold tracking-[-0.01em] text-[var(--ink-primary)]">
                          {generatingPasses === 2
                            ? hasLayeredOuterwear
                              ? "Draping layered outfit (2 passes)…"
                              : "Draping full outfit (2 passes)…"
                            : drapedSelectionItems.length >= 2
                              ? "Draping layered outfit (1:1 composite)…"
                              : "Draping garment onto silhouette…"}
                        </p>
                        {drapedSelectionItems.length > 0 && (
                          <p className="mt-1.5 max-w-[34ch] truncate text-[12px] text-[var(--ink-muted)]">
                            {buildPieceLabel(drapedSelectionItems)}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Minimal Bottom "Styled With" Strip for Shoes & Accessories */}
                    {styledWithItems.length > 0 && (
                      <div className="absolute inset-x-4 bottom-4 z-10 rounded-[16px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3.5 py-2.5">
                        <div className="flex items-center gap-3 overflow-x-auto">
                          <span className="shrink-0 text-[11px] font-medium text-[var(--ink-muted)]">
                            Styled with
                          </span>
                          <div className="flex items-center gap-2">
                            {styledWithItems.map((piece) => {
                              const pieceTitle = cleanGarmentName(
                                piece.name,
                                piece.category
                              );
                              return (
                                <div
                                  key={piece.id}
                                  className="flex shrink-0 items-center gap-2 rounded-[10px] bg-[var(--bg-well)] py-1 pr-2 pl-1.5"
                                >
                                  <div className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[var(--bg-tile)] p-1">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img
                                      src={piece.imageUrl}
                                      alt={pieceTitle}
                                      className="max-h-full max-w-full object-contain mix-blend-multiply dark:mix-blend-normal"
                                    />
                                  </div>
                                  <div className="min-w-0">
                                    <div className="max-w-[100px] truncate text-[12px] font-medium text-[var(--ink-primary)]">
                                      {pieceTitle}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => removeStyledPiece(piece)}
                                    disabled={isGenerating}
                                    aria-label={`Remove ${pieceTitle}`}
                                    className="flex h-6 w-6 items-center justify-center text-[var(--ink-muted)] transition-colors hover:text-[var(--ink-primary)] disabled:opacity-40"
                                  >
                                    <X className="h-3 w-3" />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Error Banner */}
                  {tryOnError && (
                    <div
                      role="alert"
                      className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-[16px] border border-[var(--status-danger-border)] bg-[var(--status-danger-bg)] px-5 py-3 text-[12px] text-[var(--status-danger-ink)]"
                    >
                      <span>{tryOnError}</span>
                      {tryOnBusyFallback && (
                        <button
                          type="button"
                          onClick={() => setMode("board")}
                          className="shrink-0 font-semibold underline underline-offset-4 hover:opacity-75"
                        >
                          Open Layer Board
                        </button>
                      )}
                    </div>
                  )}

                  {/* Compact Post-Render Actions Below Frame */}
                  {bodyProfile &&
                    (tryOnResultUrl || loggableTryOnIds.length > 0) && (
                      <div className="mt-3.5 flex flex-wrap items-center justify-end gap-3 px-1">
                        {tryOnResultUrl && (
                          <button
                            type="button"
                            onClick={() => void handleSaveLook()}
                            disabled={
                              isSavingLook || isGenerating || isCurrentLookSaved
                            }
                            className="group inline-flex h-10 items-center text-[12px] font-semibold text-[var(--ink-primary)] transition-opacity duration-150 hover:opacity-75 disabled:opacity-45"
                          >
                            <span
                              aria-hidden="true"
                              className={`-mr-4 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border transition-colors duration-150 ${
                                isCurrentLookSaved
                                  ? "border-[var(--ink-primary)]"
                                  : "border-[var(--ink-primary)]/40 group-hover:border-[var(--ink-primary)]"
                              }`}
                            />
                            <span className="relative z-[1]">
                              {isSavingLook
                                ? "Saving…"
                                : isCurrentLookSaved
                                  ? "Saved Look"
                                  : "Save Look"}
                            </span>
                          </button>
                        )}

                        {loggableTryOnIds.length > 0 && (
                          <button
                            type="button"
                            onClick={() => void handleLogTryOnWear()}
                            disabled={isLoggingTryOnWear || isGenerating}
                            className="inline-flex h-10 items-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 text-[12px] font-semibold text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)] disabled:opacity-40"
                          >
                            {isLoggingTryOnWear ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : loggedTryOnKey === loggableTryOnKey ? (
                              <Check className="h-3.5 w-3.5" strokeWidth={2.2} />
                            ) : null}
                            <span>
                              {loggedTryOnKey === loggableTryOnKey
                                ? "Logged Today"
                                : "Log Worn Today"}
                            </span>
                          </button>
                        )}
                      </div>
                    )}
                </div>
              )}
            </div>

            {/* RIGHT COLUMN: Closet Inventory & Unified Outfit Dock */}
            <section className="flex flex-col overflow-hidden rounded-[28px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] transition-colors duration-150 lg:col-span-6">
              {/* Single Unified Hairline-Separated Outfit Dock */}
              <div className="border-b border-[var(--border-hairline)] px-6 pt-6 pb-5 sm:px-7">
                {/* Row 1: Micro-label + CLEAR text button */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold tracking-[0.16em] text-[var(--ink-muted)] uppercase">
                    <span>Selected Outfit</span>
                    {dockModeTag && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-[var(--ink-primary)]">
                          {dockModeTag}
                        </span>
                      </>
                    )}
                  </div>

                  {allSelectedOutfitItems.length > 0 && (
                    <button
                      type="button"
                      onClick={clearSelectedOutfit}
                      disabled={isGenerating}
                      className="text-[10px] font-semibold tracking-[0.16em] text-[var(--ink-muted)] uppercase transition-colors duration-150 hover:text-[var(--ink-primary)] disabled:opacity-40"
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Row 2: Active Garment Names + Inline Clean Swap + Inline Tailor Fit Trigger */}
                <div className="mt-2.5 flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
                  <div className="basis-full overflow-hidden sm:basis-auto sm:min-w-0 sm:flex-1">
                    <AnimatePresence mode="wait" initial={false}>
                      <motion.h2
                        key={selectedOutfitSummary || "empty"}
                        title={selectedOutfitSummary || undefined}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={FAST}
                        className="truncate text-[19px] leading-tight font-bold tracking-[-0.025em] text-[var(--ink-primary)] sm:text-[21px]"
                      >
                        {selectedOutfitSummary || "Select pieces below"}
                      </motion.h2>
                    </AnimatePresence>
                  </div>

                  {mode === "tryon" && (
                    <div className="flex shrink-0 items-center gap-4">
                      <label
                        htmlFor="tryon-clean-swap"
                        title="Prevents original clothes from peeking under slimmer or shorter pieces"
                        className="inline-flex cursor-pointer items-center gap-2 select-none"
                      >
                        <button
                          id="tryon-clean-swap"
                          type="button"
                          role="switch"
                          aria-checked={cleanSwap}
                          disabled={isGenerating}
                          onClick={() => setCleanSwap((v) => !v)}
                          className={`relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-150 disabled:opacity-40 ${
                            cleanSwap
                              ? "border-[var(--ink-primary)] bg-[var(--ink-primary)]"
                              : "border-[var(--border-mid)] bg-[var(--bg-well)]"
                          }`}
                        >
                          <span
                            className={`inline-block h-3 w-3 rounded-full transition-transform duration-150 ${
                              cleanSwap
                                ? "translate-x-[16px] bg-[var(--bg-surface)]"
                                : "translate-x-[2px] bg-[var(--ink-muted)]"
                            }`}
                          />
                        </button>
                        <span className="text-[10px] font-semibold tracking-[0.12em] text-[var(--ink-secondary)] uppercase">
                          Clean Swap
                        </span>
                      </label>

                      <button
                        type="button"
                        onClick={() => setTailorDrawerOpen((prev) => !prev)}
                        aria-expanded={tailorDrawerOpen}
                        className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-primary)] uppercase transition-opacity duration-150 hover:opacity-70"
                      >
                        {isTailorModified && (
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 rounded-full bg-[var(--ink-primary)]"
                          />
                        )}
                        <span>Tailor Fit</span>
                        <ChevronDown
                          aria-hidden="true"
                          className={`h-3.5 w-3.5 transition-transform duration-150 ${
                            tailorDrawerOpen ? "rotate-180" : ""
                          }`}
                        />
                      </button>
                    </div>
                  )}
                </div>

                {/* Concise 1-line Silhouette & Proportion Note */}
                <AnimatePresence initial={false}>
                  {mode === "tryon" && silhouetteNote && (
                    <motion.p
                      key={silhouetteNote}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -4 }}
                      transition={FAST}
                      className="mt-1.5 truncate text-[12px] text-[var(--ink-secondary)]"
                    >
                      {silhouetteNote}
                    </motion.p>
                  )}
                </AnimatePresence>

                {/* Inline Outerwear Layering Style Bar (when Top + Outerwear both selected) */}
                {mode === "tryon" && hasLayeredOuterwear && (
                  <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-3">
                    <span className="text-[10px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase">
                      Outerwear Layer
                    </span>
                    <div
                      role="group"
                      aria-label="Outerwear layering style"
                      className="inline-flex flex-wrap items-center gap-4"
                    >
                      {(
                        [
                          { id: "open-front", label: "Open Front" },
                          { id: "collar-hem-peek", label: "Collar + Hem" },
                          { id: "collar-only", label: "Collar Only" },
                        ] as const
                      ).map((opt) => {
                        const active = tailorFit.outerwearStyle === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            aria-pressed={active}
                            disabled={isGenerating}
                            onClick={() =>
                              setTailorFit((prev) =>
                                sanitizeTailorFit({
                                  ...prev,
                                  outerwearStyle: opt.id as OuterwearStyle,
                                })
                              )
                            }
                            className={`pb-0.5 text-[10px] font-semibold tracking-[0.12em] uppercase transition-colors duration-150 disabled:opacity-40 ${
                              active
                                ? "border-b-[1.5px] border-[var(--ink-primary)] text-[var(--ink-primary)]"
                                : "text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                            }`}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Stark Monochrome Try On Pill CTA */}
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
                    className="group mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-6 text-[13px] font-semibold text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)] disabled:cursor-not-allowed disabled:opacity-35"
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
                        <span>Re-Drape Fit</span>
                        <ArrowRight
                          className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
                          strokeWidth={1.8}
                        />
                      </>
                    ) : (
                      <>
                        <span>Try On</span>
                        <ArrowRight
                          className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
                          strokeWidth={1.8}
                        />
                      </>
                    )}
                  </button>
                )}

                {mode === "tryon" &&
                  (!bodyProfile ||
                    isRateLimited ||
                    (allSelectedOutfitItems.length > 0 &&
                      !canRunTryOnGarments)) && (
                    <p className="mt-2.5 text-[11px] text-[var(--ink-muted)]">
                      {!bodyProfile
                        ? "Set up your Body Profile or capture in Camera Booth to enable try-on."
                        : isRateLimited
                          ? `Daily limit reached (${dailyLimit}/${dailyLimit}). Resets in 24h — use Layer Board for unlimited styling.`
                          : "Add a Top, Outerwear, or Bottom to run try-on (Shoes & Accessories appear in Styled With)."}
                    </p>
                  )}

                {/* Inline Expandable Tailor Fit Drawer */}
                {mode === "tryon" && (
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
                    expanded={tailorDrawerOpen}
                    onExpandedChange={setTailorDrawerOpen}
                    hideHeader={true}
                    hideOuterwearStyle={true}
                    onActiveGuideChange={handleActiveGuideChange}
                  />
                )}
              </div>

              {/* Horizontal Underline Title-Case Category Filter Bar */}
              <div
                role="tablist"
                aria-label="Filter studio by category"
                className="no-scrollbar flex items-stretch gap-6 overflow-x-auto border-b border-[var(--border-hairline)] px-6 sm:gap-8 sm:px-7"
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
                      className={`relative inline-flex h-11 shrink-0 items-center text-[13px] transition-colors duration-150 focus-visible:outline-offset-[-2px] ${
                        isActive
                          ? "font-semibold text-[var(--ink-primary)]"
                          : "font-medium text-[var(--ink-muted)] hover:text-[var(--ink-primary)]"
                      }`}
                    >
                      {filter.label}
                      {isActive && (
                        <motion.span
                          layoutId="studio-tab-underline"
                          transition={{ duration: 0.26, ease: EASE }}
                          className="absolute inset-x-0 -bottom-px h-[1.5px] bg-[var(--ink-primary)]"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Unified Borderless Garment Picker Grid (1:1 Match With Closet) */}
              <div className="flex-1 overflow-y-auto p-5 pb-28 sm:p-6 sm:pb-28">
                {items.length === 0 ? (
                  <div className="flex flex-col items-center justify-center rounded-[20px] bg-[var(--bg-well)] px-6 py-16 text-center">
                    <p className="text-[15px] font-semibold tracking-[-0.02em] text-[var(--ink-primary)]">
                      No pieces in your closet yet
                    </p>
                    <p className="mt-1.5 max-w-[32ch] text-[12px] text-[var(--ink-muted)]">
                      Add garment cutouts in your closet first, then return here
                      to drape them.
                    </p>
                    <Link
                      href="/closet"
                      onClick={(event) => {
                        if (
                          event.button === 0 &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          !event.altKey
                        ) {
                          event.preventDefault();
                          navigateToView("/closet");
                        }
                      }}
                      className="mt-5 inline-flex h-10 items-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 text-[12px] font-semibold text-[var(--btn-primary-fg)] transition-colors hover:bg-[var(--btn-primary-hover)]"
                    >
                      <span>Go to Closet</span>
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </div>
                ) : tryOnVisibleItems.length === 0 ? (
                  <div className="py-16 text-center">
                    <p className="text-[13px] text-[var(--ink-muted)]">
                      No{" "}
                      {tryOnFilter !== "all"
                        ? CATEGORY_LABELS[tryOnFilter].toLowerCase()
                        : ""}{" "}
                      pieces in your closet yet.
                    </p>
                    <button
                      type="button"
                      onClick={() => setTryOnFilter("all")}
                      className="mt-3 text-[13px] font-medium text-[var(--ink-primary)] underline underline-offset-4 hover:opacity-70"
                    >
                      Show all pieces
                    </button>
                  </div>
                ) : (
                  <div className="relative grid grid-cols-2 gap-x-3.5 gap-y-7 sm:grid-cols-3 sm:gap-x-4">
                    <AnimatePresence initial={false} mode="popLayout">
                      {tryOnVisibleItems.map((item) => {
                        const displayName = cleanGarmentName(
                          item.name,
                          item.category
                        );
                        const isSelected = isTryOnPieceSelected(item);
                        const isSpotlit = spotlightId === item.id;
                        const isDimmed = spotlightId !== null && !isSpotlit;
                        const effectiveWears =
                          item.wearCount + (optimisticWearAdds[item.id] ?? 0);

                        return (
                          <motion.div
                            key={item.id}
                            layout="position"
                            initial={{ opacity: 0, y: 14, scale: 0.98 }}
                            animate={{
                              opacity: isDimmed ? 0.65 : 1,
                              y: 0,
                              scale: 1,
                            }}
                            exit={{ opacity: 0, scale: 0.98 }}
                            transition={{
                              ...FAST,
                              layout: { duration: 0.26, ease: EASE },
                            }}
                            onPointerEnter={(event) => {
                              if (event.pointerType === "mouse") {
                                setSpotlightId(item.id);
                              }
                            }}
                            onPointerLeave={() =>
                              setSpotlightId((prev) =>
                                prev === item.id ? null : prev
                              )
                            }
                            onPointerDown={() => setSpotlightId(item.id)}
                            onPointerUp={(event) => {
                              if (event.pointerType !== "mouse") {
                                setSpotlightId(null);
                              }
                            }}
                            onPointerCancel={() => setSpotlightId(null)}
                            onFocus={(event) => {
                              if (event.target.matches(":focus-visible")) {
                                setSpotlightId(item.id);
                              }
                            }}
                            onBlur={() =>
                              setSpotlightId((prev) =>
                                prev === item.id ? null : prev
                              )
                            }
                          >
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => toggleTryOnPiece(item)}
                              disabled={isGenerating}
                              className="relative block w-full overflow-hidden rounded-[20px] bg-[var(--bg-tile)] text-left disabled:opacity-55"
                            >
                              <div className="flex aspect-[4/5] items-center justify-center p-7 sm:p-8">
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

                              <AnimatePresence initial={false}>
                                {isSelected && (
                                  <>
                                    <motion.span
                                      key="selected-ring"
                                      aria-hidden="true"
                                      initial={{ opacity: 0 }}
                                      animate={{ opacity: 1 }}
                                      exit={{ opacity: 0 }}
                                      transition={{ duration: 0.2, ease: EASE }}
                                      className="pointer-events-none absolute inset-0 rounded-[20px] border-[1.5px] border-[var(--ink-primary)]"
                                    />
                                    <motion.span
                                      key="selected-check"
                                      aria-hidden="true"
                                      initial={{ scale: 0.75, opacity: 0 }}
                                      animate={{ scale: 1, opacity: 1 }}
                                      exit={{ scale: 0.75, opacity: 0 }}
                                      transition={{
                                        type: "spring",
                                        stiffness: 460,
                                        damping: 30,
                                      }}
                                      className="absolute top-3 left-3 flex h-5 w-5 items-center justify-center rounded-full bg-[var(--btn-primary-bg)] text-[var(--btn-primary-fg)]"
                                    >
                                      <Check
                                        className="h-3 w-3"
                                        strokeWidth={2.4}
                                      />
                                    </motion.span>
                                  </>
                                )}
                              </AnimatePresence>
                            </button>

                            <div className="px-1 pt-2.5">
                              <div
                                title={displayName}
                                className="truncate text-[14px] font-medium tracking-[-0.01em] text-[var(--ink-primary)]"
                              >
                                {displayName}
                              </div>
                              <div className="mt-0.5 inline-flex items-baseline gap-1 text-[12px] text-[var(--ink-muted)] tabular-nums">
                                <RollingNumber value={effectiveWears} />
                                <span>
                                  {effectiveWears === 1 ? "wear" : "wears"}
                                </span>
                              </div>
                            </div>
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : mode === "lookbook" ? (
          /* ----------------------------------------------------------------
           * LOOKBOOK (Editorial 3:4 Archived Fits inside 28px Studio Card)
           * ---------------------------------------------------------------- */
          <div>
            {lookbookError && (
              <div
                role="alert"
                className="mb-5 flex items-center justify-between rounded-[16px] border border-[var(--status-danger-border)] bg-[var(--status-danger-bg)] px-5 py-3 text-[13px] text-[var(--status-danger-ink)]"
              >
                <span>{lookbookError}</span>
                <button
                  type="button"
                  onClick={() => setLookbookError(null)}
                  className="text-[11px] font-semibold tracking-[0.12em] uppercase underline underline-offset-4"
                >
                  Dismiss
                </button>
              </div>
            )}

            {savedLooks.length === 0 ? (
              <section className="flex flex-col items-center justify-center rounded-[28px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-6 py-24 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--border-hairline)] bg-[var(--bg-well)] text-[var(--ink-primary)]">
                  <BookMarked className="h-5 w-5" strokeWidth={1.4} />
                </div>
                <h1 className="mt-5 text-[20px] font-bold tracking-[-0.025em] text-[var(--ink-primary)]">
                  Your Lookbook is empty
                </h1>
                <p className="mt-2 max-w-[38ch] text-[13px] leading-relaxed text-[var(--ink-muted)]">
                  Save a try-on look or Layer Board composition to build your
                  monochrome lookbook archive.
                </p>
                <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
                  <button
                    type="button"
                    onClick={() => setMode("tryon")}
                    className="inline-flex h-11 items-center gap-2 rounded-[12px] bg-[var(--btn-primary-bg)] px-5 text-[11px] font-semibold tracking-[0.14em] text-[var(--btn-primary-fg)] uppercase transition-colors hover:bg-[var(--btn-primary-hover)]"
                  >
                    <span>Open AI Try-On</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("board")}
                    className="inline-flex h-11 items-center gap-1.5 text-[11px] font-semibold tracking-[0.14em] text-[var(--ink-muted)] uppercase transition-colors hover:text-[var(--ink-primary)]"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    <span>Layer Board</span>
                  </button>
                </div>
              </section>
            ) : (
              <section className="rounded-[28px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-4 sm:p-6">
                <h1 className="sr-only">Lookbook</h1>
                <div className="grid grid-cols-2 gap-4 sm:gap-5 md:grid-cols-3 xl:grid-cols-4">
                  {savedLooks.map((look) => {
                    const isConfirming = confirmDeleteLookId === look.id;
                    const isDeleting = deletingLookId === look.id;

                    return (
                      <article
                        key={look.id}
                        className="group flex flex-col overflow-hidden rounded-[20px] bg-[var(--bg-tile)]"
                      >
                        <div className="relative aspect-[3/4] w-full overflow-hidden">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={look.imageUrl}
                            alt={look.label}
                            loading="lazy"
                            className="h-full w-full object-cover object-top transition-transform duration-300 ease-out group-hover:scale-[1.02]"
                          />

                          <div className="absolute top-3 right-3">
                            {isConfirming ? (
                              <div className="flex items-center gap-1.5 rounded-[10px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1">
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteLook(look.id)}
                                  disabled={isDeleting}
                                  className="text-[10px] font-semibold tracking-[0.1em] text-[var(--ink-primary)] uppercase hover:opacity-70 disabled:opacity-45"
                                >
                                  {isDeleting ? "…" : "Delete"}
                                </button>
                                <span
                                  aria-hidden="true"
                                  className="text-[var(--border-mid)]"
                                >
                                  /
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteLookId(null)}
                                  disabled={isDeleting}
                                  className="text-[10px] font-medium tracking-[0.1em] text-[var(--ink-muted)] uppercase hover:text-[var(--ink-primary)]"
                                >
                                  No
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setConfirmDeleteLookId(look.id)}
                                aria-label={`Delete ${look.label}`}
                                title="Delete look"
                                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--bg-surface)]/90 text-[var(--ink-muted)] opacity-100 transition-opacity duration-150 hover:text-[var(--ink-primary)] focus:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
                              >
                                <Trash2
                                  className="h-3.5 w-3.5"
                                  strokeWidth={1.6}
                                />
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-col gap-1 border-t border-[var(--border-hairline)] px-4 py-3.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                          <h2
                            title={look.label}
                            className="truncate text-[13px] font-semibold tracking-[-0.015em] text-[var(--ink-primary)]"
                          >
                            {look.label}
                          </h2>
                          <span className="shrink-0 text-[10px] font-medium tracking-[0.12em] text-[var(--ink-muted)] uppercase tabular-nums">
                            {formatSavedDate(look.createdAt)}
                          </span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-[28px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-6 py-24 text-center">
            <h1 className="text-[20px] font-bold tracking-[-0.025em] text-[var(--ink-primary)]">
              Your layer board is empty
            </h1>
            <p className="mx-auto mt-2 max-w-[36ch] text-[13px] text-[var(--ink-muted)]">
              Add garment cutouts in your closet first, then arrange them on the
              editorial studio board.
            </p>
            <Link
              href="/closet"
              onClick={(event) => {
                if (
                  event.button === 0 &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  !event.shiftKey &&
                  !event.altKey
                ) {
                  event.preventDefault();
                  navigateToView("/closet");
                }
              }}
              className="mt-6 inline-flex h-11 items-center gap-2 rounded-[12px] bg-[var(--btn-primary-bg)] px-5 text-[11px] font-semibold tracking-[0.14em] text-[var(--btn-primary-fg)] uppercase transition-colors hover:bg-[var(--btn-primary-hover)]"
            >
              <span>Go to Closet</span>
              <ArrowRight className="h-3.5 w-3.5" />
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
          onBodyProfileChange?.(savedProfile);
          setTryOnResultUrl(null);
          setLastRenderedFitKey(null);
          setLastCompositeUrl(null);
          setLastRenderEngine(null);
          setPreviewedOutfit(null);
          setSavedCurrentResultKey(null);
          setViewStage("before");
          setTryOnError(null);
        }}
      />
    </>
  );

  if (hideNavbar) {
    return studioContent;
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-dvh bg-[var(--bg-surface)] text-[var(--ink-primary)] transition-colors duration-150">
        <Navbar
          userName={userName}
          actionSlot={
            mode === "board" ? (
              <button
                type="button"
                onClick={handleLogBoardOutfit}
                disabled={selectedBoardItems.length === 0 || isLoggingOutfit}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[12px] bg-[var(--btn-primary-bg)] px-3.5 text-[11px] font-semibold tracking-[0.12em] text-[var(--btn-primary-fg)] uppercase transition-colors duration-150 hover:bg-[var(--btn-primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {isLoggingOutfit ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span className="sm:hidden">Log Fit</span>
                <span className="hidden sm:inline">Log Fit Worn</span>
              </button>
            ) : undefined
          }
        />
        <ViewTransitionStage view="studio">{studioContent}</ViewTransitionStage>
      </div>
    </MotionConfig>
  );
}
