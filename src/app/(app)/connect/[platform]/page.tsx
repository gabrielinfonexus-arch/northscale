import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { EmptyState } from "@/components/shell/empty-state";
import { AccountPicker } from "@/components/sync/account-picker";
import { Skeleton } from "@/components/ui/skeleton";
import { prisma } from "@/lib/db";
import { getPageContext } from "@/server/page-context";
import { accountsForCredential, PLATFORM_SLUG } from "@/server/connect";

export const metadata: Metadata = { title: "Connect accounts" };

async function Picker({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ platform }, ctx] = await Promise.all([params, getPageContext(searchParams, "connect")]);
  const credentialId = typeof ctx.sp.credential === "string" ? ctx.sp.credential : "";
  const name = { meta: "Meta", google: "Google Ads", shopify: "Shopify" }[platform] ?? platform;
  if (!PLATFORM_SLUG[platform] || !ctx.client || !credentialId)
    return <EmptyState title="Nothing to connect">Start from Sync Status → Connect.</EmptyState>;
  let result: Awaited<ReturnType<typeof accountsForCredential>> | null = null;
  let error: string | null = null;
  try {
    result = await accountsForCredential(credentialId, ctx.user.organizationId);
  } catch (e) {
    error = (e as Error).message;
  }
  if (!result)
    return (
      <EmptyState
        title={`Could not list ${name} accounts`}
        action={
          <Link className="text-primary underline" href="/sync-status">
            Back to Sync Status
          </Link>
        }
      >
        {error}
      </EmptyState>
    );
  const { credential, accounts } = result;
  const linked = await prisma.connection.findMany({
    where: { clientId: ctx.client.id, platform: credential.platform },
    select: { externalId: true },
  });
  return (
    <>
      <p className="mb-3 text-[13px] text-muted">
        Signed in as <b className="text-foreground">{credential.label}</b>
        {credential.tokenExpiresAt
          ? ` · token valid until ${credential.tokenExpiresAt.toISOString().slice(0, 10)}`
          : " · token does not expire"}
      </p>
      <AccountPicker
        credentialId={credential.id}
        clientId={ctx.client.id}
        clientSlug={ctx.client.slug}
        clientName={ctx.client.name}
        accounts={accounts}
        linked={linked.map((l) => l.externalId)}
      />
    </>
  );
}

export default function ConnectPage({ params, searchParams }: PageProps<"/connect/[platform]">) {
  return (
    <>
      <PageTitle title="Connect accounts" />
      <Suspense fallback={<Skeleton className="h-72 w-full rounded-xl" />}>
        <Picker params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}
