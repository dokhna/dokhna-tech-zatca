/**
 * Public issuer for Phase 1 (QR-only) tax invoices.
 *
 * Same storage handshake as the Phase 2 issuers but returns a
 * narrower {@link IssuedPhase1Invoice} (no signed XML, no invoice
 * hash). Phase 1 invoices do not participate in the SHA-256 hash
 * chain — `storage.getPreviousHash` is therefore not consulted.
 */

import { randomUUID } from "node:crypto";
import { Phase1InvoiceBuilder } from "../invoices/phase1-invoice.js";
import type { Base64, InvoiceHash } from "../types/branded.js";
import type { EGSUnitInfo } from "../types/egs.js";
import { ZatcaValidationError } from "../types/errors.js";
import type { Phase1InvoiceInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";

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
    "egsInfo" | "invoiceCounterNumber" | "invoiceSerialNumber" | "previousInvoiceHash"
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
 * Builds a Phase 1 (QR-only) tax invoice and bumps the storage
 * counter. The all-zero base PIH is supplied for compatibility with
 * downstream code; Phase 1 invoices ignore the hash chain. The
 * resulting record is persisted via `storage.recordInvoice` with the
 * unsigned XML in both `signedXml` (only field available for Phase 1)
 * and `invoiceHash` set to the base PIH (no chain participation).
 */
export async function issuePhase1Invoice(
  args: IssuePhase1InvoiceArgs,
): Promise<IssuedPhase1Invoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(args.scope);

  const BASE_PIH =
    "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

  const fullInput: Phase1InvoiceInput = {
    ...args.input,
    kind: "phase1-invoice",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    // Phase 1 does not chain hashes — the value is irrelevant but the
    // type system requires a placeholder. Use the spec-mandated all-
    // zero base PIH so downstream consumers see a deterministic value.
    previousInvoiceHash: BASE_PIH,
  };
  const built = new Phase1InvoiceBuilder(fullInput).build();

  const invoiceId = args.invoiceId ?? randomUUID();
  const now = args.now ?? (() => new Date());
  await args.storage.recordInvoice(args.scope, {
    invoiceId,
    kind: "phase1-invoice",
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
