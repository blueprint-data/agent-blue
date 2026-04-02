import { describe, expect, it } from "vitest";
import { checkTenantAccess, requireSuperadmin } from "./adminAccess.js";

describe("checkTenantAccess", () => {
  const superadmin = {
    method: "session" as const,
    username: "admin",
    role: "superadmin" as const,
    scopedTenantId: null,
    authProvider: "password" as const
  };
  const tenantAdmin = {
    method: "session" as const,
    username: "u@t.com",
    role: "tenant_admin" as const,
    scopedTenantId: "acme",
    authProvider: "google" as const
  };

  it("allows superadmin any tenant", () => {
    expect(checkTenantAccess(superadmin, "any")).toBe(true);
  });
  it("allows tenant admin only scoped tenant", () => {
    expect(checkTenantAccess(tenantAdmin, "acme")).toBe(true);
    expect(checkTenantAccess(tenantAdmin, "other")).toEqual({
      status: 403,
      error: "You do not have access to this tenant."
    });
  });
});

describe("requireSuperadmin", () => {
  it("allows superadmin", () => {
    expect(
      requireSuperadmin({
        method: "bearer",
        username: "x",
        role: "superadmin",
        scopedTenantId: null,
        authProvider: "password"
      })
    ).toBe(true);
  });
  it("denies tenant admin", () => {
    expect(
      requireSuperadmin({
        method: "session",
        username: "u",
        role: "tenant_admin",
        scopedTenantId: "t",
        authProvider: "google"
      })
    ).toEqual({ status: 403, error: "Superadmin access required." });
  });
});
