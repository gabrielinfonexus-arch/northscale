"use client";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { LogOut, Moon, Sun } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { setDemoData } from "@/server/actions";
import { logout } from "@/server/auth-actions";

export function SidebarFooter({
  demoData,
  canEdit,
  user,
}: {
  demoData: boolean;
  canEdit: boolean;
  user: { name: string; detail: string; isShare: boolean };
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const [demo, setDemo] = useState(demoData);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <div className="flex flex-col gap-2 border-t border-border px-5 py-3 text-xs text-muted">
      <div className="flex items-center justify-between gap-2" data-testid="current-user">
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">{user.name}</div>
          <div className="truncate text-[11px] text-subtle">{user.detail}</div>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded p-1 hover:bg-accent hover:text-foreground"
            aria-label={user.isShare ? "Close shared view" : "Sign out"}
            title="Sign out"
          >
            <LogOut className="size-3.5" />
          </button>
        </form>
      </div>
      {canEdit && (
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
      )}
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
