/**
 * Public surface of the server observability layer.
 *
 * - {@link createLogger} — pino with secret redaction.
 * - {@link createMetrics} — prom-client registry + curated metrics.
 */

export {
  type CreateLoggerOptions,
  createLogger,
  SECRET_REDACT_PATHS,
} from "./logger.js";
export { createMetrics, type ServerMetrics } from "./metrics.js";
