/**
 * Error hierarchy for the ZATCA core package.
 *
 * All errors thrown by `@dokhna-tech/zatca` extend `ZatcaError`, so
 * users can `catch (err) { if (err instanceof ZatcaError) ... }` and
 * narrow further on subclasses or `err.name`.
 *
 * Each subclass exists so consumers can build domain-specific recovery
 * (e.g. retry on `ZatcaApiError` with `statusCode >= 500`, surface
 * `ZatcaValidationError` to the end user, escalate
 * `ZatcaCertificateError` to ops, etc.).
 */

/**
 * Base class for every error originating in this package.
 *
 * The optional `cause` follows the ECMA 2022 standard `Error.cause`
 * shape — used to chain a low-level error (e.g. an `OpenSSL` non-zero
 * exit, an HTTP transport error) inside a higher-level domain error.
 */
export class ZatcaError extends Error {
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    if (cause !== undefined) {
      this.cause = cause;
    }
    // Preserve V8's clean stack trace if available.
    const ctor = Error as unknown as {
      captureStackTrace?: (
        target: object,
        constructorOpt?: new (...args: never[]) => unknown,
      ) => void;
    };
    if (typeof ctor.captureStackTrace === "function") {
      ctor.captureStackTrace(this, this.constructor as new (...args: never[]) => unknown);
    }
  }
}

/**
 * Input failed a runtime validation guard (branded-type factory or
 * zod schema). The caller passed invalid data — not a server fault.
 */
export class ZatcaValidationError extends ZatcaError {}

/**
 * The ZATCA HTTP API responded with a non-2xx status, or its envelope
 * indicated rejection.
 *
 * - `statusCode`: HTTP status from the ZATCA server.
 * - `validationResults`: parsed `validationResults` block from the
 *   ZATCA error envelope (info / warning / error messages). Kept as
 *   `unknown` here; Phase 4 narrows it.
 * - `requestId`: ZATCA's `requestId` header / payload field, if any —
 *   for support tickets.
 * - `rawResponse`: the unparsed response body, attached for
 *   debuggability.
 */
export class ZatcaApiError extends ZatcaError {
  public readonly statusCode: number;
  public readonly validationResults?: unknown;
  public readonly requestId?: string;
  public readonly rawResponse?: unknown;

  constructor(
    message: string,
    statusCode: number,
    validationResults?: unknown,
    requestId?: string,
    rawResponse?: unknown,
  ) {
    super(message);
    this.statusCode = statusCode;
    if (validationResults !== undefined) this.validationResults = validationResults;
    if (requestId !== undefined) this.requestId = requestId;
    if (rawResponse !== undefined) this.rawResponse = rawResponse;
  }
}

/**
 * XML signing / hashing / canonicalization failed
 * (bad key, malformed XML, OpenSSL non-zero exit while signing, etc.).
 */
export class ZatcaSigningError extends ZatcaError {}

/**
 * X.509 certificate parse / validity / verification failed
 * (expired cert, malformed PEM, unsupported curve, mismatch between
 * cert and provided key).
 */
export class ZatcaCertificateError extends ZatcaError {}

/**
 * The onboarding flow (CSR generation, compliance / production CSID
 * issuance, OTP exchange) failed.
 */
export class ZatcaOnboardingError extends ZatcaError {}

/**
 * The configured `StorageAdapter` threw or returned an inconsistent
 * state (e.g. counter not monotonic, missing previous hash).
 */
export class ZatcaStorageError extends ZatcaError {}
