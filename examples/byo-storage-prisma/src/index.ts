/**
 * Demo entry point for the BYO Prisma adapter.
 *
 * Run with:
 *   pnpm prisma:generate
 *   pnpm --filter @dokhna-tech-examples/byo-storage-prisma start
 *
 * The DATABASE_URL env var must be set (see .env.example).
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";

import {
  type EGSUnitInfo,
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  issueSimplifiedTaxInvoice,
} from "@dokhna-tech/zatca";

import { type PrismaLike, createPrismaStorageAdapter } from "./prisma-adapter.js";

async function main(): Promise<void> {
  // The example requires `pnpm prisma:generate` to be run beforehand so
  // `@prisma/client` is populated. PrismaClient structurally satisfies
  // our `PrismaLike` subset interface.
  let prismaInstance: PrismaLike;
  try {
    prismaInstance = new PrismaClient() as unknown as PrismaLike;
  } catch (err) {
    console.log("[demo] @prisma/client not generated yet. Run `pnpm prisma:generate` and re-run.");
    if (err instanceof Error) console.log(`  cause: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const adapter = createPrismaStorageAdapter(prismaInstance);

  const vatNumber = asVATNumber("301234567890003");
  const egsUuid = asEGSUuid("00000000-0000-4000-8000-000000000001");
  const egsInfo: EGSUnitInfo = {
    uuid: egsUuid,
    customId: "byo-prisma-demo",
    model: "Prisma POS",
    crnNumber: asCommercialRegistrationNumber("1010010101"),
    vatName: "Acme Trading Co.",
    vatNumber,
    branchName: "Main",
    branchIndustry: "Retail",
    location: {
      cityName: "Riyadh",
      citySubdivision: "Olaya",
      street: "King Fahd Rd",
      plotIdentification: "1234",
      building: "5678",
      postalZone: "12345",
    },
  };

  const scope = { vatNumber, egsUuid };
  // Demo signing material — replace with real values from `onboard()`.
  const signing = {
    certificate: process.env.ZATCA_CERTIFICATE ?? "",
    privateKey: process.env.ZATCA_PRIVATE_KEY ?? "",
  };

  if (signing.certificate === "" || signing.privateKey === "") {
    console.log("[demo] Set ZATCA_CERTIFICATE and ZATCA_PRIVATE_KEY env vars to issue.");
    return;
  }

  for (let i = 0; i < 2; i += 1) {
    const issued = await issueSimplifiedTaxInvoice({
      egsInfo,
      storage: adapter,
      scope,
      signing,
      invoiceId: randomUUID(),
      input: {
        kind: "simplified-tax-invoice",
        issueDate: "2026-05-13",
        issueTime: "12:00:00",
        buyerName: "Walk-in customer",
        lineItems: [
          {
            id: "1",
            name: `Item ${i + 1}`,
            quantity: 1,
            taxExclusivePrice: 10,
            vatPercent: 15,
          },
        ],
      },
    });
    console.log(
      `[demo] issued ${issued.invoiceNumber} (sequence=${issued.sequence}) hash=${issued.invoiceHash.slice(0, 12)}...`,
    );
  }
}

await main();
