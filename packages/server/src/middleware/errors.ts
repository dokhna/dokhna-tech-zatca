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
      /**
       * For `ZatcaApiError` only: the raw upstream status returned
       * by the ZATCA gateway. The wire `statusCode` may differ —
       * 401/403/429 from ZATCA are re-mapped to 502/502/503 so a
       * client sees a downstream-service status, not a misleading
       * auth status (ME-02). Inspect `upstreamStatus` to see what
       * ZATCA actually said.
       */
      readonly upstreamStatus?: number;
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
    // ME-02: re-map upstream statuses so they don't mislead the
    // client about what failed. ZATCA's 401/403 means the server's
    // stored credentials are revoked or expired — NOT the client's
    // bearer; passing 401 through prompts ops tickets for an auth
    // problem the caller can't fix. ZATCA's 429 is a server-side
    // backpressure signal — again, surface it as a downstream
    // condition the caller should back off on, not a per-caller
    // rate limit. All other 4xx (validation errors etc.) pass
    // through unchanged because they reflect a real
    // caller-recoverable condition. The upstream status survives
    // inside the body for client debugging.
    const upstream = err.statusCode;
    let status: number;
    if (upstream === 401 || upstream === 403) {
      status = 502;
    } else if (upstream === 429) {
      status = 503;
    } else if (upstream >= 400 && upstream < 600) {
      status = upstream;
    } else {
      status = 502;
    }
    const headers: Record<string, string> = {};
    const reqId = err.requestId;
    if (reqId !== undefined) {
      headers["X-Zatca-Request-Id"] = reqId;
    }
    if (status === 503) {
      headers["retry-after"] = "30";
    }
    return {
      statusCode: status,
      body: {
        error: {
          name: err.name,
          message: err.message,
          upstreamStatus: upstream,
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
    // Some Fastify plugins (e.g. `@fastify/rate-limit`) throw an
    // Error with a `statusCode` field rather than a recognised
    // ZATCA error class. Honour that field so the wire-side status
    // is correct (429 for rate-limit, 413 for too-large, etc.)
    // instead of an opaque 500.
    const stamped = (err as { statusCode?: unknown }).statusCode;
    if (typeof stamped === "number" && stamped >= 400 && stamped < 600) {
      return makeBody(stamped, "InternalServerError", err.message, {});
    }
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
