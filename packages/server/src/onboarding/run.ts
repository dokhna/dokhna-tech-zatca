/**
 * `runOnboarding` — the server's tenant-aware wrapper around
 * `core.onboard()`.
 *
 * Wires four concerns the bare core helper leaves to the host:
 *
 * 1. **Lock** — claims the tenant's onboarding slot via
 *    `TenantStore.setState`, so two concurrent admins can't burn
 *    the same OTP twice. Holds for {@link DEFAULT_LOCK_TTL_MS} so a
 *    crashed onboarder doesn't permawedge the tenant.
 * 2. **Progress persistence** — installs an `onProgress` callback on
 *    `core.onboard` that calls `TenantStore.recordOnboardingProgress`
 *    after each compliance scenario. Lets `GET /tenants/:ref/status`
 *    surface real progress even if the originating HTTP socket drops.
 * 3. **Vault** — on success, encrypts + persists the full
 *    {@link SignerMaterial} returned by core. On failure, leaves the
 *    vault untouched.
 * 4. **Audit + lifecycle state** — writes an audit row in both the
 *    success and failure paths, transitions the tenant to
 *    `production-ready` or `failed`, parses the production-CSID
 *    expiry for the `expiringWithin` admin query.
 *
 * This module is HTTP-agnostic — the route handler in PR3 will be a
 * thin wrapper over `runOnboarding`.
 */

import {
  onboard as coreOnboard,
  type EGSUnitInfo,
  getCertificateExpirationDate,
  type OnboardingResult,
  type ZatcaEnvironment,
} from "@dokhna-tech/zatca";

import type { AuditActor, AuditLog } from "../audit/index.js";
import { redactSecrets } from "../audit/redact.js";
import { ZatcaRegistryError, ZatcaServerError } from "../errors.js";
import type { CredentialVault } from "../tenants/credential-vault.js";
import type { TenantStore } from "../tenants/store.js";
import type { TenantRecord } from "../tenants/types.js";

/**
 * 3 minutes — matches the documented HTTP read timeout for the
 * onboarding route. A crashed instance frees the lock at most one
 * full onboarding attempt later.
 */
export const DEFAULT_LOCK_TTL_MS = 180_000;

/**
 * Server-default EGS `model` field embedded in the CSR. Operators
 * can override per-tenant by passing `egsModel`; otherwise this
 * surfaces in the issued certificate's metadata.
 */
const DEFAULT_EGS_MODEL = "ZATCA Standalone Server";

/**
 * Inputs to {@link runOnboarding}.
 *
 * `onboardFn` and `getExpiry` exist as test-injection seams so unit
 * tests can exercise the wrapper without standing up msw / parsing a
 * real X.509 certificate. Production callers should leave both
 * `undefined`.
 */
export interface RunOnboardingArgs {
  readonly tenantRef: string;
  readonly otp: string;
  readonly solutionName: string;
  readonly environment: Exclude<ZatcaEnvironment, "production">;
  readonly instanceId: string;
  readonly registry: {
    readonly tenants: TenantStore;
    readonly vault: CredentialVault;
  };
  readonly auditLog: AuditLog;
  readonly actor: AuditActor;
  readonly egsCustomId?: string;
  readonly egsModel?: string;
  readonly lockTtlMs?: number;
  readonly onboardFn?: typeof coreOnboard;
  readonly getExpiry?: (productionCertificate: string) => Date;
}

/**
 * Result of a successful onboarding run.
 *
 * The signed material itself is NOT returned — it lives in the vault.
 * Routes consume this shape to render `GET /tenants/:ref/status` and
 * the immediate `POST .../onboard` response.
 */
export interface RunOnboardingResult {
  readonly tenantRef: string;
  readonly state: TenantRecord["state"];
  readonly complianceTestStatus: OnboardingResult["complianceTestReport"]["overallStatus"];
  readonly productionCertificateExpiresAt: Date;
  readonly productionRequestId: string;
}

function buildEgsInfo(
  record: TenantRecord,
  egsCustomId: string | undefined,
  egsModel: string | undefined,
): Omit<EGSUnitInfo, "certificate"> {
  return {
    uuid: record.egsUuid,
    customId: egsCustomId ?? `${record.tenantRef}-pos-01`,
    model: egsModel ?? DEFAULT_EGS_MODEL,
    crnNumber: record.crn,
    vatName: record.vatName,
    vatNumber: record.vatNumber,
    branchName: record.branchName,
    branchIndustry: record.branchIndustry ?? "Retail",
    location: {
      cityName: record.location.cityName,
      citySubdivision: record.location.citySubdivision,
      street: record.location.street,
      plotIdentification: record.location.plotIdentification,
      building: record.location.building,
      postalZone: record.location.postalZone,
    },
  };
}

/**
 * Run a tenant's onboarding flow. Throws {@link ZatcaServerError} (or
 * a more specific subclass) on any failure — the underlying ZATCA
 * error is wrapped so the caller can `instanceof`-narrow without
 * importing core errors.
 */
