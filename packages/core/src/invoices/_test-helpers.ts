/**
 * Test-only helpers shared by every `invoices/*.test.ts` file.
 *
 * Not exported from the package — the `_` prefix keeps `*.test.ts`
 * imports compatible with vitest's path discovery while making it
 * obvious this is internal.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommercialRegistrationNumber,
  EGSUuid,
  InvoiceHash,
  VATNumber,
} from "../types/branded.js";
import type { EGSUnitInfo } from "../types/egs.js";
import type {
  ZATCAInvoiceCancelation,
  ZATCAInvoiceLineItem,
} from "../types/invoice.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the `_keys/` directory shared by every fixture. */
export const KEYS_DIR = join(__dirname, "..", "fixtures", "_keys");

/** Reads the PEM test cert + private key bundled with the fixtures. */
export function readTestKeys(): {
  signingCertificatePem: string;
  signingPrivateKeyPem: string;
} {
  return {
    signingCertificatePem: readFileSync(
      join(KEYS_DIR, "test-cert.pem"),
      "utf8",
    ),
    signingPrivateKeyPem: readFileSync(
      join(KEYS_DIR, "test-key.pem"),
      "utf8",
    ),
  };
}

/**
 * Builds a deterministic, minimal-valid `EGSUnitInfo` for tests. Same
 * shape as the captured fixtures so test inputs round-trip the
 * existing golden vectors.
 */
export function makeTestEgsInfo(): EGSUnitInfo {
  return {
    uuid: "11111111-2222-3333-4444-555555555555" as EGSUuid,
    customId: "ACME-001",
    model: "SimplePOS-X1",
    crnNumber: "1010101010" as CommercialRegistrationNumber,
    vatName: "Acme LLC",
    vatNumber: "301234567890003" as VATNumber,
    branchName: "Riyadh Branch",
    branchIndustry: "Retail",
    location: {
      cityName: "Riyadh",
      citySubdivision: "Olaya",
      street: "King Fahd Road",
      plotIdentification: "1234",
      building: "1",
      postalZone: "11564",
    },
  };
}

/** The all-zero PIH base hash per the ZATCA spec — first invoice on chain. */
export const BASE_PIH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

/** A single canonical line item used by most builder tests. */
export function makeTestLineItem(): ZATCAInvoiceLineItem {
  return {
    id: "1",
    name: "Coffee",
    quantity: 2,
    taxExclusivePrice: 10,
    vatPercent: 0.15,
  };
}

/** Standard cancelation block referenced by every credit / debit-note test. */
export function makeTestCancelation(
  cancelationType: ZATCAInvoiceCancelation["cancelationType"],
): ZATCAInvoiceCancelation {
  return {
    canceledInvoiceNumber: 1,
    paymentMethod: "10",
    cancelationType,
    reason: "Customer return",
  };
}
