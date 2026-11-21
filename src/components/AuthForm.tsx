"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";
import { signIn, signUp } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "login" | "register";
}

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
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#FAFAFA] px-4 py-12">
      <div className="w-full max-w-[380px]">
        <header className="mb-8 flex items-center justify-between border-b border-[#E5E5E5] pb-4">
          <Link
            href="/"
            className="wordmark text-[15px] font-medium text-[#111111] uppercase"
          >
            SILHO
          </Link>
          <span className="text-[12px] text-[#6B6B6B]">Wardrobe Ledger</span>
        </header>

        <section className="border border-[#E5E5E5] bg-white p-7 sm:p-8">
          <h1 className="text-[20px] font-medium tracking-[-0.02em] text-[#111111]">
            {isRegister ? "Create account" : "Sign in"}
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#525252]">
            {isRegister
              ? "Catalog your wardrobe pieces and track cost per wear."
              : "Access your wardrobe archive and wear ledger."}
          </p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4" noValidate>
            {isRegister && (
              <div>
                <label
                  htmlFor="auth-name"
                  className="mb-1.5 block text-[12px] font-medium text-[#111111]"
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
                  className="h-10 w-full border border-[#E5E5E5] bg-white px-3 text-[14px] text-[#111111] placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA] disabled:text-[#6B6B6B]"
                />
              </div>
            )}

            <div>
              <label
                htmlFor="auth-email"
                className="mb-1.5 block text-[12px] font-medium text-[#111111]"
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
                className="h-10 w-full border border-[#E5E5E5] bg-white px-3 text-[14px] text-[#111111] placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA] disabled:text-[#6B6B6B]"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between">
                <label
                  htmlFor="auth-password"
                  className="block text-[12px] font-medium text-[#111111]"
                >
                  Password
                </label>
                {isRegister && (
                  <span className="text-[11px] text-[#6B6B6B]">
                    Min. 8 characters
                  </span>
                )}
              </div>
              <input
                id="auth-password"
                type="password"
                autoComplete={isRegister ? "new-password" : "current-password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                disabled={isSubmitting}
                className="h-10 w-full border border-[#E5E5E5] bg-white px-3 text-[14px] text-[#111111] placeholder:text-[#737373] transition-colors focus:border-[#111111] focus:outline-none disabled:bg-[#FAFAFA] disabled:text-[#6B6B6B]"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="border border-[#DC2626]/30 bg-[#FEF2F2] px-3 py-2.5 text-[13px] leading-snug text-[#991B1B]"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-2 flex h-10 w-full items-center justify-center gap-2 bg-[#111111] px-4 text-[13px] font-medium text-white transition-colors hover:bg-[#262626] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>{isRegister ? "Creating account…" : "Signing in…"}</span>
                </>
              ) : (
                <>
                  <span>{isRegister ? "Create account" : "Continue"}</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          </form>
        </section>

        <footer className="mt-5 flex items-center justify-between text-[13px] text-[#525252]">
          <span>{isRegister ? "Already have an account?" : "New to SILHO?"}</span>
          <Link
            href={isRegister ? "/login" : "/register"}
            className="font-medium text-[#111111] underline underline-offset-4 transition-opacity hover:opacity-70"
          >
            {isRegister ? "Sign in" : "Create account"}
          </Link>
        </footer>
      </div>
    </main>
  );
}
