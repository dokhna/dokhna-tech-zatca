# @dokhna-tach/zatca

[![CI](https://github.com/dokhna-tach/zatca/actions/workflows/ci.yml/badge.svg)](https://github.com/dokhna-tach/zatca/actions)
[![npm](https://img.shields.io/npm/v/@dokhna-tach/zatca.svg)](https://www.npmjs.com/package/@dokhna-tach/zatca)
[![license](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](./LICENSE)

A TypeScript-first ZATCA Phase 2 e-invoicing library for Saudi Arabia. Build, sign, hash, generate QR codes, and submit invoices to the ZATCA Fatoora system. Supports single-VAT and multi-VAT (multi-tenant SaaS) deployments with a bring-your-own storage adapter pattern.

> **Status: v0.1.0-alpha — under active development.** See [`plan/`](./plan/README.md) for the multi-phase roadmap.

## Table of contents

- [Why this library exists](#why-this-library-exists)
- [Features](#features)
- [Quickstart](#quickstart)
- [Packages](#packages)
- [Storage adapters](#storage-adapters)
- [Multi-VAT / multi-tenant](#multi-vat--multi-tenant)
- [Requirements](#requirements)
- [Documentation](#documentation)
- [License](#license)
- [Contributing](#contributing)

## Why this library exists

We tried several existing Node.js ZATCA Phase 2 packages on a real production system. Each had bugs that surfaced only against real ZATCA sandbox/production flows, and each had to be patched. We rewrote the integration from scratch and ran it against real Saudi Arabian invoices for months. This package is the extracted, decoupled, tested result — open-sourced for everyone with a paid commercial track for SaaS providers.

## Features

- Build and sign all six ZATCA Phase 2 invoice types (Simplified / Standard × Tax invoice / Credit note / Debit note).
- Phase 1 (QR-only) fallback for pre-onboarding.
- Compliance test runner for new EGS unit onboarding.
- Direct ZATCA Compliance, Clearance, and Reporting API clients.
- Cancel and status-check APIs.
- Certificate management helpers (verify, expiration, validity).
- Pure functional API — no class hierarchy to learn.
- BYO storage via a small `StorageAdapter` interface; reference adapters for MongoDB, PostgreSQL, in-memory.
- Multi-tenant SaaS friendly — per-VAT-number certificate isolation and atomic hash-chain management.

## Quickstart

```bash
pnpm add @dokhna-tach/zatca @dokhna-tach/zatca-storage-memory
```

```ts
// Placeholder — Phase 6 onwards
```

Full quickstart will land in Phase 7. Track progress in [`plan/PROGRESS.md`](./plan/PROGRESS.md).

## Packages

| Package | What it is |
|---------|------------|
| [`@dokhna-tach/zatca`](./packages/core) | Core: XML build, signing, QR, ZATCA API client, onboarding |
| [`@dokhna-tach/zatca-storage-memory`](./packages/storage-memory) | In-memory adapter (testing/dev) |
| [`@dokhna-tach/zatca-storage-mongo`](./packages/storage-mongo) | MongoDB adapter (Mongoose peer-dep) |
| [`@dokhna-tach/zatca-storage-postgres`](./packages/storage-postgres) | PostgreSQL adapter (pg peer-dep) |

## Storage adapters

This package does not lock you into a database. The `StorageAdapter` interface has five methods (atomic counter increment, previous-hash lookup, record invoice, load invoice, update status). We ship three reference implementations; writing your own takes ~50 lines. See `docs/storage-adapters.md` (Phase 7).

## Multi-VAT / multi-tenant

Pass a `TenantScope = { vatNumber, egsUuid }` into every storage call. Counters and hash chains are scoped per-tenant. Certificates are passed as parameters, never read from a global. See `docs/multi-vat-saas.md` (Phase 7).

## Requirements

- Node.js 20+
- pnpm 9+ (for monorepo development)
- OpenSSL CLI installed in the runtime environment (used for CSR generation during EGS onboarding)
- TypeScript 5.6+ for consumers

## Documentation

All documentation lives under `docs/` (created in Phase 7). The current development roadmap is in [`plan/`](./plan/).

## License

This package is dual-licensed:

- **Free for non-SaaS use** under the [Business Source License 1.1](./LICENSE). On 2030-05-13 (four years from the first release), the license automatically converts to Apache License 2.0.
- **Commercial license required for SaaS / multi-tenant production use.** See [`LICENSES/COMMERCIAL.md`](./LICENSES/COMMERCIAL.md).

If you are unsure which applies to your use case, read the LICENSE file's "Additional Use Grant" section or contact `licensing@dokhna-tach.example`.

The BSL model is used by MariaDB, Sentry, CockroachDB, and Couchbase. It is a source-available license, not an OSI-approved open-source license, until the Change Date.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Security issues: see [`SECURITY.md`](./SECURITY.md).
