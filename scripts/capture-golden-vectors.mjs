/**
 * Golden-vector capture script.
 *
 * Reads the rwiqha helper directly from
 * /Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/
 * and produces deterministic test fixtures under
 * packages/core/src/fixtures/<scenario>/.
 *
 * Run with: `pnpm tsx scripts/capture-golden-vectors.mjs`
 *
 * Determinism notes:
 *
 * - Inputs (UUIDs, dates, amounts) are hard-coded — see SCENARIOS.
 * - The certificate + private key are generated ONCE and committed
 *   under fixtures/_keys/ so re-running the script produces the
 *   same hashes / pre-signature XML. (Signed XML + QR vary across
 *   runs because ECDSA-OpenSSL is non-deterministic; fixture tests
 *   compare only the deterministic parts — see fixtures/README.md.)
 *
 * Limitation: ECDSA without RFC 6979 ⇒ signed XML / QR differ run-
 * to-run even with identical inputs. The fixtures we capture and
 * commit are still useful: hash + pre-sign-template-fill are
 * byte-deterministic and represent the ground truth the port must
 * reproduce.
 */

import { spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const RWIQHA_SRC = resolve(
  "/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices",
);
const FIXTURES_DIR = resolve(REPO_ROOT, "packages/core/src/fixtures");
const KEYS_DIR = join(FIXTURES_DIR, "_keys");

if (!existsSync(RWIQHA_SRC)) {
  process.stderr.write(
    `Rwiqha source not found at ${RWIQHA_SRC}. Skipping capture.\n`,
  );
  process.exit(2);
}

mkdirSync(KEYS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Test key + self-signed cert. Generated once and committed under
// fixtures/_keys/ so re-runs of this script don't change the fixtures
// solely because the key changed.
// ---------------------------------------------------------------------------

const KEY_PATH = join(KEYS_DIR, "test-key.pem");
const CERT_PATH = join(KEYS_DIR, "test-cert.pem");

if (!existsSync(KEY_PATH) || !existsSync(CERT_PATH)) {
  process.stderr.write("Generating test key + self-signed cert...\n");
  // openssl ecparam to match rwiqha's expectations
  const keyResult = spawnSync(
    "openssl",
    ["ecparam", "-name", "secp256k1", "-genkey", "-noout", "-out", KEY_PATH],
    { stdio: "inherit" },
  );
  if (keyResult.status !== 0) {
    process.stderr.write("openssl ecparam failed.\n");
    process.exit(1);
  }
  const certResult = spawnSync(
    "openssl",
    [
      "req",
      "-new",
      "-x509",
      "-key",
      KEY_PATH,
      "-out",
      CERT_PATH,
      "-days",
      "3650",
      "-subj",
      "/C=SA/O=Acme LLC/OU=Riyadh Branch/CN=acme-egs-001",
    ],
    { stdio: "inherit" },
  );
  if (certResult.status !== 0) {
    process.stderr.write("openssl req -x509 failed.\n");
    process.exit(1);
  }
}

const PRIVATE_KEY = readFileSync(KEY_PATH, "utf8");
const CERTIFICATE = readFileSync(CERT_PATH, "utf8");

// ---------------------------------------------------------------------------
// Import the rwiqha helper. We dynamic-import via tsx so the .ts
// source is evaluated directly without modifying rwiqha-backend.
// ---------------------------------------------------------------------------

let ZATCASimplifiedTaxInvoice;
let ZATCAStandardTaxInvoice;
let ZATCASimplifiedCreditNote;

try {
  ({ ZATCASimplifiedTaxInvoice } = await import(
    `file://${RWIQHA_SRC}/zatca.package/classes/zatca.simplified.tax.invoice.ts`
  ));
  ({ ZATCAStandardTaxInvoice } = await import(
    `file://${RWIQHA_SRC}/zatca.package/classes/zatca.standard.tax.invoice.ts`
  ));
  ({ ZATCASimplifiedCreditNote } = await import(
    `file://${RWIQHA_SRC}/zatca.package/classes/zatca.simplified.credit.note.ts`
  ));
} catch (err) {
  process.stderr.write(
    `Failed to import rwiqha helper sources via tsx. ` +
      `Run with: pnpm tsx scripts/capture-golden-vectors.mjs\n` +
      `Underlying error: ${err.message}\n`,
  );
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Scenario inputs — fully deterministic. Each scenario captures
// input.json + the produced artefacts.
// ---------------------------------------------------------------------------

const EGS_INFO = {
  uuid: "11111111-2222-3333-4444-555555555555",
  custom_id: "ACME-001",
  model: "SimplePOS-X1",
  CRN_number: "1010101010",
  VAT_name: "Acme LLC",
  VAT_number: "301234567890003",
  branch_name: "Riyadh Branch",
  branch_industry: "Retail",
  location: {
    city: "Riyadh",
    city_subdivision: "Olaya",
    street: "King Fahd Road",
    plot_identification: "1234",
    building: "1",
    postal_zone: "11564",
  },
  private_key: PRIVATE_KEY,
  compliance_certificate: CERTIFICATE,
};

const SCENARIOS = [
  {
    name: "simple-simplified-invoice",
    klass: ZATCASimplifiedTaxInvoice,
    props: {
      egs_info: EGS_INFO,
      invoice_counter_number: 1,
      invoice_serial_number: "INV-0001",
      issue_date: "2024-01-15",
      issue_time: "14:30:45Z",
      previous_invoice_hash:
        "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
      line_items: [
        {
          id: "1",
          name: "Coffee",
          quantity: 2,
          tax_exclusive_price: 10,
          VAT_percent: 0.15,
        },
      ],
      buyer_name: "Walk-in Customer",
    },
  },
  {
    name: "simple-standard-invoice",
    klass: ZATCAStandardTaxInvoice,
    props: {
      egs_info: EGS_INFO,
      invoice_counter_number: 2,
      invoice_serial_number: "INV-0002",
      issue_date: "2024-01-15",
      issue_time: "14:31:00Z",
      previous_invoice_hash:
        "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
      line_items: [
        {
          id: "1",
          name: "Service Fee",
          quantity: 1,
          tax_exclusive_price: 100,
          VAT_percent: 0.15,
        },
      ],
    },
  },
  {
    name: "simple-simplified-credit-note",
    klass: ZATCASimplifiedCreditNote,
    props: {
      egs_info: EGS_INFO,
      invoice_counter_number: 3,
      invoice_serial_number: "CN-0001",
      issue_date: "2024-01-16",
      issue_time: "09:00:00Z",
      previous_invoice_hash:
        "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==",
      line_items: [
        {
          id: "1",
          name: "Refunded Coffee",
          quantity: 1,
          tax_exclusive_price: 10,
          VAT_percent: 0.15,
        },
      ],
      cancelation: {
        canceled_invoice_number: 1,
        payment_method: "10",
        cancelation_type: "388",
        reason: "Customer return",
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Capture loop.
// ---------------------------------------------------------------------------

for (const scenario of SCENARIOS) {
  const dir = join(FIXTURES_DIR, scenario.name);
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    join(dir, "input.json"),
    JSON.stringify(
      {
        klass: scenario.klass.name,
        props: scenario.props,
      },
      null,
      2,
    ),
  );

  let invoice;
  try {
    invoice = new scenario.klass({ props: scenario.props });
  } catch (err) {
    process.stderr.write(
      `Failed to construct ${scenario.klass.name} for ${scenario.name}: ${err.message}\n`,
    );
    continue;
  }

  const presignXmlDoc = invoice.getXML?.() ?? invoice.invoice_xml;
  const presignXml = presignXmlDoc.toString({ no_header: false });
  writeFileSync(join(dir, "expected-presign-xml.xml"), presignXml);

  let signed;
  try {
    signed = invoice.sign(CERTIFICATE, PRIVATE_KEY);
  } catch (err) {
    process.stderr.write(
      `Sign step failed for ${scenario.name}: ${err.message}\n`,
    );
    continue;
  }

  if (signed) {
    writeFileSync(join(dir, "expected-hash.txt"), signed.invoice_hash);
    writeFileSync(join(dir, "expected-signed.xml"), signed.signed_invoice_string);
    writeFileSync(join(dir, "expected-qr.b64"), signed.qr);
  }

  process.stdout.write(`Captured: ${scenario.name}\n`);
}

process.stdout.write(`\nDone. Fixtures written under ${FIXTURES_DIR}\n`);
