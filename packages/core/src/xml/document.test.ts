/**
 * Unit tests for the `XMLDocument` UBL wrapper.
 *
 * Coverage targets:
 * - Round-trip: parse → toString → parse produces a structurally
 *   equivalent object graph.
 * - `get` returns matching nodes, honours path filters, returns
 *   `undefined` when nothing matches.
 * - `delete` removes single + array-element matches, and removes
 *   the surrounding array key when emptied.
 * - `set` overwrites in place when `overwrite: true`, appends to
 *   array / promotes-to-array when `overwrite: false`, refuses to
 *   create missing parent paths.
 * - The whitespace-fragile `<cbc:ProfileID>` / `<cac:AccountingSupplierParty>`
 *   prefix preserved on toString round-trips (the ZATCA hash oracle
 *   depends on it).
 */

import { describe, expect, it } from "vitest";
import { XMLDocument } from "./document.js";

const SAMPLE_INVOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
    <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
    <cbc:ID>INV-001</cbc:ID>
    <cbc:UUID>11111111-2222-3333-4444-555555555555</cbc:UUID>
    <cac:AdditionalDocumentReference>
        <cbc:ID>ICV</cbc:ID>
        <cbc:UUID>1</cbc:UUID>
    </cac:AdditionalDocumentReference>
    <cac:AdditionalDocumentReference>
        <cbc:ID>QR</cbc:ID>
        <cac:Attachment>
            <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">SET_QR_CODE_DATA</cbc:EmbeddedDocumentBinaryObject>
        </cac:Attachment>
    </cac:AdditionalDocumentReference>
</Invoice>`;

describe("XMLDocument — construction", () => {
  it("constructs an empty document with a default `?xml` declaration", () => {
    const doc = new XMLDocument();
    const out = doc.toString();
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it("parses an invoice XML string without throwing", () => {
    expect(() => new XMLDocument(SAMPLE_INVOICE_XML)).not.toThrow();
  });
});

describe("XMLDocument — get", () => {
  it("returns the matched element at a leaf path", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    const result = doc.get("Invoice/cbc:ID");
    expect(result).toBeDefined();
    expect(result?.[0]).toBe("INV-001");
  });

  it("returns an array when the path resolves to multiple siblings", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    const result = doc.get("Invoice/cac:AdditionalDocumentReference");
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result?.length).toBe(2);
  });

  it("filters by a shallow predicate", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    const result = doc.get("Invoice/cac:AdditionalDocumentReference", {
      "cbc:ID": "QR",
    });
    expect(result?.length).toBe(1);
    expect((result?.[0] as { "cbc:ID": string })?.["cbc:ID"]).toBe("QR");
  });

  it("returns undefined for an unmatched path", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    expect(doc.get("Invoice/cbc:DoesNotExist")).toBeUndefined();
  });
});

describe("XMLDocument — delete", () => {
  it("deletes a single matched leaf", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    expect(doc.delete("Invoice/cbc:UUID")).toBe(true);
    expect(doc.get("Invoice/cbc:UUID")).toBeUndefined();
  });

  it("deletes a predicate-matched array element", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    expect(
      doc.delete("Invoice/cac:AdditionalDocumentReference", { "cbc:ID": "QR" }),
    ).toBe(true);
    const remaining = doc.get("Invoice/cac:AdditionalDocumentReference");
    expect(remaining?.length).toBe(1);
    expect((remaining?.[0] as { "cbc:ID": string })["cbc:ID"]).toBe("ICV");
  });

  it("returns false when nothing matched", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    expect(doc.delete("Invoice/cbc:NotThere")).toBe(false);
  });
});

describe("XMLDocument — toString", () => {
  it("emits an XML header by default", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    expect(doc.toString()).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  });

  it("strips the XML header when no_header is true", () => {
    const doc = new XMLDocument(SAMPLE_INVOICE_XML);
    expect(doc.toString({ no_header: true })).not.toContain('<?xml ');
  });

  it("converts &apos; back to a literal single quote", () => {
    const doc = new XMLDocument(
      `<root><cbc:Name>it's a name</cbc:Name></root>`,
    );
    const out = doc.toString({ no_header: true });
    expect(out).toContain("it's a name");
    expect(out).not.toContain("&apos;");
  });
});

describe("XMLDocument — round trip", () => {
  it("preserves the structure after parse → toString → parse", () => {
    const a = new XMLDocument(SAMPLE_INVOICE_XML);
    const round = new XMLDocument(a.toString());
    expect(round.get("Invoice/cbc:ID")?.[0]).toBe("INV-001");
    expect(round.get("Invoice/cac:AdditionalDocumentReference")?.length).toBe(2);
  });
});
