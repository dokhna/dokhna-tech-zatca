---
"@dokhna-tech/zatca-server": patch
---

Ship the package as a Docker image + a docker-compose-driven walkthrough.

- `packages/server/Dockerfile` — multi-stage build on `node:20-slim` (NOT distroless — OpenSSL CLI is required by the onboarding CSR + keygen probe), tini as PID 1, non-root user, baked-in health check against `/healthz`.
- `examples/standalone-server/` — two docker-compose profiles (`docker-compose.mongo.yml` boots a 1-node Mongo replica set + the server; `docker-compose.postgres.yml` boots Postgres + a migrations runner + the server), `.env.example` with key-generation hints, a curl-driven `README.md` walkthrough, and an `onboard-and-issue.http` request collection for the VS Code REST Client.
- Root README + `examples/multi-vat-saas/README` updated to point new operators at the standalone-server example as the recommended turnkey path; the SDK-embedded approach remains documented for shops that want full control over their own server process.

No public-API change — the package's behaviour and types are unchanged. The `patch` declaration is honest to that, but per the project's fixed-group changeset semantics the family ships together at whatever tier the highest-bumped PR in the release cycle resolves to.
