/**
 * In-process reference implementation of the three tenant interfaces.
 *
 * Intended for:
 * - Local development without a real database.
 * - Unit tests for the HTTP layer (PR3) and the onboarding wrapper.
 *
 * NOT for production — state lives in process memory and is lost on
 * restart. Multi-replica deployments use the Mongo / Postgres
 * registries shipped in PR2.
 *
 * The three factory functions can be wired independently (useful when
 * a test wants to swap one implementation for another). The
 * {@link createMemoryRegistry} convenience returns all three already
 * bound to the same backing maps.
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { SecretCipher } from "../crypto/index.js";
import { ZatcaCipherError, ZatcaRegistryError } from "../errors.js";

import type {
  ApiKeyListEntry,
  ApiKeyStore,
  IssuedApiKey,
  ResolvedApiKey,
} from "./api-key-store.js";
import type {
  CredentialVault,
  EncryptedSignerMaterial,
  SignerMaterial,
} from "./credential-vault.js";
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
 * ≈ 80 bits of entropy — collision-safe for any realistic tenant count.
 */
export function generateTenantRef(): string {
  return base32Encode(randomBytes(10)).toLowerCase();
}

function clone<T>(value: T): T {
  // Records are immutable on the API surface but mutated internally
  // during state transitions. Cloning on read prevents callers from
  // mutating the store's internal state.
  return structuredClone(value);
}

function deepFreezeProgress(progress: OnboardingProgress): OnboardingProgress {
  return {
    scenarios: { ...progress.scenarios },
    ...(progress.lastError !== undefined ? { lastError: progress.lastError } : {}),
  };
}

function applyOptionalDate(
  record: Record<string, unknown>,
  key: string,
  value: Date | undefined,
): void {
  if (value === undefined) {
    delete record[key];
  } else {
    record[key] = value;
  }
}

function emptyProgress(): OnboardingProgress {
  return { scenarios: {} };
}

/**
 * Build the in-memory tenant store. Each call returns an independent
 * instance — perfect per-test isolation.
 */
