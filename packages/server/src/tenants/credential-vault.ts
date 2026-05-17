/**
 * `CredentialVault` — encrypts and persists per-tenant ZATCA signing
 * material.
 *
 * One row per tenant. Every secret field is stored as a kid-versioned
 * {@link CipherEnvelope} so a master-key rotation never requires
 * downtime or a schema change. Plaintext only exists in-process
 * during a `get` call.
 *
 * The vault NEVER returns secret material over the HTTP layer. Routes
 * that wrap a ZATCA call decrypt-in-process, hand the plaintext to
 * the core helpers, and drop the local references when the await
 * settles.
 *
 * Both compliance- and production-phase artifacts are persisted. The
 * compliance set is optional on read because a tenant may have been
 * onboarded without retaining the intermediate compliance cert (older
 * registrations), or may be in a state where it has not yet acquired
 * one (mid-rotation).
 */

import type { CipherEnvelope } from "../crypto/index.js";

/**
 * Decrypted signing material returned from the vault.
 *
 * Every field is a raw string straight from `core.onboard`'s result.
 * Treat each as **secret** — never log, never write to a non-encrypted
 * store, never include in an HTTP response body.
 */
export interface SignerMaterial {
  readonly privateKey: string;
  readonly productionCertificate: string;
  readonly productionBinarySecurityToken: string;
  readonly productionApiSecret: string;
  readonly complianceCertificate?: string;
  readonly complianceBinarySecurityToken?: string;
  readonly complianceApiSecret?: string;
}

/**
 * Persisted ciphertext form. One {@link CipherEnvelope} per field.
 * Exposed for the DB-backed impls in PR2; route handlers do not see
 * this type directly.
 */
export interface EncryptedSignerMaterial {
  readonly privateKey: CipherEnvelope;
  readonly productionCertificate: CipherEnvelope;
  readonly productionBinarySecurityToken: CipherEnvelope;
  readonly productionApiSecret: CipherEnvelope;
  readonly complianceCertificate?: CipherEnvelope;
  readonly complianceBinarySecurityToken?: CipherEnvelope;
  readonly complianceApiSecret?: CipherEnvelope;
}

export interface CredentialVault {
  /**
   * Encrypt + persist signing material for the tenant. Overwrites any
   * existing material (the caller is expected to have transitioned the
   * tenant state appropriately first — e.g. credentials rotation).
   */
  put(tenantRef: string, material: SignerMaterial): Promise<void>;

  /**
   * Fetch and decrypt signing material. Returns `null` if no material
   * has been persisted yet. Throws {@link ZatcaCipherError} (from the
   * underlying cipher) on a decrypt failure — never silently degrades.
   */
  get(tenantRef: string): Promise<SignerMaterial | null>;

  /**
   * Remove all persisted material for the tenant. Idempotent.
   * Implementations SHOULD wipe — not soft-delete — to minimize the
   * footprint of revoked keys.
   */
  delete(tenantRef: string): Promise<void>;
}
