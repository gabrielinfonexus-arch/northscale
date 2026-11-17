import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthForm } from "@/components/auth/auth-form";
import { login } from "@/server/auth-actions";

export const metadata: Metadata = { title: "Sign in" };

async function LoginForm({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";
  return (
    <AuthForm
      title="Sign in"
      fields={[
        { name: "email", label: "Email", type: "email", autoComplete: "username" },
        { name: "password", label: "Password", type: "password", autoComplete: "current-password" },
      ]}
      hidden={{ next }}
      submit="Sign in"
      action={login}
      footer={[{ href: "/forgot", label: "Forgot password?" }]}
    />
  );
}

export default function LoginPage({ searchParams }: PageProps<"/login">) {
  return (
    <Suspense>
      <LoginForm searchParams={searchParams} />
    </Suspense>
  );
}
