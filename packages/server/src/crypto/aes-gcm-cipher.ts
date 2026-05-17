/**
 * AES-256-GCM `SecretCipher` with a versioned key-ring.
 *
 * The cipher holds a map of `kid → 32-byte key`. New writes always
 * use the kid declared as `activeKid`; reads pick the kid recorded
 * in the envelope. Rotating the master key is therefore:
 *
 *   1. Add a new `(kid, key)` entry to the ring; flip `activeKid`.
 *   2. New rows encrypt under the new kid; old rows still decrypt
 *      under the old kid.
 *   3. A background job re-encrypts old rows at leisure.
 *   4. Once no rows reference the old kid, remove it from the ring.
 *
 * Zero downtime, no schema change, no double-write window.
 *
 * IV strategy: 96 random bits per encrypt, drawn from
 * {@link randomBytes}. AES-GCM's birthday bound is `2^32` messages
 * per key with random IVs — at a million invoices per tenant per
 * year, a single kid is safe for >4,000 years. (Rotate annually
 * anyway for operational hygiene.)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { ZatcaCipherError } from "../errors.js";
import type { CipherEnvelope, SecretCipher } from "./cipher.js";

const ALG = "aes-256-gcm" as const;
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;

/**
 * Single entry in the master key-ring.
 *
 * - `kid` — short, stable identifier (e.g. `"v1"`, `"2026-q2"`). Must
 *           be unique within the ring. Persisted alongside every
 *           ciphertext so the cipher can route decrypts.
 * - `key` — raw 32-byte (256-bit) symmetric key. Callers are
 *           responsible for sourcing this from a secure place — env
 *           var, mounted secret file, or KMS-derived bytes.
 */
export interface MasterKey {
  readonly kid: string;
  readonly key: Buffer;
}

/**
 * Constructor input for {@link createAesGcmCipher}.
 */
export interface AesGcmCipherOptions {
  readonly keyring: ReadonlyArray<MasterKey>;
  readonly activeKid: string;
}

/**
 * Build an AES-256-GCM cipher backed by the supplied key-ring.
 *
 * Throws {@link ZatcaCipherError} synchronously at construction time
 * if the ring is empty, contains duplicate kids, contains a key of
 * the wrong length, or the `activeKid` is not present in the ring.
 * Validating upfront keeps surprise-at-first-write out of the hot
 * path.
 */
export function createAesGcmCipher(options: AesGcmCipherOptions): SecretCipher {
  if (options.keyring.length === 0) {
    throw new ZatcaCipherError("AES-GCM cipher requires at least one master key in the ring.");
  }

  const byKid = new Map<string, Buffer>();
  for (const entry of options.keyring) {
    if (byKid.has(entry.kid)) {
      throw new ZatcaCipherError(`Duplicate kid '${entry.kid}' in master key-ring.`);
    }
    if (entry.key.length !== KEY_BYTES) {
      throw new ZatcaCipherError(
        `Master key '${entry.kid}' must be ${KEY_BYTES} bytes; got ${entry.key.length}.`,
      );
    }
    byKid.set(entry.kid, entry.key);
  }

  const activeKey = byKid.get(options.activeKid);
  if (activeKey === undefined) {
    throw new ZatcaCipherError(
      `activeKid '${options.activeKid}' is not present in the master key-ring.`,
    );
  }
  const activeKid = options.activeKid;

  return {
    async encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALG, activeKey, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        kid: activeKid,
        alg: ALG,
        iv: iv.toString("base64"),
        ct: ct.toString("base64"),
        tag: tag.toString("base64"),
      };
    },

    async decrypt(envelope: CipherEnvelope) {
      if (envelope.alg !== ALG) {
        throw new ZatcaCipherError(
          `Envelope alg '${envelope.alg}' is not handled by aes-256-gcm cipher.`,
        );
      }
      const key = byKid.get(envelope.kid);
      if (key === undefined) {
        throw new ZatcaCipherError(
          `Envelope references unknown kid '${envelope.kid}'. Has the key been rotated out of the ring?`,
        );
      }
      const iv = Buffer.from(envelope.iv, "base64");
      if (iv.length !== IV_BYTES) {
        throw new ZatcaCipherError(`Envelope iv must be ${IV_BYTES} bytes; got ${iv.length}.`);
      }
      const tag = Buffer.from(envelope.tag, "base64");
      if (tag.length !== TAG_BYTES) {
        throw new ZatcaCipherError(`Envelope tag must be ${TAG_BYTES} bytes; got ${tag.length}.`);
      }
      const ct = Buffer.from(envelope.ct, "base64");
      const decipher = createDecipheriv(ALG, key, iv);
      decipher.setAuthTag(tag);
      try {
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString("utf8");
      } catch (cause) {
        throw new ZatcaCipherError(
          `AES-GCM decrypt failed for kid '${envelope.kid}' — auth tag mismatch or corrupt ciphertext.`,
          cause,
        );
      }
    },
  };
}
