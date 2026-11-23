"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import StrokeText from "./StrokeText";
import "./OpeningAnimation.css";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

type IntroPhase = "entering" | "active" | "exiting" | "done";

interface DeviceProfile {
  fontSize: number;
  letterSpacing: number;
  strokeWidth: number;
  drawDuration: number;
  fillDelay: number;
  stagger: number;
  ruleDurationMs: number;
  holdMs: number;
  exitMs: number;
  reducedMotion: boolean;
}

/**
 * Selects typography scale, optical hairline weight, and pacing tuned for
 * the visitor's actual screen dimensions, orientation, and motion preference.
 */
function resolveDeviceProfile(): DeviceProfile {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const reducedMotion =
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const isShortLandscape = height <= 480 && width > height;

  if (isShortLandscape) {
    return {
      fontSize: 58,
      letterSpacing: 13,
      strokeWidth: 1.45,
      drawDuration: 0.85,
      fillDelay: 0.08,
      stagger: 0.055,
      ruleDurationMs: 1200,
      holdMs: 200,
      exitMs: 360,
      reducedMotion,
    };
  }

  if (width < 380) {
    // Compact phones (320px - 379px, e.g. iPhone SE)
    return {
      fontSize: 54,
      letterSpacing: 9,
      strokeWidth: 1.65,
      drawDuration: 0.85,
      fillDelay: 0.08,
      stagger: 0.055,
      ruleDurationMs: 1200,
      holdMs: 200,
      exitMs: 360,
      reducedMotion,
    };
  }

  if (width < 640) {
    // Standard & large phones (380px - 639px)
    return {
      fontSize: 66,
      letterSpacing: 12,
      strokeWidth: 1.55,
      drawDuration: 0.9,
      fillDelay: 0.08,
      stagger: 0.055,
      ruleDurationMs: 1280,
      holdMs: 220,
      exitMs: 360,
      reducedMotion,
    };
  }

  if (width < 1024) {
    // Tablets (640px - 1023px)
    return {
      fontSize: 96,
      letterSpacing: 22,
      strokeWidth: 1.35,
      drawDuration: 1.0,
      fillDelay: 0.1,
      stagger: 0.06,
      ruleDurationMs: 1420,
      holdMs: 240,
      exitMs: 400,
      reducedMotion,
    };
  }

  if (width < 1440) {
    // Standard laptops & desktops (1024px - 1439px)
    return {
      fontSize: 118,
      letterSpacing: 30,
      strokeWidth: 1.25,
      drawDuration: 1.05,
      fillDelay: 0.12,
      stagger: 0.065,
      ruleDurationMs: 1520,
      holdMs: 260,
      exitMs: 420,
      reducedMotion,
    };
  }

  // Large & ultrawide displays (1440px+)
  return {
    fontSize: 132,
    letterSpacing: 34,
    strokeWidth: 1.2,
    drawDuration: 1.1,
    fillDelay: 0.12,
    stagger: 0.065,
    ruleDurationMs: 1600,
    holdMs: 280,
    exitMs: 420,
    reducedMotion,
  };
}

