import { describe, expect, it } from "vitest";
import {
  emailDomainFromAddress,
  parseSuperadminEmailDomains,
  parseTenantEmailDomainMap,
  resolveGoogleLoginAccess
} from "./adminAuthPolicy.js";

describe("emailDomainFromAddress", () => {
  it("extracts domain", () => {
    expect(emailDomainFromAddress("User@Takenos.COM")).toBe("takenos.com");
  });
  it("returns null for invalid", () => {
    expect(emailDomainFromAddress("nope")).toBeNull();
    expect(emailDomainFromAddress("@x.com")).toBeNull();
  });
});

describe("parseSuperadminEmailDomains", () => {
  it("parses comma list", () => {
    const set = parseSuperadminEmailDomains(" blueprintdata.xyz , Example.COM ");
    expect(set.has("blueprintdata.xyz")).toBe(true);
    expect(set.has("example.com")).toBe(true);
  });
});

describe("parseTenantEmailDomainMap", () => {
  it("parses domain:tenant pairs", () => {
    expect(parseTenantEmailDomainMap("takenos.com:takenos")).toEqual({ "takenos.com": "takenos" });
    expect(parseTenantEmailDomainMap("a.com:tenant-a,b.org:tenant-b")).toEqual({
      "a.com": "tenant-a",
      "b.org": "tenant-b"
    });
  });
  it("supports tenant ids with colons", () => {
    expect(parseTenantEmailDomainMap("corp.com:tenant:with:colons")).toEqual({
      "corp.com": "tenant:with:colons"
    });
  });
});

describe("resolveGoogleLoginAccess", () => {
  const tenantExists = (id: string) => id === "takenos";

  it("rejects unverified email", () => {
    const r = resolveGoogleLoginAccess({
      email: "a@takenos.com",
      emailVerified: false,
      superadminDomains: new Set(),
      tenantDomainToTenantId: { "takenos.com": "takenos" },
      tenantExists
    });
    expect(r).toEqual({ ok: false, code: "unverified_email" });
  });

  it("superadmin by domain", () => {
    const r = resolveGoogleLoginAccess({
      email: "ops@blueprintdata.xyz",
      emailVerified: true,
      superadminDomains: new Set(["blueprintdata.xyz"]),
      tenantDomainToTenantId: {},
      tenantExists
    });
    expect(r).toEqual({ ok: true, role: "superadmin", scopedTenantId: null });
  });

  it("tenant admin when domain maps and tenant exists", () => {
    const r = resolveGoogleLoginAccess({
      email: "x@takenos.com",
      emailVerified: true,
      superadminDomains: new Set(),
      tenantDomainToTenantId: { "takenos.com": "takenos" },
      tenantExists
    });
    expect(r).toEqual({ ok: true, role: "tenant_admin", scopedTenantId: "takenos" });
  });

  it("rejects unknown domain", () => {
    const r = resolveGoogleLoginAccess({
      email: "x@other.com",
      emailVerified: true,
      superadminDomains: new Set(),
      tenantDomainToTenantId: { "takenos.com": "takenos" },
      tenantExists
    });
    expect(r).toEqual({ ok: false, code: "unknown_domain" });
  });

  it("rejects hosted domain mismatch", () => {
    const r = resolveGoogleLoginAccess({
      email: "x@takenos.com",
      emailVerified: true,
      hostedDomain: "evil.com",
      superadminDomains: new Set(),
      tenantDomainToTenantId: { "takenos.com": "takenos" },
      tenantExists
    });
    expect(r).toEqual({ ok: false, code: "hosted_domain_mismatch" });
  });
});
