/**
 * ZATCA-compliant datetime formatting helpers.
 *
 * These replace the legacy helper's legacy date-format helpers with
 * pure native-`Date` arithmetic. Every value is treated as UTC;
 * ZATCA's UBL invoices encode dates / times as UTC-zoned strings
 * and the QR timestamp is explicitly `YYYY-MM-DDTHH:mm:ssZ`.
 *
 * No external dependencies. No `Intl` (timezone offsets are derived
 * directly from `Date.prototype.toISOString`, which is always UTC,
 * so the output is deterministic regardless of the host machine's
 * `TZ`).
 */

/**
 * Coerces a `Date` or ISO-string input to a `Date`.
 *
 * Throws on a non-finite value rather than emitting `Invalid Date`
 * silently — every helper downstream of this would emit `"NaN-NaN-NaN"`
 * otherwise.
 */
function toDate(input: Date | string): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new TypeError(`Invalid date input: ${String(input)}`);
  }
  return d;
}

/**
 * ZATCA `IssueDate` format: `YYYY-MM-DD` (UTC).
 *
 * Always derived from `toISOString()` so daylight savings, host `TZ`,
 * and locale do not perturb the output.
 */
export function formatZatcaDate(input: Date | string): string {
  const iso = toDate(input).toISOString();
  // ISO string is "YYYY-MM-DDTHH:mm:ss.sssZ" — slice the date prefix.
  return iso.slice(0, 10);
}

/**
 * ZATCA `IssueTime` format: `HH:mm:ssZ` (UTC).
 *
 * Trailing `Z` is mandatory per UBL 2.1 + ZATCA spec — the QR
 * timestamp encodes the same UTC instant and tags break in production
 * if the two differ.
 */
export function formatZatcaTime(input: Date | string): string {
  const iso = toDate(input).toISOString();
  // "YYYY-MM-DDTHH:mm:ss.sssZ" — extract "HH:mm:ss" and re-append Z.
  return `${iso.slice(11, 19)}Z`;
}

/**
 * Idempotently ensures a ZATCA wall-clock `IssueTime` string carries the
 * mandatory UTC `Z` designator.
 *
 * Unlike {@link formatZatcaTime}, this does NOT parse the value through a
 * `Date` — it operates purely on the already-formatted `HH:mm:ss` string a
 * caller supplies, so a bare time (no `Z`) is accepted and a time that
 * already ends in `Z` is returned unchanged (no double `Z`). The `Z` must
 * reach the XML `<cbc:IssueTime>` so it matches the QR timestamp and the
 * XAdES `SigningTime`; otherwise ZATCA warns on the missing timezone and
 * the signing timestamp can drift on non-UTC hosts.
 */
export function ensureZatcaTimeZ(time: string): string {
  return time.endsWith("Z") ? time : `${time}Z`;
}

/**
 * ZATCA combined timestamp format: `YYYY-MM-DDTHH:mm:ss` (UTC-naive).
 *
 * Used inside the XML for fields where ZATCA's hash oracle compares
 * the canonical XML byte-for-byte and the spec omits the trailing `Z`.
 * See `zatca.xml.signing.ts` in the legacy source — the legacy
 * date-format helper was configured with `format('YYYY-MM-DDTHH:mm:ss')`
 * (no `Z`) for these call sites.
 */
export function formatZatcaDateTime(input: Date | string): string {
  const iso = toDate(input).toISOString();
  return iso.slice(0, 19);
}

/**
 * Sign-timestamp format used inside the XAdES `SigningTime` element:
 * `YYYY-MM-DDTHH:mm:ssZ`.
 *
 * Trailing `Z` is required by the XAdES schema. The legacy source
 * concatenates this manually as `` `${...format('YYYY-MM-DDTHH:mm:ss')}Z` ``;
 * this helper just consolidates that.
 */
export function formatSignTimestamp(input: Date | string): string {
  return `${formatZatcaDateTime(input)}Z`;
}

/**
 * Helper for invoice ingestion: derive the canonical ZATCA
 * `IssueDate` / `IssueTime` pair from a single `Date` (or ISO string).
 *
 * Mirrors the legacy `extractZatcaDateTime` helper one-to-one so any
 * downstream code that builds invoice props can swap drop-in.
 */
export function extractZatcaDateTime(input: Date | string): {
  issue_date: string;
  issue_time: string;
} {
  return {
    issue_date: formatZatcaDate(input),
    issue_time: formatZatcaTime(input),
  };
}
