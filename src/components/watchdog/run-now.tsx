"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { runChecksNow } from "@/server/watchdog-actions";

export function RunChecksButton({ clientId, label }: { clientId: string | null; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      {msg && (
        <span role="status" className="text-[12px] text-muted">
          {msg}
        </span>
      )}
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await runChecksNow(clientId);
            setMsg(r.ok ? `Checked ${label}: ${r.created} new, ${r.resolved} resolved, ${r.open} open.` : r.error);
            router.refresh();
          })
        }
      >
        <Play aria-hidden />
        {pending ? "Checking…" : "Run checks now"}
      </Button>
    </div>
  );
}
