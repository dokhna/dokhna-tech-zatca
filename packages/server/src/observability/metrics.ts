/**
 * Prometheus metrics registry.
 *
 * Curated counter / histogram / gauge set per the architect's
 * observability requirements. Each metric is `zatca_*` prefixed so
 * dashboards filter cleanly across deployments.
 *
 * Multi-process metric aggregation is NOT enabled here — single-
 * process collection is the v1 expectation. Multi-replica deployers
 * scrape each replica separately and aggregate at Prometheus.
 */

import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from "prom-client";

/**
 * The set of metrics exposed by the server. Each is a thin wrapper
 * around the underlying prom-client primitive so call sites stay
 * type-safe.
 */
export interface ServerMetrics {
  readonly registry: Registry;
  readonly invoicesIssuedTotal: Counter<"tenant" | "kind" | "status">;
  readonly invoicesCancelledTotal: Counter<"tenant" | "result">;
  readonly onboardingTotal: Counter<"outcome">;
  readonly zatcaApiLatencySeconds: Histogram<"endpoint" | "result">;
  readonly activeTenants: Gauge<never>;
  readonly productionCertExpirySeconds: Gauge<"tenant">;
  readonly httpRequestsTotal: Counter<"method" | "route" | "status">;
  readonly httpRequestDurationSeconds: Histogram<"method" | "route">;
}

/**
 * Build the metrics registry. Pass `collectDefaults: false` in tests
 * where the default `process_*` collectors add noise.
 */
export function createMetrics(
  options: { readonly collectDefaults?: boolean; readonly registry?: Registry } = {},
): ServerMetrics {
  const registry = options.registry ?? new Registry();
  if (options.collectDefaults !== false) {
    collectDefaultMetrics({ register: registry, prefix: "zatca_" });
  }

  const invoicesIssuedTotal = new Counter({
    name: "zatca_invoices_issued_total",
    help: "Count of invoice issuance attempts grouped by tenant, kind, and status.",
    labelNames: ["tenant", "kind", "status"] as const,
    registers: [registry],
  });

  const invoicesCancelledTotal = new Counter({
    name: "zatca_invoices_cancelled_total",
    help: "Count of invoice cancellation attempts grouped by tenant and outcome.",
    labelNames: ["tenant", "result"] as const,
    registers: [registry],
  });

  const onboardingTotal = new Counter({
    name: "zatca_onboarding_total",
    help: "Count of onboarding attempts grouped by outcome (succeeded, failed, locked).",
    labelNames: ["outcome"] as const,
    registers: [registry],
  });

  const zatcaApiLatencySeconds = new Histogram({
    name: "zatca_api_latency_seconds",
    help: "Wall-clock latency of outbound ZATCA gateway calls.",
    labelNames: ["endpoint", "result"] as const,
    // Buckets sized for ZATCA's typical clearance/compliance latency
    // (100ms – 30s range).
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  });

  const activeTenants = new Gauge({
    name: "zatca_active_tenants",
    help: "Currently active (non-revoked) tenant count, refreshed periodically.",
    registers: [registry],
  });

  const productionCertExpirySeconds = new Gauge({
    name: "zatca_production_cert_expiry_seconds",
    help: "Seconds remaining until each tenant's production CSID expires.",
    labelNames: ["tenant"] as const,
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: "zatca_http_requests_total",
    help: "Inbound HTTP request count grouped by method, route, and response status.",
    labelNames: ["method", "route", "status"] as const,
    registers: [registry],
  });

  const httpRequestDurationSeconds = new Histogram({
    name: "zatca_http_request_duration_seconds",
    help: "Inbound HTTP request handling latency.",
    labelNames: ["method", "route"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  return {
    registry,
    invoicesIssuedTotal,
    invoicesCancelledTotal,
    onboardingTotal,
    zatcaApiLatencySeconds,
    activeTenants,
    productionCertExpirySeconds,
    httpRequestsTotal,
    httpRequestDurationSeconds,
  };
}
