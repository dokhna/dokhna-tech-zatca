# @dokhna-tech/zatca

[![CI](https://github.com/dokhna/dokhna-tech-zatca/actions/workflows/ci.yml/badge.svg)](https://github.com/dokhna/dokhna-tech-zatca/actions)
[![npm](https://img.shields.io/npm/v/@dokhna-tech/zatca.svg)](https://www.npmjs.com/package/@dokhna-tech/zatca)
[![license](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](https://github.com/dokhna/dokhna-tech-zatca/blob/main/LICENSE)

A TypeScript-first ZATCA Phase 2 e-invoicing library for Saudi Arabia. Build, sign, hash, generate QR codes, and submit invoices to the ZATCA Fatoora system. Supports single-VAT and multi-VAT (multi-tenant SaaS) deployments with a bring-your-own storage adapter pattern.

## Table of contents

- [Why this library exists](#why-this-library-exists)
- [Features](#features)
- [Quickstart](#quickstart)
- [Packages](#packages)
- [Examples](#examples)
- [Documentation](#documentation)
- [Storage adapters](#storage-adapters)
- [Multi-VAT / multi-tenant](#multi-vat--multi-tenant)
- [Requirements](#requirements)
- [License](#license)
- [Contributing](#contributing)

## Why this library exists

We tried several existing Node.js ZATCA Phase 2 packages on a real production system. Each had bugs that surfaced only against real ZATCA sandbox/production flows, and each had to be patched. We rewrote the integration from scratch and ran it against real Saudi Arabian invoices for months. This package is the extracted, decoupled, tested result — open-sourced for everyone with a paid commercial track for SaaS providers.

## Features

- Build and sign all six ZATCA Phase 2 invoice types (Simplified / Standard × Tax invoice / Credit note / Debit note).
- Phase 1 (QR-only) fallback for pre-onboarding.
- One-shot `onboard()` orchestrating key generation, CSR, compliance certificate, the six-scenario compliance test pack, and production CSID issuance.
- Direct ZATCA Compliance, Clearance, and Reporting API clients with retry + structured error normalization.
- Cancel and status-check APIs.
- Certificate management helpers (verify, expiration, validity).
- Pure functional API — no class hierarchy to learn.
- BYO storage via a small `StorageAdapter` interface; reference adapters for MongoDB, PostgreSQL, in-memory.
- Multi-tenant SaaS friendly — per-VAT-number certificate isolation and atomic hash-chain management.
- Zero logging — the package writes nothing to stdout / stderr / disk. Errors are typed exceptions.

## Quickstart

```bash
pnpm add @dokhna-tech/zatca @dokhna-tech/zatca-storage-memory
```

```ts
import {
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  issueSimplifiedTaxInvoice,
  type EGSUnitInfo,
} from "@dokhna-tech/zatca";
import { createMemoryStorageAdapter } from "@dokhna-tech/zatca-storage-memory";

const storage = createMemoryStorageAdapter();
const vatNumber = asVATNumber("301234567890003");
const egsUuid = asEGSUuid("00000000-0000-4000-8000-000000000001");

const egsInfo: EGSUnitInfo = {
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
    kind: "simplified-tax-invoice",
    issueDate: "2026-05-13",
    issueTime: "12:00:00",
    buyerName: "Walk-in customer",
    lineItems: [
      {
        id: "1",
        name: "Coffee 250ml",
        quantity: 2,
        taxExclusivePrice: 10,
        vatPercent: 15,
      },
    ],
  },
});

// issued.signedXml / .invoiceHash / .qrCode / .invoiceNumber / .sequence
```

To get the certificate + key in the first place, run [`onboard()`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/onboarding.md). For the full 15-minute path, see [`docs/getting-started.md`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/getting-started.md).

## Packages

| Package                                                                                                                  | What it is                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [`@dokhna-tech/zatca`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/packages/core)                              | Core: XML build, signing, QR, ZATCA API client, onboarding                                               |
| [`@dokhna-tech/zatca-server`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/packages/server)                     | Standalone multi-tenant ZATCA service (Docker image + HTTP API + encrypted credential vault + audit log) |
| [`@dokhna-tech/zatca-storage-memory`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/packages/storage-memory)     | In-memory adapter (testing/dev)                                                                          |
| [`@dokhna-tech/zatca-storage-mongo`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/packages/storage-mongo)       | MongoDB adapter (Mongoose peer-dep)                                                                      |
| [`@dokhna-tech/zatca-storage-postgres`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/packages/storage-postgres) | PostgreSQL adapter (pg peer-dep)                                                                         |

### Looking for a turnkey deployment?

Don't want to embed the SDK? `@dokhna-tech/zatca-server` ships as a Docker image you point at MongoDB or PostgreSQL and an HTTP API your back-office calls. Tenant onboarding, encrypted credential vault, audit log, and `/metrics` exposition are wired up. See [`examples/standalone-server/`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/examples/standalone-server) for a docker-compose + curl walkthrough.

## Examples

Four runnable example projects under [`examples/`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/examples):

| Example                                                                                                    | Demonstrates                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`standalone-server/`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/examples/standalone-server)   | **Recommended** — boot `@dokhna-tech/zatca-server` via docker-compose (Mongo or Postgres) and onboard + issue via curl.                                       |
| [`single-vat-express/`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/examples/single-vat-express) | Express server, one VAT, in-memory storage, full onboarding + issuance flow.                                                                                  |
| [`multi-vat-saas/`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/examples/multi-vat-saas)         | Fastify server, multiple tenants, per-tenant scoping, MongoDB. Use when you want to embed the SDK in your own server instead of running the standalone image. |
| [`byo-storage-prisma/`](https://github.com/dokhna/dokhna-tech-zatca/tree/main/examples/byo-storage-prisma) | Custom `StorageAdapter` against Prisma + SQLite.                                                                                                              |

From the repo root:

```bash
pnpm install
pnpm --filter @dokhna-tech-examples/single-vat-express start
```

## Documentation

- [Getting started](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/getting-started.md) — 15-minute path to a signed invoice.
- [Standalone server](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/standalone-server.md) — turnkey Docker deployment, when to choose it.
- [Standalone server — HTTP API reference](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/standalone-server-api.md) — every route, body schema, error envelope.
- [Standalone server — operations](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/standalone-server-operations.md) — env vars, vault rotation, audit, metrics, multi-replica caveats.
- [Single VAT deployment](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/single-vat.md) — Express wire-up.
- [Multi-VAT SaaS](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/multi-vat-saas.md) — per-tenant scoping, certificate isolation.
- [Storage adapters](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/storage-adapters.md) — interface contract + custom adapter.
- [Onboarding](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/onboarding.md) — CSR, OTP, compliance certs, production CSID.
- [Compliance tests](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/compliance-tests.md) — `runComplianceTests` + interpreting results.
- [Migration from an existing helper](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/migration-from-existing-helper.md) — function-by-function table.
- [Troubleshooting](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/troubleshooting.md) — ZATCA error codes + Lambda OpenSSL recipe.
- [Security](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/security.md) — secret classification, rotation, zero-logging policy.
- [API reference](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/api-reference.md) — links to the TypeDoc-generated HTML at `docs/typedoc/index.html`.

Regenerate the API reference with `pnpm docs:api`.

## Storage adapters

This package does not lock you into a database. The `StorageAdapter` interface has five methods (atomic counter increment, previous-hash lookup, record invoice, load invoice, update status). We ship three reference implementations; writing your own takes ~80 lines. See [`docs/storage-adapters.md`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/storage-adapters.md).

## Multi-VAT / multi-tenant

Pass a `TenantScope = { vatNumber, egsUuid }` into every storage call. Counters and hash chains are scoped per-tenant. Certificates are passed as parameters, never read from a global. See [`docs/multi-vat-saas.md`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/multi-vat-saas.md).

## Requirements

- Node.js 20+
- pnpm 9+ (for monorepo development)
- OpenSSL CLI installed in the runtime environment (used for CSR generation during EGS onboarding). See [troubleshooting.md](https://github.com/dokhna/dokhna-tech-zatca/blob/main/docs/troubleshooting.md#openssl-not-found) for Lambda / Alpine recipes.
- TypeScript 5.6+ for consumers

## License

This package is dual-licensed:

- **Free for non-SaaS use** under the [Business Source License 1.1](https://github.com/dokhna/dokhna-tech-zatca/blob/main/LICENSE). On 2030-05-13 (four years from the first release), the license automatically converts to Apache License 2.0.
- **Commercial license required for SaaS / multi-tenant production use.** See [`LICENSES/COMMERCIAL.md`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/LICENSES/COMMERCIAL.md).

If you are unsure which applies to your use case, read the LICENSE file's "Additional Use Grant" section or contact `licensing@dokhna.tech`.

The BSL model is used by MariaDB, Sentry, CockroachDB, and Couchbase. It is a source-available license, not an OSI-approved open-source license, until the Change Date.

## Contributing

See [`CONTRIBUTING.md`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/CONTRIBUTING.md). Security issues: see [`SECURITY.md`](https://github.com/dokhna/dokhna-tech-zatca/blob/main/SECURITY.md).
