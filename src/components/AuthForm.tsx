"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn, signUp } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "login" | "register";
}

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isRegister = mode === "register";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    const trimmedName = name.trim();

    if (isRegister && !trimmedName) {
      setError("Enter your name to start an archive");
      return;
    }

    if (!trimmedEmail || !password) {
      setError("Enter your email and password");
      return;
    }

    if (isRegister && password.length < 8) {
      setError("Use at least 8 characters for your password");
      return;
    }

    setIsSubmitting(true);

    try {
      if (isRegister) {
        const response = await signUp.email({
          name: trimmedName,
          email: trimmedEmail,
          password,
        });

        if (response.error) {
          setError(
            response.error.message ||
              "Could not create archive — check your details"
          );
          setIsSubmitting(false);
          return;
        }
      } else {
        const response = await signIn.email({
          email: trimmedEmail,
          password,
        });

        if (response.error) {
          setError(
            response.error.message || "Email or password doesn't match"
          );
          setIsSubmitting(false);
          return;
        }
      }

      router.push("/closet");
      router.refresh();
    } catch {
      setError("Couldn't reach the server — try again");
      setIsSubmitting(false);
    }
  }

  const emailIndex = isRegister ? "02" : "01";
  const passwordIndex = isRegister ? "03" : "02";

  return (
    <main
      style={{ colorScheme: "light" }}
      className="flex min-h-dvh flex-col justify-between bg-[#FAFAFA] text-[#0A0A0A] selection:bg-[#0A0A0A] selection:text-[#FFFFFF]"
    >
      {/* Top Bar */}
      <header className="border-b border-[#E5E5E5] bg-[#FFFFFF]">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center justify-between px-4 sm:px-8 lg:px-10">
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-2.5 focus-visible:outline-[1.5px] focus-visible:outline-offset-4 focus-visible:outline-[#0A0A0A]"
          >
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] shrink-0 bg-[#0A0A0A]"
            />
            <span className="text-[13px] font-medium tracking-[0.22em] text-[#0A0A0A]">
              SILHO
            </span>
          </Link>

          <span className="font-mono text-[12px] text-[#666666]">
            Wardrobe archive
          </span>
        </div>
      </header>

      {/* Archival Hangtag + Desktop Ledger Specimen */}
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 items-start px-4 pt-6 pb-12 sm:px-8 sm:pt-12 lg:items-center lg:px-10 lg:py-16">
        <div className="grid w-full grid-cols-1 lg:grid-cols-12 lg:items-start lg:gap-8">
          <div className="mx-auto w-full max-w-[420px] lg:col-span-5 lg:col-start-2 lg:mx-0 lg:max-w-none">
            <section
              aria-labelledby="auth-heading"
              className="border border-[#E5E5E5] bg-[#FFFFFF]"
            >
              <div className="flex items-baseline justify-between border-b border-[#E5E5E5] px-4 py-4 sm:px-5 sm:py-5">
                <h1
                  id="auth-heading"
                  className="text-[24px] leading-[1.15] font-medium tracking-[-0.025em] text-[#0A0A0A] sm:text-[28px]"
                >
                  {isRegister ? "Start an archive" : "Sign in"}
                </h1>
                <span className="font-mono text-[12px] text-[#666666] tabular-nums">
                  {isRegister ? "01–03" : "01–02"}
                </span>
              </div>

              <form onSubmit={handleSubmit} noValidate>
                {isRegister && (
                  <div className="relative flex h-14 items-center border-b border-[#E5E5E5] bg-[#FFFFFF] transition-colors duration-150 focus-within:z-10 focus-within:shadow-[inset_0_0_0_1px_#0A0A0A]">
                    <label
                      htmlFor="auth-name"
                      className="flex h-full w-[116px] shrink-0 cursor-pointer items-center gap-2 border-r border-[#E5E5E5] px-3.5 font-mono text-[12px] font-normal text-[#0A0A0A] tabular-nums select-none sm:w-[128px] sm:px-4"
                    >
                      <span className="text-[#666666]">01</span>
                      <span>Name</span>
                    </label>
                    <input
                      id="auth-name"
                      type="text"
                      autoComplete="name"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      disabled={isSubmitting}
                      className="silho-hangtag-input h-full min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent px-3.5 text-[16px] font-normal text-[#0A0A0A] caret-[#0A0A0A] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-[#FAFAFA] disabled:text-[#666666] sm:px-4"
                    />
                  </div>
                )}

                <div className="relative flex h-14 items-center border-b border-[#E5E5E5] bg-[#FFFFFF] transition-colors duration-150 focus-within:z-10 focus-within:shadow-[inset_0_0_0_1px_#0A0A0A]">
                  <label
                    htmlFor="auth-email"
                    className="flex h-full w-[116px] shrink-0 cursor-pointer items-center gap-2 border-r border-[#E5E5E5] px-3.5 font-mono text-[12px] font-normal text-[#0A0A0A] tabular-nums select-none sm:w-[128px] sm:px-4"
                  >
                    <span className="text-[#666666]">{emailIndex}</span>
                    <span>Email</span>
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isSubmitting}
                    className="silho-hangtag-input h-full min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent px-3.5 text-[16px] font-normal text-[#0A0A0A] caret-[#0A0A0A] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-[#FAFAFA] disabled:text-[#666666] sm:px-4"
                  />
                </div>

                <div className="relative flex h-14 items-center border-b border-[#E5E5E5] bg-[#FFFFFF] transition-colors duration-150 focus-within:z-10 focus-within:shadow-[inset_0_0_0_1px_#0A0A0A]">
                  <label
                    htmlFor="auth-password"
                    className="flex h-full w-[116px] shrink-0 cursor-pointer items-center gap-2 border-r border-[#E5E5E5] px-3.5 font-mono text-[12px] font-normal text-[#0A0A0A] tabular-nums select-none sm:w-[128px] sm:px-4"
                  >
                    <span className="text-[#666666]">{passwordIndex}</span>
                    <span>Password</span>
                  </label>
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    autoComplete={
                      isRegister ? "new-password" : "current-password"
                    }
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                    className="silho-hangtag-input h-full min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent px-3.5 text-[16px] font-normal text-[#0A0A0A] caret-[#0A0A0A] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-[#FAFAFA] disabled:text-[#666666] sm:px-4"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    disabled={isSubmitting}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    className="h-full shrink-0 cursor-pointer border-l border-[#E5E5E5] px-3.5 font-mono text-[12px] font-normal text-[#666666] transition-colors duration-150 hover:text-[#0A0A0A] focus-visible:z-20 focus-visible:outline-[1.5px] focus-visible:outline-offset-[-2px] focus-visible:outline-[#0A0A0A] disabled:opacity-50 sm:px-4"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>

                {isRegister && (
                  <div className="flex h-9 items-center justify-between border-b border-[#E5E5E5] bg-[#FAFAFA] px-3.5 font-mono text-[11px] text-[#666666] tabular-nums sm:px-4">
                    <span>Requirement</span>
                    <span>8 characters minimum</span>
                  </div>
                )}

                {error && (
                  <div
                    role="alert"
                    className="border-b border-[#D9B4B2] bg-[#FAF2F2] px-3.5 py-3 text-[13px] leading-snug text-[#8C1D18] sm:px-4"
                  >
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  aria-busy={isSubmitting}
                  className="flex h-14 w-full cursor-pointer items-center justify-center rounded-none bg-[#0A0A0A] px-5 text-[14px] font-medium tracking-[-0.01em] text-[#FFFFFF] transition-colors duration-150 hover:bg-[#1F1F1F] focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-[#0A0A0A] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting
                    ? isRegister
                      ? "Creating archive…"
                      : "Opening archive…"
                    : isRegister
                      ? "Create archive"
                      : "Open archive"}
                </button>
              </form>
            </section>

            <div className="mt-5 flex items-baseline justify-between text-[13px]">
              <span className="text-[#666666]">
                {isRegister ? "Have an archive" : "No archive yet"}
              </span>
              <Link
                href={isRegister ? "/login" : "/register"}
                className="font-mono text-[12px] font-medium text-[#0A0A0A] underline decoration-[#0A0A0A]/35 underline-offset-4 transition-colors duration-150 hover:decoration-[#0A0A0A] focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-[#0A0A0A]"
              >
                {isRegister ? "Sign in" : "Start one"}
              </Link>
            </div>
          </div>

          {/* Desktop Cost-Per-Wear Ledger Specimen */}
          <aside className="hidden lg:col-span-4 lg:col-start-8 lg:flex lg:flex-col lg:border-l lg:border-[#E5E5E5] lg:pt-4 lg:pl-8">
            <p className="max-w-[30ch] text-[15px] leading-[1.6] font-normal text-[#0A0A0A]">
              Catalog what you own, log each wear, and see what every garment
              actually costs to keep.
            </p>
            <div className="mt-8 border-t border-[#E5E5E5] pt-4">
              <p className="font-mono text-[13px] font-medium text-[#0A0A0A] tabular-nums">
                ₱ 2,400 ÷ 18 wears = ₱ 133 / wear
              </p>
              <p className="mt-1 font-mono text-[11px] text-[#666666]">
                Cost-per-wear ledger specimen
              </p>
            </div>
          </aside>
        </div>
      </div>

      {/* Single Colophon Footer */}
      <footer className="border-t border-[#E5E5E5] bg-[#FFFFFF]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-4 py-3.5 font-mono text-[11px] text-[#666666] tabular-nums sm:px-8 lg:px-10">
          <span>SILHO — Wardrobe ledger and fit studio</span>
          <div className="flex items-center gap-3">
            <span>₱ PHP</span>
            <span aria-hidden="true" className="h-3 w-px bg-[#E5E5E5]" />
            <span>v0.1.0</span>
          </div>
        </div>
      </footer>
    </main>
  );
}
