"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Loader2, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth-client";

interface NavbarProps {
  userName?: string | null;
  metricsSlot?: ReactNode;
  actionSlot?: ReactNode;
}

const NAV_ITEMS = [
  { href: "/closet", label: "Closet" },
  { href: "/canvas", label: "Canvas" },
] as const;

export function Navbar({ userName, metricsSlot, actionSlot }: NavbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

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

  return (
    <header className="sticky top-0 z-30 border-b border-[#E2E0DA] bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-[60px] max-w-[1440px] items-center justify-between gap-2.5 px-3.5 sm:gap-4 sm:px-6 lg:px-10">
        <div className="flex h-full min-w-0 items-center gap-3.5 sm:gap-10">
          <Link
            href="/closet"
            className="inline-flex shrink-0 items-center gap-2 text-[#0E0E0E] transition-opacity hover:opacity-75 sm:gap-2.5"
          >
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] shrink-0 bg-[#0E0E0E]"
            />
            <span className="wordmark text-[14px] font-semibold uppercase sm:text-[15px]">
              SILHO
            </span>
          </Link>

          <nav
            aria-label="Primary"
            className="flex h-full items-stretch gap-4 sm:gap-6"
          >
            {NAV_ITEMS.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex items-center text-[13px] tracking-[0.01em] transition-colors ${
                    isActive
                      ? "font-medium text-[#0E0E0E]"
                      : "text-[#6C6A64] hover:text-[#0E0E0E]"
                  }`}
                >
                  {item.label}
                  {isActive && (
                    <span className="absolute inset-x-0 bottom-0 h-[2px] bg-[#0E0E0E]" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:gap-4">
          {metricsSlot && (
            <div className="hidden items-center gap-5 border-r border-[#E2E0DA] pr-5 lg:flex">
              {metricsSlot}
            </div>
          )}

          {actionSlot}

          <div className="flex items-center gap-3 border-l border-[#E2E0DA] pl-2 sm:pl-4">
            {userName && (
              <span className="hidden max-w-[150px] truncate text-[12px] text-[#4A4945] xl:inline">
                {userName}
              </span>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex h-9 w-9 items-center justify-center gap-1.5 border border-[#E2E0DA] bg-white px-0 text-[12px] font-medium text-[#4A4945] transition-colors hover:border-[#0E0E0E] hover:text-[#0E0E0E] disabled:opacity-50 sm:w-auto sm:px-3"
            >
              {signingOut ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" strokeWidth={1.6} />
              )}
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
