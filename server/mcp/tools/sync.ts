// sync_status: read-only view of a durable sync job.
//
// Job state lives in the sync_jobs table (issue #6), so this answer is the
// same on every replica — unlike the old per-replica in-memory version. A
// job whose worker stopped heartbeating reads as error ("Sync worker lost
// (heartbeat timeout)"). The tool never starts, cancels, or otherwise
// mutates jobs.

import { z } from "zod";
import { syncJobManager, type SyncJob } from "../../sync-job-manager";
import type { McpAuthContext } from "../../oauth/middleware";
import type { ToolRegistrar } from "../register";
import { ok, err } from "../format";

function trimJob(job: SyncJob) {
  return {
    id: job.id,
    kind: job.kind,
    show_id: job.showId,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    completed_shows: job.completedShows,
    total_shows: job.totalShows,
    eta_seconds: job.etaSeconds,
    episodes_imported: job.episodesImported,
    episodes_updated: job.episodesUpdated,
    errors: job.errors,
    last_message: job.lastMessage,
    started_at: job.startedAt.toISOString(),
    finished_at: job.finishedAt ? job.finishedAt.toISOString() : null,
  };
}

export function registerSyncTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  tools.registerReadTool(
    "sync_status",
    "Status of an async sync job (show sync, library import, episode import). " +
      "Job state is durable in Postgres and consistent across replicas; a job " +
      "whose worker stopped heartbeating is reported as error. " +
      "Read-only: it cannot start or cancel jobs. " +
      "Omit job_id to get the user's most recent sync job.",
    {
      job_id: z
        .string()
        .min(1)
        .optional()
        .describe("Sync job id. If omitted, the user's most recent sync job is returned."),
    },
    async ({ job_id }) => {
      const job = job_id
        ? await syncJobManager.getJob(job_id, auth.userId)
        : await syncJobManager.getLatestJob(auth.userId);
      if (!job) {
        return err(
          job_id ? `unknown sync job: ${job_id}` : "no sync jobs found for this user"
        );
      }
      return ok({ job: trimJob(job) });
    }
  );
}
