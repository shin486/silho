import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const session = await getSession();
  if (session) {
    redirect("/closet");
  }

  return <AuthForm mode="login" />;
}
