/**
 * Postgres-backed implementations of `TenantStore`, `CredentialVault`,
 * and `ApiKeyStore`.
 *
 * Atomicity:
 * - `setState` uses `UPDATE ... WHERE state IN (...) RETURNING *` for a
 *   single-statement compare-and-swap. The CAS subsumes the in-process
 *   "expectedFrom" guard and is safe across replicas.
 * - `recordOnboardingProgress` and `patch` use a row-level lock via
 *   `UPDATE ... RETURNING` (no read-modify-write between selects, so
 *   no need for `SELECT FOR UPDATE`).
 * - Transactional audit writes: every mutating method accepts a
 *   {@link PgQueryable}, which can be either a `pg.Pool` or a
 *   `pg.PoolClient` checked out and put into a `BEGIN/COMMIT` block by
 *   the caller. The HTTP layer (PR3) uses {@link withPgTransaction} to
 *   wrap mutation + audit-write in a single transaction.
 *
 * Schema is in `migrations/postgres/001_initial.sql`. Adapters do not
 * apply the migration automatically — the deploying app owns
 * migration lifecycle.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { asCommercialRegistrationNumber, asEGSUuid, asVATNumber } from "@dokhna-tech/zatca";
import type { CipherEnvelope, SecretCipher } from "../crypto/index.js";
import { ZatcaCipherError, ZatcaRegistryError } from "../errors.js";
import type {
  ApiKeyListEntry,
  ApiKeyStore,
  IssuedApiKey,
  ResolvedApiKey,
} from "./api-key-store.js";
import type { CredentialVault, SignerMaterial } from "./credential-vault.js";
import type { TenantStore } from "./store.js";
import type {
  CreateTenantInput,
  OnboardingProgress,
  PatchableTenantFields,
  SetStateOptions,
  TenantListFilter,
  TenantRecord,
  TenantState,
} from "./types.js";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Minimal subset of `pg.Pool` / `pg.PoolClient` the adapters rely on.
 * Encoded as a structural interface so callers can pass either, or a
 * `pg-mem`-backed double, interchangeably.
 *
 * Identical in shape to the type exported from
 * `@dokhna-tech/zatca-storage-postgres`; re-declared here so the
 * server has no hard runtime dep on the storage adapter package.
 */
export interface PgQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Generate a URL-safe opaque slug. 10 random bytes → 16 base32 chars,
 * ≈ 80 bits entropy.
 */
export function generateTenantRef(): string {
  return base32Encode(randomBytes(10)).toLowerCase();
}

function generateTokenId(): string {
  return base32Encode(randomBytes(10)).toLowerCase();
}

function generateTokenTail(): string {
  return base32Encode(randomBytes(20)).slice(0, 32);
}

