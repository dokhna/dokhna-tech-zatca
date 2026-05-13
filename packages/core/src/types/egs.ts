/**
 * EGS (Electronic Generation Solution) — the unit issuing invoices on
 * behalf of a Saudi VAT registration. ZATCA requires one EGS per
 * physical/logical billing endpoint (cash register, POS, server).
 *
 * Field names are camelCase (`vatNumber`, `crnNumber`) — a deliberate
 * departure from the snake_case shape used in the legacy rwiqha
 * helper. The internal UBL template fillers translate to whatever the
 * XML expects.
 */

import type {
  Base64,
  CommercialRegistrationNumber,
  EGSUuid,
  VATNumber,
} from "./branded.js";

/**
 * Postal address of the EGS unit. All fields are required by ZATCA.
 *
 * - `cityName`        — e.g. "Riyadh".
 * - `citySubdivision` — district / neighbourhood.
 * - `street`          — street name (Arabic or transliterated Latin).
 * - `plotIdentification` — plot number (per Saudi Address standard).
 * - `building`        — building number (4 digits per Saudi Address).
 * - `postalZone`      — 5-digit Saudi postal code.
 */
export interface EGSUnitLocation {
  cityName: string;
  citySubdivision: string;
  street: string;
  plotIdentification: string;
  building: string;
  postalZone: string;
}

/**
 * Onboarding artifacts produced by the CSR + CSID exchange with ZATCA.
 *
 * - `privateKey`            — PEM-encoded ECDSA-secp256k1 private key.
 *                              **Treat as a secret**; never log.
 * - `csr`                   — PEM-encoded Certificate Signing Request.
 * - `complianceCertificate` — X.509 PEM issued by the ZATCA
 *                              compliance environment.
 * - `complianceApiSecret`   — API secret paired with the compliance
 *                              certificate.
 * - `productionCertificate` — X.509 PEM issued after compliance tests
 *                              pass.
 * - `productionApiSecret`   — API secret paired with the production
 *                              certificate.
 */
export interface EGSCertificate {
  privateKey?: string;
  csr?: string;
  complianceCertificate?: string;
  complianceApiSecret?: string;
  productionCertificate?: string;
  productionApiSecret?: string;
}

/**
 * Static metadata about an EGS unit, plus its onboarding artifacts.
 *
 * Passed into every invoice-issuance call — together with
 * `TenantScope` it identifies which VAT registration / EGS pair is
 * issuing the document.
 *
 * - `uuid`           — UUID v4 unique to this EGS (immutable; assigned
 *                      at first onboarding).
 * - `customId`       — operator-chosen string identifier (e.g.
 *                      "branch-01-pos-03"). Echoed in the CSR and
 *                      visible to ZATCA support.
 * - `model`          — POS / register hardware model string.
 * - `crnNumber`      — operator's Saudi commercial registration.
 * - `vatName`        — registered legal name attached to the VAT.
 * - `vatNumber`      — 15-digit Saudi VAT registration number.
 * - `branchName`     — human-readable branch name.
 * - `branchIndustry` — branch industry classification string.
 * - `location`       — physical address of the unit.
 * - `certificate`    — onboarding artifacts; absent before first CSR.
 */
export interface EGSUnitInfo {
  uuid: EGSUuid;
  customId: string;
  model: string;
  crnNumber: CommercialRegistrationNumber;
  vatName: string;
  vatNumber: VATNumber;
  branchName: string;
  branchIndustry: string;
  location: EGSUnitLocation;
  certificate?: EGSCertificate;
}

/**
 * Minimal projection of an EGS certificate used by API clients —
 * the binary security token (base64 cert) plus the paired API secret.
 *
 * Used as `egsInfo.certificate` payload when calling compliance /
 * clearance / reporting endpoints.
 */
export interface EGSApiCredentials {
  certificateContent: Base64;
  apiSecret: string;
  binarySecurityToken: Base64;
}
