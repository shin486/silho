"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signIn, signUp } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "login" | "register";
}

function StudioGarmentStudy() {
  return (
    <svg
      viewBox="0 0 280 340"
      fill="none"
      aria-hidden="true"
      className="h-auto w-full max-w-[260px] select-none"
    >
      {/* Subtle architectural registration ticks & vertical plumb axis */}
      <path
        d="M 28 28 L 28 20 L 36 20 M 244 20 L 252 20 L 252 28 M 28 312 L 28 320 L 36 320 M 244 320 L 252 320 L 252 312"
        stroke="#D4D4D4"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="140"
        y1="20"
        x2="140"
        y2="320"
        stroke="#EBEBEB"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />

      {/* Studio garment rail & minimalist hanger */}
      <line
        x1="48"
        y1="44"
        x2="232"
        y2="44"
        stroke="#D4D4D4"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="140"
        y1="44"
        x2="140"
        y2="66"
        stroke="#0A0A0A"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M 100 84 L 140 66 L 180 84"
        stroke="#737373"
        strokeWidth="1"
        strokeLinecap="square"
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />

      {/* Internal tailoring construction seams (placket, drop-shoulders, pocket) */}
      <path
        d="M 140 91 L 140 288 M 94 138 Q 88 114 82 95 M 186 138 Q 192 114 198 95 M 154 138 L 176 138 L 176 164 L 154 164 Z"
        stroke="#D4D4D4"
        strokeWidth="1"
        strokeLinecap="square"
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />

      {/* Tailored overshirt / coat outer silhouette */}
      <path
        d="M 120 81 Q 140 75 160 81"
        stroke="#737373"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M 118 82 Q 140 93 162 82 L 206 98 L 228 196 L 198 202 L 186 138 L 188 288 L 92 288 L 94 138 L 82 202 L 52 196 L 74 98 Z"
        stroke="#0A0A0A"
        strokeWidth="1"
        strokeLinecap="square"
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CompactGarmentMark() {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="h-16 w-16 select-none"
    >
      <line
        x1="6"
        y1="8"
        x2="58"
        y2="8"
        stroke="#E5E5E5"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="32"
        y1="8"
        x2="32"
        y2="16"
        stroke="#0A0A0A"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M 20 23 L 32 16 L 44 23"
        stroke="#737373"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <line
        x1="32"
        y1="25"
        x2="32"
        y2="56"
        stroke="#E5E5E5"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d="M 23 22 Q 32 27 41 22 L 53 28 L 57 46 L 48 48 L 45 36 L 45 56 L 19 56 L 19 36 L 16 48 L 7 46 L 11 28 Z"
        stroke="#0A0A0A"
        strokeWidth="1"
        strokeLinecap="square"
        strokeLinejoin="miter"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
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
      setError("Enter your name to create your wardrobe.");
      return;
    }

    if (!trimmedEmail || !password) {
      setError("Enter your email and password.");
      return;
    }

    if (isRegister && password.length < 8) {
      setError("Use at least 8 characters for your password.");
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
              "Could not create your wardrobe. Check your details and try again."
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
            response.error.message ||
              "Incorrect email or password."
          );
          setIsSubmitting(false);
          return;
        }
      }

      router.push("/closet");
      router.refresh();
    } catch {
      setError("Unable to reach the studio right now. Try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <main
      style={{ colorScheme: "light" }}
      className="min-h-dvh bg-[#FFFFFF] text-[#0A0A0A] selection:bg-[#0A0A0A] selection:text-[#FFFFFF] md:grid md:grid-cols-2"
    >
      {/* Left Half: Desktop Studio Canvas */}
      <aside className="hidden md:flex md:min-h-dvh md:flex-col md:justify-between md:border-r md:border-[#E5E5E5] md:bg-[#FAFAFA] md:p-10 lg:p-14">
        <Link
          href="/"
          className="inline-block w-fit text-[13px] font-medium tracking-[0.18em] text-[#0A0A0A] uppercase focus-visible:outline-[1.5px] focus-visible:outline-offset-4 focus-visible:outline-[#0A0A0A]"
        >
          SILHO
        </Link>

        <div className="my-auto flex items-center justify-center py-8">
          <StudioGarmentStudy />
        </div>

        <p className="text-[11px] font-normal tracking-[0.16em] text-[#737373] uppercase">
          SILHO — PERSONAL WARDROBE ARCHIVE
        </p>
      </aside>

      {/* Right Half: Mobile Single-Screen + Desktop Centered Form */}
      <div className="flex min-h-dvh flex-col bg-[#FFFFFF]">
        {/* Mobile Header */}
        <header className="flex h-14 items-center justify-between border-b border-[#F0F0F0] px-6 md:hidden">
          <Link
            href="/"
            className="text-[13px] font-medium tracking-[0.18em] text-[#0A0A0A] uppercase focus-visible:outline-[1.5px] focus-visible:outline-offset-4 focus-visible:outline-[#0A0A0A]"
          >
            SILHO
          </Link>
          <span className="text-[11px] font-normal tracking-[0.16em] text-[#737373] uppercase">
            WARDROBE STUDIO
          </span>
        </header>

        {/* Desktop Quiet Top-Right Studio Label */}
        <div className="hidden md:flex md:h-14 md:items-center md:justify-end md:px-10 lg:px-14">
          <span className="text-[11px] font-normal tracking-[0.16em] text-[#737373] uppercase">
            WARDROBE STUDIO
          </span>
        </div>

        {/* Form Body */}
        <section
          aria-labelledby="auth-heading"
          className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center px-6 pt-6 pb-10 md:px-0 md:py-12"
        >
          <div className="mb-5 md:hidden">
            <CompactGarmentMark />
          </div>

          <h1
            id="auth-heading"
            className="text-[28px] leading-[1.12] font-normal tracking-[-0.025em] text-[#0A0A0A] md:text-[36px]"
          >
            {isRegister ? "Create wardrobe" : "Sign in"}
          </h1>
          <p className="mt-2 text-[14px] leading-[1.5] font-normal text-[#666666]">
            {isRegister
              ? "Begin your personal studio wardrobe."
              : "Enter your studio wardrobe."}
          </p>

          <form onSubmit={handleSubmit} noValidate className="mt-8">
            <div className="space-y-7">
              {isRegister && (
                <div>
                  <label
                    htmlFor="auth-name"
                    className="block text-[12px] font-normal text-[#737373]"
                  >
                    Name
                  </label>
                  <input
                    id="auth-name"
                    type="text"
                    autoComplete="name"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={isSubmitting}
                    className="silho-seam-input mt-1 w-full appearance-none rounded-none border-0 border-b border-[#E5E5E5] bg-transparent px-0 py-3 text-[16px] font-normal text-[#0A0A0A] caret-[#0A0A0A] transition-colors duration-150 focus:border-[#0A0A0A] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-email"
                  className="block text-[12px] font-normal text-[#737373]"
                >
                  Email
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
                  className="silho-seam-input mt-1 w-full appearance-none rounded-none border-0 border-b border-[#E5E5E5] bg-transparent px-0 py-3 text-[16px] font-normal text-[#0A0A0A] caret-[#0A0A0A] transition-colors duration-150 focus:border-[#0A0A0A] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div>
                <div className="flex items-baseline justify-between">
                  <label
                    htmlFor="auth-password"
                    className="block text-[12px] font-normal text-[#737373]"
                  >
                    Password
                  </label>
                  {isRegister && (
                    <span className="text-[11px] font-normal text-[#737373]">
                      8+ characters
                    </span>
                  )}
                </div>
                <div className="mt-1 flex items-center border-b border-[#E5E5E5] transition-colors duration-150 focus-within:border-[#0A0A0A]">
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
                    className="silho-seam-input min-w-0 flex-1 appearance-none rounded-none border-0 bg-transparent px-0 py-3 pr-3 text-[16px] font-normal text-[#0A0A0A] caret-[#0A0A0A] focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    disabled={isSubmitting}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    className="shrink-0 cursor-pointer py-2 text-[12px] font-normal text-[#737373] transition-colors duration-150 hover:text-[#0A0A0A] focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-[#0A0A0A] disabled:opacity-50"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="mt-6 border-l border-[#0A0A0A] py-0.5 pl-3.5 text-[13px] leading-[1.5] text-[#0A0A0A]"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="mt-8 flex h-12 w-full cursor-pointer items-center justify-center rounded-none bg-[#0A0A0A] px-6 text-[13px] font-medium tracking-[0.02em] text-[#FFFFFF] transition-colors duration-150 hover:bg-[#1F1F1F] focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-[#0A0A0A] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting
                ? isRegister
                  ? "Creating wardrobe…"
                  : "Signing in…"
                : isRegister
                  ? "Create wardrobe"
                  : "Sign in"}
            </button>
          </form>

          <p className="mt-7 text-[13px] font-normal text-[#737373]">
            {isRegister ? "Already have a wardrobe? " : "New to Silho? "}
            <Link
              href={isRegister ? "/login" : "/register"}
              className="text-[#0A0A0A] underline decoration-[#0A0A0A]/40 underline-offset-4 transition-colors duration-150 hover:decoration-[#0A0A0A] focus-visible:outline-[1.5px] focus-visible:outline-offset-2 focus-visible:outline-[#0A0A0A]"
            >
              {isRegister ? "Sign in" : "Create an archive"}
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
