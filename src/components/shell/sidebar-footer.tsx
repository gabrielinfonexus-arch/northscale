"use client";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Moon, Sun } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { setDemoData } from "@/server/actions";

export function SidebarFooter({ demoData, canEdit }: { demoData: boolean; canEdit: boolean }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [demo, setDemo] = useState(demoData);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="flex flex-col gap-2 border-t border-border px-5 py-3 text-xs text-muted">
      <label className="flex items-center justify-between gap-2">
        <span>Demo data</span>
        <Switch
          checked={demo}
          disabled={!canEdit || pending}
          aria-label="Show demo data"
          onCheckedChange={(v) => {
            setDemo(v);
            start(async () => {
              await setDemoData(v);
              router.refresh();
            });
          }}
        />
      </label>
      <button
        type="button"
        className="flex items-center justify-between gap-2 hover:text-foreground"
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      >
        <span>
          <span className="dark:hidden">Light mode</span>
          <span className="hidden dark:inline">Dark mode</span>
        </span>
        <span>
          <Sun className="size-3.5 dark:hidden" />
          <Moon className="hidden size-3.5 dark:block" />
        </span>
      </button>
    </div>
  );
}
