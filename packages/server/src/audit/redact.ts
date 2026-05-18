/**
 * `redactSecrets` — deep-scrub a request/response payload before it
 * lands in the audit log or a structured log line.
 *
 * The list of redacted keys is conservative: any of these names at
 * any depth gets replaced with `"[REDACTED]"`. Adding new keys is
 * intentionally cheap.
 *
 * Pino's `redact` config will catch top-level fields at log time;
 * this helper exists so the *audit* payload — which we deliberately
 * persist long-term — never gets a secret into the row by accident.
 */

// Sensitive key matching is case-insensitive — operator-supplied
// payloads frequently come from JSON that may use camelCase,
// snake_case, or arbitrary mixed-case. Lowercase the SET and the
// key-under-comparison before lookup so `APIKey`, `apiKEY`, and
// `apikey` all match. (HI-02.)
const SENSITIVE_KEYS = new Set<string>([
  // ZATCA secret material
  "privatekey",
  "private_key",
  "apisecret",
  "api_secret",
  "complianceapisecret",
  "productionapisecret",
  "binarysecuritytoken",
  "binary_security_token",
  "compliancebinarysecuritytoken",
  "productionbinarysecuritytoken",
  // Generic API key naming variants
  "apikey",
  "api_key",
  // OTP burned during onboarding
  "otp",
  // Caller-presented credentials
  "authorization",
  "token",
  "bearer",
  // Cipher master keys (in case a misconfigured caller passes one)
  "masterkey",
  "master_key",
  "masterkeys",
  // PEM / cert material — not always strictly secret, but
  // PII-adjacent in many compliance regimes; safer to redact than
  // surface in long-retention audit storage.
  "csr",
  "csid",
  "pem",
  "pemcertificate",
  "compliancecsidvalue",
  "productioncsidvalue",
  // Signed XML often embeds private key digests + invoice content
  // that should not be reflected back into the audit payload.
  "signature",
  "signaturevalue",
  "signedxml",
  // Generic
  "password",
  "secret",
]);

// Regex fallback: catch *secret*, *token*, *password* variants the
// explicit list misses. We deliberately do NOT match "key" alone
// because it's too generic (object indexes are routinely named
// "key") — but the explicit list covers the high-risk key names
// (privateKey, apiKey, masterKey).
const SENSITIVE_RE = /(secret|token|password)/i;

const REDACTED = "[REDACTED]";

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return true;
  return SENSITIVE_RE.test(key);
}

/**
 * Deep-clone the payload, replacing values under any sensitive key
 * with `"[REDACTED]"`. Arrays are walked element-wise; objects walked
 * key-wise; primitives passed through. Cycles are tolerated (the same
 * object reference appearing twice doesn't cause infinite recursion).
 */
export function redactSecrets<T>(input: T): T {
  return walk(input, new WeakMap()) as T;
}

/**
 * Maximum serialized size (UTF-8 bytes) for an audit-log payload.
 * Set deliberately small — the audit table holds business events,
 * not request dumps. Larger payloads are replaced with a stub
 * recording the original size so an operator can investigate.
 *
 * ME-25 from REVIEW.md.
 */
export const MAX_AUDIT_PAYLOAD_BYTES = 16 * 1024;

/**
 * Cap the serialized size of an audit-log payload. Called by every
 * `AuditLog.write` impl before the row hits durable storage so a
 * caller cannot DoS the audit table by writing a 100MB blob into
 * the payload field. A truncated payload is replaced with a small
 * stub recording the original size; the original is dropped (the
 * audit log is not a request archive).
 *
 * Returns the original payload reference when within the cap so the
 * common case is allocation-free.
 */
export function capAuditPayload(
  payload: Readonly<Record<string, unknown>> | undefined,
  maxBytes: number = MAX_AUDIT_PAYLOAD_BYTES,
): Readonly<Record<string, unknown>> | undefined {
  if (payload === undefined) return undefined;
  const serialized = JSON.stringify(payload);
  const size = Buffer.byteLength(serialized, "utf8");
  if (size <= maxBytes) return payload;
  return {
    _truncated: true,
    originalBytes: size,
    maxBytes,
    note: "Audit payload exceeded the configured size cap and was dropped. See server log for context.",
  };
}

function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (seen.has(value as object)) {
    return seen.get(value as object);
  }

  // HI-01: Buffer / TypedArray secret values must never be walked
  // into. Previously a Buffer holding a private key reached
  // `Object.entries(value)` and was serialized as `{"0":137,"1":42,
  // ...}` — bytes intact, fully recoverable from the JSON. The
  // redactor's whole purpose is to make audit-log payloads safe to
  // read; binary blobs need to be treated as opaque.
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const byteLength = (value as { byteLength?: number }).byteLength;
    return typeof byteLength === "number" ? `[REDACTED:Buffer/${byteLength}]` : "[REDACTED:Buffer]";
  }

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value as object, out);
    for (const item of value) {
      out.push(walk(item, seen));
    }
    return out;
  }

  // Plain object (or anything we treat as one). Dates / Maps / Sets
  // are passed through as-is — the audit log doesn't expect them
  // and pre-serializing here would lose information.
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    return value;
  }

  const out: Record<string, unknown> = {};
  seen.set(value as object, out);
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = walk(child, seen);
    }
  }
  return out;
}
