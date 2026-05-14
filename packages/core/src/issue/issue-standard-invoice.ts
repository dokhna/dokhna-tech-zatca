/**
 * Public issuer for standard Phase 2 tax invoices.
 *
 * Same shape as {@link issueSimplifiedTaxInvoice}. Differs only in
 * which builder runs and the storage `invoiceKind` argument.
 */

import { randomUUID } from "node:crypto";
import { StandardTaxInvoiceBuilder } from "../invoices/standard-tax-invoice.js";
import type { EGSUnitInfo } from "../types/egs.js";
import { ZatcaValidationError } from "../types/errors.js";
import type { StandardTaxInvoiceInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import type { IssuedInvoice } from "./issue-simplified-invoice.js";

export interface IssueStandardTaxInvoiceArgs {
  input: Omit<
    StandardTaxInvoiceInput,
    "egsInfo" | "invoiceCounterNumber" | "invoiceSerialNumber" | "previousInvoiceHash"
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

export async function issueStandardTaxInvoice(
  args: IssueStandardTaxInvoiceArgs,
): Promise<IssuedInvoice> {
  assertScope(args.egsInfo, args.scope);
  const { sequence, invoiceNumber } = await args.storage.incrementCounter(args.scope);
  const previousInvoiceHash = await args.storage.getPreviousHash(
    args.scope,
    "standard-tax-invoice",
  );
  const fullInput: StandardTaxInvoiceInput = {
    ...args.input,
    kind: "standard-tax-invoice",
    egsInfo: args.egsInfo,
    invoiceCounterNumber: sequence,
    invoiceSerialNumber: invoiceNumber,
    previousInvoiceHash,
  };
  const built = new StandardTaxInvoiceBuilder(fullInput).build({
    signingCertificatePem: args.signing.certificate,
    signingPrivateKeyPem: args.signing.privateKey,
  });

  const invoiceId = args.invoiceId ?? randomUUID();
  const now = args.now ?? (() => new Date());
  await args.storage.recordInvoice(args.scope, {
    invoiceId,
    kind: "standard-tax-invoice",
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
