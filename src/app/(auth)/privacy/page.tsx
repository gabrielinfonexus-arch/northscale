import type { Metadata } from "next";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = { title: "Privacy policy" };

/** Public page (Meta / Google / Shopify ask for a privacy policy URL when an app is published). */
export default function PrivacyPage() {
  return (
    <Card className="flex flex-col gap-3 p-6 text-[13.5px] leading-relaxed">
      <h1 className="text-[18px] font-semibold">Privacy policy</h1>
      <p>
        NorthScale is an internal reporting tool. When you connect an advertising account or store, NorthScale reads performance and order
        data (spend, impressions, clicks, conversions, revenue, orders, products) with <b>read-only</b> access, to show reports to the
        people you authorize. It never creates, changes or pauses ads, and never posts anything.
      </p>
      <p>
        Access tokens are stored encrypted (AES-256-GCM) and are never shown in the browser. Order data is stored without customer personal
        details other than an anonymous customer id used to tell new from returning customers.
      </p>
      <p>
        You can disconnect an account at any time (Clients → the client → Disconnect), which deletes its stored token; you can also remove
        NorthScale’s access in your Facebook / Google / Shopify settings. To have your data deleted, contact the administrator of this
        NorthScale workspace.
      </p>
    </Card>
  );
}
