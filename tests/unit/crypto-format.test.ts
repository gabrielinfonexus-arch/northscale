import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, redact } from "@/lib/crypto";
import { formatMetricValue, formatDeltaPct } from "@/lib/format";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

describe("token encryption (AES-256-GCM)", () => {
  it("round-trips and uses a random IV", () => {
    const a = encryptSecret("EAAB-secret-token");
    const b = encryptSecret("EAAB-secret-token");
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret");
    expect(decryptSecret(a)).toBe("EAAB-secret-token");
  });

  it("detects tampering", () => {
    const enc = encryptSecret("x");
    const [iv, tag, data] = enc.split(".");
    const flipped = Buffer.from(data, "base64");
    flipped[0] ^= 1;
    expect(() => decryptSecret([iv, tag, flipped.toString("base64")].join("."))).toThrow();
  });

  it("redacts", () => {
    expect(redact("abcdefgh")).toBe("••••efgh");
  });
});

describe("formatting", () => {
  it("formats per currency locale", () => {
    expect(formatMetricValue(1019.69, "currency", "USD")).toBe("$1,019.69");
    expect(formatMetricValue(1019.69, "currency", "BRL").replace(/\s/g, " ")).toBe("R$ 1.019,69");
    expect(formatMetricValue(124206, "number", "USD")).toBe("124,206");
    expect(formatMetricValue(0.0234, "percent", "USD")).toBe("2.34%");
    expect(formatMetricValue(3.456, "ratio", "USD")).toBe("3.46x");
    expect(formatMetricValue(null, "currency", "USD")).toBe("—");
    expect(formatDeltaPct(12.345)).toBe("12%");
    expect(formatDeltaPct(1.23)).toBe("1.2%");
  });
});
