"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { signIn, signUp } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "login" | "register";
}

const ARCHIVE_SPECS = [
  {
    label: "Archive",
    detail: "Transparent garment cutouts cataloged in seconds",
  },
  {
    label: "Ledger",
    detail: "Live cost-per-wear in PHP and 90-day unworn signals",
  },
  {
    label: "Studio",
    detail: "AI virtual try-on, Tailor Fit, and 2D Layer Board",
  },
] as const;

export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
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
    <main className="flex min-h-screen flex-col justify-between bg-[#F9F8F6] text-[#0E0E0E]">
      {/* Minimal Architectural Header */}
      <header className="border-b border-[#E2E0DA] bg-white">
        <div className="mx-auto flex h-[60px] max-w-[1200px] items-center justify-between px-5 sm:px-8">
          <Link href="/" className="inline-flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="h-[7px] w-[7px] shrink-0 bg-[#0E0E0E]"
            />
            <span className="wordmark text-[15px] font-semibold uppercase text-[#0E0E0E]">
              SILHO
            </span>
          </Link>
          <span className="text-[11px] font-medium tracking-[0.14em] text-[#6C6A64] uppercase">
            Wardrobe Ledger
          </span>
        </div>
      </header>

      {/* Main Swiss-Japanese Architectural Split */}
      <div className="mx-auto flex w-full max-w-[1200px] flex-1 items-center px-5 py-10 sm:px-8 lg:py-16">
        <div className="grid w-full grid-cols-1 border border-[#E2E0DA] bg-white lg:grid-cols-12">
          {/* Editorial Specification Column */}
          <div className="flex flex-col justify-between border-b border-[#E2E0DA] bg-[#F2F1ED] p-7 sm:p-10 lg:col-span-6 lg:border-r lg:border-b-0 lg:p-12">
            <div>
              <h1 className="max-w-[14ch] text-[30px] leading-[1.08] font-medium tracking-[-0.035em] text-[#0E0E0E] sm:text-[38px]">
                Your wardrobe, measured.
              </h1>
              <p className="mt-4 max-w-[40ch] text-[14px] leading-relaxed text-[#4A4945]">
                Catalog every garment, track true cost per wear over time, and
                preview fits before getting dressed.
              </p>
            </div>

            <dl className="mt-10 divide-y divide-[#E2E0DA] border-t border-[#E2E0DA] lg:mt-16">
              {ARCHIVE_SPECS.map((spec) => (
                <div
                  key={spec.label}
                  className="grid grid-cols-12 gap-3 py-3.5 text-[12px]"
                >
                  <dt className="col-span-4 font-medium tracking-[0.12em] text-[#0E0E0E] uppercase sm:col-span-3">
                    {spec.label}
                  </dt>
                  <dd className="col-span-8 text-[#4A4945] sm:col-span-9">
                    {spec.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Auth Form Column */}
          <section className="flex flex-col justify-between bg-white p-7 sm:p-10 lg:col-span-6 lg:p-12">
            <div>
              <h2 className="text-[22px] font-medium tracking-[-0.025em] text-[#0E0E0E]">
                {isRegister ? "Create account" : "Sign in"}
              </h2>
              <p className="mt-1.5 text-[13px] leading-relaxed text-[#4A4945]">
                {isRegister
                  ? "Start your personal garment archive and wear ledger."
                  : "Access your closet archive, cost-per-wear ledger, and fit studio."}
              </p>

              <form
                onSubmit={handleSubmit}
                className="mt-7 space-y-5"
                noValidate
              >
                {isRegister && (
                  <div>
                    <label
                      htmlFor="auth-name"
                      className="mb-2 block text-[11px] font-medium tracking-[0.1em] text-[#4A4945] uppercase"
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
                      className="h-11 w-full border border-[#E2E0DA] bg-white px-3.5 text-[14px] text-[#0E0E0E] placeholder:text-[#6C6A64] transition-colors focus:border-[#0E0E0E] disabled:bg-[#F9F8F6] disabled:text-[#6C6A64]"
                    />
                  </div>
                )}

                <div>
                  <label
                    htmlFor="auth-email"
                    className="mb-2 block text-[11px] font-medium tracking-[0.1em] text-[#4A4945] uppercase"
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
                    className="h-11 w-full border border-[#E2E0DA] bg-white px-3.5 text-[14px] text-[#0E0E0E] placeholder:text-[#6C6A64] transition-colors focus:border-[#0E0E0E] disabled:bg-[#F9F8F6] disabled:text-[#6C6A64]"
                  />
                </div>

                <div>
                  <div className="mb-2 flex items-baseline justify-between">
                    <label
                      htmlFor="auth-password"
                      className="block text-[11px] font-medium tracking-[0.1em] text-[#4A4945] uppercase"
                    >
                      Password
                    </label>
                    {isRegister && (
                      <span className="text-[11px] text-[#6C6A64]">
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
                    className="h-11 w-full border border-[#E2E0DA] bg-white px-3.5 text-[14px] text-[#0E0E0E] placeholder:text-[#6C6A64] transition-colors focus:border-[#0E0E0E] disabled:bg-[#F9F8F6] disabled:text-[#6C6A64]"
                  />
                </div>

                {error && (
                  <div
                    role="alert"
                    className="border border-[#D9B4B2] bg-[#FAF2F2] px-3.5 py-2.5 text-[13px] leading-snug text-[#8C1D18]"
                  >
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="mt-1 flex h-11 w-full items-center justify-center gap-2 bg-[#0E0E0E] px-5 text-[13px] font-medium tracking-[0.02em] text-white transition-colors hover:bg-[#2B2B29] disabled:cursor-not-allowed disabled:opacity-55"
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
                      <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </>
                  )}
                </button>
              </form>
            </div>

            <footer className="mt-8 flex items-center justify-between border-t border-[#E2E0DA] pt-5 text-[13px] text-[#4A4945]">
              <span>
                {isRegister ? "Already have an account?" : "New to SILHO?"}
              </span>
              <Link
                href={isRegister ? "/login" : "/register"}
                className="font-medium text-[#0E0E0E] underline underline-offset-4 transition-opacity hover:opacity-65"
              >
                {isRegister ? "Sign in" : "Create account"}
              </Link>
            </footer>
          </section>
        </div>
      </div>

      {/* Quiet Spec Footer */}
      <footer className="border-t border-[#E2E0DA] bg-white">
        <div className="mx-auto flex max-w-[1200px] items-center justify-between px-5 py-3.5 text-[11px] tracking-[0.08em] text-[#6C6A64] uppercase sm:px-8">
          <span>SILHO Archive</span>
          <span>PHP · Cost-Per-Wear Ledger</span>
        </div>
      </footer>
    </main>
  );
}
