# Onboarding

To issue Phase 2 invoices, an EGS unit must be onboarded with ZATCA:

1. Generate an ECDSA-secp256k1 key pair.
2. Generate a CSR (Certificate Signing Request) bound to that key, embedding EGS metadata.
3. Exchange the CSR + Fatoora-portal OTP for a **compliance certificate** + API secret.
4. Issue and submit six required compliance test invoices (the spec calls these "compliance scenarios").
5. Exchange the compliance credentials for the **production CSID** (production certificate + API secret).

The `onboard()` function does all five in one call.

## One-shot onboarding

```ts
import {
  onboard,
  asVATNumber,
  asCommercialRegistrationNumber,
  asEGSUuid,
} from "@dokhna-tech/zatca";
import { randomUUID } from "node:crypto";

const result = await onboard({
  egsInfo: {
    uuid: asEGSUuid(randomUUID()),
    customId: "branch-01-pos-03",
    model: "Acme POS v2",
    crnNumber: asCommercialRegistrationNumber("1010010101"),
    vatName: "Acme Trading Co.",
    vatNumber: asVATNumber("301234567890003"),
    branchName: "Riyadh HQ",
    branchIndustry: "Retail",
    location: {
      cityName: "Riyadh",
      citySubdivision: "Olaya",
      street: "King Fahd Road",
      plotIdentification: "1234",
      building: "5678",
      postalZone: "12345",
    },
  },
  otp: "123456", // burns on use
  environment: "simulation", // "sandbox" | "simulation" | "production"
  solutionName: "MyBilling SaaS v1.0",
});
```

Returns:

```ts
interface OnboardingResult {
  privateKey: string;                       // PEM. SECRET.
  csr: string;                              // PEM. Audit trail.
  complianceCertificate: string;            // PEM.
  complianceBinarySecurityToken: string;    // Base64 raw cert.
  complianceApiSecret: string;              // SECRET.
  complianceRequestId: string;              // ZATCA-issued reference.
  productionCertificate: string;            // PEM.
  productionBinarySecurityToken: string;    // Base64 raw cert.
  productionApiSecret: string;              // SECRET.
  productionRequestId: string;              // ZATCA-issued reference.
  complianceTestReport: ComplianceTestReport;
}
```

## Choosing an environment

`onboard()` accepts `sandbox`, `simulation`, or `production`. The same six-step flow runs against all three — only the gateway and the CSR certificate profile change:

| `environment` | Gateway (`core`/`simulation`/`developer-portal`) | CSR profile | OTP source | Use it for |
|---|---|---|---|---|
| `sandbox` | developer-portal | `PREZATCA-Code-Signing` | fixed dev OTP (`123456`) | local dev against the sandbox |
| `simulation` | simulation | `PREZATCA-Code-Signing` | simulation Fatoora portal | pre-production rehearsal with real CSIDs + strict validation |
| `production` | core | `ZATCA-Code-Signing` | **production** Fatoora portal | go-live: issue the production CSID your live invoices are signed with |

The compliance scenarios are a **required step of CSID issuance on every environment, including production** — ZATCA validates the six sample documents on the core gateway before issuing the production CSID. (Verified end-to-end against the live core gateway: all six scenarios pass and a production CSID is returned.)

## Going live (production)

To onboard a real EGS for live invoicing, generate an OTP in the **production** Fatoora portal and call `onboard()` with `environment: "production"`:

```ts
const result = await onboard({
  egsInfo,                       // OnboardingEgsInfo — must match the VAT's ZATCA registration
  otp: "601436",                 // 6-digit OTP from the PRODUCTION Fatoora portal — single-use, ~1h TTL
  environment: "production",
  solutionName: "MyBilling SaaS v1.0",
});
// Persist result.privateKey, result.productionCertificate,
// result.productionApiSecret, result.productionBinarySecurityToken
// (all SECRET) — these sign and authenticate your live invoices.
```

What happens under the hood (identical to the numbered steps above, but against the `core` gateway with the `ZATCA-Code-Signing` CSR profile):

