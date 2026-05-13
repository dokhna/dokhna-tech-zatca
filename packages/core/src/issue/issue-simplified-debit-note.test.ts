/**
 * Unit tests — {@link issueSimplifiedDebitNote}.
 */

import { describe, expect, it } from "vitest";
import type { TenantScope } from "../types/storage.js";
import {
  makeTestCancelation,
  makeTestEgsInfo,
  makeTestLineItem,
  readTestKeys,
} from "../invoices/_test-helpers.js";
import { issueSimplifiedDebitNote } from "./issue-simplified-debit-note.js";
import { makeMemoryStorage } from "./_memory-storage.js";

describe("issueSimplifiedDebitNote", () => {
  const egsInfo = makeTestEgsInfo();
  const scope: TenantScope = {
    vatNumber: egsInfo.vatNumber,
    egsUuid: egsInfo.uuid,
  };

  it("issues a simplified debit note", async () => {
    const { storage, log } = makeMemoryStorage();
    const keys = readTestKeys();
    const result = await issueSimplifiedDebitNote({
      input: {
        kind: "simplified-debit-note",
        issueDate: "2024-01-17",
        issueTime: "11:00:00Z",
        lineItems: [
          {
            ...makeTestLineItem(),
            quantity: 1,
            name: "Adjustment",
          },
        ],
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
    expect(result.invoiceXml).toContain("<cac:BillingReference>");
    expect(result.invoiceXml).toContain("<cac:PaymentMeans>");
    expect(log.getPreviousHash[0]?.kind).toBe("simplified-debit-note");
  });
});