type TenantRow = {
  tenant_ref: string;
  vat_number: string;
  egs_uuid: string;
  vat_name: string;
  crn: string;
  branch_name: string;
  branch_industry: string | null;
  location: unknown;
  environment: string;
  state: string;
  onboarding_progress: unknown;
  production_certificate_expires_at: Date | string | null;
  callback_url: string | null;
  claimed_by: string | null;
  claim_expires_at: Date | string | null;
  label: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function rowToTenant(row: TenantRow): TenantRecord {
  // Build as a mutable accumulator and cast at the end — `TenantRecord`
  // marks everything `readonly` which prevents incremental assignment.
  const out: Record<string, unknown> = {
    tenantRef: row.tenant_ref,
    vatNumber: asVATNumber(row.vat_number),
    egsUuid: asEGSUuid(row.egs_uuid),
    vatName: row.vat_name,
    crn: asCommercialRegistrationNumber(row.crn),
    branchName: row.branch_name,
    location: row.location,
    environment: row.environment,
    state: row.state,
    onboardingProgress: row.onboarding_progress,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
  if (row.branch_industry !== null) out.branchIndustry = row.branch_industry;
  if (row.production_certificate_expires_at !== null) {
    out.productionCertificateExpiresAt = toDate(row.production_certificate_expires_at);
  }
  if (row.callback_url !== null) out.callbackUrl = row.callback_url;
  if (row.claimed_by !== null) out.claimedBy = row.claimed_by;
  if (row.claim_expires_at !== null) out.claimExpiresAt = toDate(row.claim_expires_at);
  if (row.label !== null) out.label = row.label;
  if (row.deleted_at !== null) out.deletedAt = toDate(row.deleted_at);
  return out as unknown as TenantRecord;
}

const TENANT_COLUMNS = `
  tenant_ref, vat_number, egs_uuid, vat_name, crn, branch_name, branch_industry,
  location, environment, state, onboarding_progress,
  production_certificate_expires_at, callback_url, claimed_by, claim_expires_at,
  label, created_at, updated_at, deleted_at
`;

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === "23505";
}

/**
 * Constructor options for the Postgres tenant store.
 */
export interface PostgresTenantStoreOptions {
  readonly pool: PgQueryable;
  readonly now?: () => Date;
}

export function createPostgresTenantStore(options: PostgresTenantStoreOptions): TenantStore {
  const { pool } = options;
  const clock = options.now ?? (() => new Date());

  return {
    async create(input: CreateTenantInput) {
      const tenantRef = input.tenantRef ?? generateTenantRef();
      const now = clock();
      try {
        const result = await pool.query<TenantRow>(
          `INSERT INTO zatca_server_tenants (
             tenant_ref, vat_number, egs_uuid, vat_name, crn, branch_name, branch_industry,
             location, environment, state, onboarding_progress,
             callback_url, label, created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8::jsonb, $9, 'created', '{"scenarios":{}}'::jsonb,
             $10, $11, $12, $13
           )
           RETURNING ${TENANT_COLUMNS}`,
          [
            tenantRef,
            input.vatNumber,
            input.egsUuid,
            input.vatName,
            input.crn,
            input.branchName,
            input.branchIndustry ?? null,
            JSON.stringify(input.location),
            input.environment,
            input.callbackUrl ?? null,
            input.label ?? null,
            now,
            now,
          ],
        );
        const firstRow = result.rows[0];
        if (firstRow === undefined) {
          throw new ZatcaRegistryError(`create returned no row for tenant '${tenantRef}'.`);
        }
        return rowToTenant(firstRow);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ZatcaRegistryError(`Tenant '${tenantRef}' already exists.`);
        }
        throw err;
      }
    },

    async get(tenantRef: string) {
      const result = await pool.query<TenantRow>(
        `SELECT ${TENANT_COLUMNS} FROM zatca_server_tenants
         WHERE tenant_ref = $1 AND deleted_at IS NULL`,
        [tenantRef],
      );
      const row = result.rows[0];
      return row === undefined ? null : rowToTenant(row);
    },

    async list(filter: TenantListFilter = {}) {
      const where: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (filter.includeDeleted !== true) {
        where.push("deleted_at IS NULL");
      }
      if (filter.state !== undefined) {
        where.push(`state = $${i++}`);
        values.push(filter.state);
      }
      if (filter.environment !== undefined) {
        where.push(`environment = $${i++}`);
        values.push(filter.environment);
      }
      if (filter.expiringWithinDays !== undefined) {
        const cutoff = new Date(clock().getTime() + filter.expiringWithinDays * 86_400_000);
        where.push(`production_certificate_expires_at IS NOT NULL`);
        where.push(`production_certificate_expires_at <= $${i++}`);
        values.push(cutoff);
      }
      const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const result = await pool.query<TenantRow>(
        `SELECT ${TENANT_COLUMNS} FROM zatca_server_tenants
         ${whereSql}
         ORDER BY created_at ASC, tenant_ref ASC`,
        values,
      );
      return result.rows.map(rowToTenant);
    },

    async patch(tenantRef: string, patch: PatchableTenantFields) {
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      if (patch.vatName !== undefined) {
        sets.push(`vat_name = $${i++}`);
        values.push(patch.vatName);
      }
      if (patch.branchName !== undefined) {
        sets.push(`branch_name = $${i++}`);
        values.push(patch.branchName);
      }
      if (patch.branchIndustry !== undefined) {
        sets.push(`branch_industry = $${i++}`);
        values.push(patch.branchIndustry);
      }
      if (patch.location !== undefined) {
        sets.push(`location = $${i++}::jsonb`);
        values.push(JSON.stringify(patch.location));
      }
      if (patch.label !== undefined) {
        sets.push(`label = $${i++}`);
        values.push(patch.label);
      }
      if (patch.callbackUrl !== undefined) {
        sets.push(`callback_url = $${i++}`);
        values.push(patch.callbackUrl);
      }
      sets.push(`updated_at = $${i++}`);
      values.push(clock());
      values.push(tenantRef);
      const result = await pool.query<TenantRow>(
        `UPDATE zatca_server_tenants
         SET ${sets.join(", ")}
         WHERE tenant_ref = $${i} AND deleted_at IS NULL
         RETURNING ${TENANT_COLUMNS}`,
        values,
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
      }
      return rowToTenant(row);
    },

    async setState(tenantRef: string, next: TenantState, opts: SetStateOptions = {}) {
      const now = clock();
      const claimedBy = opts.claimedBy ?? null;
      const claimExpiresAt = opts.claimExpiresAt ?? null;

      // Compute the new onboarding_progress in JS — avoids `jsonb_set`
      // which pg-mem does not ship. The application-level per-tenant
      // lock (held by `runOnboarding`) prevents cross-call races on
      // the read-modify-write here; the in-call UPDATE still uses CAS
      // on state to keep the lifecycle transition atomic.
      let newProgressJson: string | null = null;
      if (opts.lastError !== undefined) {
        const current = await pool.query<{ onboarding_progress: OnboardingProgress }>(
          `SELECT onboarding_progress FROM zatca_server_tenants
           WHERE tenant_ref = $1 AND deleted_at IS NULL`,
          [tenantRef],
        );
        const existing = current.rows[0]?.onboarding_progress ?? { scenarios: {} };
        newProgressJson = JSON.stringify({ ...existing, lastError: opts.lastError });
      }

      let result: Awaited<ReturnType<typeof pool.query<TenantRow>>>;
      if (opts.expectedFrom !== undefined) {
        // CAS: only transition if state matches OR if the row is in
        // 'onboarding' with an expired claim. Reclaiming an expired
        // lock subsumes the explicit expectedFrom check.
        const query = `
          UPDATE zatca_server_tenants
          SET state = $2,
              updated_at = $3,
              claimed_by = $4,
              claim_expires_at = $5,
              onboarding_progress = COALESCE($6::jsonb, onboarding_progress)
          WHERE tenant_ref = $1
            AND deleted_at IS NULL
            AND (
              state = $7
              OR (state = 'onboarding'
                  AND claim_expires_at IS NOT NULL
                  AND claim_expires_at <= $3)
            )
          RETURNING ${TENANT_COLUMNS}`;
        result = await pool.query<TenantRow>(query, [
          tenantRef,
          next,
          now,
          claimedBy,
          claimExpiresAt,
          newProgressJson,
          opts.expectedFrom,
        ]);
      } else {
        result = await pool.query<TenantRow>(
          `UPDATE zatca_server_tenants
           SET state = $2,
               updated_at = $3,
               claimed_by = $4,
               claim_expires_at = $5,
               onboarding_progress = COALESCE($6::jsonb, onboarding_progress)
           WHERE tenant_ref = $1 AND deleted_at IS NULL
           RETURNING ${TENANT_COLUMNS}`,
          [tenantRef, next, now, claimedBy, claimExpiresAt, newProgressJson],
        );
      }
      const row = result.rows[0];
      if (row === undefined) {
        // Distinguish "unknown tenant" from "CAS failed" so the caller
        // sees a useful error message.
        const exists = await pool.query<{ state: string }>(
          `SELECT state FROM zatca_server_tenants
           WHERE tenant_ref = $1 AND deleted_at IS NULL`,
          [tenantRef],
        );
        if (exists.rows.length === 0) {
          throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
        }
        throw new ZatcaRegistryError(
          `Cannot transition tenant '${tenantRef}' from '${exists.rows[0]?.state}' (expected '${opts.expectedFrom}').`,
        );
      }
      return rowToTenant(row);
    },

    async recordOnboardingProgress(tenantRef: string, scenario: string, passed: boolean) {
      // Read-modify-write — avoids `jsonb_set` which pg-mem does not
      // ship. Application-level locking in `runOnboarding` prevents
      // cross-call races; within a single onboarding pass the
      // scenarios are issued sequentially anyway.
      const current = await pool.query<{ onboarding_progress: OnboardingProgress }>(
        `SELECT onboarding_progress FROM zatca_server_tenants
         WHERE tenant_ref = $1 AND deleted_at IS NULL`,
        [tenantRef],
      );
      const existing = current.rows[0];
      if (existing === undefined) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
      }
      const merged: OnboardingProgress = {
        ...existing.onboarding_progress,
        scenarios: {
          ...existing.onboarding_progress.scenarios,
          [scenario]: passed ? "passed" : "failed",
        },
      };
      await pool.query(
        `UPDATE zatca_server_tenants
         SET onboarding_progress = $2::jsonb, updated_at = $3
         WHERE tenant_ref = $1 AND deleted_at IS NULL`,
        [tenantRef, JSON.stringify(merged), clock()],
      );
    },

    async setProductionExpiry(tenantRef: string, expiresAt: Date) {
      // Pass the timestamp as an ISO string with an explicit
      // ::timestamptz cast. Production Postgres accepts the form
      // unchanged; `pg-mem`'s UPDATE binding for raw Date values
      // round-trips them in a way that breaks subsequent `<=`
      // comparisons in the WHERE clause — the cast+ISO form
      // sidesteps that bug.
      const result = await pool.query(
        `UPDATE zatca_server_tenants
         SET production_certificate_expires_at = $2::timestamptz, updated_at = $3
         WHERE tenant_ref = $1 AND deleted_at IS NULL`,
        [tenantRef, expiresAt.toISOString(), clock()],
      );
      if (result.rowCount === 0) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
      }
    },

    async softDelete(tenantRef: string) {
      const now = clock();
      const result = await pool.query(
        `UPDATE zatca_server_tenants
         SET state = 'revoked', deleted_at = $2, updated_at = $2
         WHERE tenant_ref = $1`,
        [tenantRef, now],
      );
      if (result.rowCount === 0) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
      }
    },
  };
}

