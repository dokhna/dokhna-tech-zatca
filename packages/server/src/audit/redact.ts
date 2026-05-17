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

const SENSITIVE_KEYS = new Set<string>([
  // ZATCA secret material
  "privateKey",
  "private_key",
  "apiSecret",
  "api_secret",
  "complianceApiSecret",
  "productionApiSecret",
  "binarySecurityToken",
  "binary_security_token",
  "complianceBinarySecurityToken",
  "productionBinarySecurityToken",
  // OTP burned during onboarding
  "otp",
  // Caller-presented credentials
  "authorization",
  "Authorization",
  "token",
  "bearer",
  // Cipher master keys (in case a misconfigured caller passes one)
  "masterKey",
  "master_key",
  // Generic
  "password",
  "secret",
]);

const REDACTED = "[REDACTED]";

/**
 * Deep-clone the payload, replacing values under any sensitive key
 * with `"[REDACTED]"`. Arrays are walked element-wise; objects walked
 * key-wise; primitives passed through. Cycles are tolerated (the same
 * object reference appearing twice doesn't cause infinite recursion).
 */
export function redactSecrets<T>(input: T): T {
  return walk(input, new WeakMap()) as T;
}

function walk(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (seen.has(value as object)) {
    return seen.get(value as object);
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
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = walk(child, seen);
    }
  }
  return out;
}
