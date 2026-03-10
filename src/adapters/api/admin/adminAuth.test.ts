import { describe, expect, it } from "vitest";
import {
  createSignedSessionCookie,
  hashAdminPassword,
  parseCookieHeader,
  serializeSessionCookie,
  verifyAdminPassword,
  verifySignedSessionCookie
} from "./adminAuth.js";

describe("adminAuth", () => {
  it("hashes and verifies passwords", () => {
    const password = "super-secret-password";
    const hash = hashAdminPassword(password);

    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifyAdminPassword(password, hash)).toBe(true);
    expect(verifyAdminPassword("wrong-password", hash)).toBe(false);
  });

  it("signs and verifies session cookies", () => {
    const sessionId = "session_123";
    const secret = "test-session-secret";
    const signedCookie = createSignedSessionCookie(sessionId, secret);
    const header = serializeSessionCookie("agent_blue_admin_session", signedCookie, {
      maxAgeSeconds: 3600,
      sameSite: "Strict",
      secure: false
    });

    const parsed = parseCookieHeader(header.split(";")[0]);
    expect(parsed.agent_blue_admin_session).toBeTruthy();
    expect(verifySignedSessionCookie(parsed.agent_blue_admin_session, secret)).toBe(sessionId);
    expect(verifySignedSessionCookie(parsed.agent_blue_admin_session, "wrong-secret")).toBeNull();
  });
});
