# @dokhna-tech/zatca-storage-mongo

MongoDB (Mongoose) `StorageAdapter` for [`@dokhna-tech/zatca`](https://www.npmjs.com/package/@dokhna-tech/zatca). Suitable for production single-VAT and multi-VAT (multi-tenant SaaS) deployments.

[![npm](https://img.shields.io/npm/v/@dokhna-tech/zatca-storage-mongo.svg)](https://www.npmjs.com/package/@dokhna-tech/zatca-storage-mongo)
[![license](https://img.shields.io/badge/license-BUSL--1.1-blue.svg)](./LICENSE)

## Install

```bash
npm install @dokhna-tech/zatca @dokhna-tech/zatca-storage-mongo mongoose
```

Peer dependencies:
- `@dokhna-tech/zatca` — the core library
- `mongoose >= 8.0.0`

## Usage

```ts
import mongoose from "mongoose";
import { createMongoStorageAdapter } from "@dokhna-tech/zatca-storage-mongo";
import { issueSimplifiedTaxInvoice, asVATNumber, asEGSUuid } from "@dokhna-tech/zatca";

await mongoose.connect(process.env.MONGO_URL!);

const storage = createMongoStorageAdapter({
  connection: mongoose.connection,
});

const result = await issueSimplifiedTaxInvoice({
  storage,
  vatNumber: asVATNumber("310123456700003"),
  egsUuid: asEGSUuid("11111111-2222-3333-4444-555555555555"),
  // ...rest of the invoice payload
});
```

The adapter serialises hash-chain writes atomically per `{vatNumber, egsUuid}` scope, so it's safe under concurrent invoice issuance from multiple Node.js processes. Collection models are built lazily from the Mongoose connection you provide — no extra schema registration needed.

The factory also accepts optional clock and invoice-number formatter overrides; see the TypeScript signature.

## Collections

The adapter manages two collections:

- `zatcacounters` — per-VAT, per-EGS monthly sequence counters.
- `zatcainvoices` — issued invoices, hashes, and chain pointers.

Collection names are deterministic from the Mongoose model name; you can deploy alongside your existing application schema.

## License

BUSL-1.1 — see [LICENSE](./LICENSE). The license converts to Apache 2.0 on 2030-05-13. SaaS / multi-tenant production use requires a commercial license; see the [main repo](https://github.com/dokhna-tech/zatca) for terms.
