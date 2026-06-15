/**
 * Zod schemas mirroring every `InvoiceInput` variant.
 *
 * The schemas are the runtime authority — they enforce the same rules
 * the TypeScript types document (and several rules TypeScript can't
 * express, like "simplified summary invoice requires `buyerName`" or
 * "credit / debit notes require `cancelation`").
 *
 * Each schema exports an inferred TypeScript type alongside. The
 * intent is that a future contributor can not silently drift the
 * schema and the static type: `z.infer<typeof X>` is what the
 * validator produces, and adapting the static `InvoiceInput` union
 * remains a manual one-time port (Phase 1 spec).
 */

import { z } from "zod";

import type {
  Base64,
  CommercialRegistrationNumber,
  EGSUuid,
  InvoiceHash,
  VATNumber,
} from "../types/branded.js";

// ---------------------------------------------------------------------------
// Primitive schemas — mirror branded-type regexes
// ---------------------------------------------------------------------------

/**
 * Saudi VAT number: 15 digits, starts and ends with `3`.
 * Output is typed as the `VATNumber` brand via `transform`.
 */
export const vatNumberSchema = z
  .string()
  .regex(/^3\d{13}3$/, {
    message: "Invalid VAT number: expected 15 digits starting and ending with 3.",
  })
  .transform((s): VATNumber => s as VATNumber);

/** Saudi commercial registration number — 10 digits. */
export const crnSchema = z
  .string()
  .regex(/^\d{10}$/, {
    message: "Invalid commercial registration number: expected 10 digits.",
  })
  .transform((s): CommercialRegistrationNumber => s as CommercialRegistrationNumber);

/** UUID v4 (lowercase or uppercase). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const egsUuidSchema = z
  .string()
  .regex(UUID_V4_REGEX, { message: "Invalid EGS UUID: expected UUID v4." })
  .transform((s): EGSUuid => s as EGSUuid);

/** Base64 SHA-256 invoice hash — 44 chars, single `=` padding. */
export const invoiceHashSchema = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, {
    message: "Invalid invoice hash: expected 44 base64 characters ending with '='.",
  })
  .transform((s): InvoiceHash => s as InvoiceHash);

/** Generic base64 string. */
export const base64Schema = z
  .string()
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, {
    message: "Invalid base64 string.",
  })
  .transform((s): Base64 => s as Base64);

// ---------------------------------------------------------------------------
// EGS schemas
// ---------------------------------------------------------------------------

export const egsUnitLocationSchema = z.object({
  cityName: z.string().min(1),
  citySubdivision: z.string().min(1),
  street: z.string().min(1),
  plotIdentification: z.string().min(1),
  building: z.string().min(1),
  postalZone: z.string().regex(/^\d{5}$/, {
    message: "Invalid postal zone: expected 5 digits.",
  }),
});

export const egsCertificateSchema = z.object({
  privateKey: z.string().optional(),
  csr: z.string().optional(),
  complianceCertificate: z.string().optional(),
  complianceApiSecret: z.string().optional(),
  productionCertificate: z.string().optional(),
  productionApiSecret: z.string().optional(),
});

export const egsUnitInfoSchema = z.object({
  uuid: egsUuidSchema,
  customId: z.string().min(1),
  model: z.string().min(1),
  crnNumber: crnSchema,
  vatName: z.string().min(1),
  vatNumber: vatNumberSchema,
  branchName: z.string().min(1),
  branchIndustry: z.string().min(1),
  location: egsUnitLocationSchema,
  certificate: egsCertificateSchema.optional(),
});

// ---------------------------------------------------------------------------
// Line item schemas
// ---------------------------------------------------------------------------

export const lineItemTaxSchema = z.object({
  percentAmount: z.number().nonnegative(),
});

export const lineItemDiscountSchema = z.object({
  amount: z.number().nonnegative(),
  reason: z.string().min(1),
});

export const lineItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  quantity: z.number().positive(),
  taxExclusivePrice: z.number().nonnegative(),
  otherTaxes: z.array(lineItemTaxSchema).optional(),
  discounts: z.array(lineItemDiscountSchema).optional(),
  vatPercent: z.number().min(0).max(100),
});

// ---------------------------------------------------------------------------
// Cancelation schemas
// ---------------------------------------------------------------------------

