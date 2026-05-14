/**
 * CSR (Certificate Signing Request) generation via OpenSSL CLI.
 *
 * Builds a ZATCA-compliant CSR from an EGS unit's identity. The CSR
 * is the input to ZATCA's `complianceCsids` endpoint which returns
 * the compliance certificate.
 *
 * The flow is:
 *
 * 1. Probe / require OpenSSL on PATH (lazy, cached).
 * 2. Render the `.cnf` template from {@link generateCSRTemplate}.
 * 3. Write the private key + config to two temp files in `os.tmpdir()`
 *    using a `crypto.randomUUID()` filename. Private-key file gets
 *    `0600` permissions.
 * 4. Shell out: `openssl req -new -sha256 -key <pk> -config <cnf>
 *    -extensions v3_req`.
 * 5. Extract the `-----BEGIN CERTIFICATE REQUEST-----` block from
 *    stdout.
 * 6. Always remove both temp files in a `finally` — even on failure
 *    — to avoid leaking key material onto disk.
 *
 * Differences from rwiqha:
 *
 * - Uses `os.tmpdir()` instead of hardcoded `/tmp/`.
 * - Uses `crypto.randomUUID()` instead of the `uuid` package.
 * - Explicit `chmod 0o600` on the private-key file.
 * - Cleanup runs in `finally`, not inside both try/catch branches.
 * - All errors become `ZatcaOnboardingError`.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZatcaOnboardingError } from "../types/errors.js";
import { generateCSRTemplate } from "./csr-template.js";
import { ensureOpenssl } from "./openssl-probe.js";

/** Inputs the CSR generator pulls from the EGS unit profile. */
export interface CSRGenerationEgsInfo {
  custom_id: string;
  model: string;
  VAT_name: string;
  VAT_number: string;
  branch_name: string;
  branch_industry: string;
  location: {
    city: string;
    street: string;
    building: string;
  };
  /** EC private key PEM the CSR will be bound to. */
  private_key: string;
}

export interface CSRGenerationParams {
  egsInfo: CSRGenerationEgsInfo;
  /** `true` → production CSR template, `false` → sandbox / simulation. */
  production: boolean;
  /** Solution name (BSN of the e-invoicing provider). */
  solutionName: string;
}

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function executeOpenSSL(args: ReadonlyArray<string>): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("openssl", args);
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Best-effort filesystem cleanup. Logs nothing (the core package
 * is log-silent) and swallows errors — the caller cannot do
 * anything useful if `unlink` fails on a temp file that already
 * vanished.
 */
async function safeUnlink(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Intentionally ignored.
  }
}

/**
 * Generates a ZATCA-compliant CSR from an EGS unit profile.
 *
 * @returns PEM-encoded CSR starting with
 *          `-----BEGIN CERTIFICATE REQUEST-----`.
 *
 * @throws {ZatcaOnboardingError} when OpenSSL is unavailable, the
 *         EGS lacks a private key, or the `openssl req` command
 *         fails / produces no CSR.
 */
export async function generateCSR(params: CSRGenerationParams): Promise<string> {
  const { egsInfo, production, solutionName } = params;

  if (!egsInfo.private_key) {
    throw new ZatcaOnboardingError(
      "EGS unit has no private_key — generate one via generateSecp256k1KeyPair first.",
    );
  }

  await ensureOpenssl();

  const tempFolder = tmpdir();
  const privateKeyFile = join(tempFolder, `${randomUUID()}.pem`);
  const csrConfigFile = join(tempFolder, `${randomUUID()}.cnf`);

  const csrConfig = generateCSRTemplate({
    production,
    solution_name: solutionName,
    egs_model: egsInfo.model,
    egs_serial_number: egsInfo.custom_id,
    vat_number: egsInfo.VAT_number,
    branch_location: `${egsInfo.location.building} ${egsInfo.location.street}, ${egsInfo.location.city}`,
    branch_industry: egsInfo.branch_industry,
    branch_name: egsInfo.branch_name,
    taxpayer_name: egsInfo.VAT_name,
    taxpayer_provided_id: egsInfo.custom_id,
  });

  try {
    // Write the private key first, then chmod 0o600 so the file
    // never exists with permissive defaults.
    await fs.writeFile(privateKeyFile, egsInfo.private_key, { mode: 0o600 });
    await fs.chmod(privateKeyFile, 0o600);
    await fs.writeFile(csrConfigFile, csrConfig);

    const result = await executeOpenSSL([
      "req",
      "-new",
      "-sha256",
      "-key",
      privateKeyFile,
      "-config",
      csrConfigFile,
      "-extensions",
      "v3_req",
    ]);

    if (result.code !== 0) {
      throw new ZatcaOnboardingError(
        `openssl req exited with code ${result.code ?? "null"}: ${result.stderr.trim()}`,
      );
    }

    const marker = "-----BEGIN CERTIFICATE REQUEST-----";
    const idx = result.stdout.indexOf(marker);
    if (idx === -1) {
      throw new ZatcaOnboardingError("openssl req produced no CSR in its output.");
    }
    return result.stdout.slice(idx).trim();
  } catch (cause) {
    if (cause instanceof ZatcaOnboardingError) throw cause;
    throw new ZatcaOnboardingError("Failed to generate CSR via openssl.", cause);
  } finally {
    await Promise.all([safeUnlink(privateKeyFile), safeUnlink(csrConfigFile)]);
  }
}
