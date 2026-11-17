import type { Metadata } from "next";
import { AuthForm } from "@/components/auth/auth-form";
import { requestPasswordReset } from "@/server/auth-actions";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <AuthForm
      title="Reset your password"
      intro="We'll email you a link to choose a new password."
      fields={[{ name: "email", label: "Email", type: "email", autoComplete: "username" }]}
      submit="Send reset link"
      action={requestPasswordReset}
      footer={[{ href: "/login", label: "Back to sign in" }]}
    />
  );
}
