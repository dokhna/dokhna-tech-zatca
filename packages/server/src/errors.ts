/**
 * Error hierarchy for `@dokhna-tech/zatca-server`.
 *
 * All errors thrown by the server package extend `ZatcaServerError`,
 * which extends the core package's `ZatcaError`. Consumers can therefore
 * catch either the package-specific base or the cross-package base.
 *
 * Each subclass exists so callers — and the HTTP layer landing in a
 * later PR — can translate a domain failure into the correct status
 * code without inspecting `.message` strings.
 */

import { ZatcaError } from "@dokhna-tech/zatca";

/**
 * Base class for every error originating in `@dokhna-tech/zatca-server`.
 *
 * Extends the core `ZatcaError` so a single
 * `catch (e) { if (e instanceof ZatcaError) ... }` block still works
 * across both packages.
 */
export class ZatcaServerError extends ZatcaError {}

/**
 * Cipher / vault failure — bad ciphertext envelope, unknown `kid`,
 * malformed master-key configuration, or an underlying `crypto`
 * primitive throwing.
 */
export class ZatcaCipherError extends ZatcaServerError {}

/**
 * Tenant registry consistency error — duplicate `tenantRef`, optimistic
 * lock failure during onboarding state transitions, or attempt to load
 * a soft-deleted record.
 */
export class ZatcaRegistryError extends ZatcaServerError {}

/**
 * Authentication / authorization failure — unknown admin key, expired
 * tenant bearer, tenant-ref mismatch between URL and bearer, or a
 * malformed `Authorization` header.
 *
 * The HTTP layer maps this to `401` (no/invalid creds) or `403`
 * (creds OK but not authorized for the target). The `statusHint`
 * disambiguates without forcing the route handler to re-read the
 * message.
 */
export class ZatcaAuthError extends ZatcaServerError {
  public readonly statusHint: 401 | 403;

  constructor(message: string, statusHint: 401 | 403, cause?: unknown) {
    super(message, cause);
    this.statusHint = statusHint;
  }
}

/**
 * Audit-log write failure. Bubbled out of the registry layer when an
 * audit row cannot be persisted in the same transaction as the
 * mutation it describes — the mutation MUST be rolled back to keep
 * the append-only audit trail honest.
 */
export class ZatcaAuditError extends ZatcaServerError {}
