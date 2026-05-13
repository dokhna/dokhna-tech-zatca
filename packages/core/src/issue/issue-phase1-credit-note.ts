/**
 * Public issuer for Phase 1 (QR-only) credit notes.
 *
 * Same storage handshake as the Phase 2 credit-note issuers but
 * returns a narrower {@link IssuedPhase1Invoice} (no signed XML, no
 * invoice hash). Phase 1 credit notes do not participate in the
 * SHA-256 hash chain — `storage.getPreviousHash` is therefore not
 * consulted.
 */

import { randomUUID } from "node:crypto";
import type { InvoiceHash } from "../types/branded.js";
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

/**
 * Builds a Phase 1 (QR-only) credit note and bumps the storage
 * counter. The all-zero base PIH is supplied for compatibility with
 * downstream code; Phase 1 documents ignore the hash chain. The
 * resulting record is persisted via `storage.recordInvoice` with the
 * unsigned XML in `signedXml` and `invoiceHash` set to the base PIH
 * (no chain participation).
 */
export async function issuePhase1CreditNote(
  args: IssuePhase1CreditNoteArgs,
): Promise<IssuedPhase1Invoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(
    args.scope,
  );

  const BASE_PIH =
    "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

  const fullInput: Phase1CreditNoteInput = {
    ...args.input,
    kind: "phase1-credit-note",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    previousInvoiceHash: BASE_PIH,
  };
  const built = new Phase1CreditNoteBuilder(fullInput).build();

  const invoiceId = args.invoiceId ?? randomUUID();
  const now = args.now ?? (() => new Date());
  await args.storage.recordInvoice(args.scope, {
    invoiceId,
    kind: "phase1-credit-note",
    serial: invoiceNumber,
    counterNumber: sequence,
    uuid: args.egsInfo.uuid,
    // Phase 1 has no signed XML or chained hash — surface the raw
    // invoice XML + base PIH so the record stays round-trippable.
    invoiceHash: BASE_PIH,
    previousInvoiceHash: BASE_PIH,
    signedXml: built.invoiceXml,
    qrBase64: built.qrCode,
    issuedAt: now(),
    status: "pending",
  });

  return {
    invoiceXml: built.invoiceXml,
    qrCode: built.qrCode,
    sequence,
    invoiceNumber,
  };
}
