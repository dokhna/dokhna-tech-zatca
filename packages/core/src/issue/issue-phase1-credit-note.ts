/**
 * Public issuer for Phase 1 (QR-only) credit notes.
 */

import type { EGSUnitInfo } from "../types/egs.js";
import type { Phase1CreditNoteInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import { ZatcaValidationError } from "../types/errors.js";
import { Phase1CreditNoteBuilder } from "../invoices/phase1-credit-note.js";
import type { IssuedPhase1Invoice } from "./issue-phase1-invoice.js";

export interface IssuePhase1CreditNoteArgs {
  input: Omit<
    Phase1CreditNoteInput,
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

export async function issuePhase1CreditNote(
  args: IssuePhase1CreditNoteArgs,
): Promise<IssuedPhase1Invoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(
    args.scope,
  );

  const BASE_PIH =
    "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==";

  const fullInput: Phase1CreditNoteInput = {
    ...args.input,
    kind: "phase1-credit-note",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    previousInvoiceHash:
      BASE_PIH as unknown as Phase1CreditNoteInput["previousInvoiceHash"],
  };
  const built = new Phase1CreditNoteBuilder(fullInput).build();
  return {
    invoiceXml: built.invoiceXml,
    qrCode: built.qrCode,
    sequence,
    invoiceNumber,
  };
}
