/**
 * `@dokhna-tach/zatca` — public entrypoint.
 *
 * Phase 1 ships only the type system and runtime validators; later
 * phases will add XML / signing / QR / HTTP-client / onboarding /
 * compliance surfaces, also re-exported here.
 */

export * from "./types/index.js";
export * from "./validation/index.js";
