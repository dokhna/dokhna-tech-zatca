/**
 * Single-VAT Express example for @dokhna-tech/zatca.
 *
 * Exposes:
 *   POST /onboard       — runs onboard() and writes the result to data/onboarding.json
 *   POST /invoices      — issues a simplified tax invoice
 *   GET  /invoices/:id  — loads a stored invoice
 *   GET  /health        — liveness
 *
 * Run with:
 *   pnpm --filter @dokhna-tech-examples/single-vat-express start
 *
 * Make sure `.env` has the required values (see .env.example).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import "dotenv/config";
import {
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  type EGSUnitInfo,
  issueSimplifiedTaxInvoice,
  type OnboardingResult,
  onboard,
} from "@dokhna-tech/zatca";
import express, { type Express, type Request, type Response } from "express";

import { buildZatcaContext } from "./zatca-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "..", "data");
const ONBOARDING_FILE = resolve(DATA_DIR, "onboarding.json");

interface OnboardRequestBody {
  readonly otp: string;
  readonly vatName: string;
  readonly vatNumber: string;
  readonly crn: string;
  readonly egsUuid?: string;
  readonly environment?: "sandbox" | "simulation";
  readonly solutionName?: string;
}

interface IssueRequestBody {
  readonly issueDate: string;
  readonly issueTime: string;
  readonly buyerName: string;
  readonly lineItems: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly quantity: number;
    readonly taxExclusivePrice: number;
    readonly vatPercent: number;
  }>;
}

const ctx = (() => {
  try {
    return buildZatcaContext();
  } catch (err) {
    // Allow the server to start even without credentials so the
    // /onboard route is usable; /invoices will fail until env is set.
    if (err instanceof Error) {
      console.log(`[startup] Issuance disabled until env is populated: ${err.message}`);
    }
    return null;
  }
})();

const app: Express = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    issuanceReady: ctx !== null,
  });
});

app.post("/onboard", async (req: Request, res: Response) => {
  const body = req.body as OnboardRequestBody;
  if (!body?.otp) {
    res.status(400).json({ error: "otp is required" });
    return;
  }

  const egsUuid = asEGSUuid(body.egsUuid ?? randomUUID());
  const egsInfo: Omit<EGSUnitInfo, "certificate"> = {
    uuid: egsUuid,
    customId: "demo-pos-01",
    model: "Express POS Demo",
    crnNumber: asCommercialRegistrationNumber(body.crn),
    vatName: body.vatName,
    vatNumber: asVATNumber(body.vatNumber),
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

  try {
    const result: OnboardingResult = await onboard({
      egsInfo,
      otp: body.otp,
      environment: body.environment ?? "simulation",
      solutionName: body.solutionName ?? "Express Demo v0.1",
    });

    await mkdir(DATA_DIR, { recursive: true });
    // NOTE: writing the OnboardingResult to a file is for DEMO ONLY.
    // privateKey + apiSecrets must be encrypted at rest in production.
    await writeFile(ONBOARDING_FILE, JSON.stringify(result, null, 2));

    res.json({
      message:
        "Onboarded. Secrets written to data/onboarding.json (demo only — encrypt in production).",
      egsUuid,
      complianceTestStatus: result.complianceTestReport.overallStatus,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: message });
  }
});

app.post("/invoices", async (req: Request, res: Response) => {
  if (ctx === null) {
    res.status(503).json({
      error: "Issuance disabled — populate the .env file (see .env.example) and restart.",
    });
    return;
  }
  const body = req.body as IssueRequestBody;
  if (!body?.issueDate || !body.issueTime || !body.lineItems?.length) {
    res.status(400).json({ error: "issueDate, issueTime, and lineItems are required" });
    return;
  }

  try {
    const issued = await issueSimplifiedTaxInvoice({
      egsInfo: ctx.egsInfo,
      storage: ctx.storage,
      scope: ctx.scope,
      signing: ctx.signing,
      input: {
        kind: "simplified-tax-invoice",
        issueDate: body.issueDate,
        issueTime: body.issueTime,
        buyerName: body.buyerName,
        lineItems: body.lineItems,
      },
    });

    res.json({
      invoiceNumber: issued.invoiceNumber,
      sequence: issued.sequence,
      invoiceHash: issued.invoiceHash,
      qrCode: issued.qrCode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    res.status(500).json({ error: message });
  }
});

app.get("/invoices/:id", async (req: Request, res: Response) => {
  if (ctx === null) {
    res.status(503).json({ error: "Issuance disabled — populate .env." });
    return;
  }
  const invoiceId = req.params.id;
  if (invoiceId === undefined) {
    res.status(400).json({ error: "id required" });
    return;
  }
  const record = await ctx.storage.loadInvoice(ctx.scope, invoiceId);
  if (record === null) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    invoiceId: record.invoiceId,
    kind: record.kind,
    serial: record.serial,
    invoiceHash: record.invoiceHash,
    status: record.status,
    issuedAt: record.issuedAt,
  });
});

// Preserve readFile import for IDE / tooling.
void readFile;

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const isMainModule =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  app.listen(port, () => {
    console.log(`single-vat-express listening on http://localhost:${port}`);
  });
}

export { app };
