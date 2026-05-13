/**
 * OpenSSL `.cnf` configuration builder for ZATCA CSRs.
 *
 * Implements ZATCA's CSR profile from §2.2.2 of the Cryptographic
 * Stamp Implementation Standards: the SAN block must contain the
 * EGS' `SerialNumber` (built from `solution_name`, `model`,
 * `egs_serial_number`), the taxpayer's VAT (`UID`), the branch
 * `registeredAddress`, the branch `businessCategory`, and a fixed
 * `title=1100` per spec.
 *
 * Production vs. sandbox is encoded in the
 * `certificateTemplateName` ASN.1 string:
 * `"ZATCA-Code-Signing"` for production, `"PREZATCA-Code-Signing"`
 * for the simulation / compliance sandbox.
 *
 * This module is intentionally *internal* — exported from
 * `crypto/index.ts` only as `_generateCSRTemplate` so the public
 * surface stays small. Users go through `generateCSR`.
 */

/**
 * Template fields. The CN (Common Name) is taken from
 * `taxpayer_provided_id`, which is typically the EGS' custom ID
 * for the cash register.
 */
export interface CSRTemplateProps {
  /** Optional private-key passphrase. Unused by ZATCA but here for
   *  parity with the openssl `req` configuration spec. */
  private_key_pass?: string;
  /** `true` → production, `false` → sandbox / simulation. */
  production: boolean;
  solution_name: string;
  egs_model: string;
  egs_serial_number: string;
  vat_number: string;
  branch_location: string;
  branch_industry: string;
  taxpayer_provided_id: string;
  branch_name: string;
  taxpayer_name: string;
}

/**
 * Builds the OpenSSL `.cnf` content for a ZATCA-compliant CSR.
 *
 * Verbatim from rwiqha's `zatca.csr.template.function.ts` —
 * deviating from this layout makes ZATCA reject the CSR with
 * "Invalid CSR distinguished name".
 */
export function generateCSRTemplate(props: CSRTemplateProps): string {
  const template = `oid_section = OIDs

[OIDs]
certificateTemplateName = 1.3.6.1.4.1.311.20.2

[req]
prompt = no
distinguished_name = dn
req_extensions = v3_req
emailAddress = placeholder@email.com

[dn]
C = SA
O = SET_TAXPAYER_NAME
OU = SET_BRANCH_NAME
CN = SET_COMMON_NAME

[v3_req]
certificateTemplateName = ASN1:PRINTABLESTRING:SET_PRODUCTION_VALUE
subjectAltName = dirName:alt_names
basicConstraints=CA:FALSE
keyUsage = digitalSignature, nonRepudiation, keyEncipherment

[alt_names]
SN = SET_EGS_SERIAL_NUMBER
UID = SET_VAT_REGISTRATION_NUMBER
title = 1100
registeredAddress = SET_BRANCH_LOCATION
businessCategory = SET_BRANCH_INDUSTRY`;

  return template
    .replaceAll(
      "SET_PRODUCTION_VALUE",
      props.production ? "ZATCA-Code-Signing" : "PREZATCA-Code-Signing",
    )
    .replaceAll(
      "SET_EGS_SERIAL_NUMBER",
      `1-${props.solution_name}|2-${props.egs_model}|3-${props.egs_serial_number}`,
    )
    .replaceAll("SET_VAT_REGISTRATION_NUMBER", props.vat_number)
    .replaceAll("SET_BRANCH_LOCATION", props.branch_location)
    .replaceAll("SET_BRANCH_INDUSTRY", props.branch_industry)
    .replaceAll("SET_COMMON_NAME", props.taxpayer_provided_id)
    .replaceAll("SET_BRANCH_NAME", props.branch_name)
    .replaceAll("SET_TAXPAYER_NAME", props.taxpayer_name);
}
