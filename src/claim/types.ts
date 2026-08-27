/**
 * Types for the manual-claim ("weekend plan") subsystem — mirrors the ZCode
 * 3.10 desktop client's `manualClaimPlan` feature.
 *
 * Server biz codes → failure kinds match the desktop client's `$vt` mapper:
 * 1001 notFound, 1002 unavailable, 1003 alreadyClaimed, 1004 ineligible,
 * 1005 quotaExhausted, 3001 invalidRequest, 3007 captcha, 401 loginRequired.
 *
 * @see _reverse/NOTEPAD.md "Manual Claim Plan" section.
 */

/** One entitlement inside a claimable plan (normalized from snake_case upstream). */
export interface PlanEntitlement {
  entitlementId: string;
  showName: string;
  meter: string;
  unitType: string;
  capabilities: string[];
  grantUnits: number;
  period: string;
  priority: number;
  /** Unix seconds when the entitlement activates (weekend plans activate late). */
  effectiveAt?: number;
}

/** A claimable trial plan from `GET /api/v1/zcode-plan/billing/preview`. */
export interface ClaimablePlan {
  planId: string;
  name: string;
  description: string;
  priority: number;
  entitlements: PlanEntitlement[];
  startsAt?: number;
  endsAt?: number;
}

export type ClaimFailureKind =
  | "not_found"
  | "unavailable"
  | "already_claimed"
  | "ineligible"
  | "quota_exhausted"
  | "invalid_request"
  | "captcha"
  | "login_required"
  | "http_error"
  | "unknown";

export type ClaimOutcome =
  | { ok: true; planId: string; startsAt?: number; endsAt?: number }
  | { ok: false; planId: string; failureKind: ClaimFailureKind; code: number | string; message: string; failureEndsAt?: number };

/** Map a server biz code to the client failure kind (mirrors `$vt` in the desktop bundle). */
export function classifyClaimCode(code: number | string | undefined): ClaimFailureKind {
  switch (typeof code === "string" ? Number.parseInt(code, 10) : code) {
    case 1001: return "not_found";
    case 1002: return "unavailable";
    case 1003: return "already_claimed";
    case 1004: return "ineligible";
    case 1005: return "quota_exhausted";
    case 3001: return "invalid_request";
    case 3007: return "captcha";
    case 401: return "login_required";
    default: return "unknown";
  }
}
