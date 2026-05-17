/**
 * Tenant-bearer auth helper.
 *
 * Wraps the {@link ApiKeyStore.resolve} primitive in a request-shaped
 * API that the HTTP layer (PR3) will call directly. Two things this
 * module adds on top of the raw store:
 *
 * 1. Header extraction (`Authorization: Bearer <token>`) with
 *    consistent error mapping.
 * 2. Tenant-scope verification: the path-resolved `tenantRef` must
 *    match the bearer's `tenantRef`, else 403. This makes
 *    cross-tenant access impossible at the routing layer — bugs in
 *    handler logic cannot leak data across tenants.
 */

import { ZatcaAuthError } from "../errors.js";
import type { ApiKeyStore, ResolvedApiKey } from "../tenants/api-key-store.js";

import { extractBearer } from "./admin-keys.js";

/**
 * The compiled tenant-bearer verifier. Built once at boot, used per
 * request.
 */
export interface TenantBearerVerifier {
  /**
   * Resolve a presented `Authorization` header against the underlying
   * api-key store AND assert that the resolved tenant matches
   * `expectedTenantRef`. Throws {@link ZatcaAuthError} on any failure
   * (missing header, malformed header, unknown token, revoked token,
   * tenant-ref mismatch). Returns the resolved key on success.
   */
  verify(authHeader: string | undefined, expectedTenantRef: string): Promise<ResolvedApiKey>;
}

/**
 * Construct a verifier bound to the supplied api-key store.
 */
export function createTenantBearerVerifier(apiKeys: ApiKeyStore): TenantBearerVerifier {
  return {
    async verify(authHeader, expectedTenantRef) {
      if (authHeader === undefined || authHeader === "") {
        throw new ZatcaAuthError("Missing Authorization header.", 401);
      }
      const bearer = extractBearer(authHeader);
      if (bearer === null) {
        throw new ZatcaAuthError("Authorization header must be of the form 'Bearer <token>'.", 401);
      }
      const resolved = await apiKeys.resolve(bearer);
      if (resolved === null) {
        throw new ZatcaAuthError("Invalid or revoked API key.", 401);
      }
      if (resolved.tenantRef !== expectedTenantRef) {
        // ME-06: previously 403; an attacker with any valid bearer
        // could distinguish "valid token, wrong tenant" (403) from
        // "invalid token" (401) — confirming the URL's tenant
        // exists. Return 401 for BOTH so the wire-side response
        // doesn't leak tenant existence. The Error.cause carries
        // the diagnostic detail (presented vs expected ref) for
        // operators reading server logs.
        throw new ZatcaAuthError("Invalid or revoked API key.", 401, {
          reason: "wrong_tenant_bearer",
          presentedTenantRef: resolved.tenantRef,
          expectedTenantRef,
        });
      }
      return resolved;
    },
  };
}
