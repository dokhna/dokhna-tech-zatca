/**
 * Simple in-process counting semaphore.
 *
 * Used by ME-27 to cap the number of concurrent `/onboard` and
 * `/credentials/rotate` requests in flight. A privileged admin (or
 * compromised key) firing parallel onboarding requests across many
 * tenants would otherwise pin the DB pool + ZATCA outbound
 * connections for up to 3 minutes each.
 *
 * The semaphore is intentionally NOT a queue — when full, `tryAcquire`
 * returns `false` immediately so the route can shed load with a
 * 503 + `Retry-After`. Queuing would defer the load-shedding to TCP
 * timeouts and amplify the problem.
 */

/**
 * Counting semaphore that returns false when full (no queueing).
 */
export interface Semaphore {
  /**
   * Try to acquire a slot. Returns a release function on success,
   * `null` when no slot is available. Caller MUST invoke the
   * returned release exactly once.
   */
  tryAcquire(): (() => void) | null;
  /** Current in-flight count. Exposed for metrics + diagnostics. */
  readonly inFlight: number;
  /** Configured cap (immutable). */
  readonly capacity: number;
}

/**
 * Build a counting semaphore with the given capacity.
 */
export function createSemaphore(capacity: number): Semaphore {
  if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isInteger(capacity)) {
    throw new Error(`Semaphore capacity must be a positive integer; got ${String(capacity)}.`);
  }
  let count = 0;
  return {
    tryAcquire() {
      if (count >= capacity) return null;
      count += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
      };
    },
    get inFlight() {
      return count;
    },
    capacity,
  };
}
