import type {
  OrchestrationV2ThreadProjection,
  ThreadUsageCost,
  ThreadUsageCostInput,
  ThreadId,
  UsageTokenTotals,
} from "@t3tools/contracts";
import {
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  OrchestrationV2SubagentJson,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { priceUsage, type RateTable } from "./usagePricing.ts";

export type ThreadUsageProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "attempts" | "subagents" | "providerTurns"
>;

interface PayloadRow {
  readonly payload_json: string;
}

const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2RunJson));
const decodeAttempt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJson),
);
const decodeSubagent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJson),
);
const decodeProviderTurn = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJson),
);

/** Reads only the four small projection tables needed for pricing. */
export const readThreadUsageProjection = Effect.fn("readThreadUsageProjection")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const [runRows, attemptRows, subagentRows, providerTurnRows] = yield* Effect.all([
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_runs
      WHERE thread_id = ${threadId}
      ORDER BY ordinal ASC
    `,
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_run_attempts
      WHERE thread_id = ${threadId}
      ORDER BY run_id ASC, attempt_ordinal ASC
    `,
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_subagents
      WHERE thread_id = ${threadId}
      ORDER BY COALESCE(started_at, ''), subagent_id ASC
    `,
    sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_provider_turns
      WHERE thread_id = ${threadId}
      ORDER BY provider_thread_id ASC, ordinal ASC
    `,
  ]);
  const [runs, attempts, subagents, providerTurns] = yield* Effect.all([
    Effect.forEach(runRows, (row) => decodeRun(row.payload_json)),
    Effect.forEach(attemptRows, (row) => decodeAttempt(row.payload_json)),
    Effect.forEach(subagentRows, (row) => decodeSubagent(row.payload_json)),
    Effect.forEach(providerTurnRows, (row) => decodeProviderTurn(row.payload_json)),
  ]);
  return { runs, attempts, subagents, providerTurns } satisfies ThreadUsageProjection;
});

function isTerminalTurn(status: ThreadUsageProjection["providerTurns"][number]["status"]): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

function unavailable(
  input: ThreadUsageCostInput,
  reason: Extract<ThreadUsageCost, { availability: "unavailable" }>["reason"],
): ThreadUsageCost {
  return {
    threadId: input.threadId,
    revision: input.revision,
    availability: "unavailable",
    reason,
  };
}

function turnModel(
  turn: ThreadUsageProjection["providerTurns"][number],
  runsById: ReadonlyMap<string, ThreadUsageProjection["runs"][number]>,
  attemptsById: ReadonlyMap<string, ThreadUsageProjection["attempts"][number]>,
  subagentsById: ReadonlyMap<string, ThreadUsageProjection["subagents"][number]>,
): string | null {
  if (turn.runAttemptId !== null) {
    const attempt = attemptsById.get(turn.runAttemptId);
    const run = attempt === undefined ? undefined : runsById.get(attempt.runId);
    if (run !== undefined) return run.modelSelection.model;
  }

  const subagent = subagentsById.get(turn.nodeId);
  if (subagent?.model) return subagent.model;
  const run =
    subagent?.runId === null || subagent?.runId === undefined
      ? undefined
      : runsById.get(subagent.runId);
  return run?.modelSelection.model ?? null;
}

/** TurnTokenUsage input includes cache reads and writes, while pricing expects disjoint inputs. */
function usageTotals(
  usage: Extract<
    NonNullable<ThreadUsageProjection["providerTurns"][number]["turnTokenUsage"]>,
    { usageStatus: "complete" }
  >,
): UsageTokenTotals {
  const cachedInputTokens = Math.min(usage.inputTokens, usage.cachedInputTokens ?? 0);
  const cacheCreationTokens = Math.min(
    usage.inputTokens - cachedInputTokens,
    usage.cacheCreationTokens ?? 0,
  );
  return {
    uncachedInputTokens: usage.inputTokens - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens ?? 0),
  };
}

/**
 * Totals completed provider turns owned by this app thread. Running turns are
 * deliberately omitted, so callers can keep displaying the last settled cost
 * until the provider publishes terminal usage.
 */
export function summarizeThreadUsageCost(input: {
  readonly request: ThreadUsageCostInput;
  readonly projection: ThreadUsageProjection;
  readonly rates: RateTable;
  readonly priceOverrides?: RateTable;
}): ThreadUsageCost {
  const terminalTurns = input.projection.providerTurns.filter((turn) =>
    isTerminalTurn(turn.status),
  );
  if (terminalTurns.length === 0) return unavailable(input.request, "noUsage");

  const runsById = new Map<string, ThreadUsageProjection["runs"][number]>(
    input.projection.runs.map((run) => [run.id, run]),
  );
  const attemptsById = new Map<string, ThreadUsageProjection["attempts"][number]>(
    input.projection.attempts.map((attempt) => [attempt.id, attempt]),
  );
  const subagentsById = new Map<string, ThreadUsageProjection["subagents"][number]>(
    input.projection.subagents.map((subagent) => [subagent.id, subagent]),
  );
  let costUsd = 0;
  let anyModelPriced = false;
  let pricedTurns = 0;
  let missingReason: Extract<ThreadUsageCost, { availability: "unavailable" }>["reason"] | null =
    null;
  for (const turn of terminalTurns) {
    if (
      turn.reportedCostUsd !== undefined &&
      Number.isFinite(turn.reportedCostUsd) &&
      turn.reportedCostUsd >= 0
    ) {
      costUsd += turn.reportedCostUsd;
      pricedTurns += 1;
      continue;
    }

    const usage = turn.turnTokenUsage;
    // Main-agent totals cannot price the whole provider turn when native
    // subagents ran unless the provider supplied the turn's own dollar total.
    if (usage?.usageStatus !== "complete" || usage.hasSubagents) {
      missingReason = "incomplete";
      continue;
    }
    const model = turnModel(turn, runsById, attemptsById, subagentsById);
    if (model === null) {
      missingReason = "incomplete";
      continue;
    }
    const priced = priceUsage(input.rates, model, usageTotals(usage), null, input.priceOverrides);
    if (priced.costSource === "unpriced") {
      missingReason ??= "unpriced";
      continue;
    }
    costUsd += priced.costUsd;
    anyModelPriced = true;
    pricedTurns += 1;
  }

  if (pricedTurns === 0) return unavailable(input.request, missingReason ?? "noUsage");

  return {
    threadId: input.request.threadId,
    revision: input.request.revision,
    availability: "available",
    costUsd,
    costSource: anyModelPriced ? "modelPriced" : "providerReported",
    completeness: missingReason === null ? "complete" : "lowerBound",
  };
}
