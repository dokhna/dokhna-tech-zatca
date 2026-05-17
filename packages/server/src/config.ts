/**
 * Runtime configuration loader.
 *
 * Reads from `process.env`, validates with `zod`, fails eagerly at
 * boot on misconfiguration. The shape is intentionally flat — every
 * field is overridable from a single env var or `--flag` to keep
 * 12-factor deployments simple.
 */

import { z } from "zod";

import type { MasterKey } from "./crypto/aes-gcm-cipher.js";
import { ZatcaServerError } from "./errors.js";

/**
 * Validated server configuration. All defaults that aren't security-
 * sensitive are baked in here; security-sensitive fields (master keys,
 * admin keys, DB URI) are required.
 */
export interface ServerConfig {
  /** Bind host. Default `0.0.0.0`. */
  readonly host: string;
  /** Bind port. Default `3000`. */
  readonly port: number;
  /** Default time zone for log timestamps + audit rows. Default `Asia/Riyadh`. */
  readonly timezone: string;
  /**
   * Comma-separated `label:key` list parsed into the admin-key
   * verifier at boot.
   */
  readonly adminKeysRaw: string;
  /**
   * `kid:base64key,kid:base64key` — every key is 32 raw bytes
   * (base64-decoded). Ordered ring; encryption uses `activeKid`
   * (defaults to the LAST entry if `ZATCA_SERVER_ACTIVE_KID` is
   * unset).
   */
  readonly masterKeys: ReadonlyArray<MasterKey>;
  /** Kid used for new encryptions. Defaults to the last entry in `masterKeys`. */
  readonly activeKid: string;
  /**
   * Which environment to use for newly minted tenant bearers
   * (`live` | `test`). Independent of the ZATCA `environment` per
   * tenant.
   */
  readonly tenantBearerEnv: "live" | "test";
  /**
   * Onboarding HTTP read timeout — and the per-tenant lock TTL.
   * Defaults to 180_000 ms (3 minutes); matches the documented
   * onboarding ceiling.
   */
  readonly onboardingTimeoutMs: number;
  /** Idempotency-key replay window in ms. Default 86_400_000 (24h). */
  readonly idempotencyWindowMs: number;
  /**
   * Server-instance identifier used for the per-tenant onboarding
   * lock. Defaults to the hostname; override when multiple replicas
   * share a hostname (Kubernetes pods, etc.).
   */
  readonly instanceId: string;
  /** Expose `/metrics` (Prometheus exposition). Default `true`. */
  readonly metricsEnabled: boolean;
  /** Pino log level. Default `info`. */
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  /**
   * Trust the `X-Forwarded-*` chain from upstream proxies. Default
   * `false` (ME-15). Set to `true` ONLY when running behind a
   * trusted reverse proxy / ingress that strips the headers before
   * forwarding. With `true` and a directly-reachable bind address,
   * a same-network attacker can spoof `req.ip` via
   * `X-Forwarded-For`.
   */
  readonly trustProxy: boolean;
}

/**
 * Route-handler-facing config. Strips the raw key material
 * (`masterKeys`, `adminKeysRaw`, `activeKid`) so a stray
 * `log.info({ config }, ...)` from a route can't dump master keys or
 * the comma-separated admin key string into stdout. The boot code in
 * `buildApp` consumes the raw fields up-front to construct the
 * cipher and verifier; downstream route handlers only ever need the
 * cipher/verifier, never the raw bytes.
 *
 * HI-09 from REVIEW.md.
 */
export type SafeServerConfig = Omit<ServerConfig, "masterKeys" | "activeKid" | "adminKeysRaw">;

/**
 * Strip the secret-bearing fields from a {@link ServerConfig}. Used
 * by `buildApp` after it has consumed the raw key material; the
 * returned shape is what every route handler sees as `deps.config`.
 */
export function toSafeServerConfig(config: ServerConfig): SafeServerConfig {
  const { masterKeys: _m, activeKid: _a, adminKeysRaw: _r, ...safe } = config;
  return safe;
}

const LevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace"]);

