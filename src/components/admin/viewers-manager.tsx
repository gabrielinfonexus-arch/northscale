"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DEFAULT_VIEWER_PAGES, SHARE_FORBIDDEN_PAGES, VIEWER_PAGES } from "@/lib/permissions";
import { createShareLink, inviteViewer, removeViewerAccess, revokeInvite, revokeShareLink, updateViewerPages } from "@/server/team-actions";
import { field, LinkBox } from "./link-box";

interface Data {
  viewers: { userId: string; email: string; name: string | null; pages: string[]; disabled: boolean; lastLoginAt: string | null }[];
  invites: { id: string; email: string; pages: string[]; expiresAt: string }[];
  links: { id: string; label: string | null; pages: string[]; expiresAt: string | null; lastUsedAt: string | null; createdAt: string }[];
}

const LABEL = Object.fromEntries(VIEWER_PAGES.map((p) => [p.id, p.label]));
const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

function PagePicker({
  value,
  onChange,
  exclude = [],
  label,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  exclude?: string[];
  label: string;
}) {
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label={label}>
      {VIEWER_PAGES.filter((p) => !exclude.includes(p.id)).map((p) => (
        <label key={p.id} className="flex items-center gap-1.5 text-[12.5px]">
          <input
            type="checkbox"
            checked={value.includes(p.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))}
          />
          {p.label}
        </label>
      ))}
    </fieldset>
  );
}

function ViewerRow({ v, clientId }: { v: Data["viewers"][number]; clientId: string }) {
  const router = useRouter();
  const [pages, setPages] = useState(v.pages);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = pages.slice().sort().join() !== v.pages.slice().sort().join();
  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-testid={`viewer-${v.email}`}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">{v.name || v.email}</div>
          <div className="text-[12px] text-subtle">
            {v.email} · {v.disabled ? "disabled" : `last sign-in ${fmt(v.lastLoginAt)}`}
          </div>
        </div>
        {dirty && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await updateViewerPages(v.userId, clientId, pages);
                setMsg(r.ok ? "Saved." : r.error);
                router.refresh();
              })
            }
          >
            Save pages
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (!confirm(`Remove ${v.email}'s access to this client?`)) return;
            start(async () => {
              await removeViewerAccess(v.userId, clientId);
              router.refresh();
            });
          }}
        >
          Remove
        </Button>
      </div>
      <PagePicker value={pages} onChange={setPages} label={`Pages for ${v.email}`} />
      {msg && (
        <p role="status" className="text-[12px] text-muted">
          {msg}
        </p>
      )}
    </li>
  );
}

export function ViewersManager({ clientId, clientName, data }: { clientId: string; clientName: string; data: Data }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [pages, setPages] = useState<string[]>(DEFAULT_VIEWER_PAGES);
  const [invited, setInvited] = useState<{ url: string | null; note: string } | null>(null);
  const [linkPages, setLinkPages] = useState<string[]>(DEFAULT_VIEWER_PAGES);
  const [label, setLabel] = useState("");
  const [days, setDays] = useState(30);
  const [shared, setShared] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[14px] font-medium">Invite someone from {clientName}</h2>
        <p className="text-[12.5px] text-muted">
          Read-only: they only see {clientName} and the pages you choose. Internal costs (P&L → Costs), Watchdog rules and settings are
          never shown.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await inviteViewer({ clientId, email, pages });
              if (!r.ok) return setError(r.error);
              setError(null);
              setInvited(
                r.added
                  ? { url: null, note: `${email} already has an account: access to ${clientName} added.` }
                  : {
                      url: r.url,
                      note: r.emailed
                        ? `Invitation emailed to ${email}. You can also send this link (valid 7 days):`
                        : `${r.emailError ?? "Email not sent."} Send this link to ${email} (valid 7 days):`,
                    },
              );
              setEmail("");
              router.refresh();
            });
          }}
        >
          <label className="flex flex-col gap-1 text-[12.5px]">
            Email
            <input
              className={`${field} w-64`}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Viewer email"
            />
          </label>
          <Button type="submit" disabled={pending || !pages.length}>
            Invite viewer
          </Button>
        </form>
        <PagePicker value={pages} onChange={setPages} label="Pages for the new viewer" />
        {error && (
          <p role="alert" className="text-[12.5px] text-bad">
            {error}
          </p>
        )}
        {invited &&
          (invited.url ? (
            <LinkBox url={invited.url} note={invited.note} />
          ) : (
            <p role="status" className="text-[12.5px] text-muted">
              {invited.note}
            </p>
          ))}
      </Card>

      <section>
        <h2 className="mb-2 text-[14px] font-medium">Viewers</h2>
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {data.viewers.map((v) => (
              <ViewerRow key={`${v.userId}:${v.pages.join()}`} v={v} clientId={clientId} />
            ))}
            {data.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                <span className="flex-1">
                  {i.email}{" "}
                  <span className="text-subtle">
                    · invited · {i.pages.map((x) => LABEL[x]).join(", ")} · expires {fmt(i.expiresAt)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await revokeInvite(i.id);
                      router.refresh();
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
            {!data.viewers.length && !data.invites.length && <li className="px-4 py-3 text-[13px] text-muted">No viewers yet.</li>}
          </ul>
        </Card>
      </section>

      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[14px] font-medium">Public link</h2>
        <p className="text-[12.5px] text-muted">
          Anyone with the link can open the chosen pages of {clientName}, read-only, until it expires or you revoke it. Hive-Mind is never
          available on public links.
        </p>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const r = await createShareLink({ clientId, label, pages: linkPages, days });
              if (!r.ok) return setError(r.error);
              setError(null);
              setShared(r.url);
              setLabel("");
              router.refresh();
            });
          }}
        >
          <label className="flex flex-col gap-1 text-[12.5px]">
            Label (optional)
            <input
              className={`${field} w-56`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Monthly review"
              aria-label="Link label"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px]">
            Expires in
            <select className={field} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Expires in">
              {[1, 7, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? "day" : "days"}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" disabled={pending || !linkPages.length}>
            Create link
          </Button>
        </form>
        <PagePicker value={linkPages} onChange={setLinkPages} exclude={SHARE_FORBIDDEN_PAGES} label="Pages on the public link" />
        {shared && <LinkBox url={shared} note="Shown once — copy it now. Only a hash is stored." />}
        {data.links.length > 0 && (
          <ul className="divide-y divide-border rounded-md border border-border text-[13px]">
            {data.links.map((l) => (
              <li key={l.id} className="flex items-center gap-3 px-3 py-2" data-testid="share-link">
                <span className="flex-1">
                  {l.label || "Public link"}{" "}
                  <span className="text-subtle">
                    · {l.pages.map((x) => LABEL[x]).join(", ")} · expires {fmt(l.expiresAt)} · last opened {fmt(l.lastUsedAt)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      await revokeShareLink(l.id);
                      router.refresh();
                    })
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
