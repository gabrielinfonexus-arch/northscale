"use client";
import * as React from "react";
import { DropdownMenu as D } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const DropdownMenu = D.Root;
export const DropdownMenuTrigger = D.Trigger;

export function DropdownMenuContent({ className, align = "end", sideOffset = 6, ...props }: React.ComponentProps<typeof D.Content>) {
  return (
    <D.Portal>
      <D.Content
        align={align}
        sideOffset={sideOffset}
        className={cn("z-50 min-w-44 rounded-lg border border-border bg-surface p-1 shadow-lg", className)}
        {...props}
      />
    </D.Portal>
  );
}
export function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof D.Item>) {
  return (
    <D.Item
      className={cn(
        "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none data-[highlighted]:bg-accent",
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuCheckboxItem({ className, children, ...props }: React.ComponentProps<typeof D.CheckboxItem>) {
  return (
    <D.CheckboxItem
      className={cn(
        "relative flex cursor-pointer select-none items-center rounded-md py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-accent",
        className,
      )}
      {...props}
    >
      <span className="absolute left-2 flex size-3.5 items-center justify-center">
        <D.ItemIndicator>
          <Check className="size-3.5" />
        </D.ItemIndicator>
      </span>
      {children}
    </D.CheckboxItem>
  );
}
export function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof D.Label>) {
  return <D.Label className={cn("px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-subtle", className)} {...props} />;
}
export function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof D.Separator>) {
  return <D.Separator className={cn("my-1 h-px bg-border", className)} {...props} />;
}
