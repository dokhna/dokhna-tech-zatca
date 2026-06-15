# Getting started

Get from `npm install` to a signed Phase 2 invoice in 15 minutes.

## 1. Install

```bash
pnpm add @dokhna-tech/zatca @dokhna-tech/zatca-storage-memory
# or for a real database:
pnpm add @dokhna-tech/zatca @dokhna-tech/zatca-storage-mongo mongoose
pnpm add @dokhna-tech/zatca @dokhna-tech/zatca-storage-postgres pg
```

Peer requirements:

- **Node.js 20+**.
- **OpenSSL CLI** on `PATH`. The library shells out to `openssl` once during onboarding to generate the secp256k1 key + CSR. See [security.md](./security.md#openssl-cli-dependency) and [troubleshooting.md](./troubleshooting.md#openssl-not-found) for Lambda / Alpine notes.

## 2. The 15-minute path

There are three flows. Pick the one that matches where you are.

### Flow A: I already have ZATCA-issued credentials

Skip to **issuing your first invoice** below.

### Flow B: I am onboarding a brand-new EGS (Electronic Generation Solution)

You need a fresh OTP from the **Fatoora portal** (`fatoora.zatca.gov.sa`) for your target environment. `onboard()` accepts `sandbox`, `simulation`, and `production` — rehearse on `simulation`, then pass `environment: "production"` (with a production-portal OTP) to issue the live CSID. The embedded compliance test pack runs on every environment as part of CSID issuance.

```ts
import {
  onboard,
  asVATNumber,
  asCommercialRegistrationNumber,
  asEGSUuid,
} from "@dokhna-tech/zatca";
import { randomUUID } from "node:crypto";

const result = await onboard({
  egsInfo: {
    uuid: asEGSUuid(randomUUID()),
    customId: "branch-01-pos-03",
    model: "Acme POS v2",
    crnNumber: asCommercialRegistrationNumber("1010010101"),
    vatName: "Acme Trading Co.",
    vatNumber: asVATNumber("301234567890003"),
    branchName: "Riyadh HQ",
    branchIndustry: "Retail",
    location: {
      cityName: "Riyadh",
      citySubdivision: "Olaya",
      street: "King Fahd Road",
      plotIdentification: "1234",
      building: "5678",
      postalZone: "12345",
    },
  },
  otp: "123456", // 6-digit OTP from Fatoora portal — burns on use
  environment: "simulation",
  solutionName: "MyBilling SaaS v1.0",
});
```

`result` carries **everything you must persist before the OTP expires**:

| Field | Sensitivity | Persist where |
|-------|------------|---------------|
| `privateKey` | SECRET | encrypted at rest |
| `csr` | not secret | optional audit log |
| `complianceCertificate` | not secret | DB or cert store |
| `complianceBinarySecurityToken` | not secret | DB or cert store |
| `complianceApiSecret` | SECRET | encrypted at rest |
| `productionCertificate` | not secret | DB or cert store |
| `productionBinarySecurityToken` | not secret | DB or cert store |
| `productionApiSecret` | SECRET | encrypted at rest |
| `complianceTestReport` | not secret | audit log |

See [security.md](./security.md) for the full storage / rotation guidance.

> Heads-up: the ZATCA sandbox / simulation hostnames and the auth scheme used for cancel/status calls were inferred from a known-working production helper but have not yet been verified against a fresh live gateway in this branch. If your first invoice round-trip hits a 404 or a 401, see [troubleshooting.md](./troubleshooting.md#urls-and-auth-scheme-drift-caveat).

### Flow C: I want a turnkey HTTP service, not an embedded SDK

Run `@dokhna-tech/zatca-server` as a Docker image. Your back-office calls its HTTP API (`POST /v1/tenants/:ref/onboard`, `POST /v1/tenants/:ref/invoices`, etc.) instead of embedding the SDK. Tenant onboarding, an encrypted credential vault, an append-only audit log, and Prometheus `/metrics` are wired up.

Three required env vars and a single `docker run`:

```bash
ADMIN_KEY="ops:$(openssl rand -base64 48 | tr -d '=' | head -c 48)"
MASTER_KEY="v1:$(openssl rand -base64 32)"

docker run --rm -p 3000:3000 \
  -e ZATCA_SERVER_ADMIN_KEYS="$ADMIN_KEY" \
  -e ZATCA_SERVER_MASTER_KEYS="$MASTER_KEY" \
  -e ZATCA_SERVER_ACTIVE_KID="v1" \
  -e STORAGE_DRIVER="memory" \
  ghcr.io/dokhna/zatca-server:latest
```

See [standalone-server.md](./standalone-server.md) for the orientation, [standalone-server-api.md](./standalone-server-api.md) for the HTTP reference, [standalone-server-operations.md](./standalone-server-operations.md) for env vars and ops, and [`examples/standalone-server/`](../examples/standalone-server/) for a docker-compose walkthrough with Mongo or Postgres.

## 3. Issue your first invoice

The shortest path is the in-memory storage adapter — useful for local dev, automated tests, and "is this thing on" smoke checks.

```ts
import {
  issueSimplifiedTaxInvoice,
  asEGSUuid,
  asVATNumber,
  asCommercialRegistrationNumber,
} from "@dokhna-tech/zatca";
import { createMemoryStorageAdapter } from "@dokhna-tech/zatca-storage-memory";

const storage = createMemoryStorageAdapter();

const vatNumber = asVATNumber("301234567890003");
const egsUuid = asEGSUuid("00000000-0000-4000-8000-000000000001");

const egsInfo = {
  uuid: egsUuid,
  customId: "branch-01-pos-03",
  model: "Acme POS v2",
  crnNumber: asCommercialRegistrationNumber("1010010101"),
  vatName: "Acme Trading Co.",
  vatNumber,
  branchName: "Riyadh HQ",
  branchIndustry: "Retail",
  location: {
    cityName: "Riyadh",
    citySubdivision: "Olaya",
    street: "King Fahd Road",
    plotIdentification: "1234",
    building: "5678",
    postalZone: "12345",
  },
};

const issued = await issueSimplifiedTaxInvoice({
  egsInfo,
  storage,
  scope: { vatNumber, egsUuid },
  signing: {
    certificate: process.env["ZATCA_PRODUCTION_CERTIFICATE"] ?? "",
    privateKey: process.env["ZATCA_PRIVATE_KEY"] ?? "",
  },
  input: {
    issueDate: "2026-05-13",
    issueTime: "12:00:00",
    lineItems: [
      {
        id: "1",
        name: "Coffee 250ml",
        quantity: 2,
        taxExclusivePrice: 10,
        vatPercent: 15,
      },
    ],
    buyerName: "Walk-in customer",
  },
});

// issued.signedXml — full signed UBL XML
// issued.invoiceHash — base64 SHA-256
// issued.qrCode — base64 Phase 2 TLV QR
// issued.invoiceNumber — printable serial, e.g. "202605000001"
// issued.sequence — numeric ICV
```

You now have a signed Phase 2 invoice. Submitting it to ZATCA is one more call — see [single-vat.md](./single-vat.md#submitting-to-zatca) for the wiring.

## 4. Where next

- Turnkey HTTP service (Docker image, no SDK to embed): [standalone-server.md](./standalone-server.md), [HTTP API reference](./standalone-server-api.md), [operations](./standalone-server-operations.md).
- One VAT registration, one process: [single-vat.md](./single-vat.md).
- SaaS handling multiple tenants on one runtime: [multi-vat-saas.md](./multi-vat-saas.md).
- Custom database adapter: [storage-adapters.md](./storage-adapters.md).
- Running the six required compliance scenarios manually: [compliance-tests.md](./compliance-tests.md).
- Migrating from a previous in-house helper: [migration-from-existing-helper.md](./migration-from-existing-helper.md).
- Troubleshooting and ZATCA error codes: [troubleshooting.md](./troubleshooting.md).
- Secret handling, certificate rotation, what we log: [security.md](./security.md).
- Generated API reference: `./typedoc/index.html`.
