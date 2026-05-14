/**
 * Prisma-backed StorageAdapter for @dokhna-tech/zatca.
 *
 * The Prisma client's exact types only exist after `prisma generate`
 * runs. To keep this file typecheckable without the generated client
 * (handy in CI and for first-look readers), the adapter takes the
 * structural shape it needs via the {@link PrismaLike} interface below.
 *
 * In your own code, `pnpm prisma generate` will produce a `PrismaClient`
 * that satisfies this shape exactly — pass it straight in:
 *
 * ```ts
 * import { PrismaClient } from "@prisma/client";
 * const prisma = new PrismaClient();
 * const adapter = createPrismaStorageAdapter(prisma);
 * ```
 */

import type {
  InvoiceHash,
  InvoiceKind,
  InvoiceRecord,
  InvoiceStatus,
  StorageAdapter,
  TenantScope,
} from "@dokhna-tech/zatca";
import { ZatcaStorageError } from "@dokhna-tech/zatca";

const ZATCA_BASE_INVOICE_HASH =
  "NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==" as InvoiceHash;

interface InvoiceRow {
  id: string;
  vatNumber: string;
  egsUuid: string;
  kind: string;
  serial: string;
  counterNumber: number;
  uuid: string;
  invoiceHash: string;
  previousInvoiceHash: string;
  signedXml: string;
  qrBase64: string;
  issuedAt: Date;
  status: string;
  clearanceNumber: string | null;
  validationResults: string | null;
}

interface CounterRow {
  vatNumber: string;
  egsUuid: string;
  yearMonth: string;
  sequence: number;
  updatedAt: Date;
}

/**
 * Minimal structural shape we use from `PrismaClient`. The generated
 * client is a superset; the assignment in `createPrismaStorageAdapter`
 * therefore "just works" without any cast.
 */
export interface PrismaLike {
  zatcaInvoice: {
    create(args: { data: InvoiceRow }): Promise<InvoiceRow>;
    findFirst(args: {
      where: { vatNumber: string; egsUuid: string; id?: string };
      orderBy?: { counterNumber: "asc" | "desc" };
      select?: { invoiceHash: true };
    }): Promise<{ invoiceHash: string } | InvoiceRow | null>;
    updateMany(args: {
      where: { vatNumber: string; egsUuid: string; id: string };
      data: { status: string };
    }): Promise<{ count: number }>;
  };
  zatcaCounter: {
    upsert(args: {
      where: {
        vatNumber_egsUuid_yearMonth: {
          vatNumber: string;
          egsUuid: string;
          yearMonth: string;
        };
      };
      update: { sequence: { increment: number } };
      create: {
        vatNumber: string;
        egsUuid: string;
        yearMonth: string;
        sequence: number;
      };
    }): Promise<CounterRow>;
  };
}

function yearMonthFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}${month}`;
}

function rowToRecord(row: InvoiceRow): InvoiceRecord {
  const base: InvoiceRecord = {
    invoiceId: row.id,
    kind: row.kind as InvoiceKind,
    serial: row.serial,
    counterNumber: row.counterNumber,
    uuid: row.uuid,
    invoiceHash: row.invoiceHash as InvoiceHash,
    previousInvoiceHash: row.previousInvoiceHash as InvoiceHash,
    signedXml: row.signedXml,
    qrBase64: row.qrBase64,
    issuedAt: row.issuedAt,
    status: row.status as InvoiceStatus,
  };
  if (row.clearanceNumber !== null) {
    base.clearanceNumber = row.clearanceNumber;
  }
  if (row.validationResults !== null) {
    try {
      base.validationResults = JSON.parse(row.validationResults) as unknown;
    } catch {
      base.validationResults = row.validationResults;
    }
  }
  return base;
}

/**
 * Build a `StorageAdapter` backed by Prisma. The supplied client must
 * have been generated against the schema in `prisma/schema.prisma` (or
 * an equivalent).
 */
export function createPrismaStorageAdapter(prisma: PrismaLike): StorageAdapter {
  return {
    async incrementCounter(scope: TenantScope) {
      const yearMonth = yearMonthFor(new Date());
      const updated = await prisma.zatcaCounter.upsert({
        where: {
          vatNumber_egsUuid_yearMonth: {
            vatNumber: scope.vatNumber,
            egsUuid: scope.egsUuid,
            yearMonth,
          },
        },
        update: { sequence: { increment: 1 } },
        create: {
          vatNumber: scope.vatNumber,
          egsUuid: scope.egsUuid,
          yearMonth,
          sequence: 1,
        },
      });
      const sequence = updated.sequence;
      const invoiceNumber = `${yearMonth}${String(sequence).padStart(6, "0")}`;
      return { sequence, invoiceNumber };
    },

    async getPreviousHash(scope: TenantScope) {
      const last = await prisma.zatcaInvoice.findFirst({
        where: { vatNumber: scope.vatNumber, egsUuid: scope.egsUuid },
        orderBy: { counterNumber: "desc" },
        select: { invoiceHash: true },
      });
      if (last === null) return ZATCA_BASE_INVOICE_HASH;
      return last.invoiceHash as InvoiceHash;
    },

    async recordInvoice(scope: TenantScope, record: InvoiceRecord) {
      try {
        await prisma.zatcaInvoice.create({
          data: {
            id: record.invoiceId,
            vatNumber: scope.vatNumber,
            egsUuid: scope.egsUuid,
            kind: record.kind,
            serial: record.serial,
            counterNumber: record.counterNumber,
            uuid: record.uuid,
            invoiceHash: record.invoiceHash,
            previousInvoiceHash: record.previousInvoiceHash,
            signedXml: record.signedXml,
            qrBase64: record.qrBase64,
            issuedAt: record.issuedAt,
            status: record.status,
            clearanceNumber: record.clearanceNumber ?? null,
            validationResults:
              record.validationResults === undefined
                ? null
                : JSON.stringify(record.validationResults),
          },
        });
      } catch (cause) {
        // Production code should distinguish P2002 (unique violation)
        // and re-fetch + compare for idempotency. Omitted for brevity.
        throw new ZatcaStorageError("recordInvoice failed", cause);
      }
    },

    async loadInvoice(scope: TenantScope, invoiceId: string) {
      const row = await prisma.zatcaInvoice.findFirst({
        where: { vatNumber: scope.vatNumber, egsUuid: scope.egsUuid, id: invoiceId },
      });
      if (row === null) return null;
      // findFirst's selection variant returned the full row.
      const full = row as InvoiceRow;
      return rowToRecord(full);
    },

    async updateInvoiceStatus(scope: TenantScope, invoiceId: string, status: InvoiceStatus) {
      await prisma.zatcaInvoice.updateMany({
        where: { vatNumber: scope.vatNumber, egsUuid: scope.egsUuid, id: invoiceId },
        data: { status },
      });
    },
  };
}
