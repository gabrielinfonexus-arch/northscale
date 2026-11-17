import type { Metadata } from "next";
import { Suspense } from "react";
import { PageTitle } from "@/components/shell/page-header";
import { ClientForm, NEW_CLIENT } from "@/components/admin/client-form";
import { requirePage } from "@/server/auth";

export const metadata: Metadata = { title: "New client" };

async function Content() {
  await requirePage("clients");
  return (
    <>
      <ol className="mb-5 flex flex-wrap gap-2 text-[12.5px]" aria-label="Onboarding steps">
        {["1. Brand & economics", "2. Connect accounts", "3. Targets", "4. Client access"].map((s, i) => (
          <li
            key={s}
            className={i === 0 ? "rounded-full bg-primary px-3 py-1 text-primary-fg" : "rounded-full bg-accent px-3 py-1 text-muted"}
          >
            {s}
          </li>
        ))}
      </ol>
      <ClientForm initial={NEW_CLIENT} mode="create" />
    </>
  );
}

export default function NewClientPage() {
  return (
    <>
      <PageTitle title="New client" />
      <Suspense>
        <Content />
      </Suspense>
    </>
  );
}
