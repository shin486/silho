import { WorkspaceShell } from "@/components/WorkspaceShell";
import {
  getTryOnQuota,
  getUserBodyProfile,
  getUserSavedLooks,
} from "@/lib/canvas";
import { getUserWardrobe } from "@/lib/closet";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function readParam(params: SearchParams, key: string): string | undefined {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length <= 64 ? value : undefined;
}

export default async function CanvasPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const [items, bodyProfile, quota, savedLooks] = await Promise.all([
    getUserWardrobe(session.user.id),
    getUserBodyProfile(session.user.id),
    getTryOnQuota(session.user.id),
    getUserSavedLooks(session.user.id),
  ]);

  const accessories = (readParam(params, "acc") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 12);

  const initialSelection = {
    top: readParam(params, "top"),
    outerwear: readParam(params, "outerwear"),
    bottom: readParam(params, "bottom"),
    shoes: readParam(params, "shoes"),
    accessories,
  };

  const hasExplicitSelection = Boolean(
    initialSelection.top ||
      initialSelection.outerwear ||
      initialSelection.bottom ||
      initialSelection.shoes ||
      initialSelection.accessories.length > 0
  );

  return (
    <WorkspaceShell
      initialView={hasExplicitSelection ? "studio" : "closet"}
      initialItems={items}
      initialBodyProfile={bodyProfile}
      initialSavedLooks={savedLooks}
      initialRemaining={quota.remaining}
      isUnlimited={quota.unlimited}
      dailyLimit={quota.limit}
      userName={session.user.name || session.user.email}
      initialSelection={initialSelection}
    />
  );
}
