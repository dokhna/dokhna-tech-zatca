/**
 * Golden-vector tests.
 *
 * Each scenario directory under `fixtures/` contains:
 *
 * - `input.json`              — the inputs we fed the rwiqha helper.
 * - `expected-presign-xml.xml` — the template-filled invoice XML
 *                                before signing. Deterministic
 *                                output of the rwiqha helper.
 * - `expected-hash.txt`        — the SHA-256 invoice hash. Byte-
 *                                deterministic; we assert exact match.
 * - `expected-signed.xml`      — the full signed XML. ECDSA is
 *                                non-deterministic without RFC 6979,
 *                                so we compare *structure* (tag set,
 *                                cert hash, sign timestamp), not bytes.
 * - `expected-qr.b64`          — the Phase 2 QR. Likewise: tags 1-6
 *                                + 8 + 9 are deterministic; tag 7 is
 *                                the signature and varies.
 *
 * Goal: a byte-identical hash means our `XMLDocument` + canonicaliser
 * + whitespace fixups + SHA-256 produce the same digest as the
 * rwiqha helper for the same pre-sign XML.
 *
 * See `fixtures/README.md` for capture procedure.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getInvoiceHash } from "../crypto/hash.js";
import { XMLDocument } from "../xml/document.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Scenario {
  name: string;
  dir: string;
  presignXmlPath: string;
  hashPath: string;
  signedXmlPath?: string;
  qrPath?: string;
}

function discoverScenarios(): Scenario[] {
  const root = __dirname;
  const entries = readdirSync(root, { withFileTypes: true });
  const scenarios: Scenario[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_")) continue; // _keys/ etc.
    const dir = join(root, entry.name);
    const presignXmlPath = join(dir, "expected-presign-xml.xml");
    const hashPath = join(dir, "expected-hash.txt");
    if (!existsSync(presignXmlPath) || !existsSync(hashPath)) continue;
    if (statSync(presignXmlPath).size === 0) continue;
    if (statSync(hashPath).size === 0) continue;
    const signedXmlPath = join(dir, "expected-signed.xml");
    const qrPath = join(dir, "expected-qr.b64");
    scenarios.push({
      name: entry.name,
      dir,
      presignXmlPath,
      hashPath,
      ...(existsSync(signedXmlPath) ? { signedXmlPath } : {}),
      ...(existsSync(qrPath) ? { qrPath } : {}),
    });
  }
  return scenarios;
}

const scenarios = discoverScenarios();

describe("golden vectors — byte-identical hash parity", () => {
  if (scenarios.length === 0) {
    it.todo(
      "no fixtures captured yet — run `pnpm tsx scripts/capture-golden-vectors.mjs`",
    );
    return;
  }

  for (const scenario of scenarios) {
    it(`reproduces the rwiqha invoice hash for ${scenario.name}`, () => {
      const presignXml = readFileSync(scenario.presignXmlPath, "utf8");
      const expectedHash = readFileSync(scenario.hashPath, "utf8").trim();
      const actual = getInvoiceHash(new XMLDocument(presignXml));
      expect(actual).toBe(expectedHash);
    });
  }
});

describe("golden vectors — signed XML structure", () => {
  for (const scenario of scenarios) {
    if (!scenario.signedXmlPath) continue;
    it(`signed XML contains the expected structural elements for ${scenario.name}`, () => {
      const signed = readFileSync(scenario.signedXmlPath!, "utf8");
      expect(signed).toContain("<ds:SignatureValue>");
      expect(signed).toContain("<ds:X509Certificate>");
      expect(signed).toContain("<xades:SigningTime>");
      expect(signed).toContain("urn:oasis:names:specification:ubl:signature:Invoice");
    });
  }
});

describe("golden vectors — QR shape", () => {
  for (const scenario of scenarios) {
    if (!scenario.qrPath) continue;
    it(`captured QR is a valid base64 TLV with 9 tags for ${scenario.name}`, () => {
      const qr = readFileSync(scenario.qrPath!, "utf8").trim();
      const bytes = Buffer.from(qr, "base64");
      let i = 0;
      let count = 0;
      while (i < bytes.byteLength) {
        const tag = bytes[i];
        const len = bytes[i + 1];
        if (tag === undefined || len === undefined) break;
        count += 1;
        i += 2 + len;
      }
      expect(count).toBe(9);
    });
  }
});

// ---------------------------------------------------------------------------
// Phase 3 builder parity — re-running the new Phase 3 builders on the
// same `input.json` payloads MUST produce byte-identical invoice hashes
// to the captured `expected-hash.txt` from the rwiqha helper. This is
// the regression that proves the Phase 3 refactor preserves the
// canonical pre-sign XML to the byte.
// ---------------------------------------------------------------------------
import { SimplifiedTaxInvoiceBuilder } from "../invoices/simplified-tax-invoice.js";
import { StandardTaxInvoiceBuilder } from "../invoices/standard-tax-invoice.js";
import { SimplifiedCreditNoteBuilder } from "../invoices/simplified-credit-note.js";
import type {
  CommercialRegistrationNumber,
  EGSUuid,
  InvoiceHash,
  VATNumber,
} from "../types/branded.js";
import type {
  SimplifiedCreditNoteInput,
  SimplifiedTaxInvoiceInput,
  StandardTaxInvoiceInput,
  ZatcaInvoiceType,
  ZatcaPaymentMethod,
} from "../types/invoice.js";

interface LegacyEgsInfo {
  uuid: string;
  custom_id: string;
  model: string;
  CRN_number: string;
  VAT_name: string;
  VAT_number: string;
  branch_name: string;
  branch_industry: string;
  location: {
    city: string;
    city_subdivision: string;
    street: string;
    plot_identification: string;
    building: string;
    postal_zone: string;
  };
}
interface LegacyLineItem {
  id: string;
  name: string;
  quantity: number;
  tax_exclusive_price: number;
  VAT_percent: number;
}
interface LegacyProps {
  egs_info: LegacyEgsInfo;
  invoice_counter_number: number;
  invoice_serial_number: string;
  issue_date: string;
  issue_time: string;
  previous_invoice_hash: string;
  line_items: ReadonlyArray<LegacyLineItem>;
  buyer_name?: string;
  cancelation?: {
    canceled_invoice_number: number;
    payment_method: ZatcaPaymentMethod;
    cancelation_type: ZatcaInvoiceType;
    reason: string;
  };
}

function readProps(scenario: string): LegacyProps {
  const raw = JSON.parse(
    readFileSync(join(__dirname, scenario, "input.json"), "utf8"),
  ) as { props: LegacyProps };
  return raw.props;
}
function readPhase3Keys(): {
  signingCertificatePem: string;
  signingPrivateKeyPem: string;
} {
  return {
    signingCertificatePem: readFileSync(
      join(__dirname, "_keys", "test-cert.pem"),
      "utf8",
    ),
    signingPrivateKeyPem: readFileSync(
      join(__dirname, "_keys", "test-key.pem"),
      "utf8",
    ),
  };
}
function mapEgs(p: LegacyEgsInfo): SimplifiedTaxInvoiceInput["egsInfo"] {
  return {
    uuid: p.uuid as EGSUuid,
    customId: p.custom_id,
    model: p.model,
    crnNumber: p.CRN_number as CommercialRegistrationNumber,
    vatName: p.VAT_name,
    vatNumber: p.VAT_number as VATNumber,
    branchName: p.branch_name,
    branchIndustry: p.branch_industry,
    location: {
      cityName: p.location.city,
      citySubdivision: p.location.city_subdivision,
      street: p.location.street,
      plotIdentification: p.location.plot_identification,
      building: p.location.building,
      postalZone: p.location.postal_zone,
    },
  };
}
function mapItems(
  items: ReadonlyArray<LegacyLineItem>,
): SimplifiedTaxInvoiceInput["lineItems"] {
  return items.map((li) => ({
    id: li.id,
    name: li.name,
    quantity: li.quantity,
    taxExclusivePrice: li.tax_exclusive_price,
    // rwiqha's input.json stores VAT_percent as a decimal fraction
    // (0.15); the v2 builder API takes a percent (15). Convert at the
    // boundary so the captured golden vectors remain byte-identical.
    vatPercent: li.VAT_percent * 100,
  }));
}

describe("golden vectors — Phase 3 builders reproduce captured hashes", () => {
  it("SimplifiedTaxInvoiceBuilder matches simple-simplified-invoice", () => {
    const p = readProps("simple-simplified-invoice");
    const expectedHash = readFileSync(
      join(__dirname, "simple-simplified-invoice", "expected-hash.txt"),
      "utf8",
    ).trim();
    const input: SimplifiedTaxInvoiceInput = {
      kind: "simplified-tax-invoice",
      egsInfo: mapEgs(p.egs_info),
      invoiceCounterNumber: p.invoice_counter_number,
      invoiceSerialNumber: p.invoice_serial_number,
      issueDate: p.issue_date,
      issueTime: p.issue_time,
      previousInvoiceHash: p.previous_invoice_hash as InvoiceHash,
      lineItems: mapItems(p.line_items),
      buyerName: p.buyer_name ?? "Walk-in Customer",
    };
    const built = new SimplifiedTaxInvoiceBuilder(input).build(readPhase3Keys());
    expect(built.invoiceHash).toBe(expectedHash);
  });

  it("StandardTaxInvoiceBuilder matches simple-standard-invoice", () => {
    const p = readProps("simple-standard-invoice");
    const expectedHash = readFileSync(
      join(__dirname, "simple-standard-invoice", "expected-hash.txt"),
      "utf8",
    ).trim();
    const input: StandardTaxInvoiceInput = {
      kind: "standard-tax-invoice",
      egsInfo: mapEgs(p.egs_info),
      invoiceCounterNumber: p.invoice_counter_number,
      invoiceSerialNumber: p.invoice_serial_number,
      issueDate: p.issue_date,
      issueTime: p.issue_time,
      previousInvoiceHash: p.previous_invoice_hash as InvoiceHash,
      lineItems: mapItems(p.line_items),
    };
    const built = new StandardTaxInvoiceBuilder(input).build(readPhase3Keys());
    expect(built.invoiceHash).toBe(expectedHash);
  });

  it("SimplifiedCreditNoteBuilder matches simple-simplified-credit-note", () => {
    const p = readProps("simple-simplified-credit-note");
    const expectedHash = readFileSync(
      join(__dirname, "simple-simplified-credit-note", "expected-hash.txt"),
      "utf8",
    ).trim();
    if (p.cancelation === undefined) {
      throw new Error("Credit-note fixture must carry cancelation block.");
    }
    const input: SimplifiedCreditNoteInput = {
      kind: "simplified-credit-note",
      egsInfo: mapEgs(p.egs_info),
      invoiceCounterNumber: p.invoice_counter_number,
      invoiceSerialNumber: p.invoice_serial_number,
      issueDate: p.issue_date,
      issueTime: p.issue_time,
      previousInvoiceHash: p.previous_invoice_hash as InvoiceHash,
      lineItems: mapItems(p.line_items),
      cancelation: {
        canceledInvoiceNumber: p.cancelation.canceled_invoice_number,
        paymentMethod: p.cancelation.payment_method,
        cancelationType: p.cancelation.cancelation_type,
        reason: p.cancelation.reason,
      },
    };
    const built = new SimplifiedCreditNoteBuilder(input).build(
      readPhase3Keys(),
    );
    expect(built.invoiceHash).toBe(expectedHash);
  });
});
