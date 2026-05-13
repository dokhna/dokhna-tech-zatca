/**
 * Public issuer for simplified Phase 2 tax invoices.
 *
 * Orchestrates the storage handshake (`incrementCounter` +
 * `getPreviousHash`), invokes the Phase 3 builder, and returns the
 * full {@link IssuedInvoice} package. This module does NOT call
 * `storage.recordInvoice` — that decision is deferred to Phase 6's
 * higher-level orchestrator (or the direct caller) so this function
 * stays a pure "build a signed envelope" primitive.
 *
 * The function asserts that the supplied `egsInfo.uuid` matches
 * `scope.egsUuid` and that the EGS's VAT number matches
 * `scope.vatNumber`. Mismatches are programmer errors and surface as
 * {@link ZatcaValidationError}.
 */

import type { Base64, InvoiceHash } from "../types/branded.js";
import type { EGSUnitInfo } from "../types/egs.js";
import type { SimplifiedTaxInvoiceInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import { ZatcaValidationError } from "../types/errors.js";
import { SimplifiedTaxInvoiceBuilder } from "../invoices/simplified-tax-invoice.js";

/**
 * Result returned by every Phase 2 issuer function.
 *
 * Surfaces the storage-side fields (`sequence`, `invoiceNumber`)
 * alongside the cryptographic envelope (`invoiceXml`, `signedXml`,
 * `invoiceHash`, `qrCode`). The caller persists this record via its
 * own `storage.recordInvoice` invocation when ready.
 */
export interface IssuedInvoice {
  invoiceXml: string;
  signedXml: string;
  invoiceHash: InvoiceHash;
  qrCode: Base64;
  sequence: number;
  invoiceNumber: string;
}

/**
 * Inputs to {@link issueSimplifiedTaxInvoice}.
 *
 * The `input` field carries every business-level value (line items,
 * buyer name, issue date / time). The orchestrator overlays the
 * `invoiceCounterNumber`, `invoiceSerialNumber`, and
 * `previousInvoiceHash` fields after the storage handshake — callers
 * may pass placeholders for those three fields; they are ignored.
 */
export interface IssueSimplifiedTaxInvoiceArgs {
  input: Omit<
    SimplifiedTaxInvoiceInput,
    | "egsInfo"
    | "invoiceCounterNumber"
    | "invoiceSerialNumber"
    | "previousInvoiceHash"
  >;
  egsInfo: EGSUnitInfo;
  storage: StorageAdapter;
  scope: TenantScope;
  signing: { certificate: string; privateKey: string };
}

function assertScope(egsInfo: EGSUnitInfo, scope: TenantScope): void {
  if (egsInfo.uuid !== scope.egsUuid) {
    throw new ZatcaValidationError(
      `egsInfo.uuid (${egsInfo.uuid}) does not match scope.egsUuid (${scope.egsUuid}).`,
    );
  }
  if (egsInfo.vatNumber !== scope.vatNumber) {
    throw new ZatcaValidationError(
      `egsInfo.vatNumber (${egsInfo.vatNumber}) does not match scope.vatNumber (${scope.vatNumber}).`,
    );
  }
}

/**
 * Issues one simplified Phase 2 tax invoice.
 *
 * Steps:
 *
 * 1. Validate the (egsInfo, scope) consistency.
 * 2. Atomically increment the EGS counter via the storage adapter.
 * 3. Read the previous invoice hash from the storage adapter.
 * 4. Build the signed XML + Phase 2 QR via the builder.
 * 5. Return the {@link IssuedInvoice} package.
 */
export async function issueSimplifiedTaxInvoice(
  args: IssueSimplifiedTaxInvoiceArgs,
): Promise<IssuedInvoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(
    args.scope,
  );
  const previousInvoiceHash = await args.storage.getPreviousHash(
    args.scope,
    "simplified-tax-invoice",
  );

  const fullInput: SimplifiedTaxInvoiceInput = {
    ...args.input,
    kind: "simplified-tax-invoice",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    previousInvoiceHash,
  };

  const built = new SimplifiedTaxInvoiceBuilder(fullInput).build({
    signingCertificatePem: args.signing.certificate,
    signingPrivateKeyPem: args.signing.privateKey,
  });

  return {
    invoiceXml: built.invoiceXml,
    signedXml: built.signedXml,
    invoiceHash: built.invoiceHash,
    qrCode: built.qrCode,
    sequence,
    invoiceNumber,
  };
}
