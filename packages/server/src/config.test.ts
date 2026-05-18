import { describe, expect, it } from "vitest";

import { loadConfig, toSafeServerConfig } from "./config.js";
import { ZatcaServerError } from "./errors.js";

const VALID_KEY_B64 = Buffer.alloc(32, 1).toString("base64");
const VALID_KEY_B64_V2 = Buffer.alloc(32, 2).toString("base64");
const ADMIN_KEY = "a".repeat(32);

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ZATCA_SERVER_ADMIN_KEYS: `ops:${ADMIN_KEY}`,
    ZATCA_SERVER_MASTER_KEYS: `v1:${VALID_KEY_B64}`,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads a minimal valid configuration", () => {
    const cfg = loadConfig(env());
    expect(cfg.host).toBe("0.0.0.0");
    expect(cfg.port).toBe(3000);
    expect(cfg.timezone).toBe("Asia/Riyadh");
    expect(cfg.masterKeys).toHaveLength(1);
    expect(cfg.activeKid).toBe("v1");
    expect(cfg.tenantBearerEnv).toBe("live");
    expect(cfg.logLevel).toBe("info");
  });

  it("rejects empty admin keys", () => {
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_ADMIN_KEYS: "" })).toThrow(
      /ZATCA_SERVER_ADMIN_KEYS is required/,
    );
  });

  it("rejects empty master keys", () => {
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_MASTER_KEYS: "" })).toThrow(
      /ZATCA_SERVER_MASTER_KEYS is required/,
    );
  });

  it("rejects master keys of the wrong length", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_MASTER_KEYS: `v1:${short}` })).toThrow(
      /must be 32 bytes/,
    );
  });

  it("rejects duplicate kids", () => {
    expect(() =>
      loadConfig({
        ...env(),
        ZATCA_SERVER_MASTER_KEYS: `v1:${VALID_KEY_B64},v1:${VALID_KEY_B64_V2}`,
      }),
    ).toThrow(/Duplicate kid/);
  });

  it("rejects an activeKid not present in the ring", () => {
    expect(() =>
      loadConfig({
        ...env(),
        ZATCA_SERVER_ACTIVE_KID: "v99",
      }),
    ).toThrow(/not present in the master key ring/);
  });

  it("supports multiple keys with active kid pointing to v2", () => {
    const cfg = loadConfig({
      ...env(),
      ZATCA_SERVER_MASTER_KEYS: `v1:${VALID_KEY_B64},v2:${VALID_KEY_B64_V2}`,
      ZATCA_SERVER_ACTIVE_KID: "v2",
    });
    expect(cfg.masterKeys.map((k) => k.kid)).toEqual(["v1", "v2"]);
    expect(cfg.activeKid).toBe("v2");
  });

  it("parses port + timeout from env", () => {
    const cfg = loadConfig({
      ...env(),
      ZATCA_SERVER_PORT: "8080",
      ZATCA_SERVER_ONBOARDING_TIMEOUT_MS: "60000",
    });
    expect(cfg.port).toBe(8080);
    expect(cfg.onboardingTimeoutMs).toBe(60_000);
  });

  it("rejects invalid port + timeout strings", () => {
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_PORT: "abc" })).toThrow(/ZATCA_SERVER_PORT/);
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_PORT: "0" })).toThrow();
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_ONBOARDING_TIMEOUT_MS: "abc" })).toThrow();
  });

  it("parses metricsEnabled as boolean from string", () => {
    expect(loadConfig({ ...env(), ZATCA_SERVER_METRICS_ENABLED: "false" }).metricsEnabled).toBe(
      false,
    );
    expect(loadConfig({ ...env(), ZATCA_SERVER_METRICS_ENABLED: "true" }).metricsEnabled).toBe(
      true,
    );
  });

  it("rejects unknown log level", () => {
    expect(() => loadConfig({ ...env(), ZATCA_SERVER_LOG_LEVEL: "verbose" })).toThrow(
      /ZATCA_SERVER_LOG_LEVEL/,
    );
  });

  it("defaults instanceId to env.HOSTNAME when not set", () => {
    expect(loadConfig({ ...env(), HOSTNAME: "pod-7" }).instanceId).toBe("pod-7");
  });

  it("ZatcaServerError exposes hierarchy", () => {
    try {
      loadConfig({ ...env(), ZATCA_SERVER_ADMIN_KEYS: "" });
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaServerError);
    }
  });
});

describe("toSafeServerConfig (HI-09)", () => {
  it("strips master keys, active kid, and the raw admin-key string", () => {
    const cfg = loadConfig(env());
    const safe = toSafeServerConfig(cfg);
    expect(safe).not.toHaveProperty("masterKeys");
    expect(safe).not.toHaveProperty("activeKid");
    expect(safe).not.toHaveProperty("adminKeysRaw");
  });

  it("preserves every non-secret field unchanged", () => {
    const cfg = loadConfig(env());
    const safe = toSafeServerConfig(cfg);
    expect(safe.host).toBe(cfg.host);
    expect(safe.port).toBe(cfg.port);
    expect(safe.timezone).toBe(cfg.timezone);
    expect(safe.tenantBearerEnv).toBe(cfg.tenantBearerEnv);
    expect(safe.onboardingTimeoutMs).toBe(cfg.onboardingTimeoutMs);
    expect(safe.idempotencyWindowMs).toBe(cfg.idempotencyWindowMs);
    expect(safe.instanceId).toBe(cfg.instanceId);
    expect(safe.metricsEnabled).toBe(cfg.metricsEnabled);
    expect(safe.logLevel).toBe(cfg.logLevel);
  });

  it("JSON.stringify of the safe config does not contain the master-key bytes", () => {
    const cfg = loadConfig(env());
    const safe = toSafeServerConfig(cfg);
    const serialized = JSON.stringify(safe);
    // The base64 admin key embeds 'aaaa...' (32 'a's) — its presence
    // in the serialized blob would mean a stray log would leak.
    expect(serialized).not.toContain(ADMIN_KEY);
    expect(serialized).not.toContain(VALID_KEY_B64);
  });
});
