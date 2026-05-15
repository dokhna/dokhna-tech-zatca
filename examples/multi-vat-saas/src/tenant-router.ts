/**
 * Resolves a `TenantScope` and the per-tenant `EGSUnitInfo` from an
 * inbound request.
 *
 * Production resolvers pull this from a tenants collection in your own
 * database. The example uses an in-memory map so the demo runs without
 * extra setup.
 */

import {
  asCommercialRegistrationNumber,
  asEGSUuid,
  asVATNumber,
  type EGSUnitInfo,
  type TenantScope,
} from "@dokhna-tech/zatca";

export interface TenantCredentials {
  readonly certificate: string;
  readonly privateKey: string;
  readonly binarySecurityToken: string;
  readonly apiSecret: string;
}

export interface TenantContext {
  readonly scope: TenantScope;
  readonly egsInfo: EGSUnitInfo;
  readonly credentials: TenantCredentials;
}

export interface TenantRecord {
  readonly id: string;
  readonly vatNumber: string;
  readonly egsUuid: string;
  readonly vatName: string;
  readonly crn: string;
  readonly branchName: string;
  readonly credentials: TenantCredentials;
}

/**
 * Looks up a tenant by `X-Tenant-ID` header. Returns `null` if unknown.
 *
 * Replace the implementation with your tenants-collection lookup.
 */
export function makeTenantResolver(
  tenants: ReadonlyArray<TenantRecord>,
): (tenantId: string) => TenantContext | null {
  const byId = new Map<string, TenantRecord>(tenants.map((t) => [t.id, t]));
  return (tenantId) => {
    const record = byId.get(tenantId);
    if (record === undefined) return null;
    const vatNumber = asVATNumber(record.vatNumber);
    const egsUuid = asEGSUuid(record.egsUuid);
    const egsInfo: EGSUnitInfo = {
      uuid: egsUuid,
      customId: `${record.id}-pos-01`,
      model: "SaaS POS",
      crnNumber: asCommercialRegistrationNumber(record.crn),
      vatName: record.vatName,
      vatNumber,
      branchName: record.branchName,
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
    return {
      scope: { vatNumber, egsUuid },
      egsInfo,
      credentials: record.credentials,
    };
  };
}
