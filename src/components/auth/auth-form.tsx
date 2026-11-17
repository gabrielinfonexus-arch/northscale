"use client";
import { useActionState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { FormState } from "@/server/auth-actions";

export interface Field {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  defaultValue?: string;
  readOnly?: boolean;
}

const input =
  "h-9 w-full rounded-md border border-border bg-surface px-2.5 text-[14px] outline-none focus:ring-2 focus:ring-ring read-only:bg-accent";

export function AuthForm({
  title,
  intro,
  fields,
  hidden = {},
  submit,
  action,
  footer,
}: {
  title: string;
  intro?: string;
  fields: Field[];
  hidden?: Record<string, string>;
  submit: string;
  action: (s: FormState, f: FormData) => Promise<FormState>;
  footer?: { href: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <Card className="p-6">
      <h1 className="text-[18px] font-semibold">{title}</h1>
      {intro && <p className="mt-1 text-[13px] text-muted">{intro}</p>}
      <form action={formAction} className="mt-5 flex flex-col gap-3.5">
        {Object.entries(hidden).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        {fields.map((f) => (
          <label key={f.name} className="flex flex-col gap-1.5 text-[13px] font-medium">
            {f.label}
            <input
              name={f.name}
              type={f.type ?? "text"}
              autoComplete={f.autoComplete}
              defaultValue={state?.values?.[f.name] ?? f.defaultValue}
              readOnly={f.readOnly}
              required={!f.readOnly && f.name !== "name"}
              className={input}
            />
          </label>
        ))}
        {state?.error && (
          <p role="alert" className="rounded-md bg-bad-bg px-3 py-2 text-[13px] text-bad">
            {state.error}
          </p>
        )}
        {state?.message && (
          <p role="status" className="rounded-md bg-accent px-3 py-2 text-[13px]">
            {state.message}
          </p>
        )}
        <Button type="submit" disabled={pending} className="h-9">
          {pending ? "…" : submit}
        </Button>
      </form>
      {footer && (
        <div className="mt-4 flex justify-between text-[12.5px] text-muted">
          {footer.map((l) => (
            <Link key={l.href} href={l.href} className="hover:text-foreground hover:underline">
              {l.label}
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
