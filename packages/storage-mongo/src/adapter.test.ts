/**
 * `MongoStorageAdapter` — conformance suite wire-up.
 *
 * Spins up an in-process MongoDB via `mongodb-memory-server`, connects
 * Mongoose, and runs the shared conformance suite against the mongo
 * adapter. The connection is closed in the conformance suite's
 * `afterAll` via the `teardown` hook.
 *
 * Concurrency is capped at 25 (default 100 would saturate the in-memory
 * Mongo's WiredTiger storage engine under a single-CPU CI run and
 * occasionally trips the WriteConflict path).
 */

import { runStorageAdapterConformance } from "@dokhna-tech/zatca/test-helpers";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createMongoStorageAdapter } from "./adapter.js";

let mongod: MongoMemoryServer | undefined;
let connection: mongoose.Connection | undefined;

runStorageAdapterConformance(
  async () => {
    mongod = await MongoMemoryServer.create();
    connection = await mongoose
      .createConnection(mongod.getUri(), { dbName: "zatca_test" })
      .asPromise();
    return createMongoStorageAdapter({ connection });
  },
  {
    concurrency: 25,
    teardown: async () => {
      if (connection !== undefined) {
        await connection.dropDatabase();
        await connection.close();
        connection = undefined;
      }
      if (mongod !== undefined) {
        await mongod.stop();
        mongod = undefined;
      }
    },
  },
);
