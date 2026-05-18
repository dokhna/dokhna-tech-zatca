/**
 * Public surface of the server's onboarding layer.
 *
 * Wraps `core.onboard()` with tenant locking, per-scenario progress
 * persistence, vault writes, audit, and lifecycle state transitions.
 */

export {
  DEFAULT_LOCK_TTL_MS,
  type RunOnboardingArgs,
  type RunOnboardingResult,
  runOnboarding,
} from "./run.js";
