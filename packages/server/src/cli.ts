#!/usr/bin/env node
/**
 * `zatca-server` CLI entrypoint.
 *
 * Reads config from env, picks a storage + registry driver based on
 * `STORAGE_DRIVER` / `DATABASE_URL`, and boots the Fastify app.
 *
 * Storage drivers in v1:
 *   - `memory`   — in-process only; for dev / smoke tests.
 *   - `mongo`    — needs `MONGO_URI` env var.
 *   - `postgres` — needs `DATABASE_URL` env var.
 *
 * Drivers are resolved lazily via `await import(...)` so callers
 * using only one driver don't pay the cost of installing both peer
 * deps.
 */

import process from "node:process";

import type { StorageAdapter } from "@dokhna-tech/zatca";
import { buildApp } from "./app.js";
import type { AuditLog } from "./audit/index.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { ZatcaServerError } from "./errors.js";
import type { WithUnitOfWork } from "./routes/index.js";
import type { ApiKeyStore } from "./tenants/api-key-store.js";
import type { CredentialVault } from "./tenants/credential-vault.js";
import type { TenantStore } from "./tenants/store.js";

type Driver = "memory" | "mongo" | "postgres";

interface BootedDeps {
  readonly storage: StorageAdapter;
  readonly registry: {
    readonly tenants: TenantStore;
    readonly vault: CredentialVault;
    readonly apiKeys: ApiKeyStore;
  };
  readonly auditLog: AuditLog;
  /**
   * Transactional unit-of-work primitive. Postgres provides a real
   * one wired around `withPgTransaction` (CR-01); memory + Mongo
   * leave it undefined and let `buildApp` fall through to its
   * pass-through default.
   */
  readonly withUnitOfWork?: WithUnitOfWork;
  /** Driver-specific cleanup (close pool / connection). */
  readonly shutdown: () => Promise<void>;
}

function resolveDriver(env: NodeJS.ProcessEnv): Driver {
  const raw = env.STORAGE_DRIVER ?? "memory";
  if (raw !== "memory" && raw !== "mongo" && raw !== "postgres") {
    throw new ZatcaServerError(
      `STORAGE_DRIVER must be one of: memory | mongo | postgres. Got: '${raw}'`,
    );
  }
  return raw;
}

async function bootMemory(config: ServerConfig): Promise<BootedDeps> {
  const { createAesGcmCipher } = await import("./crypto/aes-gcm-cipher.js");
  const cipher = createAesGcmCipher({
    keyring: config.masterKeys,
    activeKid: config.activeKid,
  });
  const { createMemoryRegistry } = await import("./tenants/registry-memory.js");
  const { createMemoryAuditLog } = await import("./audit/log.js");
  const memoryStorageMod = (await import("@dokhna-tech/zatca-storage-memory")) as {
    createMemoryStorageAdapter: () => StorageAdapter;
  };
  const storage = memoryStorageMod.createMemoryStorageAdapter();
  const registry = createMemoryRegistry({
    cipher,
    env: config.tenantBearerEnv,
  });
  const auditLog = createMemoryAuditLog();
  return {
    storage,
    registry,
    auditLog,
    shutdown: async () => {
      /* nothing to close */
    },
  };
}

async function bootMongo(config: ServerConfig, env: NodeJS.ProcessEnv): Promise<BootedDeps> {
  const uri = env.MONGO_URI;
  if (uri === undefined || uri === "") {
    throw new ZatcaServerError("STORAGE_DRIVER=mongo requires MONGO_URI to be set.");
  }
  const mongoose = (await import("mongoose")).default;
  const connection = mongoose.createConnection(uri);
  await connection.asPromise();
  const { createMongoStorageAdapter } = (await import("@dokhna-tech/zatca-storage-mongo")) as {
    createMongoStorageAdapter: (opts: { connection: typeof connection }) => StorageAdapter;
  };
  const storage = createMongoStorageAdapter({ connection });
  const { createMongoRegistry } = await import("./tenants/registry-mongo.js");
  const { createMongoAuditLog } = await import("./audit/log-mongo.js");
  const { createAesGcmCipher } = await import("./crypto/aes-gcm-cipher.js");
  const cipher = createAesGcmCipher({
    keyring: config.masterKeys,
    activeKid: config.activeKid,
  });
  const registry = createMongoRegistry({
    connection,
    cipher,
    env: config.tenantBearerEnv,
  });
  const auditLog = createMongoAuditLog({ connection });
  return {
    storage,
    registry,
    auditLog,
    shutdown: async () => {
      await connection.close();
    },
  };
}

