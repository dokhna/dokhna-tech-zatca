/**
 * Idempotency middleware.
 *
 * Mutating routes that perform external side effects (ZATCA submission,
 * onboarding OTP exchange) require an `Idempotency-Key` header so a
 * client retry within the configured window replays the cached
 * response instead of re-executing.
 *
 * The store models an explicit in-flight / committed state machine
 * (HI-11). The naive shape — caller does `get`, executes work, then
 * `set` — has a race window equal to the work's duration during which
 * a concurrent retry with the same key sees no cache entry and
 * duplicates the side-effectful work. The explicit state machine
 * closes that window: the first caller `begin`s, atomically reserving
 * an in-flight slot; the second concurrent caller sees the in-flight
 * state and gets a 409 retry-later, never executing the work.
 *
 * Storage is pluggable via {@link IdempotencyStore}. The in-memory
 * impl shipped here is fine for single-replica deployments; multi-
 * replica deployments should plug a Redis-backed store (the
 * `begin`/`commit`/`release` shape maps cleanly to Redis `SET NX PX`
 * + `SET XX PX` + `DEL`).
 */

import { createHash } from "node:crypto";

/**
 * Stored response shape — captured on `commit`, replayed on matching
 * retries.
 */
export interface CachedResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Result of {@link IdempotencyStore.begin}. The discriminant tells the
 * caller exactly which of the three protocol paths to take.
 *
 * - `claimed`  — the caller is first; MUST eventually `commit` or
 *               `release` so the slot doesn't wedge in-flight until
 *               TTL.
 * - `in-flight` — another caller holds the slot; respond 409 to the
 *               client so it retries after backoff.
 * - `replay`   — a prior caller committed a response; replay it
 *               byte-for-byte (subject to header overrides at the
 *               route layer).
 */
export type IdempotencyBeginResult =
  | { readonly kind: "claimed" }
  | { readonly kind: "in-flight" }
  | { readonly kind: "replay"; readonly response: CachedResponse };

/**
 * Idempotency store contract. The triple
 * `begin` / `commit` / `release` is a small state machine: every
 * `begin` that returns `claimed` MUST be followed by exactly one of
 * `commit` (success) or `release` (failure that should allow an
 * immediate retry). Skipping both leaves the slot wedged in-flight
 * until TTL.
 *
 * The contract intentionally mirrors Redis primitives so a
 * production deployer can drop in a Redis-backed impl without
 * changing call sites:
 *   - `begin`   → `SET <k> "<in-flight>" NX PX <ttl>` then conditional `GET`
 *   - `commit`  → `SET <k> "<committed:...>" XX PX <ttl>`
 *   - `release` → `DEL <k>`
 */
export interface IdempotencyStore {
  /**
   * Atomically reserve a slot OR fetch a prior committed response.
   * See {@link IdempotencyBeginResult} for the three branches.
   */
  begin(key: string, ttlMs: number): Promise<IdempotencyBeginResult>;
  /**
   * Publish the final response for a previously `begin`-claimed key.
   * Overwrites the in-flight placeholder and extends the TTL.
   * Throws if the key was never claimed (the caller is missing a
   * `begin`) — surfacing the misuse loudly so a future refactor
   * doesn't quietly drop replays.
   */
  commit(key: string, response: CachedResponse, ttlMs: number): Promise<void>;
  /**
   * Release a previously-claimed key without committing a response.
   * Use on the error path so the next retry can immediately re-claim
   * the slot rather than wait for TTL. Idempotent — a release of an
   * unknown key is a no-op.
   */
  release(key: string): Promise<void>;
}

type Entry =
  | { readonly status: "in-flight"; readonly expiresAt: number }
  | { readonly status: "committed"; readonly response: CachedResponse; readonly expiresAt: number };

/**
 * In-memory idempotency store. Sweeps expired entries lazily on
 * `begin`. Suitable for single-replica deployments + tests.
 */
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, Entry>();

  function readFresh(key: string): Entry | undefined {
    const entry = entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    async begin(key, ttlMs) {
      const existing = readFresh(key);
      if (existing === undefined) {
        entries.set(key, { status: "in-flight", expiresAt: Date.now() + ttlMs });
        return { kind: "claimed" };
      }
      if (existing.status === "in-flight") {
        return { kind: "in-flight" };
      }
      return { kind: "replay", response: existing.response };
    },
    async commit(key, response, ttlMs) {
      const existing = entries.get(key);
      if (existing === undefined) {
        throw new Error(
          `IdempotencyStore.commit called for unclaimed key '${key}' — missing a prior begin(). This is a programming error in the caller.`,
        );
      }
      entries.set(key, { status: "committed", response, expiresAt: Date.now() + ttlMs });
    },
    async release(key) {
      entries.delete(key);
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

/**
 * Default TTL for idempotency cache entries — 24 hours. Matches the
 * window over which a retry of a side-effectful operation
 * (onboarding, invoice issuance) is plausibly the SAME logical
 * request. Beyond this window, an `Idempotency-Key` that happens
 * to repeat is treated as a fresh request.
 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
