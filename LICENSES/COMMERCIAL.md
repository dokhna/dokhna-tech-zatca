# Commercial License — @dokhna-tech/zatca

The Business Source License 1.1 (`LICENSE` at the repository root) permits free use of `@dokhna-tech/zatca` and its sub-packages except when the Licensed Work is offered to third parties as a hosted or embedded SaaS service.

If you intend to use `@dokhna-tech/zatca` to provide ZATCA e-invoicing — or any related service — to third-party customers on a multi-tenant or hosted basis, you must obtain a commercial license from the Licensor.

## What requires a commercial license

- Operating a SaaS platform whose customers issue ZATCA invoices through your service.
- Embedding the Licensed Work in a hosted product offered to third parties.
- Any redistribution of the Licensed Work as part of a commercial product whose value proposition includes the Licensed Work's functionality.

## What does NOT require a commercial license

- Internal use within a single organisation (your own books, your own VAT number).
- Self-hosted single-tenant deployments for your own legal entity.
- Evaluation, development, and testing.
- Personal projects and open-source projects that do not offer hosted ZATCA functionality to third parties.
- Use after the BSL 1.1 Change Date (2030-05-13), at which point the work converts to Apache License 2.0.

## How to obtain a commercial license

Contact `licensing@dokhna.tech` with:

1. Your organisation name and country of registration.
2. The expected number of tenants / VAT numbers you will serve.
3. The expected number of invoices per month.
4. Your timeline.

Commercial licenses are priced per-tenant per-year. A trial license is available for proof-of-concept work.

## Why dual-license?

This package was extracted from a working production helper that took many engineer-months to debug against real ZATCA edge cases. Open-sourcing it under a permissive license would let competitor SaaS platforms ship it without contributing back. The BSL model — used by MariaDB, Sentry, CockroachDB, and Couchbase — keeps the source open and free for the people who actually need to integrate ZATCA into their own books, while asking SaaS providers to contribute commercially. After four years the work automatically becomes Apache 2.0.
