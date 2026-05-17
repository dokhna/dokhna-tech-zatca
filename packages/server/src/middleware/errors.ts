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
    // 404 for any "unknown <entity>" lookup miss; 409 for state-
    // machine conflicts (CAS failures, duplicate creates, etc).
    const status = /^Unknown\b/.test(err.message) ? 404 : 409;
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
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof ZatcaError) {
    return makeBody(500, err.name, err.message, {});
  }
  if (err instanceof Error) {
    return makeBody(500, "InternalServerError", err.message, {});
  }
  return makeBody(500, "InternalServerError", "Unknown error", {});
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
