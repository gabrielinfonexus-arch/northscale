"use client";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatShortDay } from "@/lib/periods";

const tooltipStyle = { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 };

/** Jobs per day by status. Status colours (good / critical / in progress) with a legend, never colour alone. */
export function JobsPerDay({ data }: { data: { date: string; SUCCESS: number; FAILED: number; RUNNING: number; QUEUED: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
        <XAxis
          dataKey="date"
          tickFormatter={formatShortDay}
          tick={{ fontSize: 11, fill: "var(--muted)" }}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          minTickGap={20}
        />
        <YAxis width={40} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "var(--accent)" }} labelFormatter={(l) => formatShortDay(String(l))} />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12 }}
          formatter={(v) => ({ SUCCESS: "Succeeded", FAILED: "Failed", RUNNING: "Running", QUEUED: "Queued" })[String(v)] ?? v}
        />
        <Bar dataKey="SUCCESS" stackId="s" fill="var(--good)" isAnimationActive={false} />
        <Bar dataKey="RUNNING" stackId="s" fill="var(--series-1)" isAnimationActive={false} />
        <Bar dataKey="QUEUED" stackId="s" fill="var(--subtle)" isAnimationActive={false} />
        <Bar dataKey="FAILED" stackId="s" fill="var(--bad)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}
