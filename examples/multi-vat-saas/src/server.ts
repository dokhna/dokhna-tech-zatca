/**
 * Multi-tenant SaaS example for @dokhna-tach/zatca.
 *
 * Fastify server with a single Mongoose connection. Every request
 * resolves a TenantScope from the `X-Tenant-ID` header before invoking
 * the storage adapter and the issuers.
 *
 * The tenants registry is hardcoded for demo purposes — in production
 * you'd load tenants from your tenants collection and resolve
 * per-tenant signing material from your secret store on the request
 * path (cached briefly in-memory if your SLA demands it).
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import "dotenv/config";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { issueSimplifiedTaxInvoice, type StorageAdapter } from "@dokhna-tach/zatca";

import { buildStorageAdapter, connectMongo } from "./zatca-mongo.js";
import {
  makeTenantResolver,
  type TenantContext,
  type TenantRecord,
} from "./tenant-router.js";

const DEMO_TENANTS: ReadonlyArray<TenantRecord> = [
  {
    id: "acme",
    vatNumber: "301234567890003",
    egsUuid: "00000000-0000-4000-8000-000000000001",
    vatName: "Acme Trading Co.",
    crn: "1010010101",
    branchName: "Riyadh HQ",
    credentials: {
      certificate: process.env["ACME_CERTIFICATE"] ?? "",
      privateKey: process.env["ACME_PRIVATE_KEY"] ?? "",
      binarySecurityToken: process.env["ACME_BST"] ?? "",
      apiSecret: process.env["ACME_API_SECRET"] ?? "",
    },
  },
  {
    id: "globex",
    vatNumber: "302345678901243",
    egsUuid: "00000000-0000-4000-8000-000000000002",
    vatName: "Globex Distribution",
    crn: "1010020202",
    branchName: "Jeddah Warehouse",
    credentials: {
      certificate: process.env["GLOBEX_CERTIFICATE"] ?? "",
      privateKey: process.env["GLOBEX_PRIVATE_KEY"] ?? "",
      binarySecurityToken: process.env["GLOBEX_BST"] ?? "",
      apiSecret: process.env["GLOBEX_API_SECRET"] ?? "",
    },
  },
];

const resolveTenant = makeTenantResolver(DEMO_TENANTS);

interface IssueBody {
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

function getTenant(
  req: FastifyRequest,
  reply: FastifyReply,
): TenantContext | null {
  const header = req.headers["x-tenant-id"];
  const tenantId = Array.isArray(header) ? header[0] : header;
  if (typeof tenantId !== "string" || tenantId === "") {
    reply.code(400).send({ error: "missing X-Tenant-ID header" });
    return null;
  }
  const ctx = resolveTenant(tenantId);
  if (ctx === null) {
    reply.code(404).send({ error: `unknown tenant: ${tenantId}` });
    return null;
  }
  return ctx;
}

export async function buildServer(
  storage: StorageAdapter,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/health", async () => ({ status: "ok", tenants: DEMO_TENANTS.length }));

  app.post<{ Body: IssueBody }>("/invoices", async (req, reply) => {
    const tenant = getTenant(req, reply);
    if (tenant === null) return reply;
    const body = req.body;
    if (!body?.issueDate || !body.issueTime || !body.lineItems?.length) {
      return reply.code(400).send({
        error: "issueDate, issueTime, and lineItems are required",
      });
    }
    if (
      tenant.credentials.certificate === "" ||
      tenant.credentials.privateKey === ""
    ) {
      return reply.code(503).send({
        error: `tenant ${tenant.egsInfo.customId} has no signing material configured`,
      });
    }

    try {
      const issued = await issueSimplifiedTaxInvoice({
        egsInfo: tenant.egsInfo,
        storage,
        scope: tenant.scope,
        signing: {
          certificate: tenant.credentials.certificate,
          privateKey: tenant.credentials.privateKey,
        },
        input: {
          kind: "simplified-tax-invoice",
          issueDate: body.issueDate,
          issueTime: body.issueTime,
          buyerName: body.buyerName,
          lineItems: body.lineItems,
        },
      });
      return reply.send({
        invoiceNumber: issued.invoiceNumber,
        sequence: issued.sequence,
        invoiceHash: issued.invoiceHash,
        qrCode: issued.qrCode,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return reply.code(500).send({ error: message });
    }
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (req, reply) => {
    const tenant = getTenant(req, reply);
    if (tenant === null) return reply;
    const record = await storage.loadInvoice(tenant.scope, req.params.id);
    if (record === null) return reply.code(404).send({ error: "not found" });
    return reply.send({
      invoiceId: record.invoiceId,
      kind: record.kind,
      serial: record.serial,
      invoiceHash: record.invoiceHash,
      status: record.status,
      issuedAt: record.issuedAt,
    });
  });

  return app;
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  const mongoUri = process.env["MONGO_URI"] ?? "mongodb://localhost:27017/zatca-saas-demo";
  const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);

  const connection = await connectMongo(mongoUri);
  const storage = buildStorageAdapter(connection);
  const app = await buildServer(storage);
  await app.listen({ port, host: "0.0.0.0" });
  console.log(`multi-vat-saas listening on http://localhost:${port}`);
}
