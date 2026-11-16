"use client";
import { useMemo, useState } from "react";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { useUrlState } from "@/components/filters/use-url-state";
import type { ClientSummary } from "@/server/clients";
import { PLATFORM_LABEL, PlatformDot } from "./platform";
import { cn } from "@/lib/utils";

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-fg">
      {name.slice(0, 1)}
    </span>
  );
}

export function ClientSwitcher({ clients, currentId }: { clients: ClientSummary[]; currentId: string | null }) {
  const { sp, set } = useUrlState();
  const [open, setOpen] = useState(false);
  const current = clients.find((c) => c.id === currentId) ?? null;
  const selected = useMemo(() => new Set((sp.get("accounts") ?? "").split(",").filter(Boolean)), [sp]);
  const nAccounts = current?.connections.length ?? 0;
  const nSelected = selected.size || nAccounts;

  const toggleAccount = (id: string) => {
    if (!current) return;
    const all = current.connections.map((c) => c.id);
    const base = selected.size ? new Set(selected) : new Set(all);
    if (base.has(id)) base.delete(id);
    else base.add(id);
    const next = all.filter((x) => base.has(x));
    set({ accounts: next.length === all.length || next.length === 0 ? null : next.join(",") });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="client-switcher"
          className="flex h-8 max-w-[300px] items-center gap-2 whitespace-nowrap rounded-md border border-border bg-surface px-2 text-[13px] hover:bg-accent"
        >
          {current ? <Avatar name={current.name} /> : null}
          <span className="truncate font-medium">{current?.name ?? "Select client"}</span>
          {current && (
            <span className="hidden text-xs text-muted sm:inline">
              {nSelected === nAccounts ? `${nAccounts} accounts` : `${nSelected}/${nAccounts}`}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0">
        <Command loop className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-border px-3">
            <Search className="size-3.5 text-muted" />
            <Command.Input
              placeholder="Search clients or accounts…"
              className="h-9 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle"
            />
          </div>
          <Command.List className="max-h-[360px] overflow-auto p-1">
            <Command.Empty className="px-3 py-6 text-center text-xs text-muted">No match.</Command.Empty>
            <Command.Group
              heading="Clients"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-subtle"
            >
              {clients.map((c) => (
                <Command.Item
                  key={c.id}
                  value={`${c.name} ${c.connections.map((x) => x.name).join(" ")}`}
                  onSelect={() => {
                    set({ client: c.slug, accounts: null });
                    setOpen(false);
                  }}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] data-[selected=true]:bg-accent"
                >
                  <Avatar name={c.name} />
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="text-[11px] text-muted">{c.currency}</span>
                  {c.isDemo && <span className="rounded bg-accent px-1 text-[10px] text-muted">demo</span>}
                  <Check className={cn("size-3.5", c.id === currentId ? "opacity-100" : "opacity-0")} />
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
          {current && current.connections.length > 0 && (
            <div className="border-t border-border p-2">
              <div className="flex items-center justify-between px-1 pb-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-subtle">Accounts in {current.name}</span>
                {selected.size > 0 && (
                  <button type="button" className="text-[11px] text-muted hover:text-foreground" onClick={() => set({ accounts: null })}>
                    Select all
                  </button>
                )}
              </div>
              <ul className="max-h-48 overflow-auto">
                {current.connections.map((conn) => (
                  <li key={conn.id}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-[12.5px] hover:bg-accent">
                      <Checkbox checked={selected.size === 0 || selected.has(conn.id)} onCheckedChange={() => toggleAccount(conn.id)} />
                      <PlatformDot platform={conn.platform} />
                      <span className="flex-1 truncate">{conn.name}</span>
                      <span className="text-[10px] text-muted">
                        {PLATFORM_LABEL[conn.platform]}
                        {conn.currency !== current.currency ? ` · ${conn.currency}` : ""}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Resolves the current client from ?client= (fallback: first client, same rule as the server). */
export function ClientSwitcherFromUrl({ clients }: { clients: ClientSummary[] }) {
  const { sp } = useUrlState();
  const slug = sp.get("client");
  const current = clients.find((c) => c.slug === slug) ?? clients[0] ?? null;
  return <ClientSwitcher clients={clients} currentId={current?.id ?? null} />;
}