export function createMemoryTenantStore(options: { now?: () => Date } = {}): TenantStore {
  const clock = options.now ?? (() => new Date());
  const records = new Map<string, TenantRecord>();

  function requireRecord(tenantRef: string): TenantRecord {
    const existing = records.get(tenantRef);
    if (existing === undefined || existing.deletedAt !== undefined) {
      throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
    }
    return existing;
  }

  return {
    async create(input: CreateTenantInput) {
      const tenantRef = input.tenantRef ?? generateTenantRef();
      if (records.has(tenantRef)) {
        throw new ZatcaRegistryError(`Tenant '${tenantRef}' already exists.`);
      }
      const now = clock();
      const record: TenantRecord = {
        tenantRef,
        vatNumber: input.vatNumber,
        egsUuid: input.egsUuid,
        vatName: input.vatName,
        crn: input.crn,
        branchName: input.branchName,
        ...(input.branchIndustry !== undefined ? { branchIndustry: input.branchIndustry } : {}),
        location: input.location,
        environment: input.environment,
        state: "created",
        onboardingProgress: emptyProgress(),
        ...(input.callbackUrl !== undefined ? { callbackUrl: input.callbackUrl } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        createdAt: now,
        updatedAt: now,
      };
      records.set(tenantRef, record);
      return clone(record);
    },

    async get(tenantRef: string) {
      const existing = records.get(tenantRef);
      if (existing === undefined || existing.deletedAt !== undefined) {
        return null;
      }
      return clone(existing);
    },

    async list(filter: TenantListFilter = {}) {
      const out: TenantRecord[] = [];
      const expiringBefore =
        filter.expiringWithinDays !== undefined
          ? new Date(clock().getTime() + filter.expiringWithinDays * 86_400_000)
          : null;
      for (const record of records.values()) {
        if (record.deletedAt !== undefined && filter.includeDeleted !== true) continue;
        if (filter.state !== undefined && record.state !== filter.state) continue;
        if (filter.environment !== undefined && record.environment !== filter.environment) continue;
        if (expiringBefore !== null) {
          if (record.productionCertificateExpiresAt === undefined) continue;
          if (record.productionCertificateExpiresAt > expiringBefore) continue;
        }
        out.push(clone(record));
      }
      // Stable sort by createdAt then tenantRef for deterministic listings.
      out.sort((a, b) => {
        const dt = a.createdAt.getTime() - b.createdAt.getTime();
        return dt !== 0 ? dt : a.tenantRef.localeCompare(b.tenantRef);
      });
      return out;
    },

    async patch(tenantRef: string, patch: PatchableTenantFields) {
      const existing = requireRecord(tenantRef);
      const updated: TenantRecord = {
        ...existing,
        ...(patch.vatName !== undefined ? { vatName: patch.vatName } : {}),
        ...(patch.branchName !== undefined ? { branchName: patch.branchName } : {}),
        ...(patch.branchIndustry !== undefined ? { branchIndustry: patch.branchIndustry } : {}),
        ...(patch.location !== undefined ? { location: patch.location } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.callbackUrl !== undefined ? { callbackUrl: patch.callbackUrl } : {}),
        updatedAt: clock(),
      };
      records.set(tenantRef, updated);
      return clone(updated);
    },

    async setState(tenantRef: string, next: TenantState, options: SetStateOptions = {}) {
      const existing = requireRecord(tenantRef);
      if (options.expectedFrom !== undefined) {
        // Honor an expired claim as if the slot were free.
        const claimExpired =
          existing.claimExpiresAt !== undefined && existing.claimExpiresAt <= clock();
        if (existing.state !== options.expectedFrom && !claimExpired) {
          throw new ZatcaRegistryError(
            `Cannot transition tenant '${tenantRef}' from '${existing.state}' (expected '${options.expectedFrom}').`,
          );
        }
      }
      const mutableRecord: Record<string, unknown> = { ...existing };
      mutableRecord.state = next;
      mutableRecord.updatedAt = clock();
      applyOptionalDate(mutableRecord, "claimExpiresAt", options.claimExpiresAt);
      if (options.claimedBy === undefined) {
        delete mutableRecord.claimedBy;
      } else {
        mutableRecord.claimedBy = options.claimedBy;
      }
      if (options.lastError !== undefined) {
        mutableRecord.onboardingProgress = deepFreezeProgress({
          ...existing.onboardingProgress,
          lastError: options.lastError,
        });
      }
      const updated = mutableRecord as unknown as TenantRecord;
      records.set(tenantRef, updated);
      return clone(updated);
    },

    async recordOnboardingProgress(tenantRef: string, scenario: string, passed: boolean) {
      const existing = requireRecord(tenantRef);
      const nextScenarios = {
        ...existing.onboardingProgress.scenarios,
        [scenario]: passed ? "passed" : "failed",
      } as Record<string, "pending" | "passed" | "failed">;
      const updated: TenantRecord = {
        ...existing,
        onboardingProgress: {
          ...existing.onboardingProgress,
          scenarios: nextScenarios,
        },
        updatedAt: clock(),
      };
      records.set(tenantRef, updated);
    },

    async setProductionExpiry(tenantRef: string, expiresAt: Date) {
      const existing = requireRecord(tenantRef);
      const updated: TenantRecord = {
        ...existing,
        productionCertificateExpiresAt: expiresAt,
        updatedAt: clock(),
      };
      records.set(tenantRef, updated);
    },

    async softDelete(tenantRef: string) {
      const existing = records.get(tenantRef);
      if (existing === undefined) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`);
      }
      const updated: TenantRecord = {
        ...existing,
        state: "revoked",
        deletedAt: clock(),
        updatedAt: clock(),
      };
      records.set(tenantRef, updated);
    },
  };
}

/**
 * Build the in-memory credential vault. The supplied cipher is used
 * for encrypt + decrypt; vault rows are stored as ciphertext to match
 * the contract advertised to DB-backed impls in PR2.
 */
export function createMemoryCredentialVault(options: { cipher: SecretCipher }): CredentialVault {
  const cipher = options.cipher;
  const rows = new Map<string, EncryptedSignerMaterial>();

  async function encryptOptional(value: string | undefined) {
    if (value === undefined) return undefined;
    return cipher.encrypt(value);
  }

  async function decryptOptional(envelope: EncryptedSignerMaterial["complianceCertificate"]) {
    if (envelope === undefined) return undefined;
    return cipher.decrypt(envelope);
  }

  return {
    async put(tenantRef: string, material: SignerMaterial) {
      const encrypted: EncryptedSignerMaterial = {
        privateKey: await cipher.encrypt(material.privateKey),
        productionCertificate: await cipher.encrypt(material.productionCertificate),
        productionBinarySecurityToken: await cipher.encrypt(material.productionBinarySecurityToken),
        productionApiSecret: await cipher.encrypt(material.productionApiSecret),
        ...(material.complianceCertificate !== undefined
          ? { complianceCertificate: await encryptOptional(material.complianceCertificate) }
          : {}),
        ...(material.complianceBinarySecurityToken !== undefined
          ? {
              complianceBinarySecurityToken: await encryptOptional(
                material.complianceBinarySecurityToken,
              ),
            }
          : {}),
        ...(material.complianceApiSecret !== undefined
          ? { complianceApiSecret: await encryptOptional(material.complianceApiSecret) }
          : {}),
      } as EncryptedSignerMaterial;
      rows.set(tenantRef, encrypted);
    },

    async get(tenantRef: string) {
      const row = rows.get(tenantRef);
      if (row === undefined) return null;
      try {
        const compCert = await decryptOptional(row.complianceCertificate);
        const compBst = await decryptOptional(row.complianceBinarySecurityToken);
        const compSecret = await decryptOptional(row.complianceApiSecret);
        return {
          privateKey: await cipher.decrypt(row.privateKey),
          productionCertificate: await cipher.decrypt(row.productionCertificate),
          productionBinarySecurityToken: await cipher.decrypt(row.productionBinarySecurityToken),
          productionApiSecret: await cipher.decrypt(row.productionApiSecret),
          ...(compCert !== undefined ? { complianceCertificate: compCert } : {}),
          ...(compBst !== undefined ? { complianceBinarySecurityToken: compBst } : {}),
          ...(compSecret !== undefined ? { complianceApiSecret: compSecret } : {}),
        };
      } catch (cause) {
        // Re-raise as ZatcaCipherError so callers don't have to know
        // about the underlying primitive.
        if (cause instanceof ZatcaCipherError) throw cause;
        throw new ZatcaCipherError(`Vault decrypt failed for tenant '${tenantRef}'.`, cause);
      }
    },

    async delete(tenantRef: string) {
      rows.delete(tenantRef);
    },
  };
}

/**
 * Token shape: `zts_<env>_<tenantRef>_<32 base32 chars>`. The 32-char
 * random tail gives ~160 bits of entropy.
 */
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

interface ApiKeyRow {
  tokenId: string;
  tenantRef: string;
  hash: Buffer;
  salt: Buffer;
  label: string;
  last4: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

/**
 * Build the in-memory API-key store. `env` selects the token prefix
 * (`live` vs `test`); a single store may only mint tokens for one
 * environment to keep the prefix honest.
 */
export function createMemoryApiKeyStore(
  options: { env?: "live" | "test"; now?: () => Date } = {},
): ApiKeyStore {
  const env = options.env ?? "live";
  const clock = options.now ?? (() => new Date());
  const rows = new Map<string, ApiKeyRow>();

  return {
    async issue(tenantRef: string, label: string): Promise<IssuedApiKey> {
      const tail = base32Encode(randomBytes(20)).slice(0, 32);
      const token = `zts_${env}_${tenantRef}_${tail}`;
      const tokenId = base32Encode(randomBytes(10)).toLowerCase();
      const salt = randomBytes(16);
      const hash = await scrypt(token, salt, 32);
      const row: ApiKeyRow = {
        tokenId,
        tenantRef,
        hash,
        salt,
        label,
        last4: tail.slice(-4),
        createdAt: clock(),
      };
      rows.set(tokenId, row);
      return { token, tokenId };
    },

    async resolve(presentedToken: string): Promise<ResolvedApiKey | null> {
      const parsed = parseToken(presentedToken);
      if (parsed === null) return null;
      if (parsed.env !== env) return null;
      // Linear scan is fine for in-memory tests. DB impls will index
      // by (tenantRef, tail-prefix) for O(log n).
      for (const row of rows.values()) {
        if (row.revokedAt !== undefined) continue;
        if (row.tenantRef !== parsed.tenantRef) continue;
        const candidate = await scrypt(presentedToken, row.salt, 32);
        if (candidate.length !== row.hash.length) continue;
        if (!timingSafeEqual(candidate, row.hash)) continue;
        row.lastUsedAt = clock();
        return { tenantRef: row.tenantRef, tokenId: row.tokenId };
      }
      return null;
    },

    async revoke(tenantRef: string, tokenId: string) {
      const row = rows.get(tokenId);
      if (row === undefined) return false;
      // Tenant scoping: refuse to revoke a token that belongs to a
      // different tenant. The route layer maps `false` to 404 so
      // cross-tenant attempts (CR-04) cannot succeed.
      if (row.tenantRef !== tenantRef) return false;
      if (row.revokedAt !== undefined) return false;
      row.revokedAt = clock();
      return true;
    },

    async list(tenantRef: string): Promise<ReadonlyArray<ApiKeyListEntry>> {
      const out: ApiKeyListEntry[] = [];
      for (const row of rows.values()) {
        if (row.tenantRef !== tenantRef) continue;
        out.push({
          tokenId: row.tokenId,
          tenantRef: row.tenantRef,
          label: row.label,
          last4: row.last4,
          createdAt: row.createdAt,
          ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
          ...(row.revokedAt !== undefined ? { revokedAt: row.revokedAt } : {}),
        });
      }
      out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return out;
    },

    async revokeAllForTenant(tenantRef: string) {
      const now = clock();
      for (const row of rows.values()) {
        if (row.tenantRef !== tenantRef) continue;
        if (row.revokedAt !== undefined) continue;
        row.revokedAt = now;
      }
    },
  };
}

/**
 * Convenience: build all three in-memory stores wired together with
 * the supplied cipher.
 */
export function createMemoryRegistry(options: {
  cipher: SecretCipher;
  env?: "live" | "test";
  now?: () => Date;
}): { tenants: TenantStore; vault: CredentialVault; apiKeys: ApiKeyStore } {
  const baseOptions = options.now !== undefined ? { now: options.now } : {};
  const apiKeyOptions =
    options.env !== undefined ? { ...baseOptions, env: options.env } : baseOptions;
  return {
    tenants: createMemoryTenantStore(baseOptions),
    vault: createMemoryCredentialVault({ cipher: options.cipher }),
    apiKeys: createMemoryApiKeyStore(apiKeyOptions),
  };
}
