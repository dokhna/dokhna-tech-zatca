/**
 * TLV (Tag-Length-Value) byte-encoder primitive used by ZATCA QR
 * generation.
 *
 * Each TLV entry is `[tagNumber, byteLength, ...bytes]` with the tag
 * number assigned sequentially starting at `1`. The output is the
 * concatenation of all entries.
 *
 * Reference: ZATCA E-Invoicing Detailed Guidelines §3.3 (QR fields).
 */

/**
 * Accepted input shapes for each TLV value:
 *
 * - `string` — UTF-8 encoded then length-prefixed.
 * - `Uint8Array` / `Buffer` — taken verbatim.
 */
export type TLVValue = string | Uint8Array;

/**
 * Encodes an ordered list of values into a single TLV byte buffer.
 *
 * The tag number of each entry is its 1-based position in the input
 * array — caller must pass values in the order specified by the
 * ZATCA QR spec (see `phase1.ts` / `phase2.ts`).
 *
 * Throws `RangeError` if any value's encoded length exceeds 255 bytes
 * — TLV length is a single byte and the spec does not define a
 * multi-byte extension. None of ZATCA's defined QR fields ever
 * exceed 255 bytes, so this is a defensive guard.
 */
export function createTLV(values: ReadonlyArray<TLVValue>): Uint8Array {
  const segments: Uint8Array[] = [];
  let totalLength = 0;

  values.forEach((value, index) => {
    const tagNumber = index + 1;
    const bytes = value instanceof Uint8Array ? value : Buffer.from(value, "utf8");
    if (bytes.byteLength > 255) {
      throw new RangeError(
        `TLV tag ${tagNumber} exceeds the 255-byte length cap (got ${bytes.byteLength} bytes).`,
      );
    }
    const segment = new Uint8Array(2 + bytes.byteLength);
    segment[0] = tagNumber;
    segment[1] = bytes.byteLength;
    segment.set(bytes, 2);
    segments.push(segment);
    totalLength += segment.byteLength;
  });

  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const segment of segments) {
    out.set(segment, offset);
    offset += segment.byteLength;
  }
  return out;
}

/**
 * Convenience wrapper: encode + base64-stringify in one call.
 *
 * `Buffer.from(uint8array).toString("base64")` and not the WebCrypto
 * approach because this package targets Node 20+ exclusively and
 * `Buffer` is universally available.
 */
export function encodeTLVAsBase64(values: ReadonlyArray<TLVValue>): string {
  return Buffer.from(createTLV(values)).toString("base64");
}
