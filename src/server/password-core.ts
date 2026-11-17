/** Password hashing without the server-only guard, so CLI scripts (scripts/ensure-owner.ts) can use it. App code imports ./password. */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

type ScryptOpts = { N: number; r: number; p: number; maxmem: number };
const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: ScryptOpts) => Promise<Buffer>;
const PARAMS = { N: 16384, r: 8, p: 1 };
const LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

/** Stored as "scrypt:N:r:p:salt:hash" (base64url). The password itself is never stored or logged. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize("NFKC"), salt, LEN, { ...PARAMS, maxmem: MAXMEM });
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), hash.toString("base64url")].join(":");
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [alg, n, r, p, salt, hash] = stored.split(":");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const got = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function passwordProblem(pw: string): string | null {
  if (pw.length < 10) return "Use at least 10 characters.";
  if (pw.length > 200) return "Too long.";
  if (/^(.)\1+$/.test(pw)) return "Too easy to guess.";
  return null;
}

/** 256-bit random token for cookies and one-time links (only its SHA-256 is stored). */
export const newToken = () => randomBytes(32).toString("base64url");
