"use client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseChartSpec } from "@/lib/ai-display";
import { AiChart } from "./ai-chart";

/** Assistant text: GitHub-flavoured Markdown (tables) plus ```chart blocks. No raw HTML is rendered. */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="ai-prose text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-primary underline underline-offset-2"
              target={href?.startsWith("/") ? undefined : "_blank"}
              rel="noreferrer"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-[13px] tabular-nums">{children}</table>
            </div>
          ),
          th: ({ children, style }) => (
            <th
              style={style}
              className="border-b border-border bg-accent px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted"
            >
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td style={style} className="border-b border-border px-3 py-1.5 last:border-r-0">
              {children}
            </td>
          ),
          code: ({ className, children }) => {
            const lang = /language-(\w+)/.exec(className ?? "")?.[1];
            const raw = String(children).replace(/\n$/, "");
            if (lang === "chart") {
              const spec = parseChartSpec(raw);
              return spec ? <AiChart spec={spec} /> : <span className="text-[12px] text-muted">(chart could not be drawn)</span>;
            }
            return <code className="rounded bg-accent px-1 py-0.5 text-[12.5px]">{children}</code>;
          },
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
