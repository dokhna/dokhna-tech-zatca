# Plan — @dokhna-tach/zatca

This directory drives the multi-phase implementation of the package. It is the source of truth for what is being built next, who is building it, and how progress is verified.

## Files

| File | Purpose |
|------|---------|
| `README.md` | This index |
| `ORCHESTRATOR.md` | Spec of the top-level orchestrator that runs each phase |
| `OBSERVER.md` | Spec of the 2-minute observer that monitors progress |
| `PROGRESS.md` | Live progress table — updated by each phase agent on entry/exit |
| `observer.log` | Append-only log written by the observer every 2 minutes |
| `PHASES/PHASE-00-bootstrap.md` | Bootstrap & plan directory (done) |
| `PHASES/PHASE-01-types.md` | Type system foundation |
| `PHASES/PHASE-02-crypto-xml.md` | Crypto, XML, QR core |
| `PHASES/PHASE-03-invoice-builders.md` | Invoice / credit / debit builders |
| `PHASES/PHASE-04-api-client.md` | ZATCA API client |
| `PHASES/PHASE-05-storage-adapters.md` | Storage adapter interface + reference impls |
| `PHASES/PHASE-06-onboarding-compliance.md` | Onboarding, compliance tests, cert management |
| `PHASES/PHASE-07-docs-examples.md` | Documentation & examples |
| `PHASES/PHASE-08-release.md` | Release hygiene |

## Phases at a glance

| # | Title | Agent | Status |
|---|-------|-------|--------|
| 0 | Bootstrap & plan directory | build-engineer | done |
| 1 | Type system foundation | typescript-pro | pending |
| 2 | Crypto, XML, QR core | backend-developer | pending |
| 3 | Invoice / credit / debit builders | backend-developer | pending |
| 4 | ZATCA API client | backend-developer | pending |
| 5 | Storage adapters | architect → typescript-pro → backend-developer | pending |
| 6 | Onboarding, compliance tests, cert management | backend-developer | pending |
| 7 | Documentation & examples | typescript-pro → architect-reviewer | pending |
| 8 | Release hygiene | architect-reviewer → herald | pending |

## Reference

The source plan written by the orchestrator's planning step lives at `/Users/ameensaeed/.claude/plans/we-ve-been-trying-to-twinkly-pascal.md`. That document is the authoritative narrative; the per-phase MD files here are the executable unit of work.

Source helper being ported: `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/api/zatca.invoices/` and `/Users/ameensaeed/Documents/Node/rwiqha-backend/src/server/helpers/zatca/`.
