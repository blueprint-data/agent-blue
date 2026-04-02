import type { Response } from "express";
import type { AdminAuthProvider, AdminPrincipalRole } from "../../../core/interfaces.js";

export interface AdminRequestAuth {
  method: "session" | "basic" | "bearer";
  username: string;
  role: AdminPrincipalRole;
  email?: string;
  scopedTenantId?: string | null;
  authProvider: AdminAuthProvider;
}

export type AccessDenied = { status: 403; error: string };

export function checkTenantAccess(auth: AdminRequestAuth, tenantId: string): true | AccessDenied {
  if (auth.role === "superadmin") {
    return true;
  }
  if (auth.scopedTenantId && auth.scopedTenantId === tenantId) {
    return true;
  }
  return { status: 403, error: "You do not have access to this tenant." };
}

export function requireSuperadmin(auth: AdminRequestAuth): true | AccessDenied {
  if (auth.role === "superadmin") {
    return true;
  }
  return { status: 403, error: "Superadmin access required." };
}

export function sendAccessDenied(res: Response, denied: AccessDenied): void {
  res.status(denied.status).json({ error: denied.error });
}
