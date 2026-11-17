"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { disconnectConnection, setClientArchived } from "@/server/client-actions";

export function ArchiveClientButton({ clientId, archived, name }: { clientId: string; archived: boolean; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => {
        if (!archived && !confirm(`Archive ${name}? It disappears from every page (data is kept and you can restore it).`)) return;
        start(async () => {
          await setClientArchived(clientId, !archived);
          router.refresh();
        });
      }}
    >
      {archived ? "Restore" : "Archive"}
    </Button>
  );
}

export function DisconnectButton({ connectionId, name }: { connectionId: string; name: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-[12px] text-bad">{error}</span>}
      <Button
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (
            !confirm(
              `Disconnect ${name}? Syncing stops and the stored token is deleted. Data already synced is kept; nothing changes in the account itself.`,
            )
          )
            return;
          start(async () => {
            const r = await disconnectConnection(connectionId);
            if (!r.ok) setError(r.error);
            router.refresh();
          });
        }}
      >
        Disconnect
      </Button>
    </span>
  );
}
