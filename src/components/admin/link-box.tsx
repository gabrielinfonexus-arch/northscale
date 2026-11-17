"use client";
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A one-time link (invite / reset / public link) shown once, with a copy button. */
export function LinkBox({ url, note }: { url: string; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-accent/60 p-2.5" data-testid="link-box">
      {note && <p className="text-[12px] text-muted">{note}</p>}
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={url}
          aria-label="Link"
          className="h-8 min-w-0 flex-1 rounded border border-border bg-surface px-2 font-mono text-[12px]"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={async () => {
            await navigator.clipboard?.writeText(url).catch(() => {});
            setCopied(true);
          }}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export const field = "h-8 rounded-md border border-border bg-surface px-2 text-[13px] outline-none focus:ring-2 focus:ring-ring";
