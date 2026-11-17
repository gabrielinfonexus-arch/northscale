import { AlertOctagon, AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

export type Sev = "CRITICAL" | "WARNING" | "INFO";

const STYLE: Record<Sev, { label: string; cls: string; Icon: typeof Info }> = {
  CRITICAL: { label: "Critical", cls: "bg-bad-bg text-bad", Icon: AlertOctagon },
  WARNING: { label: "Warning", cls: "bg-warn-bg text-warn", Icon: AlertTriangle },
  INFO: { label: "Info", cls: "bg-accent text-muted", Icon: Info },
};

/** Severity is always icon + label, never color alone. */
export function SeverityBadge({ severity, className }: { severity: Sev; className?: string }) {
  const s = STYLE[severity];
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 rounded px-1.5 text-[11px] font-medium", s.cls, className)}>
      <s.Icon className="size-3" aria-hidden />
      {s.label}
    </span>
  );
}
