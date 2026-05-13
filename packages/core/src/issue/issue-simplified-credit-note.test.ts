/**
 * Unit tests — {@link issueSimplifiedCreditNote}.
 */

import { describe, expect, it } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueSimplifiedCreditNote } from "./issue-simplified-credit-note.js";
import { makeMemoryStorage } from "./_memory-storage.js";

describe("issueSimplifiedCreditNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a credit note with cancelation block", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueSimplifiedCreditNote({
      input: {
        kind: "simplified-credit-note",
        issueDate: "2024-01-16",
        issueTime: "09:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            name: "Refunded Coffee",
          },
        ],
        cancelation: makeTestCancelation("388"),
      },
      egsInfo,
      storage,
      scope,
      signing: {
        certificate: keys.signingCertificatePem,
        privateKey: keys.signingPrivateKeyPem,
      },
    });
    expect(result.invoiceXml).toContain("<cac:BillingReference>");
    expect(result.invoiceXml).toContain("<cac:PaymentMeans>");
    expect(log.getPreviousHash[0]?.kind).toBe("simplified-credit-note");
  });
});
