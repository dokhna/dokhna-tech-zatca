/**
 * `PostgresStorageAdapter` — conformance suite wire-up.
 *
 * Uses `pg-mem` (in-process Postgres mock) so CI does not need Docker
 * or a running Postgres. The mock supports `INSERT ... ON CONFLICT
 * ... DO UPDATE`, JSONB, and SQLSTATE `23505` — the three features
 * the adapter relies on.
 *
 * Concurrency is capped at 25; `pg-mem` is single-threaded so the
 * 100-call stress is unnecessarily slow without exercising new code
 * paths.
 *
 * Note: `pg-mem`'s adapter exposes a `pg.Pool`-compatible object
 * synchronously via `adapters.createPg().Pool`. We treat it as
 * {@link PgQueryable}.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runStorageAdapterConformance } from "@dokhna-tach/zatca/test-helpers";
import { newDb } from "pg-mem";
import { createPostgresStorageAdapter, type PgQueryable } from "./adapter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let activePool: { end: () => Promise<void> } | undefined;

runStorageAdapterConformance(
  async () => {
    const db = newDb({ autoCreateForeignKeyIndices: true });
    // pg-mem's BIGSERIAL maps via `serial` — no special config needed.
    const migration = readFileSync(
      join(__dirname, "..", "migrations", "001_initial.sql"),
      "utf8",
    );
    db.public.none(migration);
    const pgAdapter = db.adapters.createPg() as {
      Pool: new () => PgQueryable & { end: () => Promise<void> };
    };
    const pool = new pgAdapter.Pool();
    activePool = pool;
    return createPostgresStorageAdapter({ pool });
  },
  {
    concurrency: 25,
    teardown: async () => {
      if (activePool !== undefined) {
        await activePool.end();
        activePool = undefined;
      }
    },
  },
);
