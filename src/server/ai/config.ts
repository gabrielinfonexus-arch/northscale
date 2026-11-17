import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * Model choice (env): ANTHROPIC_MODEL for everyday questions and insights, ANTHROPIC_MODEL_HEAVY for
 * "deep analysis" conversations. AI_MOCK=1 swaps the API for a scripted model (local dev / tests, never production).
 */
export const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
export const AI_MODEL_HEAVY = process.env.ANTHROPIC_MODEL_HEAVY || "claude-opus-5-5";

export function aiMockEnabled(): boolean {
  const on = process.env.AI_MOCK === "1";
  if (on && process.env.NODE_ENV === "production") throw new Error("AI_MOCK is not allowed in production");
  return on;
}

export function aiConfigured(): boolean {
  return aiMockEnabled() || !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY; the key never reaches the browser
  return client;
}

/**
 * Server-side refusal fallback (beta): if a safety classifier declines, the API re-runs the request on a
 * fallback model inside the same call. "default" routes by refusal category.
 */
export const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

/** USD per million tokens: input, output, cache read. Cache writes bill at 1.25× input. */
const PRICES: Record<string, [number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 0.1],
  "claude-opus-5-5": [4, 20, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.01],
  "claude-fable-5-2": [8, 40, 0.2],
  "claude-sonnet-5": [2, 10, 0.2],
  "claude-opus-5": [5, 25, 0.5],
};

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function costUsd(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ""];
  if (!p) return 0;
  return (u.input * p[0] + u.output * p[1] + u.cacheRead * p[2] + u.cacheWrite * p[0] * 1.25) / 1_000_000;
}

export function addUsage(
  a: Usage,
  u: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
): Usage {
  return {
    input: a.input + (u.input_tokens ?? 0),
    output: a.output + (u.output_tokens ?? 0),
    cacheRead: a.cacheRead + (u.cache_read_input_tokens ?? 0),
    cacheWrite: a.cacheWrite + (u.cache_creation_input_tokens ?? 0),
  };
}
export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
