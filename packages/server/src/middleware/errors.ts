/**
 * Error → HTTP status mapping.
 *
 * One central place that translates our domain errors into the
 * response shape the API contract advertises. Route handlers throw
 * the appropriate domain error; this mapper does the rest.
 *
 * Response body shape:
 *
 *   {
 *     "error": {
 *       "name": "ZatcaRegistryError",
 *       "message": "Unknown tenant 'acme'.",
 *       "zatcaRequestId": "...",        // when available
 *       "validationResults": { ... }   // when available (ZatcaApiError)
 *     }
 *   }
 */

import {
  ZatcaApiError,
  ZatcaCertificateError,
  ZatcaError,
  ZatcaOnboardingError,
  ZatcaSigningError,
  ZatcaStorageError,
  ZatcaValidationError,
} from "@dokhna-tech/zatca";

import {
  ZatcaAuditError,
  ZatcaAuthError,
  ZatcaCipherError,
  ZatcaRegistryError,
  ZatcaServerError,
} from "../errors.js";

/**
 * Computed HTTP status code + JSON body for an error response.
 */
export interface ErrorResponse {
  readonly statusCode: number;
  readonly body: {
    readonly error: {
      readonly name: string;
      readonly message: string;
      readonly zatcaRequestId?: string;
      readonly validationResults?: unknown;
    };
  };
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Translate any thrown value into a structured response. Unknown
 * non-`Error` throws degrade to `500 Internal Server Error` with a
 * generic body — operators inspect the log to find the cause.
 */
export function mapErrorToResponse(err: unknown): ErrorResponse {
  if (err instanceof ZatcaAuthError) {
    return makeBody(err.statusHint, err.name, err.message, {});
  }
  if (err instanceof ZatcaValidationError) {
    return makeBody(400, err.name, err.message, {});
  }
  if (err instanceof ZatcaRegistryError) {
    // HI-08: route by the explicit `code` field — set at every throw
    // site in the server's own code. The `.message`-regex fallback
    // is kept only for the legacy / external-callsite case where
    // `code` is undefined; new throws MUST set `code`.
    const status = registryErrorStatus(err);
    return makeBody(status, err.name, err.message, {});
  }
  if (err instanceof ZatcaCipherError) {
    // Internal — vault corruption / kid rotation issues.
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof ZatcaAuditError) {
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof ZatcaApiError) {
    // Surface ZATCA's status code; clamp non-HTTP statuses to 502.
    const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 502;
    const headers: Record<string, string> = {};
    const reqId = err.requestId;
    if (reqId !== undefined) {
      headers["X-Zatca-Request-Id"] = reqId;
    }
    return {
      statusCode: status,
      body: {
        error: {
          name: err.name,
          message: err.message,
          ...(reqId !== undefined ? { zatcaRequestId: reqId } : {}),
          ...(err.validationResults !== undefined
            ? { validationResults: err.validationResults }
            : {}),
        },
      },
      headers,
    };
  }
  if (err instanceof ZatcaOnboardingError) {
    return makeBody(422, err.name, err.message, {});
  }
  if (err instanceof ZatcaSigningError) {
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof ZatcaCertificateError) {
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof ZatcaStorageError) {
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof ZatcaServerError) {
    // HI-07: respect `statusHint` when the throw site set one. Several
    // user-recoverable conditions in `runOnboarding` (lock conflicts,
    // bad-state transitions, compliance-test failures) throw plain
    // `ZatcaServerError`; without the hint they'd all map to 500.
    const status = err.statusHint ?? 500;
    return makeBody(status, err.name, err.message, {});
  }
  if (err instanceof ZatcaError) {
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof Error) {
    return makeBody(500, "InternalServerError", err.message, {});
  }
  return makeBody(500, "InternalServerError", "Unknown error", {});
}

/**
 * HI-08: pick the HTTP status for a {@link ZatcaRegistryError} from
 * its explicit `code` field, falling back to the historical
 * `.message`-regex routing for callers that haven't been updated.
 *
 * New throws inside this package always pass `code`; the fallback
 * exists only to preserve behaviour for binary-compat external
 * callers (downstream apps embedding the package) that construct the
 * class without it.
 */
function registryErrorStatus(err: ZatcaRegistryError): number {
  if (err.code === "not_found") return 404;
  if (err.code === "invalid") return 400;
  if (err.code === "conflict") return 409;
  // Legacy fallback — kept narrow on purpose. Once external callers
  // adopt `code`, the regex can be deleted entirely.
  return /^Unknown\b/.test(err.message) ? 404 : 409;
}

function makeBody(
  statusCode: number,
  name: string,
  message: string,
  headers: Record<string, string>,
): ErrorResponse {
  return {
    statusCode,
    body: { error: { name, message } },
    headers,
  };
}