function readKeyring(raw: string): ReadonlyArray<MasterKey> {
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (entries.length === 0) {
    throw new ZatcaServerError(
      "ZATCA_SERVER_MASTER_KEYS is required. Format: kid:<base64-32-bytes>[,kid:<base64-32-bytes>...]",
    );
  }
  const out: MasterKey[] = [];
  const seenKids = new Set<string>();
  for (const entry of entries) {
    const idx = entry.indexOf(":");
    if (idx <= 0 || idx === entry.length - 1) {
      throw new ZatcaServerError(
        `Master key entry '${entry}' must be of the form 'kid:<base64-32-bytes>'.`,
      );
    }
    const kid = entry.slice(0, idx).trim();
    const b64 = entry.slice(idx + 1).trim();
    if (seenKids.has(kid)) {
      throw new ZatcaServerError(`Duplicate kid '${kid}' in master key ring.`);
    }
    seenKids.add(kid);
    // ME-24: Buffer.from(..., "base64") silently truncates on
    // garbage input (e.g. unicode or non-base64 punctuation) and
    // returns a short buffer. The length check below would catch
    // most cases but report a misleading "got 8 bytes" when the
    // operator pasted a 44-char string of nonsense. Validate the
    // alphabet first so the error names the real problem.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
      throw new ZatcaServerError(
        `Master key for kid '${kid}' is not valid base64. Expected ` +
          `44 chars of [A-Za-z0-9+/] with optional '=' padding (32 raw bytes).`,
      );
    }
    const key = Buffer.from(b64, "base64");
    if (key.length !== 32) {
      throw new ZatcaServerError(
        `Master key for kid '${kid}' must be 32 bytes after base64 decode; got ${key.length}.`,
      );
    }
    out.push({ kid, key });
  }
  return out;
}

const PortSchema = z
  .string()
  .regex(/^\d+$/, "must be a positive integer")
  .transform((s) => Number.parseInt(s, 10))
  .refine((n) => n > 0 && n < 65536, "must be between 1 and 65535");

const MsSchema = z
  .string()
  .regex(/^\d+$/, "must be a positive integer")
  .transform((s) => Number.parseInt(s, 10))
  .refine((n) => n > 0, "must be positive");

const BoolSchema = z
  .string()
  .transform((s) => s.toLowerCase())
  .refine((s) => s === "true" || s === "false", "must be 'true' or 'false'")
  .transform((s) => s === "true");

const EnvLiteralSchema = z.enum(["live", "test"]);

/**
 * Build a {@link ServerConfig} from `process.env` (or any equivalent
 * map). Throws {@link ZatcaServerError} with a precise reason on any
 * invalid / missing required field.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const adminKeysRaw = env.ZATCA_SERVER_ADMIN_KEYS ?? "";
  if (adminKeysRaw === "") {
    throw new ZatcaServerError(
      "ZATCA_SERVER_ADMIN_KEYS is required. Format: label:<key>[,label:<key>...]",
    );
  }
  const masterKeysRaw = env.ZATCA_SERVER_MASTER_KEYS ?? "";
  const masterKeys = readKeyring(masterKeysRaw);
  const activeKid =
    env.ZATCA_SERVER_ACTIVE_KID?.trim() ?? masterKeys[masterKeys.length - 1]?.kid ?? "";
  if (!masterKeys.some((m) => m.kid === activeKid)) {
    throw new ZatcaServerError(
      `ZATCA_SERVER_ACTIVE_KID '${activeKid}' is not present in the master key ring.`,
    );
  }

  function withDefault<T>(
    raw: string | undefined,
    schema: z.ZodType<T, z.ZodTypeDef, string>,
    fallback: T,
    envName: string,
  ): T {
    if (raw === undefined || raw === "") return fallback;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new ZatcaServerError(
        `${envName} is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    return parsed.data;
  }

  return {
    host: env.ZATCA_SERVER_HOST ?? "0.0.0.0",
    port: withDefault(env.ZATCA_SERVER_PORT, PortSchema, 3000, "ZATCA_SERVER_PORT"),
    timezone: env.ZATCA_SERVER_TZ ?? "Asia/Riyadh",
    adminKeysRaw,
    masterKeys,
    activeKid,
    tenantBearerEnv: withDefault(
      env.ZATCA_SERVER_TENANT_BEARER_ENV,
      EnvLiteralSchema,
      "live",
      "ZATCA_SERVER_TENANT_BEARER_ENV",
    ),
    onboardingTimeoutMs: withDefault(
      env.ZATCA_SERVER_ONBOARDING_TIMEOUT_MS,
      MsSchema,
      180_000,
      "ZATCA_SERVER_ONBOARDING_TIMEOUT_MS",
    ),
    idempotencyWindowMs: withDefault(
      env.ZATCA_SERVER_IDEMPOTENCY_WINDOW_MS,
      MsSchema,
      86_400_000,
      "ZATCA_SERVER_IDEMPOTENCY_WINDOW_MS",
    ),
    instanceId: env.ZATCA_SERVER_INSTANCE_ID ?? env.HOSTNAME ?? "instance-0",
    metricsEnabled: withDefault(
      env.ZATCA_SERVER_METRICS_ENABLED,
      BoolSchema,
      true,
      "ZATCA_SERVER_METRICS_ENABLED",
    ),
    logLevel: withDefault(
      env.ZATCA_SERVER_LOG_LEVEL,
      LevelSchema,
      "info",
      "ZATCA_SERVER_LOG_LEVEL",
    ),
    trustProxy: withDefault(
      env.ZATCA_SERVER_TRUST_PROXY,
      BoolSchema,
      false,
      "ZATCA_SERVER_TRUST_PROXY",
    ),
  };
}
