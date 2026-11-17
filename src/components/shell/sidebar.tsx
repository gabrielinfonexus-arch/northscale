"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { NAV } from "@/lib/nav";
import { pickGlobalParams } from "@/lib/filters";
import { cn } from "@/lib/utils";

/** Sidebar navigation. Global filters (client, dates…) are carried over between pages. */
export function SidebarNav({ onNavigate, badges }: { onNavigate?: () => void; badges?: Record<string, number> }) {
  const pathname = usePathname();
  const sp = useSearchParams();
  const qs = pickGlobalParams(new URLSearchParams(sp.toString())).toString();
  return <NavList pathname={pathname} qs={qs} onNavigate={onNavigate} badges={badges} />;
}

export function NavList({
  pathname,
  qs = "",
  onNavigate,
  badges = {},
}: {
  pathname?: string;
  qs?: string;
  onNavigate?: () => void;
  /** e.g. open critical alerts on /watchdog */
  badges?: Record<string, number>;
}) {
  return (
    <nav className="flex flex-col gap-5 px-3 pb-6" aria-label="Main">
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="mb-1.5 px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-subtle">{g.group}</div>
          <ul className="flex flex-col gap-px">
            {g.items.map((it) => {
              const active = pathname === it.href || pathname?.startsWith(it.href + "/");
              return (
                <li key={it.href}>
                  <Link
                    href={qs ? `${it.href}?${qs}` : it.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-[30px] items-center rounded-md px-2 text-[13.5px] text-zinc-600 transition-colors hover:bg-accent hover:text-foreground dark:text-zinc-400",
                      active && "bg-accent font-medium text-foreground dark:text-foreground",
                    )}
                  >
                    {active && <span className="absolute -left-3 top-1 bottom-1 w-[3px] rounded-r bg-primary" aria-hidden />}
                    {it.label}
                    {!!badges[it.href] && (
                      <span
                        className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-bad px-1 text-[10px] font-semibold tabular-nums text-white"
                        aria-label={`${badges[it.href]} open critical alerts`}
                        data-testid={`nav-badge-${it.href.slice(1)}`}
                      >
                        {badges[it.href] > 99 ? "99+" : badges[it.href]}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
