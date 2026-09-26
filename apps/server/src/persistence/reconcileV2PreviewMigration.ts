import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import ProjectionThreadPullRequests from "./Migrations/050_ProjectionThreadPullRequests.ts";
import ProjectionThreadMessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import ProjectionThreadTitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettleDisabledAt from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";

const splitV2MigrationNames = new Map<number, string>([
  [50, "OrchestrationV2"],
  [51, "OrchestrationV2Subagents"],
  [52, "OrchestrationV2Foundation"],
  [53, "OrchestrationV2ProviderSessionBindings"],
  [54, "OrchestrationV2ThreadLaunchWorkflows"],
  [55, "ApplicationEventSource"],
  [56, "OrchestrationV2EffectCancellation"],
  [57, "ScheduledTasks"],
  [58, "LegacyV1ImportState"],
  [59, "ApplicationEventSequenceIndexes"],
  [60, "OrchestrationV2RecoveryIndexes"],
  [61, "OrchestrationV2ShellIndexes"],
] as const);

// Published previews assigned V2 to 53, then 54. Keep their schema and import
// progress intact while reserving main's migration ids for upgrades from main.
export const reconcileV2PreviewMigration = Effect.fn("reconcileV2PreviewMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return [];
      const history = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
        readonly created_at: string;
      }>`
        SELECT migration_id, name, created_at
        FROM effect_sql_migrations
        WHERE migration_id >= 50
        ORDER BY migration_id
      `;
      const splitV2 = history.find(
        (row) => row.migration_id === 50 && row.name === "OrchestrationV2",
      );
      if (splitV2) {
        const valid =
          history.length === splitV2MigrationNames.size &&
          history.every((row) => splitV2MigrationNames.get(row.migration_id) === row.name);
        if (!valid) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade split V2 migrations with unexpected later migrations.",
          });
        }

        yield* ProjectionThreadPullRequests;
        yield* ProjectionThreadMessageContext;
        yield* ProjectionThreadTitleState;
        yield* PullRequestFilesViewed;
        yield* AutoSettleDisabledAt;
        yield* RemoveRedundantProjectionIndexes;

        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 50`;
        for (const [migrationId, name] of [
          [50, "ProjectionThreadPullRequests"],
          [51, "ProjectionThreadMessageContext"],
          [52, "ProjectionThreadTitleState"],
          [53, "PullRequestFilesViewed"],
          [54, "ProjectionThreadsAutoSettleDisabledAt"],
        ] as const) {
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (${migrationId}, ${name})
          `;
        }
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (55, 'OrchestrationV2', ${splitV2.created_at})
        `;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name)
          VALUES (56, 'RemoveRedundantProjectionIndexes')
        `;
        return [
          [50, "ProjectionThreadPullRequests"],
          [51, "ProjectionThreadMessageContext"],
          [52, "ProjectionThreadTitleState"],
          [53, "PullRequestFilesViewed"],
          [54, "ProjectionThreadsAutoSettleDisabledAt"],
          [56, "RemoveRedundantProjectionIndexes"],
        ] as const;
      }

      const previewHistory = history.filter((row) => row.migration_id >= 53);
      const legacy = previewHistory.find(
        (row) =>
          row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
      );
      if (!legacy) return [];
      const valid = previewHistory.every(
        (row) =>
          row === legacy ||
          (legacy.migration_id === 54 &&
            ((row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
              (row.migration_id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
      );
      if (!valid) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade V2 preview with unexpected later migrations.",
        });
      }
      const executed: Array<readonly [number, string]> = [];
      if (legacy.migration_id === 53) {
        yield* PullRequestFilesViewed;
        executed.push([53, "PullRequestFilesViewed"]);
      }
      yield* AutoSettleDisabledAt;
      executed.push([54, "ProjectionThreadsAutoSettleDisabledAt"]);
      // Move the later entry first to avoid a primary-key collision.
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 56 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = 55 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
      if (legacy.migration_id === 53) {
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (53, 'PullRequestFilesViewed')`;
      }
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (54, 'ProjectionThreadsAutoSettleDisabledAt')`;
      return executed;
    }),
  );
});
