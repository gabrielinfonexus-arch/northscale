"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CalendarRange, Link2, Plus, RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PlatformDot, PLATFORM_LABEL } from "@/components/shell/platform";
import { addShopifyCredential, addTokenCredential, resyncRange, syncNow } from "@/server/sync-actions";
import type { ConnectionStatusRow } from "@/server/sync-status";
import { cn } from "@/lib/utils";

const STATUS: Record<string, { label: string; cls: string }> = {
  OK: { label: "OK", cls: "bg-good-bg text-good" },
  SYNCING: { label: "Syncing", cls: "bg-accent text-primary" },
  ERROR: { label: "Error", cls: "bg-bad-bg text-bad" },
  TOKEN_EXPIRED: { label: "Token expired", cls: "bg-bad-bg text-bad" },
  DISCONNECTED: { label: "Disconnected", cls: "bg-accent text-muted" },
};

export function relTime(iso: string | null, now: number): string {
  if (!iso) return "—";
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 3_600_000
      ? [Math.round(abs / 60_000), "min"]
      : abs < 86_400_000
        ? [Math.round(abs / 3_600_000), "h"]
        : [Math.round(abs / 86_400_000), "d"];
  return diff < 0 ? `${unit[0]} ${unit[1]} ago` : `in ${unit[0]} ${unit[1]}`;
}

