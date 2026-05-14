/**
 * Public certificate-management helpers re-exported from
 * `@dokhna-tech/zatca`.
 *
 * All three helpers are pure, synchronous, and perform no network or
 * filesystem I/O. They wrap Node's built-in {@link X509Certificate}
 * with consistent error semantics + a private-key cross-check used by
 * admin tooling.
 */

export type { CertificateVerification } from "./verify.js";
export { verifyCertificate } from "./verify.js";
export { isCertificateValid } from "./validity.js";
export { getCertificateExpirationDate } from "./expiration.js";
