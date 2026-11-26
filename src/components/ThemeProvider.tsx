"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";

export type StudioTheme = "light" | "dark";

interface ThemeContextValue {
  theme: StudioTheme;
  setTheme: (next: StudioTheme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "silho-theme";

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  setTheme: () => {},
  toggleTheme: () => {},
});

function applyThemeToDocument(theme: StudioTheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "dark") {
    root.setAttribute("data-theme", "dark");
    root.style.colorScheme = "dark";
  } else {
    root.removeAttribute("data-theme");
    root.style.colorScheme = "light";
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", theme === "dark" ? "#1E2022" : "#ECECEB");
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const isAuthRoute = pathname === "/login" || pathname === "/register";
  const [theme, setThemeState] = useState<StudioTheme>("light");

  useEffect(() => {
    let resolved: StudioTheme = "light";
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "dark" || saved === "light") {
        resolved = saved;
      } else if (
        document.documentElement.getAttribute("data-theme") === "dark"
      ) {
        resolved = "dark";
      }
    } catch {
      if (document.documentElement.getAttribute("data-theme") === "dark") {
        resolved = "dark";
      }
    }
    setThemeState(resolved);
    applyThemeToDocument(isAuthRoute ? "light" : resolved);
  }, [isAuthRoute]);

  const setTheme = useCallback(
    (next: StudioTheme) => {
      setThemeState(next);
      applyThemeToDocument(isAuthRoute ? "light" : next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Ignore storage write errors.
      }
    },
    [isAuthRoute]
  );

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: StudioTheme = prev === "dark" ? "light" : "dark";
      applyThemeToDocument(isAuthRoute ? "light" : next);
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Ignore storage write errors.
      }
      return next;
    });
  }, [isAuthRoute]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
