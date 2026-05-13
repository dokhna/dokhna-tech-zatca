/**
 * Public onboarding surface re-exported from `@dokhna-tach/zatca`.
 *
 * The `onboard` function orchestrates key generation, CSR signing,
 * compliance certificate issuance, the six-scenario compliance test
 * pack, and production CSID issuance into a single call.
 *
 * **Secret material** — `privateKey`, `complianceApiSecret`, and
 * `productionApiSecret` — is returned as plain strings. Callers MUST
 * persist these to an encrypted store and never log them. The
 * package itself writes nothing to disk.
 */

export type {
  OnboardArgs,
  OnboardingEgsInfo,
  OnboardingResult,
} from "./onboard.js";
export { onboard } from "./onboard.js";