export function SyncStatusTable({
  rows,
  currentClient,
  now,
}: {
  rows: ConnectionStatusRow[];
  currentClient: { id: string; name: string; slug: string } | null;
  now: number;
}) {
  const router = useRouter();
  const [onlyClient, setOnlyClient] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [shopifyOpen, setShopifyOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const running = rows.some((r) => r.status === "SYNCING" || r.lastJob?.status === "RUNNING" || r.lastJob?.status === "QUEUED");

  // live refresh while something is running
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [running, router]);

  const shown = onlyClient && currentClient ? rows.filter((r) => r.clientId === currentClient.id) : rows;
  const act = (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    start(async () => {
      await fn();
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {currentClient && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" checked={onlyClient} onChange={(e) => setOnlyClient(e.target.checked)} />
            Only {currentClient.name}
          </label>
        )}
        {running && (
          <span className="flex items-center gap-1.5 text-xs text-primary">
            <RefreshCw className="size-3 animate-spin" /> Sync running — refreshing
          </span>
        )}
        {currentClient && (
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setShopifyOpen(true)} data-testid="connect-shopify">
              <Plus /> Connect Shopify
            </Button>
            <Button size="sm" variant="outline" onClick={() => setGoogleOpen(true)} data-testid="connect-google">
              <Plus /> Connect Google Ads
            </Button>
            <Button size="sm" onClick={() => setConnectOpen(true)} data-testid="connect-meta">
              <Plus /> Connect Meta
            </Button>
          </div>
        )}
      </div>
      <Card className="overflow-hidden">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[1000px] border-separate border-spacing-0 text-[13px]" data-testid="sync-status-table">
            <thead>
              <tr className="text-[10.5px] uppercase tracking-wide text-subtle">
                {["Account", "Client", "Status", "Last success", "Next sync", "Rows (last job)", "Message", ""].map((h, i) => (
                  <th key={i} className={cn("border-b border-border px-3 py-2.5 text-left font-medium", i === 5 && "text-right")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const st = STATUS[r.status] ?? STATUS.ERROR;
                const expiresSoon = r.tokenExpiresAt && Date.parse(r.tokenExpiresAt) - now < 7 * 86_400_000;
                const progress =
                  r.lastJob && (r.lastJob.status === "RUNNING" || r.lastJob.status === "QUEUED") ? (r.lastJob.progress ?? 0) : null;
                return (
                  <tr key={r.id} className="align-top hover:bg-accent/50" data-testid={`conn-${r.externalId}`} data-conn-id={r.id}>
                    <td className="border-b border-border px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <PlatformDot platform={r.platform} />
                        <div className="min-w-0">
                          <div className="font-medium">{r.name}</div>
                          <div className="text-[11.5px] text-muted">
                            {PLATFORM_LABEL[r.platform]} · {r.externalId}
                            {r.isDemo ? " · demo" : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="border-b border-border px-3 py-2.5">{r.clientName}</td>
                    <td className="border-b border-border px-3 py-2.5">
                      <span
                        className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", st.cls)}
                        data-testid="conn-status"
                      >
                        {st.label}
                      </span>
                      {progress !== null && (
                        <div
                          className="mt-1.5 h-1 w-24 rounded-full bg-accent"
                          role="progressbar"
                          aria-valuenow={Math.round(progress * 100)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(4, progress * 100)}%` }} />
                        </div>
                      )}
                    </td>
                    <td className="border-b border-border px-3 py-2.5 text-muted" title={r.lastSuccessAt ?? undefined}>
                      {relTime(r.lastSuccessAt, now)}
                    </td>
                    <td className="border-b border-border px-3 py-2.5 text-muted">
                      {r.status === "TOKEN_EXPIRED" ? "—" : relTime(r.nextSyncAt, now)}
                    </td>
                    <td className="num border-b border-border px-3 py-2.5 text-right">
                      {r.lastJob ? r.lastJob.rows.toLocaleString("en-US") : "—"}
                    </td>
                    <td className="max-w-[320px] border-b border-border px-3 py-2.5 text-[12px]">
                      {r.lastError ? (
                        <span className={r.status === "OK" ? "text-warn" : "text-bad"}>{r.lastError}</span>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                      {expiresSoon && (
                        <div className="mt-1 flex items-center gap-1 text-warn">
                          <AlertTriangle className="size-3" /> Token expires {relTime(r.tokenExpiresAt, now)}
                        </div>
                      )}
                      {r.account && typeof r.account.accountStatus === "string" && r.account.accountStatus !== "Active" && (
                        <div className="mt-1 text-bad">Account: {String(r.account.accountStatus)}</div>
                      )}
                    </td>
                    <td className="border-b border-border px-3 py-2.5">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === r.id}
                          onClick={() => act(r.id, () => syncNow(r.id))}
                          aria-label={`Sync ${r.name} now`}
                        >
                          <RefreshCw className={cn(busy === r.id && "animate-spin")} /> Sync now
                        </Button>
                        <ResyncPopover now={now} onSubmit={(from, to) => act(r.id, () => resyncRange(r.id, from, to))} />
                        {(r.platform === "META" || r.platform === "GOOGLE") && !r.isDemo && (
                          <Button variant="ghost" size="sm" asChild>
                            <a href={`/api/connect/${r.platform === "META" ? "meta" : "google"}/start?client=${r.clientId}`}>
                              <Link2 /> Reconnect
                            </a>
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-3 py-12 text-center text-muted">
                    No connections yet. Connect Meta, Google Ads or a Shopify store to start syncing.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      {currentClient && <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} client={currentClient} />}
      {currentClient && <GoogleConnectDialog open={googleOpen} onOpenChange={setGoogleOpen} client={currentClient} />}
      {currentClient && <ShopifyConnectDialog open={shopifyOpen} onOpenChange={setShopifyOpen} client={currentClient} />}
    </>
  );
}

function ResyncPopover({ now, onSubmit }: { now: number; onSubmit: (from: string, to: string) => void }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Re-sync a period">
          <CalendarRange /> Re-sync
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <div className="flex flex-col gap-2 text-xs text-muted">
          <span className="font-medium text-foreground">Re-sync a period</span>
          <label className="flex flex-col gap-1">
            From
            <input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 rounded-md border border-border bg-surface px-2 text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1">
            To
            <input
              type="date"
              value={to}
              min={from}
              max={today}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 rounded-md border border-border bg-surface px-2 text-foreground"
            />
          </label>
          <Button
            size="sm"
            onClick={() => {
              onSubmit(from, to);
              setOpen(false);
            }}
          >
            Queue re-sync
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ConnectDialog({
  open,
  onOpenChange,
  client,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  client: { id: string; name: string; slug: string };
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const submitToken = () =>
    start(async () => {
      setError(null);
      const r = await addTokenCredential({ clientId: client.id, platform: "meta", token });
      if (!r.ok) return setError(r.error);
      router.push(`/connect/meta?credential=${r.credentialId}&client=${client.slug}`);
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-base font-semibold">Connect Meta to {client.name}</DialogTitle>
        <DialogDescription className="mb-3 text-xs text-muted">
          Read-only access (ads_read). NorthScale never changes anything in your ad accounts. Tokens are stored encrypted.
        </DialogDescription>
        <div className="flex flex-col gap-4">
          <a
            href={`/api/connect/meta/start?client=${client.id}`}
            className="flex items-center justify-center gap-2 rounded-lg bg-[#1877f2] px-4 py-2.5 text-[13.5px] font-medium text-white hover:opacity-90"
            data-testid="facebook-login"
          >
            Continue with Facebook
          </a>
          <div className="flex items-center gap-3 text-[11px] uppercase tracking-wide text-subtle">
            <span className="h-px flex-1 bg-border" /> or a System User token <span className="h-px flex-1 bg-border" />
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Business Manager → Users → System users → Generate token (permission: ads_read)
            <textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              rows={3}
              autoComplete="off"
              spellCheck={false}
              className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring"
              placeholder="EAAB…"
              aria-label="System user token"
            />
          </label>
          {error && <p className="text-xs text-bad">{error}</p>}
          <Button onClick={submitToken} disabled={pending || token.trim().length < 20} data-testid="submit-token">
            {pending ? "Checking token…" : "Use this token"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GoogleConnectDialog({
  open,
  onOpenChange,
  client,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  client: { id: string; name: string };
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-base font-semibold">Connect Google Ads to {client.name}</DialogTitle>
        <DialogDescription className="mb-3 text-xs text-muted">
          Read-only reporting through the Google Ads API. Sign in with a Google account that has access to the ad accounts or to their
          manager account (MCC); you will pick the accounts next. The refresh token is stored encrypted.
        </DialogDescription>
        <a
          href={`/api/connect/google/start?client=${client.id}`}
          className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-[13.5px] font-medium hover:bg-accent"
          data-testid="google-login"
        >
          <span className="text-[15px] font-bold text-[#4285f4]">G</span> Continue with Google
        </a>
      </DialogContent>
    </Dialog>
  );
}

function ShopifyConnectDialog({
  open,
  onOpenChange,
  client,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  client: { id: string; name: string; slug: string };
}) {
  const router = useRouter();
  const [shop, setShop] = useState("");
  const [mode, setMode] = useState<"token" | "app" | "oauth">("token");
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const field =
    "h-8 rounded-md border border-border bg-surface px-2 font-mono text-[12px] text-foreground outline-none focus:ring-2 focus:ring-ring";
  const submit = () =>
    start(async () => {
      setError(null);
      const r = await addShopifyCredential({
        clientId: client.id,
        shop,
        ...(mode === "token" ? { accessToken: token } : { appClientId: appId, appClientSecret: appSecret }),
      });
      if (!r.ok) return setError(r.error);
      router.push(`/connect/shopify?credential=${r.credentialId}&client=${client.slug}`);
    });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="text-base font-semibold">Connect a Shopify store to {client.name}</DialogTitle>
        <DialogDescription className="mb-3 text-xs text-muted">
          Read-only access to orders, products and inventory costs (read_orders, read_all_orders, read_products, read_inventory).
          Credentials are stored encrypted.
        </DialogDescription>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted">
            Store domain
            <input
              value={shop}
              onChange={(e) => setShop(e.target.value)}
              placeholder="brand.myshopify.com"
              className={field}
              aria-label="Store domain"
              autoComplete="off"
            />
          </label>
          <div role="tablist" className="flex gap-1 rounded-lg bg-accent p-0.5 text-xs">
            {(
              [
                ["token", "Access token"],
                ["app", "App client ID + secret"],
                ["oauth", "Install via OAuth"],
              ] as const
            ).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cn("flex-1 rounded-md px-2 py-1", mode === m ? "bg-surface font-medium shadow-sm" : "text-muted")}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "token" && (
            <label className="flex flex-col gap-1 text-xs text-muted">
              Admin API access token of an existing custom app (starts with shpat_)
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className={field}
                placeholder="shpat_…"
                aria-label="Admin API access token"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
          )}
          {mode === "app" && (
            <>
              <p className="text-[11.5px] text-muted">
                Dev Dashboard app installed on this store (your own organization). NorthScale requests a fresh token on every sync.
              </p>
              <input
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                className={field}
                placeholder="Client ID"
                aria-label="App client ID"
                autoComplete="off"
                spellCheck={false}
              />
              <input
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                className={field}
                placeholder="Client secret"
                aria-label="App client secret"
                type="password"
                autoComplete="off"
              />
            </>
          )}
          {mode === "oauth" ? (
            <a
              href={`/api/connect/shopify/start?client=${client.id}&shop=${encodeURIComponent(shop)}`}
              aria-disabled={shop.length < 3}
              className={cn(
                "flex items-center justify-center rounded-lg bg-[#5e8e3e] px-4 py-2.5 text-[13.5px] font-medium text-white hover:opacity-90",
                shop.length < 3 && "pointer-events-none opacity-50",
              )}
              data-testid="shopify-oauth"
            >
              Install NorthScale on the store
            </a>
          ) : (
            <Button onClick={submit} disabled={pending || shop.length < 3} data-testid="submit-shopify">
              {pending ? "Checking…" : "Connect store"}
            </Button>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
