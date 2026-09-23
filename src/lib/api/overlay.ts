import type { RequireEntitlementResult } from "../entitlements/server";
import { augmentStatsDisabledResponse, augmentStatsEnabled } from "@/lib/stats/kill-switch";

export interface ModelReleaseRow {
  model_version: string;
  engine_version: string;
  data_version: string;
  config_sha256: string;
  signature: string;
  package_url: string;
}

export interface TrialLease {
  gameHash: string;
  expiresAt: string;
}

export interface OverlayApiDeps {
  /** A desktop request's `Authorization: Bearer <deviceToken>`, when present. */
  requireEntitlement(bearerToken?: string | null): Promise<RequireEntitlementResult>;
  getActiveRelease(): Promise<ModelReleaseRow | null>;
  /** Active (unexpired) trial reservation for this user, if any. */
  findActiveLease(userId: string): Promise<TrialLease | null>;
  /** Reserve one trial credit; null when no credit is available. */
  reserveTrialCredit(userId: string, gameHash: string): Promise<TrialLease | null>;
  getUserId(bearerToken?: string | null): Promise<string | null>;
  now?(): Date;
}

const LEASE_MINUTES = 40;

export function leaseExpiry(now: Date): string {
  return new Date(now.getTime() + LEASE_MINUTES * 60_000).toISOString();
}

function bearerTokenFrom(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

/**
 * GET /api/overlay/bootstrap — members (or trial users holding an active
 * game lease) receive the active signed model manifest.
 */
export async function handleOverlayBootstrap(
  request: Request,
  deps: OverlayApiDeps,
): Promise<Response> {
  if (!augmentStatsEnabled()) return augmentStatsDisabledResponse();
  const bearerToken = bearerTokenFrom(request);
  const gate = await deps.requireEntitlement(bearerToken);
  let leased: TrialLease | null = null;

  if (!gate.ok) {
    if (gate.status === 401) {
      return Response.json({ error: gate.reason }, { status: 401 });
    }
    const userId = await deps.getUserId(bearerToken);
    leased = userId ? await deps.findActiveLease(userId) : null;
    if (!leased) return Response.json({ error: gate.reason }, { status: 403 });
  }

  const release = await deps.getActiveRelease();
  if (!release) return Response.json({ error: "no-active-model" }, { status: 404 });

  return Response.json({
    manifest: {
      modelVersion: release.model_version,
      engineVersion: release.engine_version,
      dataVersion: release.data_version,
      configSha256: release.config_sha256,
      signature: release.signature,
    },
    packageUrl: release.package_url,
    access: gate.ok ? { kind: gate.entitlement.kind } : { kind: "trial-lease", lease: leased },
  });
}

/**
 * POST /api/overlay/game-session — members get a lease without consuming
 * anything; trial users reserve one of their three game credits.
 */
export async function handleGameSession(
  request: Request,
  deps: OverlayApiDeps,
): Promise<Response> {
  const bearerToken = bearerTokenFrom(request);
  // Checked first (not just gameHash/body parsing) so an invalid/revoked
  // bearer token always surfaces its distinct 401 reason, the same way
  // bootstrap does — the desktop side needs that distinction to know when to
  // delete a bad credential vs. when it simply isn't a member.
  const gate = await deps.requireEntitlement(bearerToken);
  if (!gate.ok && gate.status === 401) {
    return Response.json({ error: gate.reason }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { gameHash } = (body ?? {}) as Record<string, unknown>;
  if (typeof gameHash !== "string" || gameHash.length < 8) {
    return Response.json({ error: "gameHash is required" }, { status: 400 });
  }

  if (gate.ok) {
    const now = deps.now?.() ?? new Date();
    return Response.json({
      lease: { kind: gate.entitlement.kind, gameHash, expiresAt: leaseExpiry(now) },
    });
  }

  const userId = await deps.getUserId(bearerToken);
  if (!userId) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const lease = await deps.reserveTrialCredit(userId, gameHash);
  if (!lease) return Response.json({ error: "no-trial-credits" }, { status: 403 });
  return Response.json({ lease: { kind: "trial", ...lease } });
}
