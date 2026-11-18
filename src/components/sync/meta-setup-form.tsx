"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { field } from "@/components/admin/link-box";
import { saveMetaApp } from "@/server/actions";

/** The 3 values from the Meta app; saved encrypted, then straight to "Continue with Facebook". */
export function MetaSetupForm({ startHref, configured }: { startHref: string; configured: boolean }) {
  const [v, setV] = useState({ appId: "", secret: "", configId: "" });
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saved, setSaved] = useState(configured);
  const input = (k: keyof typeof v, label: string, hint: string, type = "text") => (
    <label className="flex flex-col gap-1 text-[13px]">
      <span className="font-medium">{label}</span>
      <input
        className={`${field} w-full font-mono`}
        type={type}
        autoComplete="off"
        value={v[k]}
        onChange={(e) => setV({ ...v, [k]: e.target.value })}
        aria-label={label}
      />
      <span className="text-[12px] text-subtle">{hint}</span>
    </label>
  );
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await saveMetaApp(v);
          if (!r.ok) return setMsg({ ok: false, text: r.error });
          setSaved(true);
          setV({ appId: "", secret: "", configId: "" });
          if (!r.warning) return window.location.assign(startHref); // keys verified: go to Facebook
          setMsg({ ok: true, text: r.warning });
        });
      }}
    >
      {input("appId", "App ID", "Meta app → App settings → Basic")}
      {input("secret", "App secret", "Same page → App secret → Show (stored encrypted)", "password")}
      {input("configId", "Configuration ID", "Facebook Login for Business → Configurations")}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !v.appId || !v.secret}>
          {pending ? "Checking with Meta…" : configured ? "Replace keys" : "Save"}
        </Button>
        {saved && (
          <Button asChild variant="default" className="bg-[#1877F2] hover:bg-[#1877F2]/90">
            <a href={startHref}>Continue with Facebook</a>
          </Button>
        )}
        {msg && (
          <span role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-[13px] text-good" : "text-[13px] text-bad"}>
            {msg.text}
          </span>
        )}
      </div>
    </form>
  );
}
