# Open-sourcing `@dokhna-tech/zatca` — Saudi ZATCA Phase 2 e-invoicing for Node.js

We are releasing `@dokhna-tech/zatca` 1.0.0 today: a complete, audited, dual-licensed implementation of Saudi Arabia's ZATCA Phase 2 e-invoicing requirements for Node.js. Four packages, 332 tests, three byte-identity golden vectors against the official ZATCA reference fixtures.

## Why we built this

Every business operating in Saudi Arabia that wants to issue tax invoices through software is on the hook for Phase 2 compliance. The spec is dense — UBL 2.1 XML profiles, XMLDSig with very specific canonicalisation, a SHA-256 hash chain that has to be byte-identical to ZATCA's expectations, TLV-encoded QR codes, certificate enrolment via the Fatoora portal, and a multi-step API dance involving compliance CSIDs, clearance, reporting, and status callbacks.

We have been running this in production for four years. We have hit every edge case: subtle whitespace differences breaking the hash, fast-xml-parser quirks, certificate format ambiguities, OpenSSL CLI gotchas, the asymmetry between "clear" and "report" flows, and the painful onboarding flow where one wrong field invalidates the whole CSR. None of this is documented in a way that lets a new team ship safely in a week.

Rather than have every Node.js shop in the region re-discover the same lessons, we are publishing the implementation.

## What it does

`@dokhna-tech/zatca` ships:

- **All six Phase 2 invoice types** plus Phase 1 fallbacks — standard tax invoice, standard credit/debit notes, simplified tax invoice, simplified credit notes, with full UBL XML.
- **Crypto and XML** — XMLDSig signing, ZATCA-flavoured SHA-256 hashing, TLV-encoded base64 QR. Three golden vectors run on every CI build and assert byte-identity against ZATCA's published reference outputs.
- **Full API client** — onboarding (compliance CSID → compliance tests → production CSID), clearance, reporting, status check, cancellation. Native `fetch` with configurable retry, exponential backoff, and timeout.
- **End-to-end `onboard()`** — one function call from "I have OTP" to "I have production CSIDs ready to sign with".
- **Pluggable storage** — three first-party adapters (memory, mongo, postgres) sharing one `StorageAdapter` contract verified by a shared conformance suite. Want Prisma? Implement nine methods. There is an example.

## The dual-license thinking

The package is dual-licensed under [BSL 1.1](https://mariadb.com/bsl11/) (free for non-SaaS use) converting to Apache 2.0 on `2030-05-13`. SaaS / multi-tenant production use requires a commercial license.

This is the same model MariaDB, Sentry, CockroachDB, and Couchbase use. Our reasoning is straightforward: a business that uses this internally for its own invoicing has effectively zero impact on us, and we want them to be able to use it freely. A business that wraps this in a hosted service and resells it has a direct commercial dependency on our maintenance, and we want to be paid for that.

The Change Date is non-negotiable: in four years, every version published before that date — including this one — becomes Apache 2.0. That guarantee is the whole point of the BSL model.

## Quickstart

```ts
import { onboard, buildStandardTaxInvoice, signInvoiceXml, buildQR } from "@dokhna-tech/zatca";
import { MemoryStorageAdapter } from "@dokhna-tech/zatca-storage-memory";

// One-time: get production CSIDs
const result = await onboard({
  egsInfo,              // see docs/ONBOARDING.md
  otp: "123456",        // from Fatoora portal
  environment: "simulation",
  solutionName: "MyBilling v1.0",
});

// Per invoice
const xml = buildStandardTaxInvoice({ invoice, seller, buyer });
const signed = signInvoiceXml(xml, result.productionCertificate, result.privateKey);
const qr = buildQR(signed);
```

The [Quickstart](./docs/QUICKSTART.md) walks through the full flow end to end in about ten minutes.

## What's next

v1.1.0 is already on the runway:

- **Replace `@fidm/x509`** with `pkijs` — the dependency is unmaintained, the replacement is already in our transitive tree.
- **Pure-JS OpenSSL path** — drop the CLI binary requirement for CSR generation so this works inside containers without `openssl(1)`.
- **Optional PDF/A-3 sub-package** — for the embed-invoice-in-PDF flows some sectors require.

Issues, discussions, and PRs are welcome on the repository. If you operate a SaaS that needs a commercial license, the contact is in [`LICENSES/COMMERCIAL.md`](./LICENSES/COMMERCIAL.md).

Happy invoicing.
