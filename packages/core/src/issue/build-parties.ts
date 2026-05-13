/**
 * Framework-neutral party builders.
 *
 * Replaces rwiqha-backend's Mongoose-coupled `buildSellerInfo` /
 * `buildBuyerInfo` helpers. The Phase 1 types (`EGSUnitInfo`,
 * `BuyerInfo`) carry every field these helpers need; there are no
 * database reads, no `_id` quirks, and no `lean()` calls.
 *
 * Two consumers in this package:
 *
 * 1. The UBL templates already embed the seller party — the
 *    `populate*Template` functions splice `EGSUnitInfo` fields into
 *    the `<cac:AccountingSupplierParty>` block at template-fill time.
 *    {@link buildSellerSummary} is exposed for callers (e.g. Phase 1
 *    invoice / credit-note builders that hand-roll a minimal
 *    template) that prefer a structured projection.
 *
 * 2. {@link buildBuyerInfoXml} produces the structured `XMLObject`
 *    the {@link BaseInvoiceBuilder} injects into
 *    `<cac:AccountingCustomerParty>` for *standard* invoices and any
 *    credit / debit note that carries a full `BuyerInfo`.
 */

import type { EGSUnitInfo } from "../types/egs.js";
import type { BuyerInfo } from "../types/parties.js";
import type { XMLObject } from "../xml/document.js";

/**
 * Minimal structured projection of the EGS unit's seller identity.
 * Useful for Phase 1 hand-rolled templates and for the
 * compliance / clearance HTTP payloads.
 */
export interface SellerSummary {
  vatNumber: string;
  registrationName: string;
  streetName: string;
  buildingNumber: string;
  plotIdentification: string;
  cityName: string;
  citySubdivision: string;
  postalZone: string;
  countryCode: "SA";
  identityType: "CRN";
  identityNumber: string;
}

/**
 * Distills an `EGSUnitInfo` into the seller projection used by the
 * legacy `saveZatcaInvoice` shape. No defaults — every field is
 * required at the type level, so the caller's branded values are
 * passed through verbatim.
 */
export function buildSellerSummary(egsInfo: EGSUnitInfo): SellerSummary {
  return {
    vatNumber: egsInfo.vatNumber,
    registrationName: egsInfo.vatName,
    streetName: egsInfo.location.street,
    buildingNumber: egsInfo.location.building,
    plotIdentification: egsInfo.location.plotIdentification,
    cityName: egsInfo.location.cityName,
    citySubdivision: egsInfo.location.citySubdivision,
    postalZone: egsInfo.location.postalZone,
    countryCode: "SA",
    identityType: "CRN",
    identityNumber: egsInfo.crnNumber,
  };
}

/**
 * Builds the structured `<cac:AccountingCustomerParty>` content for
 * a UBL invoice. The returned `XMLObject` matches what
 * `fast-xml-parser`'s `XMLBuilder` re-serialises in the rwiqha
 * golden vectors.
 *
 * Optional fields (`vatNumber`, `address`) are omitted from the
 * output when absent — `fast-xml-parser` drops `undefined`-valued
 * keys silently, but we filter explicitly to keep the object graph
 * inspectable and deterministic.
 */
export function buildBuyerInfoXml(buyer: BuyerInfo): XMLObject {
  const party: XMLObject = {};

  party["cac:PartyIdentification"] = {
    "cbc:ID": {
      "@_schemeID": buyer.identityScheme,
      "#text": buyer.identityNumber,
    },
  };

  if (buyer.address !== undefined) {
    const address: XMLObject = {
      "cbc:StreetName": buyer.address.streetName,
      "cbc:BuildingNumber": buyer.address.buildingNumber,
    };
    if (buyer.address.plotIdentification !== undefined) {
      address["cbc:PlotIdentification"] = buyer.address.plotIdentification;
    }
    if (buyer.address.citySubdivision !== undefined) {
      address["cbc:CitySubdivisionName"] = buyer.address.citySubdivision;
    }
    address["cbc:CityName"] = buyer.address.cityName;
    address["cbc:PostalZone"] = buyer.address.postalZone;
    address["cac:Country"] = {
      "cbc:IdentificationCode": buyer.address.countryCode,
    };
    party["cac:PostalAddress"] = address;
  }

  if (buyer.vatNumber !== undefined) {
    party["cac:PartyTaxScheme"] = {
      "cbc:CompanyID": buyer.vatNumber,
      "cac:TaxScheme": { "cbc:ID": "VAT" },
    };
  }

  party["cac:PartyLegalEntity"] = {
    "cbc:RegistrationName": buyer.registrationName,
  };

  return { "cac:Party": party };
}
