"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { AboutView } from "@/components/AboutView";
import { CanvasClient } from "@/components/CanvasClient";
import { ClosetClient } from "@/components/ClosetClient";
import { Navbar } from "@/components/Navbar";
import { UploadCutoutModal } from "@/components/UploadCutoutModal";
import {
  parseSelectionFromHref,
  pathnameToView,
  useViewTransition,
  VIEW_TRANSITION_EASE,
  writeStagedOutfit,
  type StudioView,
  type UrlSelectionParams,
} from "@/components/ViewTransitionProvider";
import type { BodyProfileDTO, SavedLookDTO } from "@/lib/canvas";
import type { WardrobeItemDTO } from "@/lib/closet";

export interface WorkspaceShellProps {
  initialView: StudioView;
  initialItems: WardrobeItemDTO[];
  initialBodyProfile: BodyProfileDTO | null;
  initialSavedLooks: SavedLookDTO[];
  initialRemaining: number | null;
  isUnlimited: boolean;
  dailyLimit: number;
  userName?: string | null;
  initialSelection?: UrlSelectionParams;
}

const TITLE_SWAP_TRANSITION = {
  layout: { duration: 0.34, ease: VIEW_TRANSITION_EASE },
} as const;

const BODY_VARIANTS = {
  initial: { opacity: 0, y: 6 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.18, ease: VIEW_TRANSITION_EASE },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.18, ease: VIEW_TRANSITION_EASE },
  },
} as const;

