/**
 * secp256k1 EC key-pair generation via OpenSSL CLI.
 *
 * ZATCA mandates the secp256k1 curve for CSRs (ZATCA E-Invoicing
 * Implementation Standards §2.2.1). Node's `crypto.generateKeyPair`
 * supports `secp256k1` in modern releases, but the *output PEM
 * exactly matches* what OpenSSL produces only when shelling out to
 * the CLI — and the ZATCA validator was historically picky about
 * the EC key encoding. The legacy helper shells out, and we
 * preserve that to keep parity until v2.
 *
 * Command equivalent:
 *
 * ```sh
 * openssl ecparam -name secp256k1 -genkey -noout
 * ```
 *
 * (We pass `-genkey` but omit `-noout` since we capture stdout
 * directly — `-noout` would suppress the PEM output.)
 */

import { spawn } from "node:child_process";
import { ZatcaOnboardingError } from "../types/errors.js";
import { ensureOpenssl } from "./openssl-probe.js";

interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn `openssl` with the given args and capture stdout / stderr.
 *
 * Rejects on `ENOENT` (binary missing) and any other spawn error.
 * Resolves with `{ code, stdout, stderr }` on close — the caller
 * inspects the exit code.
 */
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
 * Generates a fresh secp256k1 EC private key as a PEM string.
 *
 * @returns PEM-encoded private key starting with
 *          `-----BEGIN EC PRIVATE KEY-----`.
 *
 * @throws {ZatcaOnboardingError} when OpenSSL is unavailable or the
 *         command fails / produces no key.
 */
export async function generateSecp256k1KeyPair(): Promise<string> {
  await ensureOpenssl();

  let result: SpawnResult;
  try {
    result = await executeOpenSSL(["ecparam", "-name", "secp256k1", "-genkey"]);
  } catch (cause) {
    throw new ZatcaOnboardingError("Failed to invoke openssl for EC key generation.", cause);
  }

  if (result.code !== 0) {
    throw new ZatcaOnboardingError(
      `openssl ecparam exited with code ${result.code ?? "null"}: ${result.stderr.trim()}`,
    );
  }

  const marker = "-----BEGIN EC PRIVATE KEY-----";
  const idx = result.stdout.indexOf(marker);
  if (idx === -1) {
    throw new ZatcaOnboardingError("openssl ecparam produced no EC private key in its output.");
  }
  return result.stdout.slice(idx).trim();
}
