/**
 * Public issuer for standard Phase 2 debit notes.
 */

import { randomUUID } from "node:crypto";
import type { EGSUnitInfo } from "../types/egs.js";
import type { StandardDebitNoteInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import { ZatcaValidationError } from "../types/errors.js";
import { StandardDebitNoteBuilder } from "../invoices/standard-debit-note.js";
import type { IssuedInvoice } from "./issue-simplified-invoice.js";

export interface IssueStandardDebitNoteArgs {
  input: Omit<
    StandardDebitNoteInput,
    | "egsInfo"
    | "invoiceCounterNumber"
    | "invoiceSerialNumber"
    | "previousInvoiceHash"
  >;
  egsInfo: EGSUnitInfo;
  storage: StorageAdapter;
  scope: TenantScope;
  signing: { certificate: string; privateKey: string };
  /** Caller-chosen primary key for the persisted record; defaults to `randomUUID()`. */
  invoiceId?: string;
  /** Override the issuance clock (defaults to `new Date()`). */
  now?: () => Date;
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

export async function issueStandardDebitNote(
  args: IssueStandardDebitNoteArgs,
): Promise<IssuedInvoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(
    args.scope,
  );
  const previousInvoiceHash = await args.storage.getPreviousHash(
    args.scope,
    "standard-debit-note",
  );
  const fullInput: StandardDebitNoteInput = {
    ...args.input,
    kind: "standard-debit-note",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    previousInvoiceHash,
  };
  const built = new StandardDebitNoteBuilder(fullInput).build({
    signingCertificatePem: args.signing.certificate,
    signingPrivateKeyPem: args.signing.privateKey,
  });

  const invoiceId = args.invoiceId ?? randomUUID();
  const now = args.now ?? (() => new Date());
  await args.storage.recordInvoice(args.scope, {
    invoiceId,
    kind: "standard-debit-note",
    serial: invoiceNumber,
    counterNumber: sequence,
    uuid: args.egsInfo.uuid,
    invoiceHash: built.invoiceHash,
    previousInvoiceHash,
    signedXml: built.signedXml,
    qrBase64: built.qrCode,
    issuedAt: now(),
    status: "pending",
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
