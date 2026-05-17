/**
 * MongoDB-backed implementations of `TenantStore`, `CredentialVault`,
 * and `ApiKeyStore` using Mongoose.
 *
 * Atomicity:
 * - `setState` uses `findOneAndUpdate` with a state predicate in the
 *   filter — single-statement compare-and-swap, safe across replicas.
 * - Multi-document atomicity (a mutation + an audit-log write in the
 *   same transaction) requires a Mongo replica set and explicit
 *   sessions. The HTTP layer in PR3 will manage sessions; this layer
 *   accepts an optional `session` parameter on every method (omitted
 *   here for v1 simplicity — added when needed).
 *
 * Collections (all created on first use; Mongoose's discoverIndexes
 * builds the indexes lazily — call `await connection.syncIndexes()`
 * during boot in production to ensure they exist before traffic):
 *
 *   zatca_server_tenants
 *   zatca_server_credentials
 *   zatca_server_api_keys
 *   zatca_server_audit_log  (handled by log-mongo.ts)
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { asCommercialRegistrationNumber, asEGSUuid, asVATNumber } from "@dokhna-tech/zatca";
import type { Connection, Model, Schema as SchemaType } from "mongoose";
import mongoose from "mongoose";

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
  TenantLocation,
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

export function generateTenantRef(): string {
  return base32Encode(randomBytes(10)).toLowerCase();
}

function generateTokenId(): string {
  return base32Encode(randomBytes(10)).toLowerCase();
}

function generateTokenTail(): string {
  return base32Encode(randomBytes(20)).slice(0, 32);
}

interface TenantDoc {
  _id: string; // tenantRef
  vatNumber: string;
  egsUuid: string;
  vatName: string;
  crn: string;
  branchName: string;
  branchIndustry?: string;
  location: TenantLocation;
  environment: string;
  state: string;
  onboardingProgress: OnboardingProgress;
  productionCertificateExpiresAt?: Date;
  callbackUrl?: string;
  claimedBy?: string;
  claimExpiresAt?: Date;
  label?: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;
}

interface CredentialsDoc {
  _id: string; // tenantRef
  privateKey: CipherEnvelope;
  productionCertificate: CipherEnvelope;
  productionBinarySecurityToken: CipherEnvelope;
  productionApiSecret: CipherEnvelope;
  complianceCertificate?: CipherEnvelope;
  complianceBinarySecurityToken?: CipherEnvelope;
  complianceApiSecret?: CipherEnvelope;
  createdAt: Date;
  updatedAt: Date;
}

interface ApiKeyDoc {
  _id: string; // tokenId
  tenantRef: string;
  tokenHashB64: string;
  saltB64: string;
  env: string;
  last4: string;
  label: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

const TenantSchemaDefinition = {
  _id: { type: String, required: true },
  vatNumber: { type: String, required: true },
  egsUuid: { type: String, required: true },
  vatName: { type: String, required: true },
  crn: { type: String, required: true },
  branchName: { type: String, required: true },
  branchIndustry: { type: String, required: false },
  location: { type: mongoose.Schema.Types.Mixed, required: true },
  environment: { type: String, required: true },
  state: { type: String, required: true, default: "created" },
  onboardingProgress: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    default: () => ({ scenarios: {} }),
  },
  productionCertificateExpiresAt: { type: Date, required: false },
  callbackUrl: { type: String, required: false },
  claimedBy: { type: String, required: false },
  claimExpiresAt: { type: Date, required: false },
  label: { type: String, required: false },
  createdAt: { type: Date, required: true, default: () => new Date() },
  updatedAt: { type: Date, required: true, default: () => new Date() },
  deletedAt: { type: Date, required: false },
};

const CredentialsSchemaDefinition = {
  _id: { type: String, required: true },
  privateKey: { type: mongoose.Schema.Types.Mixed, required: true },
  productionCertificate: { type: mongoose.Schema.Types.Mixed, required: true },
  productionBinarySecurityToken: { type: mongoose.Schema.Types.Mixed, required: true },
  productionApiSecret: { type: mongoose.Schema.Types.Mixed, required: true },
  complianceCertificate: { type: mongoose.Schema.Types.Mixed, required: false },
  complianceBinarySecurityToken: { type: mongoose.Schema.Types.Mixed, required: false },
  complianceApiSecret: { type: mongoose.Schema.Types.Mixed, required: false },
  createdAt: { type: Date, required: true, default: () => new Date() },
  updatedAt: { type: Date, required: true, default: () => new Date() },
};

const ApiKeySchemaDefinition = {
  _id: { type: String, required: true },
  tenantRef: { type: String, required: true, index: true },
  tokenHashB64: { type: String, required: true },
  saltB64: { type: String, required: true },
  env: { type: String, required: true },
  last4: { type: String, required: true },
  label: { type: String, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
  lastUsedAt: { type: Date, required: false },
  revokedAt: { type: Date, required: false },
};

interface ServerModels {
  TenantModel: Model<TenantDoc>;
  CredentialsModel: Model<CredentialsDoc>;
  ApiKeyModel: Model<ApiKeyDoc>;
}

/**
 * Materialise Mongoose models on the supplied connection. Collection
 * names are fixed (`zatca_server_*`) so cross-process callers see the
 * same data.
 */
