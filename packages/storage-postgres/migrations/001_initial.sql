-- ZATCA storage — initial schema.
--
-- Two tables, both colocated in whatever schema the calling app
-- chooses (the adapter prefixes nothing; if you need a schema, run
-- `SET search_path` on the connection before applying this file).
--
-- Tables:
--   zatca_counters  — atomic per-(VAT, EGS, year-month) sequence
--   zatca_invoices  — one row per issued invoice / credit / debit note
--
-- Indexes:
--   PK on zatca_counters         — single-row UPSERT for counter atomicity.
--   UQ on (vat, egs, invoice_id) — idempotency lookup + uniqueness.
--   IDX on (vat, egs, created_at DESC) — hash-chain head query.
--   IDX on (vat, egs, kind, created_at DESC) — multi-stream chain head.

CREATE TABLE IF NOT EXISTS zatca_counters (
  vat_number TEXT NOT NULL,
  egs_uuid   TEXT NOT NULL,
  year_month TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  PRIMARY KEY (vat_number, egs_uuid, year_month)
);

CREATE TABLE IF NOT EXISTS zatca_invoices (
  id                    BIGSERIAL PRIMARY KEY,
  vat_number            TEXT NOT NULL,
  egs_uuid              TEXT NOT NULL,
  invoice_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL,
  serial                TEXT NOT NULL,
  counter_number        INTEGER NOT NULL,
  uuid                  TEXT NOT NULL,
  invoice_hash          TEXT NOT NULL,
  previous_invoice_hash TEXT NOT NULL,
  signed_xml            TEXT NOT NULL,
  qr_base64             TEXT NOT NULL,
  status                TEXT NOT NULL,
  issued_at             TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  clearance_number      TEXT,
  validation_results    JSONB,
  CONSTRAINT zatca_invoices_scope_invoice_unique
    UNIQUE (vat_number, egs_uuid, invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_zatca_invoices_chain
  ON zatca_invoices (vat_number, egs_uuid, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_zatca_invoices_chain_by_kind
  ON zatca_invoices (vat_number, egs_uuid, kind, created_at DESC);
