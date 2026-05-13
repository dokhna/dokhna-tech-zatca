/**
 * Public issuer for simplified Phase 2 debit notes.
 */

import type { EGSUnitInfo } from "../types/egs.js";
import type { SimplifiedDebitNoteInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import { ZatcaValidationError } from "../types/errors.js";
import { SimplifiedDebitNoteBuilder } from "../invoices/simplified-debit-note.js";
import type { IssuedInvoice } from "./issue-simplified-invoice.js";

export interface IssueSimplifiedDebitNoteArgs {
  input: Omit<
    SimplifiedDebitNoteInput,
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

export async function issueSimplifiedDebitNote(
  args: IssueSimplifiedDebitNoteArgs,
): Promise<IssuedInvoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(
    args.scope,
  );
  const previousInvoiceHash = await args.storage.getPreviousHash(
    args.scope,
    "simplified-debit-note",
  );
  const fullInput: SimplifiedDebitNoteInput = {
    ...args.input,
    kind: "simplified-debit-note",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    previousInvoiceHash,
  };
  const built = new SimplifiedDebitNoteBuilder(fullInput).build({
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
