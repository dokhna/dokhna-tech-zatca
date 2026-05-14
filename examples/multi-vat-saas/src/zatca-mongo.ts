/**
 * Mongoose connection + adapter wiring for the multi-tenant SaaS example.
 *
 * One Mongoose connection serves all tenants; the storage adapter scopes
 * everything by `TenantScope` on the request path.
 */

import mongoose, { type Connection } from "mongoose";
import type { StorageAdapter } from "@dokhna-tech/zatca";
import { createMongoStorageAdapter } from "@dokhna-tech/zatca-storage-mongo";

export async function connectMongo(uri: string): Promise<Connection> {
  await mongoose.connect(uri);
  return mongoose.connection;
}

export function buildStorageAdapter(connection: Connection): StorageAdapter {
  return createMongoStorageAdapter({ connection });
}
