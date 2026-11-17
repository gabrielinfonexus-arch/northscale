import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { AuthForm } from "@/components/auth/auth-form";
import { Card } from "@/components/ui/card";
import { prisma } from "@/lib/db";
import { hashToken } from "@/lib/crypto";
import { acceptInvite } from "@/server/auth-actions";

export const metadata: Metadata = { title: "Accept invitation" };

const ROLE: Record<string, string> = { OWNER: "Owner", ADMIN: "Admin", ANALYST: "Analyst", CLIENT_VIEWER: "Client viewer (read-only)" };

async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  await connection();
  const t = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!t || t.kind !== "invite" || t.usedAt || t.expiresAt <= new Date())
    return (
      <Card className="p-6 text-[14px]">
        <h1 className="text-[18px] font-semibold">Invitation not valid</h1>
        <p className="mt-2 text-muted">This invitation has expired or was already used. Ask whoever invited you for a new link.</p>
      </Card>
    );
  const clients = t.clientIds.length ? await prisma.client.findMany({ where: { id: { in: t.clientIds } }, select: { name: true } }) : [];
  return (
    <AuthForm
      title="Join NorthScale"
      intro={`You're invited as ${ROLE[t.role ?? ""] ?? "member"}${clients.length ? ` for ${clients.map((c) => c.name).join(", ")}` : ""}. Choose a password to finish.`}
      fields={[
        { name: "email", label: "Email", type: "email", defaultValue: t.email, readOnly: true },
        { name: "name", label: "Your name", autoComplete: "name" },
        { name: "password", label: "Password", type: "password", autoComplete: "new-password" },
        { name: "confirm", label: "Repeat password", type: "password", autoComplete: "new-password" },
      ]}
      hidden={{ token }}
      submit="Create account"
      action={acceptInvite}
    />
  );
}

export default function InvitePage({ params }: PageProps<"/invite/[token]">) {
  return (
    <Suspense>
      <Invite params={params} />
    </Suspense>
  );
}
