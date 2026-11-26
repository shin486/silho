"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { LayoutGroup } from "motion/react";

export type StudioView = "about" | "closet" | "studio";

export const VIEW_ORDER: Record<StudioView, number> = {
  about: 0,
  closet: 1,
  studio: 2,
};

export const VIEW_TRANSITION_EASE = [0.22, 1, 0.36, 1] as const;
export const VIEW_TRANSITION_DURATION = 0.22;
export const NAV_UNDERLINE_SPRING = {
  type: "spring",
  stiffness: 380,
  damping: 32,
} as const;

export interface StagedOutfitSelection {
  top: string | null;
  outerwear: string | null;
  bottom: string | null;
  shoes: string | null;
  accessories: string[];
}

const STAGED_OUTFIT_STORAGE_KEY = "silho-staged-outfit";

let inMemoryStagedOutfit: StagedOutfitSelection | null = null;

function sanitizeStagedOutfit(raw: unknown): StagedOutfitSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<StagedOutfitSelection>;
  const normalizeId = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= 64
      ? value
      : null;

  return {
    top: normalizeId(candidate.top),
    outerwear: normalizeId(candidate.outerwear),
    bottom: normalizeId(candidate.bottom),
    shoes: normalizeId(candidate.shoes),
    accessories: Array.isArray(candidate.accessories)
      ? candidate.accessories
          .filter(
            (id): id is string =>
              typeof id === "string" && id.length > 0 && id.length <= 64
          )
          .slice(0, 12)
      : [],
  };
}

/**
 * Synchronous in-memory staged outfit reader (returns null during initial SSR
 * hydration so server/client HTML match, and returns staged state immediately on
 * in-memory view switches).
 */
export function readStagedOutfit(): StagedOutfitSelection | null {
  return inMemoryStagedOutfit;
}

/**
 * Restores staged outfit from sessionStorage on cold loads/reloads if in-memory
 * cache is empty. Safe to call inside mount useEffect.
 */
export function hydrateStagedOutfitFromStorage(): StagedOutfitSelection | null {
  if (inMemoryStagedOutfit) return inMemoryStagedOutfit;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STAGED_OUTFIT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = sanitizeStagedOutfit(JSON.parse(raw));
    if (parsed) {
      inMemoryStagedOutfit = parsed;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeStagedOutfit(selection: StagedOutfitSelection): void {
  const normalized: StagedOutfitSelection = {
    top: selection.top,
    outerwear: selection.outerwear,
    bottom: selection.bottom,
    shoes: selection.shoes,
    accessories: selection.accessories.slice(0, 12),
  };
  inMemoryStagedOutfit = normalized;
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      STAGED_OUTFIT_STORAGE_KEY,
      JSON.stringify(normalized)
    );
  } catch {
    // Ignore storage quota / privacy mode restrictions
  }
}

export function pathnameToView(pathname: string): StudioView | null {
  if (
    pathname === "/about" ||
    pathname.startsWith("/about/") ||
    pathname.includes("view=about") ||
    pathname.endsWith("#about")
  ) {
    return "about";
  }
  if (
    pathname === "/" ||
    pathname === "/closet" ||
    pathname.startsWith("/closet/")
  ) {
    return "closet";
  }
  if (pathname === "/canvas" || pathname.startsWith("/canvas/")) {
    return "studio";
  }
  return null;
}

export interface UrlSelectionParams {
  top?: string;
  outerwear?: string;
  bottom?: string;
  shoes?: string;
  accessories?: string[];
}

export function parseSelectionFromHref(href: string): UrlSelectionParams | undefined {
  const queryIndex = href.indexOf("?");
  if (queryIndex === -1) return undefined;
  const searchParams = new URLSearchParams(href.slice(queryIndex + 1));
  const readId = (key: string) => {
    const val = searchParams.get(key);
    return val && val.length <= 64 ? val : undefined;
  };
  const accessories = (searchParams.get("acc") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 64)
    .slice(0, 12);

  const selection: UrlSelectionParams = {
    top: readId("top"),
    outerwear: readId("outerwear"),
    bottom: readId("bottom"),
    shoes: readId("shoes"),
    accessories: accessories.length > 0 ? accessories : undefined,
  };

  if (
    !selection.top &&
    !selection.outerwear &&
    !selection.bottom &&
    !selection.shoes &&
    !selection.accessories?.length
  ) {
    return undefined;
  }
  return selection;
}

type WorkspaceSwitcherFn = (href: string) => void;

interface ViewTransitionContextValue {
  currentView: StudioView | null;
  registerWorkspaceSwitcher: (
    switcher: WorkspaceSwitcherFn | null,
    initialActiveView?: StudioView | null
  ) => void;
  syncWorkspaceView: (view: StudioView) => void;
  navigateToView: (href: string) => boolean;
}

const ViewTransitionContext = createContext<ViewTransitionContextValue>({
  currentView: "closet",
  registerWorkspaceSwitcher: () => {},
  syncWorkspaceView: () => {},
  navigateToView: () => false,
});

export function ViewTransitionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const routeView = pathnameToView(pathname);

  const [workspaceView, setWorkspaceView] = useState<StudioView | null>("closet");
  const workspaceSwitcherRef = useRef<WorkspaceSwitcherFn | null>(null);

  useEffect(() => {
    router.prefetch("/closet");
    router.prefetch("/canvas");
  }, [router]);

  const registerWorkspaceSwitcher = useCallback(
    (switcher: WorkspaceSwitcherFn | null, activeView?: StudioView | null) => {
      workspaceSwitcherRef.current = switcher;
      setWorkspaceView(switcher ? (activeView ?? "closet") : null);
    },
    []
  );

  const syncWorkspaceView = useCallback((view: StudioView) => {
    setWorkspaceView(view);
  }, []);

  /**
   * Switches between About, Closet, and Studio in-memory (returning true) when
   * WorkspaceShell is active; falls back to router.push otherwise.
   */
  const navigateToView = useCallback(
    (href: string): boolean => {
      const normalizedHref = href === "about" ? "/closet#about" : href;
      const targetView = pathnameToView(normalizedHref);
      if (targetView && workspaceSwitcherRef.current) {
        setWorkspaceView(targetView);
        workspaceSwitcherRef.current(normalizedHref);
        return true;
      }
      router.push(normalizedHref === "/closet#about" ? "/closet" : normalizedHref);
      return false;
    },
    [router]
  );

  const currentView = workspaceView ?? routeView ?? "closet";

  return (
    <ViewTransitionContext.Provider
      value={{
        currentView,
        registerWorkspaceSwitcher,
        syncWorkspaceView,
        navigateToView,
      }}
    >
      <LayoutGroup id="silho-nav-swap">{children}</LayoutGroup>
    </ViewTransitionContext.Provider>
  );
}

export function useViewTransition() {
  return useContext(ViewTransitionContext);
}

/**
 * Compatibility wrapper: WorkspaceShell now coordinates transitions below the
 * persistent Navbar without unmounting routes.
 */
export function ViewTransitionStage({
  children,
}: {
  view?: StudioView;
  children: ReactNode;
}) {
  return <div>{children}</div>;
}