export function buildServerModels(connection: Connection): ServerModels {
  const tenantSchema = (connection.models.ZatcaServerTenant as Model<TenantDoc> | undefined)
    ?.schema as SchemaType<TenantDoc> | undefined;
  const TenantModel =
    (connection.models.ZatcaServerTenant as Model<TenantDoc> | undefined) ??
    connection.model<TenantDoc>(
      "ZatcaServerTenant",
      tenantSchema ??
        new mongoose.Schema<TenantDoc>(TenantSchemaDefinition, { versionKey: false, _id: false }),
      "zatca_server_tenants",
    );
  const credentialsSchema = (
    connection.models.ZatcaServerCredentials as Model<CredentialsDoc> | undefined
  )?.schema as SchemaType<CredentialsDoc> | undefined;
  const CredentialsModel =
    (connection.models.ZatcaServerCredentials as Model<CredentialsDoc> | undefined) ??
    connection.model<CredentialsDoc>(
      "ZatcaServerCredentials",
      credentialsSchema ??
        new mongoose.Schema<CredentialsDoc>(CredentialsSchemaDefinition, {
          versionKey: false,
          _id: false,
        }),
      "zatca_server_credentials",
    );
  const apiKeySchema = (connection.models.ZatcaServerApiKey as Model<ApiKeyDoc> | undefined)
    ?.schema as SchemaType<ApiKeyDoc> | undefined;
  const ApiKeyModel =
    (connection.models.ZatcaServerApiKey as Model<ApiKeyDoc> | undefined) ??
    connection.model<ApiKeyDoc>(
      "ZatcaServerApiKey",
      apiKeySchema ??
        new mongoose.Schema<ApiKeyDoc>(ApiKeySchemaDefinition, { versionKey: false, _id: false }),
      "zatca_server_api_keys",
    );
  return { TenantModel, CredentialsModel, ApiKeyModel };
}

function docToTenant(doc: TenantDoc): TenantRecord {
  const out: Record<string, unknown> = {
    tenantRef: doc._id,
    vatNumber: asVATNumber(doc.vatNumber),
    egsUuid: asEGSUuid(doc.egsUuid),
    vatName: doc.vatName,
    crn: asCommercialRegistrationNumber(doc.crn),
    branchName: doc.branchName,
    location: doc.location,
    environment: doc.environment,
    state: doc.state,
    onboardingProgress: doc.onboardingProgress ?? { scenarios: {} },
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (doc.branchIndustry !== undefined) out.branchIndustry = doc.branchIndustry;
  if (doc.productionCertificateExpiresAt !== undefined) {
    out.productionCertificateExpiresAt = doc.productionCertificateExpiresAt;
  }
  if (doc.callbackUrl !== undefined) out.callbackUrl = doc.callbackUrl;
  if (doc.claimedBy !== undefined) out.claimedBy = doc.claimedBy;
  if (doc.claimExpiresAt !== undefined) out.claimExpiresAt = doc.claimExpiresAt;
  if (doc.label !== undefined) out.label = doc.label;
  if (doc.deletedAt !== undefined) out.deletedAt = doc.deletedAt;
  return out as unknown as TenantRecord;
}

function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === 11000;
}

/**
 * Constructor options for the Mongo tenant store.
 */
export interface MongoTenantStoreOptions {
  readonly connection: Connection;
  readonly now?: () => Date;
}

