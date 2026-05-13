/**
 * Detect whether the OpenSSL CLI is available on `PATH`.
 *
 * ZATCA's onboarding flow (key generation + CSR generation) shells
 * out to `openssl`. We probe at module load (or on demand) and fail
 * fast with a clear error if it's missing.
 *
 * This module is intentionally side-effect free — the probe runs
 * lazily when {@link probeOpenssl} or {@link ensureOpenssl} is
 * called.
 */

import { spawn } from "node:child_process";
import { ZatcaOnboardingError } from "../types/errors.js";

/**
 * Stable result shape — `available: false` always implies
 * `version: null`.
 */
export interface OpensslProbeResult {
  available: boolean;
  version: string | null;
}

/**
 * Probes `openssl version` once and returns the result.
 *
 * - Resolves with `{ available: true, version: "OpenSSL 3.2.1 ..." }`
 *   when the binary is on `PATH` and exits 0.
 * - Resolves with `{ available: false, version: null }` when
 *   `spawn` errors (typically `ENOENT`) or `openssl` exits non-zero.
 *
 * Never throws — callers either inspect the result themselves or
 * use {@link ensureOpenssl} for the throwing variant.
 */
export function probeOpenssl(): Promise<OpensslProbeResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("openssl", ["version"]);
    } catch {
      resolve({ available: false, version: null });
      return;
    }
    let out = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      out += chunk.toString();
    });
    proc.on("error", () => resolve({ available: false, version: null }));
    proc.on("close", (code) => {
      const trimmed = out.trim();
      resolve({
        available: code === 0,
        version: trimmed.length > 0 ? trimmed : null,
      });
    });
  });
}

/** Cache so repeated `ensureOpenssl` calls don't fork-exec per request. */
let cachedProbe: Promise<OpensslProbeResult> | null = null;

/**
 * Throws `ZatcaOnboardingError` if OpenSSL is not available.
 *
 * Result is cached for the lifetime of the process — `openssl`'s
 * availability isn't going to change between calls in a single
 * process.
 *
 * @throws {ZatcaOnboardingError} when the probe reports unavailable.
 */
export async function ensureOpenssl(): Promise<OpensslProbeResult> {
  cachedProbe ??= probeOpenssl();
  const result = await cachedProbe;
  if (!result.available) {
    throw new ZatcaOnboardingError(
      "OpenSSL CLI is required for ZATCA onboarding but was not found on PATH. " +
        "Install OpenSSL or use a Docker image that includes it.",
    );
  }
  return result;
}

/**
 * Reset the internal cache. Exposed for unit tests so they can
 * simulate a clean process state between assertions.
 *
 * @internal
 */
export function resetOpensslProbeCache(): void {
  cachedProbe = null;
}
