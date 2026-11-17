"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createResetLink, inviteTeamMember, revokeInvite, setMemberDisabled, updateMember } from "@/server/team-actions";
import { field, LinkBox } from "./link-box";

type Role = "OWNER" | "ADMIN" | "ANALYST" | "CLIENT_VIEWER";
interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  clientIds: string[];
  disabled: boolean;
  hasPassword: boolean;
  lastLoginAt: string | null;
}
interface Invite {
  id: string;
  email: string;
  role: Role | null;
  expiresAt: string;
  clientIds: string[];
}
interface Props {
  me: { id: string; role: Role };
  clients: { id: string; name: string }[];
  members: Member[];
  invites: Invite[];
}

const ROLE_LABEL: Record<Role, string> = { OWNER: "Owner", ADMIN: "Admin", ANALYST: "Analyst", CLIENT_VIEWER: "Client viewer" };
const ROLE_HELP: Record<string, string> = {
  OWNER: "Everything, including other Owners and Admins.",
  ADMIN: "Every client, team, viewers and billing (not Owners/Admins).",
  ANALYST: "Only the clients assigned to them; no team, billing or client management.",
};
const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

function ClientPicker({
  clients,
  value,
  onChange,
  label,
}: {
  clients: Props["clients"];
  value: string[];
  onChange: (v: string[]) => void;
  label: string;
}) {
  return (
    <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5" aria-label={label}>
      {clients.map((c) => (
        <label key={c.id} className="flex items-center gap-1.5 text-[12.5px]">
          <input
            type="checkbox"
            checked={value.includes(c.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))}
          />
          {c.name}
        </label>
      ))}
    </fieldset>
  );
}

function MemberRow({ m, p }: { m: Member; p: Props }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [role, setRole] = useState<Role>(m.role);
  const [clientIds, setClientIds] = useState(m.clientIds);
  const [msg, setMsg] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const isMe = m.userId === p.me.id;
  const ownerOnly = (r: Role) => r === "OWNER" || r === "ADMIN";
  const canManage = p.me.role === "OWNER" || !ownerOnly(m.role);
  const dirty = role !== m.role || clientIds.slice().sort().join() !== m.clientIds.slice().sort().join();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok?: string) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? (ok ?? null) : (r.error ?? "Failed"));
      router.refresh();
    });

  return (
    <li className={cn("flex flex-col gap-2 px-4 py-3", m.disabled && "opacity-60")} data-testid={`member-${m.email}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13.5px] font-medium">
            {m.name || m.email} {isMe && <span className="text-[12px] font-normal text-subtle">(you)</span>}
          </div>
          <div className="text-[12px] text-subtle">
            {m.email} · {m.disabled ? "disabled" : m.hasPassword ? `last sign-in ${fmt(m.lastLoginAt)}` : "no password yet"}
          </div>
        </div>
        <select
          className={field}
          value={role}
          disabled={!canManage || isMe || pending}
          onChange={(e) => setRole(e.target.value as Role)}
          aria-label={`Role of ${m.email}`}
        >
          {(["OWNER", "ADMIN", "ANALYST"] as Role[]).map((r) => (
            <option key={r} value={r} disabled={p.me.role !== "OWNER" && ownerOnly(r)}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {canManage && dirty && (
          <Button size="sm" disabled={pending} onClick={() => run(() => updateMember(m.userId, { role, clientIds }), "Saved.")}>
            Save
          </Button>
        )}
        {canManage && !isMe && (
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const r = await createResetLink(m.userId);
                  if (r.ok) setLink(r.url);
                  else setMsg(r.error);
                })
              }
            >
              Reset link
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setMemberDisabled(m.userId, !m.disabled))}>
              {m.disabled ? "Enable" : "Disable"}
            </Button>
          </>
        )}
      </div>
      {role === "ANALYST" && (
        <div className="rounded-md bg-accent/50 px-3 py-2">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-subtle">Clients this analyst sees</div>
          {canManage ? (
            <ClientPicker clients={p.clients} value={clientIds} onChange={setClientIds} label={`Clients of ${m.email}`} />
          ) : (
            <span className="text-[12.5px]">{m.clientIds.length} clients</span>
          )}
        </div>
      )}
      {msg && (
        <p role="status" className="text-[12px] text-muted">
          {msg}
        </p>
      )}
      {link && <LinkBox url={link} note="One-time password reset link (valid 24 h). Send it to them privately." />}
    </li>
  );
}

export function TeamManager(p: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("ANALYST");
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [result, setResult] = useState<{ url: string; note: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invite = () =>
    start(async () => {
      const r = await inviteTeamMember({ email, role: role as "ADMIN" | "ANALYST" | "OWNER", clientIds });
      if (!r.ok) return setError(r.error);
      setError(null);
      setResult({
        url: r.url,
        note: r.emailed
          ? `Invitation emailed to ${email}. You can also send this link (valid 7 days):`
          : `${r.emailError ?? "Email not sent."} Send this link to ${email} (valid 7 days):`,
      });
      setEmail("");
      setClientIds([]);
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-3 p-4">
        <h2 className="text-[14px] font-medium">Invite a teammate</h2>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            invite();
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
              aria-label="Invite email"
            />
          </label>
          <label className="flex flex-col gap-1 text-[12.5px]">
            Role
            <select className={field} value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Invite role">
              {(["ANALYST", "ADMIN", "OWNER"] as Role[])
                .filter((r) => p.me.role === "OWNER" || r === "ANALYST")
                .map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
            </select>
          </label>
          <Button type="submit" disabled={pending}>
            Create invitation
          </Button>
        </form>
        <p className="text-[12px] text-subtle">{ROLE_HELP[role]}</p>
        {role === "ANALYST" && (
          <ClientPicker clients={p.clients} value={clientIds} onChange={setClientIds} label="Clients for the new analyst" />
        )}
        {error && (
          <p role="alert" className="text-[12.5px] text-bad">
            {error}
          </p>
        )}
        {result && <LinkBox url={result.url} note={result.note} />}
      </Card>

      <section>
        <h2 className="mb-2 text-[14px] font-medium">Members</h2>
        <Card className="p-0">
          <ul className="divide-y divide-border">
            {p.members.map((m) => (
              <MemberRow key={`${m.userId}:${m.role}:${m.clientIds.join()}:${m.disabled}`} m={m} p={p} />
            ))}
          </ul>
        </Card>
      </section>

      {p.invites.length > 0 && (
        <section>
          <h2 className="mb-2 text-[14px] font-medium">Pending invitations</h2>
          <Card className="p-0">
            <ul className="divide-y divide-border text-[13px]">
              {p.invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-2.5" data-testid={`invite-${i.email}`}>
                  <span className="flex-1">
                    {i.email}{" "}
                    <span className="text-subtle">
                      · {i.role ? ROLE_LABEL[i.role] : ""} · expires {fmt(i.expiresAt)}
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
            </ul>
          </Card>
        </section>
      )}
    </div>
  );
}