export function OpeningAnimation() {
  const [phase, setPhase] = useState<IntroPhase>("entering");
  const [profile, setProfile] = useState<DeviceProfile | null>(null);

  const holdTimerRef = useRef<number | null>(null);
  const exitTimerRef = useRef<number | null>(null);
  const failsafeTimerRef = useRef<number | null>(null);
  const dismissedRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
    if (failsafeTimerRef.current !== null) {
      window.clearTimeout(failsafeTimerRef.current);
      failsafeTimerRef.current = null;
    }
  }, []);

  const beginExit = useCallback(
    (exitDurationMs: number) => {
      if (dismissedRef.current) return;
      dismissedRef.current = true;
      clearTimers();

      // Restore scrolling immediately once exit begins so the app feels instantly live.
      document.documentElement.style.overflow = "";
      setPhase("exiting");

      exitTimerRef.current = window.setTimeout(() => {
        setPhase("done");
      }, exitDurationMs);
    },
    [clearTimers]
  );

  // Measure device viewport synchronously before first paint to avoid flash or scale jump.
  useIsomorphicLayoutEffect(() => {
    const resolved = resolveDeviceProfile();
    setProfile(resolved);

    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";

    if (resolved.reducedMotion) {
      // Hard failsafe for reduced-motion mode if fonts stall; normal fade starts in handleStrokeStart.
      failsafeTimerRef.current = window.setTimeout(() => {
        beginExit(240);
      }, 1200);

      return () => {
        clearTimers();
        document.documentElement.style.overflow = prevOverflow;
      };
    }

    // Hard failsafe ensures the overlay can never strand the visitor on any device.
    failsafeTimerRef.current = window.setTimeout(() => {
      beginExit(resolved.exitMs);
    }, 4200);

    return () => {
      clearTimers();
      document.documentElement.style.overflow = prevOverflow;
    };
  }, [beginExit, clearTimers]);

  // Allow instant keyboard Escape dismissal.
  useEffect(() => {
    if (phase === "done" || phase === "exiting") return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        beginExit(profile?.reducedMotion ? 200 : 280);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [phase, profile, beginExit]);

  const handleStrokeStart = useCallback(() => {
    if (dismissedRef.current) return;
    setPhase("active");
  }, []);

  const handleStrokeComplete = useCallback(() => {
    if (dismissedRef.current || !profile) return;
    if (profile.reducedMotion) {
      holdTimerRef.current = window.setTimeout(() => {
        beginExit(240);
      }, 520);
      return;
    }
    holdTimerRef.current = window.setTimeout(() => {
      beginExit(profile.exitMs);
    }, profile.holdMs);
  }, [profile, beginExit]);

  if (phase === "done") return null;

  const isReduced = profile?.reducedMotion ?? false;
  const exitMs = isReduced ? 240 : (profile?.exitMs ?? 420);
  const stageExitMs = Math.round(exitMs * 0.76);

  const rootStyle = {
    "--intro-exit-ms": `${exitMs}ms`,
    "--intro-stage-exit-ms": `${stageExitMs}ms`,
    "--intro-rule-ms": `${profile?.ruleDurationMs ?? 1450}ms`,
  } as CSSProperties;

  const rootClassName = [
    "silho-intro",
    phase === "active" ? "silho-intro--active" : "",
    phase === "exiting" ? "silho-intro--exiting" : "",
    isReduced ? "silho-intro--reduced" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <noscript>
        <style>{`.silho-intro { display: none !important; }`}</style>
      </noscript>
      <div
        className={rootClassName}
        style={rootStyle}
        role="presentation"
        aria-hidden={phase === "exiting"}
      >
        <div className="silho-intro__stage">
          {profile && (
            <>
              <StrokeText
                text="SILHO"
                strokeColor="#0E0E0E"
                fillColor="#0E0E0E"
                strokeStyle="solid"
                strokeWidth={profile.strokeWidth}
                drawDuration={profile.drawDuration}
                fillDelay={profile.fillDelay}
                stagger={profile.stagger}
                ease="power2.out"
                trigger="mount"
                fillMode="wipe"
                wipeFrom="left"
                fontSize={profile.fontSize}
                fontWeight={500}
                fontFamily="var(--font-inter), ui-sans-serif, system-ui, -apple-system, sans-serif"
                letterSpacing={profile.letterSpacing}
                marching={false}
                hoverRedraw={false}
                shadow={false}
                trimTrailingSpacing={true}
                waitForFonts={true}
                freezeOnResize={true}
                className="silho-intro__mark"
                onStart={handleStrokeStart}
                onComplete={handleStrokeComplete}
              />
              <div className="silho-intro__rule-track" aria-hidden="true">
                <span className="silho-intro__rule-fill" />
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          className="silho-intro__skip"
          onClick={() => beginExit(isReduced ? 200 : 280)}
          aria-label="Skip opening animation"
        >
          Skip
        </button>
      </div>
    </>
  );
}
