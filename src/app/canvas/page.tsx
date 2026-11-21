import { CanvasClient } from "@/components/CanvasClient";
import {
  getTryOnQuota,
  getUserBodyProfile,
  getUserSavedLooks,
} from "@/lib/canvas";
import { getUserWardrobe } from "@/lib/closet";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function CanvasPage() {
  const session = await requireSession();
  const [items, bodyProfile, quota, savedLooks] = await Promise.all([
    getUserWardrobe(session.user.id),
    getUserBodyProfile(session.user.id),
    getTryOnQuota(session.user.id),
    getUserSavedLooks(session.user.id),
  ]);

  return (
    <CanvasClient
      items={items}
      initialBodyProfile={bodyProfile}
      initialSavedLooks={savedLooks}
      initialRemaining={quota.remaining}
      isUnlimited={quota.unlimited}
      dailyLimit={quota.limit}
      userName={session.user.name || session.user.email}
    />
  );
}
