import type { DecisionContext, DecisionMode, DecisionResult } from "../contracts/decision";
import { augmentStatsDisabledResponse, augmentStatsEnabled } from "@/lib/stats/kill-switch";
import { evaluateDecision, type DecisionEngineData } from "../decision/evaluate";
import { DEFAULT_MODEL_CONFIG } from "../decision/model-config";
import type { RequireEntitlementResult } from "../entitlements/server";
import { parseDecisionContext } from "./decision-validation";
import { checkRateLimit } from "./rate-limit";

export interface DecisionSessionRecord {
  userId: string;
  modelVersion: string;
  mode: DecisionMode;
  championSlug: string;
  round: number;
  context: DecisionContext;
  resultSummary: {
    poolSize: number;
    rerollStance: string;
    candidates: Array<{ augmentSlug: string; grade: string; score: number }>;
  };
}

export interface DecisionApiDeps {
  requireEntitlement(): Promise<RequireEntitlementResult>;
  loadData(championSlug: string): Promise<DecisionEngineData>;
  /** Best-effort member history; failures must never block the decision. */
  recordSession?(record: DecisionSessionRecord): Promise<void>;
  now?(): number;
}

const EVALUATE_LIMIT = { limit: 30, windowMs: 60_000 };
const MATRIX_LIMIT = { limit: 10, windowMs: 60_000 };

function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}

async function readJson(request: Request): Promise<unknown | undefined> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export async function handleEvaluate(
  request: Request,
  deps: DecisionApiDeps,
): Promise<Response> {
  if (!augmentStatsEnabled()) return augmentStatsDisabledResponse();
  const gate = await deps.requireEntitlement();
  if (!gate.ok) return jsonError(gate.reason, gate.status);

  const rate = checkRateLimit(`evaluate:${gate.user.id}`, {
    ...EVALUATE_LIMIT,
    now: deps.now?.(),
  });
  if (!rate.allowed) {
    return jsonError("rate-limited", 429, { "Retry-After": String(rate.retryAfterSeconds) });
  }

  const body = await readJson(request);
  if (body === undefined) return jsonError("invalid JSON body", 400);
  const parsed = parseDecisionContext(body);
  if (!parsed.ok) return jsonError(parsed.error, 400);

  let data: DecisionEngineData;
  try {
    data = await deps.loadData(parsed.context.championSlug);
  } catch {
    return jsonError("unknown champion", 404);
  }

  const result: DecisionResult = evaluateDecision(parsed.context, data, DEFAULT_MODEL_CONFIG);

  try {
    await deps.recordSession?.({
      userId: gate.user.id,
      modelVersion: result.modelVersion,
      mode: parsed.context.mode,
      championSlug: parsed.context.championSlug,
      round: parsed.context.round,
      context: parsed.context,
      resultSummary: {
        poolSize: result.poolSize,
        rerollStance: result.reroll.stance,
        candidates: result.candidates.map((candidate) => ({
          augmentSlug: candidate.augmentSlug,
          grade: candidate.grade,
          score: candidate.score,
        })),
      },
    });
  } catch {
    // History is member value, the decision result is the product — fail open.
  }

  return Response.json(result);
}

export interface MatrixCell {
  rarity: DecisionContext["screenRarity"];
  poolSize: number;
  candidates: DecisionResult["candidates"];
}

export async function handleChampionMatrix(
  request: Request,
  deps: DecisionApiDeps,
): Promise<Response> {
  if (!augmentStatsEnabled()) return augmentStatsDisabledResponse();
  const gate = await deps.requireEntitlement();
  if (!gate.ok) return jsonError(gate.reason, gate.status);

  const rate = checkRateLimit(`matrix:${gate.user.id}`, {
    ...MATRIX_LIMIT,
    now: deps.now?.(),
  });
  if (!rate.allowed) {
    return jsonError("rate-limited", 429, { "Retry-After": String(rate.retryAfterSeconds) });
  }

  const body = await readJson(request);
  if (typeof body !== "object" || body === null) return jsonError("invalid JSON body", 400);
  const { championSlug, mode } = body as Record<string, unknown>;
  if (typeof championSlug !== "string" || championSlug.length === 0) {
    return jsonError("championSlug is required", 400);
  }
  if (mode !== "competitive" && mode !== "exploration") {
    return jsonError("mode must be competitive|exploration", 400);
  }

  let data: DecisionEngineData;
  try {
    data = await deps.loadData(championSlug);
  } catch {
    return jsonError("unknown champion", 404);
  }

  let modelVersion = "";
  const rounds = ([1, 2, 3, 4] as const).map((round) => ({
    round,
    rarities: (["silver", "gold", "prismatic"] as const).map((rarity): MatrixCell => {
      const result = evaluateDecision(
        {
          championSlug,
          round,
          screenRarity: rarity,
          mode,
          ownedAugmentSlugs: [],
          currentItemIds: [],
          plannedItemIds: [],
          rerollsRemaining: 0,
          goldenRerollAvailable: false,
        },
        data,
        DEFAULT_MODEL_CONFIG,
      );
      modelVersion = result.modelVersion;
      return { rarity, poolSize: result.poolSize, candidates: result.candidates };
    }),
  }));

  return Response.json({ championSlug, mode, modelVersion, rounds });
}
