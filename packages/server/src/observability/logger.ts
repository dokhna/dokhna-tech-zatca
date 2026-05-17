/**
 * Pino logger with project-wide secret redaction.
 *
 * Pino's `redact` config replaces the matched paths with `[REDACTED]`
 * before serialisation. Combined with `redactSecrets` on the audit-
 * log payload, the two-layer scrub means a stray `req.body` log line
 * cannot leak an OTP / private key / API secret.
 *
 * Two strict requirements implementing operators should keep in mind:
 *
 * 1. NEVER log full request bodies for the onboarding endpoint
 *    without going through `redactSecrets` first — pino's `redact` is
 *    path-based and won't catch a stringified body.
 * 2. NEVER log the resolved `SignerMaterial` from the vault. The
 *    pino `redact` paths below catch the typical field names, but
 *    a custom log line that embeds the whole object inline as a
 *    string would slip through.
 */

import pino, { type Logger, type LoggerOptions } from "pino";

const REDACT_PATHS = [
  // Request-side
  "req.headers.authorization",
  "req.headers.Authorization",
  "req.headers.cookie",
  "req.body.otp",
  "req.body.privateKey",
  "req.body.private_key",
  "req.body.apiSecret",
  "req.body.api_secret",
  "req.body.binarySecurityToken",
  "req.body.binary_security_token",
  // Generic top-level fields (objects passed through `log.info({ ... })`)
  "otp",
  "privateKey",
  "private_key",
  "apiSecret",
  "api_secret",
  "complianceApiSecret",
  "productionApiSecret",
  "binarySecurityToken",
  "complianceBinarySecurityToken",
  "productionBinarySecurityToken",
  "authorization",
  "Authorization",
  "token",
  "bearer",
  "masterKey",
  "master_key",
  "password",
  "secret",
] as const;

/**
 * Constructor options for {@link createLogger}.
 */
export interface CreateLoggerOptions {
  readonly level?: LoggerOptions["level"];
  /**
   * Force pretty-printed output (dev-friendly) regardless of
   * `NODE_ENV`. Defaults to `NODE_ENV === 'development'`.
   */
  readonly pretty?: boolean;
  /**
   * Override the base context bound to every log line (e.g. service
   * version, deployment region).
   */
  readonly base?: Record<string, unknown>;
}

/**
 * Build a pino logger pre-configured with the project's redact list
 * + a sensible default base context. Reuse a single instance across
 * the app (the Fastify factory does this).
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const base = options.base ?? {};
  const pretty = options.pretty ?? process.env.NODE_ENV === "development";
  const transport: LoggerOptions["transport"] | undefined = pretty
    ? {
        target: "pino-pretty",
        options: { translateTime: "SYS:standard", ignore: "pid,hostname" },
      }
    : undefined;
  const opts: LoggerOptions = {
    level,
    base,
    redact: {
      paths: [...REDACT_PATHS],
      censor: "[REDACTED]",
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(transport !== undefined ? { transport } : {}),
  };
  return pino(opts);
}

/**
 * Paths pino redacts. Exported so tests can assert on the list.
 */
export const SECRET_REDACT_PATHS: ReadonlyArray<string> = REDACT_PATHS;
