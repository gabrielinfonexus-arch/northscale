"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ParamSpec } from "@/lib/watchdog/rules";
import { resetRule, saveRule } from "@/server/watchdog-actions";

export interface RuleSetting {
  key: string;
  label: string;
  description: string;
  params: ParamSpec[];
  enabled: boolean;
  values: Record<string, number>;
  notifyEmail: boolean;
  notifySlack: boolean;
  customized: boolean;
}

const UNIT: Record<ParamSpec["unit"], string> = { "%": "%", x: "×", currency: "", days: "days", number: "" };
const field =
  "h-7 w-20 rounded-md border border-border bg-surface px-2 text-right text-[13px] tabular-nums outline-none focus:ring-2 focus:ring-ring";

function RuleCard({ clientId, rule, currency, canEdit }: { clientId: string; rule: RuleSetting; currency: string; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState({
    enabled: rule.enabled,
    notifyEmail: rule.notifyEmail,
    notifySlack: rule.notifySlack,
    values: Object.fromEntries(Object.entries(rule.values).map(([k, v]) => [k, String(v)])),
  });
  const [msg, setMsg] = useState<string | null>(null);
  const dirty =
    state.enabled !== rule.enabled ||
    state.notifyEmail !== rule.notifyEmail ||
    state.notifySlack !== rule.notifySlack ||
    rule.params.some((p) => Number(state.values[p.key]) !== rule.values[p.key]);

  const save = () =>
    start(async () => {
      const params = Object.fromEntries(rule.params.map((p) => [p.key, Number(String(state.values[p.key]).replace(",", "."))]));
      if (Object.values(params).some((v) => !Number.isFinite(v))) return setMsg("Enter numbers only.");
      const r = await saveRule(clientId, rule.key, {
        enabled: state.enabled,
        notifyEmail: state.notifyEmail,
        notifySlack: state.notifySlack,
        params,
      });
      setMsg(r.ok ? "Saved. Applies from the next check." : r.error);
      if (r.ok) router.refresh();
    });

  return (
    <Card className="flex flex-col gap-3 p-4" data-testid={`rule-${rule.key}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-medium">{rule.label}</h3>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{rule.description}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[12px] text-muted">
          {state.enabled ? "On" : "Off"}
          <Switch
            checked={state.enabled}
            disabled={!canEdit}
            onCheckedChange={(v) => setState({ ...state, enabled: v })}
            aria-label={`${rule.label} enabled`}
          />
        </label>
      </div>
      {rule.params.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {rule.params.map((p) => (
            <label key={p.key} className="flex items-center gap-2 text-[12.5px]">
              <span className="text-muted">{p.label}</span>
              {p.unit === "currency" && <span className="text-subtle">{currency}</span>}
              <input
                className={field}
                inputMode="decimal"
                disabled={!canEdit}
                value={state.values[p.key]}
                aria-label={`${rule.label}: ${p.label}`}
                onChange={(e) => setState({ ...state, values: { ...state.values, [p.key]: e.target.value } })}
              />
              <span className="text-subtle">{UNIT[p.unit]}</span>
            </label>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <div className="flex items-center gap-4 text-[12.5px] text-muted">
          <label className="flex items-center gap-2">
            <Switch
              checked={state.notifyEmail}
              disabled={!canEdit}
              onCheckedChange={(v) => setState({ ...state, notifyEmail: v })}
              aria-label={`${rule.label}: email`}
            />
            Email
          </label>
          <label className="flex items-center gap-2">
            <Switch
              checked={state.notifySlack}
              disabled={!canEdit}
              onCheckedChange={(v) => setState({ ...state, notifySlack: v })}
              aria-label={`${rule.label}: Slack`}
            />
            Slack
          </label>
        </div>
        <div className="flex items-center gap-2">
          {msg && (
            <span role="status" className="text-[12px] text-muted">
              {msg}
            </span>
          )}
          {canEdit && rule.customized && (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  await resetRule(clientId, rule.key);
                  setMsg("Back to defaults.");
                  router.refresh();
                })
              }
            >
              Reset to defaults
            </Button>
          )}
          {canEdit && (
            <Button size="sm" disabled={pending || !dirty} onClick={save}>
              Save
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function RulesEditor({
  clientId,
  rules,
  currency,
  canEdit,
}: {
  clientId: string;
  rules: RuleSetting[];
  currency: string;
  canEdit: boolean;
}) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {rules.map((r) => (
        <RuleCard
          key={`${clientId}:${r.key}:${JSON.stringify(r.values)}:${r.enabled}:${r.notifyEmail}:${r.notifySlack}`}
          clientId={clientId}
          rule={r}
          currency={currency}
          canEdit={canEdit}
        />
      ))}
    </div>
  );
}
