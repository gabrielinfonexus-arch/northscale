"use client";
import { useState } from "react";
import { Menu } from "lucide-react";
import { Dialog, DialogTitle, DialogTrigger, SheetContent } from "@/components/ui/dialog";
import { SidebarNav } from "./sidebar";

export function MobileNav({ visible, badges }: { visible?: string[]; badges?: Record<string, number> }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="rounded-md p-1.5 text-muted hover:bg-accent lg:hidden" aria-label="Open menu">
        <Menu className="size-5" />
      </DialogTrigger>
      <SheetContent aria-describedby={undefined}>
        <DialogTitle className="px-5 pb-4 pt-5 text-[15px] font-semibold">NorthScale</DialogTitle>
        <SidebarNav onNavigate={() => setOpen(false)} visible={visible} badges={badges} />
      </SheetContent>
    </Dialog>
  );
}
