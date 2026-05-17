/**
 * Public surface of the tenant-registry layer.
 *
 * Three separate interfaces — `TenantStore`, `CredentialVault`,
 * `ApiKeyStore` — plus the in-memory reference implementation that
 * wires them together for dev + tests. DB-backed implementations land
 * in PR2.
 */

export type {
  ApiKeyListEntry,
  ApiKeyStore,
  IssuedApiKey,
  ResolvedApiKey,
} from "./api-key-store.js";
export type {
  CredentialVault,
  EncryptedSignerMaterial,
  SignerMaterial,
} from "./credential-vault.js";
export {
  createMemoryApiKeyStore,
  createMemoryCredentialVault,
  createMemoryRegistry,
  createMemoryTenantStore,
  generateTenantRef,
} from "./registry-memory.js";
export {
  buildServerModels,
  createMongoApiKeyStore,
  createMongoCredentialVault,
  createMongoRegistry,
  createMongoTenantStore,
  type MongoApiKeyStoreOptions,
  type MongoCredentialVaultOptions,
  type MongoTenantStoreOptions,
} from "./registry-mongo.js";
export {
  createPostgresApiKeyStore,
  createPostgresCredentialVault,
  createPostgresRegistry,
  createPostgresTenantStore,
  type PgClient,
  type PgQueryable,
  type PostgresApiKeyStoreOptions,
  type PostgresCredentialVaultOptions,
  type PostgresTenantStoreOptions,
  withPgTransaction,
} from "./registry-postgres.js";
export type { TenantStore } from "./store.js";
export {
  type CreateTenantInput,
  type OnboardingProgress,
  type PatchableTenantFields,
  type SetStateOptions,
  type TenantListFilter,
  type TenantLocation,
  type TenantRecord,
  type TenantState,
  toTenantScope,
} from "./types.js";
