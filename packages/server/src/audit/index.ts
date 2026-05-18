/**
 * Public surface of the audit layer.
 *
 * - {@link AuditLog} contract + in-memory impl.
 * - {@link redactSecrets} helper for scrubbing payloads before they
 *   land in a row.
 */

export {
  type AuditAction,
  type AuditActor,
  type AuditEntry,
  type AuditEntryInput,
  type AuditListFilter,
  type AuditLog,
  type AuditResult,
  createMemoryAuditLog,
} from "./log.js";
export { createMongoAuditLog, type MongoAuditLogOptions } from "./log-mongo.js";
export { createPostgresAuditLog, type PostgresAuditLogOptions } from "./log-postgres.js";
export { redactSecrets } from "./redact.js";
