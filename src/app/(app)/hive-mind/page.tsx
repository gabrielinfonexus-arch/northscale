import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { PageTitle } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { HiveMind } from "@/components/ai/hive-mind";
import { prisma } from "@/lib/db";
import { toTurns } from "@/lib/ai-display";
import { getCurrentUser } from "@/server/auth";
import { listClients } from "@/server/clients";
import { AI_MODEL, AI_MODEL_HEAVY, aiConfigured, aiMockEnabled } from "@/server/ai/config";
import { SUGGESTIONS } from "@/server/ai/prompt";

export const metadata: Metadata = { title: "Hive-Mind" };

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function when(d: Date) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    d,
  );
}

async function Content({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  await connection();
  const [user, clients] = await Promise.all([getCurrentUser(), listClients()]);
  const conversations = await prisma.aiConversation.findMany({
    where: { userId: user.id },
    orderBy: { updatedAt: "desc" },
    take: 60,
    select: { id: true, title: true, updatedAt: true },
  });
  const cId = str(sp.new) ? null : str(sp.c);
  const conv = cId
    ? await prisma.aiConversation.findFirst({
        where: { id: cId, userId: user.id },
        include: { messages: { orderBy: { createdAt: "asc" } } },
      })
    : null;
  const urlClient = clients.find((c) => c.slug === str(sp.client));
  const scope = (conv?.scope ?? {}) as { clientIds?: string[] };
  return (
    <HiveMind
      key={conv?.id ?? `new-${str(sp.new) ?? ""}`}
      conversations={conversations.map((c) => ({ id: c.id, title: c.title, when: when(c.updatedAt) }))}
      active={conv ? { id: conv.id, clientIds: scope.clientIds ?? [], heavy: conv.heavy, turns: toTurns(conv.messages) } : null}
      clients={clients.map((c) => ({ id: c.id, name: c.name }))}
      defaultClientIds={urlClient ? [urlClient.id] : []}
      suggestions={SUGGESTIONS}
      configured={aiConfigured()}
      mock={aiMockEnabled()}
      models={{ standard: AI_MODEL, heavy: AI_MODEL_HEAVY }}
    />
  );
}

export default function HiveMindPage({ searchParams }: PageProps<"/hive-mind">) {
  return (
    <>
      <PageTitle title="Hive-Mind" />
      <Suspense fallback={<Skeleton className="h-[70vh] w-full rounded-xl" />}>
        <Content searchParams={searchParams} />
      </Suspense>
    </>
  );
}
