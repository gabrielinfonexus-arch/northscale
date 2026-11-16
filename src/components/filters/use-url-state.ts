"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

/** Read/merge URL query params. Every filter change is a navigation, so links are always shareable. */
export function useUrlState() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const [pending, startTransition] = useTransition();

  const set = useCallback(
    (updates: Record<string, string | null | undefined>, opts: { replace?: boolean } = {}) => {
      const p = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === undefined || v === "") p.delete(k);
        else p.set(k, v);
      }
      const qs = p.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      startTransition(() => (opts.replace ? router.replace(url, { scroll: false }) : router.push(url, { scroll: false })));
    },
    [pathname, router, sp],
  );

  return { sp, set, pending, pathname };
}
