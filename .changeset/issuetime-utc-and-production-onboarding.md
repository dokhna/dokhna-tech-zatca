---
"@dokhna-tech/zatca": patch
"@dokhna-tech/zatca-server": patch
---

Fix ZATCA IssueTime timezone warning and enable production onboarding.

- **IssueTime UTC `Z`**: invoice `issueTime` is now normalized to `HH:mm:ssZ` in the builder constructors, so the XML `<cbc:IssueTime>`, the QR timestamp (tag 3), and the XAdES `SigningTime` all carry the UTC designator and agree. This clears the UBL 2.1 timezone warning and fixes a host-timezone drift in `SigningTime` on non-UTC servers. The public input contract is unchanged — callers may still pass a bare `HH:mm:ss` (the `Z` is appended) or `HH:mm:ssZ`.
- **Production onboarding**: `onboard()` now accepts `environment: "production"` (previously it threw). It issues the CSR against the `ZATCA-Code-Signing` profile and runs the compliance scenarios on the live `core` gateway as part of production CSID issuance — verified end-to-end against ZATCA production. The server onboarding route and types accept `production` accordingly, and the onboarding docs document the real go-live steps.
