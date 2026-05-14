# @dokhna-tech/zatca-storage-memory

In-memory `StorageAdapter` for [`@dokhna-tech/zatca`](https://www.npmjs.com/package/@dokhna-tech/zatca). For testing and development only — data is lost on process restart and is not shared across processes.

[![npm](https://img.shields.io/npm/v/@dokhna-tech/zatca-storage-memory.svg)](https://www.npmjs.com/package/@dokhna-tech/zatca-storage-memory)
[![license](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](./LICENSE)

## Install

```bash
npm install @dokhna-tech/zatca @dokhna-tech/zatca-storage-memory
```

`@dokhna-tech/zatca` is a peer dependency.

## Usage

```ts
import { createMemoryStorageAdapter } from "@dokhna-tech/zatca-storage-memory";
import { issueSimplifiedTaxInvoice, asVATNumber, asEGSUuid } from "@dokhna-tech/zatca";

const storage = createMemoryStorageAdapter();

const result = await issueSimplifiedTaxInvoice({
  storage,
  vatNumber: asVATNumber("310123456700003"),
  egsUuid: asEGSUuid("11111111-2222-3333-4444-555555555555"),
  // ...rest of the invoice payload
});
```

The factory accepts an optional `options` object for clock injection and custom invoice-number formatting — see the TypeScript signature for details.

## When to use

- **Yes:** unit and integration tests, local development without a database, spike / proof-of-concept work.
- **No:** production. Data is lost on restart and never shared between processes — use [`@dokhna-tech/zatca-storage-mongo`](https://www.npmjs.com/package/@dokhna-tech/zatca-storage-mongo) or [`@dokhna-tech/zatca-storage-postgres`](https://www.npmjs.com/package/@dokhna-tech/zatca-storage-postgres) instead.

## License

BUSL-1.1 — see [LICENSE](./LICENSE). The license converts to Apache 2.0 on 2030-05-13. SaaS / multi-tenant production use requires a commercial license; see the [main repo](https://github.com/dokhna-tech/zatca) for terms.
