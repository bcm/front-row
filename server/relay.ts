// Shared relay machinery for table-backed work queues: FIFO claim via
// SELECT ... FOR UPDATE SKIP LOCKED, so concurrent workers (autoscale
// replicas, or a worker racing a previous tick) never double-claim a row.
//
// Built for the TVMaze pace queue (issue #5); the outbox drain (#12) reuses
// this against the events table (eligible: processed_at IS NULL,
// claim: SET processed_by = <worker>, ...).
//
// Raw SQL, not the query builder: drizzle's pg builder has no FOR UPDATE
// support, and the claim must be a single atomic statement. The table name
// and clauses come from internal constants, never user input. Claimed rows
// must carry created_at (drain order); single-word column names are returned
// as-is by the driver.

import { pool } from "./db";

export interface ClaimSpec {
  /** Trusted internal table name. */
  table: string;
  /** Rows eligible to claim, e.g. "status = 'queued'". */
  eligibleWhere: string;
  /** SET clause applied on claim, e.g. "status = 'claimed', claimed_at = now()". */
  claimSet: string;
  limit?: number;
}

/**
 * Atomically claim up to `limit` eligible rows, oldest first.
 * Returns the claimed rows with their post-claim values.
 */
export async function claimRelayRows<T = Record<string, unknown>>(
  spec: ClaimSpec
): Promise<T[]> {
  const limit = spec.limit ?? 1;
  const { rows } = await pool.query(
    `WITH eligible AS (
       SELECT id FROM ${spec.table}
       WHERE ${spec.eligibleWhere}
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE ${spec.table} AS t
     SET ${spec.claimSet}
     FROM eligible
     WHERE t.id = eligible.id
     RETURNING t.*`,
    [limit]
  );
  return rows as T[];
}
