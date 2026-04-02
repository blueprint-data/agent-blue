import crypto from "node:crypto";

const DEFAULT_SCRYPT_N = 16384;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const DEFAULT_KEY_LENGTH = 64;

export interface ParsedAdminPasswordHash {
  algorithm: "scrypt";
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

export interface AdminCookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
  sameSite?: "Strict" | "Lax";
  path?: string;
}

export function hashAdminPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, DEFAULT_KEY_LENGTH, {
    N: DEFAULT_SCRYPT_N,
    r: DEFAULT_SCRYPT_R,
    p: DEFAULT_SCRYPT_P
  });
  return [
    "scrypt",
    DEFAULT_SCRYPT_N,
    DEFAULT_SCRYPT_R,
    DEFAULT_SCRYPT_P,
    salt.toString("base64url"),
    hash.toString("base64url")
  ].join("$");
}

export function parseAdminPasswordHash(value: string): ParsedAdminPasswordHash | null {
  const parts = value.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }
  const n = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) {
    return null;
  }
  try {
    return {
      algorithm: "scrypt",
      n,
      r,
      p,
      salt: Buffer.from(parts[4] ?? "", "base64url"),
      hash: Buffer.from(parts[5] ?? "", "base64url")
    };
  } catch {
    return null;
  }
}

export function verifyAdminPassword(password: string, storedHash: string): boolean {
  const parsed = parseAdminPasswordHash(storedHash);
  if (!parsed) {
    return false;
  }
  const derived = crypto.scryptSync(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p
  });
  if (derived.length !== parsed.hash.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, parsed.hash);
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
      .map((entry) => {
        const separator = entry.indexOf("=");
        if (separator === -1) {
          return [entry, ""];
        }
        const key = entry.slice(0, separator).trim();
        const value = entry.slice(separator + 1).trim();
        return [key, decodeURIComponent(value)];
      })
  );
}

function signSessionId(sessionId: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(sessionId).digest("base64url");
}

export function createSignedSessionCookie(sessionId: string, secret: string): string {
  return `${sessionId}.${signSessionId(sessionId, secret)}`;
}

export function verifySignedSessionCookie(cookieValue: string | undefined, secret: string): string | null {
  if (!cookieValue) {
    return null;
  }
  const lastDot = cookieValue.lastIndexOf(".");
  if (lastDot === -1) {
    return null;
  }
  const sessionId = cookieValue.slice(0, lastDot);
  const signature = cookieValue.slice(lastDot + 1);
  if (!sessionId || !signature) {
    return null;
  }
  const expected = signSessionId(sessionId, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  return sessionId;
}

export function serializeSessionCookie(
  cookieName: string,
  value: string,
  options: AdminCookieOptions
): string {
  const path = options.path ?? "/";
  const sameSite = options.sameSite ?? "Strict";
  const parts = [
    `${cookieName}=${encodeURIComponent(value)}`,
    `Path=${path}`,
    "HttpOnly",
    `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${sameSite}`
  ];
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function serializeClearedSessionCookie(
  cookieName: string,
  secure: boolean,
  extra?: Pick<AdminCookieOptions, "path" | "sameSite">
): string {
  return serializeSessionCookie(cookieName, "", {
    maxAgeSeconds: 0,
    sameSite: extra?.sameSite ?? "Strict",
    secure,
    path: extra?.path
  });
}

export function createSessionId(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Signed opaque value for OAuth `state` and matching cookie. */
export function createOAuthStateToken(secret: string): string {
  const raw = createSessionId();
  return createSignedSessionCookie(raw, secret);
}

export function verifyOAuthStateToken(params: {
  cookieValue: string | undefined;
  queryState: string | undefined;
  secret: string;
}): boolean {
  const { cookieValue, queryState, secret } = params;
  if (!cookieValue || !queryState) {
    return false;
  }
  if (!timingSafeStringEqual(cookieValue, queryState)) {
    return false;
  }
  return verifySignedSessionCookie(queryState, secret) !== null;
}
