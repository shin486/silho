"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { signIn, signUp } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "login" | "register";
}

const ARCHIVE_SPECS = [
  {
    label: "Archive",
    detail: "Category-aware transparent garment cutouts",
  },
  {
    label: "Telemetry",
    detail: "Live cost-per-wear in PHP and 90-day unworn signals",
  },
  {
    label: "Studio",
    detail: "2-pass editorial try-on, Tailor Fit, and Layer Board",
  },
] as const;

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      setError("Enter both your email address and password.");
      return;
    }

    if (isRegister && password.length < 8) {
      setError("Password must be at least 8 characters long.");
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
            "Could not create your account. Check your details and try again."
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
            "Invalid email or password. Check your credentials and try again."
          );
          setIsSubmitting(false);
          return;
        }
      }

      router.push("/closet");
      router.refresh();
    } catch {
      setError("Unable to reach the authentication service. Try again.");
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen flex-col justify-between bg-[var(--bg-viewport)] text-[var(--ink-primary)] transition-colors duration-150">
      {/* Minimal Studio Header */}
      <header className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex h-[60px] max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ink-primary)]"
            />
            <span className="text-[16px] font-bold tracking-[-0.03em] text-[var(--ink-primary)]">
              Silho
            </span>
          </Link>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={
              theme === "dark"
                ? "Switch to Light Studio theme"
                : "Switch to Obsidian Dark theme"
            }
            className="inline-flex h-8 items-center gap-2 text-[10px] font-medium tracking-[0.16em] text-[var(--ink-muted)] uppercase transition-colors duration-150 hover:text-[var(--ink-primary)]"
          >
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 rounded-full border border-[var(--ink-primary)] transition-colors duration-150 ${theme === "dark" ? "bg-[var(--ink-primary)]" : "bg-transparent"
                }`}
            />
            <span>{theme === "dark" ? "Obsidian" : "Studio"}</span>
          </button>
        </div>
      </header>

      {/* Editorial Dual-Polarity Card (28px Radius) */}
      <div className="mx-auto flex w-full max-w-[1080px] flex-1 items-center px-4 py-10 sm:px-8 lg:py-16">
        <div className="grid w-full grid-cols-1 overflow-hidden rounded-[28px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] lg:grid-cols-12">
          {/* Left Matte Obsidian Band */}
          <div className="flex flex-col justify-between bg-[#141415] p-8 text-[#F5F5F5] sm:p-11 lg:col-span-6 lg:p-12 dark:bg-[#1B1B1D]">
            <div>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full bg-[#F5F5F5]"
                />
                <span className="text-[10px] font-semibold tracking-[0.18em] text-[#8A8A8E] uppercase">
                  Silho Studio
                </span>
              </div>
              <h1 className="mt-5 max-w-[12ch] text-[34px] leading-[1.04] font-bold tracking-[-0.035em] text-[#F5F5F5] sm:text-[42px]">
                Your wardrobe, measured.
              </h1>
              <p className="mt-4 max-w-[36ch] text-[14px] leading-relaxed text-[#B8B8BC]">
                Catalog every garment cutout, track cost per wear over time, and
                preview fits inside a monochrome editorial studio.
              </p>
            </div>

            <dl className="mt-12 divide-y divide-[#262629] border-t border-[#262629] lg:mt-16">
              {ARCHIVE_SPECS.map((spec) => (
                <div
                  key={spec.label}
                  className="grid grid-cols-12 gap-3 py-3.5 text-[12px]"
                >
                  <dt className="col-span-4 text-[10px] font-semibold tracking-[0.16em] text-[#F5F5F5] uppercase sm:col-span-3">
                    {spec.label}
                  </dt>
                  <dd className="col-span-8 text-[#8A8A8E] sm:col-span-9">
                    {spec.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Right Form Surface */}
          <section className="flex flex-col justify-between bg-[var(--bg-surface)] p-8 sm:p-11 lg:col-span-6 lg:p-12">
            <div>
              <h2 className="text-[24px] font-bold tracking-[-0.03em] text-[var(--ink-primary)]">
                {isRegister ? "Create account" : "Sign in"}
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--ink-muted)]">
                {isRegister
                  ? "Start your personal garment archive and wear telemetry."
                  : "Access your closet archive, cost-per-wear metrics, and fit studio."}
              </p>

              <form
                onSubmit={handleSubmit}
                className="mt-8 space-y-5"
                noValidate
              >
                {isRegister && (
                  <div>
                    <label
                      htmlFor="auth-name"
                      className="mb-2 block text-[10px] font-semibold tracking-[0.16em] text-[var(--ink-muted)] uppercase"
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
                      placeholder="Alex Rivera"
                      disabled={isSubmitting}
                      className="h-11 w-full rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-well)] px-4 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-colors duration-150 focus:border-[var(--ink-primary)] focus:bg-[var(--bg-surface)] disabled:opacity-50"
                    />
                  </div>
                )}

                <div>
                  <label
                    htmlFor="auth-email"
                    className="mb-2 block text-[10px] font-semibold tracking-[0.16em] text-[var(--ink-muted)] uppercase"
                  >
                    Email
                  </label>
                  <input
                    id="auth-email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@domain.com"
                    disabled={isSubmitting}
                    className="h-11 w-full rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-well)] px-4 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-colors duration-150 focus:border-[var(--ink-primary)] focus:bg-[var(--bg-surface)] disabled:opacity-50"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <label
                      htmlFor="auth-password"
                      className="block text-[10px] font-semibold tracking-[0.16em] text-[var(--ink-muted)] uppercase"
                    >
                      Password
                    </label>
                    {isRegister && (
                      <span className="text-[11px] text-[var(--ink-muted)]">
                        Min. 8 characters
                      </span>
                    )}
                  </div>
                  <input
                    id="auth-password"
                    type="password"
                    autoComplete={
                      isRegister ? "new-password" : "current-password"
                    }
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    disabled={isSubmitting}
                    className="h-11 w-full rounded-[12px] border border-[var(--border-hairline)] bg-[var(--bg-well)] px-4 text-[14px] text-[var(--ink-primary)] placeholder:text-[var(--ink-muted)] transition-colors duration-150 focus:border-[var(--ink-primary)] focus:bg-[var(--bg-surface)] disabled:opacity-50"
                  />
                </div>

                {error && (
                  <div
                    role="alert"
                    className="rounded-[12px] border border-[var(--status-danger-border)] bg-[var(--status-danger-bg)] px-4 py-3 text-[13px] leading-snug text-[var(--status-danger-ink)]"
                  >
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="group mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-[12px] bg-[var(--btn-primary-bg)] px-5 text-[11px] font-semibold tracking-[0.16em] text-[var(--btn-primary-fg)] uppercase transition-colors duration-150 hover:bg-[var(--btn-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>
                        {isRegister ? "Creating account…" : "Signing in…"}
                      </span>
                    </>
                  ) : (
                    <>
                      <span>{isRegister ? "Create account" : "Continue"}</span>
                      <ArrowRight
                        className="h-3.5 w-3.5 transition-transform duration-150 group-hover:translate-x-0.5"
                        strokeWidth={1.8}
                      />
                    </>
                  )}
                </button>
              </form>
            </div>

            <footer className="mt-8 flex items-center justify-between border-t border-[var(--border-hairline)] pt-5 text-[13px] text-[var(--ink-muted)]">
              <span>
                {isRegister ? "Already have an account?" : "New to Silho?"}
              </span>
              <Link
                href={isRegister ? "/login" : "/register"}
                className="text-[11px] font-semibold tracking-[0.14em] text-[var(--ink-primary)] uppercase underline underline-offset-4 transition-opacity hover:opacity-65"
              >
                {isRegister ? "Sign in" : "Create account"}
              </Link>
            </footer>
          </section>
        </div>
      </div>

      {/* Quiet Footer */}
      <footer className="border-t border-[var(--border-hairline)] bg-[var(--bg-surface)]">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-3.5 text-[10px] font-medium tracking-[0.16em] text-[var(--ink-muted)] uppercase sm:px-8">
          <span>Silho Wardrobe OS</span>
          <span>PHP · Cost-Per-Wear Telemetry</span>
        </div>
      </footer>
    </main>
  );
}
