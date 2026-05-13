/**
 * ZATCA XML signing.
 *
 * Ported from rwiqha-backend's `zatca.xml.signing.ts`. The pipeline is:
 *
 * 1. Compute the invoice hash (`getInvoiceHash`).
 * 2. Extract the cert info (hash, DN-reversed issuer, decimal serial,
 *    raw public key, raw signature) — `extractCertificateInfo`.
 * 3. Sign the *raw bytes of the invoice hash* with ECDSA-SHA256
 *    using the supplied private key — `createInvoiceDigitalSignature`.
 * 4. Build the Phase 2 QR — `generatePhase2QR`.
 * 5. Build the XAdES `SignedProperties` block (twice — once for
 *    hashing into the `<DigestValue>` reference, once for serialising
 *    into the signed XML).
 * 6. SHA-256 the for-signing variant, base64-of-hex.
 * 7. Substitute `SET_UBL_EXTENSIONS_STRING` and `SET_QR_CODE_DATA`
 *    placeholders in the template-filled XML, then apply the
 *    `signedPropertiesIndentationFix`.
 *
 * The two whitespace-fix functions exist because ZATCA's hash oracle
 * is whitespace-sensitive in counter-intuitive ways. Removing them
 * changes the bytes the sandbox sees and the signature is rejected.
 *
 * The legacy date-format dependency is replaced by
 * `formatSignTimestamp`. The legacy XML DOM dependency is replaced
 * by `@xmldom/xmldom`. The legacy collection-utilities dependency
 * was removed at the parser layer.
 */

import { createHash, createSign } from "node:crypto";
import type { Base64, InvoiceHash } from "../types/branded.js";
import { ZatcaSigningError } from "../types/errors.js";
import { formatSignTimestamp } from "../utils/datetime.js";
import { XMLDocument } from "../xml/document.js";
import { generatePhase2QR } from "../qr/phase2.js";
import { cleanUpCertificateString, extractCertificateInfo } from "./cert-info.js";
import { getInvoiceHash } from "./hash.js";

/**
 * Result of the signing pipeline.
 *
 * `signed_invoice_string` is the final XML wire format (with QR +
 * UBL signature extension injected). `invoice_hash` is the canonical
 * pre-sign hash (also written to the storage adapter as the next
 * invoice's `previous_invoice_hash`). `qr` is the Phase 2 QR
 * base64 string.
 */
export interface SignedXMLResult {
  signed_invoice_string: string;
  invoice_hash: InvoiceHash;
  qr: string;
  /** Base64-encoded ECDSA signature. */
  digital_signature: Base64;
}

export interface GenerateSignatureXMLParams {
  invoice_xml: XMLDocument;
  certificate_string: string;
  private_key_string: string;
}

/**
 * Strips `-----BEGIN EC PRIVATE KEY-----` / `-----END EC PRIVATE KEY-----`
 * framing from a PEM private key, leaving only the base64 body.
 */
export function cleanUpPrivateKeyString(private_key_string: string): string {
  return private_key_string
    .replace("-----BEGIN EC PRIVATE KEY-----\n", "")
    .replace("-----END EC PRIVATE KEY-----", "")
    .trim();
}

/**
 * Signs the *raw bytes of the invoice hash* with ECDSA-SHA256.
 *
 * The hash input is `Buffer.from(invoice_hash, "base64")` — the
 * signature is over the raw 32-byte digest, not the base64 string.
 * Output is base64.
 *
 * @throws {ZatcaSigningError} if the key is malformed.
 */
export function createInvoiceDigitalSignature(
  invoice_hash: string,
  private_key_string: string,
): string {
  try {
    const invoice_hash_bytes = Buffer.from(invoice_hash, "base64");
    const cleaned = cleanUpPrivateKeyString(private_key_string);
    const wrapped = `-----BEGIN EC PRIVATE KEY-----\n${cleaned}\n-----END EC PRIVATE KEY-----`;

    const sign = createSign("sha256");
    sign.update(invoice_hash_bytes);
    return Buffer.from(sign.sign(wrapped)).toString("base64");
  } catch (cause) {
    throw new ZatcaSigningError(
      "Failed to ECDSA-sign the invoice hash. Check that the private key is a valid secp256k1 PEM.",
      cause,
    );
  }
}

