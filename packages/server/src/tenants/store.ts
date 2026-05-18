/**
 * `TenantStore` — persists tenant identity + lifecycle metadata.
 *
 * Holds **no secret material** (signing keys, API secrets, BSTs all
 * live in {@link CredentialVault}) and **no API-caller credentials**
 * (bearer tokens live in {@link ApiKeyStore}). Splitting the three
 * concerns up front matches their distinct read patterns + threat
 * models, and lets sophisticated deployers point each at a different
 * backing store (Vault, KMS, Redis) without forking the package.
 *
 * Implementations MUST:
 * - Make `tenantRef` unique. `create` throws {@link ZatcaRegistryError}
 *   on collision.
 * - Treat `setState` as an atomic compare-and-swap when `expectedFrom`
 *   is supplied. The in-memory impl serializes via JS event-loop
 *   semantics; the Mongo + Postgres impls (PR2) use `findOneAndUpdate`
 *   / `UPDATE ... RETURNING` row locks.
 * - Soft-delete via `softDelete`. `get` returns `null` for deleted
 *   records; `list` hides them unless `includeDeleted: true`.
 * - Persist `Date` values at second precision or finer; do not coerce
 *   to strings on the read path.
 */

import type {
  CreateTenantInput,
  PatchableTenantFields,
  SetStateOptions,
  TenantListFilter,
  TenantRecord,
  TenantState,
} from "./types.js";

export interface TenantStore {
  /**
   * Register a new tenant. Returns the persisted record. Throws if
   * `input.tenantRef` is supplied and already exists, or if any
   * required field is empty.
   */
  create(input: CreateTenantInput): Promise<TenantRecord>;

  /**
   * Fetch by `tenantRef`. Returns `null` for unknown or soft-deleted
   * records.
   */
  get(tenantRef: string): Promise<TenantRecord | null>;

  /**
   * List tenants matching the filter. Excludes soft-deleted unless
   * `includeDeleted: true`. Ordering is implementation-defined but
   * stable within a single call.
   */
  list(filter?: TenantListFilter): Promise<ReadonlyArray<TenantRecord>>;

  /**
   * Update mutable metadata. Returns the post-update record. Throws
   * `ZatcaRegistryError` if the tenant is unknown or soft-deleted.
   * Patching `vatNumber` / `egsUuid` / `state` / `environment` is
   * not allowed — those have dedicated mutators or are immutable.
   */
  patch(tenantRef: string, patch: PatchableTenantFields): Promise<TenantRecord>;

  /**
   * Transition lifecycle state, optionally with an optimistic-lock
   * guard. When `expectedFrom` is supplied and the record's current
   * state differs, throws `ZatcaRegistryError` and does NOT mutate.
   * This is the per-tenant onboarding mutex.
   */
  setState(tenantRef: string, next: TenantState, options?: SetStateOptions): Promise<TenantRecord>;

  /**
   * Mark a single onboarding scenario `passed` or `failed`. Idempotent
   * on the (tenantRef, scenario) pair — repeat calls with the same
   * outcome are a no-op; conflicting outcomes overwrite.
   */
  recordOnboardingProgress(tenantRef: string, scenario: string, passed: boolean): Promise<void>;

  /**
   * Record the production-CSID `notAfter` instant. Surfaced by the
   * admin `?expiringWithin=` query so operators can renew before
   * expiry.
   */
  setProductionExpiry(tenantRef: string, expiresAt: Date): Promise<void>;

  /**
   * Soft-delete. The record stays in the backing store for audit
   * retention; `get` returns `null`, `list` hides it. Implementations
   * SHOULD revoke any outstanding API keys for the tenant in the same
   * transaction (the `ApiKeyStore` exposes a primitive for this in PR2;
   * the in-memory store is a no-op since auth checks fail anyway once
   * the tenant is hidden).
   */
  softDelete(tenantRef: string): Promise<void>;

  /**
   * Cheap connectivity check used by `/readyz`. Returns when the
   * backing store is reachable; throws otherwise. Implementations
   * SHOULD execute a constant-time operation (e.g. `SELECT 1`,
   * `db.runCommand({ping:1})`) rather than a paginated read so the
   * cost stays flat as the tenant population grows (ME-11).
   */
  ping(): Promise<void>;
}
