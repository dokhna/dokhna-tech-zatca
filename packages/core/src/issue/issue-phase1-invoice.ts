/**
 * Public issuer for Phase 1 (QR-only) tax invoices.
 *
 * Same storage handshake as the Phase 2 issuers but returns a
 * narrower {@link IssuedPhase1Invoice} (no signed XML, no invoice
 * hash). Phase 1 invoices do not participate in the SHA-256 hash
 * chain — `storage.getPreviousHash` is therefore not consulted.
 */

import type { Base64 } from "../types/branded.js";
import type { EGSUnitInfo } from "../types/egs.js";
import type { Phase1InvoiceInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import { ZatcaValidationError } from "../types/errors.js";
import { Phase1InvoiceBuilder } from "../invoices/phase1-invoice.js";

/**
 * Result returned by Phase 1 issuers.
 */
export interface IssuedPhase1Invoice {
  invoiceXml: string;
  qrCode: Base64;
  sequence: number;
  invoiceNumber: string;
}

export interface IssuePhase1InvoiceArgs {
  input: Omit<
    Phase1InvoiceInput,
    | "egsInfo"
    | "invoiceCounterNumber"
    | "invoiceSerialNumber"
    | "previousInvoiceHash"
  >;
  egsInfo: EGSUnitInfo;
  storage: StorageAdapter;
  scope: TenantScope;
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
 * Builds a Phase 1 (QR-only) tax invoice and bumps the storage
 * counter. The all-zero base PIH is supplied for compatibility with
 * downstream code; Phase 1 invoices ignore the hash chain.
 */
export async function issuePhase1Invoice(
  args: IssuePhase1InvoiceArgs,
): Promise<IssuedPhase1Invoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(
    args.scope,
  );

  const BASE_PIH =
    "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

  const fullInput: Phase1InvoiceInput = {
    ...args.input,
    kind: "phase1-invoice",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    // Phase 1 does not chain hashes — the value is irrelevant but the
    // type system requires a placeholder. Use the spec-mandated all-
    // zero base PIH so downstream consumers see a deterministic value.
    previousInvoiceHash:
      BASE_PIH as unknown as Phase1InvoiceInput["previousInvoiceHash"],
  };
  const built = new Phase1InvoiceBuilder(fullInput).build();
  return {
    invoiceXml: built.invoiceXml,
    qrCode: built.qrCode,
    sequence,
    invoiceNumber,
  };
}
