"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Plus } from "lucide-react";
import { useShowSplash } from "@/components/OpeningAnimation";
import { useTheme } from "@/components/ThemeProvider";
import {
  useViewTransition,
  type StudioView,
} from "@/components/ViewTransitionProvider";
import { signOut } from "@/lib/auth-client";

interface NavbarProps {
  userName?: string | null;
  actionSlot?: ReactNode;
  onAddClick?: () => void;
}

const NAV_ITEMS: readonly { href: string; label: string; view: StudioView }[] =
  [
    { href: "/closet", label: "Closet", view: "closet" },
    { href: "/canvas", label: "Studio", view: "studio" },
  ] as const;

const TITLE_SWAP_TRANSITION = {
  layout: { duration: 0.34, ease: [0.22, 1, 0.36, 1] },
} as const;

export function Navbar({ userName, actionSlot, onAddClick }: NavbarProps) {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const { currentView, navigateToView } = useViewTransition();
  const showSplash = useShowSplash();
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;

    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      router.push("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const addAction =
    onAddClick !== undefined ? (
      <button
        type="button"
        onClick={onAddClick}
        className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[var(--btn-primary-bg)] pr-3.5 pl-3 text-[13px] font-medium whitespace-nowrap text-[var(--btn-primary-fg)] transition-colors duration-150 hover:bg-[var(--btn-primary-hover)]"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        <span>Add</span>
      </button>
    ) : (
      actionSlot
    );

  return (
    <header
      className={`sticky top-0 overflow-visible border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] transition-colors duration-150 ${
        showSplash ? "z-30" : "z-[45]"
      }`}
    >
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-3 px-5 sm:px-8 lg:px-10">
        <motion.button
          type="button"
          aria-label="About Silho"
          aria-current={currentView === "about" ? "page" : undefined}
          whileTap={{ scale: 0.98 }}
          onClick={() => navigateToView("/closet#about")}
          className="inline-flex shrink-0 cursor-pointer items-center text-[20px] leading-none font-semibold tracking-[-0.03em] lowercase transition-opacity duration-150 hover:opacity-75"
        >
          {showSplash ? (
            <span
              aria-hidden="true"
              className="inline-block text-[20px] leading-none font-semibold tracking-[-0.03em] lowercase opacity-0 select-none"
            >
              silho
            </span>
          ) : (
            <motion.span
              layoutId="silho-brand-wordmark"
              transition={{
                layout: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
              }}
              className="inline-block text-[20px] leading-none font-semibold tracking-[-0.03em] text-[#141415] lowercase dark:text-[#F5F5F3]"
            >
              silho
            </motion.span>
          )}
        </motion.button>

        <div className="ml-auto flex min-w-0 items-center gap-4">
          <nav aria-label="Primary" className="flex items-center gap-4">
            {NAV_ITEMS.map((item) => {
              if (currentView === item.view) return null;
              return (
                <button
                  key={item.href}
                  type="button"
                  onClick={() => navigateToView(item.href)}
                  className="cursor-pointer px-1 py-1.5"
                >
                  <motion.span
                    layoutId={`silho-view-${item.view}`}
                    initial={false}
                    transition={TITLE_SWAP_TRANSITION}
                    className="inline-block text-[14px] leading-none font-semibold tracking-[-0.01em] whitespace-nowrap text-[#737370] transition-colors duration-150 hover:text-[#141415] dark:text-[#8A8A86] dark:hover:text-[#F5F5F3]"
                  >
                    {item.label}
                  </motion.span>
                </button>
              );
            })}
          </nav>

          {addAction && <div className="shrink-0">{addAction}</div>}

          {/* Single minimal utility menu: appearance, account, sign out */}
          <div ref={menuRef} className="relative shrink-0">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-expanded={menuOpen}
              aria-controls="silho-utility-menu"
              aria-label="Menu"
              className="flex h-9 w-9 items-center justify-center rounded-full text-[var(--ink-muted)] transition-colors duration-150 hover:bg-[var(--bg-well)] hover:text-[var(--ink-primary)]"
            >
              <span aria-hidden="true" className="flex items-center gap-[3px]">
                <span className="h-[3px] w-[3px] rounded-full bg-current" />
                <span className="h-[3px] w-[3px] rounded-full bg-current" />
                <span className="h-[3px] w-[3px] rounded-full bg-current" />
              </span>
            </button>

            {menuOpen && (
              <div
                id="silho-utility-menu"
                className="absolute top-[calc(100%+8px)] right-0 w-60 rounded-[16px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.14)]"
              >
                {userName && (
                  <p className="truncate px-3 pt-2 pb-2.5 text-[12px] text-[var(--ink-muted)]">
                    {userName}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => {
                    toggleTheme();
                    setMenuOpen(false);
                  }}
                  className="flex h-10 w-full items-center justify-between rounded-[10px] px-3 text-left text-[13px] text-[var(--ink-primary)] transition-colors duration-150 hover:bg-[var(--bg-well)]"
                >
                  <span>
                    {theme === "dark" ? "Light studio" : "Obsidian mode"}
                  </span>
                  <span
                    aria-hidden="true"
                    className={`h-2.5 w-2.5 rounded-full border border-[var(--ink-primary)] ${theme === "dark"
                      ? "bg-transparent"
                      : "bg-[var(--ink-primary)]"
                      }`}
                  />
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  disabled={signingOut}
                  className="flex h-10 w-full items-center rounded-[10px] px-3 text-left text-[13px] text-[var(--ink-primary)] transition-colors duration-150 hover:bg-[var(--bg-well)] disabled:opacity-45"
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
