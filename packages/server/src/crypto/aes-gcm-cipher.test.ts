import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ZatcaCipherError } from "../errors.js";
import { createAesGcmCipher, type MasterKey } from "./aes-gcm-cipher.js";

function key(kid: string): MasterKey {
  return { kid, key: randomBytes(32) };
}

describe("createAesGcmCipher", () => {
  describe("construction", () => {
    it("rejects an empty key-ring", () => {
      expect(() => createAesGcmCipher({ keyring: [], activeKid: "v1" })).toThrow(ZatcaCipherError);
    });

    it("rejects duplicate kids", () => {
      const k = key("v1");
      expect(() =>
        createAesGcmCipher({
          keyring: [k, { kid: "v1", key: randomBytes(32) }],
          activeKid: "v1",
        }),
      ).toThrow(/Duplicate kid/);
    });

    it("rejects a key of the wrong length", () => {
      expect(() =>
        createAesGcmCipher({
          keyring: [{ kid: "v1", key: randomBytes(16) }],
          activeKid: "v1",
        }),
      ).toThrow(/must be 32 bytes/);
    });

    it("rejects an activeKid that is not in the ring", () => {
      expect(() => createAesGcmCipher({ keyring: [key("v1")], activeKid: "v2" })).toThrow(
        /not present in the master key-ring/,
      );
    });
  });

  describe("encrypt + decrypt round-trip", () => {
    it("returns an envelope tagged with the active kid", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const envelope = await cipher.encrypt("hello");
      expect(envelope.kid).toBe("v1");
      expect(envelope.alg).toBe("aes-256-gcm");
      expect(envelope.iv).toMatch(/^[A-Za-z0-9+/]+=*$/);
      expect(envelope.tag).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it("decrypts back to the original plaintext", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const envelope = await cipher.encrypt("private key material");
      expect(await cipher.decrypt(envelope)).toBe("private key material");
    });

    it("uses a fresh IV per encrypt (envelopes differ)", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const a = await cipher.encrypt("same plaintext");
      const b = await cipher.encrypt("same plaintext");
      expect(a.iv).not.toBe(b.iv);
      expect(a.ct).not.toBe(b.ct);
    });

    it("handles utf8 multi-byte characters", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const plaintext = "بطاقة هوية — ١٢٣٤";
      const envelope = await cipher.encrypt(plaintext);
      expect(await cipher.decrypt(envelope)).toBe(plaintext);
    });
  });

  describe("key rotation", () => {
    it("decrypts envelopes written under an older kid after the active kid flips", async () => {
      const v1 = key("v1");
      const v2 = key("v2");
      const writerV1 = createAesGcmCipher({ keyring: [v1], activeKid: "v1" });
      const envelopeV1 = await writerV1.encrypt("legacy secret");

      const readerBoth = createAesGcmCipher({
        keyring: [v1, v2],
        activeKid: "v2",
      });
      // Old envelope still decrypts.
      expect(await readerBoth.decrypt(envelopeV1)).toBe("legacy secret");
      // New writes use the new kid.
      const envelopeV2 = await readerBoth.encrypt("fresh secret");
      expect(envelopeV2.kid).toBe("v2");
      expect(await readerBoth.decrypt(envelopeV2)).toBe("fresh secret");
    });

    it("rejects envelopes whose kid has been rotated out of the ring", async () => {
      const v1 = key("v1");
      const writerV1 = createAesGcmCipher({ keyring: [v1], activeKid: "v1" });
      const envelope = await writerV1.encrypt("payload");

      const v2 = key("v2");
      const readerV2Only = createAesGcmCipher({ keyring: [v2], activeKid: "v2" });
      await expect(readerV2Only.decrypt(envelope)).rejects.toThrow(/unknown kid 'v1'/);
    });
  });

  describe("decrypt failure modes", () => {
    it("rejects envelopes from a foreign algorithm", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      await expect(
        cipher.decrypt({ kid: "v1", alg: "noop", iv: "", ct: "", tag: "" }),
      ).rejects.toThrow(/not handled by aes-256-gcm/);
    });

    it("rejects envelopes with the wrong IV length", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const envelope = await cipher.encrypt("x");
      const broken = { ...envelope, iv: Buffer.from("short").toString("base64") };
      await expect(cipher.decrypt(broken)).rejects.toThrow(/iv must be 12 bytes/);
    });

    it("rejects envelopes with the wrong tag length", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const envelope = await cipher.encrypt("x");
      const broken = { ...envelope, tag: Buffer.from("short").toString("base64") };
      await expect(cipher.decrypt(broken)).rejects.toThrow(/tag must be 16 bytes/);
    });

    it("rejects tampered ciphertext (auth-tag mismatch)", async () => {
      const cipher = createAesGcmCipher({ keyring: [key("v1")], activeKid: "v1" });
      const envelope = await cipher.encrypt("untampered");
      // Flip one bit of the ciphertext.
      const ctBytes = Buffer.from(envelope.ct, "base64");
      ctBytes[0] = (ctBytes[0] ?? 0) ^ 0x01;
      const tampered = { ...envelope, ct: ctBytes.toString("base64") };
      await expect(cipher.decrypt(tampered)).rejects.toThrow(/auth tag mismatch/);
    });
  });
});
