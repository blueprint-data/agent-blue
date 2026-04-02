import type { AdminPrincipalRole } from "../core/interfaces.js";

export type GoogleLoginResolution =
  | { ok: true; role: AdminPrincipalRole; scopedTenantId: string | null }
  | { ok: false; code: "unverified_email" | "hosted_domain_mismatch" | "unknown_domain" | "tenant_not_found" };

/** Normalizes an email domain label for storage and lookup (lowercase, trimmed). */
export function normalizeDomainPart(value: string): string {
  return value.trim().toLowerCase();
}

/** Returns the domain part of an email, or null if invalid. */
export function emailDomainFromAddress(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) {
    return null;
  }
  const domain = trimmed.slice(at + 1);
  if (!domain || domain.includes("@")) {
    return null;
  }
  return domain;
}

export function parseSuperadminEmailDomains(raw: string): Set<string> {
  const set = new Set<string>();
  for (const part of raw.split(",")) {
    const d = normalizeDomainPart(part);
    if (d) {
      set.add(d);
    }
  }
  return set;
}

/** Parses `domain:tenantId,domain2:tenant2` (tenantId may contain colons — use first colon as split). */
export function parseTenantEmailDomainMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const segment of raw.split(",")) {
    const trimmed = segment.trim();
    if (!trimmed) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    const domain = normalizeDomainPart(trimmed.slice(0, colon));
    const tenantId = trimmed.slice(colon + 1).trim();
    if (domain && tenantId) {
      map[domain] = tenantId;
    }
  }
  return map;
}

export function resolveGoogleLoginAccess(input: {
  email: string;
  emailVerified: boolean;
  hostedDomain?: string | null;
  superadminDomains: Set<string>;
  tenantDomainToTenantId: Record<string, string>;
  tenantExists: (tenantId: string) => boolean;
}): GoogleLoginResolution {
  if (!input.emailVerified) {
    return { ok: false, code: "unverified_email" };
  }
  const domain = emailDomainFromAddress(input.email);
  if (!domain) {
    return { ok: false, code: "unknown_domain" };
  }
  if (input.hostedDomain) {
    const hd = normalizeDomainPart(input.hostedDomain);
    if (hd && hd !== domain) {
      return { ok: false, code: "hosted_domain_mismatch" };
    }
  }
  if (input.superadminDomains.has(domain)) {
    return { ok: true, role: "superadmin", scopedTenantId: null };
  }
  const tenantId = input.tenantDomainToTenantId[domain];
  if (!tenantId) {
    return { ok: false, code: "unknown_domain" };
  }
  if (!input.tenantExists(tenantId)) {
    return { ok: false, code: "tenant_not_found" };
  }
  return { ok: true, role: "tenant_admin", scopedTenantId: tenantId };
}