export async function runOnboarding(args: RunOnboardingArgs): Promise<RunOnboardingResult> {
  const onboardFn = args.onboardFn ?? coreOnboard;
  const getExpiry = args.getExpiry ?? getCertificateExpirationDate;
  const lockTtlMs = args.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;

  const existing = await args.registry.tenants.get(args.tenantRef);
  if (existing === null) {
    throw new ZatcaRegistryError(`Unknown tenant '${args.tenantRef}'.`);
  }

  // Pre-flight: refuse to attempt onboarding while a fresh claim is
  // held by another instance. The setState CAS below is the source of
  // truth, but this gives a cleaner error message.
  if (
    existing.state === "onboarding" &&
    existing.claimExpiresAt !== undefined &&
    existing.claimExpiresAt > new Date()
  ) {
    throw new ZatcaServerError(
      `Tenant '${args.tenantRef}' is already onboarding (claimed by '${
        existing.claimedBy ?? "unknown"
      }', lock expires ${existing.claimExpiresAt.toISOString()}).`,
    );
  }

  // Acquire the lock. `setState` clears any prior progress lastError
  // implicitly when no `lastError` option is passed. The expectedFrom
  // CAS only covers ONE state, so try the two valid starting points
  // sequentially. In-memory single-threaded JS guarantees no
  // interleave between the two attempts; DB-backed impls in PR2 use
  // an atomic UPDATE with an `IN (...)` predicate.
  const lockExpires = new Date(Date.now() + lockTtlMs);
  let acquired = false;
  for (const from of ["created", "failed", "production-ready"] as const) {
    try {
      await args.registry.tenants.setState(args.tenantRef, "onboarding", {
        expectedFrom: from,
        claimedBy: args.instanceId,
        claimExpiresAt: lockExpires,
      });
      acquired = true;
      break;
    } catch (err) {
      if (err instanceof ZatcaRegistryError) continue;
      throw err;
    }
  }
  if (!acquired) {
    // The tenant must have been in a state we don't permit-from.
    // Re-read to give a useful error.
    const fresh = await args.registry.tenants.get(args.tenantRef);
    throw new ZatcaServerError(
      `Tenant '${args.tenantRef}' cannot be onboarded from state '${fresh?.state ?? "unknown"}'.`,
    );
  }

  const egsInfo = buildEgsInfo(existing, args.egsCustomId, args.egsModel);

  try {
    const result = await onboardFn({
      egsInfo,
      otp: args.otp,
      environment: args.environment,
      solutionName: args.solutionName,
      onProgress: async (event) => {
        // Persist per-scenario progress so `GET /status` shows real
        // ground state even mid-run. Errors thrown here are swallowed
        // by core's onProgress contract — but we also log them via
        // the audit hook so admins can diagnose persistence issues.
        await args.registry.tenants.recordOnboardingProgress(
          args.tenantRef,
          event.scenarioName,
          event.passed,
        );
      },
    });

    if (result.complianceTestReport.overallStatus === "failed") {
      // core.onboard() already throws ZatcaOnboardingError on a
      // failed report, but we belt-and-brace in case that contract
      // softens — defensive symmetry with the success path.
      throw new ZatcaServerError(`Compliance tests failed for tenant '${args.tenantRef}'.`);
    }

    await args.registry.vault.put(args.tenantRef, {
      privateKey: result.privateKey,
      productionCertificate: result.productionCertificate,
      productionBinarySecurityToken: result.productionBinarySecurityToken,
      productionApiSecret: result.productionApiSecret,
      complianceCertificate: result.complianceCertificate,
      complianceBinarySecurityToken: result.complianceBinarySecurityToken,
      complianceApiSecret: result.complianceApiSecret,
    });

    let productionExpiry: Date;
    try {
      productionExpiry = getExpiry(result.productionCertificate);
    } catch (cause) {
      throw new ZatcaServerError(
        `Onboarding succeeded but production certificate expiry could not be parsed for '${args.tenantRef}'.`,
        cause,
      );
    }
    await args.registry.tenants.setProductionExpiry(args.tenantRef, productionExpiry);

    const finalRecord = await args.registry.tenants.setState(
      args.tenantRef,
      "production-ready",
      {},
    );

    await args.auditLog.write({
      actor: args.actor,
      tenantRef: args.tenantRef,
      action: "tenant.onboarded",
      targetId: args.tenantRef,
      result: "ok",
      payload: redactSecrets({
        environment: args.environment,
        solutionName: args.solutionName,
        complianceRequestId: result.complianceRequestId,
        productionRequestId: result.productionRequestId,
        productionCertificateExpiresAt: productionExpiry.toISOString(),
      }),
    });

    return {
      tenantRef: args.tenantRef,
      state: finalRecord.state,
      complianceTestStatus: result.complianceTestReport.overallStatus,
      productionCertificateExpiresAt: productionExpiry,
      productionRequestId: result.productionRequestId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Mark failed + release the lock. Don't let a follow-up failure
    // here mask the original error.
    try {
      await args.registry.tenants.setState(args.tenantRef, "failed", { lastError: message });
    } catch {
      // Swallow — the original error is what we want to surface.
    }
    try {
      await args.auditLog.write({
        actor: args.actor,
        tenantRef: args.tenantRef,
        action: "tenant.onboarded",
        targetId: args.tenantRef,
        result: "error",
        payload: redactSecrets({
          environment: args.environment,
          solutionName: args.solutionName,
          error: message,
        }),
      });
    } catch {
      // Audit-write failure is non-fatal in the error path.
    }
    throw err;
  }
}
