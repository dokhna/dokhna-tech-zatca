/**
 * Branded type primitives used throughout the ZATCA core package.
 *
 * A branded type is a nominal-typing trick that carries a phantom
 * tag at the type level without changing the runtime representation.
 * It prevents accidental misuse of structurally identical primitives —
 * e.g. passing a raw `string` where a `VATNumber` is expected.
 *
 * Runtime validation and the (string -> VATNumber) coercion live in
 * `../validation/`. Consumers should never cast manually; always go
 * through the `as*` factory functions which enforce the format rules.
 */

/**
 * Attach a phantom brand `B` to the base type `T`.
 *
 * The brand lives in an unconstructable optional property keyed by a
 * plain string (`"__brand"`). It is erased at runtime — a
 * `Brand<string, "X">` is still a plain string when you
 * `JSON.stringify` it — but the compiler will refuse to silently
 * cast `string` into the branded type. Use the `as*` factory functions
 * in `../validation/` to obtain branded values.
 *
 * The `"__brand"` key is intentionally a plain string (not a
 * `unique symbol`) so inferred-from types — e.g. zod's `z.infer` —
 * remain *nameable* across module boundaries. A `unique symbol` brand
 * triggers TS4023 ("cannot be named") on any inferred export that
 * carries the branded shape.
 */
export type Brand<T, B extends string> = T & {
  readonly __brand: B;
};

/**
 * Saudi VAT (Tax Registration Number).
 *
 * Format: 15 digits, starts with `3` and ends with `3`.
 * Example: `301234567890003`.
 */
export type VATNumber = Brand<string, "VATNumber">;

/**
 * Saudi Commercial Registration Number (CRN / Sijil Tijari).
 *
 * Format: 10 digits.
 */
export type CommercialRegistrationNumber = Brand<string, "CRN">;

/**
 * UUID v4 identifying a ZATCA invoice / credit-note / debit-note.
 * Generated once per document at issuance time.
 */
export type InvoiceUUID = Brand<string, "InvoiceUUID">;

/**
 * Base64-encoded SHA-256 hash of the canonicalized invoice XML.
 * 44 characters, ends with `=`.
 */
export type InvoiceHash = Brand<string, "InvoiceHash">;

/**
 * UUID v4 identifying an EGS (Electronic Generation Solution) unit.
 * One per cash register / POS / billing endpoint per VAT registration.
 */
export type EGSUuid = Brand<string, "EGSUuid">;

/**
 * Arbitrary base64-encoded byte string (PEM bodies, certificates,
 * binary security tokens, etc).
 */
export type Base64 = Brand<string, "Base64">;
