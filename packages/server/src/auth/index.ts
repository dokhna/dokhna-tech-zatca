/**
 * Public surface of the auth layer.
 *
 * Pure logic — no Fastify dependency. The HTTP middleware (PR3)
 * binds these helpers to request/reply objects.
 */

export {
  type AdminKeyEntry,
  type AdminKeyVerifier,
  createAdminKeyVerifier,
  extractBearer,
  parseAdminKeys,
} from "./admin-keys.js";
export {
  createTenantBearerVerifier,
  type TenantBearerVerifier,
} from "./tenant-bearer.js";
