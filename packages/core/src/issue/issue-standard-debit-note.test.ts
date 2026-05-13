/**
 * Unit tests — {@link issueStandardDebitNote}.
 */

import { describe, expect, it } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueStandardDebitNote } from "./issue-standard-debit-note.js";
import { makeMemoryStorage } from "./_memory-storage.js";

describe("issueStandardDebitNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a standard debit note with buyer + RoundingAmount on line item", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueStandardDebitNote({
      input: {
        kind: "standard-debit-note",
        issueDate: "2024-01-17",
        issueTime: "12:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            taxExclusivePrice: 50,
            name: "Service Adjustment",
          },
        ],
        buyerInfo: {
          registrationName: "Acme Buyer Co.",
          identityScheme: "CRN",
          identityNumber: "2020202020",
        },
        cancelation: makeTestCancelation("383"),
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
    });
    expect(result.invoiceXml).toContain("Acme Buyer Co.");
    expect(result.invoiceXml).toContain("<cbc:RoundingAmount");
    expect(log.getPreviousHash[0]?.kind).toBe("standard-debit-note");
  });
});
