/**
 * `XMLDocument` — minimal-surface UBL XML wrapper.
 *
 * Ported from the legacy helper's `zatca.xml.parser.ts` with two
 * dependency changes:
 *
 * 1. **No external collection-utility library.** Path filtering uses
 *    a small `matchesSubset` walker (~20 LOC) that does shallow
 *    predicate matching against object properties. Behaviour matches
 *    the original `filter(arr, matches(condition))` for the subset
 *    of inputs the ZATCA pipeline produces (plain objects with
 *    string / number / nested-object values).
 * 2. **`fast-xml-parser` v5 (bumped from the legacy helper's v4).** The v4 / v5
 *    APIs are compatible for the options we use (`ignoreAttributes:
 *    false`, `ignoreDeclaration: false`, `parseTagValue: false`).
 *    Golden vectors confirmed byte-identical across the bump.
 *
 * The class is intentionally a thin wrapper: `get / set / delete /
 * toString`. Every ZATCA signing operation operates on the parsed
 * object graph and re-serialises through `toString`, which is the
 * pre-canonicalisation input to `xmldsigjs`.
 */

import { XMLBuilder, XMLParser } from "fast-xml-parser";

/**
 * Loose XML object shape produced by `fast-xml-parser`. Tag names
 * are arbitrary strings (`cbc:UUID`, `@_currencyID`, `#text`), so a
 * record is the most we can usefully type without losing the
 * structural flexibility the parser provides.
 */
export interface XMLObject {
  [tag: string]: unknown;
}

export type XMLQueryResult = XMLObject[] | undefined;

export interface XMLParserOptions {
  ignoreAttributes: boolean;
  ignoreDeclaration: boolean;
  ignorePiTags: boolean;
  parseTagValue: boolean;
}

/**
 * Shallow subset predicate — returns `true` iff every key of
 * `partial` is present on `item` with a strictly equal value.
 *
 * Replaces the legacy `matches` predicate for the limited usage in
 * this module (filtering arrays of `XMLObject` against simple
 * `{tag: value}` shapes). Deep equality is not needed — the ZATCA
 * pipeline only predicate-filters on string-valued leaf tags
 * (e.g. `{"cbc:ID": "QR"}`).
 */
