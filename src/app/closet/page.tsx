import { ClosetClient } from "@/components/ClosetClient";
import { getUserWardrobe } from "@/lib/closet";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function ClosetPage() {
  const session = await requireSession();
  const items = await getUserWardrobe(session.user.id);

  return (
    <ClosetClient
      initialItems={items}
      userName={session.user.name || session.user.email}
    />
  );
}