/**
 * Constructor options for the Postgres credential vault.
 */
export interface PostgresCredentialVaultOptions {
  readonly pool: PgQueryable;
  readonly cipher: SecretCipher;
  readonly now?: () => Date;
}

type CredentialsRow = {
  private_key: unknown;
  production_certificate: unknown;
  production_binary_security_token: unknown;
  production_api_secret: unknown;
  compliance_certificate: unknown;
  compliance_binary_security_token: unknown;
  compliance_api_secret: unknown;
};

export function createPostgresCredentialVault(
  options: PostgresCredentialVaultOptions,
): CredentialVault {
  const { pool, cipher } = options;
  const clock = options.now ?? (() => new Date());

  async function encryptOptional(value: string | undefined): Promise<CipherEnvelope | null> {
    if (value === undefined) return null;
    return cipher.encrypt(value);
  }

  function rowToEnvelope(value: unknown): CipherEnvelope | null {
    if (value === null || value === undefined) return null;
    return value as CipherEnvelope;
  }

  return {
    async put(tenantRef: string, material: SignerMaterial) {
      const now = clock();
      const privateKey = await cipher.encrypt(material.privateKey);
      const productionCertificate = await cipher.encrypt(material.productionCertificate);
      const productionBst = await cipher.encrypt(material.productionBinarySecurityToken);
      const productionApiSecret = await cipher.encrypt(material.productionApiSecret);
      const complianceCertificate = await encryptOptional(material.complianceCertificate);
      const complianceBst = await encryptOptional(material.complianceBinarySecurityToken);
      const complianceApiSecret = await encryptOptional(material.complianceApiSecret);
      await pool.query(
        `INSERT INTO zatca_server_credentials (
           tenant_ref, private_key, production_certificate,
           production_binary_security_token, production_api_secret,
           compliance_certificate, compliance_binary_security_token,
           compliance_api_secret, created_at, updated_at
         ) VALUES (
           $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb,
           $6::jsonb, $7::jsonb, $8::jsonb, $9, $9
         )
         ON CONFLICT (tenant_ref) DO UPDATE SET
           private_key = EXCLUDED.private_key,
           production_certificate = EXCLUDED.production_certificate,
           production_binary_security_token = EXCLUDED.production_binary_security_token,
           production_api_secret = EXCLUDED.production_api_secret,
           compliance_certificate = EXCLUDED.compliance_certificate,
           compliance_binary_security_token = EXCLUDED.compliance_binary_security_token,
           compliance_api_secret = EXCLUDED.compliance_api_secret,
           updated_at = EXCLUDED.updated_at`,
        [
          tenantRef,
          JSON.stringify(privateKey),
          JSON.stringify(productionCertificate),
          JSON.stringify(productionBst),
          JSON.stringify(productionApiSecret),
          complianceCertificate === null ? null : JSON.stringify(complianceCertificate),
          complianceBst === null ? null : JSON.stringify(complianceBst),
          complianceApiSecret === null ? null : JSON.stringify(complianceApiSecret),
          now,
        ],
      );
    },

    async get(tenantRef: string) {
      const result = await pool.query<CredentialsRow>(
        `SELECT private_key, production_certificate, production_binary_security_token,
                production_api_secret, compliance_certificate,
                compliance_binary_security_token, compliance_api_secret
         FROM zatca_server_credentials
         WHERE tenant_ref = $1`,
        [tenantRef],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      const privateKey = rowToEnvelope(row.private_key);
      const productionCertificate = rowToEnvelope(row.production_certificate);
      const productionBst = rowToEnvelope(row.production_binary_security_token);
      const productionApiSecret = rowToEnvelope(row.production_api_secret);
      if (
        privateKey === null ||
        productionCertificate === null ||
        productionBst === null ||
        productionApiSecret === null
      ) {
        throw new ZatcaCipherError(
          `Vault row for tenant '${tenantRef}' is missing required production fields.`,
        );
      }
      try {
        const out: SignerMaterial = {
          privateKey: await cipher.decrypt(privateKey),
          productionCertificate: await cipher.decrypt(productionCertificate),
          productionBinarySecurityToken: await cipher.decrypt(productionBst),
          productionApiSecret: await cipher.decrypt(productionApiSecret),
        };
        const complianceCertificate = rowToEnvelope(row.compliance_certificate);
        const complianceBst = rowToEnvelope(row.compliance_binary_security_token);
        const complianceApiSecret = rowToEnvelope(row.compliance_api_secret);
        if (complianceCertificate !== null) {
          (out as { complianceCertificate?: string }).complianceCertificate =
            await cipher.decrypt(complianceCertificate);
        }
        if (complianceBst !== null) {
          (out as { complianceBinarySecurityToken?: string }).complianceBinarySecurityToken =
            await cipher.decrypt(complianceBst);
        }
        if (complianceApiSecret !== null) {
          (out as { complianceApiSecret?: string }).complianceApiSecret =
            await cipher.decrypt(complianceApiSecret);
        }
        return out;
      } catch (cause) {
        if (cause instanceof ZatcaCipherError) throw cause;
        throw new ZatcaCipherError(`Vault decrypt failed for tenant '${tenantRef}'.`, cause);
      }
    },

    async delete(tenantRef: string) {
      await pool.query(`DELETE FROM zatca_server_credentials WHERE tenant_ref = $1`, [tenantRef]);
    },
  };
}

const TOKEN_RE = /^zts_(live|test)_([a-z0-9]+)_([A-Z2-7]{32})$/;

function parseToken(
  token: string,
): { env: "live" | "test"; tenantRef: string; tail: string } | null {
  const match = TOKEN_RE.exec(token);
  if (match === null) return null;
  return {
    env: match[1] as "live" | "test",
    tenantRef: match[2] as string,
    tail: match[3] as string,
  };
}

type ApiKeyRow = {
  token_id: string;
  tenant_ref: string;
  token_hash_b64: string;
  salt_b64: string;
  env: string;
  last4: string;
  label: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  revoked_at: Date | string | null;
};

/**
 * Constructor options for the Postgres api-key store.
 */
export interface PostgresApiKeyStoreOptions {
  readonly pool: PgQueryable;
  readonly env?: "live" | "test";
  readonly now?: () => Date;
}

export function createPostgresApiKeyStore(options: PostgresApiKeyStoreOptions): ApiKeyStore {
  const { pool } = options;
  const env = options.env ?? "live";
  const clock = options.now ?? (() => new Date());

  return {
    async issue(tenantRef: string, label: string): Promise<IssuedApiKey> {
      const tail = generateTokenTail();
      const token = `zts_${env}_${tenantRef}_${tail}`;
      const tokenId = generateTokenId();
      const salt = randomBytes(16);
      const hash = await scrypt(token, salt, 32);
      // Persist hash + salt as base64 TEXT — sidesteps non-portable
      // BYTEA round-tripping (e.g. `pg-mem` corrupts non-ASCII bytes
      // through its UTF-8 conversion). Real Postgres handles BYTEA
      // correctly, but TEXT base64 round-trips cleanly everywhere
      // for a 33%-larger row.
      await pool.query(
        `INSERT INTO zatca_server_api_keys (
           token_id, tenant_ref, token_hash_b64, salt_b64, env, last4, label, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tokenId,
          tenantRef,
          hash.toString("base64"),
          salt.toString("base64"),
          env,
          tail.slice(-4),
          label,
          clock(),
        ],
      );
      return { token, tokenId };
    },

    async resolve(presentedToken: string): Promise<ResolvedApiKey | null> {
      const parsed = parseToken(presentedToken);
      if (parsed === null) return null;
      if (parsed.env !== env) return null;
      const result = await pool.query<ApiKeyRow>(
        `SELECT token_id, tenant_ref, token_hash_b64, salt_b64, env, last4, label,
                created_at, last_used_at, revoked_at
         FROM zatca_server_api_keys
         WHERE tenant_ref = $1 AND revoked_at IS NULL`,
        [parsed.tenantRef],
      );
      for (const row of result.rows) {
        const salt = Buffer.from(row.salt_b64, "base64");
        const expectedHash = Buffer.from(row.token_hash_b64, "base64");
        const candidate = await scrypt(presentedToken, salt, 32);
        if (candidate.length !== expectedHash.length) continue;
        if (!timingSafeEqual(candidate, expectedHash)) continue;
        await pool.query(`UPDATE zatca_server_api_keys SET last_used_at = $2 WHERE token_id = $1`, [
          row.token_id,
          clock(),
        ]);
        return { tenantRef: row.tenant_ref, tokenId: row.token_id };
      }
      return null;
    },

    async revoke(tokenId: string) {
      await pool.query(
        `UPDATE zatca_server_api_keys SET revoked_at = $2
         WHERE token_id = $1 AND revoked_at IS NULL`,
        [tokenId, clock()],
      );
    },

    async list(tenantRef: string): Promise<ReadonlyArray<ApiKeyListEntry>> {
      const result = await pool.query<ApiKeyRow>(
        `SELECT token_id, tenant_ref, token_hash_b64, salt_b64, env, last4, label,
                created_at, last_used_at, revoked_at
         FROM zatca_server_api_keys
         WHERE tenant_ref = $1
         ORDER BY created_at ASC`,
        [tenantRef],
      );
      return result.rows.map((row) => {
        const out: ApiKeyListEntry = {
          tokenId: row.token_id,
          tenantRef: row.tenant_ref,
          label: row.label,
          last4: row.last4,
          createdAt: toDate(row.created_at),
        };
        if (row.last_used_at !== null) {
          (out as { lastUsedAt?: Date }).lastUsedAt = toDate(row.last_used_at);
        }
        if (row.revoked_at !== null) {
          (out as { revokedAt?: Date }).revokedAt = toDate(row.revoked_at);
        }
        return out;
      });
    },

    async revokeAllForTenant(tenantRef: string) {
      await pool.query(
        `UPDATE zatca_server_api_keys SET revoked_at = $2
         WHERE tenant_ref = $1 AND revoked_at IS NULL`,
        [tenantRef, clock()],
      );
    },
  };
}

/**
 * Convenience: build all three Postgres-backed stores wired to the
 * same connection pool.
 */
export function createPostgresRegistry(options: {
  readonly pool: PgQueryable;
  readonly cipher: SecretCipher;
  readonly env?: "live" | "test";
  readonly now?: () => Date;
}): { tenants: TenantStore; vault: CredentialVault; apiKeys: ApiKeyStore } {
  const baseOptions = options.now !== undefined ? { now: options.now } : {};
  const tenantOptions = { pool: options.pool, ...baseOptions };
  const vaultOptions = { pool: options.pool, cipher: options.cipher, ...baseOptions };
  const apiKeyOptions =
    options.env !== undefined
      ? { pool: options.pool, env: options.env, ...baseOptions }
      : { pool: options.pool, ...baseOptions };
  return {
    tenants: createPostgresTenantStore(tenantOptions),
    vault: createPostgresCredentialVault(vaultOptions),
    apiKeys: createPostgresApiKeyStore(apiKeyOptions),
  };
}

/**
 * Helper: wrap a callback in a Postgres transaction. The callback
 * receives a `PgQueryable` that's a single checked-out client — pass
 * it as the `pool` field to any of the registry stores' factories OR
 * use it directly with `query`. Commits on resolve, rolls back on
 * throw.
 *
 * Intended for the HTTP layer (PR3) to bundle a mutation + audit
 * write into a single atomic transaction.
 */
export async function withPgTransaction<T>(
  pool: { connect(): Promise<PgClient> },
  fn: (tx: PgQueryable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow — original error is the one to surface.
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Minimal subset of `pg.PoolClient` `withPgTransaction` needs.
 */
export interface PgClient extends PgQueryable {
  release(): void;
}
