import type { Request, Response } from "express";
import type { AdminRequestAuth } from "./adminAccess.js";
import { checkTenantAccess, requireSuperadmin, sendAccessDenied } from "./adminAccess.js";

export function adminAuthFromRequest(req: Request): AdminRequestAuth {
  const auth = (req as Request & { adminAuth?: AdminRequestAuth }).adminAuth;
  if (!auth) {
    throw new Error("adminAuth missing on request");
  }
  return auth;
}

/** Returns true if the request was denied (response already sent). */
export function denyUnlessSuperadmin(req: Request, res: Response): boolean {
  const denied = requireSuperadmin(adminAuthFromRequest(req));
  if (denied !== true) {
    sendAccessDenied(res, denied);
    return true;
  }
  return false;
}

/** Returns true if the request was denied (response already sent). */
export function denyUnlessTenantAccess(req: Request, res: Response, tenantId: string): boolean {
  const denied = checkTenantAccess(adminAuthFromRequest(req), tenantId);
  if (denied !== true) {
    sendAccessDenied(res, denied);
    return true;
  }
  return false;
}
