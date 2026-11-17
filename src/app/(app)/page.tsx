import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ALL_NAV } from "@/lib/nav";
import { canSeePage } from "@/lib/permissions";
import { getCurrentUser } from "@/server/auth";

/** Home: the first page this user may open (Data for the team). */
async function Go(): Promise<null> {
  const user = await getCurrentUser();
  const first = ["/data", ...ALL_NAV.map((n) => n.href)].find((h) => canSeePage(user, h.slice(1)));
  redirect(first ?? "/forbidden");
  return null;
}

export default function Home() {
  return (
    <Suspense>
      <Go />
    </Suspense>
  );
}
