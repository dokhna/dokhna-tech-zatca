# Single-VAT deployment

You operate a single Saudi VAT registration and want to wire ZATCA Phase 2 into one Node.js service. This is the simplest topology supported.

## Topology

- One `EGSUnitInfo` per cash register / billing endpoint.
- One private key + production CSID per EGS.
- One `StorageAdapter` instance, shared across requests.
- One constant `TenantScope = { vatNumber, egsUuid }` passed to every issue call.

## Minimal Express server

```ts
import express from "express";
import { randomUUID } from "node:crypto";
import {
  issueSimplifiedTaxInvoice,
  singleInvoiceReportingOrClearanceStatus,
  asVATNumber,
  asCommercialRegistrationNumber,
  asEGSUuid,
  type TenantScope,
  type EGSUnitInfo,
} from "@dokhna-tach/zatca";
import { createMemoryStorageAdapter } from "@dokhna-tach/zatca-storage-memory";

const storage = createMemoryStorageAdapter();

const vatNumber = asVATNumber(process.env["VAT_NUMBER"] ?? "");
const egsUuid = asEGSUuid(process.env["EGS_UUID"] ?? "");
const scope: TenantScope = { vatNumber, egsUuid };

const egsInfo: EGSUnitInfo = {
  uuid: egsUuid,
  customId: process.env["EGS_CUSTOM_ID"] ?? "default",
  model: process.env["EGS_MODEL"] ?? "Express POS",
  crnNumber: asCommercialRegistrationNumber(process.env["CRN"] ?? ""),
  vatName: process.env["VAT_NAME"] ?? "",
  vatNumber,
  branchName: process.env["BRANCH_NAME"] ?? "Main",
  branchIndustry: process.env["BRANCH_INDUSTRY"] ?? "Retail",
  location: {
    cityName: "Riyadh",
    citySubdivision: "Olaya",
    street: "King Fahd Rd",
    plotIdentification: "1234",
    building: "5678",
    postalZone: "12345",
  },
};

const app = express();
app.use(express.json());

app.post("/invoices", async (req, res) => {
  const issued = await issueSimplifiedTaxInvoice({
    egsInfo,
    storage,
    scope,
    signing: {
      certificate: process.env["ZATCA_PRODUCTION_CERTIFICATE"] ?? "",
      privateKey: process.env["ZATCA_PRIVATE_KEY"] ?? "",
    },
    invoiceId: randomUUID(),
    input: {
      issueDate: req.body.issueDate,
      issueTime: req.body.issueTime,
      lineItems: req.body.lineItems,
      buyerName: req.body.buyerName,
    },
  });

  res.json({
    invoiceNumber: issued.invoiceNumber,
    qrCode: issued.qrCode,
    invoiceHash: issued.invoiceHash,
  });
});

app.listen(3000);
```

The full runnable equivalent is in [`examples/single-vat-express/`](../examples/single-vat-express/).

## Submitting to ZATCA

`issueSimplifiedTaxInvoice` only builds + signs + records. To send the document to the gateway:

```ts
import { singleInvoiceReportingOrClearanceStatus } from "@dokhna-tach/zatca";

const submission = await singleInvoiceReportingOrClearanceStatus({
  signedInvoiceXml: issued.signedXml,
  invoiceHash: issued.invoiceHash,
  egsUuid: egsInfo.uuid,
  binarySecurityToken: process.env["ZATCA_PRODUCTION_BST"] ?? "",
  apiSecret: process.env["ZATCA_PRODUCTION_API_SECRET"] ?? "",
  environment: "production",
});

// submission.endpoint is "reporting" for simplified invoices,
// "clearance" for standard. submission.response carries the ZATCA envelope.
await storage.updateInvoiceStatus(
  scope,
  issuedInvoiceId,
  submission.response.reportingStatus === "REPORTED" ? "accepted" : "rejected",
);
```

The dispatcher reads the invoice type from the signed XML and routes to the correct endpoint — you do not pick.

## Where to put the certificate + key

Three patterns, increasing rigor:

1. **Environment variables** — quickest for staging / single-host deployments. The example above does this.
2. **AWS Secrets Manager / GCP Secret Manager / Vault** — production default. Cache the resolved values per process; rotate via your platform's secret-rotation hook.
3. **HSM / KMS-wrapped envelope** — the private key is encrypted at rest with a KMS data key; decrypt in-process before signing.

The library never reads the key or certificate from disk — it accepts them as arguments to every signing call. See [security.md](./security.md) for the threat model.

## Variant cookbook

The issuer functions all share the same shape — pass `input`, `egsInfo`, `storage`, `scope`, `signing`, get back an `IssuedInvoice`. Pick the function that matches the document:

| Document | Function |
|----------|----------|
| Simplified tax invoice (B2C) | `issueSimplifiedTaxInvoice` |
| Standard tax invoice (B2B) | `issueStandardTaxInvoice` |
| Simplified credit note (B2C refund) | `issueSimplifiedCreditNote` |
| Standard credit note (B2B refund) | `issueStandardCreditNote` |
| Simplified debit note (B2C upward) | `issueSimplifiedDebitNote` |
| Standard debit note (B2B upward) | `issueStandardDebitNote` |
| Phase 1 invoice (QR-only) | `issuePhase1Invoice` |
| Phase 1 credit note | `issuePhase1CreditNote` |

If you need to dispatch dynamically (variant decided at runtime), use `issueInvoice` with the discriminated `InvoiceInput` union.
