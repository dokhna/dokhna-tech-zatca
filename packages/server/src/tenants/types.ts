/**
 * Shared types for the tenant registry layer.
 *
 * Identity vs. material vs. caller-credentials are split into three
 * interfaces (`TenantStore`, `CredentialVault`, `ApiKeyStore`) — see
 * the per-file headers for the rationale. This module holds the
 * pieces that touch all three.
 */

import type {
  CommercialRegistrationNumber,
  EGSUuid,
  TenantScope,
  VATNumber,
  ZatcaEnvironment,
} from "@dokhna-tech/zatca";

/**
 * Lifecycle state for a tenant in the registry.
 *
 * - `created`                  — registered; no ZATCA credentials yet.
 * - `onboarding`               — `onboard()` in flight; lock held.
 * - `production-ready`         — production CSID acquired and persisted.
 * - `failed`                   — the most recent onboarding attempt aborted. `onboardingProgress.lastError` holds the reason.
 * - `revoked`                  — soft-deleted; all API keys revoked; vault retained for audit retention.
 *
 * ME-26: `compliance-tests-passed` was previously enumerated as an
 * intermediate state but no code path transitions into it — the
 * onboarding flow goes straight from `onboarding` to either
 * `production-ready` or `failed`. Dead state removed to avoid
 * operator dashboards permanently showing zero rows in a filter.
 */
export type TenantState = "created" | "onboarding" | "production-ready" | "failed" | "revoked";

/**
 * Physical-address fields embedded in the CSR + UBL XML.
 *
 * Mirrors {@link "@dokhna-tech/zatca".EGSUnitInfo} `location` but
 * carries everything as strings — branded types are only needed at
 * issuance time, when the helper bridges the registry shape into
 * `EGSUnitInfo`.
 */
export interface TenantLocation {
  readonly cityName: string;
  readonly citySubdivision: string;
  readonly street: string;
  readonly plotIdentification: string;
  readonly building: string;
  readonly postalZone: string;
}

/**
 * Per-scenario onboarding status, surfaced in `GET /v1/tenants/:ref/status`.
 *
 * The keys are the compliance-scenario identifiers reported by
 * `core.runComplianceTests`. The server marks each `pending` at the
 * start of `onboard()` and flips to `passed | failed` as the
 * `onProgress` callback fires.
 */
export interface OnboardingProgress {
  readonly scenarios: Readonly<Record<string, "pending" | "passed" | "failed">>;
  readonly lastError?: string;
}

/**
 * Public view of a tenant — no secret material, no api-key hashes.
 *
 * Returned by `TenantStore.get` / `list` and over the HTTP layer.
 * Branded scope types (`vatNumber`, `egsUuid`) flow through so calls
 * to the existing `StorageAdapter` (`incrementCounter`, etc.) accept
 * them without re-validation at every request.
 */
export interface TenantRecord {
  readonly tenantRef: string;
  readonly vatNumber: VATNumber;
  readonly egsUuid: EGSUuid;
  readonly vatName: string;
  readonly crn: CommercialRegistrationNumber;
  readonly branchName: string;
  readonly branchIndustry?: string;
  readonly location: TenantLocation;
  readonly environment: ZatcaEnvironment;
  readonly state: TenantState;
  readonly onboardingProgress: OnboardingProgress;
  readonly productionCertificateExpiresAt?: Date;
  /**
   * Reserved. Webhook delivery is deferred to a later release; the
   * column / field exists so a future enable can be a flag flip, not
   * a schema change.
   */
  readonly callbackUrl?: string;
  /**
   * Server-instance identifier currently holding the onboarding lock.
   * `undefined` when no lock is held.
   */
  readonly claimedBy?: string;
  /**
   * Absolute time the current onboarding claim expires. After this
   * instant the lock can be reclaimed by another instance or via the
   * `/unlock` admin route.
   */
  readonly claimExpiresAt?: Date;
  readonly label?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * Set on soft-delete via `revoke`. Records with `deletedAt` are
   * hidden from `list` by default; pass `includeDeleted: true` to see
   * them.
   */
  readonly deletedAt?: Date;
}

/**
 * Inputs to `TenantStore.create`.
 *
 * `tenantRef` is optional — the store generates a URL-safe slug if
 * absent. The state is always `created`; callers cannot pre-seed a
 * tenant into `production-ready` to bypass onboarding.
 */
export interface CreateTenantInput {
  readonly tenantRef?: string;
  readonly vatNumber: VATNumber;
  readonly egsUuid: EGSUuid;
  readonly vatName: string;
  readonly crn: CommercialRegistrationNumber;
  readonly branchName: string;
  readonly branchIndustry?: string;
  readonly location: TenantLocation;
  readonly environment: ZatcaEnvironment;
  readonly label?: string;
  readonly callbackUrl?: string;
}

/**
 * Subset of {@link TenantRecord} mutable via `TenantStore.patch`.
 *
 * Intentionally excludes `vatNumber`, `egsUuid`, `tenantRef`,
 * `environment`, and `state` — those either identify the tenant
 * (changing them would orphan invoice records) or have dedicated
 * mutators (`setState`).
 */
export interface PatchableTenantFields {
  readonly vatName?: string;
  readonly branchName?: string;
  readonly branchIndustry?: string;
  readonly location?: TenantLocation;
  readonly label?: string;
  readonly callbackUrl?: string;
}

/**
 * Inputs to `TenantStore.list`.
 *
 * `expiringWithinDays` returns only tenants whose
 * `productionCertificateExpiresAt` is within the given window. Useful
 * for the admin "what needs renewal" query.
 */
export interface TenantListFilter {
  readonly state?: TenantState;
  readonly environment?: ZatcaEnvironment;
  readonly expiringWithinDays?: number;
  readonly includeDeleted?: boolean;
}

/**
 * Optimistic-lock options for `TenantStore.setState`.
 *
 * - `expectedFrom`     — refuse the transition unless the record is
 *                        currently in this state. Used to implement
 *                        the per-tenant onboarding mutex.
 * - `claimedBy`        — record which server instance owns the next
 *                        state. Audit + diagnostics use this.
 * - `claimExpiresAt`   — when the claim auto-releases. The next call
 *                        with `expectedFrom: "onboarding"` will
 *                        succeed for any caller after this instant
 *                        even if `claimedBy` differs.
 * - `lastError`        — failure context for `state: "failed"`. Stored
 *                        on `onboardingProgress.lastError`.
 */
export interface SetStateOptions {
  readonly expectedFrom?: TenantState;
  readonly claimedBy?: string;
  readonly claimExpiresAt?: Date;
  readonly lastError?: string;
}

/**
 * Convert a {@link TenantRecord} into the `TenantScope` shape the
 * existing core `StorageAdapter` expects. Branded types pass through
 * unchanged — no re-validation cost.
 */
export function toTenantScope(record: TenantRecord): TenantScope {
  return { vatNumber: record.vatNumber, egsUuid: record.egsUuid };
}
