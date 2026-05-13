/**
 * Public cryptographic helpers re-exported from `@dokhna-tach/zatca`.
 *
 * Internal helpers — `csr-template.ts` builder, the various
 * `cleanUp*` PEM strippers — are intentionally not re-exported.
 * Users should drive the pipeline via {@link generateSignedXMLString}
 * and {@link generateCSR}; the lower-level primitives are exposed
 * here for advanced callers (compliance test runners, custom
 * signing flows).
 */

export { getInvoiceHash, getCertificateHash, getPureInvoiceString } from "./hash.js";
export {
  cleanUpCertificateString,
  wrapCertificateString,
  extractCertificateInfo,
} from "./cert-info.js";
export type { CertificateInfo } from "./cert-info.js";
export {
  cleanUpPrivateKeyString,
  createInvoiceDigitalSignature,
  generateSignedXMLString,
} from "./sign.js";
export type { GenerateSignatureXMLParams, SignedXMLResult } from "./sign.js";
export {
  ensureOpenssl,
  probeOpenssl,
  resetOpensslProbeCache,
} from "./openssl-probe.js";
export type { OpensslProbeResult } from "./openssl-probe.js";
export { generateSecp256k1KeyPair } from "./generate-keys.js";
export { generateCSR } from "./generate-csr.js";
export type { CSRGenerationEgsInfo, CSRGenerationParams } from "./generate-csr.js";
