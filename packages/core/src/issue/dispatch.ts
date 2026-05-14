/**
 * Discriminated-union dispatcher.
 *
 * Routes an opaque {@link InvoiceInput} to the correct per-variant
 * issuer. The switch is exhaustive: adding a new `kind` to the union
 * forces the `default` branch's `assertNever` call to flag a type
 * error, prompting the developer to register a new issuer here.
 *
 * `signing` is required for every Phase 2 kind; Phase 1 variants
 * ignore it. Callers passing a Phase 1 input may omit it.
 */

import type { EGSUnitInfo } from "../types/egs.js";
import { ZatcaValidationError } from "../types/errors.js";
import type { InvoiceInput } from "../types/invoice.js";
import type { StorageAdapter, TenantScope } from "../types/storage.js";
import { issuePhase1CreditNote } from "./issue-phase1-credit-note.js";
import { type IssuedPhase1Invoice, issuePhase1Invoice } from "./issue-phase1-invoice.js";
import { issueSimplifiedCreditNote } from "./issue-simplified-credit-note.js";
import { issueSimplifiedDebitNote } from "./issue-simplified-debit-note.js";
import { type IssuedInvoice, issueSimplifiedTaxInvoice } from "./issue-simplified-invoice.js";
import { issueStandardCreditNote } from "./issue-standard-credit-note.js";
import { issueStandardDebitNote } from "./issue-standard-debit-note.js";
import { issueStandardTaxInvoice } from "./issue-standard-invoice.js";

/**
 * Inputs to {@link issueInvoice}.
 *
 * The `input` field is the full {@link InvoiceInput} including
 * placeholder `invoiceCounterNumber` / `invoiceSerialNumber` /
 * `previousInvoiceHash` fields — those are overwritten by the
 * downstream issuer's storage handshake.
 */
export interface IssueInvoiceArgs {
  input: InvoiceInput;
  storage: StorageAdapter;
  scope: TenantScope;
  signing?: { certificate: string; privateKey: string };
}

/**
 * Compiler-side exhaustiveness sentinel. Any unhandled `kind` in
 * {@link issueInvoice} causes this call to flag a type error.
 */
function assertNever(value: never): never {
  throw new ZatcaValidationError(`Unhandled invoice kind: ${JSON.stringify(value)}`);
}

/**
 * Routes one validated {@link InvoiceInput} to the correct issuer.
 *
 * Returns either {@link IssuedInvoice} (Phase 2) or
 * {@link IssuedPhase1Invoice} (Phase 1) — callers can narrow on the
 * presence of `signedXml` / `invoiceHash`.
 */
export async function issueInvoice(
  args: IssueInvoiceArgs,
): Promise<IssuedInvoice | IssuedPhase1Invoice> {
  const requireSigning = (): { certificate: string; privateKey: string } => {
    if (args.signing === undefined) {
      throw new ZatcaValidationError(
        `Phase 2 invoice kind "${args.input.kind}" requires signing.certificate + signing.privateKey.`,
      );
    }
    return args.signing;
  };

  const baseShared = {
    storage: args.storage,
    scope: args.scope,
    egsInfo: args.input.egsInfo,
  };

  // Discard the storage-managed fields from the input — the per-kind
  // issuer re-populates them after the storage handshake.
  const stripStorageFields = <
    T extends {
      invoiceCounterNumber?: number;
      invoiceSerialNumber?: string;
      previousInvoiceHash?: unknown;
      egsInfo?: EGSUnitInfo;
    },
  >(
    input: T,
  ): Omit<
    T,
    "invoiceCounterNumber" | "invoiceSerialNumber" | "previousInvoiceHash" | "egsInfo"
  > => {
    const {
      invoiceCounterNumber: _ic,
      invoiceSerialNumber: _is,
      previousInvoiceHash: _pih,
      egsInfo: _eg,
      ...rest
    } = input;
    return rest;
  };

  switch (args.input.kind) {
    case "simplified-tax-invoice":
      return issueSimplifiedTaxInvoice({
        ...baseShared,
        input: stripStorageFields(args.input),
        signing: requireSigning(),
      });
    case "standard-tax-invoice":
      return issueStandardTaxInvoice({
        ...baseShared,
        input: stripStorageFields(args.input),
        signing: requireSigning(),
      });
    case "simplified-credit-note":
      return issueSimplifiedCreditNote({
        ...baseShared,
        input: stripStorageFields(args.input),
        signing: requireSigning(),
      });
    case "standard-credit-note":
      return issueStandardCreditNote({
        ...baseShared,
        input: stripStorageFields(args.input),
        signing: requireSigning(),
      });
    case "simplified-debit-note":
      return issueSimplifiedDebitNote({
        ...baseShared,
        input: stripStorageFields(args.input),
        signing: requireSigning(),
      });
    case "standard-debit-note":
      return issueStandardDebitNote({
        ...baseShared,
        input: stripStorageFields(args.input),
        signing: requireSigning(),
      });
    case "phase1-invoice":
      return issuePhase1Invoice({
        ...baseShared,
        input: stripStorageFields(args.input),
      });
    case "phase1-credit-note":
      return issuePhase1CreditNote({
        ...baseShared,
        input: stripStorageFields(args.input),
      });
    default:
      return assertNever(args.input);
  }
}
