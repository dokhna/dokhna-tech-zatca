/**
 * Mongoose connection + adapter wiring for the multi-tenant SaaS example.
 *
 * One Mongoose connection serves all tenants; the storage adapter scopes
 * everything by `TenantScope` on the request path.
 */

import mongoose, { type Connection } from "mongoose";
import type { StorageAdapter } from "@dokhna-tach/zatca";
import { createMongoStorageAdapter } from "@dokhna-tach/zatca-storage-mongo";

export async function connectMongo(uri: string): Promise<Connection> {
  await mongoose.connect(uri);
  return mongoose.connection;
}

export function buildStorageAdapter(connection: Connection): StorageAdapter {
  return createMongoStorageAdapter({ connection });
}