// ===========================================================================
// XAdES SignedProperties templates — inlined to avoid a templates/ module
// dependency in Phase 2. Phase 3 will move these to `templates/` alongside
// the UBL extension wrapper.
// ===========================================================================

interface SignedPropertiesProps {
  sign_timestamp: string;
  certificate_hash: string;
  certificate_issuer: string;
  certificate_serial_number: string;
}

/**
 * SignedProperties template used as the digest input — has heavy
 * indentation that the ZATCA hash oracle expects.
 */
const SIGNED_PROPERTIES_FOR_SIGNING = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
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

/**
 * SignedProperties template used as the serialised output — same
 * structure as the for-signing variant but with the namespace
 * declarations stripped from inner elements (they're inherited
 * from the enclosing UBL extension).
 */
const SIGNED_PROPERTIES_AFTER_SIGNING = `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
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

function populateSignedProperties(
  template: string,
  props: SignedPropertiesProps,
): string {
  return template
    .replace("SET_SIGN_TIMESTAMP", props.sign_timestamp)
    .replace("SET_CERTIFICATE_HASH", props.certificate_hash)
    .replace("SET_CERTIFICATE_ISSUER", props.certificate_issuer)
    .replace("SET_CERTIFICATE_SERIAL_NUMBER", props.certificate_serial_number);
}

// ===========================================================================
// UBL extension wrapper — also inlined for Phase 2.
// ===========================================================================

const UBL_EXTENSION_TEMPLATE = `
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures
                    xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
                    xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"
                    xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature Id="signature" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod
                                    Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod
                                    Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform
                                            Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod
                                        Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>SET_INVOICE_HASH</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference
                                    Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties"
                                    URI="#xadesSignedProperties">
                                <ds:DigestMethod
                                        Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>SET_SIGNED_PROPERTIES_HASH</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>SET_DIGITAL_SIGNATURE</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>SET_CERTIFICATE</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties Target="signature"
                                                        xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
                                SET_SIGNED_PROPERTIES_XML
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>`;

function populateUBLSignExtension(args: {
  invoice_hash: string;
  signed_properties_hash: string;
  digital_signature: string;
  certificate_string: string;
  signed_properties_xml: string;
}): string {
  return UBL_EXTENSION_TEMPLATE.replace("SET_INVOICE_HASH", args.invoice_hash)
    .replace("SET_SIGNED_PROPERTIES_HASH", args.signed_properties_hash)
    .replace("SET_DIGITAL_SIGNATURE", args.digital_signature)
    .replace("SET_CERTIFICATE", args.certificate_string)
    .replace("SET_SIGNED_PROPERTIES_XML", args.signed_properties_xml);
}

/**
 * Trims leading spaces from each line inside `<ds:Object>...</ds:Object>`
 * to match the indentation ZATCA's validator expects.
 *
 * Verbatim from rwiqha — see the source's comment block. ZATCA's
 * validator computes the hash over an *unindented* SignedProperties
 * block. Removing this function makes the sandbox reject the
 * signature with a "Signature hash mismatch" error.
 */
function signedPropertiesIndentationFix(signed_invoice_string: string): string {
  let fixer = signed_invoice_string;
  const objectSegments = fixer.split("<ds:Object>");
  if (objectSegments.length < 2) {
    return fixer;
  }
  const innerSegments = (objectSegments[1] ?? "").split("</ds:Object>");
  if (innerSegments.length < 1 || innerSegments[0] === undefined) {
    return fixer;
  }
  const signed_props_lines = innerSegments[0].split("\n");
  const fixed_lines: string[] = signed_props_lines.map((line) =>
    line.slice(4, line.length),
  );

  const trimmed_signed_props_lines = signed_props_lines.slice(0, -1);
  const trimmed_fixed_lines = fixed_lines.slice(0, -1);

  fixer = fixer.replace(
    trimmed_signed_props_lines.join("\n"),
    trimmed_fixed_lines.join("\n"),
  );
  return fixer;
}

/**
 * Entry point: produces the fully signed UBL invoice + Phase 2 QR.
 *
 * The input `invoice_xml` is expected to have `SET_UBL_EXTENSIONS_STRING`
 * and `SET_QR_CODE_DATA` placeholder strings in its serialised form —
 * these are produced by the Phase 3 invoice builders.
 */
export function generateSignedXMLString(
  params: GenerateSignatureXMLParams,
): SignedXMLResult {
  const { invoice_xml, certificate_string, private_key_string } = params;
  const invoice_copy = new XMLDocument(invoice_xml.toString({ no_header: false }));

  // 1: Invoice hash.
  const invoice_hash = getInvoiceHash(invoice_xml);

  // 2: Certificate info.
  const cert_info = extractCertificateInfo(certificate_string);

  // 3: Digital signature.
  const digital_signature = createInvoiceDigitalSignature(
    invoice_hash,
    private_key_string,
  );

  // 4: Phase 2 QR.
  const qr = generatePhase2QR({
    invoice: invoice_xml,
    invoiceHash: invoice_hash,
    digitalSignature: digital_signature,
    publicKey: cert_info.public_key,
    certificateSignature: cert_info.signature,
  });

  // 5: Sign timestamp anchored to the invoice issue date/time when
  //    possible, falling back to "now" if either is absent. Mirrors
  //    rwiqha's behaviour so the SigningTime element matches what
  //    the QR encodes.
  const issue_date_result = invoice_xml.get("Invoice/cbc:IssueDate");
  const issue_time_result = invoice_xml.get("Invoice/cbc:IssueTime");
  const issue_date = issue_date_result?.[0];
  const issue_time = issue_time_result?.[0];
  const datetime: Date | string =
    typeof issue_date === "string" && typeof issue_time === "string"
      ? `${issue_date}T${issue_time}`
      : new Date();

  const signed_properties_props: SignedPropertiesProps = {
    sign_timestamp: formatSignTimestamp(datetime),
    certificate_hash: cert_info.hash,
    certificate_issuer: cert_info.issuer,
    certificate_serial_number: cert_info.serial_number,
  };

  const ubl_signed_properties_for_signing = populateSignedProperties(
    SIGNED_PROPERTIES_FOR_SIGNING,
    signed_properties_props,
  );
  const ubl_signed_properties_for_output = populateSignedProperties(
    SIGNED_PROPERTIES_AFTER_SIGNING,
    signed_properties_props,
  );

  // 6: SignedProperties digest (sha256, hex, then base64).
  const signed_properties_hash = Buffer.from(
    createHash("sha256")
      .update(Buffer.from(ubl_signed_properties_for_signing))
      .digest("hex"),
  ).toString("base64");

  // 7: UBL extension wrapper.
  const ubl_signature_xml_string = populateUBLSignExtension({
    invoice_hash,
    signed_properties_hash,
    digital_signature,
    certificate_string: cleanUpCertificateString(certificate_string),
    signed_properties_xml: ubl_signed_properties_for_output,
  });

  let unsigned_invoice_str = invoice_copy.toString({ no_header: false });
  unsigned_invoice_str = unsigned_invoice_str.replace(
    "SET_UBL_EXTENSIONS_STRING",
    ubl_signature_xml_string,
  );
  unsigned_invoice_str = unsigned_invoice_str.replace("SET_QR_CODE_DATA", qr);

  const signed_invoice = new XMLDocument(unsigned_invoice_str);
  let signed_invoice_string = signed_invoice.toString({ no_header: false });
  signed_invoice_string = signedPropertiesIndentationFix(signed_invoice_string);

  return {
    signed_invoice_string,
    invoice_hash,
    qr,
    digital_signature: digital_signature as Base64,
  };
}
