import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { PageTitle } from "@/components/shell/page-header";
import { Card } from "@/components/ui/card";
import { LinkBox } from "@/components/admin/link-box";
import { MetaSetupForm } from "@/components/sync/meta-setup-form";
import { requirePage } from "@/server/auth";
import { getMetaAppConfig } from "@/server/meta-app";

export const metadata: Metadata = { title: "Set up Facebook login" };

async function Content({
  params,
  searchParams,
}: {
  params: Promise<{ platform: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ platform }, sp] = await Promise.all([params, searchParams]);
  if (platform !== "meta") notFound();
  const user = await requirePage("connect");
  const h = await headers();
  const origin = (
    process.env.APP_URL || `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`
  ).replace(/\/$/, "");
  const host = new URL(origin).host;
  const clientId = typeof sp.client === "string" ? sp.client : "";
  const startHref = clientId ? `/api/connect/meta/start?client=${encodeURIComponent(clientId)}` : "/sync-status";
  const cfg = await getMetaAppConfig();
  const admin = user.role === "OWNER" || user.role === "ADMIN";

  const steps: { title: string; body: React.ReactNode }[] = [
    {
      title: "Create the app (once)",
      body: (
        <>
          Open{" "}
          <a className="text-primary underline" href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noreferrer">
            developers.facebook.com → Create App
          </a>
          . Use case <b>Other</b> → type <b>Business</b> → name it (e.g. NorthScale) → Create app.
        </>
      ),
    },
    {
      title: "App settings → Basic",
      body: (
        <div className="flex flex-col gap-2">
          <span>
            In <b>App domains</b> paste this, then <b>Save changes</b>. Keep this tab open: you’ll copy the App ID and App secret from here
            in step 6.
          </span>
          <LinkBox url={host} />
          <span>
            If Meta asks for a <b>Privacy policy URL</b>:
          </span>
          <LinkBox url={`${origin}/privacy`} />
        </div>
      ),
    },
    {
      title: "Add products",
      body: (
        <>
          In the app dashboard, add <b>Marketing API</b> and <b>Facebook Login for Business</b> (Set up on each).
        </>
      ),
    },
    {
      title: "Facebook Login for Business → Settings",
      body: (
        <div className="flex flex-col gap-2">
          <span>
            In <b>Valid OAuth Redirect URIs</b> paste this, then <b>Save changes</b>:
          </span>
          <LinkBox url={`${origin}/api/connect/meta/callback`} />
        </div>
      ),
    },
    {
      title: "Facebook Login for Business → Configurations → Create",
      body: (
        <>
          Name <b>NorthScale</b> · Login variation <b>General</b> · Access token <b>User access token</b> · Assets: <b>Ad accounts</b> and{" "}
          <b>Pages</b> · Permissions: <b>ads_read, business_management, pages_show_list</b> (+ leads_retrieval for lead forms) → Create →
          copy the <b>Configuration ID</b>.
        </>
      ),
    },
    {
      title: "Paste the 3 values below",
      body: <>NorthScale checks them with Meta and stores the secret encrypted. Then click Continue with Facebook.</>,
    },
  ];

  return (
    <div className="flex max-w-3xl flex-col gap-5">
      <p className="text-[13.5px] text-muted">
        “Continue with Facebook” works like Zapier: you sign in to Facebook, pick the business, ad accounts and pages, and authorize
        read-only access. Other tools you already connected keep working. Meta requires every service to have its own <b>Meta app</b>,
        created once in your Facebook account — that part can only be done by you, the rest is ready here.
      </p>
      {cfg ? (
        <Card className="flex flex-wrap items-center gap-3 p-4 text-[13.5px]" data-testid="meta-configured">
          <CheckCircle2 className="size-5 text-good" aria-hidden />
          <span className="flex-1">
            Facebook login is set up (app {cfg.appId}
            {cfg.source === "env" ? ", from the server environment" : ""}
            {cfg.configId ? "" : " — add a Configuration ID for the account & page picker"}).
          </span>
          <a href={startHref} className="rounded-md bg-[#1877F2] px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90">
            Continue with Facebook
          </a>
        </Card>
      ) : null}
      {admin ? (
        <>
          <ol className="flex flex-col gap-3">
            {steps.map((s, i) => (
              <li key={s.title}>
                <Card className="flex gap-3 p-4 text-[13.5px]">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[12px] font-semibold">
                    {i + 1}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="font-medium">{s.title}</div>
                    <div className="text-muted">{s.body}</div>
                  </div>
                </Card>
              </li>
            ))}
          </ol>
          {cfg?.source !== "env" && (
            <Card className="p-4">
              <MetaSetupForm startHref={startHref} configured={!!cfg} />
            </Card>
          )}
          <p className="text-[12.5px] text-subtle">
            While the Meta app is in Development mode, only you (and people you add as app admins / testers) can authorize — enough to read
            every ad account you have access to. For clients to authorize their own accounts, Meta requires App Review (Advanced access for
            ads_read) and Business Verification.
          </p>
        </>
      ) : (
        !cfg && <Card className="p-4 text-[13.5px]">Facebook login isn’t set up yet. Ask an Owner or Admin to open this page.</Card>
      )}
    </div>
  );
}

export default function MetaSetupPage({ params, searchParams }: PageProps<"/connect/[platform]/setup">) {
  return (
    <>
      <PageTitle title="Connect Meta with Facebook login" />
      <Suspense>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}
