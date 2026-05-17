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
 *
 * `statusHint` lets callers signal the intended HTTP status without
 * forcing the central error mapper to inspect `.message`. The mapper
 * defaults to 500 when `statusHint` is undefined — the historical
 * behaviour for this class. Concrete subclasses that want a tighter
 * default (`ZatcaAuthError` → 401/403) can either set `statusHint` in
 * their constructor or override this base entirely. (HI-07.)
 */
export class ZatcaServerError extends ZatcaError {
  public readonly statusHint?: number;

  constructor(message: string, cause?: unknown, options?: { statusHint?: number }) {
    super(message, cause);
    if (options?.statusHint !== undefined) {
      this.statusHint = options.statusHint;
    }
  }
}

/**
 * Cipher / vault failure — bad ciphertext envelope, unknown `kid`,
 * malformed master-key configuration, or an underlying `crypto`
 * primitive throwing.
 */
export class ZatcaCipherError extends ZatcaServerError {}

/**
 * Reason code on a {@link ZatcaRegistryError}, used by the central
 * error mapper to pick the HTTP status without regex-matching the
 * error message (HI-08). Throw sites set this explicitly so a future
 * rewording of the message doesn't silently flip the wire contract.
 *
 * - `not_found` — referenced row does not exist (→ 404).
 * - `conflict` — optimistic-lock or state-machine violation (→ 409).
 * - `invalid` — caller-supplied input violates a constraint (→ 400).
 */
export type ZatcaRegistryErrorCode = "not_found" | "conflict" | "invalid";

/**
 * Tenant registry consistency error — duplicate `tenantRef`, optimistic
 * lock failure during onboarding state transitions, or attempt to load
 * a soft-deleted record.
 *
 * The optional `code` field disambiguates the HTTP status the mapper
 * should pick. Pre-HI-08 callers that omit `code` fall back to the
 * historical regex-on-message routing — preserved for binary-compat
 * with any external code that constructs this class without a code.
 */
export class ZatcaRegistryError extends ZatcaServerError {
  public readonly code?: ZatcaRegistryErrorCode;

  constructor(
    message: string,
    options?: { code?: ZatcaRegistryErrorCode; cause?: unknown },
  ) {
    super(message, options?.cause);
    if (options?.code !== undefined) {
      this.code = options.code;
    }
  }
}

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
  public override readonly statusHint: 401 | 403;

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
