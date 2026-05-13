/**
 * XAdES `<xades:SignedProperties>` templates.
 *
 * Two variants are exported:
 *
 * - {@link populateSignedPropertiesForSigning} — the heavy-indent
 *   version whose canonical SHA-256 digest goes into the
 *   `<ds:DigestValue>` reference inside the UBL extension. The
 *   namespace declarations are repeated on the inner `ds:` elements
 *   because the digest is taken *standalone* before being embedded.
 *
 * - {@link populateSignedPropertiesForOutput} — the lighter-indent
 *   version that lives in the final signed XML. Namespace
 *   declarations are stripped from the inner elements because the
 *   enclosing UBL extension already declares them.
 *
 * Both templates and the helper functions are ported verbatim from
 * rwiqha-backend's `zatca.ubl.extension.signed.properties.template.ts`.
 * The leading indentation matters for the post-sign canonicalisation
 * step — do not reformat.
 */

/**
 * Substitution inputs shared by both SignedProperties variants.
 */
export interface SignedPropertiesParams {
  signTimestamp: string;
  certificateHash: string;
  certificateIssuer: string;
  certificateSerialNumber: string;
}

const TEMPLATE_FOR_SIGNING = /* XML */ `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>SET_SIGN_TIMESTAMP</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">SET_CERTIFICATE_HASH</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">SET_CERTIFICATE_ISSUER</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">SET_CERTIFICATE_SERIAL_NUMBER</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;

const TEMPLATE_FOR_OUTPUT = /* XML */ `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                <xades:SignedSignatureProperties>
                                    <xades:SigningTime>SET_SIGN_TIMESTAMP</xades:SigningTime>
                                    <xades:SigningCertificate>
                                        <xades:Cert>
                                            <xades:CertDigest>
                                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
                                                <ds:DigestValue>SET_CERTIFICATE_HASH</ds:DigestValue>
                                            </xades:CertDigest>
                                            <xades:IssuerSerial>
                                                <ds:X509IssuerName>SET_CERTIFICATE_ISSUER</ds:X509IssuerName>
                                                <ds:X509SerialNumber>SET_CERTIFICATE_SERIAL_NUMBER</ds:X509SerialNumber>
                                            </xades:IssuerSerial>
                                        </xades:Cert>
                                    </xades:SigningCertificate>
                                </xades:SignedSignatureProperties>
                            </xades:SignedProperties>`;

function populate(template: string, params: SignedPropertiesParams): string {
  return template
    .replace("SET_SIGN_TIMESTAMP", params.signTimestamp)
    .replace("SET_CERTIFICATE_HASH", params.certificateHash)
    .replace("SET_CERTIFICATE_ISSUER", params.certificateIssuer)
    .replace("SET_CERTIFICATE_SERIAL_NUMBER", params.certificateSerialNumber);
}

/**
 * Heavy-indent SignedProperties used to compute the digest reference
 * embedded in the UBL extension.
 */
export function populateSignedPropertiesForSigning(
  params: SignedPropertiesParams,
): string {
  return populate(TEMPLATE_FOR_SIGNING, params);
}

/**
 * Light-indent SignedProperties used in the final signed XML body.
 */
export function populateSignedPropertiesForOutput(
  params: SignedPropertiesParams,
): string {
  return populate(TEMPLATE_FOR_OUTPUT, params);
}
