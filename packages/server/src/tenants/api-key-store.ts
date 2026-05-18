/**
 * `ApiKeyStore` — issues + verifies the bearer tokens external
 * systems present on tenant-scoped routes.
 *
 * Token format: `zts_<env>_<tenantRef>_<32 base32url chars>`.
 *
 * - `zts_` prefix — fixed, so token-scanners (GitHub secret-scanning,
 *   `grep` over customer logs) can pattern-match leaks.
 * - `<env>` — `live` or `test`, mirroring the tenant's environment.
 *   Lets operators spot a misuse where a test token landed in
 *   production traffic.
 * - `<tenantRef>` — embedded so the store can hash-lookup in O(1)
 *   without scanning. Validation also ensures the URL `:ref` matches
 *   the bearer's `:ref`; mismatch is a 403.
 * - 32 base32url random chars ≈ 160 bits entropy.
 *
 * Stored shape: `(tokenId, tenantRef, scryptHash(token), salt, prefix,
 * last4, label, createdAt, lastUsedAt, revokedAt)`. Plaintext returned
 * only ONCE at issuance — operators write it down or pipe it into a
 * secret manager and never see it again.
 */

/**
 * Issued token + opaque id. Plaintext `token` returned only from
 * `issue`; thereafter, references are by `tokenId` only.
 */
export interface IssuedApiKey {
  readonly token: string;
  readonly tokenId: string;
}

/**
 * Result of resolving a presented bearer. `tokenId` is opaque to
 * callers; the auth middleware uses it to update `lastUsedAt`.
 */
export interface ResolvedApiKey {
  readonly tenantRef: string;
  readonly tokenId: string;
}

/**
 * Public listing entry. Plaintext token is NOT included; only the
 * `last4` for visual identification.
 */
export interface ApiKeyListEntry {
  readonly tokenId: string;
  readonly tenantRef: string;
  readonly label: string;
  readonly last4: string;
  readonly createdAt: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
}

export interface ApiKeyStore {
  /**
   * Mint a new token for the tenant. Returns the plaintext token —
   * the only opportunity to see it. The caller is expected to surface
   * the token to the operator in the HTTP response body and discard
   * it.
   */
  issue(tenantRef: string, label: string): Promise<IssuedApiKey>;

  /**
   * Hash-lookup the presented token. Returns `null` if the token
   * shape is invalid, the prefix is unknown, the underlying hash
   * mismatches, or the token has been revoked. Implementations MUST
   * use constant-time comparison on the hash check.
   */
  resolve(presentedToken: string): Promise<ResolvedApiKey | null>;

  /**
   * Revoke by id, scoped to the tenant that owns the token. Returns
   * `true` if a matching active row was revoked, `false` if no row
   * matched (either the token id is unknown, was already revoked, or
   * belongs to a different tenant). The route layer turns `false`
   * into a 404 so cross-tenant revocation attempts fail loudly.
   *
   * Idempotent over a single tenant — calling `revoke` twice for the
   * same `(tenantRef, tokenId)` returns `true` on the first call and
   * `false` on the second. After revoke, `resolve` returns `null` for
   * any presentation of the revoked token even if the bytes are still
   * valid.
   */
  revoke(tenantRef: string, tokenId: string): Promise<boolean>;

  /**
   * List active + revoked keys for the tenant. No plaintext, just
   * metadata + `last4` for visual disambiguation in admin UIs.
   */
  list(tenantRef: string): Promise<ReadonlyArray<ApiKeyListEntry>>;

  /**
   * Bulk-revoke all keys for a tenant. Used by `TenantStore.softDelete`
   * to ensure a revoked tenant cannot serve traffic via leaked keys.
   * Idempotent.
   */
  revokeAllForTenant(tenantRef: string): Promise<void>;
}
