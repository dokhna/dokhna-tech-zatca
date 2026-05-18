/**
 * `SecretCipher` — the pluggable seam through which the server
 * encrypts tenant-signing material before persisting it.
 *
 * The persisted shape is always a {@link CipherEnvelope}: a kid-tagged
 * record from which a future master-key rotation can pick the right
 * key without scanning the row. New writes always use the *active*
 * key; reads look up the key by the envelope's `kid`. This makes
 * rotation a background re-encrypt job, never a downtime event.
 *
 * The interface is asynchronous so a future KMS-backed implementation
 * (AWS KMS, GCP KMS, HashiCorp Vault) can replace the bundled
 * in-process AES-GCM without forcing a contract change. The first-
 * party implementations (`aes-256-gcm`, `noop`) resolve synchronously
 * even though their return type is a Promise.
 */

/**
 * Persisted ciphertext envelope.
 *
 * Stored verbatim in the credential vault. All binary fields are
 * base64-encoded so the envelope round-trips cleanly through JSON
 * columns / Mongo BSON / Postgres `jsonb` without per-driver byte
 * handling.
 *
 * - `kid`  — key id used for the encrypt; the cipher uses this to
 *            select the right master key during decrypt.
 * - `alg`  — algorithm identifier (e.g. `"aes-256-gcm"`, `"noop"`).
 *            Lets callers reject envelopes from a cipher family they
 *            no longer trust.
 * - `iv`   — base64 nonce / initialization vector.
 * - `ct`   — base64 ciphertext.
 * - `tag`  — base64 authentication tag (empty for AEAD-less ciphers).
 */
export interface CipherEnvelope {
  readonly kid: string;
  readonly alg: string;
  readonly iv: string;
  readonly ct: string;
  readonly tag: string;
}

/**
 * Encrypt / decrypt seam used by the credential vault.
 *
 * Implementations MUST:
 * - Produce envelopes that round-trip: `decrypt(encrypt(p)) === p`.
 * - Throw {@link ZatcaCipherError} on any decrypt-side failure
 *   (unknown kid, auth-tag mismatch, malformed envelope).
 * - Treat the `alg` field as authoritative — never attempt to decrypt
 *   an envelope whose `alg` the implementation does not own.
 *
 * Implementations MAY:
 * - Memoize the envelope shape across calls (the AES-GCM impl does).
 * - Resolve synchronously even though the type is async (the bundled
 *   in-process ciphers do; KMS-backed impls will not).
 */
export interface SecretCipher {
  encrypt(plaintext: string): Promise<CipherEnvelope>;
  decrypt(envelope: CipherEnvelope): Promise<string>;
}