async function bootPostgres(config: ServerConfig, env: NodeJS.ProcessEnv): Promise<BootedDeps> {
  const uri = env.DATABASE_URL;
  if (uri === undefined || uri === "") {
    throw new ZatcaServerError("STORAGE_DRIVER=postgres requires DATABASE_URL to be set.");
  }
  const pgMod = await import("pg");
  const PoolCtor =
    (pgMod as { default?: { Pool: new (cfg: { connectionString: string }) => unknown } }).default
      ?.Pool ??
    (pgMod as unknown as { Pool: new (cfg: { connectionString: string }) => unknown }).Pool;
  const pool = new PoolCtor({ connectionString: uri }) as {
    end: () => Promise<void>;
    query: (text: string, values?: ReadonlyArray<unknown>) => Promise<unknown>;
  };
  const { createPostgresStorageAdapter } = (await import(
    "@dokhna-tech/zatca-storage-postgres"
  )) as {
    createPostgresStorageAdapter: (opts: { pool: typeof pool }) => StorageAdapter;
  };
  const storage = createPostgresStorageAdapter({ pool });
  const { createPostgresRegistry, createPostgresWithUnitOfWork } = await import(
    "./tenants/registry-postgres.js"
  );
  const { createPostgresAuditLog } = await import("./audit/log-postgres.js");
  const { createAesGcmCipher } = await import("./crypto/aes-gcm-cipher.js");
  const cipher = createAesGcmCipher({
    keyring: config.masterKeys,
    activeKid: config.activeKid,
  });
  const registry = createPostgresRegistry({
    pool: pool as never,
    cipher,
    env: config.tenantBearerEnv,
  });
  const auditLog = createPostgresAuditLog({ pool: pool as never });
  // Real transactional unit-of-work: each call opens BEGIN, builds
  // tx-scoped stores + audit log on a checked-out client, COMMITs on
  // resolve / ROLLBACKs on throw. Route handlers that mutate + audit
  // use this so the two writes share a single transaction (CR-01).
  const withUnitOfWork: WithUnitOfWork = createPostgresWithUnitOfWork<
    TenantStore,
    CredentialVault,
    ApiKeyStore,
    AuditLog
  >({
    pool: pool as never,
    cipher,
    env: config.tenantBearerEnv,
    auditLogFactory: (opts) => createPostgresAuditLog(opts),
  });
  return {
    storage,
    registry,
    auditLog,
    withUnitOfWork,
    shutdown: async () => {
      await pool.end();
    },
  };
}

async function main(): Promise<void> {
  // Pin the timezone before any Date.toString() call lands in a log.
  const config = loadConfig(process.env);
  process.env.TZ = config.timezone;

  const driver = resolveDriver(process.env);
  const booted =
    driver === "memory"
      ? await bootMemory(config)
      : driver === "mongo"
        ? await bootMongo(config, process.env)
        : await bootPostgres(config, process.env);

  const app = await buildApp({
    config,
    registry: booted.registry,
    storage: booted.storage,
    auditLog: booted.auditLog,
    ...(booted.withUnitOfWork !== undefined ? { withUnitOfWork: booted.withUnitOfWork } : {}),
  });

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      driver,
      host: config.host,
      port: config.port,
      timezone: config.timezone,
      tenantBearerEnv: config.tenantBearerEnv,
    },
    "zatca-server listening",
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await booted.shutdown();
    } catch (err) {
      app.log.error({ err }, "shutdown error");
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

const isMainModule =
  process.argv[1] !== undefined &&
  (import.meta.url === `file://${process.argv[1]}` ||
    import.meta.url.endsWith(process.argv[1].split("/").pop() ?? ""));

if (isMainModule) {
  main().catch((err) => {
    // Fall back to console — pino isn't constructed yet if boot failed.
    console.error("[zatca-server] fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
