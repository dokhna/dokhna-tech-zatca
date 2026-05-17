/**
 * Admin-key auth helper.
 *
 * Admin endpoints (tenant registration, onboarding kickoff, API-key
 * mgmt, etc.) authenticate against a *list* of labelled keys rather
 * than a single secret. The list gives operators two operational wins:
 *
 * 1. **Rotation without downtime** — add a new entry, distribute the
 *    new key, retire the old entry on the next deploy. No window
 *    where both old and new clients are broken.
 * 2. **Attribution in the audit log** — every mutation records which
 *    label resolved the request. Lost-key incident response stops
 *    being "who used the admin key" — it's "rotate key X, audit-log
 *    everything labelled X."
 *
 * Source-of-truth shape (env var or CLI flag):
 *
 *     ZATCA_SERVER_ADMIN_KEYS=ops:k_live_aaa...,ci:k_live_bbb...
 *
 * Comma-separated entries; each entry is `label:key`. Whitespace
 * around commas and colons is tolerated. Labels are arbitrary
 * non-empty strings; keys must be at least 32 chars (loose minimum to
 * reject obvious typos).
 */

import { timingSafeEqual } from "node:crypto";

import { ZatcaAuthError, ZatcaServerError } from "../errors.js";

const MIN_KEY_LENGTH = 32;

/**
 * One admin credential, after parsing.
 */
export interface AdminKeyEntry {
  readonly label: string;
  readonly key: string;
}

/**
 * Parse the env-shaped admin-key list. Throws {@link ZatcaServerError}
 * if the input is empty, malformed, contains a duplicate label, or
 * carries a key below the minimum length. Failing eagerly at boot
 * keeps the runtime path from silently degrading into "no admin can
 * call anything."
 */
export function parseAdminKeys(raw: string): ReadonlyArray<AdminKeyEntry> {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) {
    throw new ZatcaServerError(
      "Admin keys are required. Set ZATCA_SERVER_ADMIN_KEYS=label:key[,label:key...].",
    );
  }
  const out: AdminKeyEntry[] = [];
  const seenLabels = new Set<string>();
  for (const entry of entries) {
    const idx = entry.indexOf(":");
    if (idx <= 0 || idx === entry.length - 1) {
      throw new ZatcaServerError(`Admin key entry '${entry}' must be of the form 'label:key'.`);
    }
    const label = entry.slice(0, idx).trim();
    const key = entry.slice(idx + 1).trim();
    if (label.length === 0) {
      throw new ZatcaServerError(`Admin key entry '${entry}' has an empty label.`);
    }
    if (key.length < MIN_KEY_LENGTH) {
      throw new ZatcaServerError(
        `Admin key for label '${label}' is too short (${key.length} chars; need ${MIN_KEY_LENGTH}+).`,
      );
    }
    if (seenLabels.has(label)) {
      throw new ZatcaServerError(`Duplicate admin label '${label}'.`);
    }
    seenLabels.add(label);
    out.push({ label, key });
  }
  return out;
}

/**
 * Compare two strings in constant time. Returns `false` for any length
 * mismatch (the comparison is still bound by the longer of the two so
 * timing differs only at the length-difference boundary, not the
 * content).
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Compiled admin-key verifier. Built once at boot from the parsed
 * env list, then used per-request without re-parsing.
 */
export interface AdminKeyVerifier {
  /**
   * Match a presented key against the configured list. Returns the
   * matched label or `null` if none match. Constant-time over the
   * full list — does not short-circuit on first mismatch.
   */
  verify(presented: string): { label: string } | null;
  /**
   * Pull the bearer out of an `Authorization` header value and run
   * {@link verify}. Throws {@link ZatcaAuthError} with the right
   * statusHint when the header is missing, malformed, or contains an
   * unknown key.
   */
  verifyHeader(authHeader: string | undefined): { label: string };
}

/**
 * Construct a verifier from the env-shaped string. Throws on a bad
 * input list at construction time — never at request time.
 */
export function createAdminKeyVerifier(rawAdminKeys: string): AdminKeyVerifier {
  const entries = parseAdminKeys(rawAdminKeys);
  return {
    verify(presented: string) {
      let matchedLabel: string | null = null;
      // Iterate all entries even after a match to keep timing flat
      // against the list length. The cost is trivial (one scrypt-free
      // string compare per entry).
      for (const entry of entries) {
        if (constantTimeEquals(presented, entry.key)) {
          matchedLabel = entry.label;
        }
      }
      return matchedLabel === null ? null : { label: matchedLabel };
    },
    verifyHeader(authHeader: string | undefined) {
      if (authHeader === undefined || authHeader === "") {
        throw new ZatcaAuthError("Missing Authorization header.", 401);
      }
      const bearer = extractBearer(authHeader);
      if (bearer === null) {
        throw new ZatcaAuthError("Authorization header must be of the form 'Bearer <key>'.", 401);
      }
      const match = this.verify(bearer);
      if (match === null) {
        throw new ZatcaAuthError("Unknown admin key.", 401);
      }
      return match;
    },
  };
}

/**
 * Pull the bearer token from an `Authorization: Bearer <token>`
 * header value. Returns `null` if the scheme is missing or unknown.
 * Trims surrounding whitespace; case-insensitive on the scheme.
 */
export function extractBearer(authHeader: string): string | null {
  const trimmed = authHeader.trim();
  // Match `Bearer ` then capture the rest (no trailing-whitespace
  // tolerance; a stray newline is the operator's problem to surface).
  const m = /^Bearer\s+(\S.*)$/i.exec(trimmed);
  if (m === null) return null;
  return (m[1] ?? "").trim();
}
