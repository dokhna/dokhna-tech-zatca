/**
 * Wires the storage adapter, EGS info, and signing credentials for the
 * example. In production, you would resolve `certificate` / `privateKey`
 * from a KMS or secrets manager — env vars are used here only because
 * this is a runnable demo.
 */

import {
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  type EGSUnitInfo,
  type TenantScope,
} from "@dokhna-tech/zatca";
import { createMemoryStorageAdapter } from "@dokhna-tech/zatca-storage-memory";

const env = (key: string): string => {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const envOptional = (key: string, fallback: string): string => process.env[key] ?? fallback;

export function buildZatcaContext(): {
  storage: ReturnType<typeof createMemoryStorageAdapter>;
  egsInfo: EGSUnitInfo;
  scope: TenantScope;
  signing: { certificate: string; privateKey: string };
} {
  const vatNumber = asVATNumber(env("VAT_NUMBER"));
  const egsUuid = asEGSUuid(env("EGS_UUID"));
  const egsInfo: EGSUnitInfo = {
    uuid: egsUuid,
    customId: envOptional("EGS_CUSTOM_ID", "demo-pos-01"),
    model: envOptional("EGS_MODEL", "Express POS Demo"),
    crnNumber: asCommercialRegistrationNumber(env("CRN")),
    vatName: env("VAT_NAME"),
    vatNumber,
    branchName: envOptional("BRANCH_NAME", "Main"),
    branchIndustry: envOptional("BRANCH_INDUSTRY", "Retail"),
    location: {
      cityName: envOptional("CITY_NAME", "Riyadh"),
      citySubdivision: envOptional("CITY_SUBDIVISION", "Olaya"),
      street: envOptional("STREET", "King Fahd Rd"),
      plotIdentification: envOptional("PLOT", "1234"),
      building: envOptional("BUILDING", "5678"),
      postalZone: envOptional("POSTAL_ZONE", "12345"),
    },
  };

  return {
    storage: createMemoryStorageAdapter(),
    egsInfo,
    scope: { vatNumber, egsUuid },
    signing: {
      certificate: env("ZATCA_PRODUCTION_CERTIFICATE"),
      privateKey: env("ZATCA_PRIVATE_KEY"),
    },
  };
}
