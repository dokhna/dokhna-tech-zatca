/**
 * Public surface of the route layer.
 *
 * Individual plugins are exported so advanced callers can compose
 * them ala carte; `registerAllRoutes` is the typical entrypoint.
 */

import type { FastifyInstance } from "fastify";

import { registerAdminApiKeyRoutes } from "./admin-api-keys.js";
import { registerAdminOnboardRoutes } from "./admin-onboard.js";
import { registerAdminTenantRoutes } from "./admin-tenants.js";
import type { RouteDeps } from "./deps.js";
import { opsRoutes } from "./ops.js";
import { registerTenantInvoiceRoutes } from "./tenant-invoices.js";

export { adminApiKeyRoutesPlugin } from "./admin-api-keys.js";
export { adminOnboardRoutesPlugin } from "./admin-onboard.js";
export { adminTenantRoutesPlugin } from "./admin-tenants.js";
export type { RouteDeps, UnitOfWork, WithUnitOfWork } from "./deps.js";
export { opsRoutes } from "./ops.js";
export { tenantInvoiceRoutesPlugin } from "./tenant-invoices.js";

/**
 * Register the full route set on a Fastify instance. The order is
 * unimportant for correctness but kept predictable for ops-route
 * binding and reverse-proxy config.
 */
export async function registerAllRoutes(server: FastifyInstance, deps: RouteDeps): Promise<void> {
  await server.register(opsRoutes, deps);
  registerAdminTenantRoutes(server, deps);
  registerAdminApiKeyRoutes(server, deps);
  registerAdminOnboardRoutes(server, deps);
  registerTenantInvoiceRoutes(server, deps);
}
