import { cn } from "@/lib/utils";

export const PLATFORM_LABEL: Record<string, string> = {
  META: "Meta",
  GOOGLE: "Google",
  SHOPIFY: "Shopify",
  OTHER_REVENUE: "Other Revenue",
};

const DOT: Record<string, string> = { META: "bg-[#1877f2]", GOOGLE: "bg-[#fbbc04]", SHOPIFY: "bg-[#5e8e3e]", OTHER_REVENUE: "bg-zinc-400" };

export function PlatformDot({ platform, className }: { platform: string; className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", DOT[platform], className)} aria-hidden />;
}
