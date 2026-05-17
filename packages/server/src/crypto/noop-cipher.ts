/**
 * No-op `SecretCipher` for local development only.
 *
 * Persists plaintext in the `ct` field with `alg: "noop"`. Lets a
 * developer spin the server up against a memory or local DB without
 * standing up a master-key ring first.
 *
 * Refuses to construct unless `NODE_ENV === "development"` OR the
 * caller passes `{ acknowledgeUnsafe: true }`. The acknowledge flag
 * exists so unit tests that need *some* cipher (without caring about
 * crypto) can opt in explicitly. Production deployments must not be
 * able to fall back to this cipher by accident.
 */

import { ZatcaCipherError } from "../errors.js";
import type { CipherEnvelope, SecretCipher } from "./cipher.js";

const ALG = "noop" as const;
const KID = "noop" as const;

/**
 * Constructor input for {@link createNoopCipher}.
 */
export interface NoopCipherOptions {
  /**
   * Explicit opt-in for use outside `NODE_ENV=development`.
   * Set to `true` in unit tests that need a cipher but do not care
   * about encryption semantics. Leave `undefined` in any code path
   * that might run in production.
   */
  readonly acknowledgeUnsafe?: boolean;
}

/**
 * Construct the no-op cipher. Throws {@link ZatcaCipherError} if used
 * outside a development environment without the explicit `acknowledgeUnsafe`
 * opt-in.
 */
export function createNoopCipher(options: NoopCipherOptions = {}): SecretCipher {
  const env = process.env.NODE_ENV;
  const isDev = env === "development";
  if (!isDev && options.acknowledgeUnsafe !== true) {
    throw new ZatcaCipherError(
      "createNoopCipher refuses to run outside NODE_ENV=development without acknowledgeUnsafe=true. " +
        "Use createAesGcmCipher in production.",
    );
  }

  return {
    async encrypt(plaintext) {
      return {
        kid: KID,
        alg: ALG,
        iv: "",
        ct: Buffer.from(plaintext, "utf8").toString("base64"),
        tag: "",
      };
    },

    async decrypt(envelope: CipherEnvelope) {
      if (envelope.alg !== ALG) {
        throw new ZatcaCipherError(
          `Envelope alg '${envelope.alg}' is not handled by the noop cipher.`,
        );
      }
      return Buffer.from(envelope.ct, "base64").toString("utf8");
    },
  };
}