function matchesSubset(item: unknown, partial: XMLObject): boolean {
  if (item === null || typeof item !== "object") {
    return false;
  }
  const record = item as Record<string, unknown>;
  for (const key of Object.keys(partial)) {
    if (record[key] !== partial[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Filters an array of unknown values down to those that satisfy
 * `matchesSubset(_, predicate)`. Type-narrowed to `XMLObject[]` for
 * downstream consumers.
 */
function filterByMatchSubset(arr: ReadonlyArray<unknown>, predicate: XMLObject): XMLObject[] {
  const out: XMLObject[] = [];
  for (const x of arr) {
    if (matchesSubset(x, predicate)) {
      out.push(x as XMLObject);
    }
  }
  return out;
}

/**
 * Empty-check that mirrors the legacy `isEmpty` semantics for the
 * subset of inputs this module passes in:
 * - `undefined` / `null` → empty.
 * - Array → empty iff length 0.
 * - Object → empty iff no own enumerable keys.
 * - Primitives → empty iff falsy.
 */
function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return !value;
}

/**
 * Wrapper around `fast-xml-parser`'s `XMLParser` + `XMLBuilder` that
 * exposes a path-based query / mutate / delete API over UBL invoice
 * XML.
 *
 * Construction:
 * - `new XMLDocument(xmlStr)`  — parse an existing XML string.
 * - `new XMLDocument()`        — start from an empty `?xml`
 *                                declaration only.
 */
export class XMLDocument {
  private xml_object: XMLObject;
  private readonly parser_options: XMLParserOptions = {
    ignoreAttributes: false,
    ignoreDeclaration: false,
    ignorePiTags: false,
    parseTagValue: false,
  };

  constructor(xml_str?: string) {
    const parser = new XMLParser(this.parser_options);
    if (xml_str) {
      const parsed = parser.parse(xml_str) as XMLObject | undefined;
      this.xml_object = parsed ?? {};
    } else {
      this.xml_object = { "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" } };
    }
  }

  /**
   * Walks `xml_object` down `path_query` (a `/`-separated tag list),
   * returning the leaf object along with its parent + parent's tag.
   * Recursion mirrors the legacy original.
   */
  private getElement(
    xml_object: XMLObject | undefined,
    path_query: string,
    parent_xml_object?: XMLObject,
    last_tag?: string,
  ): {
    xml_object: XMLObject | undefined;
    parent_xml_object: XMLObject | undefined;
    last_tag: string | undefined;
  } {
    if (path_query === "") {
      return { xml_object, parent_xml_object, last_tag };
    }
    if (xml_object === undefined || xml_object === null) {
      return {
        xml_object: undefined,
        parent_xml_object,
        last_tag,
      };
    }
    // `fast-xml-parser` collapses empty elements (`<foo></foo>`) into
    // the empty string `""`. A string has no descendants, so any
    // remaining path query is unresolvable — treat as a miss.
    if (typeof xml_object !== "object") {
      return {
        xml_object: undefined,
        parent_xml_object,
        last_tag,
      };
    }
    const current_path = path_query.split("/");
    const [current_tag] = current_path.splice(0, 1);
    if (current_tag === undefined) {
      return { xml_object, parent_xml_object, last_tag };
    }
    const new_query_path = current_path.join("/");
    const next = xml_object[current_tag] as XMLObject | undefined;
    return this.getElement(next, new_query_path, xml_object, current_tag);
  }

  /**
   * Queries the XML for a specific element given its path in tags.
   * Accepts an optional shallow-match condition for filtering.
   *
   * @param path_query e.g. `"Invoice/cac:Delivery/cbc:ActualDeliveryDate"`.
   * @param condition  Optional `{tag: value}` shape — filter results
   *                   to objects whose listed properties all match.
   * @returns Array of matched elements, or `undefined` if no match.
   */
  get(path_query?: string, condition?: XMLObject): XMLQueryResult {
    if (!this.xml_object) {
      return undefined;
    }
    const { xml_object } = this.getElement(this.xml_object, path_query ?? "");
    if (xml_object === undefined) {
      return undefined;
    }
    let query_result: XMLObject[] = Array.isArray(xml_object)
      ? (xml_object as unknown as XMLObject[])
      : [xml_object];
    if (condition) {
      query_result = filterByMatchSubset(query_result, condition);
    }
    return isEmpty(query_result) ? undefined : query_result;
  }

  /**
   * Queries the XML for a specific element given its path in tags
   * and deletes it.
   *
   * @returns `true` if at least one match was deleted; `false` otherwise.
   */
  delete(path_query?: string, condition?: XMLObject): boolean {
    if (!this.xml_object) {
      return false;
    }
    const { xml_object, parent_xml_object, last_tag } = this.getElement(
      this.xml_object,
      path_query ?? "",
    );
    if (xml_object === undefined) {
      return false;
    }
    let query_result: XMLObject[] = Array.isArray(xml_object)
      ? (xml_object as unknown as XMLObject[])
      : [xml_object];
    if (condition) {
      query_result = filterByMatchSubset(query_result, condition);
    }
    if (isEmpty(query_result)) {
      return false;
    }
    if (parent_xml_object && last_tag !== undefined) {
      const target = parent_xml_object[last_tag];
      if (Array.isArray(target) && condition) {
        const filtered = (target as unknown[]).filter(
          (element) => !matchesSubset(element, condition),
        );
        if (isEmpty(filtered)) {
          delete parent_xml_object[last_tag];
        } else {
          parent_xml_object[last_tag] = filtered;
        }
      } else {
        delete parent_xml_object[last_tag];
      }
    }
    return true;
  }

  /**
   * Sets (or appends) an `XMLObject` value at a specific path. The
   * parent path must already exist — this method does not create
   * intermediate tags.
   *
   * @param overwrite When `true`, replaces any existing value at the
   *                  leaf. When `false`, appends to / promotes-to-array
   *                  the existing value.
   * @returns `true` on success; `false` if the parent path is missing
   *          or the mutation throws.
   */
  set(path_query: string, overwrite: boolean, set_xml: XMLObject | string): boolean {
    if (!this.xml_object) {
      return false;
    }
    const path_tags = path_query.split("/");
    const [tag] = path_tags.splice(-1, 1);
    if (tag === undefined) {
      return false;
    }
    const new_path_query = path_tags.join("/");
    const walked = this.getElement(this.xml_object, new_path_query);
    const xml_object = walked.xml_object;
    let parent_xml_object = walked.parent_xml_object;
    let last_tag = walked.last_tag;
    if (isEmpty(xml_object)) {
      return false;
    }
    // Workaround for adding to root (since the document has no key).
    if (!new_path_query) {
      parent_xml_object = { root: this.xml_object };
      last_tag = "root";
    }

    try {
      if (parent_xml_object && last_tag !== undefined) {
        const branch = parent_xml_object[last_tag] as XMLObject;
        if (Array.isArray(branch[tag])) {
          branch[tag] = overwrite ? set_xml : [...(branch[tag] as unknown[]), set_xml];
        } else if (branch[tag] !== undefined) {
          branch[tag] = overwrite ? set_xml : [branch[tag], set_xml];
        } else {
          branch[tag] = set_xml;
        }
      }
      return true;
    } catch {
      // Mutation failures fall through to `false`. No logging in core.
    }
    return false;
  }

  /**
   * Serialises the document back to an XML string.
   *
   * `no_header: true` strips the `<?xml ... ?>` declaration — used
   * when the result will be embedded inside another XML container.
   */
  toString({ no_header }: { no_header?: boolean } = {}): string {
    const builder_options = {
      ...this.parser_options,
      format: true,
      indentBy: "    ",
    };
    const builder = new XMLBuilder(builder_options);
    let xml_str = builder.build(this.xml_object) as string;
    if (no_header) {
      xml_str = xml_str.replace('<?xml version="1.0" encoding="UTF-8"?>', "");
    }
    xml_str = xml_str.replaceAll("&apos;", "'");
    return xml_str;
  }
}
