"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Command } from "cmdk";
import { Dialog as D } from "radix-ui";
import { ALL_NAV } from "@/lib/nav";
import { pickGlobalParams } from "@/lib/filters";

export interface PaletteClient {
  slug: string;
  name: string;
}

/** ⌘K / Ctrl+K: jump to any page or switch client. */
export function CommandPalette({ clients }: { clients: PaletteClient[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const sp = useSearchParams();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string, client?: string) => {
    const p = pickGlobalParams(new URLSearchParams(sp.toString()));
    if (client) {
      p.set("client", client);
      p.delete("accounts");
    }
    const path = href || window.location.pathname;
    router.push(p.toString() ? `${path}?${p}` : path);
    setOpen(false);
  };

  const item = "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-[13px] data-[selected=true]:bg-accent";
  const group =
    "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle";

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <D.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[18vh] z-50 w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <Command loop>
            <Command.Input
              autoFocus
              placeholder="Jump to a page or client…"
              className="h-11 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-subtle"
            />
            <Command.List className="max-h-[50vh] overflow-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-xs text-muted">Nothing found.</Command.Empty>
              <Command.Group heading="Pages" className={group}>
                {ALL_NAV.map((n) => (
                  <Command.Item key={n.href} value={`page ${n.label}`} onSelect={() => go(n.href)} className={item}>
                    {n.label}
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="Clients" className={group}>
                {clients.map((c) => (
                  <Command.Item key={c.slug} value={`client ${c.name}`} onSelect={() => go("", c.slug)} className={item}>
                    {c.name}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
