/**
 * Public surface of the tenant-registry layer.
 *
 * Three separate interfaces — `TenantStore`, `CredentialVault`,
 * `ApiKeyStore` — plus three implementations:
 *   - in-memory (`createMemoryRegistry`) for dev + tests
 *   - MongoDB (`createMongoRegistry`)
 *   - PostgreSQL (`createPostgresRegistry`)
 *
 * All three implementations satisfy the same contracts so swapping
 * storage backends doesn't require touching route handlers. The
 * `withPgTransaction` helper is re-exported from
 * `registry-postgres.js` for downstream apps that embed the package
 * and need to wrap their own work in a transaction; route handlers
 * inside this package go through the `withUnitOfWork` abstraction in
 * `routes/deps.ts` instead.
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
