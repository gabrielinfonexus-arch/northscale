import Link from "next/link";
import { Suspense } from "react";
import { NavList, SidebarNav } from "@/components/shell/sidebar";
import { SidebarFooter } from "@/components/shell/sidebar-footer";
import { MobileNav } from "@/components/shell/mobile-nav";
import { ClientSwitcherFromUrl } from "@/components/shell/client-switcher";
import { CommandPalette } from "@/components/shell/command-palette";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentUser } from "@/server/auth";
import { getOrgSettings, listClients } from "@/server/clients";
import { openCriticalCount } from "@/server/watchdog/queries";
import { ALL_NAV } from "@/lib/nav";
import { canSeePage } from "@/lib/permissions";
import type { SessionUser } from "@/server/auth";

const ROLE_LABEL = { OWNER: "Owner", ADMIN: "Admin", ANALYST: "Analyst", CLIENT_VIEWER: "Client viewer" } as const;
const visibleHrefs = (u: SessionUser) => ALL_NAV.filter((n) => canSeePage(u, n.href.slice(1))).map((n) => n.href);

async function navProps() {
  const user = await getCurrentUser();
  const visible = visibleHrefs(user);
  const critical = visible.includes("/watchdog") ? await openCriticalCount() : 0;
  return { visible, badges: { "/watchdog": critical } };
}

async function SidebarNavWithBadges() {
  return <SidebarNav {...await navProps()} />;
}

async function MobileNavLoader() {
  return <MobileNav {...await navProps()} />;
}

async function SidebarFooterLoader() {
  const [user, settings] = await Promise.all([getCurrentUser(), getOrgSettings()]);
  return (
    <SidebarFooter
      demoData={settings?.demoData ?? true}
      canEdit={user.role === "OWNER" || user.role === "ADMIN"}
      user={{
        name: user.name || user.email || "Signed in",
        detail: user.kind === "share" ? "Read-only link" : `${ROLE_LABEL[user.role]} · ${user.email}`,
        isShare: user.kind === "share",
      }}
    />
  );
}

async function TopBarSwitcher() {
  const clients = await listClients();
  return <ClientSwitcherFromUrl clients={clients} />;
}

async function Palette() {
  const [clients, user] = await Promise.all([listClients(), getCurrentUser()]);
  return <CommandPalette clients={clients.map((c) => ({ slug: c.slug, name: c.name }))} visible={visibleHrefs(user)} />;
}

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[200px] flex-col border-r border-border bg-surface lg:flex">
        <Link href="/data" className="px-5 pb-6 pt-5 text-[15px] font-semibold tracking-tight">
          NorthScale
        </Link>
        <div className="scroll-thin flex-1 overflow-y-auto">
          <Suspense fallback={<NavList />}>
            <SidebarNavWithBadges />
          </Suspense>
        </div>
        <Suspense fallback={<div className="h-[76px] border-t border-border" />}>
          <SidebarFooterLoader />
        </Suspense>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col lg:pl-[200px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur lg:px-7">
          <Suspense fallback={null}>
            <MobileNavLoader />
          </Suspense>
          <span className="text-[15px] font-semibold lg:hidden">NorthScale</span>
          <div className="ml-auto flex items-center gap-2">
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[10px] text-muted md:inline">⌘K</kbd>
            <Suspense fallback={<Skeleton className="h-8 w-48" />}>
              <TopBarSwitcher />
            </Suspense>
          </div>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-7">{children}</main>
      </div>
      <Suspense fallback={null}>
        <Palette />
      </Suspense>
    </div>
  );
}
