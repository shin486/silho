"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motion } from "motion/react";
import "./OpeningAnimation.css";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

const EASE = [0.22, 1, 0.36, 1] as const;

let showSplashState = true;
let splashDoneState = false;
const splashListeners = new Set<() => void>();

function notifySplashListeners(): void {
  splashListeners.forEach((listener) => listener());
}

function subscribeSplash(listener: () => void): () => void {
  splashListeners.add(listener);
  return () => {
    splashListeners.delete(listener);
  };
}

function setShowSplashState(next: boolean): void {
  if (showSplashState === next) return;
  showSplashState = next;
  notifySplashListeners();
}

function setSplashDoneState(next: boolean): void {
  if (splashDoneState === next) return;
  splashDoneState = next;
  notifySplashListeners();
}

/**
 * True while the opening splash owns `layoutId="silho-brand-wordmark"` (`0.00s–0.80s`).
 * Flips synchronously to false at `800ms` so the header mounts the shared wordmark
 * on the exact render tick the splash wordmark unmounts.
 */
export function useShowSplash(): boolean {
  return useSyncExternalStore(
    subscribeSplash,
    () => showSplashState,
    () => true
  );
}

/**
 * True after the splash wordmark has handed off (`!showSplash`) or finished completely.
 */
export function useSplashComplete(): boolean {
  return useSyncExternalStore(
    subscribeSplash,
    () => !showSplashState || splashDoneState,
    () => false
  );
}

export function OpeningAnimation() {
  const showSplash = useShowSplash();
  const backdropDone = useSyncExternalStore(
    subscribeSplash,
    () => splashDoneState,
    () => false
  );
  const [reducedMotion, setReducedMotion] = useState(false);

  const handoffTimerRef = useRef<number | null>(null);
  const doneTimerRef = useRef<number | null>(null);

  const clearAllTimers = useCallback(() => {
    if (handoffTimerRef.current !== null) {
      window.clearTimeout(handoffTimerRef.current);
      handoffTimerRef.current = null;
    }
    if (doneTimerRef.current !== null) {
      window.clearTimeout(doneTimerRef.current);
      doneTimerRef.current = null;
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    if (splashDoneState) return undefined;

    const prefersReduced =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    setReducedMotion(prefersReduced);

    if (prefersReduced) {
      handoffTimerRef.current = window.setTimeout(() => {
        setShowSplashState(false);
      }, 300);
      doneTimerRef.current = window.setTimeout(() => {
        setSplashDoneState(true);
      }, 500);

      return () => {
        clearAllTimers();
      };
    }

    // 0.00s–0.45s focus + 0.45s–0.80s calm hold -> swap layoutId owner at 800ms
    handoffTimerRef.current = window.setTimeout(() => {
      setShowSplashState(false);
    }, 800);

    // Ensure splash backdrop completely unmounts cleanly after fade + morph settle (1.25s)
    doneTimerRef.current = window.setTimeout(() => {
      setSplashDoneState(true);
    }, 1250);

    return () => {
      clearAllTimers();
    };
  }, [clearAllTimers]);

  if (backdropDone) return null;

  return (
    <>
      <noscript>
        <style>{`.silho-intro { display: none !important; }`}</style>
      </noscript>

      {/* Backdrop overlay dissolves independently (`opacity: 1 -> 0`) once showSplash flips false */}
      <motion.div
        aria-hidden="true"
        initial={{ opacity: 1 }}
        animate={{ opacity: showSplash ? 1 : 0 }}
        transition={{
          duration: reducedMotion ? 0.15 : 0.35,
          ease: EASE,
        }}
        className="silho-intro pointer-events-none fixed inset-0 z-40 bg-[#FFFFFF] dark:bg-[#111112]"
      />

      {/* Centered splash wordmark — unmounts synchronously with zero AnimatePresence exit hold */}
      {showSplash && (
        <div
          className="silho-intro pointer-events-none fixed inset-0 z-50 grid place-items-center"
          role="presentation"
        >
          <motion.span
            layoutId="silho-brand-wordmark"
            initial={
              reducedMotion
                ? { opacity: 1, filter: "blur(0px)", scale: 1 }
                : { opacity: 0, filter: "blur(8px)", scale: 0.96 }
            }
            animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
            transition={{
              opacity: { duration: reducedMotion ? 0.01 : 0.45, ease: EASE },
              filter: { duration: reducedMotion ? 0.01 : 0.45, ease: EASE },
              scale: { duration: reducedMotion ? 0.01 : 0.45, ease: EASE },
              layout: { duration: reducedMotion ? 0.01 : 0.45, ease: EASE },
            }}
            className="inline-block text-[36px] leading-none font-semibold tracking-[-0.04em] text-[#141415] lowercase select-none dark:text-[#F5F5F3]"
          >
            silho
          </motion.span>
        </div>
      )}
    </>
  );
}
