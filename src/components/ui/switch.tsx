"use client";
import * as React from "react";
import { Switch as S } from "radix-ui";
import { cn } from "@/lib/utils";

export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-border-strong transition-colors data-[state=checked]:bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      <S.Thumb className="pointer-events-none block size-3 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0.5 dark:bg-zinc-900" />
    </S.Root>
  );
}
