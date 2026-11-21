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
    <header className="sticky top-0 z-30 border-b border-[#E5E5E5] bg-white/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6 sm:gap-8">
          <Link
            href="/closet"
            className="wordmark text-[15px] font-medium text-[#111111] uppercase"
          >
            SILHO
          </Link>

          <nav aria-label="Primary" className="flex h-14 items-stretch gap-5">
            {NAV_ITEMS.map((item) => {
              const isActive =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`relative flex items-center text-[13px] transition-colors ${
                    isActive
                      ? "font-medium text-[#111111]"
                      : "text-[#6B6B6B] hover:text-[#111111]"
                  }`}
                >
                  {item.label}
                  {isActive && (
                    <span className="absolute inset-x-0 bottom-0 h-[1.5px] bg-[#111111]" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3 sm:gap-5">
          {metricsSlot && (
            <div className="hidden items-center gap-5 border-r border-[#E5E5E5] pr-5 lg:flex">
              {metricsSlot}
            </div>
          )}

          {actionSlot}

          <div className="flex items-center gap-3 border-l border-[#E5E5E5] pl-3 sm:pl-4">
            {userName && (
              <span className="hidden max-w-[140px] truncate text-[12px] text-[#525252] xl:inline">
                {userName}
              </span>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
              className="inline-flex h-8 items-center gap-1.5 border border-[#E5E5E5] bg-white px-2.5 text-[12px] text-[#525252] transition-colors hover:border-[#111111] hover:text-[#111111] disabled:opacity-50"
            >
              {signingOut ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <LogOut className="h-3.5 w-3.5" />
              )}
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
