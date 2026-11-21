import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";

/**
 * Server-side session reader cached per React request lifecycle.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({
    headers: await headers(),
  });
});

/**
 * Ensures an authenticated session exists for protected Server Components.
 * Redirects unauthenticated visitors to `/login`.
 */
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }
  return session;
}