1. Generate the secp256k1 keypair + production CSR.
2. `issueComplianceCertificate` — exchange CSR + production OTP for the compliance certificate (**this is the call that consumes the OTP**).
3. `runComplianceTests` — submit the six compliance scenarios to the core gateway.
4. `issueCSIDS` — exchange the passing compliance credentials for the **production CSID**.

Operational notes:

- The OTP is **single-use** and short-lived. Generate the key + CSR first (cheap, offline); only step 2 touches the OTP, so a misconfiguration fails before burning it.
- Each successful `onboard()` registers a **new EGS unit** (fresh `uuid`) with ZATCA. Use one EGS per physical/logical billing endpoint.
- `egsInfo` must reflect the VAT's real ZATCA registration (legal name, CRN, address). Mismatches surface as ZATCA validation warnings/errors on the compliance documents.
- After onboarding, set `ZATCA_ENVIRONMENT=production` for the reporting/clearance calls that submit your live invoices.

## What you must persist

| Field | Sensitivity | Where it goes |
|-------|-------------|---------------|
| `privateKey` | **SECRET** | Encrypted at rest (KMS, Secrets Manager, HSM). |
| `complianceApiSecret` | **SECRET** | Encrypted at rest. |
| `productionApiSecret` | **SECRET** | Encrypted at rest. |
| `complianceCertificate` / `productionCertificate` | Public | Normal DB column. |
| `complianceBinarySecurityToken` / `productionBinarySecurityToken` | Tenant-identifying | Normal DB column with tenant-level ACLs. |
| `complianceTestReport` | Audit | Append-only audit log. |
| `csr` | Public | Optional audit log. |

See [security.md](./security.md) for a deeper treatment.

## OpenSSL CLI is required

The CSR is generated by shelling out to `openssl` once. `onboard()` calls `ensureOpenssl()` first and throws `ZatcaOnboardingError` with a clear message if the binary is missing. Lambda users and `node:alpine` users need to install OpenSSL — see [troubleshooting.md](./troubleshooting.md#openssl-not-found).

## The `args.crypto` injection is for tests only

`onboard()` accepts an `args.crypto` field with `generateKeyPair`, `generateCSR`, and `skipOpensslProbe`. **This is exclusively for unit tests** that need deterministic fixtures. Production code MUST leave `args.crypto` undefined so the real OpenSSL-CLI helpers run.

## Renewal

ZATCA certificates have a finite validity window. To renew an EGS:

1. Call `onboard()` again with a fresh OTP and the same `egsInfo`. Note that this generates a NEW private key and a NEW `egsInfo.uuid` is recommended.
2. Persist the new bundle.
3. Switch traffic to the new bundle on a planned cutover.
4. Retire the old bundle after the audit retention window expires.

`getCertificateExpirationDate(pem)` returns the certificate's `Not After` date — run it on a cron to schedule renewals 30 days ahead.

## Driving the steps individually

If you need to interleave onboarding with your own workflow (e.g. handing the CSR to a human for review before submission), call the lower-level functions directly:

```ts
import {
  generateSecp256k1KeyPair,
  generateCSR,
  issueComplianceCertificate,
  runComplianceTests,
  issueCSIDS,
} from "@dokhna-tech/zatca";

const privateKey = await generateSecp256k1KeyPair();
const csr = await generateCSR({ /* ... */ });
const compliance = await issueComplianceCertificate({ csr, otp, environment, /* ... */ });
const report = await runComplianceTests({ /* ... */ });
if (report.overallStatus === "failed") throw new Error("compliance failed");
const production = await issueCSIDS({ /* ... */ });
```

`onboard()` is just the wrapper that wires those together with sensible error mapping.

## What it does NOT do

- It does not write to disk. The caller persists.
- It does not log. The caller decides what (if anything) to record.
- It does not retry past the default HTTP-client retry policy. Override via `args.httpClientOptions.retries`.
- It does not validate the OTP server-side before generating the keypair. ZATCA does that; we let the error propagate as `ZatcaApiError`.
