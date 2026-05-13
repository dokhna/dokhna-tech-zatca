/**
 * Unit tests for the framework-neutral party helpers.
 */

import { describe, expect, it } from "vitest";
import type { BuyerInfo } from "../types/parties.js";
import type { VATNumber } from "../types/branded.js";
import { buildBuyerInfoXml, buildSellerSummary } from "./build-parties.js";
import { makeTestEgsInfo } from "../invoices/_test-helpers.js";

describe("buildSellerSummary", () => {
  it("derives every projection field from the EGS unit info", () => {
    const egs = makeTestEgsInfo();
    const summary = buildSellerSummary(egs);
    expect(summary.vatNumber).toBe(egs.vatNumber);
    expect(summary.registrationName).toBe(egs.vatName);
    expect(summary.streetName).toBe(egs.location.street);
    expect(summary.buildingNumber).toBe(egs.location.building);
    expect(summary.plotIdentification).toBe(egs.location.plotIdentification);
    expect(summary.cityName).toBe(egs.location.cityName);
    expect(summary.citySubdivision).toBe(egs.location.citySubdivision);
    expect(summary.postalZone).toBe(egs.location.postalZone);
    expect(summary.countryCode).toBe("SA");
    expect(summary.identityType).toBe("CRN");
    expect(summary.identityNumber).toBe(egs.crnNumber);
  });
});

describe("buildBuyerInfoXml", () => {
  it("emits a minimal buyer (identity scheme + registration name only)", () => {
    const buyer: BuyerInfo = {
      registrationName: "Customer X",
      identityScheme: "NAT",
      identityNumber: "1234567890",
    };
    const xml = buildBuyerInfoXml(buyer);
    const party = xml["cac:Party"] as Record<string, unknown>;
    expect(party["cac:PartyIdentification"]).toBeDefined();
    expect(party["cac:PartyLegalEntity"]).toMatchObject({
      "cbc:RegistrationName": "Customer X",
    });
    expect(party["cac:PartyTaxScheme"]).toBeUndefined();
    expect(party["cac:PostalAddress"]).toBeUndefined();
  });

  it("includes PartyTaxScheme when buyer has a VAT number", () => {
    const buyer: BuyerInfo = {
      registrationName: "Acme Buyer Co.",
      vatNumber: "311111111111113" as VATNumber,
      identityScheme: "CRN",
      identityNumber: "2020202020",
    };
    const xml = buildBuyerInfoXml(buyer);
    const party = xml["cac:Party"] as Record<string, unknown>;
    expect(party["cac:PartyTaxScheme"]).toMatchObject({
      "cbc:CompanyID": "311111111111113",
      "cac:TaxScheme": { "cbc:ID": "VAT" },
    });
  });

  it("includes PostalAddress when buyer has an address", () => {
    const buyer: BuyerInfo = {
      registrationName: "Acme Buyer Co.",
      identityScheme: "CRN",
      identityNumber: "2020202020",
      address: {
        streetName: "King Khalid Rd",
        buildingNumber: "42",
        cityName: "Jeddah",
        postalZone: "21577",
        countryCode: "SA",
      },
    };
    const xml = buildBuyerInfoXml(buyer);
    const party = xml["cac:Party"] as Record<string, unknown>;
    const addr = party["cac:PostalAddress"] as Record<string, unknown>;
    expect(addr["cbc:StreetName"]).toBe("King Khalid Rd");
    expect(addr["cbc:BuildingNumber"]).toBe("42");
    expect(addr["cbc:CityName"]).toBe("Jeddah");
    expect(addr["cbc:PostalZone"]).toBe("21577");
    expect(addr["cac:Country"]).toMatchObject({
      "cbc:IdentificationCode": "SA",
    });
  });
});
