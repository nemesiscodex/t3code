import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { RateTable } from "./usagePricing.ts";
import { summarizeThreadUsageCost, type ThreadUsageProjection } from "./threadUsageCost.ts";

const now = DateTime.makeUnsafe("2026-09-17T12:00:00.000Z");
const threadId = ThreadId.make("thread-cost");
const runId = RunId.make("run-cost");
const attemptId = RunAttemptId.make("attempt-cost");
const nodeId = NodeId.make("node-cost");
const providerThreadId = ProviderThreadId.make("provider-thread-cost");
const providerInstanceId = ProviderInstanceId.make("codex");

const run: OrchestrationV2Run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId,
  modelSelection: { instanceId: providerInstanceId, model: "priced-model" },
  providerThreadId,
  userMessageId: MessageId.make("message-cost"),
  rootNodeId: nodeId,
  activeAttemptId: attemptId,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
};

const attempt: OrchestrationV2RunAttempt = {
  id: attemptId,
  runId,
  attemptOrdinal: 1,
  rootNodeId: nodeId,
  providerInstanceId,
  providerThreadId,
  providerTurnId: ProviderTurnId.make("turn-cost"),
  reason: "initial",
  status: "completed",
  startedAt: now,
  completedAt: now,
};

function turn(overrides: Partial<OrchestrationV2ProviderTurn> = {}): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make("turn-cost"),
    providerThreadId,
    nodeId,
    runAttemptId: attemptId,
    nativeTurnRef: null,
    ordinal: 1,
    status: "completed",
    startedAt: now,
    completedAt: now,
    turnTokenUsage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100,
      hasSubagents: false,
    },
    ...overrides,
  };
}

function projection(providerTurns: readonly OrchestrationV2ProviderTurn[]): ThreadUsageProjection {
  return {
    runs: [run],
    attempts: [attempt],
    subagents: [],
    providerTurns,
  };
}

const rates: RateTable = new Map([
  [
    "priced-model",
    {
      inputCostPerToken: 0.001,
      outputCostPerToken: 0.002,
      cacheReadCostPerToken: 0.0001,
      cacheCreationCostPerToken: 0.001,
    },
  ],
]);

const request = { threadId, revision: "run-cost:complete" } as const;

describe("thread usage cost", () => {
  it("prices complete turn usage with the run's model", () => {
    const result = summarizeThreadUsageCost({ request, projection: projection([turn()]), rates });

    assert.strictEqual(result.availability, "available");
    if (result.availability !== "available") return;
    assert.strictEqual(result.costSource, "modelPriced");
    assert.strictEqual(result.completeness, "complete");
    assert.closeTo(result.costUsd, 0.84, 1e-12);
  });

  it("prefers a provider-reported turn cost even when subagent token usage is incomplete", () => {
    const result = summarizeThreadUsageCost({
      request,
      projection: projection([
        turn({
          reportedCostUsd: 1.34,
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            hasSubagents: true,
          },
        }),
      ]),
      rates: new Map(),
    });

    assert.deepEqual(result, {
      threadId,
      revision: request.revision,
      availability: "available",
      costUsd: 1.34,
      costSource: "providerReported",
      completeness: "complete",
    });
  });

  it("omits running turns so a settled total stays usable during the next turn", () => {
    const result = summarizeThreadUsageCost({
      request,
      projection: projection([
        turn(),
        turn({
          id: ProviderTurnId.make("turn-running"),
          status: "running",
          completedAt: null,
          turnTokenUsage: undefined,
        }),
      ]),
      rates,
    });

    assert.strictEqual(result.availability, "available");
    if (result.availability !== "available") return;
    assert.closeTo(result.costUsd, 0.84, 1e-12);
  });

  it("returns a lower bound when only some terminal turns have complete usage", () => {
    const result = summarizeThreadUsageCost({
      request,
      projection: projection([
        turn(),
        turn({
          id: ProviderTurnId.make("turn-partial"),
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            inputTokens: 10,
            hasSubagents: false,
          },
        }),
      ]),
      rates,
    });

    assert.strictEqual(result.availability, "available");
    if (result.availability !== "available") return;
    assert.strictEqual(result.completeness, "lowerBound");
    assert.closeTo(result.costUsd, 0.84, 1e-12);
  });

  it("returns a lower bound when settled usage is followed by a terminal turn without usage", () => {
    const result = summarizeThreadUsageCost({
      request,
      projection: projection([
        turn(),
        turn({
          id: ProviderTurnId.make("turn-cancelled"),
          status: "cancelled",
          turnTokenUsage: undefined,
        }),
      ]),
      rates,
    });

    assert.strictEqual(result.availability, "available");
    if (result.availability !== "available") return;
    assert.strictEqual(result.completeness, "lowerBound");
    assert.closeTo(result.costUsd, 0.84, 1e-12);
  });
});
