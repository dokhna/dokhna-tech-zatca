/**
 * Public surface of the server crypto layer.
 *
 * - {@link SecretCipher} / {@link CipherEnvelope} — the pluggable seam.
 * - {@link createAesGcmCipher} — production-grade kid-versioned AEAD.
 * - {@link createNoopCipher} — development-only passthrough.
 */

export {
  type AesGcmCipherOptions,
  createAesGcmCipher,
  type MasterKey,
} from "./aes-gcm-cipher.js";
export type { CipherEnvelope, SecretCipher } from "./cipher.js";
export { createNoopCipher, type NoopCipherOptions } from "./noop-cipher.js";
