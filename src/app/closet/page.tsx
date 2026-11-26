import { WorkspaceShell } from "@/components/WorkspaceShell";
import {
  getTryOnQuota,
  getUserBodyProfile,
  getUserSavedLooks,
} from "@/lib/canvas";
import { getUserWardrobe } from "@/lib/closet";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ClosetPage() {
  const session = await requireSession();
  const [items, bodyProfile, quota, savedLooks] = await Promise.all([
    getUserWardrobe(session.user.id),
    getUserBodyProfile(session.user.id),
    getTryOnQuota(session.user.id),
    getUserSavedLooks(session.user.id),
  ]);

  return (
    <WorkspaceShell
      initialView="closet"
      initialItems={items}
      initialBodyProfile={bodyProfile}
      initialSavedLooks={savedLooks}
      initialRemaining={quota.remaining}
      isUnlimited={quota.unlimited}
      dailyLimit={quota.limit}
      userName={session.user.name || session.user.email}
    />
  );
}
