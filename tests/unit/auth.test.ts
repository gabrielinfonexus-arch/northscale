import { describe, expect, it } from "vitest";
import { canSeePage, type PageAccessUser } from "@/lib/permissions";
import { hashPassword, passwordProblem, verifyPassword } from "@/server/password-core";

const u = (role: PageAccessUser["role"], kind: PageAccessUser["kind"] = "user", viewerPages: PageAccessUser["viewerPages"] = null): PageAccessUser => ({ role, kind, viewerPages });

describe("page permissions", () => {
  it("owners and admins see everything", () => {
    for (const p of ["clients", "team", "billing", "client-viewers", "hive-mind", "pnl"]) {
      expect(canSeePage(u("OWNER"), p)).toBe(true);
      expect(canSeePage(u("ADMIN"), p)).toBe(true);
    }
  });

  it("analysts: reporting pages, no management", () => {
    const a = u("ANALYST");
    for (const p of ["data", "dashboard", "hive-mind", "sync-status", "help"]) expect(canSeePage(a, p)).toBe(true);
    for (const p of ["clients", "team", "billing", "client-viewers"]) expect(canSeePage(a, p)).toBe(false);
  });

  it("viewers: only chosen pages, per client", () => {
    const v = u("CLIENT_VIEWER", "user", { c1: ["dashboard", "pnl"], c2: ["data"] });
    expect(canSeePage(v, "pnl", "c1")).toBe(true);
    expect(canSeePage(v, "pnl", "c2")).toBe(false);
    expect(canSeePage(v, "data")).toBe(true); // some client allows it (nav)
    expect(canSeePage(v, "watchdog")).toBe(false);
    expect(canSeePage(v, "sync-status")).toBe(false);
    expect(canSeePage(v, "help")).toBe(true);
  });

  it("public links never get Hive-Mind or Help", () => {
    const s = u("CLIENT_VIEWER", "share", { c1: ["dashboard", "hive-mind"] });
    expect(canSeePage(s, "dashboard", "c1")).toBe(true);
    expect(canSeePage(s, "hive-mind", "c1")).toBe(false);
    expect(canSeePage(s, "help")).toBe(false);
  });
});

describe("passwords", () => {
  it("hash and verify (salted, constant format, no plain text)", async () => {
    const h = await hashPassword("correct-horse-battery");
    expect(h).toMatch(/^scrypt:16384:8:1:[\w-]+:[\w-]+$/);
    expect(h).not.toContain("correct-horse");
    expect(await hashPassword("correct-horse-battery")).not.toBe(h);
    expect(await verifyPassword("correct-horse-battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
  it("rules", () => {
    expect(passwordProblem("short")).toMatch(/10/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/guess/);
    expect(passwordProblem("a-good-pass-phrase")).toBeNull();
  });
});
