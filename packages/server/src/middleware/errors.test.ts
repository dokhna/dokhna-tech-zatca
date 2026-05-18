import { ZatcaApiError, ZatcaError, ZatcaValidationError } from "@dokhna-tech/zatca";
import { describe, expect, it } from "vitest";

import {
  ZatcaAuthError,
  ZatcaCipherError,
  ZatcaRegistryError,
  ZatcaServerError,
} from "../errors.js";

import { mapErrorToResponse } from "./errors.js";

describe("mapErrorToResponse", () => {
  it("ZatcaAuthError → status from statusHint", () => {
    expect(mapErrorToResponse(new ZatcaAuthError("nope", 401)).statusCode).toBe(401);
    expect(mapErrorToResponse(new ZatcaAuthError("not yours", 403)).statusCode).toBe(403);
  });

  it("ZatcaValidationError → 400", () => {
    expect(mapErrorToResponse(new ZatcaValidationError("bad input")).statusCode).toBe(400);
  });

  it("ZatcaRegistryError with 'Unknown tenant' → 404", () => {
    expect(mapErrorToResponse(new ZatcaRegistryError("Unknown tenant 'x'.")).statusCode).toBe(404);
  });

  it("ZatcaRegistryError with state conflict → 409", () => {
    expect(
      mapErrorToResponse(new ZatcaRegistryError("Cannot transition tenant 'x' from 'created'."))
        .statusCode,
    ).toBe(409);
  });

  it("ZatcaCipherError → 500", () => {
    expect(mapErrorToResponse(new ZatcaCipherError("auth tag mismatch")).statusCode).toBe(500);
  });

  it("ZatcaApiError surfaces ZATCA status + request id + validationResults", () => {
    const err = new ZatcaApiError("rejected", 422, { errorMessages: [] }, "req-zatca-1");
    const mapped = mapErrorToResponse(err);
    expect(mapped.statusCode).toBe(422);
    expect(mapped.headers["X-Zatca-Request-Id"]).toBe("req-zatca-1");
    expect(mapped.body.error.zatcaRequestId).toBe("req-zatca-1");
    expect(mapped.body.error.validationResults).toEqual({ errorMessages: [] });
  });

  it("ZatcaApiError clamps non-HTTP status codes to 502", () => {
    expect(mapErrorToResponse(new ZatcaApiError("weird", 0)).statusCode).toBe(502);
    expect(mapErrorToResponse(new ZatcaApiError("weird", 999)).statusCode).toBe(502);
  });

  it("generic ZatcaServerError → 500", () => {
    expect(mapErrorToResponse(new ZatcaServerError("boom")).statusCode).toBe(500);
  });

  it("generic ZatcaError → 500", () => {
    class Custom extends ZatcaError {}
    expect(mapErrorToResponse(new Custom("custom")).statusCode).toBe(500);
  });

  it("plain Error → 500 with the message", () => {
    const mapped = mapErrorToResponse(new Error("yikes"));
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.message).toBe("yikes");
  });

  it("non-Error throw → generic 500", () => {
    const mapped = mapErrorToResponse("string-thrown");
    expect(mapped.statusCode).toBe(500);
    expect(mapped.body.error.name).toBe("InternalServerError");
  });
});