export function WorkspaceShell({
  initialView = "closet",
  initialItems,
  initialBodyProfile,
  initialSavedLooks,
  initialRemaining,
  isUnlimited,
  dailyLimit,
  userName,
  initialSelection,
}: WorkspaceShellProps) {
  const { registerWorkspaceSwitcher, syncWorkspaceView } = useViewTransition();

  const [activeView, setActiveView] = useState<StudioView>(initialView);
  const viewRef = useRef<StudioView>(initialView);
  viewRef.current = activeView;

  // Shared live workspace data (stays synced across About <-> Closet <-> Studio without refetching)
  const [items, setItems] = useState<WardrobeItemDTO[]>(initialItems);
  const [bodyProfile, setBodyProfile] = useState<BodyProfileDTO | null>(
    initialBodyProfile
  );
  const [savedLooks, setSavedLooks] =
    useState<SavedLookDTO[]>(initialSavedLooks);
  const [remaining, setRemaining] = useState<number | null>(initialRemaining);
  const [unlimited, setUnlimited] = useState<boolean>(isUnlimited);
  const [urlSelection, setUrlSelection] = useState<
    UrlSelectionParams | undefined
  >(initialSelection);

  // Global "+ Add" modal stays mounted across About, Closet, and Studio
  const [closetUploadOpen, setClosetUploadOpen] = useState(false);

  useEffect(() => {
    setItems(initialItems);
  }, [initialItems]);

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
    if (
      typeof window !== "undefined" &&
      initialView === "closet" &&
      window.location.pathname === "/canvas"
    ) {
      window.history.replaceState({ silhoView: "closet" }, "", "/closet");
    }
  }, [initialView]);

  const applyHrefSwitch = useCallback(
    (href: string, pushHistory: boolean) => {
      const targetView = pathnameToView(href);
      if (!targetView) return;

      const parsedSelection = parseSelectionFromHref(href);
      if (parsedSelection) {
        writeStagedOutfit({
          top: parsedSelection.top ?? null,
          outerwear: parsedSelection.outerwear ?? null,
          bottom: parsedSelection.bottom ?? null,
          shoes: parsedSelection.shoes ?? null,
          accessories: parsedSelection.accessories ?? [],
        });
      }
      setUrlSelection(parsedSelection);

      if (pushHistory && typeof window !== "undefined") {
        const nextUrl = targetView === "studio" ? href : "/closet";
        window.history.pushState({ silhoView: targetView }, "", nextUrl);
      }

      if (targetView === viewRef.current) return;

      syncWorkspaceView(targetView);
      if (typeof window !== "undefined") {
        window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      }
      setActiveView(targetView);
    },
    [syncWorkspaceView]
  );

  useEffect(() => {
    registerWorkspaceSwitcher(
      (href: string) => applyHrefSwitch(href, true),
      initialView
    );
    return () => {
      registerWorkspaceSwitcher(null);
    };
  }, [applyHrefSwitch, initialView, registerWorkspaceSwitcher]);

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      const historyView = (event.state as { silhoView?: StudioView } | null)
        ?.silhoView;
      if (historyView === "about") {
        applyHrefSwitch("/closet#about", false);
        return;
      }
      if (historyView === "closet") {
        applyHrefSwitch("/closet", false);
        return;
      }
      if (historyView === "studio") {
        applyHrefSwitch(window.location.pathname + window.location.search, false);
        return;
      }

      const currentHref =
        window.location.pathname + window.location.search + window.location.hash;
      if (pathnameToView(currentHref)) {
        applyHrefSwitch(currentHref, false);
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [applyHrefSwitch]);

  const handleQuotaChange = useCallback(
    (nextRemaining: number | null, nextUnlimited: boolean) => {
      setRemaining(nextRemaining);
      setUnlimited(nextUnlimited);
    },
    []
  );

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-dvh bg-[var(--bg-surface)] text-[var(--ink-primary)] transition-colors duration-150">
        <Navbar
          userName={userName}
          onAddClick={() => setClosetUploadOpen(true)}
        />

        {/* Synchronous Page Header Slot (OUTSIDE AnimatePresence to prevent double-render) */}
        {activeView === "closet" ? (
          <div className="mx-auto max-w-[1440px] px-5 pt-8 sm:px-8 sm:pt-10 lg:px-10">
            <div className="flex h-[44px] items-baseline gap-3">
              <h1 className="m-0 leading-none">
                <motion.span
                  layoutId="silho-view-closet"
                  initial={false}
                  transition={TITLE_SWAP_TRANSITION}
                  className="inline-block text-[28px] leading-none font-semibold tracking-[-0.03em] whitespace-nowrap text-[#141415] dark:text-[#F5F5F3]"
                >
                  Closet
                </motion.span>
              </h1>
              <motion.p
                key="closet-meta"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.16, delay: 0.12 }}
                className="text-[13px] text-[#8A8A86] tabular-nums"
              >
                {items.length} {items.length === 1 ? "piece" : "pieces"}
              </motion.p>
            </div>
          </div>
        ) : activeView === "studio" ? (
          <div className="mx-auto max-w-[1440px] px-5 pt-8 pb-2 sm:px-8 sm:pt-10 lg:px-10">
            <div className="flex h-[44px] items-baseline gap-3">
              <h1 className="m-0 leading-none">
                <motion.span
                  layoutId="silho-view-studio"
                  initial={false}
                  transition={TITLE_SWAP_TRANSITION}
                  className="inline-block text-[28px] leading-none font-semibold tracking-[-0.03em] whitespace-nowrap text-[#141415] dark:text-[#F5F5F3]"
                >
                  Studio
                </motion.span>
              </h1>
            </div>
          </div>
        ) : null}

        <div className="overflow-x-clip">
          <AnimatePresence mode="wait" initial={false}>
            {activeView === "about" ? (
              <motion.div
                key="about"
                variants={BODY_VARIANTS}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <AboutView
                  onBackToCloset={() => applyHrefSwitch("/closet", true)}
                />
              </motion.div>
            ) : activeView === "closet" ? (
              <motion.div
                key="closet"
                variants={BODY_VARIANTS}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <ClosetClient
                  initialItems={items}
                  userName={userName}
                  hideNavbar
                  externalUploadOpen={false}
                  onExternalUploadOpen={() => setClosetUploadOpen(true)}
                  onExternalUploadClose={() => setClosetUploadOpen(false)}
                  onItemsChange={setItems}
                />
              </motion.div>
            ) : (
              <motion.div
                key="studio"
                variants={BODY_VARIANTS}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                <CanvasClient
                  items={items}
                  initialBodyProfile={bodyProfile}
                  initialSavedLooks={savedLooks}
                  initialRemaining={remaining}
                  isUnlimited={unlimited}
                  dailyLimit={dailyLimit}
                  userName={userName}
                  initialSelection={urlSelection}
                  hideNavbar
                  onItemsChange={setItems}
                  onBodyProfileChange={setBodyProfile}
                  onSavedLooksChange={setSavedLooks}
                  onQuotaChange={handleQuotaChange}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <UploadCutoutModal
          open={closetUploadOpen}
          onClose={() => setClosetUploadOpen(false)}
          onSaved={() => {
            if (viewRef.current !== "closet") {
              applyHrefSwitch("/closet", true);
            }
          }}
        />
      </div>
    </MotionConfig>
  );
}
