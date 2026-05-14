/**
 * Buyer / seller party shapes used inside `InvoiceInput`.
 *
 * For *standard* invoices and credit / debit notes, the full buyer
 * party is required (registration name, address, identity). For
 * *simplified* invoices the package only needs `buyerName` from the
 * parent `InvoiceCommon` shape — `buyerInfo` here is optional.
 *
 * Seller information is derived entirely from `EGSUnitInfo` — the
 * package builds the seller party from the EGS record, so there is no
 * `SellerInfo` input type by design.
 */

import type { CommercialRegistrationNumber, VATNumber } from "./branded.js";

/**
 * Identity scheme codes accepted by ZATCA for buyer identification.
 *
 * - `CRN` — Commercial Registration Number
 * - `MOM` — Ministry of Municipal & Rural Affairs licence
 * - `MLS` — MLSD (labour) licence
 * - `700` — 700-account number
 * - `SAG` — Saudi Authority for Industrial Cities (MODON)
 * - `NAT` — National ID
 * - `GCC` — GCC citizen ID
 * - `IQA` — Iqama (resident) ID
 * - `PAS` — Passport
 * - `OTH` — Other identifier
 */
export const ZATCA_PARTY_IDENTITY_SCHEMES = {
  CRN: "CRN",
  MOM: "MOM",
  MLS: "MLS",
  TIN: "700",
  SAG: "SAG",
  NAT: "NAT",
  GCC: "GCC",
  IQA: "IQA",
  PAS: "PAS",
  OTH: "OTH",
} as const;

/** Literal union of accepted ZATCA party identity scheme codes. */
export type ZatcaPartyIdentityScheme =
  (typeof ZATCA_PARTY_IDENTITY_SCHEMES)[keyof typeof ZATCA_PARTY_IDENTITY_SCHEMES];

/**
 * Postal address for a party (buyer; the seller's address lives on
 * `EGSUnitInfo.location`).
 */
export interface PartyAddress {
  streetName: string;
  buildingNumber: string;
  plotIdentification?: string;
  cityName: string;
  citySubdivision?: string;
  postalZone: string;
  /** ISO 3166-1 alpha-2 country code. */
  countryCode: string;
}

/**
 * Buyer party — required for standard invoices / credit notes / debit
 * notes; optional on simplified.
 *
 * - `vatNumber`        — buyer's 15-digit VAT registration (B2B).
 * - `registrationName` — legal registration name.
 * - `address`          — buyer's postal address.
 * - `identityScheme`   — which identifier scheme `identityNumber`
 *                         belongs to (per `ZATCA_PARTY_IDENTITY_SCHEMES`).
 * - `identityNumber`   — the identifier itself. `CRN` values are
 *                         branded for type-safety; everything else is a
 *                         plain string.
 */
export interface BuyerInfo {
  vatNumber?: VATNumber;
  registrationName: string;
  address?: PartyAddress;
  identityScheme: ZatcaPartyIdentityScheme;
  identityNumber: CommercialRegistrationNumber | string;
}
