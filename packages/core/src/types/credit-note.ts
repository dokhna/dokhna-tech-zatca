/**
 * Credit-note input types — re-exported from `./invoice.ts` so users
 * who only care about credit notes get a tight, focused import.
 *
 * Credit notes amend or refund a previously issued invoice. They
 * carry a mandatory `cancelation` block (validated in `schemas.ts`)
 * referencing the original document.
 */

import type {
  Phase1CreditNoteInput,
  SimplifiedCreditNoteInput,
  StandardCreditNoteInput,
} from "./invoice.js";

export type { Phase1CreditNoteInput, SimplifiedCreditNoteInput, StandardCreditNoteInput };

/**
 * Discriminated union of every credit-note variant accepted by the
 * package — Phase 2 simplified, Phase 2 standard, and Phase 1
 * (QR-only).
 */
export type CreditNoteInput =
  | SimplifiedCreditNoteInput
  | StandardCreditNoteInput
  | Phase1CreditNoteInput;
