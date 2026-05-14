/**
 * Debit-note input types — re-exported from `./invoice.ts` so users
 * who only care about debit notes get a tight, focused import.
 *
 * Debit notes record upward adjustments (additional charge on a
 * previously issued invoice). They carry a mandatory `cancelation`
 * block referencing the original document (validated in `schemas.ts`).
 */

import type { SimplifiedDebitNoteInput, StandardDebitNoteInput } from "./invoice.js";

export type { SimplifiedDebitNoteInput, StandardDebitNoteInput };

/**
 * Discriminated union of every debit-note variant accepted by the
 * package. There is no Phase 1 debit-note variant — Phase 1 only
 * defines invoice and credit-note flows.
 */
export type DebitNoteInput = SimplifiedDebitNoteInput | StandardDebitNoteInput;
