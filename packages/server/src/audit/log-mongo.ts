/**
 * MongoDB-backed `AuditLog` implementation.
 *
 * Pairs with `createMongoRegistry` in `tenants/registry-mongo.ts`.
 * Both share the same Mongoose `Connection`. The HTTP layer in PR3
 * uses Mongo sessions + multi-doc transactions (requires a replica
 * set) to bundle a mutation + audit-write atomically; this layer
 * accepts session-aware writes when needed.
 */

import { randomUUID } from "node:crypto";

import type { Connection, Model } from "mongoose";
import mongoose from "mongoose";
import type {
  AuditActor,
  AuditEntry,
  AuditEntryInput,
  AuditListFilter,
  AuditLog,
  AuditResult,
} from "./log.js";
import { capAuditPayload } from "./redact.js";

interface AuditDoc {
  _id: string; // UUID
  at: Date;
  actorType: string;
  actor: AuditActor;
  tenantRef?: string;
  action: string;
  targetId?: string;
  result: string;
  zatcaRequestId?: string;
  requestId?: string;
  payload?: Readonly<Record<string, unknown>>;
}

const AuditSchemaDefinition = {
  _id: { type: String, required: true },
  at: { type: Date, required: true, default: () => new Date() },
  actorType: { type: String, required: true },
  actor: { type: mongoose.Schema.Types.Mixed, required: true },
  tenantRef: { type: String, required: false },
  action: { type: String, required: true },
  targetId: { type: String, required: false },
  result: { type: String, required: true },
  zatcaRequestId: { type: String, required: false },
  requestId: { type: String, required: false },
  payload: { type: mongoose.Schema.Types.Mixed, required: false },
};

function buildAuditModel(connection: Connection): Model<AuditDoc> {
  const existing = connection.models.ZatcaServerAuditLog as Model<AuditDoc> | undefined;
  if (existing !== undefined) return existing;
  // LO-05: `_id: false` was misleading — it applies to subdocuments,
  // not the top-level schema. We explicitly declare `_id` of type
  // String above so Mongoose already treats our value as the row id.
  const schema = new mongoose.Schema<AuditDoc>(AuditSchemaDefinition, {
    versionKey: false,
  });
  schema.index({ tenantRef: 1, at: -1 });
  schema.index({ action: 1, at: -1 });
  schema.index({ at: -1 });
  return connection.model<AuditDoc>("ZatcaServerAuditLog", schema, "zatca_server_audit_log");
}

function docToEntry(doc: AuditDoc): AuditEntry {
  const out: Record<string, unknown> = {
    id: doc._id,
    at: doc.at,
    actor: doc.actor,
    action: doc.action,
    result: doc.result as AuditResult,
  };
  if (doc.tenantRef !== undefined) out.tenantRef = doc.tenantRef;
  if (doc.targetId !== undefined) out.targetId = doc.targetId;
  if (doc.zatcaRequestId !== undefined) out.zatcaRequestId = doc.zatcaRequestId;
  if (doc.requestId !== undefined) out.requestId = doc.requestId;
  if (doc.payload !== undefined) out.payload = doc.payload;
  return out as unknown as AuditEntry;
}

/**
 * Constructor options for the Mongo audit log.
 */
export interface MongoAuditLogOptions {
  readonly connection: Connection;
  readonly now?: () => Date;
}

export function createMongoAuditLog(options: MongoAuditLogOptions): AuditLog {
  const AuditModel = buildAuditModel(options.connection);
  const clock = options.now ?? (() => new Date());

  return {
    async write(input: AuditEntryInput): Promise<AuditEntry> {
      const id = randomUUID();
      const at = clock();
      // ME-25: cap payload size before it hits the Mixed-type field.
      const cappedPayload = capAuditPayload(input.payload);
      const doc: AuditDoc = {
        _id: id,
        at,
        actorType: input.actor.type,
        actor: input.actor,
        action: input.action,
        result: input.result,
        ...(input.tenantRef !== undefined ? { tenantRef: input.tenantRef } : {}),
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input.zatcaRequestId !== undefined ? { zatcaRequestId: input.zatcaRequestId } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
        ...(cappedPayload !== undefined ? { payload: cappedPayload } : {}),
      };
      await AuditModel.create(doc);
      return docToEntry(doc);
    },

    async list(filter: AuditListFilter = {}) {
      const mongoFilter: Record<string, unknown> = {};
      if (filter.tenantRef !== undefined) mongoFilter.tenantRef = filter.tenantRef;
      if (filter.action !== undefined) mongoFilter.action = filter.action;
      if (filter.actorType !== undefined) mongoFilter.actorType = filter.actorType;
      if (filter.result !== undefined) mongoFilter.result = filter.result;
      if (filter.since !== undefined || filter.until !== undefined) {
        const atFilter: Record<string, Date> = {};
        if (filter.since !== undefined) atFilter.$gte = filter.since;
        if (filter.until !== undefined) atFilter.$lte = filter.until;
        mongoFilter.at = atFilter;
      }
      const limit = filter.limit ?? 100;
      const docs = (await AuditModel.find(mongoFilter)
        .sort({ at: -1 })
        .limit(limit)
        .lean()
        .exec()) as AuditDoc[];
      return docs.map(docToEntry);
    },
  };
}