export function createMongoTenantStore(options: MongoTenantStoreOptions): TenantStore {
  const { TenantModel } = buildServerModels(options.connection);
  const clock = options.now ?? (() => new Date());

  async function requireDoc(tenantRef: string): Promise<TenantDoc> {
    const doc = await TenantModel.findOne({ _id: tenantRef, deletedAt: { $exists: false } })
      .lean()
      .exec();
    if (doc === null) {
      throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`, { code: "not_found" });
    }
    return doc as TenantDoc;
  }

  return {
    async create(input: CreateTenantInput) {
      const tenantRef = input.tenantRef ?? generateTenantRef();
      const now = clock();
      const doc: TenantDoc = {
        _id: tenantRef,
        vatNumber: input.vatNumber,
        egsUuid: input.egsUuid,
        vatName: input.vatName,
        crn: input.crn,
        branchName: input.branchName,
        ...(input.branchIndustry !== undefined ? { branchIndustry: input.branchIndustry } : {}),
        location: input.location,
        environment: input.environment,
        state: "created",
        onboardingProgress: { scenarios: {} },
        ...(input.callbackUrl !== undefined ? { callbackUrl: input.callbackUrl } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        createdAt: now,
        updatedAt: now,
      };
      try {
        await TenantModel.create(doc);
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          throw new ZatcaRegistryError(`Tenant '${tenantRef}' already exists.`, {
            code: "conflict",
          });
        }
        throw err;
      }
      return docToTenant(doc);
    },

    async get(tenantRef: string) {
      const doc = await TenantModel.findOne({
        _id: tenantRef,
        deletedAt: { $exists: false },
      })
        .lean()
        .exec();
      return doc === null ? null : docToTenant(doc as TenantDoc);
    },

    async list(filter: TenantListFilter = {}) {
      const mongoFilter: Record<string, unknown> = {};
      if (filter.includeDeleted !== true) {
        mongoFilter.deletedAt = { $exists: false };
      }
      if (filter.state !== undefined) mongoFilter.state = filter.state;
      if (filter.environment !== undefined) mongoFilter.environment = filter.environment;
      if (filter.expiringWithinDays !== undefined) {
        const cutoff = new Date(clock().getTime() + filter.expiringWithinDays * 86_400_000);
        mongoFilter.productionCertificateExpiresAt = { $ne: null, $lte: cutoff };
      }
      const docs = await TenantModel.find(mongoFilter).sort({ createdAt: 1, _id: 1 }).lean().exec();
      return docs.map((d) => docToTenant(d as TenantDoc));
    },

    async patch(tenantRef: string, patch: PatchableTenantFields) {
      const set: Record<string, unknown> = { updatedAt: clock() };
      if (patch.vatName !== undefined) set.vatName = patch.vatName;
      if (patch.branchName !== undefined) set.branchName = patch.branchName;
      if (patch.branchIndustry !== undefined) set.branchIndustry = patch.branchIndustry;
      if (patch.location !== undefined) set.location = patch.location;
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.callbackUrl !== undefined) set.callbackUrl = patch.callbackUrl;
      const doc = await TenantModel.findOneAndUpdate(
        { _id: tenantRef, deletedAt: { $exists: false } },
        { $set: set },
        { returnDocument: "after", lean: true },
      ).exec();
      if (doc === null) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`, { code: "not_found" });
      }
      return docToTenant(doc as unknown as TenantDoc);
    },

    async setState(tenantRef: string, next: TenantState, opts: SetStateOptions = {}) {
      const now = clock();
      const set: Record<string, unknown> = {
        state: next,
        updatedAt: now,
      };
      const unset: Record<string, unknown> = {};
      if (opts.claimedBy !== undefined) {
        set.claimedBy = opts.claimedBy;
      } else {
        unset.claimedBy = "";
      }
      if (opts.claimExpiresAt !== undefined) {
        set.claimExpiresAt = opts.claimExpiresAt;
      } else {
        unset.claimExpiresAt = "";
      }
      const update: Record<string, unknown> = { $set: set };
      if (Object.keys(unset).length > 0) {
        update.$unset = unset;
      }

      // Pre-compute the onboardingProgress update for lastError so the
      // setState UPDATE remains a single atomic operation.
      if (opts.lastError !== undefined) {
        const current = (await TenantModel.findOne({ _id: tenantRef })
          .lean()
          .exec()) as TenantDoc | null;
        const existing = current?.onboardingProgress ?? { scenarios: {} };
        set.onboardingProgress = { ...existing, lastError: opts.lastError };
      }

      let filter: Record<string, unknown>;
      if (opts.expectedFrom !== undefined) {
        // CAS: state matches expectedFrom OR a stale claim that we can
        // reclaim. A NULL/missing claimExpiresAt is treated as
        // "lock not held" (CR-02) — without this branch a tenant whose
        // claimExpiresAt never got persisted (crash mid-setState, DBA
        // intervention, future refactor calling setState('onboarding',
        // {}) with no expiry) wedges forever because no CAS predicate
        // matches.
        filter = {
          _id: tenantRef,
          deletedAt: { $exists: false },
          $or: [
            { state: opts.expectedFrom },
            {
              $and: [
                { state: "onboarding" },
                {
                  $or: [
                    { claimExpiresAt: { $lte: now } },
                    { claimExpiresAt: null },
                    { claimExpiresAt: { $exists: false } },
                  ],
                },
              ],
            },
          ],
        };
      } else {
        filter = { _id: tenantRef, deletedAt: { $exists: false } };
      }

      const doc = await TenantModel.findOneAndUpdate(filter, update, {
        returnDocument: "after",
        lean: true,
      }).exec();
      if (doc === null) {
        // Distinguish "unknown" from "CAS-failed".
        const exists = (await TenantModel.findOne({
          _id: tenantRef,
          deletedAt: { $exists: false },
        })
          .lean()
          .exec()) as TenantDoc | null;
        if (exists === null) {
          throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`, { code: "not_found" });
        }
        throw new ZatcaRegistryError(
          `Cannot transition tenant '${tenantRef}' from '${exists.state}' (expected '${opts.expectedFrom}').`,
          { code: "conflict" },
        );
      }
      return docToTenant(doc as unknown as TenantDoc);
    },

    async recordOnboardingProgress(tenantRef: string, scenario: string, passed: boolean) {
      const existing = await requireDoc(tenantRef);
      // Defensive against legacy rows / Mixed-type quirks where the
      // field could conceivably be absent.
      const currentProgress: OnboardingProgress = existing.onboardingProgress ?? { scenarios: {} };
      const merged: OnboardingProgress = {
        ...currentProgress,
        scenarios: {
          ...currentProgress.scenarios,
          [scenario]: passed ? "passed" : "failed",
        },
      };
      const result = await TenantModel.updateOne(
        { _id: tenantRef, deletedAt: { $exists: false } },
        { $set: { onboardingProgress: merged, updatedAt: clock() } },
      ).exec();
      if (result.matchedCount === 0) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`, { code: "not_found" });
      }
    },

    async setProductionExpiry(tenantRef: string, expiresAt: Date) {
      const result = await TenantModel.updateOne(
        { _id: tenantRef, deletedAt: { $exists: false } },
        { $set: { productionCertificateExpiresAt: expiresAt, updatedAt: clock() } },
      ).exec();
      if (result.matchedCount === 0) {
        throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`, { code: "not_found" });
      }
    },

    async softDelete(tenantRef: string) {
      const now = clock();
      // ME-05: filter so a second softDelete can't clobber the
      // original deletion timestamp. Use $exists:false on deletedAt
      // — Mongoose treats unset and null differently; we set
      // deletedAt only on first delete, so $exists:false matches
      // exactly the not-yet-deleted state.
      const result = await TenantModel.updateOne(
        { _id: tenantRef, deletedAt: { $exists: false } },
        { $set: { state: "revoked", deletedAt: now, updatedAt: now } },
      ).exec();
      if (result.matchedCount === 0) {
        const exists = await TenantModel.exists({ _id: tenantRef });
        if (exists === null) {
          throw new ZatcaRegistryError(`Unknown tenant '${tenantRef}'.`, { code: "not_found" });
        }
        throw new ZatcaRegistryError(`Tenant '${tenantRef}' is already deleted.`, {
          code: "conflict",
        });
      }
    },

    async ping() {
      // ME-11: cheap ping via the underlying driver — checks
      // connectivity without pulling tenant rows. Used by /readyz.
      const db = options.connection.db;
      if (db === undefined) {
        throw new Error("Mongoose connection has no .db handle (not yet open?).");
      }
      await db.admin().ping();
    },
  };
}

/**
 * Constructor options for the Mongo credential vault.
 */
export interface MongoCredentialVaultOptions {
  readonly connection: Connection;
  readonly cipher: SecretCipher;
  readonly now?: () => Date;
}

export function createMongoCredentialVault(options: MongoCredentialVaultOptions): CredentialVault {
  const { CredentialsModel } = buildServerModels(options.connection);
  const cipher = options.cipher;
  const clock = options.now ?? (() => new Date());

  async function encryptOptional(value: string | undefined): Promise<CipherEnvelope | undefined> {
    if (value === undefined) return undefined;
    return cipher.encrypt(value);
  }

  return {
    async put(tenantRef: string, material: SignerMaterial) {
      const now = clock();
      const doc: Partial<CredentialsDoc> = {
        _id: tenantRef,
        privateKey: await cipher.encrypt(material.privateKey),
        productionCertificate: await cipher.encrypt(material.productionCertificate),
        productionBinarySecurityToken: await cipher.encrypt(material.productionBinarySecurityToken),
        productionApiSecret: await cipher.encrypt(material.productionApiSecret),
        updatedAt: now,
      };
      const cc = await encryptOptional(material.complianceCertificate);
      const cbst = await encryptOptional(material.complianceBinarySecurityToken);
      const cas = await encryptOptional(material.complianceApiSecret);
      // HI-10: re-onboard MUST clear stale optional compliance fields.
      // Build a parallel `$unset` for fields the new material omits so
      // a row that previously held compliance values doesn't keep them
      // after a rotation that produced production material only.
      const unset: Record<string, ""> = {};
      if (cc !== undefined) doc.complianceCertificate = cc;
      else unset.complianceCertificate = "";
      if (cbst !== undefined) doc.complianceBinarySecurityToken = cbst;
      else unset.complianceBinarySecurityToken = "";
      if (cas !== undefined) doc.complianceApiSecret = cas;
      else unset.complianceApiSecret = "";
      const update: Record<string, unknown> = {
        $set: doc,
        $setOnInsert: { createdAt: now },
      };
      if (Object.keys(unset).length > 0) update.$unset = unset;
      await CredentialsModel.findOneAndUpdate({ _id: tenantRef }, update, {
        upsert: true,
        returnDocument: "after",
      }).exec();
    },

    async get(tenantRef: string) {
      const doc = (await CredentialsModel.findOne({ _id: tenantRef })
        .lean()
        .exec()) as CredentialsDoc | null;
      if (doc === null) return null;
      try {
        const out: SignerMaterial = {
          privateKey: await cipher.decrypt(doc.privateKey),
          productionCertificate: await cipher.decrypt(doc.productionCertificate),
          productionBinarySecurityToken: await cipher.decrypt(doc.productionBinarySecurityToken),
          productionApiSecret: await cipher.decrypt(doc.productionApiSecret),
        };
        if (doc.complianceCertificate !== undefined) {
          (out as { complianceCertificate?: string }).complianceCertificate = await cipher.decrypt(
            doc.complianceCertificate,
          );
        }
        if (doc.complianceBinarySecurityToken !== undefined) {
          (out as { complianceBinarySecurityToken?: string }).complianceBinarySecurityToken =
            await cipher.decrypt(doc.complianceBinarySecurityToken);
        }
        if (doc.complianceApiSecret !== undefined) {
          (out as { complianceApiSecret?: string }).complianceApiSecret = await cipher.decrypt(
            doc.complianceApiSecret,
          );
        }
        return out;
      } catch (cause) {
        if (cause instanceof ZatcaCipherError) throw cause;
        throw new ZatcaCipherError(`Vault decrypt failed for tenant '${tenantRef}'.`, cause);
      }
    },

    async delete(tenantRef: string) {
      await CredentialsModel.deleteOne({ _id: tenantRef }).exec();
    },
  };
}

// ME-22: tenantRef segment matches the admin-side allow-list
// `^[a-z0-9][a-z0-9-]{0,63}$` (admin-tenants.ts).
const TOKEN_RE = /^zts_(live|test)_([a-z0-9-]+)_([A-Z2-7]{32})$/;

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

/**
 * Constructor options for the Mongo api-key store.
 */
export interface MongoApiKeyStoreOptions {
  readonly connection: Connection;
  readonly env?: "live" | "test";
  readonly now?: () => Date;
}

/**
 * ME-04: skip writing `lastUsedAt` more often than once per minute
 * per token. Mirror of the Postgres impl debounce.
 */
const MONGO_LAST_USED_DEBOUNCE_MS = 60_000;

export function createMongoApiKeyStore(options: MongoApiKeyStoreOptions): ApiKeyStore {
  const { ApiKeyModel } = buildServerModels(options.connection);
  const env = options.env ?? "live";
  const clock = options.now ?? (() => new Date());
  const lastUsedWriteAt = new Map<string, number>();

  return {
    async issue(tenantRef: string, label: string): Promise<IssuedApiKey> {
      const tail = generateTokenTail();
      const token = `zts_${env}_${tenantRef}_${tail}`;
      const tokenId = generateTokenId();
      const salt = randomBytes(16);
      const hash = await scrypt(token, salt, 32);
      await ApiKeyModel.create({
        _id: tokenId,
        tenantRef,
        tokenHashB64: hash.toString("base64"),
        saltB64: salt.toString("base64"),
        env,
        last4: tail.slice(-4),
        label,
        createdAt: clock(),
      });
      return { token, tokenId };
    },

    async resolve(presentedToken: string): Promise<ResolvedApiKey | null> {
      const parsed = parseToken(presentedToken);
      if (parsed === null) return null;
      if (parsed.env !== env) return null;
      const docs = (await ApiKeyModel.find({
        tenantRef: parsed.tenantRef,
        revokedAt: { $exists: false },
      })
        .lean()
        .exec()) as ApiKeyDoc[];
      for (const doc of docs) {
        const salt = Buffer.from(doc.saltB64, "base64");
        const expectedHash = Buffer.from(doc.tokenHashB64, "base64");
        const candidate = await scrypt(presentedToken, salt, 32);
        if (candidate.length !== expectedHash.length) continue;
        if (!timingSafeEqual(candidate, expectedHash)) continue;
        // ME-04: debounce — skip the update if we wrote one for
        // this token within the window. Mirror of the Postgres impl.
        const now = clock().getTime();
        const lastWriteAt = lastUsedWriteAt.get(doc._id) ?? 0;
        if (now - lastWriteAt >= MONGO_LAST_USED_DEBOUNCE_MS) {
          lastUsedWriteAt.set(doc._id, now);
          await ApiKeyModel.updateOne(
            { _id: doc._id },
            { $set: { lastUsedAt: new Date(now) } },
          ).exec();
        }
        return { tenantRef: doc.tenantRef, tokenId: doc._id };
      }
      return null;
    },

    async revoke(tenantRef: string, tokenId: string) {
      // Tenant scoping (CR-04): the filter requires both `_id` and
      // `tenantRef` so an admin cannot revoke another tenant's tokens
      // via the wrong URL. `matchedCount` distinguishes a real revoke
      // (1) from a miss (0); the route turns the miss into a 404.
      const result = await ApiKeyModel.updateOne(
        { _id: tokenId, tenantRef, revokedAt: { $exists: false } },
        { $set: { revokedAt: clock() } },
      ).exec();
      return result.matchedCount > 0;
    },

    async list(tenantRef: string): Promise<ReadonlyArray<ApiKeyListEntry>> {
      const docs = (await ApiKeyModel.find({ tenantRef })
        .sort({ createdAt: 1 })
        .lean()
        .exec()) as ApiKeyDoc[];
      return docs.map((doc) => {
        const out: ApiKeyListEntry = {
          tokenId: doc._id,
          tenantRef: doc.tenantRef,
          label: doc.label,
          last4: doc.last4,
          createdAt: doc.createdAt,
        };
        if (doc.lastUsedAt !== undefined) {
          (out as { lastUsedAt?: Date }).lastUsedAt = doc.lastUsedAt;
        }
        if (doc.revokedAt !== undefined) {
          (out as { revokedAt?: Date }).revokedAt = doc.revokedAt;
        }
        return out;
      });
    },

    async revokeAllForTenant(tenantRef: string) {
      await ApiKeyModel.updateMany(
        { tenantRef, revokedAt: { $exists: false } },
        { $set: { revokedAt: clock() } },
      ).exec();
    },
  };
}

/**
 * Convenience: build all three Mongo-backed stores wired to the same
 * connection.
 */
export function createMongoRegistry(options: {
  readonly connection: Connection;
  readonly cipher: SecretCipher;
  readonly env?: "live" | "test";
  readonly now?: () => Date;
}): { tenants: TenantStore; vault: CredentialVault; apiKeys: ApiKeyStore } {
  const baseOptions = options.now !== undefined ? { now: options.now } : {};
  const tenantOptions = { connection: options.connection, ...baseOptions };
  const vaultOptions = {
    connection: options.connection,
    cipher: options.cipher,
    ...baseOptions,
  };
  const apiKeyOptions =
    options.env !== undefined
      ? { connection: options.connection, env: options.env, ...baseOptions }
      : { connection: options.connection, ...baseOptions };
  return {
    tenants: createMongoTenantStore(tenantOptions),
    vault: createMongoCredentialVault(vaultOptions),
    apiKeys: createMongoApiKeyStore(apiKeyOptions),
  };
}
