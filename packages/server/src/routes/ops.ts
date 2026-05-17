/**
 * Operational routes — `/healthz`, `/readyz`, `/metrics`.
 *
 * Bind these to an internal-only interface in production; they
 * intentionally have NO auth so kubernetes probes (and Prometheus
 * scrapers) can hit them without credentials.
 */

import type { FastifyPluginAsync } from "fastify";

import type { RouteDeps } from "./deps.js";

/**
 * Fastify plugin registering `/healthz`, `/readyz`, and (optionally)
 * `/metrics`. Metrics endpoint is gated by `config.metricsEnabled`.
 */
export const opsRoutes: FastifyPluginAsync<RouteDeps> = async (server, deps) => {
  server.get("/healthz", async () => ({ status: "ok" }));

  server.get("/readyz", async (req, reply) => {
    // Liveness over reachability: ping the tenant store (cheap) and
    // surface failures as 503. Future versions may also ping ZATCA.
    try {
      await deps.registry.tenants.list({ includeDeleted: false });
      return { status: "ready" };
    } catch (err) {
      // ME-12: /readyz is unauthenticated by design (k8s probes hit
      // it without credentials), and an internet-reachable port
      // would otherwise let any caller scrape the raw error.message
      // — which on a pg failure embeds the internal hostname / IP /
      // port. Log the detailed error for operators; return only a
      // coarse reason on the wire.
      req.log.error({ err }, "/readyz failed");
      return reply.code(503).send({
        status: "not-ready",
        reason: "backing-store-unavailable",
      });
    }
  });

  if (deps.config.metricsEnabled && deps.metrics !== undefined) {
    const metrics = deps.metrics;
    server.get("/metrics", async (_req, reply) => {
      const body = await metrics.registry.metrics();
      reply.header("Content-Type", metrics.registry.contentType);
      return body;
    });
  }
};
