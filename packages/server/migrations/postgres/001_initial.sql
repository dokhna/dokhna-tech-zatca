-- ZATCA server — initial schema.
--
-- Four tables, all colocated in whatever schema the calling app chooses.
-- The package prefixes nothing; run `SET search_path` on the connection
-- before applying this file if you want to namespace.
--
-- Tables:
--   zatca_server_tenants     — identity + lifecycle + onboarding progress
--   zatca_server_credentials — encrypted ZATCA signing material (one row per tenant)
--   zatca_server_api_keys    — bearer tokens external systems present on tenant routes
--   zatca_server_audit_log   — append-only audit trail (tax-authority retention)
--
-- Atomicity:
--   The credential vault and api-keys are linked to tenants via FK so a
--   tenant cannot be deleted without explicitly clearing dependents.
--   The audit log is intentionally NOT FK-linked — audit rows must
--   outlive the tenants they describe.

CREATE TABLE IF NOT EXISTS zatca_server_tenants (
  tenant_ref                          TEXT PRIMARY KEY,
  vat_number                          TEXT NOT NULL,
  egs_uuid                            TEXT NOT NULL,
  vat_name                            TEXT NOT NULL,
  crn                                 TEXT NOT NULL,
  branch_name                         TEXT NOT NULL,
  branch_industry                     TEXT,
  location                            JSONB NOT NULL,
  environment                         TEXT NOT NULL,
  state                               TEXT NOT NULL DEFAULT 'created',
  onboarding_progress                 JSONB NOT NULL DEFAULT '{"scenarios":{}}'::jsonb,
  production_certificate_expires_at   TIMESTAMPTZ,
  callback_url                        TEXT,
  claimed_by                          TEXT,
  claim_expires_at                    TIMESTAMPTZ,
  label                               TEXT,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                          TIMESTAMPTZ,
  CONSTRAINT zatca_server_tenants_environment_check
    CHECK (environment IN ('sandbox','simulation','production')),
  CONSTRAINT zatca_server_tenants_state_check
    CHECK (state IN ('created','onboarding','production-ready','failed','revoked'))
);

-- Indexed for state-filtered listing AND for the "expiring within N
-- days" admin query. A composite (state, expiry) index serves both
-- without pg-mem's known issue around single-column timestamp
-- indexes after UPDATE-set values. Production Postgres uses the
-- index identically.
CREATE INDEX IF NOT EXISTS idx_zatca_server_tenants_state_prod_expiry
  ON zatca_server_tenants (state, production_certificate_expires_at);

CREATE TABLE IF NOT EXISTS zatca_server_credentials (
  tenant_ref                          TEXT PRIMARY KEY
    REFERENCES zatca_server_tenants(tenant_ref) ON DELETE CASCADE,
  private_key                         JSONB NOT NULL,
  production_certificate              JSONB NOT NULL,
  production_binary_security_token    JSONB NOT NULL,
  production_api_secret               JSONB NOT NULL,
  compliance_certificate              JSONB,
  compliance_binary_security_token    JSONB,
  compliance_api_secret               JSONB,
  created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS zatca_server_api_keys (
  token_id        TEXT PRIMARY KEY,
  tenant_ref      TEXT NOT NULL
    REFERENCES zatca_server_tenants(tenant_ref) ON DELETE CASCADE,
  token_hash_b64  TEXT NOT NULL,
  salt_b64        TEXT NOT NULL,
  env             TEXT NOT NULL,
  last4           TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  CONSTRAINT zatca_server_api_keys_env_check
    CHECK (env IN ('live','test'))
);

-- Active-key lookup by tenant: `resolve` reads here to scrypt-check.
-- See the comment above re: partial-index handling — kept plain for
-- pg-mem compatibility.
CREATE INDEX IF NOT EXISTS idx_zatca_server_api_keys_tenant
  ON zatca_server_api_keys (tenant_ref);

CREATE TABLE IF NOT EXISTS zatca_server_audit_log (
  id                  UUID PRIMARY KEY,
  at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_type          TEXT NOT NULL,
  actor               JSONB NOT NULL,
  tenant_ref          TEXT,
  action              TEXT NOT NULL,
  target_id           TEXT,
  result              TEXT NOT NULL,
  zatca_request_id    TEXT,
  request_id          TEXT,
  payload             JSONB,
  CONSTRAINT zatca_server_audit_log_actor_type_check
    CHECK (actor_type IN ('admin','tenant','system')),
  CONSTRAINT zatca_server_audit_log_result_check
    CHECK (result IN ('ok','error'))
);

-- Newest-first per-tenant audit listing.
CREATE INDEX IF NOT EXISTS idx_zatca_server_audit_log_tenant_at
  ON zatca_server_audit_log (tenant_ref, at DESC);

-- Newest-first by action (action-level dashboards, compliance reports).
CREATE INDEX IF NOT EXISTS idx_zatca_server_audit_log_action_at
  ON zatca_server_audit_log (action, at DESC);

-- Global newest-first.
CREATE INDEX IF NOT EXISTS idx_zatca_server_audit_log_at
  ON zatca_server_audit_log (at DESC);
