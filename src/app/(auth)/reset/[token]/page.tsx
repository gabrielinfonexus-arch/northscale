import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { resetPassword } from "@/server/auth-actions";

export const metadata: Metadata = { title: "Choose a new password" };

async function Form({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthForm
      title="Choose a new password"
      intro="At least 10 characters. You'll be signed out on every other device."
      fields={[
        { name: "password", label: "New password", type: "password", autoComplete: "new-password" },
        { name: "confirm", label: "Repeat password", type: "password", autoComplete: "new-password" },
      ]}
      hidden={{ token }}
      submit="Save and sign in"
      action={resetPassword}
    />
  );
}

export default function ResetPage({ params }: PageProps<"/reset/[token]">) {
  return (
    <Suspense>
      <Form params={params} />
    </Suspense>
  );
}