export const paymentMethodSchema = z.enum(["10", "30", "42", "48"]);
export const invoiceTypeCodeSchema = z.enum(["388", "383", "381"]);

export const cancelationSchema = z.object({
  canceledInvoiceNumber: z.number().int().positive(),
  paymentMethod: paymentMethodSchema,
  cancelationType: invoiceTypeCodeSchema,
  reason: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Buyer party schema (used by standard invoices / notes)
// ---------------------------------------------------------------------------

export const partyAddressSchema = z.object({
  streetName: z.string().min(1),
  buildingNumber: z.string().min(1),
  plotIdentification: z.string().optional(),
  cityName: z.string().min(1),
  citySubdivision: z.string().optional(),
  postalZone: z.string().regex(/^\d{5}$/),
  countryCode: z.string().length(2),
});

export const partyIdentitySchemeSchema = z.enum([
  "CRN",
  "MOM",
  "MLS",
  "700",
  "SAG",
  "NAT",
  "GCC",
  "IQA",
  "PAS",
  "OTH",
]);

export const buyerInfoSchema = z.object({
  vatNumber: vatNumberSchema.optional(),
  registrationName: z.string().min(1),
  address: partyAddressSchema.optional(),
  identityScheme: partyIdentitySchemeSchema,
  identityNumber: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Invoice-input variants — discriminated union on `kind`
// ---------------------------------------------------------------------------

const issueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
  message: "Invalid issueDate: expected YYYY-MM-DD.",
});

// Accept a bare wall-clock time (`HH:mm:ss`) or one already carrying the
// UTC `Z`, and normalize to `HH:mm:ssZ`. The trailing `Z` is required so the
// XML `<cbc:IssueTime>` matches the QR timestamp and the XAdES SigningTime.
const issueTimeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}:\d{2}Z?$/, {
    message: "Invalid issueTime: expected HH:mm:ss or HH:mm:ssZ.",
  })
  .transform((t) => (t.endsWith("Z") ? t : `${t}Z`));

/**
 * Builder for the shared invoice-common base. Returns a *new* schema
 * for every kind so we can append `kind` cleanly via `.extend`.
 */
const invoiceCommonShape = {
  egsInfo: egsUnitInfoSchema,
  invoiceCounterNumber: z.number().int().positive(),
  invoiceSerialNumber: z.string().min(1),
  issueDate: issueDateSchema,
  issueTime: issueTimeSchema,
  previousInvoiceHash: invoiceHashSchema,
  lineItems: z.array(lineItemSchema).min(1, {
    message: "Invoice must contain at least one line item.",
  }),
  cancelation: cancelationSchema.optional(),
  buyerName: z.string().min(1).optional(),
  buyerInfo: buyerInfoSchema.optional(),
};

export const simplifiedTaxInvoiceInputSchema = z
  .object({
    kind: z.literal("simplified-tax-invoice"),
    ...invoiceCommonShape,
  })
  // BR-KSA-71: simplified summary invoices require buyerName.
  .refine((v) => typeof v.buyerName === "string" && v.buyerName.length > 0, {
    message: "Simplified tax invoice requires buyerName (BR-KSA-71 for summary invoices).",
    path: ["buyerName"],
  });

export const standardTaxInvoiceInputSchema = z
  .object({
    kind: z.literal("standard-tax-invoice"),
    ...invoiceCommonShape,
  })
  // Standard tax invoices need the full buyer party.
  .refine((v) => v.buyerInfo !== undefined, {
    message: "Standard tax invoice requires buyerInfo.",
    path: ["buyerInfo"],
  });

export const simplifiedCreditNoteInputSchema = z
  .object({
    kind: z.literal("simplified-credit-note"),
    ...invoiceCommonShape,
  })
  .refine((v) => v.cancelation !== undefined, {
    message: "Credit notes require a cancelation block referencing the original invoice.",
    path: ["cancelation"],
  });

export const standardCreditNoteInputSchema = z
  .object({
    kind: z.literal("standard-credit-note"),
    ...invoiceCommonShape,
  })
  .refine((v) => v.cancelation !== undefined, {
    message: "Credit notes require a cancelation block referencing the original invoice.",
    path: ["cancelation"],
  })
  .refine((v) => v.buyerInfo !== undefined, {
    message: "Standard credit note requires buyerInfo.",
    path: ["buyerInfo"],
  });

