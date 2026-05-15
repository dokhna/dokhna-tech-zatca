/**
 * ZATCA gateway base URLs and endpoint paths for sandbox /
 * simulation / production environments.
 *
 * The legacy helper hard-codes two base URLs:
 *   - `https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation` (used
 *     for both pre-prod sandbox and ZATCA's simulation onboarding flow)
 *   - `https://gw-fatoora.zatca.gov.sa/e-invoicing/core` (production)
 *
 * The open-source surface keeps a richer three-environment vocabulary
 * because ZATCA distinguishes them in their developer portal:
 *
 *   - **sandbox** — the "developer-portal" gateway, used during onboarding
 *     test runs and the compliance test pack.
 *   - **simulation** — the "simulation" gateway, mirrored on the same
 *     infrastructure as sandbox; the legacy helper aliases this to the simulation
 *     base URL.
 *   - **production** — the "core" gateway for live invoicing.
 *
 * Paths are the same across all three environments — only the base
 * differs. Both `clearance` and `reporting` accept the single-invoice
 * submission body; the caller chooses one based on the invoice type
 * (standard → clearance, simplified → reporting).
 */

import type { ZatcaEnvironment } from "../types/api.js";

/**
 * Endpoint group for a single ZATCA environment.
 */
export interface ZatcaEnvironmentEndpoints {
  /** Base URL — no trailing slash. */
  readonly base: string;
  /** Compliance check (returns validation envelope only). */
  readonly compliance: string;
  /** Single-invoice clearance (standard invoices). */
  readonly clearance: string;
  /** Single-invoice reporting (simplified invoices). */
  readonly reporting: string;
  /** Compliance certificate issuance (CSR + OTP → compliance CSID). */
  readonly complianceCertificate: string;
  /** Production CSID issuance (compliance creds → production CSID). */
  readonly csids: string;
  /** Invoice cancellation. */
  readonly cancelInvoice: string;
  /** Invoice status lookup. */
  readonly invoiceStatus: string;
}

/**
 * The full ZATCA endpoint matrix, keyed by environment name.
 *
 * Sandbox and simulation share the same upstream gateway prefix in
 * the legacy helper; we keep them as separate entries so callers can document
 * intent (and so we can repoint either independently if ZATCA splits
 * them later).
 */
export const ZATCA_ENDPOINTS: Readonly<Record<ZatcaEnvironment, ZatcaEnvironmentEndpoints>> = {
  sandbox: {
    base: "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal",
    compliance: "/compliance/invoices",
    clearance: "/invoices/clearance/single",
    reporting: "/invoices/reporting/single",
    complianceCertificate: "/compliance",
    csids: "/production/csids",
    cancelInvoice: "/invoices/cancel",
    invoiceStatus: "/invoices/status",
  },
  simulation: {
    base: "https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation",
    compliance: "/compliance/invoices",
    clearance: "/invoices/clearance/single",
    reporting: "/invoices/reporting/single",
    complianceCertificate: "/compliance",
    csids: "/production/csids",
    cancelInvoice: "/invoices/cancel",
    invoiceStatus: "/invoices/status",
  },
  production: {
    base: "https://gw-fatoora.zatca.gov.sa/e-invoicing/core",
    compliance: "/compliance/invoices",
    clearance: "/invoices/clearance/single",
    reporting: "/invoices/reporting/single",
    complianceCertificate: "/compliance",
    csids: "/production/csids",
    cancelInvoice: "/invoices/cancel",
    invoiceStatus: "/invoices/status",
  },
} as const;

/**
 * Resolve the endpoint group for a ZATCA environment.
 *
 * Throws if the environment name is not one of the three known values
 * (defensive — `ZatcaEnvironment` is a literal union, so this is a
 * runtime guard against any unchecked casts at the boundary).
 */
export function getZatcaEndpoints(environment: ZatcaEnvironment): ZatcaEnvironmentEndpoints {
  const group = ZATCA_ENDPOINTS[environment];
  if (!group) {
    throw new Error(`Unknown ZATCA environment: ${environment}`);
  }
  return group;
}

/**
 * Default ZATCA API version header value. ZATCA pins clients to V2 in
 * the Phase 2 sandbox and production gateways.
 */
export const ZATCA_API_VERSION = "V2";
