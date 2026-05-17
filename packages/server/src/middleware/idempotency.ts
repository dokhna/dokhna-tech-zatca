/**
 * Idempotency middleware.
 *
 * Mutating routes that perform external side effects (ZATCA submission,
 * onboarding OTP exchange) require an `Idempotency-Key` header so a
 * client retry within the configured window replays the cached
 * response instead of re-executing.
 *
 * Storage is pluggable via {@link IdempotencyStore}. The in-memory
 * impl shipped here is fine for single-replica deployments; multi-
 * replica deployments should plug a Redis-backed store (the
 * interface intentionally maps to Redis `SET ... EX` semantics).
 */

import { createHash } from "node:crypto";

/**
 * Stored response shape — captured on first execution, replayed on
 * matching retries.
 */
export interface CachedResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Bring-your-own idempotency store. The contract matches Redis
 * `SET NX PX <ttl>` + `GET` so production impls drop in cleanly.
 */
export interface IdempotencyStore {
  /**
   * Insert a fresh entry. Returns `true` if the entry was inserted
   * (caller proceeds to execute), `false` if a prior entry exists
   * under the same key (caller may treat as in-flight or simply
   * proceed to read).
   */
  putIfAbsent(key: string, value: CachedResponse, ttlMs: number): Promise<boolean>;
  /**
   * Fetch a stored response. Returns `null` if no entry or if the
   * entry's TTL has elapsed.
   */
  get(key: string): Promise<CachedResponse | null>;
  /**
   * Mark the entry's value (used when the in-flight request finishes
   * after the placeholder was inserted).
   */
  set(key: string, value: CachedResponse, ttlMs: number): Promise<void>;
}

interface MemoryEntry {
  value: CachedResponse;
  expiresAt: number;
}

/**
 * In-memory idempotency store. Sweeps expired entries lazily on
 * read. Suitable for single-replica deployments + tests.
 */
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, MemoryEntry>();
  return {
    async putIfAbsent(key, value, ttlMs) {
      const existing = entries.get(key);
      if (existing !== undefined && existing.expiresAt > Date.now()) {
        return false;
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return null;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttlMs) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

/**
 * Compose a unique idempotency key from the tenant + route + the
 * caller-supplied `Idempotency-Key` header. Hashes the tail so a
 * malicious caller cannot probe other tenants' keys by guessing.
 */
export function buildIdempotencyCacheKey(input: {
  tenantRef: string | undefined;
  route: string;
  presentedKey: string;
}): string {
  const tenant = input.tenantRef ?? "_admin_";
  const hash = createHash("sha256").update(input.presentedKey).digest("base64url").slice(0, 32);
  return `idem:${tenant}:${input.route}:${hash}`;
}