export const simplifiedDebitNoteInputSchema = z
  .object({
    kind: z.literal("simplified-debit-note"),
    ...invoiceCommonShape,
  })
  .refine((v) => v.cancelation !== undefined, {
    message: "Debit notes require a cancelation block referencing the original invoice.",
    path: ["cancelation"],
  });

export const standardDebitNoteInputSchema = z
  .object({
    kind: z.literal("standard-debit-note"),
    ...invoiceCommonShape,
  })
  .refine((v) => v.cancelation !== undefined, {
    message: "Debit notes require a cancelation block referencing the original invoice.",
    path: ["cancelation"],
  })
  .refine((v) => v.buyerInfo !== undefined, {
    message: "Standard debit note requires buyerInfo.",
    path: ["buyerInfo"],
  });

export const phase1InvoiceInputSchema = z.object({
  kind: z.literal("phase1-invoice"),
  ...invoiceCommonShape,
});

export const phase1CreditNoteInputSchema = z
  .object({
    kind: z.literal("phase1-credit-note"),
    ...invoiceCommonShape,
  })
  .refine((v) => v.cancelation !== undefined, {
    message: "Phase 1 credit notes require a cancelation block referencing the original invoice.",
    path: ["cancelation"],
  });

/**
 * Top-level invoice-input schema.
 *
 * `z.discriminatedUnion` requires bare object schemas (not the
 * `.refine`-wrapped ones above), so we keep a parallel raw-union here.
 * Consumers wanting BR-KSA-71 / cancelation enforcement should use the
 * individual variant schemas; this top-level union is for the
 * dispatcher path where the per-builder code re-validates the variant
 * with its own refined schema.
 */
const simplifiedTaxBase = z.object({
  kind: z.literal("simplified-tax-invoice"),
  ...invoiceCommonShape,
});
const standardTaxBase = z.object({
  kind: z.literal("standard-tax-invoice"),
  ...invoiceCommonShape,
});
const simplifiedCreditBase = z.object({
  kind: z.literal("simplified-credit-note"),
  ...invoiceCommonShape,
});
const standardCreditBase = z.object({
  kind: z.literal("standard-credit-note"),
  ...invoiceCommonShape,
});
const simplifiedDebitBase = z.object({
  kind: z.literal("simplified-debit-note"),
  ...invoiceCommonShape,
});
const standardDebitBase = z.object({
  kind: z.literal("standard-debit-note"),
  ...invoiceCommonShape,
});
const phase1InvoiceBase = z.object({
  kind: z.literal("phase1-invoice"),
  ...invoiceCommonShape,
});
const phase1CreditBase = z.object({
  kind: z.literal("phase1-credit-note"),
  ...invoiceCommonShape,
});

export const invoiceInputSchema = z.discriminatedUnion("kind", [
  simplifiedTaxBase,
  standardTaxBase,
  simplifiedCreditBase,
  standardCreditBase,
  simplifiedDebitBase,
  standardDebitBase,
  phase1InvoiceBase,
  phase1CreditBase,
]);

// ---------------------------------------------------------------------------
// Inferred types (for tests and downstream consumers)
// ---------------------------------------------------------------------------

export type SimplifiedTaxInvoiceInputParsed = z.infer<typeof simplifiedTaxInvoiceInputSchema>;
export type StandardTaxInvoiceInputParsed = z.infer<typeof standardTaxInvoiceInputSchema>;
export type SimplifiedCreditNoteInputParsed = z.infer<typeof simplifiedCreditNoteInputSchema>;
export type StandardCreditNoteInputParsed = z.infer<typeof standardCreditNoteInputSchema>;
export type SimplifiedDebitNoteInputParsed = z.infer<typeof simplifiedDebitNoteInputSchema>;
export type StandardDebitNoteInputParsed = z.infer<typeof standardDebitNoteInputSchema>;
export type Phase1InvoiceInputParsed = z.infer<typeof phase1InvoiceInputSchema>;
export type Phase1CreditNoteInputParsed = z.infer<typeof phase1CreditNoteInputSchema>;
export type InvoiceInputParsed = z.infer<typeof invoiceInputSchema>;
