# Security

`@dokhna-tech/zatca` is a cryptographic boundary library — it generates ECDSA keys, signs documents, and brokers credentials with the ZATCA gateway. This page enumerates the secret material, the storage / rotation guidance, and the package's own zero-logging policy.

## Threat model

Three categories of compromise the library is designed against:

1. **Accidental disclosure via logging** — the package emits no logs at any level. The only optional output is the `debug` channel on the storage adapters, which logs counters and hash heads but never secret material.
2. **Cross-tenant leakage in multi-tenant deployments** — the package never reads secrets from a global; every signing call takes the key and certificate as an explicit argument. Per-tenant isolation is the host's responsibility, but the structure is enforced.
3. **OpenSSL CLI substitution** — the CSR generation is the only step that shells out. The probe ensures the binary is present on `PATH`; running with a malicious `openssl` on `PATH` is out of scope.

Out of scope:

- Protection against a compromised host. If the host process is rooted, the in-memory private key is exposed.
- Side-channel attacks on the OpenSSL CLI invocation.
- Replay protection at the network layer (TLS does that).

## Secret classification

`OnboardingResult` is the most concentrated bundle of secret material in the package. Treat it as follows:

| Field | Sensitivity | Storage requirement |
|-------|-------------|---------------------|
| `privateKey` | **SECRET** | Encrypted at rest (KMS, HSM, Secrets Manager). NEVER log. |
| `complianceApiSecret` | **SECRET** | Encrypted at rest. |
| `productionApiSecret` | **SECRET** | Encrypted at rest. |
| `csr` | Public | Optional audit log. |
| `complianceCertificate` | Public | Normal DB column. |
| `productionCertificate` | Public | Normal DB column. |
| `complianceBinarySecurityToken` | Tenant-identifying, not cryptographically secret | Normal DB column, tenant-level ACL. |
| `productionBinarySecurityToken` | Tenant-identifying, not cryptographically secret | Normal DB column, tenant-level ACL. |
| `complianceRequestId` / `productionRequestId` | Audit | Audit log. |
| `complianceTestReport` | Audit | Append-only audit log. |

The two `binarySecurityToken` values are the base64-stripped PEM body that ZATCA's gateway accepts as authentication material. They are not secret in the cryptographic sense — anyone with the certificate has them — but they do identify the tenant, so leakage is a regulatory exposure, not a cryptographic one. Apply your standard tenant-data ACLs.

## Persistence patterns

### Pattern A: Cloud KMS envelope encryption

Recommended for cloud deployments.

1. Generate or fetch a Customer Master Key (CMK) in AWS KMS / GCP KMS / Azure Key Vault.
2. On `onboard()` completion:
   - Request a data key (`GenerateDataKey`); store the encrypted data key + ciphertext blob in the tenants table.
   - Use the plaintext data key to AES-256-GCM-encrypt the `privateKey`, `complianceApiSecret`, `productionApiSecret` values.
   - Zero the plaintext data key in memory.
3. On a signing call:
   - Decrypt the encrypted data key with KMS (`Decrypt`).
   - Decrypt the secret values.
   - Pass them to `issueSimplifiedTaxInvoice` (or peer).
   - Zero them in memory after use.

A short-lived (e.g. 60s) in-memory cache of decrypted values is acceptable and avoids per-request KMS round-trips. Tune the TTL against your audit requirements.

### Pattern B: HSM-backed key handling

The library's signing API accepts the private key as a PEM string. If you have a hardware-backed key (e.g. AWS CloudHSM, Yubico), you have two choices:

1. **Decrypt-on-use**: Pull the PEM into memory from the HSM only for the duration of the signing call. The PEM never persists to disk.
2. **Sign-via-callback (future work)**: We're tracking a feature request to accept a `sign(data: Buffer) => Buffer` callback so the private key never leaves the HSM. Open an issue if this matters to you.

### Pattern C: Single-tenant, env-var simple

For a single-VAT deployment on a hardened host, putting the private key in an environment variable populated from a sealed file (or `systemd`'s `LoadCredential`) is acceptable. It is *not* defensible in a multi-tenant SaaS context.

## Rotation

ZATCA production CSIDs have a finite validity window (the exact period changes; query the certificate with `getCertificateExpirationDate(pem)`).

Recommended rotation schedule:

1. Run `getCertificateExpirationDate(productionCertificate)` on a daily cron.
2. When the certificate has < 30 days remaining, schedule a renewal.
3. Run `onboard()` again with a fresh OTP. A new private key is generated; the old key is NOT reused.
4. Persist the new bundle alongside the old. Promote on a planned cutover.
5. Retain the old bundle for the audit retention window (typically 6 years for ZATCA), then delete the encrypted material.

The package does not run this automation; do it in your scheduler.

## OpenSSL CLI dependency

The CSR generation step shells out to `openssl`. This is intentional — it uses well-audited, kernel-randomized key generation rather than reinventing it in JavaScript.

Security implications:

- The `openssl` binary on `PATH` is trusted to generate the key. If a host has a tampered `openssl`, an attacker can leak the private key. This is the same risk model as any container running a key-generating binary.
- The probe (`ensureOpenssl`) verifies the binary exists and is callable. It does NOT verify the binary's signature or integrity. If you need that, run the onboarding step in a hardened build environment.
- Once the key + CSR are generated, the OpenSSL binary is not invoked again. All subsequent signing happens in pure JavaScript via `xmldsigjs` and the WebCrypto-backed primitives in Node.

In tests, `args.crypto.skipOpensslProbe: true` + `args.crypto.generateKeyPair` + `args.crypto.generateCSR` let you avoid the binary entirely. **Production code must never set these fields.**

## Zero-logging policy

The package writes nothing to the console / stdout / stderr / files in the normal path. This is verified by a CI grep:

```bash
grep -RE "console\.(log|warn|error|info|debug)" packages/*/src
# expected: no matches
```

The only side-channel output is via the `debug` npm package, which is opt-in:

- Active only when `DEBUG='zatca:*'` is set in the environment.
- Restricted to the storage adapters (`zatca:storage:memory`, `zatca:storage:mongo`, `zatca:storage:postgres`).
- Logs counter operations, hash heads, and idempotency-collision events. **Does not log signed XML, certificates, private keys, or API secrets.**

If you need to log invoice-level information for your application, do it in your host code with the `IssuedInvoice` bundle in hand — and be careful not to log `signedXml` to a long-lived store (it embeds your certificate and is verbose).

## Reporting vulnerabilities

See [`SECURITY.md`](../SECURITY.md) at the repo root for the disclosure policy. Do not file public GitHub issues for vulnerabilities.
